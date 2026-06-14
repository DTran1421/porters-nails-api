// Porter's Nails — booking handler
// GET  → returns all appointments for the dashboard
// POST → receives a new booking, stores it, emails owner + customer

const { logMessage } = require('./log');

module.exports = async function handler(req, res) {
  var origin = req.headers.origin || '';
  if (origin.includes('portersnailsandspa.com')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://portersnailsandspa.com');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const RESEND_KEY       = process.env.RESEND_KEY;
  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const OWNER_EMAIL      = process.env.OWNER_EMAIL;

  // ── GET ───────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      if (req.query.settings === '1') {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/site_settings`, {
          headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        const rows = await r.json();
        const out = {};
        rows.forEach(row => out[row.key] = row.value);
        return res.status(200).json(out);
      }
      if (req.query.techs === '1') {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?order=name.asc`, {
          headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        return res.status(200).json(await r.json());
      }
      if (req.query.slots === '1') {
        const { tech, date } = req.query;
        if (!date) return res.status(200).json({ booked: [], bookedByTech: {} });
        if (tech === 'any') {
          const r = await fetch(
            `${SUPABASE_URL}/rest/v1/appointments?date=eq.${date}&status=in.(pending,confirmed)&select=tech_name,time`,
            { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
          );
          if (!r.ok) throw new Error(`Supabase ${r.status}`);
          const rows = await r.json();
          const bookedByTech = {};
          rows.forEach(row => {
            if (!bookedByTech[row.tech_name]) bookedByTech[row.tech_name] = [];
            bookedByTech[row.tech_name].push(row.time);
          });
          return res.status(200).json({ bookedByTech });
        }
        if (!tech) return res.status(200).json({ booked: [] });
        const exclude = req.query.exclude || '';
        const anyFilter = exclude
          ? `tech_name=in.(Any%20available,To%20be%20assigned)&date=eq.${date}&status=in.(pending,confirmed)&id=neq.${exclude}&select=time`
          : `tech_name=in.(Any%20available,To%20be%20assigned)&date=eq.${date}&status=in.(pending,confirmed)&select=time`;
        const [techRes, anyRes, blockRes] = await Promise.all([
          fetch(`${SUPABASE_URL}/rest/v1/appointments?tech_name=eq.${encodeURIComponent(tech)}&date=eq.${date}&status=in.(pending,confirmed)&select=time`,
            { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }),
          fetch(`${SUPABASE_URL}/rest/v1/appointments?${anyFilter}`,
            { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }),
          fetch(`${SUPABASE_URL}/rest/v1/blocked_times?date=eq.${date}&or=(tech_name.eq.${encodeURIComponent(tech)},tech_name.is.null)`,
            { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } })
        ]);
        if (!techRes.ok || !anyRes.ok) throw new Error('Supabase query failed');
        const techRows  = await techRes.json();
        const anyRows   = await anyRes.json();
        const blockRows = blockRes.ok ? await blockRes.json() : [];
        const blockedTimes = [];
        blockRows.forEach(b => { if (!b.start_time && !b.end_time) blockedTimes.push('ALL_DAY'); });
        const booked = [...new Set([...techRows.map(a => a.time), ...anyRows.map(a => a.time)])];
        return res.status(200).json({ booked, blocked: blockedTimes });
      } else {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/appointments?order=date.asc,time.asc`, {
          headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        return res.status(200).json(await r.json());
      }
    } catch (err) {
      console.error('GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: create a new booking ─────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, phone, email, service, category, techName, date, time, notes, priceLabel, walkin } = req.body;
  if (!name || !phone || !service) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const apptStatus = walkin ? 'confirmed' : 'pending';

    // Re-check slot availability to prevent double-booking (skip for walk-ins and "any available")
    if (!walkin && date && time && techName && techName !== 'Any available' && techName !== 'To be assigned') {
      const conflictRes = await fetch(
        `${SUPABASE_URL}/rest/v1/appointments?date=eq.${date}&time=eq.${encodeURIComponent(time)}&status=in.(pending,confirmed)&or=(tech_name.eq.${encodeURIComponent(techName)},tech_name.in.(Any%20available,To%20be%20assigned))&select=id`,
        { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
      );
      if (conflictRes.ok) {
        const conflicts = await conflictRes.json();
        if (conflicts.length > 0) {
          return res.status(409).json({ error: 'slot_taken', message: 'Sorry, that time was just booked. Please pick another time.' });
        }
      }
    }

    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`, 'Prefer': 'return=representation' },
      body: JSON.stringify({ name, phone, email: email || null, service, category,
        tech_name: techName, date, time, notes: notes || null, price: priceLabel || null, status: apptStatus, token })
    });
    if (!dbRes.ok) throw new Error(`Supabase error: ${dbRes.status}`);
    const [newAppt] = await dbRes.json();
    const apptId = newAppt?.id;

    // ── Email owner ───────────────────────────────────────────────────
    const ownerEmailBody = `New booking request from ${name}: ${service} on ${date} at ${time}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: "Porter's Nails <bookings@portersnailsandspa.com>",
        to: [OWNER_EMAIL],
        subject: `New booking request — ${name}`,
        html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <h2 style="color:#B84A6E;margin-bottom:16px">💅 New Appointment Request</h2>
          <table style="width:100%;border-collapse:collapse;font-size:15px">
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600;width:110px">Name</td><td>${name}</td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Phone</td><td><a href="tel:${phone}">${phone}</a></td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Email</td><td>${email || 'Not provided'}</td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Service</td><td>${service}${priceLabel ? ' — ' + priceLabel : ''} <span style="color:#888">(${category})</span></td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Tech</td><td>${techName}</td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Date</td><td>${date}</td></tr>
            <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:10px 0;font-weight:600">Time</td><td>${time}</td></tr>
            <tr><td style="padding:10px 0;font-weight:600">Notes</td><td>${notes || 'None'}</td></tr>
          </table>
          <a href="https://portersnailsandspa.com/manage/"
            style="display:inline-block;margin-top:24px;background:#B84A6E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
            Open Dashboard →</a>
        </div>`
      })
    });
    await logMessage({ type:'email', recipient:OWNER_EMAIL, recipientName:'Owner', subject:`New booking request — ${name}`, body:ownerEmailBody, trigger:'new_booking', appointmentId:apptId });

    // ── Email customer ────────────────────────────────────────────────
    if (email) {
      const custSubject = "We got your booking request! 💅";
      const custBody = `Hi ${name}! We received your appointment request for ${service} on ${date} at ${time}.`;
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "Porter's Nails <bookings@portersnailsandspa.com>",
          to: [email],
          subject: custSubject,
          html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
            <h2 style="color:#B84A6E">Thanks, ${name}!</h2>
            <p style="color:#555;font-size:15px">We received your appointment request at <strong>Porter's Nails and Spa</strong>. We'll confirm it shortly!</p>
            <div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px">
              <div style="margin-bottom:8px"><strong>Service:</strong> ${service}</div>
              <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
              <div><strong>Time:</strong> ${time}</div>
            </div>
            <p style="color:#555;font-size:14px">Questions? Call or text us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p>
            <a href="https://portersnailsandspa.com?booking=${token}" style="display:inline-block;margin-top:16px;background:#B84A6E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View or reschedule my booking →</a>
            <p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365<br>Mon–Sat 9 AM–6:30 PM</p>
          </div>`
        })
      });
      await logMessage({ type:'email', recipient:email, recipientName:name, subject:custSubject, body:custBody, trigger:'new_booking', appointmentId:apptId });
    }

    // ── SMS ───────────────────────────────────────────────────────────
    const TWILIO_SID   = process.env.TWILIO_SID;
    const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
    const TWILIO_FROM  = process.env.TWILIO_FROM;

    const sendSms = async (to, body, recipientName, trigger) => {
      if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
      const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: body }).toString()
      });
      await logMessage({ type:'sms', recipient:toNum, recipientName, body, trigger, appointmentId:apptId });
    };

    if (phone) {
      await sendSms(phone, `Hi ${name}! We received your appointment request for ${service} on ${date} at ${time}. We'll confirm shortly! Questions? Call (281) 747-7421. - Porter's Nails & Spa`, name, 'new_booking');
    }

    // Notify all booking managers (techs with is_manager=true and a phone)
    const mgrRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?is_manager=eq.true&phone=not.is.null&select=name,phone`, { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } });
    const managers = mgrRes.ok ? await mgrRes.json() : [];
    if (managers.length) {
      const d = new Date(date + 'T00:00:00');
      const mon = d.toLocaleString('en-US',{month:'short'}).toUpperCase();
      const ref = `${mon}${d.getDate()}-${(time||'').replace(/:00/,'').replace(/\s/g,'').toUpperCase()}`;
      const techLine = (techName && techName !== 'Any available' && techName !== 'To be assigned') ? `Requested: ${techName}` : 'Requested: Any available';
      const ownerMsg = `New booking: ${name}\n${service} — ${date} at ${time}\n${techLine}\nReply CONFIRM [name] or DECLINE\nRef: ${ref}`;
      for (const m of managers) {
        await sendSms(m.phone, ownerMsg, m.name, 'new_booking');
      }
    }

    if (techName && techName !== 'Any available' && techName !== 'To be assigned') {
      const techRes = await fetch(
        `${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(techName)}&select=phone`,
        { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
      );
      if (techRes.ok) {
        const techRows = await techRes.json();
        if (techRows[0]?.phone) {
          await sendSms(techRows[0].phone, `New booking: ${name} requested ${service} on ${date} at ${time}. Check the dashboard. - Porter's Nails`, techName, 'new_booking');
        }
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('POST error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please call (281) 747-7421.' });
  }
};
