// Porter's Nails — approve, decline, or cancel an appointment
// Also handles assigning a tech when approving "Any available" bookings.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, status, name, email, phone, service, date, time, tech_name, new_date, new_time, old_date, old_time } = req.body;
  if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

  const RESEND_KEY       = process.env.RESEND_KEY;
  const SUPABASE_URL     = process.env.SUPABASE_URL;
  const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    // ── Staff reschedule (owner/tech moves appointment to new date/time) ──
    if (status === 'rescheduled') {
      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ date: new_date, time: new_time })
      });
      if (!updateRes.ok) throw new Error(`Supabase error: ${updateRes.status}`);

      const TWILIO_SID = process.env.TWILIO_SID, TWILIO_TOKEN = process.env.TWILIO_TOKEN, TWILIO_FROM = process.env.TWILIO_FROM;
      const sendSms = async (to, body) => {
        if (!TWILIO_SID || !to) return;
        const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: body }).toString()
        });
      };

      // Text customer
      if (phone) await sendSms(phone, `Hi ${name}! Your ${service} at Porter's Nails has been rescheduled to ${new_date} at ${new_time}. Questions? Call (281) 747-7421.`);

      // Text tech
      if (tech_name && tech_name !== 'Any available') {
        const techRes = await fetch(`${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(tech_name)}&select=phone`, { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } });
        if (techRes.ok) { const rows = await techRes.json(); if (rows[0]?.phone) await sendSms(rows[0].phone, `Appointment update: ${name}'s ${service} moved to ${new_date} at ${new_time}. - Porter's Nails`); }
      }

      // Email customer
      if (email) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: "Porter's Nails <bookings@portersnailsandspa.com>",
            to: [email],
            subject: "Your appointment has been rescheduled",
            html: `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
              <h2 style="color:#B84A6E">Appointment rescheduled 📅</h2>
              <p>Hi ${name}! Your <strong>${service}</strong> appointment has been moved:</p>
              <table style="width:100%;border-collapse:collapse;font-size:15px;margin:16px 0">
                <tr style="border-bottom:1px solid #f0d0d8"><td style="padding:8px 0;font-weight:600;color:#888">Was</td><td style="text-decoration:line-through;color:#888">${old_date} at ${old_time}</td></tr>
                <tr><td style="padding:8px 0;font-weight:600">Now</td><td><strong>${new_date} at ${new_time}</strong></td></tr>
              </table>
              <p style="color:#555;font-size:14px">Questions? Call <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p>
            </div>`
          })
        });
      }
      return res.status(200).json({ success: true });
    }

    // Build the update payload — include tech_name if provided (for "any available" assignments)
    const updatePayload = { status };
    if (tech_name) updatePayload.tech_name = tech_name;

    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(updatePayload)
    });
    if (!dbRes.ok) throw new Error(`Supabase error: ${dbRes.status}`);

    // If this is a reschedule approval, cancel the original booking
    if (status === 'confirmed') {
      const apptRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${id}&select=reschedule_of`, {
        headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` }
      });
      if (apptRes.ok) {
        const apptRows = await apptRes.json();
        if (apptRows[0]?.reschedule_of) {
          await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${apptRows[0].reschedule_of}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}`, 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'cancelled' })
          });
        }
      }
    }

    // ── SMS via Twilio ────────────────────────────────────────────────────
    const TWILIO_SID   = process.env.TWILIO_SID;
    const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
    const TWILIO_FROM  = process.env.TWILIO_FROM;

    const sendSms = async (to, body) => {
      if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !to) return;
      const toNum = '+1' + to.replace(/\D/g,'').slice(-10);
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: toNum, Body: body }).toString()
      });
    };

    const assignedTech = tech_name || null;
    const isConfirmed  = status === 'confirmed';
    const isCancelled  = status === 'cancelled';

    // Text the customer
    if (isConfirmed && id) {
      await sendSms(null, ''); // placeholder — customer phone not passed here yet
    }

    // Text the tech when confirmed
    if (isConfirmed && assignedTech && assignedTech !== 'Any available') {
      const techRes = await fetch(
        `${SUPABASE_URL}/rest/v1/nail_techs?name=eq.${encodeURIComponent(assignedTech)}&select=phone`,
        { headers: { 'apikey': SUPABASE_SVC_KEY, 'Authorization': `Bearer ${SUPABASE_SVC_KEY}` } }
      );
      if (techRes.ok) {
        const techRows = await techRes.json();
        if (techRows[0]?.phone) {
          await sendSms(techRows[0].phone, `Your appointment with ${name} for ${service} on ${date} at ${time} is confirmed. - Porter's Nails`);
        }
      }
    }

    // Send email to customer if they provided one
    if (email) {

      let subject, html;

      if (isConfirmed) {
        subject = "Your appointment is confirmed! 💅";
        html = `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <h2 style="color:#B84A6E">You're all set, ${name}! 🎉</h2>
          <p style="color:#555;font-size:15px">Your appointment at <strong>Porter's Nails and Spa</strong> is confirmed.</p>
          <div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px">
            <div style="margin-bottom:8px"><strong>Service:</strong> ${service}</div>
            <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
            <div style="margin-bottom:8px"><strong>Time:</strong> ${time}</div>
            ${assignedTech ? `<div><strong>Your nail tech:</strong> ${assignedTech}</div>` : ''}
          </div>
          <p style="color:#555;font-size:14px">We look forward to seeing you! Need to reschedule? Call us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a>.</p>
          <p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365 &nbsp;·&nbsp; Mon–Sat 9 AM–6:30 PM</p>
        </div>`;
      } else if (isCancelled) {
        subject = "Your appointment has been cancelled";
        html = `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <h2 style="color:#9a5a5a">Your appointment has been cancelled</h2>
          <p style="color:#555;font-size:15px">Hi ${name}, unfortunately we've had to cancel your appointment at <strong>Porter's Nails and Spa</strong>.</p>
          <div style="background:#fdf8f5;border:1px solid #f0d0d8;border-radius:12px;padding:18px;margin:20px 0;font-size:15px">
            <div style="margin-bottom:8px"><strong>Service:</strong> ${service}</div>
            <div style="margin-bottom:8px"><strong>Date:</strong> ${date}</div>
            <div><strong>Time:</strong> ${time}</div>
          </div>
          <p style="color:#555;font-size:14px">We're sorry for the inconvenience. Please call us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a> to reschedule.</p>
          <p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365</p>
        </div>`;
      } else {
        subject = "About your appointment request";
        html = `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px">
          <h2 style="color:#B84A6E">About your appointment request</h2>
          <p style="color:#555;font-size:15px">Hi ${name}, unfortunately we can't accommodate your requested time.</p>
          <p style="color:#555;font-size:14px">Please call or text us at <a href="tel:2817477421" style="color:#B84A6E">(281) 747-7421</a> and we'll find a time that works for you.</p>
          <p style="color:#aaa;font-size:12px">23830 FM1314 Suite C, Porter, TX 77365</p>
        </div>`;
      }

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: "Porter's Nails <bookings@portersnailsandspa.com>",
          to: [email],
          subject,
          html
        })
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Status update error:', err.message);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
