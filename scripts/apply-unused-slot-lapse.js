/**
 * Recalculate unused-slot ROI lapse for all premium members ($101+)
 * and close income cycles that have now hit the 2×/3× cap.
 *
 * Usage:
 *   node scripts/apply-unused-slot-lapse.js          # dry-run
 *   node scripts/apply-unused-slot-lapse.js --apply
 */
const db = require('../config/db');
const { isMemberWorking, incomeCapMultiplier } = require('../utils/incomeCap');
const { computeMemberRoiLapsedSummary } = require('../utils/roiLapsedCap');
const { isPremiumPlan, computePremiumSlotRoi } = require('../utils/roiPremium');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '=== APPLY unused-slot lapse ===' : '=== DRY-RUN unused-slot lapse ===');

  const [members] = await db.query(
    `SELECT id, name, referral_code, package_amount, status, created_at, plan_topup_count
     FROM members
     WHERE status = 'active' AND package_amount >= 101
     ORDER BY id ASC`,
  );

  console.log(`Active premium members: ${members.length}`);
  const perSlotByPkg = new Map();

  let withPartial = 0;
  let withAnyLapse = 0;
  let totalPartialDays = 0;
  let totalPartialAmount = 0;
  let cyclesToClose = 0;
  const closedIds = [];
  const samples = [];

  for (const m of members) {
    const pkg = Number(m.package_amount) || 0;
    if (!isPremiumPlan(pkg)) continue;
    if (!perSlotByPkg.has(pkg)) perSlotByPkg.set(pkg, computePremiumSlotRoi(pkg));

    const summary = await computeMemberRoiLapsedSummary(db, m.id, m);
    const partialDays = Number(summary.days_partial_lapsed || 0);
    const partialAmount = (summary.lapsed_days || [])
      .filter((d) => d.partial)
      .reduce((s, d) => s + Number(d.amount || 0), 0);

    if (summary.lapsed_amount > 0) withAnyLapse += 1;
    if (partialDays > 0) {
      withPartial += 1;
      totalPartialDays += partialDays;
      totalPartialAmount = parseFloat((totalPartialAmount + partialAmount).toFixed(4));
      if (samples.length < 25) {
        samples.push({
          id: m.id,
          code: m.referral_code,
          name: m.name,
          pkg,
          full_miss_days: summary.days_lapsed,
          unused_slot_days: partialDays,
          lapsed_amount: summary.lapsed_amount,
          unused_slot_amount: parseFloat(partialAmount.toFixed(4)),
        });
      }
    }

    const working = await isMemberWorking(db, m.id);
    const multiplier = incomeCapMultiplier(working);
    const [cycles] = await db.query(
      `SELECT id, cycle_level, cap_base, capped_earned, cap_closed
       FROM member_income_cycles WHERE member_id = ? ORDER BY cycle_level ASC`,
      [m.id],
    );

    for (const cycle of cycles) {
      if (cycle.cap_closed) continue;
      const limit = parseFloat((Number(cycle.cap_base) * multiplier).toFixed(4));
      const earned = Number(cycle.capped_earned || 0);
      const lapsed = Number(summary.by_cycle[cycle.id] || 0);
      const effective = parseFloat((earned + lapsed).toFixed(4));
      if (effective + 0.0001 >= limit) {
        cyclesToClose += 1;
        closedIds.push({
          member_id: m.id,
          code: m.referral_code,
          cycle_id: cycle.id,
          cycle_level: cycle.cycle_level,
          earned,
          lapsed,
          limit,
        });
        if (APPLY) {
          await db.query(`UPDATE member_income_cycles SET cap_closed = 1 WHERE id = ?`, [cycle.id]);
        }
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log('Members with unused-slot lapse days:', withPartial);
  console.log('Members with any lapse (full miss + unused slot):', withAnyLapse);
  console.log('Unused-slot days (all members):', totalPartialDays);
  console.log('Unused-slot lapsed amount: $' + totalPartialAmount.toFixed(4));
  console.log('Cycles at cap after lapse (to close):', cyclesToClose);
  console.log('Per-slot ROI by plan:', Object.fromEntries(perSlotByPkg));

  if (samples.length) {
    console.log('\n--- Sample members with unused-slot lapse ---');
    for (const s of samples) {
      console.log(
        `#${s.id} ${s.code} ${s.name} $${s.pkg} | full-miss ${s.full_miss_days}d | unused-slot ${s.unused_slot_days}d | lapse $${s.lapsed_amount} (unused $${s.unused_slot_amount})`,
      );
    }
  }

  if (closedIds.length) {
    console.log(APPLY ? '\n--- Closed cycles ---' : '\n--- Cycles that would close ---');
    for (const c of closedIds) {
      console.log(
        `${c.code} cycle ${c.cycle_level} (id ${c.cycle_id}): earned $${c.earned} + lapsed $${c.lapsed} >= limit $${c.limit}`,
      );
    }
  }

  if (!APPLY && (withPartial || cyclesToClose)) {
    console.log('\nRe-run with --apply to close cycles that have now hit cap.');
  }

  await db.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
