export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

  const { fecha, rival, match_id } = req.query;
  if (!fecha || !rival) return res.status(400).json({ error: 'Missing params' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html'
  };

  try {
    // 1. Check Supabase cache first
    const cacheRes = await fetch(
      `${SUPABASE_URL}/rest/v1/partidos_extra?id=eq.${encodeURIComponent(match_id)}&select=*`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const cached = await cacheRes.json();
    if (cached && cached.length > 0 && cached[0].dt_boca && cached[0].dt_boca !== 'N/D') {
      return res.status(200).json({ ...cached[0], from_cache: true });
    }

    // 2. Search on historiadeboca.com.ar
    const year = fecha.substring(0, 4);
    const [y, m, d] = fecha.split('-');
    const fechaFormatted = `${d}/${m}/${y}`;

    // Search home games of that year
    const searchUrl = `https://www.historiadeboca.com.ar/buscarresultados.php?anio1=${year}&anio2=${year}&estadio=1&orden=1`;
    const searchRes = await fetch(searchUrl, { headers });
    const searchHtml = await searchRes.text();

    // Find match link by date
    let matchUrl = null;
    const linkPattern = /href="(\/partido\/boca-[^"]+\/(\d+)\/[^"]*)"/g;
    let linkMatch;
    const candidates = [];
    while ((linkMatch = linkPattern.exec(searchHtml)) !== null) {
      candidates.push({ href: linkMatch[1], id: linkMatch[2] });
    }

    // Find the one matching our date
    for (const c of candidates) {
      const pageUrl = `https://www.historiadeboca.com.ar/partido/${c.href.split('/partido/')[1].split('/')[0]}/${c.id}.html`;
      // Check if date appears near this link in the HTML
      const pos = searchHtml.indexOf(c.href);
      const surrounding = searchHtml.substring(Math.max(0, pos - 200), pos + 200);
      if (surrounding.includes(fechaFormatted)) {
        matchUrl = pageUrl;
        break;
      }
    }

    // Fallback: try rival-based slug search
    if (!matchUrl) {
      const rivalSlug = rival.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s.()]/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-');
      for (const c of candidates) {
        if (c.href.includes(rivalSlug.substring(0, 5))) {
          matchUrl = `https://www.historiadeboca.com.ar/partido/${c.href.split('/partido/')[1].split('/')[0]}/${c.id}.html`;
          break;
        }
      }
    }

    if (!matchUrl) {
      return res.status(404).json({ error: 'Match not found', fecha, rival });
    }

    // 3. Fetch match page
    const matchRes = await fetch(matchUrl, { headers });
    const html = await matchRes.text();

    // Extract exact date
    const fechaMatch = html.match(/Fecha:\s*([A-ZÁÉÍÓÚa-záéíóúñ]+\s+\d+\s+de\s+[A-ZÁÉÍÓÚa-záéíóúñ]+\s+de\s+\d{4})/i);
    const fecha_exacta = fechaMatch ? fechaMatch[1].trim() : fechaFormatted;

    // Extract DT Boca (first tecnico link)
    const dtBocaMatch = html.match(/tecnicos\/[^"]+">([^<]+)<\/a>/);
    const dt_boca = dtBocaMatch ? dtBocaMatch[1].trim() : 'N/D';

    // Extract DT Rival (second tecnico link)
    const allDTs = [...html.matchAll(/tecnicos\/[^"]+">([^<]+)<\/a>/g)];
    const dt_rival = allDTs.length > 1 ? allDTs[1][1].trim() : 'N/D';

    // Extract goals from incidencias
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

    // 4. Save to Supabase cache
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
