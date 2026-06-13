// Porter's Nails — blocked times management
// GET  → return all blocked times (for booking wizard)
// POST → add a block
// DELETE ?id=X → remove a block

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
      const r = await fetch(`${SUPABASE_URL}/rest/v1/blocked_times?order=date.asc`, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json(await r.json());
    }

    if (req.method === 'POST') {
      const { tech_name, date, start_time, end_time, reason } = req.body;
      if (!date) return res.status(400).json({ error: 'Missing date' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/blocked_times`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ tech_name: tech_name || null, date, start_time: start_time || null, end_time: end_time || null, reason: reason || null })
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json({ success: true, block: (await r.json())[0] });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/blocked_times?id=eq.${id}`, {
        method: 'DELETE', headers
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Blocks error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
