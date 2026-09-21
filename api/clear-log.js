// Porter's Nails — clear message log (password-protected, server-side delete)

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Missing password' });
  if (password !== process.env.CLEAR_LOG_PASSWORD) {
    return res.status(403).json({ error: 'Incorrect password' });
  }

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/message_log?id=gt.0`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Prefer': 'return=minimal'
      }
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Clear log error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
