const db = require('../config/db');

async function main() {
  const codes = process.argv.slice(2).length ? process.argv.slice(2) : ['PTNAN065EA4', 'PTNJ4W1355Y'];

  console.log('\n--- Duplicate roi_income scan (same member + trade + slot) ---');
  const [dupes] = await db.query(
    `SELECT m.referral_code, m.name, rt.id AS trade_id,
            DATE_FORMAT(rt.trade_date,'%Y-%m-%d') AS trade_date,
            SUBSTRING_INDEX(SUBSTRING_INDEX(t.description, '| slot ', -1), ' |', 1) AS slot,
            COUNT(*) AS cnt, SUM(t.amount) AS total, GROUP_CONCAT(t.id) AS txn_ids
     FROM transactions t
     JOIN members m ON m.id = t.member_id
     JOIN roi_trades rt ON rt.id = t.reference_id
     WHERE t.income_type = 'roi_income' AND t.reference_type = 'roi_trade'
       AND t.description LIKE '%| slot %'
     GROUP BY t.member_id, t.reference_id, slot
     HAVING cnt > 1
     ORDER BY rt.trade_date DESC, m.referral_code`,
  );
  if (!dupes.length) console.log('No duplicates found.');
  else dupes.forEach((d) => console.log(d));

  for (const code of codes) {
    const [m] = await db.query(
      'SELECT id, name, referral_code, package_amount FROM members WHERE referral_code = ?',
      [code],
    );
    console.log('\n===', code, m[0] || 'NOT FOUND');
    if (!m.length) continue;
    const id = m[0].id;
    const [txns] = await db.query(
      `SELECT t.id, t.txn_id, t.amount, t.description, t.reference_id, t.created_at,
              DATE_FORMAT(rt.trade_date,'%Y-%m-%d') AS trade_date
       FROM transactions t
       LEFT JOIN roi_trades rt ON t.reference_type='roi_trade' AND rt.id=t.reference_id
       WHERE t.member_id=? AND t.income_type='roi_income'
       ORDER BY t.created_at DESC LIMIT 30`,
      [id],
    );
    console.log('Recent roi_income txns:', txns.length);
    for (const t of txns) {
      console.log(' ', t.trade_date, t.amount, t.description, t.created_at);
    }
    const [parts] = await db.query(
      `SELECT p.id, p.topup_slot, p.roi_settled_at, DATE_FORMAT(rt.trade_date,'%Y-%m-%d') AS trade_date, rt.id AS trade_id
       FROM roi_trade_participants p JOIN roi_trades rt ON rt.id=p.roi_trade_id
       WHERE p.member_id=? ORDER BY rt.trade_date DESC, p.topup_slot LIMIT 20`,
      [id],
    );
    console.log('Participants:', parts.length);
    for (const p of parts) {
      console.log(' ', p.trade_date, 'slot', p.topup_slot, 'settled', p.roi_settled_at, 'trade', p.trade_id);
    }
  }
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
