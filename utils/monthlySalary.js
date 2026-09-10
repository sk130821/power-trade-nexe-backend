/**
 * Direct Monthly Salary tiers.
 * Only one active tier per member; higher tier supersedes lower.
 * Payouts: on the same calendar date each month (anniversary of activation),
 * up to 3 times total, to salary wallet.
 */
const { recordTransaction } = require('./transaction');
const db = require('../config/db');

const SALARY_DURATION_MONTHS = 3;

/** Direct referrals in window → % of direct team plan volume (monthly). */
const DIRECT_MONTHLY_TIERS = [
  { tier: 1, minDirects: 5,  windowDays: 7,  percent: 1,  label: '5 Direct · 7 Days' },
  { tier: 2, minDirects: 10, windowDays: 15, percent: 2,  label: '10 Direct · 15 Days' },
  { tier: 3, minDirects: 15, windowDays: 30, percent: 3,  label: '15 Direct · 30 Days' },
  { tier: 4, minDirects: 20, windowDays: 60, percent: 4,  label: '20 Direct · 60 Days' },
];

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function startOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function anniversaryPeriodKey(payoutIndex) {
  return `a${payoutIndex}`;
}

/** Payout N is due on the N-month anniversary of entitlement start (same day of month). */
function isAnniversaryPayoutDue(startedAt, payoutIndex, now = new Date()) {
  const due = addMonths(new Date(startedAt), payoutIndex);
  return startOfDay(now) >= startOfDay(due);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function daysLeftUntil(endDate, now = new Date()) {
  const end = endDate instanceof Date ? endDate : new Date(endDate);
  const ms = end.getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function isWindowExpired(anchorDate, windowDays, now = new Date()) {
  if (windowDays == null) return false;
  return now > addDays(anchorDate, windowDays);
}

async function countDirectsInWindow(conn, memberId, anchorDate, windowDays) {
  const anchor = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);
  let sql = `SELECT COUNT(*) AS c FROM members
    WHERE sponsor_id = ? AND status = 'active'`;
  const params = [memberId];
  if (windowDays != null) {
    sql += ` AND created_at <= DATE_ADD(?, INTERVAL ? DAY)`;
    params.push(anchor, windowDays);
  }
  const [[row]] = await conn.query(sql, params);
  return Number(row?.c || 0);
}

function highestDirectTier(qualified) {
  if (!qualified.length) return null;
  return qualified.reduce((a, b) => (b.tier > a.tier ? b : a));
}

async function evaluateDirectMonthly(conn, memberId) {
  const [[member]] = await conn.query(
    'SELECT id, status, package_amount, created_at FROM members WHERE id = ?',
    [memberId],
  );
  if (!member || member.status !== 'active') return null;

  const anchor = member.created_at;
  const qualified = [];
  for (const tier of DIRECT_MONTHLY_TIERS) {
    const count = await countDirectsInWindow(conn, memberId, anchor, tier.windowDays);
    if (count >= tier.minDirects) qualified.push({ ...tier, directCount: count });
  }
  return highestDirectTier(qualified);
}

async function sumDirectPlanVolume(conn, memberId, anchorDate, windowDays) {
  const anchor = anchorDate instanceof Date ? anchorDate : new Date(anchorDate);
  let sql = `SELECT COALESCE(SUM(package_amount), 0) AS plan_sum
    FROM members WHERE sponsor_id = ? AND status = 'active'`;
  const params = [memberId];
  if (windowDays != null) {
    sql += ` AND created_at <= DATE_ADD(?, INTERVAL ? DAY)`;
    params.push(anchor, windowDays);
  }
  const [[row]] = await conn.query(sql, params);
  return Number(row?.plan_sum || 0);
}

async function getActiveEntitlement(conn, memberId, program) {
  const [[row]] = await conn.query(
    `SELECT * FROM member_salary_entitlements
     WHERE member_id = ? AND program = ? AND status = 'active'
     ORDER BY tier_rank DESC LIMIT 1`,
    [memberId, program],
  );
  return row || null;
}

async function supersedeActiveEntitlement(conn, memberId, program) {
  await conn.query(
    `UPDATE member_salary_entitlements
     SET status = 'superseded', updated_at = NOW()
     WHERE member_id = ? AND program = ? AND status = 'active'`,
    [memberId, program],
  );
}

async function grantEntitlement(conn, memberId, program, tierDef) {
  const now = new Date();
  const expiresAt = addMonths(now, SALARY_DURATION_MONTHS);
  const tierCode = `D${tierDef.tier}`;
  const tierRank = tierDef.tier;
  const tierLabel = tierDef.label;
  const percent = tierDef.percent;

  await supersedeActiveEntitlement(conn, memberId, program);

  const [result] = await conn.query(
    `INSERT INTO member_salary_entitlements
     (member_id, program, tier_code, tier_rank, tier_label, percent_rate, status, started_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [memberId, program, tierCode, tierRank, tierLabel, percent, now, expiresAt],
  );
  return { id: result.insertId, tierCode, tierLabel, percent, expiresAt, started_at: now };
}

async function maybeUpgradeEntitlement(conn, memberId, program, evaluateFn, incomeType) {
  const qualified = await evaluateFn(conn, memberId);
  if (!qualified) return null;

  const current = await getActiveEntitlement(conn, memberId, program);
  const newRank = qualified.tier;

  if (current && Number(current.tier_rank) >= newRank) return null;

  const granted = await grantEntitlement(conn, memberId, program, qualified);
  return { ...granted, incomeType, qualified };
}

async function evaluateMemberMonthlySalaries(conn, memberId) {
  const results = [];
  const direct = await maybeUpgradeEntitlement(
    conn, memberId, 'direct_monthly', evaluateDirectMonthly, 'direct_monthly_salary',
  );
  if (direct) results.push(direct);
  return results;
}

/** Walk upline when a new member activates — re-check sponsors. */
async function evaluateMonthlySalariesForUpline(conn, activatedMemberId) {
  const [[m]] = await conn.query('SELECT sponsor_id FROM members WHERE id = ?', [activatedMemberId]);
  if (!m?.sponsor_id) return [];

  const upgrades = [];
  let sponsorId = m.sponsor_id;
  const seen = new Set();
  while (sponsorId && !seen.has(sponsorId)) {
    seen.add(sponsorId);
    const r = await evaluateMemberMonthlySalaries(conn, sponsorId);
    upgrades.push(...r);
    const [[sp]] = await conn.query('SELECT sponsor_id FROM members WHERE id = ?', [sponsorId]);
    sponsorId = sp?.sponsor_id || null;
  }
  return upgrades;
}

async function computePayoutAmount(conn, entitlement) {
  const [[member]] = await conn.query(
    'SELECT id, package_amount, created_at FROM members WHERE id = ? AND status = \'active\'',
    [entitlement.member_id],
  );
  if (!member) return 0;

  const tier = DIRECT_MONTHLY_TIERS.find((t) => t.tier === Number(entitlement.tier_rank));
  const windowDays = tier?.windowDays ?? null;
  const planSum = await sumDirectPlanVolume(
    conn, entitlement.member_id, member.created_at, windowDays,
  );
  return parseFloat((planSum * Number(entitlement.percent_rate) / 100).toFixed(4));
}

async function expireStaleEntitlements(conn) {
  await conn.query(
    `UPDATE member_salary_entitlements SET status = 'expired', updated_at = NOW()
     WHERE status = 'active' AND expires_at <= NOW()`,
  );
}

async function processMonthlySalaryPayouts(conn) {
  await expireStaleEntitlements(conn);
  const now = new Date();
  const [rows] = await conn.query(
    `SELECT e.* FROM member_salary_entitlements e
     INNER JOIN members m ON m.id = e.member_id AND m.status = 'active'
     WHERE e.status = 'active' AND e.program = 'direct_monthly' AND e.expires_at > NOW()`,
  );

  let paid = 0;
  for (const ent of rows) {
    for (let payoutIndex = 1; payoutIndex <= SALARY_DURATION_MONTHS; payoutIndex += 1) {
      if (!isAnniversaryPayoutDue(ent.started_at, payoutIndex, now)) continue;

      const period = anniversaryPeriodKey(payoutIndex);
      const [[existing]] = await conn.query(
        `SELECT id FROM member_salary_payouts
         WHERE entitlement_id = ? AND period_yyyy_mm = ?`,
        [ent.id, period],
      );
      if (existing) continue;

      const amount = await computePayoutAmount(conn, ent);
      if (amount <= 0) continue;

      const dueDate = addMonths(new Date(ent.started_at), payoutIndex);
      const desc = `Direct Monthly Salary · ${ent.tier_label} · ${ent.percent_rate}% of direct team plan · payout ${payoutIndex}/${SALARY_DURATION_MONTHS} · ${dueDate.toISOString().slice(0, 10)}`;

      const txnId = await recordTransaction(conn, {
        member_id: ent.member_id,
        income_type: 'direct_monthly_salary',
        amount,
        description: desc,
        reference_id: ent.id,
        reference_type: ent.program,
        dedup_key: `direct_monthly_salary|ent${ent.id}|${period}`,
      });
      if (!txnId) continue;

      await conn.query(
        `INSERT INTO member_salary_payouts (entitlement_id, member_id, period_yyyy_mm, amount, txn_id)
         VALUES (?, ?, ?, ?, ?)`,
        [ent.id, ent.member_id, period, amount, txnId],
      );
      paid += 1;
    }
  }
  return paid;
}

async function buildDirectTierStatuses(conn, memberId, member, activeRows, pastRows) {
  const anchor = member.created_at;
  const now = new Date();
  const activeDirect = activeRows.find((r) => r.program === 'direct_monthly');
  const statuses = [];

  for (const tier of DIRECT_MONTHLY_TIERS) {
    const windowEnd = addDays(anchor, tier.windowDays);
    const windowExpired = isWindowExpired(anchor, tier.windowDays, now);
    const count = await countDirectsInWindow(conn, memberId, anchor, tier.windowDays);
    const planSum = await sumDirectPlanVolume(conn, memberId, anchor, tier.windowDays);
    const pastEnt = pastRows.find(
      (r) => r.program === 'direct_monthly' && Number(r.tier_rank) === tier.tier,
    );

    let status;
    if (activeDirect && Number(activeDirect.tier_rank) === tier.tier) {
      status = 'active';
    } else if (pastEnt?.status === 'expired') {
      status = 'expired';
    } else if (pastEnt?.status === 'superseded' || count >= tier.minDirects) {
      status = 'achieved';
    } else if (windowExpired) {
      status = 'expired';
    } else {
      status = 'achievable';
    }

    let nextPayoutDate = null;
    if (activeDirect && Number(activeDirect.tier_rank) === tier.tier) {
      const [paidRows] = await conn.query(
        `SELECT period_yyyy_mm FROM member_salary_payouts WHERE entitlement_id = ?`,
        [activeDirect.id],
      );
      const paidCount = paidRows.length;
      if (paidCount < SALARY_DURATION_MONTHS) {
        nextPayoutDate = addMonths(new Date(activeDirect.started_at), paidCount + 1);
      }
    }

    statuses.push({
      tier: tier.tier,
      label: tier.label,
      min_required: tier.minDirects,
      window_days: tier.windowDays,
      percent: tier.percent,
      current_count: count,
      plan_sum: planSum,
      window_expires_at: windowEnd,
      days_left: windowExpired ? 0 : daysLeftUntil(windowEnd, now),
      status,
      next_payout_date: nextPayoutDate,
      entitlement: activeDirect && Number(activeDirect.tier_rank) === tier.tier
        ? { started_at: activeDirect.started_at, expires_at: activeDirect.expires_at }
        : pastEnt
          ? { started_at: pastEnt.started_at, expires_at: pastEnt.expires_at, ended_status: pastEnt.status }
          : null,
    });
  }
  return statuses;
}

async function buildMemberSalaryStatus(conn, memberId) {
  const [[member]] = await conn.query(
    'SELECT id, status, package_amount, created_at FROM members WHERE id = ?',
    [memberId],
  );
  if (!member) return null;

  const [activeRows] = await conn.query(
    `SELECT * FROM member_salary_entitlements
     WHERE member_id = ? AND status = 'active' AND program = 'direct_monthly'
     ORDER BY tier_rank DESC`,
    [memberId],
  );

  const [pastRows] = await conn.query(
    `SELECT * FROM member_salary_entitlements
     WHERE member_id = ? AND program = 'direct_monthly' AND status IN ('expired', 'superseded')
     ORDER BY tier_rank DESC, started_at DESC`,
    [memberId],
  );

  const directCount7 = await countDirectsInWindow(conn, memberId, member.created_at, 7);
  const directCount15 = await countDirectsInWindow(conn, memberId, member.created_at, 15);
  const directCount30 = await countDirectsInWindow(conn, memberId, member.created_at, 30);
  const directCount60 = await countDirectsInWindow(conn, memberId, member.created_at, 60);
  const directPlanSum = await sumDirectPlanVolume(conn, memberId, member.created_at, null);

  const directQualified = await evaluateDirectMonthly(conn, memberId);
  const directTierStatuses = await buildDirectTierStatuses(conn, memberId, member, activeRows, pastRows);

  return {
    active: activeRows.map((r) => ({
      program: r.program,
      tier_code: r.tier_code,
      tier_label: r.tier_label,
      tier_rank: r.tier_rank,
      percent_rate: Number(r.percent_rate),
      started_at: r.started_at,
      expires_at: r.expires_at,
    })),
    past: pastRows.map((r) => ({
      program: r.program,
      tier_code: r.tier_code,
      tier_label: r.tier_label,
      tier_rank: r.tier_rank,
      percent_rate: Number(r.percent_rate),
      status: r.status,
      started_at: r.started_at,
      expires_at: r.expires_at,
    })),
    tier_status: {
      direct: directTierStatuses,
    },
    progress: {
      direct_counts: { d7: directCount7, d15: directCount15, d30: directCount30, d60: directCount60 },
      direct_plan_sum: directPlanSum,
      package_amount: Number(member.package_amount),
      member_since: member.created_at,
    },
    qualified_now: {
      direct_monthly: directQualified
        ? { tier: directQualified.tier, label: directQualified.label, percent: directQualified.percent }
        : null,
    },
    tiers: {
      direct: DIRECT_MONTHLY_TIERS,
    },
  };
}

async function runMonthlySalaryJob() {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const paid = await processMonthlySalaryPayouts(conn);
    await conn.commit();
    if (paid) console.log(`[monthly-salary] Credited ${paid} payout(s)`);
    return paid;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  DIRECT_MONTHLY_TIERS,
  SALARY_DURATION_MONTHS,
  evaluateMemberMonthlySalaries,
  evaluateMonthlySalariesForUpline,
  processMonthlySalaryPayouts,
  buildMemberSalaryStatus,
  runMonthlySalaryJob,
};
