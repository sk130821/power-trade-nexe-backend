/** Withdrawal windows (IST calendar day + daily hours). */
const WITHDRAWAL_RULES = {
  trading_wallet: {
    label: 'Trading Wallet',
    anyDay: true,
    allowedDay: null,
    hint: 'Any day · 8:00 AM – 8:00 PM IST',
  },
  salary_wallet: {
    label: 'Salary Wallet',
    anyDay: false,
    allowedDay: 1,
    hint: '1st of month · 8:00 AM – 8:00 PM IST',
  },
  exchange_wallet: {
    label: 'Exchange Wallet',
    anyDay: false,
    allowedDay: 15,
    hint: '15th of month · 8:00 AM – 8:00 PM IST',
  },
};

const IST_TZ = 'Asia/Kolkata';
const WITHDRAWAL_HOUR_START = 8;
const WITHDRAWAL_HOUR_END = 20;

function getISTDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const pick = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

function getIstHourMinute(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { hour, minute };
}

/** Daily withdrawal window: 8:00 AM – 8:00 PM IST (inclusive). */
function isWithinWithdrawalHours(now = new Date()) {
  const { hour, minute } = getIstHourMinute(now);
  const total = hour * 60 + minute;
  return total >= WITHDRAWAL_HOUR_START * 60 && total <= WITHDRAWAL_HOUR_END * 60;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function nextAllowedDateISO(walletType, now = new Date()) {
  const rule = WITHDRAWAL_RULES[walletType];
  if (!rule || rule.anyDay) return null;

  const { year, month, day } = getISTDateParts(now);
  if (day === rule.allowedDay) return null;

  let m = month;
  let y = year;
  if (day > rule.allowedDay) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(rule.allowedDay).padStart(2, '0')}`;
}

function withdrawalHoursMeta(now = new Date()) {
  const open = isWithinWithdrawalHours(now);
  return {
    withdrawal_hours_open: open,
    hours_start: `${String(WITHDRAWAL_HOUR_START).padStart(2, '0')}:00`,
    hours_end: `${String(WITHDRAWAL_HOUR_END).padStart(2, '0')}:00`,
    hours_hint: '8:00 AM – 8:00 PM IST',
  };
}

function checkWithdrawalAllowed(walletType, now = new Date()) {
  const rule = WITHDRAWAL_RULES[walletType];
  if (!rule) {
    return { allowed: false, error: 'Invalid wallet type' };
  }

  const hours = withdrawalHoursMeta(now);
  if (!hours.withdrawal_hours_open) {
    return {
      allowed: false,
      wallet_type: walletType,
      hint: rule.hint,
      allowed_today: false,
      allowed_day: rule.allowedDay,
      next_date: nextAllowedDateISO(walletType, now),
      ...hours,
      error: `Withdrawals are only allowed between ${hours.hours_hint}. Please try again during this window.`,
    };
  }

  if (rule.anyDay) {
    return {
      allowed: true,
      wallet_type: walletType,
      hint: rule.hint,
      allowed_today: true,
      allowed_day: null,
      next_date: null,
      ...hours,
    };
  }

  const { day } = getISTDateParts(now);
  const allowedToday = day === rule.allowedDay;
  const nextDate = nextAllowedDateISO(walletType, now);

  if (allowedToday) {
    return {
      allowed: true,
      wallet_type: walletType,
      hint: rule.hint,
      allowed_today: true,
      allowed_day: rule.allowedDay,
      next_date: null,
      ...hours,
    };
  }

  return {
    allowed: false,
    wallet_type: walletType,
    hint: rule.hint,
    allowed_today: false,
    allowed_day: rule.allowedDay,
    next_date: nextDate,
    ...hours,
    error: `${rule.label} withdrawal is only allowed on the ${ordinal(rule.allowedDay)} of each month (IST), ${hours.hours_hint}. Next window: ${nextDate}.`,
  };
}

function buildWithdrawalSchedule(now = new Date()) {
  const hours = withdrawalHoursMeta(now);
  const schedule = {};
  for (const walletType of Object.keys(WITHDRAWAL_RULES)) {
    const check = checkWithdrawalAllowed(walletType, now);
    schedule[walletType] = {
      label: WITHDRAWAL_RULES[walletType].label,
      hint: WITHDRAWAL_RULES[walletType].hint,
      allowed_today: check.allowed,
      allowed_day: check.allowed_day,
      next_date: check.next_date,
      ...hours,
    };
  }
  return schedule;
}

module.exports = {
  WITHDRAWAL_RULES,
  IST_TZ,
  WITHDRAWAL_HOUR_START,
  WITHDRAWAL_HOUR_END,
  getISTDateParts,
  getIstHourMinute,
  isWithinWithdrawalHours,
  checkWithdrawalAllowed,
  buildWithdrawalSchedule,
};
