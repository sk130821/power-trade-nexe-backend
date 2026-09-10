const { v4: uuidv4 } = require('uuid');
const { isCappedIncomeType } = require('./incomeCap');
const { applyCycleIncomeCap, applyIncomeCapToOldestCycle } = require('./retopupCycles');

/**
 * Central transaction recorder
 * Call this function for every income credit.
 * 
 * @param {Object} conn - DB connection (inside a transaction)
 * @param {Object} opts
 * @param {number} opts.member_id
 * @param {string} opts.income_type - 'roi_income'|'direct_income'|'level_income'|'salary_income'|'trading_income'|'reward_income'
 * @param {number} opts.amount
 * @param {string} opts.description
 * @param {number} [opts.reference_id]
 * @param {string} [opts.reference_type]
 * @param {number} [opts.from_member_id]
 * @param {number} [opts.level_no]
 * @param {number} [opts.income_cycle_id] — per retopup/plan cycle cap
 */
async function recordTransaction(conn, opts) {
  const {
    member_id, income_type, amount,
    reference_id = null, reference_type = null,
    from_member_id = null, level_no = null,
    income_cycle_id = null,
    dedup_key = null,
  } = opts;
  let { description } = opts;

  // Wallet mapping
  const walletMap = {
    roi_income:     'exchange_wallet',
    direct_income:  'exchange_wallet',
    level_income:   'exchange_wallet',
    salary_income:  'salary_wallet',
    trading_income: 'trading_wallet',
    reward_income:  'exchange_wallet',
    level_monthly_salary:  'salary_wallet',
    direct_monthly_salary: 'salary_wallet',
    daily_bonus_income:    'exchange_wallet',
  };

  // Income total column mapping
  const incomeColMap = {
    roi_income:     'total_roi_income',
    direct_income:  'total_direct_income',
    level_income:   'total_level_income',
    salary_income:  'total_salary_income',
    trading_income: 'total_trading_income',
    reward_income:  'total_reward_income',
    level_monthly_salary:  'total_level_monthly_salary',
    direct_monthly_salary: 'total_direct_monthly_salary',
    daily_bonus_income:    'total_daily_bonus_income',
  };

  const wallet_type = walletMap[income_type];
  const income_col  = incomeColMap[income_type];

  const creditAmount0 = Number(amount);
  if (!Number.isFinite(creditAmount0) || creditAmount0 <= 0) {
    return null;
  }

  // When a dedup_key is supplied we wrap the cap + insert + wallet update in a
  // SAVEPOINT. The UNIQUE index uq_txn_dedup_key makes a second credit for the
  // same income physically impossible (any race / extra process / retry); on a
  // duplicate we roll back to the savepoint so the cycle cap is NOT consumed and
  // the wallet is NOT touched.
  const savepoint = dedup_key
    ? 'rt_' + uuidv4().replace(/-/g, '').substr(0, 12)
    : null;
  if (savepoint) {
    await conn.query(`SAVEPOINT ${savepoint}`);
  }

  try {
    let creditAmount = creditAmount0;

    if (isCappedIncomeType(income_type)) {
      const cap = income_cycle_id
        ? await applyCycleIncomeCap(conn, member_id, income_cycle_id, creditAmount)
        : await applyIncomeCapToOldestCycle(conn, member_id, creditAmount);
      if (cap.skipped || cap.amount <= 0) {
        if (savepoint) await conn.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        return null;
      }
      creditAmount = cap.amount;
      if (cap.capped && description) {
        description = `${description} (partial — cycle cap reached)`;
      }
      if (cap.cap_closed && description && !description.includes('cycle closed')) {
        description = `${description} (cycle ${cap.cycle_level ?? ''} cap closed)`;
      }
    }

    const txn_id = 'TXN' + Date.now() + uuidv4().replace(/-/g, '').substr(0, 6).toUpperCase();

    // 1. Insert into transactions table (dedup_key UNIQUE → duplicate throws ER_DUP_ENTRY)
    await conn.query(
      `INSERT INTO transactions 
       (member_id, txn_id, income_type, wallet_type, amount, description, reference_id, reference_type, dedup_key, from_member_id, level_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [member_id, txn_id, income_type, wallet_type, creditAmount, description, reference_id, reference_type, dedup_key, from_member_id, level_no]
    );

    // 2. Update member wallet + income total + grand total
    await conn.query(
      `UPDATE members 
       SET ${wallet_type} = ${wallet_type} + ?,
           ${income_col} = ${income_col} + ?,
           total_income = total_income + ?
       WHERE id = ?`,
      [creditAmount, creditAmount, creditAmount, member_id]
    );

    if (savepoint) await conn.query(`RELEASE SAVEPOINT ${savepoint}`);
    return txn_id;
  } catch (err) {
    if (savepoint && err && err.code === 'ER_DUP_ENTRY') {
      // Duplicate income blocked by the unique key — undo cap consumption, credit nothing.
      await conn.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      return null;
    }
    throw err;
  }
}

module.exports = { recordTransaction };
