/** Current calendar date & clock in Asia/Kolkata (for automation). */
function istNow() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const timeStr = `${hour}:${get('minute')}:${get('second')}`;
  return { dateStr, timeStr };
}

function toMySqlTime(v, defaultHour, defaultMin) {
  if (v == null || v === '') {
    return `${String(defaultHour).padStart(2, '0')}:${String(defaultMin).padStart(2, '0')}:00`;
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) {
    return `${String(defaultHour).padStart(2, '0')}:${String(defaultMin).padStart(2, '0')}:00`;
  }
  const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, '0');
  const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, '0');
  const ss =
    m[3] != null ? String(Math.min(59, Math.max(0, parseInt(m[3], 10)))).padStart(2, '0') : '00';
  return `${hh}:${mm}:${ss}`;
}

function sqlTimeToHms(v) {
  if (v == null || v === '') return '12:00:00';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return [
      String(v.getHours()).padStart(2, '0'),
      String(v.getMinutes()).padStart(2, '0'),
      String(v.getSeconds()).padStart(2, '0'),
    ].join(':');
  }
  if (typeof v === 'object' && v !== null) {
    const s = String(v);
    if (/^\d{2}:\d{2}/.test(s)) return toMySqlTime(s, 12, 0);
  }
  const s = String(v);
  if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{2}:\d{2}$/.test(s)) return `${s}:00`;
  return toMySqlTime(s, 12, 0);
}

function sessionEnvelope(slotWindows) {
  if (!Array.isArray(slotWindows) || !slotWindows.length) {
    return { sessionOpen: '12:00:00', sessionClose: '13:00:00' };
  }
  let minO = sqlTimeToHms(slotWindows[0].open_time);
  let maxC = sqlTimeToHms(slotWindows[0].close_time);
  for (let i = 1; i < slotWindows.length; i++) {
    const w = slotWindows[i];
    const o = sqlTimeToHms(w.open_time);
    const c = sqlTimeToHms(w.close_time);
    if (o < minO) minO = o;
    if (c > maxC) maxC = c;
  }
  return { sessionOpen: minO, sessionClose: maxC };
}

function istTimeInSlotWindowInclusive(timeStr, openStr, closeStr) {
  const t = sqlTimeToHms(timeStr);
  const o = sqlTimeToHms(openStr);
  const c = sqlTimeToHms(closeStr);
  return t >= o && t <= c;
}

function istWeekdayName(dateStr) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
  }).format(new Date(`${dateStr}T12:00:00+05:30`));
}

function isWeekendIST(dateStr) {
  const day = istWeekdayName(dateStr);
  return day === 'Saturday' || day === 'Sunday';
}

/** Mon–Fri IST — ROI trading days. */
function isRoiTradingDayIST(dateStr) {
  return !isWeekendIST(dateStr);
}

/** Normalize MySQL DATE / DATETIME to YYYY-MM-DD (IST for Date objects). */
function normalizeSqlDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(value);
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

module.exports = {
  istNow,
  toMySqlTime,
  sqlTimeToHms,
  sessionEnvelope,
  istTimeInSlotWindowInclusive,
  istWeekdayName,
  isWeekendIST,
  isRoiTradingDayIST,
  normalizeSqlDate,
};
