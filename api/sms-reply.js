// Porter's Nails — handles inbound SMS from owners to confirm/decline/assign appointments
const { logMessage } = require('./log');

module.exports = async function handler(req, res) {
  // Twilio sends application/x-www-form-urlencoded POST
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  }

  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const RESEND_KEY       = process.env.RESEND_KEY;
  const OWNER_EMAIL      = process.env.OWNER_EMAIL;
  const TWILIO_SID       = process.env.TWILIO_SID;
  const TWILIO_TOKEN     = process.env.TWILIO_TOKEN;
  const TWILIO_FROM      = process.env.TWILIO_FROM;
  const headers = { 'Content-Type': 'application/json', 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` };

  // Parse Twilio's form-encoded body
  let body = req.body;
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    body = { From: params.get('From'), Body: params.get('Body') };
  }
  const fromPhone = (body.From || '').replace(/\D/g,'').slice(-10);
  const message = (body.Body || '').trim();

  // Reply helper — returns TwiML so Twilio texts the owner back
  const reply = (text) => {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Message></Response>`);
  };

  const sendSms = async (to, text, recipientName, trigger, apptId) => {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
    const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: text }).toString()
    });
    try { await logMessage({ type:'sms', recipient:toNum, recipientName, body:text, trigger, appointmentId:apptId }); } catch(e){}
  };

  const sendEmail = async (to, subject, html) => {
    if (!RESEND_KEY || !to) return;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: "Porter's Nails <bookings@portersnailsandspa.com>", to: [to], subject, html })
    });
  };

  try {
    // Load all booking managers (techs with is_manager=true and a phone)
    const mgrRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?is_manager=eq.true&phone=not.is.null&select=name,phone`, { headers });
    const managers = mgrRes.ok ? await mgrRes.json() : [];
    const responder = managers.find(m => (m.phone||'').replace(/\D/g,'').slice(-10) === fromPhone);

    if (managers.length && !responder) {
      // Unknown sender (likely a customer) — stay silent, don't send a confusing reply.
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }
    const responderName = responder ? responder.name : 'A manager';

    // Helper to broadcast to all OTHER managers
    const broadcastToOthers = async (text, apptId) => {
      for (const m of managers) {
        const mp = (m.phone||'').replace(/\D/g,'').slice(-10);
        if (mp && mp !== fromPhone) await sendSms(m.phone, text, m.name, 'handled_broadcast', apptId);
      }
    };

    const upper = message.toUpperCase();
    const isConfirm = upper.startsWith('CONFIRM');
    const isDecline = upper.startsWith('DECLINE');

    if (!isConfirm && !isDecline) {
      return reply("Reply CONFIRM [tech name] or DECLINE to manage a booking. Example: CONFIRM AMY");
    }

    // Parse optional ref (e.g. JUN20-2PM) and tech name
    const parts = message.split(/\s+/);
    let techName = null;
    let ref = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/\d/.test(p) && /[A-Za-z]/.test(p) && p.includes('-')) { ref = p.toUpperCase(); }
      else if (/^[A-Za-z]+$/.test(p)) { techName = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }
    }

    // Find pending appointments
    const pendRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?status=eq.pending&order=created_at.asc&select=*`, { headers });
    const pending = await pendRes.json();
    if (!pending.length) {
      return reply("There are no pending appointments right now.");
    }

    // Match the appointment
    let appt = null;
    if (ref) {
      // ref looks like JUN20-2PM — match against date+time
      appt = pending.find(a => {
        const d = new Date(a.date + 'T00:00:00');
        const mon = d.toLocaleString('en-US',{month:'short'}).toUpperCase();
        const day = d.getDate();
        const t = (a.time||'').replace(/:00/,'').replace(/\s/g,'').toUpperCase();
        return ref === `${mon}${day}-${t}` || ref.replace(/[^A-Z0-9]/g,'') === `${mon}${day}${t}`.replace(/[^A-Z0-9]/g,'');
      });
      if (!appt) return reply(`Couldn't find a pending booking matching ref ${ref}. Reply CONFIRM [tech] or DECLINE without a ref to act on the oldest pending booking.`);
    } else if (pending.length === 1) {
      appt = pending[0];
    } else {
      // Multiple pending, no ref
      const list = pending.slice(0,5).map(a => {
        const d = new Date(a.date+'T00:00:00');
        const mon = d.toLocaleString('en-US',{month:'short'}).toUpperCase();
        return `${a.name}: ${mon}${d.getDate()}-${(a.time||'').replace(/:00/,'').replace(/\s/g,'')}`;
      }).join('\n');
      return reply(`Multiple pending bookings. Reply with the ref to pick one:\n${list}\n\nExample: CONFIRM AMY ${pending[0] ? (function(a){const d=new Date(a.date+'T00:00:00');return d.toLocaleString('en-US',{month:'short'}).toUpperCase()+d.getDate()+'-'+(a.time||'').replace(/:00/,'').replace(/\s/g,'');})(pending[0]) : 'JUN20-2PM'}`);
    }

    const apptDesc = `${appt.name} — ${appt.service} on ${appt.date} at ${appt.time}`;

    // ── DECLINE ──
    if (isDecline) {
      const upd = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.id}&status=eq.pending`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ status: 'declined' })
      });
      const updRows = await upd.json();
      if (!updRows.length) return reply(`That booking (${appt.name}) was already handled by another manager.`);

      if (appt.phone) await sendSms(appt.phone, `Hi ${appt.name}, unfortunately we can't accommodate your requested time for ${appt.service}. Please call (281) 747-7421 and we'll find a time that works. - Porter's Nails`, appt.name, 'declined', appt.id);
      if (appt.email) await sendEmail(appt.email, "About your appointment request", `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#B84A6E">About your appointment request</h2><p>Hi ${appt.name}, unfortunately we can't accommodate your requested time. Please call or text us at <a href="tel:2817477421">(281) 747-7421</a> and we'll find a time that works.</p></div>`);
      await broadcastToOthers(`✗ Handled by ${responderName}: ${appt.name}'s request (${appt.date} at ${appt.time}) was declined.`, appt.id);
      return reply(`✓ Declined. ${appt.name} has been notified.`);
    }

    // ── CONFIRM ──
    // Determine tech: explicit name > existing specific tech > prompt
    let assignTech = techName;
    if (!assignTech) {
      if (appt.tech_name && appt.tech_name !== 'Any available' && appt.tech_name !== 'To be assigned') {
        assignTech = appt.tech_name;
      } else {
        return reply(`Who should be assigned to ${appt.name}'s ${appt.service}?\nReply CONFIRM [name]: AMY, IVY, MIMI, or RACHEL`);
      }
    }

    // Validate tech exists
    const techRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(assignTech)}&select=name,phone`, { headers });
    const techRows = await techRes.json();
    if (!techRows.length) {
      const allTechs = await (await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?select=name`, { headers })).json();
      const names = allTechs.map(t => t.name.toUpperCase()).join(', ');
      return reply(`"${assignTech}" isn't a known tech. Available: ${names}. Example: CONFIRM ${allTechs[0]?.name?.toUpperCase()||'AMY'}`);
    }

    // Atomic confirm — only if still pending
    const upd = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.id}&status=eq.pending`, {
      method: 'PATCH', headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({ status: 'confirmed', tech_name: assignTech })
    });
    const updRows = await upd.json();
    if (!updRows.length) return reply(`That booking (${appt.name}) was already handled by another manager.`);

    // If this was a reschedule, cancel the original
    if (appt.reschedule_of) {
      await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.reschedule_of}`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'cancelled' })
      });
    }

    // Notify customer
    if (appt.phone) await sendSms(appt.phone, `Hi ${appt.name}! Your ${appt.service} at Porter's Nails on ${appt.date} at ${appt.time} is confirmed with ${assignTech}. See you then! - Porter's Nails & Spa`, appt.name, 'confirmed', appt.id);
    if (appt.email) await sendEmail(appt.email, "Your appointment is confirmed! 💅", `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#B84A6E">You're all set, ${appt.name}! 🎉</h2><div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px"><div style="margin-bottom:8px"><strong>Service:</strong> ${appt.service}</div><div style="margin-bottom:8px"><strong>Date:</strong> ${appt.date}</div><div style="margin-bottom:8px"><strong>Time:</strong> ${appt.time}</div><div><strong>Your nail tech:</strong> ${assignTech}</div></div><p style="color:#555;font-size:14px">Questions? Call <a href="tel:2817477421">(281) 747-7421</a>.</p></div>`);

    // Notify assigned tech
    if (techRows[0].phone) await sendSms(techRows[0].phone, `Hi ${assignTech}! New appointment: ${appt.name} — ${appt.service} on ${appt.date} at ${appt.time}. - Porter's Nails`, assignTech, 'confirmed', appt.id);

    // Email owner receipt
    if (OWNER_EMAIL) await sendEmail(OWNER_EMAIL, `Confirmed — ${appt.name}`, `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#3B6D11">✓ Appointment Confirmed</h2><p><strong>${responderName}</strong> confirmed <strong>${appt.name}'s</strong> appointment via text.</p><table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0"><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">Service</td><td>${appt.service}</td></tr><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">When</td><td>${appt.date} at ${appt.time}</td></tr><tr><td style="padding:8px 0;font-weight:600">Assigned to</td><td>${assignTech}</td></tr></table><p style="color:#555;font-size:13px">${appt.name} and ${assignTech} have been notified.</p></div>`);

    await broadcastToOthers(`✓ Handled by ${responderName}: ${appt.name} confirmed with ${assignTech}, ${appt.date} at ${appt.time}.`, appt.id);
    return reply(`✓ Confirmed! ${appt.name} assigned to ${assignTech}. Customer${techRows[0].phone ? ' and '+assignTech : ''} notified.`);

  } catch (err) {
    console.error('SMS reply error:', err.message);
    return reply("Something went wrong processing that. Please use the dashboard.");
  }
};
