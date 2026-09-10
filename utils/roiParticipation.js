const { istNow, isWeekendIST, isRoiTradingDayIST, normalizeSqlDate, istTimeInSlotWindowInclusive, sqlTimeToHms } = require('./roiTime');
const { isPremiumPlan, premiumJoinSlots, premiumJoinSlotsForOpenCycles } = require('./roiPremium');
const { fetchAllOpenCycles } = require('./memberCycleQueries');
const { estimateMissedRoiForLapsedDay } = require('./roiLapsedCap');

function monthBounds(year, month) {
  const y = Number(year);
  const m = Number(month);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const last = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { first, last };
}

function datesInRange(first, last) {
  const out = [];
  const [y0, m0, d0] = first.split('-').map(Number);
  const [y1, m1, d1] = last.split('-').map(Number);
  const end = new Date(y1, m1 - 1, d1);
  const cur = new Date(y0, m0 - 1, d0);
  while (cur <= end) {
    const ys = cur.getFullYear();
    const ms = String(cur.getMonth() + 1).padStart(2, '0');
    const ds = String(cur.getDate()).padStart(2, '0');
    out.push(`${ys}-${ms}-${ds}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function weekdayLabelIST(dateStr) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
  }).format(new Date(`${dateStr}T12:00:00+05:30`));
}

function toYearMonth(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
}


function listMonthsBetween(startYm, endYm) {
  if (!/^\d{4}-\d{2}$/.test(startYm) || !/^\d{4}-\d{2}$/.test(endYm)) {
    return /^\d{4}-\d{2}$/.test(endYm) ? [endYm] : [];
  }
  const out = [];
  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out.reverse();
}

async function listMemberParticipationMonths(conn, memberId) {
  const { dateStr: todayStr } = istNow();
  const currentYm = todayStr.slice(0, 7);

  const [[mem]] = await conn.query('SELECT created_at FROM members WHERE id = ?', [memberId]);
  const memberYm = toYearMonth(mem?.created_at) || currentYm;

  const [[firstTrade]] = await conn.query('SELECT MIN(trade_date) AS d FROM roi_trades');
  const tradeYm = toYearMonth(firstTrade?.d) || currentYm;

  const [txnMonthRows] = await conn.query(
    `SELECT DISTINCT DATE_FORMAT(created_at, '%Y-%m') AS ym
     FROM transactions
     WHERE member_id = ? AND income_type = 'roi_income'
     ORDER BY ym ASC`,
    [memberId],
  );
  const txnMonths = txnMonthRows.map((r) => String(r.ym)).filter((ym) => /^\d{4}-\d{2}$/.test(ym));

  const startYm = [memberYm, tradeYm, ...txnMonths].filter(Boolean).sort()[0] || currentYm;
  let months = listMonthsBetween(startYm, currentYm);
  for (const ym of txnMonths) {
    if (ym <= currentYm && !months.includes(ym)) months.push(ym);
  }
  months.sort((a, b) => (a < b ? 1 : -1));
  if (!months.length) months = [currentYm];

  return months.map((ym) => ({ value: ym, label: formatMonthLabel(ym), is_current: ym === currentYm }));
}

function formatMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

function slotWindowFromTrade(session, slotIndex) {
  let sw = session?.slot_windows;
  if (typeof sw === 'string') {
    try {
      sw = JSON.parse(sw);
    } catch {
      sw = null;
    }
  }
  const w = Array.isArray(sw) ? sw[Number(slotIndex)] : null;
  if (w && (w.open_time != null || w.open != null)) {
    return {
      open_time: sqlTimeToHms(w.open_time ?? w.open),
      close_time: sqlTimeToHms(w.close_time ?? w.close),
      trade_name: w.trade_name ?? null,
    };
  }
  return {
    open_time: sqlTimeToHms(session?.open_time),
    close_time: sqlTimeToHms(session?.close_time),
    trade_name: null,
  };
}

async function liveJoinedSlotsForDay(conn, session, joinedSlots, dateStr) {
  const { dateStr: todayStr, timeStr } = istNow();
  if (dateStr !== todayStr || !isRoiTradingDayIST(dateStr) || !session || !joinedSlots.length) {
    return [];
  }

  const [slotRows] = await conn.query(
    `SELECT slot_index, open_time, close_time, trade_name, status
     FROM roi_trade_slots WHERE roi_trade_id = ?`,
    [session.id],
  );
  const bySlot = new Map(slotRows.map((r) => [Number(r.slot_index), r]));
  const live = [];

  for (const s of joinedSlots) {
    const dbSlot = bySlot.get(Number(s));
    let openH;
    let closeH;
    let tradeName;
    if (dbSlot) {
      openH = sqlTimeToHms(dbSlot.open_time);
      closeH = sqlTimeToHms(dbSlot.close_time);
      tradeName = dbSlot.trade_name;
    } else {
      const w = slotWindowFromTrade(session, s);
      openH = w.open_time;
      closeH = w.close_time;
      tradeName = w.trade_name;
    }
    if (istTimeInSlotWindowInclusive(timeStr, openH, closeH)) {
      live.push({
        slot: Number(s),
        open_time: openH,
        close_time: closeH,
        trade_name: tradeName,
      });
    }
  }
  return live;
}

async function buildMemberRoiParticipationStats(conn, memberId, packageAmount, yearMonth, opts = {}) {
  const { dateStr: todayStr } = istNow();
  const [ty, tm] = todayStr.split('-');
  const currentYm = `${ty}-${tm}`;
  const ym = yearMonth || currentYm;
  const [year, month] = ym.split('-');
  const { first, last } = monthBounds(year, month);
  const isPastMonth = ym < currentYm;
  const isFutureMonth = ym > currentYm;
  const rangeEnd = isFutureMonth
    ? todayStr
    : isPastMonth || opts.fullMonth
      ? last
      : (last < todayStr ? last : todayStr);
  const allDates = datesInRange(first, rangeEnd);

  const premium = isPremiumPlan(packageAmount);
  const openPremiumCycles = premium ? await fetchAllOpenCycles(conn, memberId) : [];
  const planSlots = premium ? premiumJoinSlotsForOpenCycles(openPremiumCycles, packageAmount) : [];
  const requiredSlots = premium ? planSlots : null;
  const requiredJoinsPerDay = premium ? planSlots.length : 1;

  const [sessionRows] = await conn.query(
    `SELECT id, DATE_FORMAT(trade_date, '%Y-%m-%d') AS trade_date, topup_tiers, slot_windows, open_time, close_time
     FROM roi_trades
     WHERE trade_date >= ? AND trade_date <= ?
     ORDER BY trade_date ASC`,
    [first, rangeEnd],
  );
  const sessionByDate = new Map(
    sessionRows.map((r) => [normalizeSqlDate(r.trade_date) || String(r.trade_date), r]),
  );

  const [joinRows] = await conn.query(
    `SELECT DATE_FORMAT(rt.trade_date, '%Y-%m-%d') AS trade_date, p.topup_slot
     FROM roi_trade_participants p
     INNER JOIN roi_trades rt ON rt.id = p.roi_trade_id
     WHERE p.member_id = ? AND rt.trade_date >= ? AND rt.trade_date <= ?`,
    [memberId, first, rangeEnd],
  );

  const joinsByDate = new Map();
  for (const r of joinRows) {
    const d = normalizeSqlDate(r.trade_date);
    if (!d) continue;
    if (!joinsByDate.has(d)) joinsByDate.set(d, new Set());
    joinsByDate.get(d).add(Number(r.topup_slot));
  }

  const [roiTxnRows] = await conn.query(
    `SELECT t.amount, t.created_at,
            DATE_FORMAT(rt.trade_date, '%Y-%m-%d') AS trade_date
     FROM transactions t
     LEFT JOIN roi_trades rt ON t.reference_type = 'roi_trade' AND rt.id = t.reference_id
     WHERE t.member_id = ? AND t.income_type = 'roi_income'
       AND (
         (rt.trade_date IS NOT NULL AND DATE_FORMAT(rt.trade_date, '%Y-%m') = ?)
         OR (rt.trade_date IS NULL AND DATE_FORMAT(t.created_at, '%Y-%m') = ?)
       )`,
    [memberId, ym, ym],
  );

  const roiByDate = new Map();
  for (const r of roiTxnRows) {
    const d = normalizeSqlDate(r.trade_date) || normalizeSqlDate(r.created_at);
    if (!d || d < first || d > rangeEnd) continue;
    if (!roiByDate.has(d)) roiByDate.set(d, { txn_count: 0, amount: 0 });
    const bucket = roiByDate.get(d);
    bucket.txn_count += 1;
    bucket.amount = parseFloat((bucket.amount + Number(r.amount || 0)).toFixed(4));
  }

  let tradingDays = 0;
  let sessionsAvailable = 0;
  let daysJoined = 0;
  let daysWithRoiIncome = 0;
  let daysFullParticipation = 0;
  let daysLapsed = 0;
  let daysPartialLapsed = 0;
  let lapsedAmount = 0;
  let totalJoins = 0;
  let totalRoiCredits = 0;
  let totalRoiAmount = 0;
  let weekendDays = 0;

  const calendar = [];

  for (const d of allDates) {
    const weekend = isWeekendIST(d);
    if (weekend) weekendDays += 1;

    const session = sessionByDate.get(d);
    const joinedSlots = joinsByDate.has(d) ? [...joinsByDate.get(d)].sort((a, b) => a - b) : [];
    const joinCount = joinedSlots.length;
    const roiInfo = roiByDate.get(d);
    const roiTxnCount = roiInfo?.txn_count || 0;
    const roiAmount = roiInfo?.amount || 0;
    const hadRoiIncome = roiTxnCount > 0;
    const activeDay = joinCount > 0 || hadRoiIncome;

    totalJoins += joinCount;
    totalRoiCredits += roiTxnCount;
    totalRoiAmount = parseFloat((totalRoiAmount + roiAmount).toFixed(4));

    let fullParticipation = false;
    let lapsed = false;
    let partialLapsed = false;
    let missedSlots = [];
    let dayLapsedAmount = 0;
    const tradingDay = isRoiTradingDayIST(d);
    const pastTradingDay = tradingDay && d < todayStr;

    if (tradingDay) {
      tradingDays += 1;
      if (session) sessionsAvailable += 1;

      if (activeDay) {
        daysJoined += 1;
        if (hadRoiIncome) daysWithRoiIncome += 1;
        if (premium) {
          const premiumJoined = planSlots.filter((s) => joinedSlots.includes(s));
          fullParticipation = premiumJoined.length === planSlots.length;
          if (fullParticipation) daysFullParticipation += 1;
          if (session && pastTradingDay && !fullParticipation) {
            const missed = await estimateMissedRoiForLapsedDay(
              conn, memberId, session, packageAmount, joinedSlots,
            );
            dayLapsedAmount = Number(missed.total || 0);
            missedSlots = missed.missedSlots || [];
            if (dayLapsedAmount > 0) {
              partialLapsed = true;
              daysPartialLapsed += 1;
              lapsedAmount = parseFloat((lapsedAmount + dayLapsedAmount).toFixed(4));
            }
          }
        } else {
          fullParticipation = true;
        }
      } else if (session && pastTradingDay) {
        lapsed = true;
        daysLapsed += 1;
        const missed = await estimateMissedRoiForLapsedDay(
          conn, memberId, session, packageAmount, joinedSlots,
        );
        dayLapsedAmount = Number(missed.total || 0);
        missedSlots = missed.missedSlots || [];
        lapsedAmount = parseFloat((lapsedAmount + dayLapsedAmount).toFixed(4));
      }
    } else if (hadRoiIncome) {
      daysWithRoiIncome += 1;
    }

    const liveSlots = session && joinedSlots.length
      ? await liveJoinedSlotsForDay(conn, session, joinedSlots, d)
      : [];
    const roiLive = liveSlots.length > 0;

    calendar.push({
      date: d,
      weekday: weekdayLabelIST(d),
      is_weekend: weekend,
      is_trading_day: tradingDay,
      session_exists: !!session || joinCount > 0 || hadRoiIncome,
      joined_slots: joinedSlots,
      join_count: joinCount,
      roi_txn_count: roiTxnCount,
      roi_amount: roiAmount,
      had_roi_income: hadRoiIncome,
      full_participation: fullParticipation,
      lapsed: lapsed && tradingDay && !!session && !hadRoiIncome,
      partial_lapsed: partialLapsed,
      missed_slots: missedSlots,
      lapsed_amount: dayLapsedAmount,
      roi_live: roiLive,
      live_slots: liveSlots,
      required_slots: requiredSlots,
    });
  }

  const participation_rate = sessionsAvailable > 0
    ? parseFloat(((daysJoined / sessionsAvailable) * 100).toFixed(1))
    : 0;

  const todayEntry = calendar.find((c) => c.date === todayStr);

  return {
    month: ym,
    month_label: formatMonthLabel(ym),
    is_current_month: ym === currentYm,
    is_complete_month: isPastMonth || rangeEnd === last,
    range_start: first,
    range_end: rangeEnd,
    premium_plan: premium,
    required_slots_per_day: requiredSlots,
    required_joins_per_day: requiredJoinsPerDay,
    trading_days_in_range: tradingDays,
    weekend_days_in_range: weekendDays,
    sessions_available: sessionsAvailable,
    days_with_join: daysJoined,
    days_with_roi_income: daysWithRoiIncome,
    days_full_participation: daysFullParticipation,
    days_lapsed: daysLapsed,
    days_partial_lapsed: daysPartialLapsed,
    lapsed_amount: lapsedAmount,
    total_joins: totalJoins,
    total_roi_credits: totalRoiCredits,
    total_roi_amount: totalRoiAmount,
    participation_rate,
    live_roi_now: todayEntry?.live_slots ?? [],
    calendar,
  };
}

module.exports = {
  buildMemberRoiParticipationStats,
  listMemberParticipationMonths,
  formatMonthLabel,
  normalizeSqlDate,
};
