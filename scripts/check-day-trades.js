const db = require('../config/db');
const { getTodayIstYmd, isDayTradeVisibleToMember } = require('../utils/dayTradeIstWindow');

async function main() {
  console.log('IST today:', getTodayIstYmd());
  console.log('Visible to member:', isDayTradeVisibleToMember());
  const [[tz]] = await db.query('SELECT @@global.time_zone AS gtz, @@session.time_zone AS stz, CURDATE() AS cur, NOW() AS now');
  console.log('MySQL:', tz);
  const [all] = await db.query(
    'SELECT id, trade_name, status, trade_date, activated_at, deleted_at FROM day_trades ORDER BY id DESC LIMIT 15',
  );
  console.log('\nAll trades:', all);
  const [curdateRows] = await db.query(
    `SELECT id, trade_name, status, trade_date FROM day_trades
     WHERE deleted_at IS NULL AND status='active' AND DATE(trade_date)=CURDATE()`,
  );
  console.log('\nActive today (CURDATE):', curdateRows);
  const today = getTodayIstYmd();
  const [istRows] = await db.query(
    `SELECT id, trade_name, status, trade_date FROM day_trades
     WHERE deleted_at IS NULL AND status='active' AND trade_date = ?`,
    [today],
  );
  console.log('\nActive today (IST ymd):', istRows);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
