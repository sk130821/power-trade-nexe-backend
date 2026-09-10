/**
 * 12-slot ROI ladder + unlimited retopups.
 * Cycle level 0 = plan (slot 0). Each retopup +1 → cycle level = plan_topup_count.
 * Slot index = cycle_level % 12. Join slot S → ROI for every open cycle on slot S.
 */
const { isMemberWorking, incomeCapMultiplier } = require('./incomeCap');
const { computeMemberRoiLapsedSummary, getCachedLapsedSummary } = require('./roiLapsedCap');
const { ROI_LADDER_SLOTS } = require('../config/roiLadder');
const { fetchAllOpenCycles, fetchOldestOpenCycle } = require('./memberCycleQueries');

function slotIndexForCycle(cycleLevel) {
  const n = Number(cycleLevel);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n % ROI_LADDER_SLOTS;
}

/** Cycle levels 0..planTopupCount that map to slot S. */
function cycleLevelsForSlot(planTopupCount, slotIndex) {
  const maxLevel = Math.max(0, Number(planTopupCount) || 0);
  const slot = Number(slotIndex);
  const out = [];
  for (let L = 0; L <= maxLevel; L++) {
    if (slotIndexForCycle(L) === slot) out.push(L);
  }
  return out;
}

/** Next retopup pays tier at this slot index. */
function nextRetopupSlotIndex(planTopupCount) {
  return (Math.max(0, Number(planTopupCount) || 0) + 1) % ROI_LADDER_SLOTS;
}

async function fetchMemberCycles(conn, memberId) {
  const [rows] = await conn.query(
    `SELECT * FROM member_income_cycles WHERE member_id = ? ORDER BY cycle_level ASC`,
    [memberId]
  );
  return rows;
}

async function fetchOpenCyclesForSlot(conn, memberId, slotIndex) {
  const [rows] = await conn.query(
    `SELECT * FROM member_income_cycles
     WHERE member_id = ? AND slot_index = ? AND cap_closed = 0
     ORDER BY cycle_level ASC`,
    [memberId, Number(slotIndex)]
  );
  return rows;
}

async function initPlanCycle(conn, memberId, packageAmount) {
  const base = parseFloat(Number(packageAmount || 0).toFixed(4));
  await conn.query(
    `INSERT IGNORE INTO member_income_cycles (member_id, cycle_level, slot_index, cap_base)
     VALUES (?, 0, 0, ?)`,
    [memberId, base]
  );
}

async function addRetopupCycle(conn, memberId, cycleLevel, topupAmount) {
  const level = Number(cycleLevel);
  const base = parseFloat(Number(topupAmount || 0).toFixed(4));
  const slot = slotIndexForCycle(level);
  await conn.query(
    `INSERT INTO member_income_cycles (member_id, cycle_level, slot_index, cap_base)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE cap_base = VALUES(cap_base)`,
    [memberId, level, slot, base]
  );
}

async function applyCycleIncomeCap(conn, memberId, cycleId, requestedAmount) {
  const amt = Number(requestedAmount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { amount: 0, capped: false, skipped: true };
  }

  const [[cycle]] = await conn.query(
    `SELECT * FROM member_income_cycles WHERE id = ? AND member_id = ? FOR UPDATE`,
    [cycleId, memberId]
  );
  if (!cycle || cycle.cap_closed) {
    return { amount: 0, capped: true, skipped: true, cap_closed: true };
  }

  const working = await isMemberWorking(conn, memberId);
  const multiplier = incomeCapMultiplier(working);
  const limit = parseFloat((Number(cycle.cap_base) * multiplier).toFixed(4));
  const earned = Number(cycle.capped_earned ?? 0);
  const lapsedSummary = await getCachedLapsedSummary(conn, memberId);
  const lapsedForCycle = Number(lapsedSummary.by_cycle[cycleId] || 0);
  const effectiveEarned = parseFloat((earned + lapsedForCycle).toFixed(4));
  const remaining = parseFloat(Math.max(0, limit - effectiveEarned).toFixed(4));

  if (remaining <= 0) {
    if (!cycle.cap_closed) {
      await conn.query(`UPDATE member_income_cycles SET cap_closed = 1 WHERE id = ?`, [cycleId]);
    }
    return { amount: 0, capped: true, skipped: true, cap_closed: true, lapsed_blocked: lapsedForCycle > 0 };
  }

  const credit = parseFloat(Math.min(amt, remaining).toFixed(4));
  const newEarned = parseFloat((earned + credit).toFixed(4));
  const closed = (effectiveEarned + credit) >= limit - 0.0001;

  await conn.query(
    `UPDATE member_income_cycles SET capped_earned = ?, cap_closed = ? WHERE id = ?`,
    [newEarned, closed ? 1 : 0, cycleId]
  );

  return {
    amount: credit,
    capped: credit < amt,
    skipped: credit <= 0,
    cap_closed: closed,
    cycle_level: cycle.cycle_level,
    slot_index: cycle.slot_index,
  };
}

/** Non-ROI capped income → oldest open cycle (FIFO). */
async function applyIncomeCapToOldestCycle(conn, memberId, requestedAmount) {
  const cycle = await fetchOldestOpenCycle(conn, memberId);
  if (!cycle) {
    return { amount: 0, capped: true, skipped: true, cap_closed: true };
  }
  return applyCycleIncomeCap(conn, memberId, cycle.id, requestedAmount);
}

function cycleSummaryRow(cycle, working) {
  const multiplier = incomeCapMultiplier(working);
  const capBase = Number(cycle.cap_base ?? 0);
  const limit = parseFloat((capBase * multiplier).toFixed(4));
  const earned = Number(cycle.capped_earned ?? 0);
  const remaining = parseFloat(Math.max(0, limit - earned).toFixed(4));
  const closed = !!cycle.cap_closed || remaining <= 0;
  return {
    cycle_level: Number(cycle.cycle_level),
    slot_index: Number(cycle.slot_index),
    cap_base: capBase,
    cap_limit: limit,
    earned_in_cycle: earned,
    remaining: closed ? 0 : remaining,
    cap_closed: closed,
    roi_closed: closed,
    label: Number(cycle.cycle_level) === 0 ? 'Plan (slot 0)' : `Retopup #${cycle.cycle_level} → slot ${cycle.slot_index}`,
  };
}

/** Total plan investment: package × (1 + TOP-UP count). E.g. $1001 plan + 1 TOP-UP = $2002. */
async function computeTotalPlanInvestment(_conn, _memberId, packageAmount, planTopupCount) {
  const pkg = Number(packageAmount) || 0;
  const topups = Math.max(0, Number(planTopupCount) || 0);
  return parseFloat((pkg * (1 + topups)).toFixed(4));
}

async function buildMemberCycleCapOverview(conn, memberId) {
  const [[member]] = await conn.query(
    `SELECT package_amount, plan_topup_count, status, created_at FROM members WHERE id = ?`,
    [memberId],
  );
  if (member) {
    await ensureMemberCycles(conn, memberId, member.package_amount, member.plan_topup_count, null);
  }
  const cycles = await fetchMemberCycles(conn, memberId);
  const working = await isMemberWorking(conn, memberId);
  const multiplier = incomeCapMultiplier(working);
  const lapsedSummary = member
    ? await computeMemberRoiLapsedSummary(conn, memberId, member)
    : { days_lapsed: 0, lapsed_amount: 0, by_cycle: {} };

  const rows = cycles.map((c) => {
    const base = cycleSummaryRow(c, working);
    const lapsedInCycle = Number(lapsedSummary.by_cycle[c.id] || 0);
    const effectiveEarned = parseFloat((base.earned_in_cycle + lapsedInCycle).toFixed(4));
    const remaining = parseFloat(Math.max(0, base.cap_limit - effectiveEarned).toFixed(4));
    const closed = !!c.cap_closed || remaining <= 0;
    return {
      ...base,
      lapsed_in_cycle: lapsedInCycle,
      effective_earned: effectiveEarned,
      remaining: closed ? 0 : remaining,
      cap_closed: closed,
    };
  });

  const totalCredited = rows.reduce((s, r) => s + r.earned_in_cycle, 0);
  const totalLapsed = Number(lapsedSummary.lapsed_amount || 0);
  const totalInvestment = member
    ? await computeTotalPlanInvestment(conn, memberId, member.package_amount, member.plan_topup_count)
    : rows.reduce((s, r) => s + r.cap_base, 0);
  const investmentCapLimit = parseFloat((totalInvestment * multiplier).toFixed(4));
  const investmentRemaining = parseFloat(
    Math.max(0, investmentCapLimit - totalCredited - totalLapsed).toFixed(4),
  );

  return {
    working,
    multiplier,
    ladder_slots: ROI_LADDER_SLOTS,
    unlimited_retopup: true,
    cycles: rows,
    total_investment: totalInvestment,
    cap_base: totalInvestment,
    cap_limit: investmentCapLimit,
    credited_in_cycle: parseFloat(totalCredited.toFixed(4)),
    earned_in_cycle: parseFloat((totalCredited + totalLapsed).toFixed(4)),
    lapsed_amount: totalLapsed,
    days_lapsed: Number(lapsedSummary.days_lapsed || 0),
    days_partial_lapsed: Number(lapsedSummary.days_partial_lapsed || 0),
    unused_slot_lapsed_amount: Number(lapsedSummary.unused_slot_lapsed_amount || 0),
    remaining: investmentRemaining,
    capped_out: investmentRemaining <= 0,
    day_trade_excluded: true,
    roi_lapsed: {
      days_lapsed: Number(lapsedSummary.days_lapsed || 0),
      days_partial_lapsed: Number(lapsedSummary.days_partial_lapsed || 0),
      unused_slot_lapsed_amount: Number(lapsedSummary.unused_slot_lapsed_amount || 0),
      lapsed_amount: totalLapsed,
    },
  };
}

/** Backfill cycles from plan_topup_count + payment history. */
async function ensureMemberCycles(conn, memberId, packageAmount, planTopupCount, topupHistory) {
  const [exist] = await conn.query(
    `SELECT id FROM member_income_cycles WHERE member_id = ? LIMIT 1`,
    [memberId]
  );
  if (exist.length) return;

  await initPlanCycle(conn, memberId, packageAmount);

  const approved = Array.isArray(topupHistory)
    ? topupHistory.filter((p) => p.status === 'approved').sort((a, b) => {
        const ta = new Date(a.created_at || a.approved_at || 0).getTime();
        const tb = new Date(b.created_at || b.approved_at || 0).getTime();
        return ta - tb;
      })
    : [];

  const count = Math.max(0, Number(planTopupCount) || 0);
  for (let L = 1; L <= count; L++) {
    const pay = approved[L - 1];
    const amt = pay ? Number(pay.amount) : Number(packageAmount);
    await addRetopupCycle(conn, memberId, L, amt > 0 ? amt : packageAmount);
  }
}

module.exports = {
  ROI_LADDER_SLOTS,
  slotIndexForCycle,
  cycleLevelsForSlot,
  nextRetopupSlotIndex,
  fetchMemberCycles,
  fetchOpenCyclesForSlot,
  fetchOldestOpenCycle,
  fetchAllOpenCycles,
  initPlanCycle,
  addRetopupCycle,
  applyCycleIncomeCap,
  applyIncomeCapToOldestCycle,
  buildMemberCycleCapOverview,
  computeTotalPlanInvestment,
  ensureMemberCycles,
  cycleSummaryRow,
};
