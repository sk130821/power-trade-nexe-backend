/** Withdrawal rules — no calendar day or time window (anytime). */
const WITHDRAWAL_RULES = {
  trading_wallet: {
    label: 'Trading Wallet',
    anyDay: true,
    allowedDay: null,
    hint: 'Any time · amounts in $10 steps',
  },
  salary_wallet: {
    label: 'Salary Wallet',
    anyDay: true,
    allowedDay: null,
    hint: 'Any time · amounts in $10 steps',
  },
  exchange_wallet: {
    label: 'Exchange Wallet',
    anyDay: true,
    allowedDay: null,
    hint: 'Any time · amounts in $10 steps',
  },
};

const IST_TZ = 'Asia/Kolkata';
const WITHDRAWAL_HOUR_START = 0;
const WITHDRAWAL_HOUR_END = 24;

function withdrawalHoursMeta() {
  return {
    withdrawal_hours_open: true,
    hours_start: '00:00',
    hours_end: '24:00',
    hours_hint: 'Any time (24/7)',
  };
}

function checkWithdrawalAllowed(walletType) {
  const rule = WITHDRAWAL_RULES[walletType];
  if (!rule) {
    return { allowed: false, error: 'Invalid wallet type' };
  }

  const hours = withdrawalHoursMeta();
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

function buildWithdrawalSchedule() {
  const hours = withdrawalHoursMeta();
  const schedule = {};
  for (const walletType of Object.keys(WITHDRAWAL_RULES)) {
    schedule[walletType] = {
      label: WITHDRAWAL_RULES[walletType].label,
      hint: WITHDRAWAL_RULES[walletType].hint,
      allowed_today: true,
      allowed_day: null,
      next_date: null,
      ...hours,
    };
  }
  return schedule;
}

/** Kept for older imports — always open. */
function isWithinWithdrawalHours() {
  return true;
}

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
