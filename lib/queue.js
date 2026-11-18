// Porter's Nails — SMS approval queue
//
// Managers handle pending booking requests by text, one at a time, oldest first.
// A reply of YES / YES 2 / YES AMY / NO always applies to the booking at the
// front of the queue, so nobody has to type a ref code.
//
// No extra database tables are needed. The queue is built from:
//   - appointments with status=pending and a date of today or later, oldest first
//   - message_log entries:
//       trigger 'approval_prompt' = this manager was texted the approval prompt for this booking
//       trigger 'queue_skip'      = a manager's incoming SKIP text (left for the dashboard)
//
// Safety rule: a bare YES/NO only acts on the front booking if that manager was
// actually texted about it. Otherwise they get the booking first and reply again.
// (If the message log is cleared, the worst case is one extra text.)

const { logMessage } = require('../api/log');

const NONSPECIFIC = ['Any available', 'To be assigned'];
const isSpecificTech = (t) => !!t && !NONSPECIFIC.includes(t);
const last10 = (p) => (p || '').replace(/\D/g, '').slice(-10);
const e164 = (p) => '+1' + last10(p);

function cfg() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    url: process.env.SUPABASE_URL,
    headers: { 'Content-Type': 'application/json', 'apikey': key, 'Authorization': `Bearer ${key}` }
  };
}

function todayCentral() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// Same ref format as before (e.g. NOV20-2PM), so old-style replies keep working
function refFor(a) {
  const d = new Date(a.date + 'T00:00:00');
  const mon = d.toLocaleString('en-US', { month: 'short' }).toUpperCase();
  return `${mon}${d.getDate()}-${(a.time || '').replace(/:00/, '').replace(/\s/g, '').toUpperCase()}`;
}

// "2026-11-20" -> "Thu Nov 20"
function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function getJson(path) {
  const { url, headers } = cfg();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  return r.ok ? r.json() : [];
}

const getManagers = () => getJson('nail_techs?is_manager=eq.true&phone=not.is.null&select=name,phone');
// Bookable techs, in a fixed order so the numbers in the menu stay stable
const getTechs = () => getJson('nail_techs?manager_only=eq.false&order=name.asc&select=name,phone');

// Returns { queue, skipped } — both oldest first
async function getQueue() {
  const pending = await getJson(`appointments?status=eq.pending&date=gte.${todayCentral()}&order=created_at.asc&select=*`);
  if (!pending.length) return { queue: [], skipped: [] };
  const ids = pending.map((a) => a.id).join(',');
  const skips = await getJson(`message_log?trigger=eq.queue_skip&appointment_id=in.(${ids})&select=appointment_id`);
  const skippedIds = new Set(skips.map((s) => String(s.appointment_id)));
  return {
    queue: pending.filter((a) => !skippedIds.has(String(a.id))),
    skipped: pending.filter((a) => skippedIds.has(String(a.id)))
  };
}

// Was this manager's phone texted about this booking?
async function wasPrompted(apptId, phone) {
  const rows = await getJson(
    `message_log?appointment_id=eq.${apptId}&recipient=eq.${encodeURIComponent(e164(phone))}` +
    `&trigger=eq.approval_prompt&select=id&limit=1`
  );
  return rows.length > 0;
}

async function sendSms(to, body, recipientName, trigger, apptId) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
  const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: TWILIO_FROM, To: e164(to), Body: body }).toString()
  });
  try { await logMessage({ type: 'sms', recipient: e164(to), recipientName, body, trigger, appointmentId: apptId, status: tw.ok ? 'sent' : 'failed' }); } catch (_) {}
}

const techMenu = (techs) => techs.map((t, i) => `${i + 1} ${t.name}`).join(', ');

// The text a manager gets for the booking at the front of the queue.
// Plain characters only (no emoji or em dashes) so each text stays in cheap 160-char segments.
function promptText(appt, total, techs, { nextUp = false } = {}) {
  const lines = [];
  if (nextUp) lines.push(total > 1 ? `Next up (1 of ${total} waiting):` : 'Next up:');
  else lines.push(total > 1 ? `Booking request (1 of ${total} waiting):` : 'Booking request:');
  lines.push(`${appt.name} - ${appt.service}`);
  lines.push(`${prettyDate(appt.date)} at ${appt.time}${appt.reschedule_of ? ' (reschedule)' : ''}`);
  if (isSpecificTech(appt.tech_name)) {
    lines.push(`Requested: ${appt.tech_name}`);
    lines.push(`Reply YES to confirm with ${appt.tech_name}, YES + tech # to switch, or NO`);
  } else {
    lines.push('Requested: Any available');
    lines.push('Reply YES + tech # (or name), or NO');
  }
  if (techs.length) lines.push(`Techs: ${techMenu(techs)}`);
  if (total > 1) lines.push('SKIP = leave for dashboard');
  return lines.join('\n');
}

function listText(queue, skipped) {
  if (!queue.length && !skipped.length) return 'No pending bookings right now.';
  const fmt = (a, i) => `${i + 1}. ${a.name} - ${prettyDate(a.date)} ${a.time}`;
  const lines = [];
  if (queue.length) {
    lines.push(`${queue.length} waiting (oldest first):`);
    lines.push(...queue.slice(0, 6).map(fmt));
    if (queue.length > 6) lines.push(`+${queue.length - 6} more`);
    lines.push('Your reply applies to #1.');
  }
  if (skipped.length) lines.push(`${skipped.length} skipped - on the dashboard.`);
  return lines.join('\n');
}

// Make sure every manager has been texted about the booking at the front of
// the queue. Safe to call any time: managers who already got it are left alone.
//   excludePhone — someone who is getting the prompt another way (e.g. a TwiML reply)
//   notice / noticeApptId — optional "handled by" line to send in the same text
async function notifyFront({ excludePhone = null, notice = '', noticeApptId = null } = {}) {
  const [managers, techs, { queue }] = await Promise.all([getManagers(), getTechs(), getQueue()]);
  const front = queue[0];
  for (const m of managers) {
    if (excludePhone && last10(m.phone) === last10(excludePhone)) continue;
    const needsPrompt = front && !(await wasPrompted(front.id, m.phone));
    if (needsPrompt) {
      const body = (notice ? notice + '\n\n' : '') + promptText(front, queue.length, techs, { nextUp: !!notice });
      await sendSms(m.phone, body, m.name, 'approval_prompt', front.id);
    } else if (notice) {
      await sendSms(m.phone, notice, m.name, 'handled_broadcast', noticeApptId);
    }
  }
  return { front, queue, techs, managers };
}

// Call right after a new pending booking (or reschedule request) is created.
// If it's the only one waiting, managers get the full prompt.
// If others are ahead of it, they get a short heads-up with nothing to reply to.
async function announceNewRequest(apptId) {
  const [managers, techs, { queue }] = await Promise.all([getManagers(), getTechs(), getQueue()]);
  if (!managers.length) return;
  const pos = queue.findIndex((a) => String(a.id) === String(apptId));
  if (pos <= 0) {
    // Front of the line (or outside the queue, e.g. odd date) — send the full prompt
    const appt = pos === 0 ? queue[0] : (await getJson(`appointments?id=eq.${apptId}&select=*`))[0];
    if (!appt) return;
    const total = pos === 0 ? queue.length : 1;
    for (const m of managers) await sendSms(m.phone, promptText(appt, total, techs), m.name, 'approval_prompt', appt.id);
    return;
  }
  const appt = queue[pos];
  const kind = appt.reschedule_of ? 'Reschedule request' : 'New request';
  const msg = `${kind} queued: ${appt.name} - ${appt.service}, ${prettyDate(appt.date)} at ${appt.time}. ` +
    `${queue.length} waiting. You'll get it after the current one. Reply LIST to see all.`;
  for (const m of managers) await sendSms(m.phone, msg, m.name, 'queued', appt.id);
  // In case someone never got the current front booking, catch them up
  await notifyFront();
}

module.exports = {
  NONSPECIFIC, isSpecificTech, last10, e164, refFor, prettyDate,
  getManagers, getTechs, getQueue, wasPrompted, sendSms,
  promptText, listText, notifyFront, announceNewRequest
};
