export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { hdb_id, hdb_slug, match_id } = req.query;
  if (!hdb_id || !hdb_slug) return res.status(400).json({ error: 'Missing hdb_id or hdb_slug' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  try {
    // 1. Check Supabase cache
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/partidos_extra?id=eq.${encodeURIComponent(match_id)}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const cached = await cacheRes.json();
    if (cached?.length > 0 && cached[0].dt_boca && cached[0].dt_boca !== 'N/D') {
      return res.status(200).json({ ...cached[0], from_cache: true });
    }

    // 2. Fetch match page directly using slug + id
    const matchUrl = `https://www.historiadeboca.com.ar/partido/${hdb_slug}/${hdb_id}.html`;
    const matchRes = await fetch(matchUrl, { headers });
    if (!matchRes.ok) return res.status(404).json({ error: 'Page not found', url: matchUrl });
    const html = await matchRes.text();

    // Extract exact date
    const fechaMatch = html.match(/Fecha:\s*([A-ZÁÉÍÓÚa-záéíóúñ]+\s+\d+\s+de\s+[A-ZÁÉÍÓÚa-záéíóúñ]+\s+de\s+\d{4})/i);
    const fecha_exacta = fechaMatch ? fechaMatch[1].trim() : '';

    // Extract all tecnico links
    const allDTs = [...html.matchAll(/tecnicos\/[^"]+">([^<]+)<\/a>/g)];
    const dt_boca = allDTs.length > 0 ? allDTs[0][1].trim() : 'N/D';
    const dt_rival = allDTs.length > 1 ? allDTs[1][1].trim() : 'N/D';

    // Extract goals
    let goleadores = '-';
    const incBlock = html.match(/Incidencias[\s\S]*?<table([\s\S]*?)<\/table>/i);
    if (incBlock) {
      let bG = 0, rG = 0;
      const b = [], r = [];
      const goals = [...incBlock[1].matchAll(/(\d+)-(\d+)[^G\n]*Gol de ([^\n<(]+)/g)];
      goals.forEach(([, nb, nr, name]) => {
        const nbi = parseInt(nb), nri = parseInt(nr);
        const n = name.trim().replace(/\([^)]*\)/g, '').trim();
        if (nbi > bG) { b.push(n); bG = nbi; }
        else if (nri > rG) { r.push(n); rG = nri; }
      });
      if (b.length || r.length) {
        goleadores = (b.join(', ') || '-') + ' / ' + (r.join(', ') || '-');
      }
    }

    // Extract comment
    const commMatch = html.match(/Comentario\s*<\/h2>\s*<hr[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i);
    const nota = commMatch ? commMatch[1].replace(/<[^>]+>/g, '').trim().substring(0, 150) : '';

    const result = { id: match_id, fecha_exacta, dt_boca, dt_rival, goleadores, nota, fuente: matchUrl };

    // 3. Save to Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/partidos_extra`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify(result)
    });

    return res.status(200).json({ ...result, from_cache: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
