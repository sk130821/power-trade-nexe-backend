const db = require('../config/db');
const { checkWithdrawalAllowed, buildWithdrawalSchedule } = require('../utils/withdrawalSchedule');
const { createEmailOtp, verifyEmailOtp, buildOtpSuccessJson } = require('../utils/emailOtp');
const { getTradingWalletWithdrawable } = require('../utils/tradingWalletWithdrawable');

const WALLET_COL = {
  exchange_wallet: 'exchange_wallet',
  trading_wallet: 'trading_wallet',
  salary_wallet: 'salary_wallet',
};

/** Portal fee deducted from every withdrawal (member receives amount - fee). */
const PORTAL_FEE_PERCENT = 12;

/** Minimum gross withdrawal amount (USD). */
const MIN_WITHDRAWAL_USD = 10;

/** Returns { fee, net } in USD for a gross withdrawal amount. */
function computePortalFee(amount) {
  const gross = Number(amount) || 0;
  const fee = Math.round(gross * PORTAL_FEE_PERCENT) / 100; // 12% with 4-dp safe rounding
  const net = Math.round((gross - fee) * 10000) / 10000;
  return { fee_percent: PORTAL_FEE_PERCENT, fee_amount: fee, net_amount: net };
}

function isEvmAddress(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/i.test(a.trim());
}

/** Save member withdrawal destination (Trust Wallet · BSC). */
exports.updateMemberWalletAddress = async (req, res) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ error: 'Members only' });
    const { wallet_address } = req.body;
    if (!isEvmAddress(wallet_address || '')) {
      return res.status(400).json({ error: 'Valid Trust Wallet address (0x + 40 hex) is required' });
    }
    await db.query('UPDATE members SET wallet_address = ? WHERE id = ?', [
      wallet_address.trim(),
      req.user.id,
    ]);
    res.json({ message: 'Wallet address saved', wallet_address: wallet_address.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

async function validateWithdrawalRequest(memberId, wallet_type, amount) {
  const col = WALLET_COL[wallet_type];
  if (!col) return { error: 'wallet_type: exchange_wallet | trading_wallet | salary_wallet', status: 400 };
  const amt = amount != null && amount !== '' ? Number(amount) : NaN;
  if (!Number.isFinite(amt) || amt <= 0) return { error: 'Valid amount is required', status: 400 };
  if (amt < MIN_WITHDRAWAL_USD) {
    return { error: `Minimum withdrawal is $${MIN_WITHDRAWAL_USD}`, status: 400 };
  }

  const scheduleCheck = checkWithdrawalAllowed(wallet_type);
  if (!scheduleCheck.allowed) {
    return {
      error: scheduleCheck.error,
      status: 400,
      schedule: {
        allowed_today: false,
        allowed_day: scheduleCheck.allowed_day,
        next_date: scheduleCheck.next_date,
      },
    };
  }

  const [mem] = await db.query(
    `SELECT id, name, email, wallet_address, status, ${col} AS bal FROM members WHERE id = ?`,
    [memberId],
  );
  if (!mem.length) return { error: 'Member not found', status: 404 };
  if (mem[0].status !== 'active') {
    return {
      error: 'Only active members can withdraw. Wait for admin approval.',
      status: 400,
    };
  }
  if (!mem[0].wallet_address || !isEvmAddress(mem[0].wallet_address)) {
    return { error: 'Save your Trust Wallet payout address on this page first', status: 400 };
  }
  const bal = Number(mem[0].bal);
  let withdrawableBal = bal;
  let tradingWalletMeta = null;
  if (wallet_type === 'trading_wallet') {
    tradingWalletMeta = await getTradingWalletWithdrawable(memberId);
    withdrawableBal = tradingWalletMeta.trading_wallet_withdrawable;
    if (withdrawableBal < amt) {
      return {
        error:
          withdrawableBal <= 0
            ? 'Only Live Trade winnings can be withdrawn — your invested/top-up balance is not withdrawable'
            : `Insufficient withdrawable Live Trade winnings ($${withdrawableBal.toFixed(2)} available — only profit from winning trades can be withdrawn)`,
        status: 400,
        trading_wallet: tradingWalletMeta,
      };
    }
  } else if (bal < amt) {
    return { error: 'Insufficient balance in this wallet', status: 400 };
  }

  return { col, amt, member: mem[0], withdrawableBal, tradingWalletMeta };
}

/** Send OTP to member email before withdrawal. */
exports.sendWithdrawalOtp = async (req, res) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ error: 'Members only' });
    const memberId = req.user.id;
    const { wallet_type, amount, note } = req.body;

    const check = await validateWithdrawalRequest(memberId, wallet_type, amount);
    if (check.error) {
      const body = { error: check.error };
      if (check.schedule) body.schedule = check.schedule;
      return res.status(check.status || 400).json(body);
    }

    const result = await createEmailOtp({
      email: check.member.email,
      purpose: 'withdrawal',
      memberId,
      name: check.member.name,
      payload: {
        wallet_type,
        amount: check.amt,
        note: note || null,
      },
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    res.json(buildOtpSuccessJson(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.createWithdrawal = async (req, res) => {
  const conn = await db.getConnection();
  try {
    if (req.user.role !== 'member') return res.status(403).json({ error: 'Members only' });
    const memberId = req.user.id;
    const { wallet_type, amount, note, otp } = req.body;

    const [memEmail] = await conn.query('SELECT email, name FROM members WHERE id = ?', [memberId]);
    if (!memEmail.length) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const verified = await verifyEmailOtp({
      email: memEmail[0].email,
      otp,
      purpose: 'withdrawal',
      memberId,
    });
    if (!verified.ok) return res.status(verified.status || 400).json({ error: verified.error });

    const payload = verified.payload || {};
    const wType = payload.wallet_type || wallet_type;
    const wAmt = payload.amount != null ? payload.amount : amount;
    const wNote = payload.note != null ? payload.note : note;

    const check = await validateWithdrawalRequest(memberId, wType, wAmt);
    if (check.error) {
      const body = { error: check.error };
      if (check.schedule) body.schedule = check.schedule;
      return res.status(check.status || 400).json(body);
    }

    await conn.beginTransaction();
    const [mem] = await conn.query(
      `SELECT id, wallet_address, ${check.col} AS bal FROM members WHERE id = ? FOR UPDATE`,
      [memberId],
    );
    const bal = Number(mem[0].bal);
    if (wType === 'trading_wallet') {
      const tw = await getTradingWalletWithdrawable(memberId, conn);
      if (tw.trading_wallet_withdrawable < check.amt) {
        await conn.rollback();
        return res.status(400).json({
          error: `Insufficient withdrawable Live Trade winnings ($${tw.trading_wallet_withdrawable.toFixed(2)} available)`,
        });
      }
    } else if (bal < check.amt) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient balance in this wallet' });
    }

    const fee = computePortalFee(check.amt);
    await conn.query(
      `INSERT INTO withdrawal_requests
         (member_id, wallet_type, amount, fee_percent, fee_amount, net_amount, destination_address, member_note, status)
       VALUES (?,?,?,?,?,?,?,?,'pending')`,
      [
        memberId,
        wType,
        check.amt,
        fee.fee_percent,
        fee.fee_amount,
        fee.net_amount,
        String(mem[0].wallet_address).trim(),
        wNote || null,
      ],
    );
    await conn.commit();
    res.json({
      message: `Withdrawal request sent to admin. Portal fee ${fee.fee_percent}% ($${fee.fee_amount.toFixed(2)}) — you will receive $${fee.net_amount.toFixed(2)}`,
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
};

exports.listMyWithdrawals = async (req, res) => {
  try {
    if (req.user.role !== 'member') return res.status(403).json({ error: 'Members only' });
    const [rows] = await db.query(
      `SELECT id, wallet_type, amount, fee_percent, fee_amount, net_amount, destination_address, status, member_note, admin_note, payout_tx_hash, created_at, updated_at
       FROM withdrawal_requests WHERE member_id = ? ORDER BY id DESC LIMIT 100`,
      [req.user.id],
    );
    const trading_wallet = await getTradingWalletWithdrawable(req.user.id);
    res.json({
      withdrawals: rows,
      schedule: buildWithdrawalSchedule(),
      min_withdrawal_usd: MIN_WITHDRAWAL_USD,
      trading_wallet,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminListWithdrawals = async (req, res) => {
  try {
    const status = req.query.status;
    const conds = [];
    const params = [];
    if (status && ['pending', 'rejected', 'paid'].includes(String(status))) {
      conds.push('w.status = ?');
      params.push(status);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [rows] = await db.query(
      `SELECT w.*, m.name AS member_name, m.email AS member_email, m.referral_code
       FROM withdrawal_requests w
       JOIN members m ON m.id = w.member_id
       ${where}
       ORDER BY w.id DESC LIMIT 200`,
      params,
    );
    res.json({ withdrawals: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminRejectWithdrawal = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { admin_note } = req.body;
    const [r] = await db.query(
      `UPDATE withdrawal_requests SET status = 'rejected', admin_note = ? WHERE id = ? AND status = 'pending'`,
      [admin_note || null, id],
    );
    if (!r.affectedRows) return res.status(400).json({ error: 'Pending request not found' });
    res.json({ message: 'Rejected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminMarkWithdrawalPaid = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { payout_tx_hash, admin_note } = req.body;

    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE`, [id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }
    const w = rows[0];
    if (w.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ error: 'Only pending requests can be marked' });
    }
    const col = WALLET_COL[w.wallet_type];
    if (!col) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid wallet on row' });
    }
    const [m] = await conn.query(
      `SELECT id, ${col} AS bal FROM members WHERE id = ? FOR UPDATE`,
      [w.member_id],
    );
    if (!m.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Member not found' });
    }
    const bal = Number(m[0].bal);
    const need = Number(w.amount);
    if (bal < need) {
      await conn.rollback();
      return res.status(400).json({
        error: `Member balance is now too low ($${bal.toFixed(2)} < $${need.toFixed(2)}) — reject or adjust the amount`,
      });
    }

    await conn.query(`UPDATE members SET ${col} = ${col} - ? WHERE id = ?`, [need, w.member_id]);
    await conn.query(
      `UPDATE withdrawal_requests SET status = 'paid', payout_tx_hash = ?,
        admin_note = COALESCE(?, admin_note) WHERE id = ?`,
      [payout_tx_hash || null, admin_note || null, id],
    );
    await conn.commit();
    res.json({
      message:
        'Marked as paid — you can optionally save the BSC tx hash from your Trust Wallet transfer to the member address',
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
};
