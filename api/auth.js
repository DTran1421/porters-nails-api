const crypto = require('crypto');

// Simple in-memory rate limiter for login attempts
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 minutes
  const max = 10; // max attempts
  const key = ip || 'unknown';
  const attempts = loginAttempts.get(key) || [];
  const recent = attempts.filter(t => now - t < window);
  if (recent.length >= max) return false;
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
}

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
      method: 'POST', headers, body: JSON.stringify({ key, value })
    });
  }
  async function getAccount(username) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?username=eq.${encodeURIComponent(username.toLowerCase())}`, { headers });
    const data = await r.json();
    return data[0] || null;
  }
  async function verifySession(token) {
    if (!token) return null;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions?token=eq.${encodeURIComponent(token)}`, { headers });
    const data = await r.json();
    const session = data[0];
    if (!session) return null;
    if (Date.now() > parseInt(session.expiry)) {
      // Clean up expired session
      await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions?token=eq.${encodeURIComponent(token)}`, { method: 'DELETE', headers });
      return null;
    }
    return session.username;
  }

  try {
    // GET — verify session token
    if (req.method === 'GET') {
      const token = req.headers['x-session-token'];
      const user = await verifySession(token);
      if (!user) return res.status(401).json({ valid: false });
      const account = await getAccount(user);
      return res.status(200).json({ valid: true, username: user, role: account?.role || 'owner' });
    }

    if (req.method === 'POST') {
      const { action, username, password, newPassword, targetUsername, targetPassword, targetRole } = req.body || {};

      // Login
      if (action === 'login') {
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
        if (!checkRateLimit(ip)) {
          return res.status(429).json({ error: 'Too many login attempts. Please try again in 15 minutes.' });
        }
        const account = await getAccount((username || '').trim());
        if (!account || account.password_hash !== hash(password)) {
          return res.status(401).json({ error: 'Incorrect username or password.' });
        }
        const sessionToken = generateToken();
        const expiry = Date.now() + (12 * 60 * 60 * 1000);
        await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions`, {
          method: 'POST', headers,
          body: JSON.stringify({ token: sessionToken, username: account.username, expiry: expiry })
        });
        // Update last login
        await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?username=eq.${encodeURIComponent(account.username)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ last_login: new Date().toISOString() })
        });
        return res.status(200).json({ success: true, token: sessionToken, role: account.role });
      }

      // Logout — delete only this session
      if (action === 'logout') {
        const token = req.headers['x-session-token'];
        if (token) {
          await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions?token=eq.${encodeURIComponent(token)}`, { method: 'DELETE', headers });
        }
        return res.status(200).json({ success: true });
      }

      // Change own password
      if (action === 'change') {
        const token = req.headers['x-session-token'];
        const user = await verifySession(token);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        const account = await getAccount(user);
        if (!account || account.password_hash !== hash(password)) {
          return res.status(401).json({ error: 'Current password incorrect.' });
        }
        if (!newPassword || newPassword.length < 6) {
          return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }
        await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?username=eq.${encodeURIComponent(user)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ password_hash: hash(newPassword) })
        });
        // Invalidate all sessions for this user
        await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions?username=eq.${encodeURIComponent(user)}`, { method: 'DELETE', headers });
        return res.status(200).json({ success: true });
      }

      // List accounts (admin only)
      if (action === 'list_accounts') {
        const token = req.headers['x-session-token'];
        const user = await verifySession(token);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        const account = await getAccount(user);
        if (account?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
        const r = await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?select=id,username,role,phone,created_at,last_login&order=created_at.asc`, { headers });
        return res.status(200).json(await r.json());
      }

      // Create account (admin only)
      if (action === 'create_account') {
        const token = req.headers['x-session-token'];
        const user = await verifySession(token);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        const account = await getAccount(user);
        if (account?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
        if (!targetUsername || targetUsername.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters.' });
        if (!targetPassword || targetPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        const r = await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts`, {
          method: 'POST', headers: {...headers, 'Prefer': 'return=representation'},
          body: JSON.stringify({
            username: targetUsername.trim().toLowerCase(),
            password_hash: hash(targetPassword),
            role: targetRole || 'owner',
            phone: (req.body.targetPhone || '').replace(/\D/g,'').slice(-10) || null
          })
        });
        if (!r.ok) {
          const err = await r.json();
          if (JSON.stringify(err).includes('unique')) return res.status(400).json({ error: 'Username already exists.' });
          throw new Error(`Supabase ${r.status}`);
        }
        return res.status(200).json({ success: true });
      }

      // Update phone for an account (admin only)
      if (action === 'update_phone') {
        const token = req.headers['x-session-token'];
        const user = await verifySession(token);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        const account = await getAccount(user);
        if (account?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
        await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?username=eq.${encodeURIComponent(targetUsername)}`, {
          method: 'PATCH', headers, body: JSON.stringify({ phone: (req.body.targetPhone || '').replace(/\D/g,'').slice(-10) || null })
        });
        return res.status(200).json({ success: true });
      }

      // Delete account (admin only, can't delete self)
      if (action === 'delete_account') {
        const token = req.headers['x-session-token'];
        const user = await verifySession(token);
        if (!user) return res.status(401).json({ error: 'Not authenticated.' });
        const account = await getAccount(user);
        if (account?.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
        if (targetUsername === user) return res.status(400).json({ error: 'Cannot delete your own account.' });
        await fetch(`${SUPABASE_URL}/rest/v1/owner_accounts?username=eq.${encodeURIComponent(targetUsername)}`, {
          method: 'DELETE', headers
        });
        await fetch(`${SUPABASE_URL}/rest/v1/owner_sessions?username=eq.${encodeURIComponent(targetUsername)}`, { method: 'DELETE', headers });
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
