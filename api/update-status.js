// Porter's Nails — approve, decline, cancel, or reschedule an appointment (owner dashboard)
//
// Requires a logged-in dashboard session (x-session-token). Customer details
// (name, phone, email, opt-in) always come from the database, never from the
// request, so this endpoint can't be used to send texts to arbitrary numbers.
const { createAppointmentEvent, deleteAppointmentEvent } = require('../lib/calendar');
const { notifyFront, isSpecificTech } = require('../lib/queue');
const { sendSms, sendEmail, canTextCustomer } = require('../lib/notify');
const { fmtWhen } = require('../lib/format');

const PHONE = '(281) 747-7421';
const emailWrap = (inner) => `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">${inner}</div>`;
const detailsBox = (rows) => `<div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px">${rows.map((r) => `<div style="margin-bottom:8px">${r}</div>`).join('')}</div>`;
const callLine = (lead) => `<p style="color:#555;font-size:14px">${lead} <a href="tel:2817477421" style="color:#B84A6E">${PHONE}</a>.</p>`;

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', origin.includes('portersnailsandspa.com') ? origin : 'https://portersnailsandspa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { 'Content-Type': 'application/json', 'apikey': KEY, 'Authorization': `Bearer ${KEY}` };
  const db = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers, ...opts });
  const patchAppt = (apptId, fields) => db(`appointments?id=eq.${apptId}`, { method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify(fields) });

  // ── Dashboard login check ──
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const sessRes = await db(`owner_sessions?token=eq.${encodeURIComponent(token)}`);
  const session = sessRes.ok ? (await sessRes.json())[0] : null;
  if (!session || Date.now() > parseInt(session.expiry)) return res.status(401).json({ error: 'Unauthorized' });

  const { id, status, tech_name, new_date, new_time } = req.body || {};
  if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });
  if (!['confirmed', 'declined', 'cancelled', 'rescheduled'].includes(status)) return res.status(400).json({ error: 'Unknown status' });

  try {
    const apptRes = await db(`appointments?id=eq.${encodeURIComponent(id)}&select=*`);
    const appt = apptRes.ok ? (await apptRes.json())[0] : null;
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });

    const techPhone = async (name) => {
      if (!isSpecificTech(name)) return null;
      const r = await db(`nail_techs?name=eq.${encodeURIComponent(name)}&select=phone`);
      return r.ok ? ((await r.json())[0]?.phone || null) : null;
    };
    const opts = (trigger, recipientName) => ({ trigger, recipientName, apptId: appt.id });

    // ── Staff reschedule ───────────────────────────────────────────────
    if (status === 'rescheduled') {
      if (!new_date || !new_time) return res.status(400).json({ error: 'Missing new date/time' });
      const was = fmtWhen(appt.date, appt.time);
      const now = fmtWhen(new_date, new_time);
      const upd = await patchAppt(appt.id, { date: new_date, time: new_time });
      if (!upd.ok) throw new Error(`Supabase error: ${upd.status}`);

      // Move the calendar event too, so it doesn't stay at the old time
      if (appt.calendar_event_id) {
        await deleteAppointmentEvent(appt.calendar_event_id);
        const evId = await createAppointmentEvent({ ...appt, date: new_date, time: new_time });
        await patchAppt(appt.id, { calendar_event_id: evId || null });
      }

      if (canTextCustomer(appt)) await sendSms(appt.phone, `Hi ${appt.name}! Your ${appt.service} at Porter's Nails has been rescheduled to ${now}. Questions? Call ${PHONE}. - Porter's Nails & Spa`, opts('rescheduled', appt.name));
      const tp = await techPhone(appt.tech_name);
      if (tp) await sendSms(tp, `Appointment update: ${appt.name}'s ${appt.service} moved to ${now}. - Porter's Nails`, opts('rescheduled', appt.tech_name));
      if (appt.email) {
        await sendEmail(appt.email, 'Your appointment has been rescheduled', emailWrap(
          `<h2 style="color:#B84A6E">Appointment rescheduled</h2><p>Hi ${appt.name}! Your <strong>${appt.service}</strong> appointment has been moved.</p>` +
          detailsBox([`<strong>Was:</strong> <span style="text-decoration:line-through;color:#888">${was}</span>`, `<strong>Now:</strong> ${now}`]) +
          callLine('Questions? Call')), opts('rescheduled', appt.name));
      }
      return res.status(200).json({ success: true });
    }

    // ── Confirm / decline / cancel ─────────────────────────────────────
    const fields = { status };
    if (status === 'confirmed' && tech_name) fields.tech_name = tech_name;
    const upd = await patchAppt(appt.id, fields);
    if (!upd.ok) throw new Error(`Supabase error: ${upd.status}`);

    const when = fmtWhen(appt.date, appt.time);

    if (status === 'confirmed') {
      const assigned = tech_name || appt.tech_name || 'Any available';

      // Reschedule approval: cancel the original booking and its calendar event
      if (appt.reschedule_of) {
        const origRes = await db(`appointments?id=eq.${appt.reschedule_of}&select=calendar_event_id`);
        const orig = origRes.ok ? (await origRes.json())[0] : null;
        if (orig?.calendar_event_id) await deleteAppointmentEvent(orig.calendar_event_id);
        await patchAppt(appt.reschedule_of, { status: 'cancelled' });
      }
      const evId = await createAppointmentEvent({ ...appt, tech_name: assigned });
      if (evId) await patchAppt(appt.id, { calendar_event_id: evId });

      const withTech = isSpecificTech(assigned) ? ` with ${assigned}` : '';
      if (canTextCustomer(appt)) await sendSms(appt.phone, `Hi ${appt.name}! Your ${appt.service} at Porter's Nails on ${when} is confirmed${withTech}. See you then! - Porter's Nails & Spa`, opts('confirmed', appt.name));
      const tp = await techPhone(assigned);
      if (tp) await sendSms(tp, `Your appointment with ${appt.name} for ${appt.service} on ${when} is confirmed. - Porter's Nails`, opts('confirmed', assigned));
      if (appt.email) {
        await sendEmail(appt.email, 'Your appointment is confirmed! 💅', emailWrap(
          `<h2 style="color:#B84A6E">You're all set, ${appt.name}! 🎉</h2><p style="color:#555;font-size:15px">Your appointment at <strong>Porter's Nails and Spa</strong> is confirmed.</p>` +
          detailsBox([`<strong>Service:</strong> ${appt.service}`, `<strong>When:</strong> ${when}`].concat(isSpecificTech(assigned) ? [`<strong>Your nail tech:</strong> ${assigned}`] : [])) +
          callLine('We look forward to seeing you! Questions? Call') +
          `<p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365</p>`), opts('confirmed', appt.name));
      }
    }

    if (status === 'declined' || status === 'cancelled') {
      if (appt.calendar_event_id) await deleteAppointmentEvent(appt.calendar_event_id);
    }

    if (status === 'declined') {
      if (canTextCustomer(appt)) await sendSms(appt.phone, `Hi ${appt.name}, unfortunately we can't accommodate your requested time (${when}) for ${appt.service}. Please call ${PHONE} and we'll find a time that works. - Porter's Nails`, opts('declined', appt.name));
      if (appt.email) {
        await sendEmail(appt.email, 'About your appointment request', emailWrap(
          `<h2 style="color:#B84A6E">About your appointment request</h2><p style="color:#555;font-size:15px">Hi ${appt.name}, unfortunately we can't accommodate your requested time for <strong>${appt.service}</strong> on ${when}.</p>` +
          callLine("Please call or text us at") + `<p style="color:#555;font-size:14px">We'll find a time that works.</p>`), opts('declined', appt.name));
      }
    }

    if (status === 'cancelled') {
      if (canTextCustomer(appt)) await sendSms(appt.phone, `Hi ${appt.name}, your ${appt.service} at Porter's Nails on ${when} has been cancelled. We're sorry for the inconvenience - please call ${PHONE} to reschedule. - Porter's Nails`, opts('cancelled', appt.name));
      // Let the tech know their slot opened up (only if it had been confirmed with them)
      if (appt.status === 'confirmed') {
        const tp = await techPhone(appt.tech_name);
        if (tp) await sendSms(tp, `Cancellation: ${appt.name}'s ${appt.service} on ${when} was cancelled. The slot is now free. - Porter's Nails`, opts('cancelled', appt.tech_name));
      }
      if (appt.email) {
        await sendEmail(appt.email, 'Your appointment has been cancelled', emailWrap(
          `<h2 style="color:#9a5a5a">Your appointment has been cancelled</h2><p style="color:#555;font-size:15px">Hi ${appt.name}, unfortunately we've had to cancel your appointment at <strong>Porter's Nails and Spa</strong>.</p>` +
          detailsBox([`<strong>Service:</strong> ${appt.service}`, `<strong>When:</strong> ${when}`]) +
          callLine("We're sorry for the inconvenience. Please call us at") ), opts('cancelled', appt.name));
      }
    }

    // If the text-approval queue moved, text managers the next booking
    try { await notifyFront(); } catch (e) { console.error('queue notify failed', e.message); }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Status update error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
