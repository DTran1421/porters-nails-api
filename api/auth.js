const crypto = require('crypto');

function hash(str) {
  return crypto.createHash('sha256').update(str + 'porters-nails-salt').digest('hex');
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (origin.includes('portersnailsandspa.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = {
    'apikey': SUPABASE_SVC_KEY,
    'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates'
  };

  async function getSetting(key) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/site_settings?key=eq.${key}`, { headers });
    const data = await r.json();
    return data[0]?.value || null;
  }

  async function setSetting(key, value) {
    await fetch(`${SUPABASE_URL}/rest/v1/site_settings`, {
      method: 'POST', headers,
      body: JSON.stringify({ key, value })
    });
  }

  try {
    // GET — verify session token
    if (req.method === 'GET') {
      const token = req.headers['x-session-token'];
      if (!token) return res.status(401).json({ valid: false });
      const stored = await getSetting('owner_session_token');
      const expiry = await getSetting('owner_session_expiry');
      if (!stored || stored !== token) return res.status(401).json({ valid: false });
      if (expiry && Date.now() > parseInt(expiry)) return res.status(401).json({ valid: false, reason: 'expired' });
      return res.status(200).json({ valid: true });
    }

    if (req.method === 'POST') {
      const { action, username, password, newPassword } = req.body || {};

      // First-time setup with username
      if (action === 'setup') {
        const existing = await getSetting('owner_password_hash');
        if (existing) return res.status(403).json({ error: 'Account already exists. Please sign in.' });
        if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
        if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        await setSetting('owner_username', username.trim().toLowerCase());
        await setSetting('owner_password_hash', hash(password));
        return res.status(200).json({ success: true });
      }

      // Login — check username + password
      if (action === 'login') {
        const storedUsername = await getSetting('owner_username');
        const pwHash = await getSetting('owner_password_hash');
        if (!pwHash) return res.status(400).json({ error: 'No account found. Please register first.' });
        if (!storedUsername || storedUsername !== (username||'').trim().toLowerCase()) {
          return res.status(401).json({ error: 'Incorrect username or password.' });
        }
        if (hash(password) !== pwHash) {
          return res.status(401).json({ error: 'Incorrect username or password.' });
        }
        const sessionToken = generateToken();
        const expiry = Date.now() + (12 * 60 * 60 * 1000); // 12 hours
        await setSetting('owner_session_token', sessionToken);
        await setSetting('owner_session_expiry', String(expiry));
        return res.status(200).json({ success: true, token: sessionToken });
      }

      // Logout
      if (action === 'logout') {
        await setSetting('owner_session_token', '');
        await setSetting('owner_session_expiry', '0');
        return res.status(200).json({ success: true });
      }

      // Change password
      if (action === 'change') {
        const sessionTok = req.headers['x-session-token'];
        const stored = await getSetting('owner_session_token');
        if (!sessionTok || stored !== sessionTok) return res.status(401).json({ error: 'Not authenticated.' });
        const pwHash = await getSetting('owner_password_hash');
        if (hash(password) !== pwHash) return res.status(401).json({ error: 'Current password incorrect.' });
        if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        await setSetting('owner_password_hash', hash(newPassword));
        await setSetting('owner_session_token', '');
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown action.' });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
