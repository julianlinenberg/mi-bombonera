export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { hdb_id, hdb_slug, match_id } = req.query;
  if (!hdb_id || !hdb_slug) return res.status(400).json({ error: 'Missing params' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

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

    // 2. Fetch match page — try with full path first, fallback to short
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    let html = '';
    const urls = [
      `https://www.historiadeboca.com.ar/partido/${hdb_slug}/${hdb_id}.html`,
    ];
    for (const url of urls) {
      const r = await fetch(url, { headers: { 'User-Agent': ua } });
      if (r.ok) { html = await r.text(); break; }
    }
    if (!html) return res.status(404).json({ error: 'Page not found' });

    // 3. Extract date — look for "Fecha: DayName DD de Month de YYYY"
    let fecha_exacta = '';
    const fm = html.match(/Fecha:\s*((?:Lunes|Martes|Mi[eé]rcoles|Jueves|Viernes|S[aá]bado|Domingo)\s+\d+\s+de\s+\w+\s+de\s+\d{4})/i);
    if (fm) fecha_exacta = fm[1].trim();

    // 4. Extract DTs — find all /tecnicos/ links and grab display text
    const dtMatches = [...html.matchAll(/href="[^"]*\/tecnicos\/[^"]*"[^>]*>([^<]+)<\/a>/g)];
    const dt_boca = dtMatches.length > 0 ? dtMatches[0][1].trim() : 'N/D';
    const dt_rival = dtMatches.length > 1 ? dtMatches[1][1].trim() : 'N/D';

    // 5. Extract goals from Incidencias section
    let goleadores = '-';
    const incStart = html.indexOf('Incidencias');
    if (incStart > -1) {
      const incSection = html.substring(incStart, incStart + 3000);
      // Each row looks like: "55' | 1-0 Gol de S. Ascacíbar"
      const goalRows = [...incSection.matchAll(/(\d+)['′]\s*\|\s*(\d+)-(\d+)\s+Gol de\s+([^\n|<]+)/g)];
      let bG = 0, rG = 0;
      const b = [], r = [];
      goalRows.forEach(([, min, nb, nr, name]) => {
        const nbi = parseInt(nb), nri = parseInt(nr);
        const n = name.trim().replace(/\([^)]*\)/g, '').trim();
        if (nbi > bG) { b.push(`${n} (${min}')`); bG = nbi; }
        else if (nri > rG) { r.push(`${n} (${min}')`); rG = nri; }
      });
      if (b.length || r.length) {
        goleadores = (b.join(', ') || '-') + ' / ' + (r.join(', ') || '-');
      }
    }

    // 6. Extract comment
    let nota = '';
    const commStart = html.indexOf('Comentario');
    if (commStart > -1) {
      const commSection = html.substring(commStart, commStart + 800);
      const cm = commSection.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (cm) nota = cm[1].replace(/<[^>]+>/g, '').trim().substring(0, 150);
    }

    const result = { id: match_id, fecha_exacta, dt_boca, dt_rival, goleadores, nota };

    // 7. Save to Supabase
    if (SUPABASE_URL && SUPABASE_KEY) {
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
    }

    return res.status(200).json({ ...result, from_cache: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
