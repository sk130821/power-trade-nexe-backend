const db = require('../config/db');
const {
  PROGRAMS,
  listTiers,
  buildMemberRewardProgress,
  createClaim,
  approveClaim,
  rejectClaim,
  updateTier,
} = require('../utils/rewardPlan');

exports.getMemberRewards = async (req, res) => {
  try {
    if (req.user.role !== 'member') {
      return res.status(403).json({ error: 'Members only' });
    }
    const data = await buildMemberRewardProgress(db, req.user.id);
    if (!data) return res.status(404).json({ error: 'Member not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.submitMemberClaim = async (req, res) => {
  const conn = await db.getConnection();
  try {
    if (req.user.role !== 'member') {
      return res.status(403).json({ error: 'Members only' });
    }
    const tierId = Number(req.body.tier_id);
    if (!Number.isFinite(tierId) || tierId < 1) {
      return res.status(400).json({ error: 'Invalid reward' });
    }
    await conn.beginTransaction();
    const result = await createClaim(conn, req.user.id, tierId, req.body.choice);
    if (result.error) {
      await conn.rollback();
      return res.status(result.status || 400).json({ error: result.error });
    }
    await conn.commit();
    res.json({
      message: result.choice === 'cash'
        ? 'Cash request sent to admin'
        : 'Gift request sent to admin',
      request: result,
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
};

exports.adminListTiers = async (req, res) => {
  try {
    const program = PROGRAMS.includes(req.query.program) ? req.query.program : null;
    const tiers = await listTiers(db, program);
    res.json({ tiers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminUpdateTier = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const file = req.files?.gift_image?.[0] || null;
    const removeImage = req.body.remove_image === '1' || req.body.remove_image === 'true';
    const result = await updateTier(db, id, req.body, file, { removeImage });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ message: 'Reward setting saved', tier: result.tier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminListRequests = async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status && ['pending', 'approved', 'rejected'].includes(req.query.status)) {
      where.push('r.status = ?');
      params.push(req.query.status);
    }
    if (PROGRAMS.includes(req.query.program)) {
      where.push('r.program = ?');
      params.push(req.query.program);
    }
    const sql = `
      SELECT r.*, m.name AS member_name, m.email AS member_email, m.referral_code,
             m.lifetime_rank, t.title AS tier_title, t.gift_image, t.sort_order,
             a.username AS reviewed_by_name
      FROM reward_claim_requests r
      JOIN members m ON m.id = r.member_id
      JOIN reward_plan_tiers t ON t.id = r.tier_id
      LEFT JOIN admins a ON a.id = r.reviewed_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.id DESC
      LIMIT 500`;
    const [rows] = await db.query(sql, params);
    res.json({ requests: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminApproveRequest = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    await conn.beginTransaction();
    const result = await approveClaim(conn, id, req.user.id, req.body?.admin_note);
    if (result.error) {
      await conn.rollback();
      return res.status(result.status || 400).json({ error: result.error });
    }
    await conn.commit();
    res.json({ message: 'Reward approved' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
};

exports.adminRejectRequest = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    await conn.beginTransaction();
    const result = await rejectClaim(conn, id, req.user.id, req.body?.admin_note);
    if (result.error) {
      await conn.rollback();
      return res.status(result.status || 400).json({ error: result.error });
    }
    await conn.commit();
    res.json({ message: 'Request rejected' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
};

exports.adminAchievers = async (req, res) => {
  try {
    const where = [`r.status = 'approved'`];
    const params = [];
    if (PROGRAMS.includes(req.query.program)) {
      where.push('r.program = ?');
      params.push(req.query.program);
    }
    const [rows] = await db.query(
      `SELECT r.id, r.program, r.choice, r.cash_amount, r.gift_name, r.rank_name,
              r.directs_at_claim, r.team_business_at_claim, r.reviewed_at, r.created_at,
              m.id AS member_id, m.name AS member_name, m.email AS member_email,
              m.referral_code, m.lifetime_rank, t.title AS tier_title, t.sort_order, t.gift_image
       FROM reward_claim_requests r
       JOIN members m ON m.id = r.member_id
       JOIN reward_plan_tiers t ON t.id = r.tier_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.reviewed_at DESC, r.id DESC
       LIMIT 500`,
      params,
    );
    res.json({ achievers: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
