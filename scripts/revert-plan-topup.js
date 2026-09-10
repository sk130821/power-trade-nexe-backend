/**
 * Revert mistaken plan TOP-UP for one member (by referral code).
 * Usage: node scripts/revert-plan-topup.js PTNAN065EA4
 */
const db = require('../config/db');

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.error('Usage: node scripts/revert-plan-topup.js <referral_code>');
    process.exit(1);
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [memRows] = await conn.query(
      `SELECT id, referral_code, name, plan_topup_count, package_amount
       FROM members WHERE referral_code = ? FOR UPDATE`,
      [code],
    );
    const member = memRows[0];
    if (!member) throw new Error(`Member not found: ${code}`);

    const memberId = member.id;
    const currentCount = Number(member.plan_topup_count) || 0;
    if (currentCount < 1) {
      throw new Error(`plan_topup_count is already ${currentCount} — nothing to revert`);
    }

    const [cycles] = await conn.query(
      `SELECT id, cycle_level, capped_earned FROM member_income_cycles
       WHERE member_id = ? ORDER BY cycle_level DESC`,
      [memberId],
    );

    const mistakenLevel = currentCount;
    const mistakenCycle = cycles.find((c) => Number(c.cycle_level) === mistakenLevel);
    if (!mistakenCycle) {
      throw new Error(`No income cycle at level ${mistakenLevel} — check DB manually`);
    }

    console.log('Before:', {
      member: member.name,
      referral_code: member.referral_code,
      plan_topup_count: currentCount,
      cycle_to_remove: mistakenCycle,
    });

    await conn.query(
      `DELETE FROM member_income_cycles WHERE id = ? AND member_id = ? AND cycle_level = ?`,
      [mistakenCycle.id, memberId, mistakenLevel],
    );

    await conn.query(`UPDATE members SET plan_topup_count = ? WHERE id = ?`, [
      currentCount - 1,
      memberId,
    ]);

    await conn.commit();

    const [after] = await db.query(
      `SELECT plan_topup_count FROM members WHERE id = ?`,
      [memberId],
    );
    const [leftCycles] = await db.query(
      `SELECT cycle_level, slot_index, capped_earned FROM member_income_cycles WHERE member_id = ? ORDER BY cycle_level`,
      [memberId],
    );

    console.log('Reverted successfully.');
    console.log('After plan_topup_count:', after[0]?.plan_topup_count);
    console.log('Remaining cycles:', leftCycles);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
