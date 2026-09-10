const { istNow, isRoiTradingDayIST, normalizeSqlDate } = require('./roiTime');
const {
  isPremiumPlan,
  computePremiumSlotRoi,
  premiumSlotPairForCycleLevel,
} = require('./roiPremium');
const { ROI_LADDER_SLOTS } = require('../config/roiLadder');
const { getRoiPercent } = require('./roiPercent');

function parseTopupTiers(rawField) {
  let raw = rawField;
  if (raw == null) return [0];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [0];
    }
  }
  if (Buffer.isBuffer(raw)) {
    try {
      raw = JSON.parse(raw.toString('utf8'));
    } catch {
      return [0];
    }
  }
  if (!Array.isArray(raw) || !raw.length) return [0];
  return raw.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
}

function roiBaseForSlot(tiers, slot, packageAmount) {
  const maxIdx = Math.max(0, tiers.length - 1);
  const s = Math.min(Math.max(0, Number(slot) || 0), maxIdx);
  const tierVal = Number(tiers[s] ?? 0);
  if (tierVal > 0) return tierVal;
  return Number(packageAmount || 0);
}

async function fetchCyclesOpenOnDateForSlot(conn, memberId, slotIndex, dateStr) {
  const endOfDay = `${dateStr} 23:59:59`;
  const [rows] = await conn.query(
    `SELECT * FROM member_income_cycles
     WHERE member_id = ? AND slot_index = ?
       AND created_at <= ?
       AND (cap_closed = 0 OR updated_at > ?)`,
    [memberId, Number(slotIndex), endOfDay, endOfDay],
  );
  return rows;
}

async function fetchOldestCycleOpenOnDate(conn, memberId, dateStr) {
  const rows = await fetchCyclesOpenOnDate(conn, memberId, dateStr);
  return rows[0] || null;
}

async function fetchCyclesOpenOnDate(conn, memberId, dateStr) {
  const endOfDay = `${dateStr} 23:59:59`;
  const [rows] = await conn.query(
    `SELECT * FROM member_income_cycles
     WHERE member_id = ?
       AND created_at <= ?
       AND (cap_closed = 0 OR updated_at > ?)
     ORDER BY cycle_level ASC`,
    [memberId, endOfDay, endOfDay],
  );
  return rows;
}

/**
 * Missed ROI for a session day.
 * Premium ($101+): unused required slots lapse even if another slot was bought that day.
 * Non-premium: full-day miss only (any join = no lapse).
 */
async function estimateMissedRoiForLapsedDay(conn, memberId, tradeRow, packageAmount, joinedSlots = []) {
  const dateStr = normalizeSqlDate(tradeRow.trade_date);
  if (!dateStr) return { total: 0, byCycleId: {}, missedSlots: [] };

  const joined = new Set((joinedSlots || []).map((s) => Number(s)));
  const tiers = parseTopupTiers(tradeRow.topup_tiers);
  const ladderSlotCount = Math.min(ROI_LADDER_SLOTS, Math.max(1, tiers.length));
  const premium = isPremiumPlan(packageAmount);
  const byCycleId = {};
  let total = 0;

  if (premium) {
    const openCycles = await fetchCyclesOpenOnDate(conn, memberId, dateStr);
    if (!openCycles.length) return { total: 0, byCycleId: {}, missedSlots: [] };
    const perSlot = computePremiumSlotRoi(packageAmount);
    const missedSlotsSet = new Set();
    for (const cycle of openCycles) {
      const pair = premiumSlotPairForCycleLevel(cycle.cycle_level, packageAmount);
      const missed = pair.filter((s) => !joined.has(s));
      if (!missed.length) continue;
      missed.forEach((s) => missedSlotsSet.add(s));
      const dayMiss = parseFloat((perSlot * missed.length).toFixed(4));
      byCycleId[cycle.id] = parseFloat(((byCycleId[cycle.id] || 0) + dayMiss).toFixed(4));
      total += dayMiss;
    }
    return {
      total: parseFloat(total.toFixed(4)),
      byCycleId,
      missedSlots: [...missedSlotsSet].sort((a, b) => a - b),
    };
  }

  if (joined.size > 0) {
    return { total: 0, byCycleId: {}, missedSlots: [] };
  }

  for (let s = 0; s < ladderSlotCount; s += 1) {
    const openCycles = await fetchCyclesOpenOnDateForSlot(conn, memberId, s, dateStr);
    for (const cycle of openCycles) {
      const base = Number(cycle.cap_base) > 0
        ? Number(cycle.cap_base)
        : roiBaseForSlot(tiers, s, packageAmount);
      const roiAmount = parseFloat(((base * getRoiPercent(base)) / 100).toFixed(4));
      if (roiAmount <= 0) continue;
      total += roiAmount;
      byCycleId[cycle.id] = parseFloat(((byCycleId[cycle.id] || 0) + roiAmount).toFixed(4));
    }
  }

  return { total: parseFloat(total.toFixed(4)), byCycleId, missedSlots: [] };
}

async function computeMemberRoiLapsedSummary(conn, memberId, memberRow) {
  const { dateStr: todayStr } = istNow();
  const pkg = Number(memberRow?.package_amount) || 0;
  if (!pkg || memberRow?.status !== 'active') {
    return {
      days_lapsed: 0,
      days_partial_lapsed: 0,
      lapsed_amount: 0,
      unused_slot_lapsed_amount: 0,
      by_cycle: {},
      lapsed_days: [],
    };
  }

  const premium = isPremiumPlan(pkg);
  const memberStart = normalizeSqlDate(memberRow.created_at) || todayStr;

  const [sessionRows] = await conn.query(
    `SELECT id, trade_date, topup_tiers
     FROM roi_trades
     WHERE trade_date >= ? AND trade_date < ?
     ORDER BY trade_date ASC`,
    [memberStart, todayStr],
  );

  const [joinRows] = await conn.query(
    `SELECT DATE_FORMAT(rt.trade_date, '%Y-%m-%d') AS d, p.topup_slot
     FROM roi_trade_participants p
     INNER JOIN roi_trades rt ON rt.id = p.roi_trade_id
     WHERE p.member_id = ? AND rt.trade_date >= ? AND rt.trade_date < ?`,
    [memberId, memberStart, todayStr],
  );
  const joinsByDate = new Map();
  for (const r of joinRows) {
    const d = normalizeSqlDate(r.d);
    if (!d) continue;
    if (!joinsByDate.has(d)) joinsByDate.set(d, new Set());
    joinsByDate.get(d).add(Number(r.topup_slot));
  }

  let daysLapsed = 0;
  let daysPartialLapsed = 0;
  let lapsedAmount = 0;
  let unusedSlotAmount = 0;
  const byCycle = {};
  const lapsedDays = [];

  for (const trade of sessionRows) {
    const d = normalizeSqlDate(trade.trade_date);
    if (!d || !isRoiTradingDayIST(d)) continue;
    const joinedSlots = [...(joinsByDate.get(d) || [])];
    if (!premium && joinedSlots.length) continue;

    const { total, byCycleId, missedSlots } = await estimateMissedRoiForLapsedDay(
      conn, memberId, trade, pkg, joinedSlots,
    );
    if (total <= 0) continue;

    const isPartial = joinedSlots.length > 0;
    if (isPartial) daysPartialLapsed += 1;
    else daysLapsed += 1;
    lapsedAmount = parseFloat((lapsedAmount + total).toFixed(4));
    if (isPartial) {
      unusedSlotAmount = parseFloat((unusedSlotAmount + total).toFixed(4));
    }
    lapsedDays.push({
      date: d,
      amount: total,
      missed_slots: missedSlots || [],
      joined_slots: joinedSlots,
      partial: isPartial,
    });
    for (const [cid, amt] of Object.entries(byCycleId)) {
      byCycle[cid] = parseFloat(((byCycle[cid] || 0) + Number(amt)).toFixed(4));
    }
  }

  return {
    days_lapsed: daysLapsed,
    days_partial_lapsed: daysPartialLapsed,
    lapsed_amount: lapsedAmount,
    unused_slot_lapsed_amount: unusedSlotAmount,
    by_cycle: byCycle,
    lapsed_days: lapsedDays,
  };
}

async function getCachedLapsedSummary(conn, memberId) {
  if (!conn._roiLapsedCache) conn._roiLapsedCache = new Map();
  if (conn._roiLapsedCache.has(memberId)) {
    return conn._roiLapsedCache.get(memberId);
  }
  const [[member]] = await conn.query(
    `SELECT package_amount, status, created_at FROM members WHERE id = ?`,
    [memberId],
  );
  const summary = await computeMemberRoiLapsedSummary(conn, memberId, member || {});
  conn._roiLapsedCache.set(memberId, summary);
  return summary;
}

module.exports = {
  estimateMissedRoiForLapsedDay,
  computeMemberRoiLapsedSummary,
  getCachedLapsedSummary,
};
