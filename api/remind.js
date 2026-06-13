// Porter's Nails — daily appointment reminders (Vercel cron)
// Runs daily at 9 AM CT, texts customers and techs about tomorrow's appointments

const { logMessage } = require('./log');

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
  const TWILIO_SID       = process.env.TWILIO_SID;
  const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
  const TWILIO_FROM      = process.env.TWILIO_FROM;

  const sendSms = async (to, body, recipientName, appointmentId) => {
    if (!TWILIO_SID || !to) return;
    const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: body }).toString()
    });
    await logMessage({ type:'sms', recipient:toNum, recipientName, body, trigger:'reminder', appointmentId });
  };

  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/appointments?date=eq.${tomorrowStr}&status=eq.confirmed`,
      { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
    );
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const appts = await r.json();

    let sent = 0;
    for (const a of appts) {
      const timeDisplay = a.time ? a.time.replace(/(\d+):(\d+)/, (_, h, m) => {
        const hr = +h; const ap = hr >= 12 ? 'PM' : 'AM';
        return (hr % 12 || 12) + ':' + m + ' ' + ap;
      }) : a.time;

      if (a.phone) {
        await sendSms(a.phone, `Reminder: your ${a.service} at Porter's Nails is tomorrow (${tomorrowStr}) at ${timeDisplay}. See you then! Questions? Call (281) 747-7421.`, a.name, a.id);
        sent++;
      }

      if (a.tech_name && a.tech_name !== 'Any available') {
        const techRes = await fetch(
          `${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(a.tech_name)}&select=phone`,
          { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
        );
        if (techRes.ok) {
          const techRows = await techRes.json();
          if (techRows[0]?.phone) {
            await sendSms(techRows[0].phone, `Reminder: ${a.name} has a ${a.service} tomorrow at ${timeDisplay}. - Porter's Nails`, a.tech_name, a.id);
            sent++;
          }
        }
      }
    }

    return res.status(200).json({ success: true, reminders_sent: sent, date: tomorrowStr });
  } catch (err) {
    console.error('Reminder error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
