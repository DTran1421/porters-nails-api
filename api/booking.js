// Porter's Nails — booking lookup by token (for customer self-service)
const { logMessage } = require('./log');
const { deleteAppointmentEvent } = require('../lib/calendar');
module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (origin.includes('portersnailsandspa.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY       = process.env.RESEND_KEY;
  const OWNER_EMAIL      = process.env.OWNER_EMAIL;
  const TWILIO_SID       = process.env.TWILIO_SID;
  const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
  const TWILIO_FROM      = process.env.TWILIO_FROM;
  const headers = { 'Content-Type': 'application/json', 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` };

  const sendSms = async (to, body, recipientName, trigger, apptId) => {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
    const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: body }).toString()
    });
    try { await logMessage({ type:'sms', recipient:toNum, recipientName, body, trigger, appointmentId:apptId }); } catch(e){}
  };

  // ── Customer self-cancellation ───────────────────────────────────────
  if (req.method === 'DELETE') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/appointments?token=eq.${token}&select=*`, { headers });
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
      const appt = rows[0];

      // Atomic cancel — only if still pending or confirmed
      const upd = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.id}&status=in.(pending,confirmed)`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'cancelled' })
      });
      const updRows = await upd.json();
      if (!updRows.length) return res.status(409).json({ error: 'This appointment was already cancelled or completed.' });

      // Delete Google Calendar event if one exists
      if (appt.calendar_event_id) await deleteAppointmentEvent(appt.calendar_event_id);

      // Notify customer
      if (appt.phone) await sendSms(appt.phone, `Hi ${appt.name}, your ${appt.service} on ${appt.date} at ${appt.time} has been cancelled. To rebook, call (281) 747-7421. - Porter's Nails`, appt.name, 'customer_cancelled', appt.id);
      if (appt.email && RESEND_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: "Porter's Nails <bookings@portersnailsandspa.com>",
            to: [appt.email], subject: "Your appointment has been cancelled",
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#9a5a5a">Appointment cancelled</h2><p>Hi ${appt.name}, your <strong>${appt.service}</strong> on ${appt.date} at ${appt.time} has been cancelled as requested.</p><p style="color:#555;font-size:14px">Want to rebook? Call us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p></div>`
          })
        });
        try { await logMessage({ type:'email', recipient:appt.email, recipientName:appt.name, subject:'Your appointment has been cancelled', body:'Customer cancelled', trigger:'customer_cancelled', appointmentId:appt.id }); } catch(e){}
      }
      // Notify owner
      if (OWNER_EMAIL && RESEND_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: "Porter's Nails <bookings@portersnailsandspa.com>",
            to: [OWNER_EMAIL], subject: `Cancellation — ${appt.name}`,
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#9a5a5a">Appointment cancelled by customer</h2><p><strong>${appt.name}</strong> cancelled their appointment.</p><table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0"><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">Service</td><td>${appt.service}</td></tr><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">When</td><td>${appt.date} at ${appt.time}</td></tr><tr><td style="padding:8px 0;font-weight:600">Tech</td><td>${appt.tech_name||'Any available'}</td></tr></table><p style="color:#3B6D11;font-size:14px">This slot is now open for new bookings.</p></div>`
          })
        });
      }
      // Notify assigned tech
      if (appt.tech_name && appt.tech_name !== 'Any available') {
        const techRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(appt.tech_name)}&select=phone`, { headers });
        if (techRes.ok) { const tr = await techRes.json(); if (tr[0]?.phone) await sendSms(tr[0].phone, `Cancellation: ${appt.name}'s ${appt.service} on ${appt.date} at ${appt.time} was cancelled. The slot is now free. - Porter's Nails`, appt.tech_name, 'customer_cancelled', appt.id); }
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/appointments?token=eq.${token}&select=*`, { headers });
      if (!r.ok) throw new Error(`Supabase ${r.status}`);
      const rows = await r.json();
      if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
      return res.status(200).json(rows[0]);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { original_token, name, phone, email, service, category, techName, date, time, notes, priceLabel } = req.body;
    if (!original_token) return res.status(400).json({ error: 'Missing original_token' });

    try {
      const origRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?token=eq.${original_token}&select=*`, { headers });
      const origRows = await origRes.json();
      if (!origRows.length) return res.status(404).json({ error: 'Original booking not found' });
      const orig = origRows[0];

      const newToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          name: name || orig.name, phone: phone || orig.phone, email: email || orig.email,
          service: service || orig.service, category: category || orig.category,
          tech_name: techName || orig.tech_name, date, time,
          notes: notes || orig.notes, price: priceLabel || orig.price,
          status: 'pending', token: newToken, reschedule_of: orig.id
        })
      });
      if (!insertRes.ok) throw new Error(`Insert failed ${insertRes.status}`);
      const [newAppt] = await insertRes.json();
      const apptId = newAppt?.id;

      // Email owner
      const ownerSubject = `Reschedule request — ${orig.name}`;
      const ownerBody = `${orig.name} wants to reschedule from ${orig.date} at ${orig.time} to ${date} at ${time}`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "Porter's Nails <bookings@portersnailsandspa.com>",
          to: [OWNER_EMAIL], subject: ownerSubject,
          html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
            <h2 style="color:#B84A6E">📅 Reschedule Request</h2>
            <p><strong>${orig.name}</strong> wants to reschedule their appointment.</p>
            <table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0">
              <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">Original</td><td>${orig.service} — ${orig.date} at ${orig.time}</td></tr>
              <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">Requested</td><td>${service || orig.service} — ${date} at ${time}</td></tr>
              <tr><td style="padding:8px 0;font-weight:600">Tech</td><td>${techName || orig.tech_name}</td></tr>
            </table>
            <a href="https://portersnailsandspa.com/manage/" style="display:inline-block;margin-top:16px;background:#B84A6E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">Open Dashboard →</a>
          </div>`
        })
      });
      await logMessage({ type:'email', recipient:OWNER_EMAIL, recipientName:'Owner', subject:ownerSubject, body:ownerBody, trigger:'reschedule_request', appointmentId:orig.id });

      // Email customer
      if (orig.email) {
        const custSubject = "We received your reschedule request";
        const custBody = `Hi ${orig.name}! We received your request to reschedule to ${date} at ${time}.`;
        const bookingUrl = `https://portersnailsandspa.com?booking=${newToken}`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: "Porter's Nails <bookings@portersnailsandspa.com>",
            to: [orig.email], subject: custSubject,
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
              <h2 style="color:#B84A6E">Reschedule request received!</h2>
              <p>Hi ${orig.name}! We received your request to reschedule to <strong>${date}</strong> at <strong>${time}</strong>. We'll confirm it shortly.</p>
              <p style="color:#555;font-size:14px">Your original appointment remains active until we confirm the change. Questions? Call <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p>
              <a href="${bookingUrl}" style="display:inline-block;margin-top:16px;background:#B84A6E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">View your booking →</a>
            </div>`
          })
        });
        await logMessage({ type:'email', recipient:orig.email, recipientName:orig.name, subject:custSubject, body:custBody, trigger:'reschedule_request', appointmentId:orig.id });
      }

      return res.status(200).json({ success: true, token: newToken });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
