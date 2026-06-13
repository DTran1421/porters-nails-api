// Porter's Nails — storage upload proxy
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-file-name, x-file-type, x-delete-path');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    if (req.method === 'POST') {
      const fname = req.headers['x-file-name'];
      const ftype = req.headers['x-file-type'];
      if (!fname) return res.status(400).json({ error: 'Missing x-file-name header' });

      // Forward raw body to Supabase storage
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${fname}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'apikey': SUPABASE_SVC_KEY,
          'Content-Type': ftype || 'application/octet-stream',
          'x-upsert': 'true'
        },
        body
      });
      if (!r.ok) throw new Error(`Storage ${r.status}`);
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${fname}`;
      return res.status(200).json({ success: true, url: publicUrl });
    }
    if (req.method === 'DELETE') {
      const path = req.headers['x-delete-path'];
      if (!path) return res.status(400).json({ error: 'Missing x-delete-path header' });
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${path}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`, 'apikey': SUPABASE_SVC_KEY }
      });
      if (!r.ok) throw new Error(`Storage ${r.status}`);
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
