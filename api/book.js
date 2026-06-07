// Porter's Nails — booking handler
// GET  → returns all appointments for the dashboard
// POST → receives a new booking, stores it, emails owner + customer

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const RESEND_KEY       = process.env.RESEND_KEY;
  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;
  const OWNER_EMAIL      = process.env.OWNER_EMAIL;

  // ── GET: return appointments OR booked slots ──────────────────────────
  if (req.method === 'GET') {
    try {
      if (req.query.slots === '1') {
        // Return booked time slots for a specific tech + date (for booking wizard)
        const { tech, date } = req.query;
        if (!date) return res.status(200).json({ booked: [], bookedByTech: {} });
        if (tech === 'any') {
          // Return booked slots grouped by tech for this date (for "anyone available" mode)
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
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/appointments?tech_name=eq.${encodeURIComponent(tech)}&date=eq.${date}&status=in.(pending,confirmed)&select=time`,
          { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
        );
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        const rows = await r.json();
        return res.status(200).json({ booked: rows.map(a => a.time) });
      } else {
        // Return all appointments for the owner dashboard
        const r = await fetch(`${SUPABASE_URL}/rest/v1/appointments?order=date.asc,time.asc`, {
          headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
        });
        if (!r.ok) throw new Error(`Supabase ${r.status}`);
        const data = await r.json();
        return res.status(200).json(data);
      }
    } catch (err) {
      console.error('GET error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }


  // ── POST: create a new booking ─────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, phone, email, service, category, techName, date, time, notes, priceLabel } = req.body;
  if (!name || !phone || !service) return res.status(400).json({ error: 'Missing required fields' });

  try {
    // 1 — Store in Supabase
    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ name, phone, email: email || null, service, category,
        tech_name: techName, date, time, notes: notes || null, price: priceLabel || null, status: 'pending' })
    });
    if (!dbRes.ok) throw new Error(`Supabase error: ${dbRes.status}`);

    // 2 — Notify owner
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
          <a href="https://portersnailsandspa.com/manage/manage.html"
            style="display:inline-block;margin-top:24px;background:#B84A6E;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">
            Open Dashboard →</a>
        </div>`
      })
    });

    // 3 — Confirm to customer
    if (email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "Porter's Nails <bookings@portersnailsandspa.com>",
          to: [email],
          subject: "We got your booking request! 💅",
          html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
            <h2 style="color:#B84A6E">Thanks, ${name}!</h2>
            <p style="color:#555;font-size:15px">We received your appointment request at <strong>Porter's Nails and Spa</strong>. We'll confirm it shortly!</p>
            <div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px">
              <div style="margin-bottom:8px"><strong>Service:</strong> ${service}</div>
              <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
              <div><strong>Time:</strong> ${time}</div>
            </div>
            <p style="color:#555;font-size:14px">Questions? Call or text us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p>
            <p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365<br>Mon–Sat 9 AM–6:30 PM</p>
          </div>`
        })
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('POST error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please call (281) 747-7421.' });
  }
};
