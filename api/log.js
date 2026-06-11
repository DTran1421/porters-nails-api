// Porter's Nails — shared message logging helper
// Call logMessage() after any SMS or email send to record it in Supabase

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_SVC_KEY = process.env.SUPABASE_SERVICE_KEY;

/**
 * @param {object} opts
 * @param {'sms'|'email'} opts.type
 * @param {string} opts.recipient       - phone or email
 * @param {string} [opts.recipientName] - display name
 * @param {string} [opts.subject]       - email subject
 * @param {string} opts.body            - message body (will be truncated)
 * @param {string} opts.trigger         - e.g. 'new_booking', 'confirmed', 'reminder'
 * @param {string} [opts.appointmentId]
 * @param {'sent'|'failed'} [opts.status]
 */
async function logMessage(opts) {
  if (!SUPABASE_URL || !SUPABASE_SVC_KEY) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/message_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SVC_KEY,
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        type:             opts.type,
        recipient:        opts.recipient,
        recipient_name:   opts.recipientName || null,
        subject:          opts.subject       || null,
        body_preview:     (opts.body || '').slice(0, 160),
        trigger:          opts.trigger,
        appointment_id:   opts.appointmentId || null,
        status:           opts.status        || 'sent'
      })
    });
  } catch (_) {
    // logging should never break the main flow
  }
}

module.exports = { logMessage };
