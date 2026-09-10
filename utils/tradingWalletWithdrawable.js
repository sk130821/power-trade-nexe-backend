const db = require('../config/db');

/**
 * Live Trade wallet: only profit from winning (2×) trades is withdrawable.
 * Top-up / principal stays in the wallet for re-trading.
 */
async function getTradingWalletWithdrawable(memberId, conn) {
  const q = conn && typeof conn.query === 'function' ? conn.query.bind(conn) : db.query.bind(db);

  const [profitRows] = await q(
    `SELECT COALESCE(SUM(result_amount - invest_amount), 0) AS total_profit
     FROM day_trade_investments
     WHERE member_id = ? AND status = 'doubled'`,
    [memberId],
  );
  const totalProfit = Number(profitRows[0]?.total_profit) || 0;

  const [withdrawRows] = await q(
    `SELECT COALESCE(SUM(amount), 0) AS total_withdrawn
     FROM withdrawal_requests
     WHERE member_id = ? AND wallet_type = 'trading_wallet' AND status IN ('pending', 'paid')`,
    [memberId],
  );
  const totalWithdrawn = Number(withdrawRows[0]?.total_withdrawn) || 0;

  const [memRows] = await q(`SELECT trading_wallet FROM members WHERE id = ?`, [memberId]);
  const balance = Number(memRows[0]?.trading_wallet) || 0;

  const profitRemaining = Math.max(0, totalProfit - totalWithdrawn);
  const withdrawable = Math.min(balance, profitRemaining);

  return {
    trading_wallet: balance,
    trading_wallet_withdrawable: Math.round(withdrawable * 10000) / 10000,
    trading_wallet_locked: Math.round(Math.max(0, balance - withdrawable) * 10000) / 10000,
    trading_profit_total: totalProfit,
    trading_withdrawn: totalWithdrawn,
  };
}

module.exports = { getTradingWalletWithdrawable };
