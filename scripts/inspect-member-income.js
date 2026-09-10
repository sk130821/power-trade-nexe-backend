const db = require('../config/db');

async function main() {
  const code = process.argv[2] || 'PTN1BKYOLOG';
  const [[m]] = await db.query('SELECT * FROM members WHERE referral_code = ?', [code]);
  if (!m) {
    console.log('Member not found:', code);
    process.exit(1);
  }
  console.log('=== SPONSOR', code, '===');
  console.log({
    id: m.id,
    name: m.name,
    package: m.package_amount,
    status: m.status,
    plan_topup_count: m.plan_topup_count,
    income_cap_base: m.income_cap_base,
    capped_income_floor: m.capped_income_floor,
    total_direct: m.total_direct_income,
    total_roi: m.total_roi_income,
    total_level: m.total_level_income,
    total_salary: m.total_salary_income,
    total_reward: m.total_reward_income,
    total_income: m.total_income,
    exchange_wallet: m.exchange_wallet,
  });

  const [directs] = await db.query(
    'SELECT id, name, referral_code, package_amount, status, created_at FROM members WHERE sponsor_id = ? ORDER BY created_at',
    [m.id],
  );
  console.log('\n=== DIRECT REFERRALS ===');
  console.log(directs);

  const [cycles] = await db.query(
    'SELECT * FROM member_income_cycles WHERE member_id = ? ORDER BY cycle_level',
    [m.id],
  );
  console.log('\n=== INCOME CYCLES ===');
  console.log(cycles);

  const [txns] = await db.query(
    `SELECT id, amount, income_type, description, created_at, from_member_id, reference_id
     FROM transactions WHERE member_id = ?
     AND income_type IN ('direct_income','roi_income','level_income','salary_income','reward_income')
     ORDER BY created_at`,
    [m.id],
  );
  console.log('\n=== KEY TRANSACTIONS ===');
  txns.forEach((t) => console.log(t.amount, '|', t.income_type, '|', (t.description || '').slice(0, 140)));

  const pankaj = directs.find((d) => (d.name || '').includes('Pankaj'));
  if (pankaj) {
    const [[joinTxn]] = await db.query(
      `SELECT * FROM transactions WHERE income_type='direct_income' AND reference_id=? AND member_id=?`,
      [pankaj.id, m.id],
    );
    console.log('\n=== DIRECT INCOME FROM PANKAJ ===');
    console.log(joinTxn);
    const fullDirect = Number(pankaj.package_amount) * 0.05;
    console.log('Expected full 5%:', fullDirect);
    console.log('Actually paid:', joinTxn?.amount);
    console.log('Shortfall:', fullDirect - Number(joinTxn?.amount || 0));
  }

  const [[working]] = await db.query(
    `SELECT 1 AS ok FROM members WHERE sponsor_id=? AND status='active' LIMIT 1`,
    [m.id],
  );
  const mult = working ? 3 : 2;
  console.log('\nWorking:', !!working, 'Multiplier:', mult);
  for (const c of cycles) {
    const limit = Number(c.cap_base) * mult;
    const remaining = Math.max(0, limit - Number(c.capped_earned));
    console.log(
      `Cycle ${c.cycle_level}: base=$${c.cap_base} limit=$${limit} earned=$${c.capped_earned} remaining=$${remaining.toFixed(4)} closed=${c.cap_closed}`,
    );
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
