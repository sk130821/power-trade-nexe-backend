const IST_TZ = 'Asia/Kolkata';

/** Members see / buy live trades from this hour (IST) onward each day. */
const MEMBER_DAY_TRADE_VISIBLE_HOUR = 9;
/** Kept for older copy — buy no longer auto-closes at 5 PM; session stays open until admin settles. */
const MEMBER_DAY_TRADE_BUY_END_HOUR = 17;

function getIstHourMinute(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { hour, minute };
}

function getTodayIstYmd(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: IST_TZ });
}

/** MySQL DATE / ISO / Date → YYYY-MM-DD in IST (for session comparison). */
function dayTradeSessionYmd(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toLocaleDateString('en-CA', { timeZone: IST_TZ });
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  if (s.length === 10) return m[1];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleDateString('en-CA', { timeZone: IST_TZ });
  }
  return m[1];
}

/** Admin may activate day trades any time (members see from 9 AM IST). */
function isDayTradeActivateAllowed(_date = new Date()) {
  return true;
}

/** Live trades: members can buy from 9:00 AM IST until admin settles (no 5 PM auto-close). */
function isDayTradeBuyWindowOpen(date = new Date()) {
  const { hour } = getIstHourMinute(date);
  return hour >= MEMBER_DAY_TRADE_VISIBLE_HOUR;
}

/** Same as buy window — members see active trades from 9 AM IST until admin settles. */
function isDayTradeVisibleToMember(date = new Date()) {
  return isDayTradeBuyWindowOpen(date);
}

module.exports = {
  IST_TZ,
  MEMBER_DAY_TRADE_VISIBLE_HOUR,
  MEMBER_DAY_TRADE_BUY_END_HOUR,
  getIstHourMinute,
  getTodayIstYmd,
  dayTradeSessionYmd,
  isDayTradeActivateAllowed,
  isDayTradeBuyWindowOpen,
  isDayTradeVisibleToMember,
};
