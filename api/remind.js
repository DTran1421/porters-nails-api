// Porter's Nails — daily appointment reminders (Vercel cron)
// Runs daily at 9 AM CT, texts customers and techs about tomorrow's appointments

const { sendSms, canTextCustomer } = require('../lib/notify');
const { fmtWhen } = require('../lib/format');
const { isSpecificTech } = require('../lib/queue');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // Verify request comes from Vercel cron (or has the secret)
  const CRON_SECRET = process.env.CRON_SECRET;
  if (CRON_SECRET) {
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const svc = { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` };

  try {
    // "Tomorrow" in salon time (Central), not UTC
    const now = new Date();
    const tomorrowStr = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    const r = await fetch(`${SUPABASE_URL}/rest/v1/appointments?date=eq.${tomorrowStr}&status=eq.confirmed`, { headers: svc });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const appts = await r.json();

    let sent = 0, skippedNoConsent = 0;
    for (const a of appts) {
      const when = fmtWhen(a.date, a.time);

      // Customers only get texts if they opted in (A2P 10DLC)
      if (canTextCustomer(a)) {
        if (await sendSms(a.phone, `Reminder: your ${a.service} at Porter's Nails is tomorrow, ${when}. See you then! Questions? Call (281) 747-7421.`, { recipientName: a.name, trigger: 'reminder', apptId: a.id })) sent++;
      } else if (a.phone) {
        skippedNoConsent++;
      }

      if (isSpecificTech(a.tech_name)) {
        const techRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(a.tech_name)}&select=phone`, { headers: svc });
        if (techRes.ok) {
          const t = (await techRes.json())[0];
          if (t?.phone && await sendSms(t.phone, `Reminder: ${a.name} has a ${a.service} tomorrow, ${when}. - Porter's Nails`, { recipientName: a.tech_name, trigger: 'reminder', apptId: a.id })) sent++;
        }
      }
    }

    return res.status(200).json({ success: true, reminders_sent: sent, skipped_no_text_consent: skippedNoConsent, date: tomorrowStr });
  } catch (err) {
    console.error('Reminder error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
