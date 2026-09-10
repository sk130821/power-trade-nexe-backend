const db = require('../config/db');

/** Payments-based TOP-UP totals for a member (approved plan TOP-UP, trading funds, pending plan TOP-UP). */
async function fetchMemberTopupPaymentStats(memberId) {
  const mid = Number(memberId);
  const [approvedPlan] = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total_usd
     FROM payments
     WHERE member_id = ? AND payment_for = 'plan_topup' AND status = 'approved'`,
    [mid]
  );
  const [pendingPlan] = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total_usd
     FROM payments
     WHERE member_id = ? AND payment_for = 'plan_topup' AND status = 'pending'`,
    [mid]
  );
  const [approvedTrading] = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total_usd
     FROM payments
     WHERE member_id = ? AND payment_for = 'trading_topup' AND status = 'approved'`,
    [mid]
  );
  const [pendingTrading] = await db.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total_usd
     FROM payments
     WHERE member_id = ? AND payment_for = 'trading_topup' AND status = 'pending'`,
    [mid]
  );
  const rp = approvedPlan[0] || {};
  const pp = pendingPlan[0] || {};
  const rt = approvedTrading[0] || {};
  const pt = pendingTrading[0] || {};
  return {
    plan_topup: {
      approved_count: Number(rp.cnt || 0),
      approved_total_usd: parseFloat(Number(rp.total_usd || 0).toFixed(2)),
      pending_count: Number(pp.cnt || 0),
      pending_total_usd: parseFloat(Number(pp.total_usd || 0).toFixed(2)),
    },
    trading_wallet_funding: {
      approved_count: Number(rt.cnt || 0),
      approved_total_usd: parseFloat(Number(rt.total_usd || 0).toFixed(2)),
      pending_count: Number(pt.cnt || 0),
      pending_total_usd: parseFloat(Number(pt.total_usd || 0).toFixed(2)),
    },
  };
}

/**
 * Retopup history: approved cycles + payment receipts + pending/rejected submissions.
 * Admin manual +TOP-UP (no payment row) appears from member_income_cycles.
 */
async function fetchMemberPlanTopupHistory(memberId) {
  const mid = Number(memberId);
  if (!Number.isFinite(mid) || mid < 1) return [];

  const [payments] = await db.query(
    `SELECT id, amount, status, payment_type, IFNULL(transaction_id,'') AS transaction_id, created_at
     FROM payments
     WHERE member_id = ? AND payment_for = 'plan_topup'
     ORDER BY created_at ASC, id ASC`,
    [mid],
  );

  const [cycles] = await db.query(
    `SELECT cycle_level, slot_index, cap_base, created_at
     FROM member_income_cycles
     WHERE member_id = ? AND cycle_level >= 1
     ORDER BY cycle_level ASC`,
    [mid],
  );

  const approvedPayments = (payments || []).filter((p) => p.status === 'approved');
  const history = [];

  for (const cycle of cycles || []) {
    const seq = Number(cycle.cycle_level);
    const pay = approvedPayments[seq - 1] || null;
    history.push({
      seq,
      id: pay?.id ?? `cycle-${seq}`,
      cycle_level: seq,
      slot_index: Number(cycle.slot_index),
      amount: parseFloat(Number(pay?.amount ?? cycle.cap_base ?? 0).toFixed(2)),
      status: pay ? pay.status : 'admin_manual',
      source: pay ? 'payment' : 'admin_manual',
      payment_type: pay?.payment_type ?? null,
      transaction_id: pay?.transaction_id || '',
      created_at: pay?.created_at ?? cycle.created_at,
    });
  }

  const linkedPaymentIds = new Set(
    history.filter((h) => h.source === 'payment' && typeof h.id === 'number').map((h) => h.id),
  );

  for (const p of payments || []) {
    if (p.status === 'approved') {
      if (!linkedPaymentIds.has(p.id)) {
        history.push({
          seq: null,
          id: p.id,
          cycle_level: null,
          slot_index: null,
          amount: parseFloat(Number(p.amount || 0).toFixed(2)),
          status: p.status,
          source: 'payment',
          payment_type: p.payment_type,
          transaction_id: p.transaction_id || '',
          created_at: p.created_at,
        });
      }
      continue;
    }
    history.push({
      seq: null,
      id: p.id,
      cycle_level: null,
      slot_index: null,
      amount: parseFloat(Number(p.amount || 0).toFixed(2)),
      status: p.status,
      source: 'payment',
      payment_type: p.payment_type,
      transaction_id: p.transaction_id || '',
      created_at: p.created_at,
    });
  }

  history.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return history;
}

module.exports = { fetchMemberTopupPaymentStats, fetchMemberPlanTopupHistory };
