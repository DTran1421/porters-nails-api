// Porter's Nails — settings proxy (read/write site_settings via service key)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'apikey': SUPABASE_SVC_KEY,
    'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates'
  };

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/site_settings`, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json(await r.json());
    }
    if (req.method === 'POST') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/site_settings`, {
        method: 'POST', headers, body: JSON.stringify(req.body)
      });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
