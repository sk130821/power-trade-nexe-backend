/**
 * Database migration — Jul 2026 income rule updates
 * (Daily Bonus, activated_at, daily_bonus_income type, etc.)
 *
 * Safe to run multiple times — uses idempotent ensureSchema().
 *
 * Usage (from backend folder):
 *   node scripts/migrate-jul-2026-updates.js
 *
 * Requires .env: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const db = require('../config/db');
const { ensureSchema } = require('../config/schemaEnsure');

async function expireLevelMonthlyEntitlements(conn) {
  const [r] = await conn.query(
    `UPDATE member_salary_entitlements
     SET status = 'expired', updated_at = NOW()
     WHERE program = 'level_monthly' AND status = 'active'`,
  );
  if (r.affectedRows) {
    console.log(`[migrate] Expired ${r.affectedRows} active level_monthly entitlement(s) (feature removed).`);
  }
}

async function backfillActivatedAt(conn) {
  const [r] = await conn.query(
    `UPDATE members SET activated_at = created_at
     WHERE status = 'active' AND activated_at IS NULL`,
  );
  if (r.affectedRows) {
    console.log(`[migrate] Backfilled activated_at for ${r.affectedRows} active member(s).`);
  }
}

async function main() {
  console.log('[migrate] Database:', process.env.DB_NAME || '(not set)');
  console.log('[migrate] Running schema ensure (columns, tables, enums)...');

  await ensureSchema();

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await backfillActivatedAt(conn);
    await expireLevelMonthlyEntitlements(conn);
    await conn.commit();
    console.log('[migrate] Done. Restart backend if it was already running.');
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
    await db.end();
  }
}

main().catch((e) => {
  console.error('[migrate] Failed:', e.message);
  process.exit(1);
});
