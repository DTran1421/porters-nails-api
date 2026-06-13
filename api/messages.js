// Porter's Nails — message log proxy
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'apikey': SUPABASE_SVC_KEY,
    'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    if (req.method === 'GET') {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/message_log?order=created_at.desc&limit=100`, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      return res.status(200).json(await r.json());
    }
    if (req.method === 'DELETE') {
      // Clear all message logs
      const r = await fetch(`${SUPABASE_URL}/rest/v1/message_log?id=gt.0`, {
        method: 'DELETE', headers
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
