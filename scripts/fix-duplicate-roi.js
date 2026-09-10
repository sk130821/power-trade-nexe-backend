/**
 * Remove duplicate exchange trade (roi_income) payouts and related duplicate level_income.
 * Keeps the earliest transaction (lowest id) per member + trade + slot.
 *
 * Usage:
 *   node scripts/fix-duplicate-roi.js          # dry-run (report only)
 *   node scripts/fix-duplicate-roi.js --apply  # apply fixes
 */
const db = require('../config/db');
const { isMemberWorking } = require('../utils/incomeCap');
const { incomeCapMultiplier } = require('../utils/incomeCap');

const APPLY = process.argv.includes('--apply');

function parseSlotFromDescription(desc) {
  const m = String(desc || '').match(/\| slot (\d+) \|/);
  return m ? Number(m[1]) : null;
}

function parseCycleFromDescription(desc) {
  const m = String(desc || '').match(/\| slot \d+ \| cycle (\d+) \|/);
  return m ? Number(m[1]) : null;
}

async function findDuplicateRoiGroups(conn) {
  const [rows] = await conn.query(
    `SELECT t.member_id, t.reference_id AS trade_id,
            SUBSTRING_INDEX(SUBSTRING_INDEX(t.description, '| slot ', -1), ' |', 1) AS slot,
            GROUP_CONCAT(t.id ORDER BY t.id) AS txn_ids,
            COUNT(*) AS cnt
     FROM transactions t
     WHERE t.income_type = 'roi_income'
       AND t.reference_type = 'roi_trade'
       AND t.description LIKE '%| slot %'
     GROUP BY t.member_id, t.reference_id, slot
     HAVING cnt > 1
     ORDER BY t.reference_id, t.member_id, slot`,
  );
  return rows;
}

async function findDuplicateLevelGroups(conn) {
  const [rows] = await conn.query(
    `SELECT member_id, reference_id AS trade_id, from_member_id, level_no, description,
            GROUP_CONCAT(id ORDER BY id) AS txn_ids,
            COUNT(*) AS cnt
     FROM transactions
     WHERE income_type = 'level_income'
       AND reference_type = 'roi_trade'
     GROUP BY member_id, reference_id, from_member_id, level_no, description
     HAVING cnt > 1
     ORDER BY reference_id, from_member_id, level_no`,
  );
  return rows;
}

async function adjustMemberWallet(conn, memberId, walletType, incomeCol, delta, note) {
  const w = walletType;
  const col = incomeCol;
  await conn.query(
    `UPDATE members
     SET ${w} = GREATEST(0, ${w} + ?),
         ${col} = GREATEST(0, ${col} + ?),
         total_income = GREATEST(0, total_income + ?)
     WHERE id = ?`,
    [delta, delta, delta, memberId],
  );
}

async function adjustCycleCap(conn, memberId, description, amount) {
  const deduct = Number(amount);
  if (!Number.isFinite(deduct) || deduct <= 0) return;

  const cycleLevel = parseCycleFromDescription(description);
  let cycle = null;
  if (cycleLevel != null) {
    const [rows] = await conn.query(
      `SELECT * FROM member_income_cycles WHERE member_id = ? AND cycle_level = ? LIMIT 1 FOR UPDATE`,
      [memberId, cycleLevel],
    );
    cycle = rows[0] || null;
  } else {
    const [rows] = await conn.query(
      `SELECT * FROM member_income_cycles WHERE member_id = ? ORDER BY cycle_level ASC LIMIT 1 FOR UPDATE`,
      [memberId],
    );
    cycle = rows[0] || null;
  }
  if (!cycle) return;

  const working = await isMemberWorking(conn, memberId);
  const multiplier = incomeCapMultiplier(working);
  const limit = parseFloat((Number(cycle.cap_base) * multiplier).toFixed(4));
  const newEarned = Math.max(0, parseFloat((Number(cycle.capped_earned) - deduct).toFixed(4)));
  const capClosed = newEarned >= limit - 0.0001 ? 1 : 0;

  await conn.query(
    `UPDATE member_income_cycles SET capped_earned = ?, cap_closed = ? WHERE id = ?`,
    [newEarned, capClosed, cycle.id],
  );
}

async function reverseTransaction(conn, txn, reason) {
  const amount = Number(txn.amount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const walletMap = {
    roi_income: { wallet: 'exchange_wallet', col: 'total_roi_income' },
    level_income: { wallet: 'exchange_wallet', col: 'total_level_income' },
  };
  const map = walletMap[txn.income_type];
  if (!map) return 0;

  await adjustMemberWallet(conn, txn.member_id, map.wallet, map.col, -amount, reason);

  if (txn.income_type === 'roi_income') {
    await adjustCycleCap(conn, txn.member_id, txn.description, amount);
  }

  await conn.query(`DELETE FROM transactions WHERE id = ?`, [txn.id]);
  return amount;
}

async function fixTradeTotalDistributed(conn, tradeId, delta) {
  if (!delta || delta <= 0) return;
  await conn.query(
    `UPDATE roi_trades
     SET total_distributed = GREATEST(0, COALESCE(total_distributed, 0) - ?)
     WHERE id = ?`,
    [delta, tradeId],
  );
}

async function main() {
  const conn = await db.getConnection();
  try {
    const roiGroups = await findDuplicateRoiGroups(conn);
    const levelGroups = await findDuplicateLevelGroups(conn);

    const roiRemoveIds = [];
    const levelRemoveIds = [];
    let roiReverseTotal = 0;
    let levelReverseTotal = 0;
    const tradeAdjust = new Map();

    console.log(`\n=== Duplicate ROI fix ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);
    console.log(`Duplicate roi_income groups: ${roiGroups.length}`);
    console.log(`Duplicate level_income groups: ${levelGroups.length}\n`);

    for (const g of roiGroups) {
      const ids = String(g.txn_ids).split(',').map(Number);
      const keep = ids[0];
      const remove = ids.slice(1);
      roiRemoveIds.push(...remove);

      const [mem] = await conn.query(
        `SELECT referral_code, name FROM members WHERE id = ?`,
        [g.member_id],
      );
      const [txns] = await conn.query(
        `SELECT id, amount FROM transactions WHERE id IN (?)`,
        [remove],
      );
      const sum = txns.reduce((s, t) => s + Number(t.amount), 0);
      roiReverseTotal += sum;
      tradeAdjust.set(g.trade_id, (tradeAdjust.get(g.trade_id) || 0) + sum);

      console.log(
        `ROI ${mem[0]?.referral_code} trade #${g.trade_id} slot ${g.slot}: keep ${keep}, remove [${remove.join(', ')}] = -$` +
          sum.toFixed(4),
      );
    }

    for (const g of levelGroups) {
      const ids = String(g.txn_ids).split(',').map(Number);
      const remove = ids.slice(1);
      levelRemoveIds.push(...remove);

      const [txns] = await conn.query(
        `SELECT id, amount FROM transactions WHERE id IN (?)`,
        [remove],
      );
      const sum = txns.reduce((s, t) => s + Number(t.amount), 0);
      levelReverseTotal += sum;
      tradeAdjust.set(g.trade_id, (tradeAdjust.get(g.trade_id) || 0) + sum);

      console.log(
        `LEVEL member #${g.member_id} from #${g.from_member_id} trade #${g.trade_id} L${g.level_no}: remove [${remove.join(', ')}] = -$` +
          sum.toFixed(6),
      );
    }

    console.log(`\nTotal roi_income to reverse: $${roiReverseTotal.toFixed(4)} (${roiRemoveIds.length} txns)`);
    console.log(`Total level_income to reverse: $${levelReverseTotal.toFixed(6)} (${levelRemoveIds.length} txns)`);
    console.log(`Trades to adjust total_distributed: ${tradeAdjust.size}`);

    if (!APPLY) {
      console.log('\nDry run only — pass --apply to fix database.');
      return;
    }

    if (!roiRemoveIds.length && !levelRemoveIds.length) {
      console.log('\nNothing to fix.');
      return;
    }

    await conn.beginTransaction();

    const allRemoveIds = [...new Set([...roiRemoveIds, ...levelRemoveIds])].sort((a, b) => a - b);
    const [txnsToRemove] = await conn.query(
      `SELECT * FROM transactions WHERE id IN (?) ORDER BY id ASC`,
      [allRemoveIds],
    );

    let reversed = 0;
    for (const txn of txnsToRemove) {
      const amt = await reverseTransaction(
        conn,
        txn,
        'Reversal: duplicate exchange trade payout removed by system fix',
      );
      reversed += amt;
    }

    for (const [tradeId, delta] of tradeAdjust.entries()) {
      await fixTradeTotalDistributed(conn, tradeId, delta);
    }

    await conn.commit();
    console.log(`\nDone. Reversed $${reversed.toFixed(4)} across ${txnsToRemove.length} transactions.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await db.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
