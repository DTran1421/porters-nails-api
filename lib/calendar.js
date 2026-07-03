// Shared Google Calendar helpers for Porter's Nails
// Creates/deletes events on the salon calendar when appointments are confirmed/cancelled

const { google } = require('googleapis');

const TIMEZONE = 'America/Chicago';
const LOCATION = "23830 FM 1314 Suite C, Porter, TX 77365";
const COLOR_ID = '11'; // Tomato (pinkish-red — closest to rose gold in Google Calendar)

function getCalendarClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
  return google.calendar({ version: 'v3', auth });
}

// Parse appointment date ("2026-06-20") + time ("14:00") into start/end Date objects
function buildEventTimes(date, time) {
  const [year, month, day] = date.split('-').map(Number);
  // time may be stored as "14:00" or "2:00 PM"
  let hour = 0, minute = 0;
  const ampm = time.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (ampm) {
    hour = parseInt(ampm[1]);
    minute = parseInt(ampm[2]);
    if (ampm[3].toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  } else {
    const parts = time.split(':');
    hour = parseInt(parts[0]);
    minute = parseInt(parts[1] || '0');
  }
  const start = new Date(year, month - 1, day, hour, minute);
  const end   = new Date(start.getTime() + 60 * 60 * 1000); // default 1 hour
  return { start, end };
}

// Create a calendar event for a confirmed appointment
// Returns the Google Calendar event ID (stored in appointments.calendar_event_id)
async function createAppointmentEvent(appt) {
  try {
    const cal = getCalendarClient();
    if (!cal) return null;
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) return null;

    const { start, end } = buildEventTimes(appt.date, appt.time);
    const techLine = appt.tech_name && appt.tech_name !== 'Any available' ? `Tech: ${appt.tech_name}` : 'Tech: To be assigned';

    const res = await cal.events.insert({
      calendarId,
      resource: {
        summary: `${appt.name} — ${appt.service}`,
        description: [
          `Customer: ${appt.name}`,
          `Phone: ${appt.phone || 'N/A'}`,
          appt.email ? `Email: ${appt.email}` : null,
          `Service: ${appt.service}`,
          techLine,
          appt.notes ? `Notes: ${appt.notes}` : null
        ].filter(Boolean).join('\n'),
        location: LOCATION,
        colorId: COLOR_ID,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 15 }
          ]
        }
      }
    });
    return res.data.id;
  } catch (err) {
    console.error('Calendar create error:', err.message);
    return null;
  }
}

// Delete a calendar event when appointment is cancelled or declined
async function deleteAppointmentEvent(eventId) {
  if (!eventId) return;
  try {
    const cal = getCalendarClient();
    if (!cal) return;
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId) return;
    await cal.events.delete({ calendarId, eventId });
  } catch (err) {
    // 410 Gone means already deleted — that's fine
    if (!err.message.includes('410')) {
      console.error('Calendar delete error:', err.message);
    }
  }
}

module.exports = { createAppointmentEvent, deleteAppointmentEvent };
