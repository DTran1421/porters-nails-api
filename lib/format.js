// Porter's Nails — friendly formatting for texts and emails
// Appointments store date as "2026-11-18" and time as "18:00" (older rows may say "6:00 PM").

// "18:00" -> "6:00 PM"; already-friendly times pass through
function fmtTime(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (/[ap]\.?m\.?$/i.test(s)) return s.replace(/\s*([ap])\.?m\.?$/i, (_, ap) => ' ' + ap.toUpperCase() + 'M');
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return s;
  const h = +m[1];
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

// "2026-11-18" -> "Wed, Nov 18"
function fmtDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return d || '';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// "Wed, Nov 18 at 6:00 PM"
const fmtWhen = (d, t) => (t ? `${fmtDate(d)} at ${fmtTime(t)}` : fmtDate(d));

// Plain-text version of an email, for the message log
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return /^(tel:|mailto:)/i.test(href) || text === href ? text : `${text} (${href})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|tr|table|li)>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, ': ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

module.exports = { fmtTime, fmtDate, fmtWhen, htmlToText };
