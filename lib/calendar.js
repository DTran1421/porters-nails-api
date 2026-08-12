// Shared Google Calendar helpers for Porter's Nails
// Creates/deletes events on the salon calendar when appointments are confirmed/cancelled

const { google } = require('googleapis');

const TIMEZONE = 'America/Chicago';
const LOCATION = "23830 FM 1314 Suite C, Porter, TX 77365";
const COLOR_ID = '11'; // Tomato — fallback if tech unknown

// Color per nail tech — edit names to match exactly what's in your nail_techs table
const TECH_COLORS = {
  // 1:Lavender, 2:Sage, 3:Grape, 4:Flamingo, 5:Banana
  // 6:Tangerine, 7:Peacock, 8:Graphite, 9:Blueberry, 10:Basil, 11:Tomato
  'Amy':    '4',  // Flamingo (pink)
  'Ivy':    '2',  // Sage (green)
  'Mimi':   '3',  // Grape (purple)
  'Rachel': '6',  // Tangerine (orange)
};

function techColorId(techName) {
  if (!techName) return COLOR_ID;
  // Case-insensitive match
  const key = Object.keys(TECH_COLORS).find(k => k.toLowerCase() === (techName||'').toLowerCase());
  return key ? TECH_COLORS[key] : COLOR_ID;
}

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

// Parse appointment date ("2026-06-20") + time ("14:00") into floating local
// datetime strings (no timezone marker), paired with an explicit timeZone
// field when sent to Google. Building a real Date object here would be
// interpreted in the SERVER's timezone (Vercel defaults to UTC), not Central
// Time, silently shifting every event by the UTC/Central offset — this
// approach sidesteps that entirely by never constructing an absolute instant.
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
  // Date.UTC used purely as a timezone-agnostic scratch calculator for correct
  // day/month/year rollover math (e.g. a 11:30pm appointment + 1hr crossing
  // midnight) — never treated as a real UTC instant, only formatted back out.
  const startMs = Date.UTC(year, month - 1, day, hour, minute);
  const endMs = startMs + 60 * 60 * 1000;
  function fmt(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  }
  return { start: fmt(startMs), end: fmt(endMs) };
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
        colorId: techColorId(appt.tech_name),
        start: { dateTime: start, timeZone: TIMEZONE },
        end:   { dateTime: end,   timeZone: TIMEZONE },
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
