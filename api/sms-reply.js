// Porter's Nails — handles inbound SMS from owners to confirm/decline/assign appointments
const { logMessage } = require('./log');
const { createAppointmentEvent, deleteAppointmentEvent } = require('../lib/calendar');
const { getQueue, getTechs, wasPrompted, promptText, listText, notifyFront, refFor, isSpecificTech } = require('../lib/queue');

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

  // Everything that comes in and goes out here is written to the message log,
  // so the dashboard shows the full back-and-forth.
  let senderName = 'Unknown';          // set once we know who texted
  let inbound = { trigger: 'reply_received', apptId: null };  // SKIP overrides this (the queue reads it)
  const logRow = (recipientName, text, trigger, apptId) =>
    logMessage({ type: 'sms', recipient: '+1' + fromPhone, recipientName, body: text, trigger, appointmentId: apptId }).catch(() => {});

  // Reply helper — logs the incoming text and our answer, then returns TwiML so Twilio texts it back
  let inboundLogged = false;
  const logInbound = async () => {
    if (inboundLogged) return;
    inboundLogged = true;
    await logRow(`From ${senderName}`, message, inbound.trigger, inbound.apptId);
  };
  const reply = async (text, outTrigger = 'auto_reply', outApptId = null) => {
    await logInbound();
    await logRow(senderName, text, outTrigger, outApptId);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${text.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Message></Response>`);
  };

  const sendSms = async (to, text, recipientName, trigger, apptId) => {
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
    const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
    const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: text }).toString()
    });
    try { await logMessage({ type:'sms', recipient:toNum, recipientName, body:text, trigger, appointmentId:apptId , status: tw.ok ? 'sent' : 'failed' }); } catch(e){}
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
      // Unknown sender (likely a customer) — polite redirect to call or visit the site.
      senderName = 'customer';
      inbound.trigger = 'customer_text';
      return reply("Thanks for reaching out to Porter's Nails & Spa! This number isn't monitored for texts. Please call us at (281) 747-7421 or book online at portersnailsandspa.com. 💅");
    }
    const responderName = responder ? responder.name : 'A manager';
    senderName = responderName;

    const upper = message.toUpperCase();
    const firstWord = (upper.split(/\s+/)[0] || '');
    const isConfirm = ['CONFIRM', 'CONFIRMED', 'YES', 'Y'].includes(firstWord);
    const isDecline = ['DECLINE', 'DECLINED', 'NO', 'N'].includes(firstWord);
    const isSkip = firstWord === 'SKIP';
    const isList = ['LIST', 'QUEUE', 'PENDING'].includes(firstWord);

    const { queue, skipped } = await getQueue();
    const techs = await getTechs();

    // ── LIST ──
    if (isList) return reply(listText(queue, skipped), 'list_reply');

    if (!isConfirm && !isDecline && !isSkip) {
      return reply("Reply YES (+ tech # or name), NO, SKIP, or LIST. Example: YES 2");
    }

    // Parse optional ref (e.g. NOV20-2PM), tech number, or tech name
    const parts = message.split(/\s+/);
    let techName = null;
    let techNum = null;
    let ref = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].replace(/^#/, '');
      if (/\d/.test(p) && /[A-Za-z]/.test(p) && p.includes('-')) { ref = p.toUpperCase(); }
      else if (/^\d{1,2}$/.test(p)) { techNum = parseInt(p, 10); }
      else if (/^[A-Za-z]+$/.test(p)) { techName = p.charAt(0).toUpperCase() + p.slice(1).toLowerCase(); }
    }

    // Pick the booking: an explicit ref still works (any pending booking),
    // otherwise it's always the one at the front of the queue.
    let appt = null;
    if (ref) {
      const all = [...queue, ...skipped];
      appt = all.find(a => {
        const r = refFor(a);
        return ref === r || ref.replace(/[^A-Z0-9]/g,'') === r.replace(/[^A-Z0-9]/g,'');
      });
      if (!appt) return reply(`Couldn't find a pending booking matching ${ref}. Reply LIST to see what's waiting.`);
    } else {
      appt = queue[0];
      if (!appt) {
        return reply(skipped.length
          ? `Nothing waiting by text. ${skipped.length} skipped booking${skipped.length > 1 ? 's are' : ' is'} on the dashboard.`
          : "There are no pending appointments right now.");
      }
      // Never act on a booking this person hasn't been shown — show it first
      if (!(await wasPrompted(appt.id, fromPhone))) {
        const text = "Heads up - this is the booking waiting now. Reply again to act on it.\n\n" + promptText(appt, queue.length, techs);
        return reply(text, 'approval_prompt', appt.id);
      }
    }

    // After handling a booking: catch up the other managers, then build this
    // person's reply with the next booking in line attached.
    const finish = async (doneLine, notice, handledId) => {
      const { front: next, queue: q } = await notifyFront({ excludePhone: fromPhone, notice, noticeApptId: handledId });
      if (next) {
        const text = doneLine + '\n\n' + promptText(next, q.length, techs, { nextUp: true });
        return reply(text, 'approval_prompt', next.id);
      }
      const { skipped: sk } = await getQueue();
      return reply(doneLine + (sk.length ? `\nNothing else waiting by text (${sk.length} skipped on the dashboard).` : '\nAll caught up!'));
    };

    // ── SKIP ── leave it pending for the dashboard and move on
    if (isSkip) {
      // The logged incoming "SKIP" (tagged with this booking) is what takes it out of the text queue
      inbound = { trigger: 'queue_skip', apptId: appt.id };
      await logInbound();  // must be saved before we look up the next booking
      return finish(`Skipped ${appt.name}. It's still pending on the dashboard.`,
        `${responderName} skipped ${appt.name}'s request (left for the dashboard).`, appt.id);
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

      // Delete calendar event if one exists
      if (appt.calendar_event_id) await deleteAppointmentEvent(appt.calendar_event_id);

      if (appt.phone && appt.sms_opt_in) await sendSms(appt.phone, `Hi ${appt.name}, unfortunately we can't accommodate your requested time for ${appt.service}. Please call (281) 747-7421 and we'll find a time that works. - Porter's Nails`, appt.name, 'declined', appt.id);
      if (appt.email) await sendEmail(appt.email, "About your appointment request", `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#B84A6E">About your appointment request</h2><p>Hi ${appt.name}, unfortunately we can't accommodate your requested time. Please call or text us at <a href="tel:2817477421">(281) 747-7421</a> and we'll find a time that works.</p></div>`);
      return finish(`Declined ${appt.name}. They've been notified.`,
        `Handled by ${responderName}: ${appt.name}'s request (${appt.date} at ${appt.time}) was declined.`, appt.id);
    }

    // ── CONFIRM ──
    // Determine tech: explicit name > existing specific tech > prompt
    // Determine tech: number from the menu > name > the tech they requested > ask
    let assignTech = techName;
    if (techNum !== null) {
      if (!techs[techNum - 1]) {
        return reply(`There's no tech #${techNum}. Techs: ${techs.map((t, i) => `${i + 1} ${t.name}`).join(', ')}`);
      }
      assignTech = techs[techNum - 1].name;
    }
    if (!assignTech) {
      if (isSpecificTech(appt.tech_name)) {
        assignTech = appt.tech_name;
      } else {
        return reply(`Which tech for ${appt.name}'s ${appt.service}? Reply YES + number:\n${techs.map((t, i) => `${i + 1} ${t.name}`).join(', ')}`);
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

    // Create Google Calendar event
    const calEventId = await createAppointmentEvent({ ...appt, tech_name: assignTech });
    if (calEventId) {
      await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.id}`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ calendar_event_id: calEventId })
      });
    }

    // If this was a reschedule, cancel the original and delete its calendar event
    if (appt.reschedule_of) {
      const origRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.reschedule_of}&select=calendar_event_id`, { headers });
      const origRows = await origRes.json();
      if (origRows[0]?.calendar_event_id) await deleteAppointmentEvent(origRows[0].calendar_event_id);
      await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${appt.reschedule_of}`, {
        method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'cancelled' })
      });
    }

    // Notify customer
    if (appt.phone && appt.sms_opt_in) await sendSms(appt.phone, `Hi ${appt.name}! Your ${appt.service} at Porter's Nails on ${appt.date} at ${appt.time} is confirmed with ${assignTech}. See you then! - Porter's Nails & Spa`, appt.name, 'confirmed', appt.id);
    if (appt.email) await sendEmail(appt.email, "Your appointment is confirmed! 💅", `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#B84A6E">You're all set, ${appt.name}! 🎉</h2><div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px"><div style="margin-bottom:8px"><strong>Service:</strong> ${appt.service}</div><div style="margin-bottom:8px"><strong>Date:</strong> ${appt.date}</div><div style="margin-bottom:8px"><strong>Time:</strong> ${appt.time}</div><div><strong>Your nail tech:</strong> ${assignTech}</div></div><p style="color:#555;font-size:14px">Questions? Call <a href="tel:2817477421">(281) 747-7421</a>.</p></div>`);

    // Notify assigned tech
    if (techRows[0].phone) await sendSms(techRows[0].phone, `Hi ${assignTech}! New appointment: ${appt.name} — ${appt.service} on ${appt.date} at ${appt.time}. - Porter's Nails`, assignTech, 'confirmed', appt.id);

    // Email owner receipt
    if (OWNER_EMAIL) await sendEmail(OWNER_EMAIL, `Confirmed — ${appt.name}`, `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px"><h2 style="color:#3B6D11">✓ Appointment Confirmed</h2><p><strong>${responderName}</strong> confirmed <strong>${appt.name}'s</strong> appointment via text.</p><table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0"><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">Service</td><td>${appt.service}</td></tr><tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600">When</td><td>${appt.date} at ${appt.time}</td></tr><tr><td style="padding:8px 0;font-weight:600">Assigned to</td><td>${assignTech}</td></tr></table><p style="color:#555;font-size:13px">${appt.name} and ${assignTech} have been notified.</p></div>`);

    return finish(`Confirmed ${appt.name} with ${assignTech}. Customer${techRows[0].phone ? ' and ' + assignTech : ''} notified.`,
      `Handled by ${responderName}: ${appt.name} confirmed with ${assignTech}, ${appt.date} at ${appt.time}.`, appt.id);

  } catch (err) {
    console.error('SMS reply error:', err.message);
    return reply("Something went wrong processing that. Please use the dashboard.");
  }
};
