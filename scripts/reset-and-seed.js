/**
 * Wipes ALL rows from every table in the configured database,
 * then seeds one admin + one active member.
 *
 * Usage (from backend folder):
 *   node scripts/reset-and-seed.js --confirm
 *
 * Requires .env DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { generateUniqueMemberId } = require('../utils/memberId');
const { initIncomeCapOnActivation } = require('../utils/incomeCap');
const { initPlanCycle } = require('../utils/retopupCycles');

const SEED = {
  admin: {
    username: 'admin',
    email: 'admin@powertradenexus.com',
    password: 'password',
    metamask_address: '0x0000000000000000000000000000000000000001',
  },
  member: {
    name: 'Demo Member',
    email: 'member@powertradenexus.com',
    password: 'password',
    contact: '9876543210',
    aadhaar_no: '123456789012',
    dob: '1990-01-15',
    package_amount: 101,
    referral_code: 'PTNDEMO1234',
  },
};

async function main() {
  if (!process.argv.includes('--confirm')) {
    console.error('\n⚠️  This will DELETE ALL DATA in database:', process.env.DB_NAME || '(unset)');
    console.error('    Run again with --confirm to proceed.\n');
    console.error('    Example: node scripts/reset-and-seed.js --confirm\n');
    process.exit(1);
  }

  const dbName = process.env.DB_NAME;
  if (!dbName) {
    console.error('DB_NAME is not set in backend/.env');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    multipleStatements: true,
  });

  try {
    console.log(`\n🗑️  Truncating all tables in "${dbName}"...`);

    const [tables] = await conn.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [dbName],
    );

    if (!tables.length) {
      console.error('No tables found. Run schema.sql first.');
      process.exit(1);
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of tables) {
      await conn.query(`TRUNCATE TABLE \`${name}\``);
      console.log(`   ✓ ${name}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    console.log('\n🌱 Seeding admin + member...');

    const adminHash = await bcrypt.hash(SEED.admin.password, 10);
    const [adminResult] = await conn.query(
      `INSERT INTO admins (username, email, password, metamask_address)
       VALUES (?, ?, ?, ?)`,
      [SEED.admin.username, SEED.admin.email, adminHash, SEED.admin.metamask_address],
    );
    const adminId = adminResult.insertId;

    const memberHash = await bcrypt.hash(SEED.member.password, 10);
    const referralCode = SEED.member.referral_code || (await generateUniqueMemberId(conn));

    const [memberResult] = await conn.query(
      `INSERT INTO members (
         name, email, contact, aadhaar_no, password, dob,
         sponsor_id, referral_code, package_amount, plan_topup_count, status,
         exchange_wallet, trading_wallet, salary_wallet,
         income_cap_base, capped_income_floor
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, 'active', 0, 0, 0, ?, 0)`,
      [
        SEED.member.name,
        SEED.member.email,
        SEED.member.contact,
        SEED.member.aadhaar_no,
        memberHash,
        SEED.member.dob,
        referralCode,
        SEED.member.package_amount,
        SEED.member.package_amount,
      ],
    );
    const memberId = memberResult.insertId;

    await initIncomeCapOnActivation(conn, memberId);
    await initPlanCycle(conn, memberId, SEED.member.package_amount);

    console.log('\n✅ Database reset complete.\n');
    console.log('── Admin login ──');
    console.log(`   Email:    ${SEED.admin.email}`);
    console.log(`   Password: ${SEED.admin.password}`);
    console.log(`   ID:       ${adminId}`);
    console.log('\n── Member login ──');
    console.log(`   Email:          ${SEED.member.email}`);
    console.log(`   Password:       ${SEED.member.password}`);
    console.log(`   Referral code:  ${referralCode}`);
    console.log(`   Package:        $${SEED.member.package_amount}`);
    console.log(`   Status:         active`);
    console.log(`   ID:             ${memberId}\n`);
  } catch (err) {
    console.error('\n❌ Reset failed:', err.message);
    process.exit(1);
  } finally {
    await conn.end();
  }
}

main();
