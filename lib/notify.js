// Porter's Nails — one place to send texts and emails.
// Every send is written to the message log with its real result (sent / failed),
// and emails are logged as readable plain text, not just the subject line.

const { logMessage } = require('../api/log');
const { htmlToText } = require('./format');

const FROM_EMAIL = "Porter's Nails <bookings@portersnailsandspa.com>";
const e164 = (p) => '+1' + String(p || '').replace(/\D/g, '').slice(-10);

// Customer texts must only go to people who checked the SMS consent box (A2P 10DLC).
// Staff texts (techs/managers) don't use this check.
const canTextCustomer = (appt) => !!(appt && appt.phone && appt.sms_opt_in);

async function sendSms(to, body, { recipientName = null, trigger, apptId = null } = {}) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return false;
  let ok = false;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: e164(to), Body: body }).toString()
    });
    ok = r.ok;
  } catch (_) { ok = false; }
  try { await logMessage({ type: 'sms', recipient: e164(to), recipientName, body, trigger, appointmentId: apptId, status: ok ? 'sent' : 'failed' }); } catch (_) {}
  return ok;
}

async function sendEmail(to, subject, html, { recipientName = null, trigger, apptId = null } = {}) {
  const key = process.env.RESEND_KEY;
  if (!key || !to) return false;
  let ok = false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html })
    });
    ok = r.ok;
  } catch (_) { ok = false; }
  try { await logMessage({ type: 'email', recipient: to, recipientName, subject, body: htmlToText(html), trigger, appointmentId: apptId, status: ok ? 'sent' : 'failed' }); } catch (_) {}
  return ok;
}

module.exports = { sendSms, sendEmail, canTextCustomer, e164 };
