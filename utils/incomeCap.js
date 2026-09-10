/** Income cap: 2× plan (non-working) / 3× plan (working). Day trade excluded. */

const CAPPED_INCOME_TYPES = new Set([
  'roi_income',
  'direct_income',
  'level_income',
  'salary_income',
  'reward_income',
  'level_monthly_salary',
  'daily_bonus_income',
]);

function isCappedIncomeType(incomeType) {
  return CAPPED_INCOME_TYPES.has(incomeType);
}

function sumCappedTotals(member) {
  return (
    Number(member.total_roi_income ?? 0) +
    Number(member.total_direct_income ?? 0) +
    Number(member.total_level_income ?? 0) +
    Number(member.total_salary_income ?? 0) +
    Number(member.total_reward_income ?? 0) +
    Number(member.total_level_monthly_salary ?? 0) +
    Number(member.total_daily_bonus_income ?? 0)
  );
}

function capBaseAmount(member) {
  const base = Number(member.income_cap_base ?? 0);
  return base > 0 ? base : Number(member.package_amount ?? 0);
}

/** Working = at least one direct referral is active (joined under them). */
async function isMemberWorking(conn, memberId) {
  const [[row]] = await conn.query(
    `SELECT 1 AS ok FROM members WHERE sponsor_id = ? AND status = 'active' LIMIT 1`,
    [memberId]
  );
  return !!row;
}

function incomeCapMultiplier(working) {
  return working ? 3 : 2;
}

async function buildIncomeCapSummary(conn, member) {
  const working = await isMemberWorking(conn, member.id);
  const multiplier = incomeCapMultiplier(working);
  const capBase = capBaseAmount(member);
  const floor = Number(member.capped_income_floor ?? 0);
  const cappedTotal = sumCappedTotals(member);
  const earnedInCycle = Math.max(0, parseFloat((cappedTotal - floor).toFixed(4)));
  const limit = parseFloat((capBase * multiplier).toFixed(4));
  const remaining = parseFloat(Math.max(0, limit - earnedInCycle).toFixed(4));

  return {
    working,
    multiplier,
    cap_base: capBase,
    cap_limit: limit,
    earned_in_cycle: earnedInCycle,
    remaining,
    capped_out: remaining <= 0,
    day_trade_excluded: true,
  };
}

/**
 * Clip capped income to remaining allowance. Returns amount to credit (0 if cap reached).
 */
async function applyIncomeCap(conn, memberId, incomeType, requestedAmount) {
  if (!isCappedIncomeType(incomeType)) {
    return { amount: Number(requestedAmount), capped: false, skipped: false };
  }

  const amt = Number(requestedAmount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { amount: 0, capped: false, skipped: true };
  }

  const [[row]] = await conn.query(
    `SELECT id, status, package_amount, income_cap_base, capped_income_floor,
            total_roi_income, total_direct_income, total_level_income,
            total_salary_income, total_reward_income,
            total_level_monthly_salary, total_daily_bonus_income
     FROM members WHERE id = ? FOR UPDATE`,
    [memberId]
  );
  if (!row || row.status !== 'active') {
    return { amount: 0, capped: false, skipped: true };
  }

  const summary = await buildIncomeCapSummary(conn, row);
  if (summary.capped_out || summary.remaining <= 0) {
    return { amount: 0, capped: true, skipped: true, cap: summary };
  }

  const credit = parseFloat(Math.min(amt, summary.remaining).toFixed(4));
  return {
    amount: credit,
    capped: credit < amt,
    skipped: credit <= 0,
    cap: summary,
  };
}

/** On first activation: set cap base to package amount. */
async function initIncomeCapOnActivation(conn, memberId) {
  await conn.query(
    `UPDATE members SET
       income_cap_base = CASE WHEN COALESCE(income_cap_base, 0) <= 0 THEN package_amount ELSE income_cap_base END,
       capped_income_floor = CASE WHEN COALESCE(income_cap_base, 0) <= 0 THEN 0 ELSE capped_income_floor END
     WHERE id = ?`,
    [memberId]
  );
}

/** After plan top-up: add to cap base and start a new 2×/3× cycle. */
async function applyPlanTopupCapReset(conn, memberId, topupAmount) {
  const topup = Number(topupAmount);
  if (!Number.isFinite(topup) || topup <= 0) return;

  const [[row]] = await conn.query(
    `SELECT package_amount, income_cap_base, capped_income_floor,
            total_roi_income, total_direct_income, total_level_income,
            total_salary_income, total_reward_income,
            total_level_monthly_salary, total_daily_bonus_income
     FROM members WHERE id = ? FOR UPDATE`,
    [memberId]
  );
  if (!row) return;

  const cappedTotal = sumCappedTotals(row);
  const currentBase = capBaseAmount(row);
  const newBase = parseFloat((currentBase + topup).toFixed(4));

  await conn.query(
    `UPDATE members SET income_cap_base = ?, capped_income_floor = ? WHERE id = ?`,
    [newBase, cappedTotal, memberId]
  );
}

module.exports = {
  isCappedIncomeType,
  isMemberWorking,
  incomeCapMultiplier,
  buildIncomeCapSummary,
  applyIncomeCap,
  initIncomeCapOnActivation,
  applyPlanTopupCapReset,
};
