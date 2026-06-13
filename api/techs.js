// Porter's Nails — nail techs sync
// GET  → returns all techs (for booking wizard)
// POST → saves/updates a tech (from owner dashboard)
// DELETE → removes a tech

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (origin.includes('portersnailsandspa.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SVC_KEY,
    'Authorization': `Bearer ${SUPABASE_SVC_KEY}`
  };

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?order=name.asc`, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json(await r.json());
    }

    if (req.method === 'POST') {
      const { id, name, phone, cats, days, start_hour, end_hour } = req.body;
      if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id, name, phone: phone || null, cats: cats || [], days: days || {}, start_hour: start_hour || 9, end_hour: end_hour || 18, updated_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?id=eq.${id}`, {
        method: 'DELETE', headers
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Techs error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
