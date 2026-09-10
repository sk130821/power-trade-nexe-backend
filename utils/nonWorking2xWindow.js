const { isMemberWorking } = require('./incomeCap');
const { isRoiTradingDayIST, istNow } = require('./roiTime');
const {
  isPremiumPlan,
  computePremiumSlotRoi,
  premiumJoinSlotsForOpenCycles,
  premiumSlotShareLabel,
  premiumSlotPairForCycleLevel,
} = require('./roiPremium');
const { fetchAllOpenCycles, fetchOldestOpenCycle } = require('./memberCycleQueries');
const { normalizeSqlDate } = require('./roiTime');

const { getRoiPercent } = require('./roiPercent');

function formatYmd(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function addCalendarDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return formatYmd(dt);
}

function firstTradingDayOnOrAfter(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 14; i += 1) {
    if (isRoiTradingDayIST(d)) return d;
    d = addCalendarDays(d, 1);
  }
  return dateStr;
}

/** Nth Mon–Fri on or after start (n >= 1). */
function nthTradingDayOnOrAfter(startYmd, n) {
  let count = 0;
  let d = startYmd;
  for (let guard = 0; guard < 365 * 5; guard += 1) {
    if (isRoiTradingDayIST(d)) {
      count += 1;
      if (count === n) return d;
    }
    d = addCalendarDays(d, 1);
  }
  return startYmd;
}

function countTradingDaysBetween(startYmd, endYmd) {
  if (!startYmd || !endYmd || endYmd < startYmd) return 0;
  let count = 0;
  let d = startYmd;
  while (d <= endYmd) {
    if (isRoiTradingDayIST(d)) count += 1;
    d = addCalendarDays(d, 1);
  }
  return count;
}

/**
 * Non-working members (2× cap): fixed Mon–Fri window to join ROI.
 * Missed trading days = lapsed. After window ends, join is blocked.
 */
async function buildNonWorking2xParticipationWindow(conn, memberId, packageAmount, opts = {}) {
  const working =
    opts.working !== undefined ? opts.working : await isMemberWorking(conn, memberId);
  if (working) {
    return { applies: false, working: true };
  }

  const premium = isPremiumPlan(packageAmount);
  const { dateStr: todayStr } = istNow();
  const openCycles = opts.openCycles ?? (premium ? await fetchAllOpenCycles(conn, memberId) : null);
  const cycle = opts.cycle ?? (openCycles?.[0] ?? (await fetchOldestOpenCycle(conn, memberId)));

  const capBase = cycle ? Number(cycle.cap_base) || Number(packageAmount) : Number(packageAmount);
  const capLimit = parseFloat((capBase * 2).toFixed(4));
  const roiPercent = getRoiPercent(capBase);

  let dailyRoiPerFullDay;
  let dailyRoiFormula;
  if (premium) {
    const memberSlots = premiumJoinSlotsForOpenCycles(openCycles || [], packageAmount);
    const shareLabel = premiumSlotShareLabel(packageAmount);
    const perSlot = computePremiumSlotRoi(packageAmount);
    dailyRoiPerFullDay = parseFloat((perSlot * memberSlots.length).toFixed(4));
    dailyRoiFormula = `Plan $${packageAmount} × ${roiPercent}% daily (slots ${memberSlots.join(',')} × ${shareLabel}) = $${dailyRoiPerFullDay}/trading day`;
  } else {
    dailyRoiPerFullDay = parseFloat(((capBase * roiPercent) / 100).toFixed(4));
    dailyRoiFormula = `Plan $${capBase} × ${roiPercent}% = $${dailyRoiPerFullDay}/trading day`;
  }

  const tradingDaysAllowed =
    dailyRoiPerFullDay > 0 ? Math.ceil(capLimit / dailyRoiPerFullDay) : 0;

  if (!cycle) {
    return {
      applies: true,
      working: false,
      multiplier: 2,
      cap_base: capBase,
      cap_limit_2x: capLimit,
      roi_percent: roiPercent,
      daily_roi_if_joined: dailyRoiPerFullDay,
      daily_roi_formula: dailyRoiFormula,
      trading_days_allowed: tradingDaysAllowed,
      window_expired: true,
      no_open_cycle: true,
      cycle_closed: true,
      can_join_today: false,
      calculation_summary:
        tradingDaysAllowed > 0
          ? `2× target $${capLimit} ÷ $${dailyRoiPerFullDay}/day ≈ ${tradingDaysAllowed} trading days`
          : 'No open 2× cycle',
    };
  }

  const cycleStartRaw = normalizeSqlDate(cycle.created_at) || todayStr;
  const windowStart = firstTradingDayOnOrAfter(cycleStartRaw);
  const windowEnd =
    tradingDaysAllowed > 0
      ? nthTradingDayOnOrAfter(windowStart, tradingDaysAllowed)
      : windowStart;

  const windowExpired = todayStr > windowEnd || !!cycle.cap_closed;
  const rangeEndForStats = todayStr < windowEnd ? todayStr : windowEnd;

  const tradingDaysElapsed = countTradingDaysBetween(windowStart, rangeEndForStats);
  const tradingDaysRemaining = windowExpired
    ? 0
    : countTradingDaysBetween(todayStr, windowEnd);

  const [joinDayRows] = await conn.query(
    `SELECT DATE_FORMAT(rt.trade_date, '%Y-%m-%d') AS d, p.topup_slot
     FROM roi_trade_participants p
     INNER JOIN roi_trades rt ON rt.id = p.roi_trade_id
     WHERE p.member_id = ? AND rt.trade_date >= ? AND rt.trade_date <= ?`,
    [memberId, windowStart, rangeEndForStats],
  );
  const joinsByDate = new Map();
  for (const r of joinDayRows) {
    const d = normalizeSqlDate(r.d);
    if (!d) continue;
    if (!joinsByDate.has(d)) joinsByDate.set(d, new Set());
    joinsByDate.get(d).add(Number(r.topup_slot));
  }
  const daysJoined = joinsByDate.size;

  const [sessionRows] = await conn.query(
    `SELECT DATE_FORMAT(trade_date, '%Y-%m-%d') AS d FROM roi_trades
     WHERE trade_date >= ? AND trade_date <= ?`,
    [windowStart, rangeEndForStats],
  );
  const sessionDates = new Set(
    sessionRows.map((r) => normalizeSqlDate(r.d)).filter(Boolean),
  );

  const requiredSlots = premium
    ? premiumSlotPairForCycleLevel(cycle.cycle_level, packageAmount)
    : [];
  const perSlot = premium ? computePremiumSlotRoi(packageAmount) : dailyRoiPerFullDay;

  let daysLapsed = 0;
  let daysPartialLapsed = 0;
  let lapsedRoiAmount = 0;
  let d = windowStart;
  while (d <= rangeEndForStats) {
    if (isRoiTradingDayIST(d) && sessionDates.has(d) && d < todayStr) {
      const joined = joinsByDate.get(d) || new Set();
      if (premium && requiredSlots.length) {
        const missed = requiredSlots.filter((s) => !joined.has(s));
        if (missed.length === requiredSlots.length) {
          daysLapsed += 1;
        } else if (missed.length > 0) {
          daysPartialLapsed += 1;
        }
        if (missed.length > 0) {
          lapsedRoiAmount = parseFloat((lapsedRoiAmount + perSlot * missed.length).toFixed(4));
        }
      } else if (!joined.size) {
        daysLapsed += 1;
        lapsedRoiAmount = parseFloat((lapsedRoiAmount + dailyRoiPerFullDay).toFixed(4));
      }
    }
    d = addCalendarDays(d, 1);
  }

  const [roiSum] = await conn.query(
    `SELECT COALESCE(SUM(t.amount), 0) AS s
     FROM transactions t
     LEFT JOIN roi_trades rt ON t.reference_type = 'roi_trade' AND rt.id = t.reference_id
     WHERE t.member_id = ? AND t.income_type = 'roi_income'
       AND (
         (rt.trade_date IS NOT NULL AND rt.trade_date >= ? AND rt.trade_date <= ?)
         OR (rt.trade_date IS NULL AND DATE(t.created_at) >= ? AND DATE(t.created_at) <= ?)
       )`,
    [memberId, windowStart, rangeEndForStats, windowStart, rangeEndForStats],
  );
  const roiEarnedInWindow = parseFloat(Number(roiSum[0]?.s ?? 0).toFixed(4));

  return {
    applies: true,
    working: false,
    multiplier: 2,
    premium_plan: premium,
    cap_base: capBase,
    cap_limit_2x: capLimit,
    roi_percent: roiPercent,
    daily_roi_if_joined: dailyRoiPerFullDay,
    daily_roi_formula: dailyRoiFormula,
    trading_days_allowed: tradingDaysAllowed,
    trading_days_elapsed: tradingDaysElapsed,
    trading_days_remaining: tradingDaysRemaining,
    window_start_date: windowStart,
    window_end_date: windowEnd,
    cycle_started_at: cycleStartRaw,
    window_expired: windowExpired,
    can_join_today: !windowExpired && !cycle.cap_closed && isRoiTradingDayIST(todayStr),
    days_joined_in_window: daysJoined,
    days_lapsed_in_window: daysLapsed,
    days_partial_lapsed_in_window: daysPartialLapsed,
    lapsed_roi_amount: lapsedRoiAmount,
    roi_earned_in_window: roiEarnedInWindow,
    max_roi_if_joined_every_day: parseFloat(
      (tradingDaysAllowed * dailyRoiPerFullDay).toFixed(4),
    ),
    calculation_summary: `2× cap $${capLimit} ÷ $${dailyRoiPerFullDay}/trading day = ${tradingDaysAllowed} Mon–Fri days to complete (if you join every day)`,
    cycle_level: Number(cycle.cycle_level),
    cycle_closed: !!cycle.cap_closed,
  };
}

module.exports = {
  getRoiPercent,
  buildNonWorking2xParticipationWindow,
  countTradingDaysBetween,
  firstTradingDayOnOrAfter,
};
