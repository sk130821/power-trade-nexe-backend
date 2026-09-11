/**
 * Daily Growth Reward + Life Time Reward.
 * Qualify = active directs AND full-downline active team business (AND).
 */
const path = require('path');
const fs = require('fs');
const { uploadDir } = require('../config/paths');
const { recordTransaction } = require('./transaction');

const PROGRAMS = ['daily_growth', 'lifetime'];

const DEFAULT_TIERS = [
  { program: 'daily_growth', sort_order: 1, title: 'Daily Growth 1', gift_name: 'Smart Phone', rank_name: null, min_directs: 5, team_business: 5000, cash_amount: 100, allows_cash: 1 },
  { program: 'daily_growth', sort_order: 2, title: 'Daily Growth 2', gift_name: 'Tablet', rank_name: null, min_directs: 10, team_business: 10000, cash_amount: 200, allows_cash: 1 },
  { program: 'daily_growth', sort_order: 3, title: 'Daily Growth 3', gift_name: 'AC', rank_name: null, min_directs: 15, team_business: 25000, cash_amount: 500, allows_cash: 1 },
  { program: 'daily_growth', sort_order: 4, title: 'Daily Growth 4', gift_name: 'Bike', rank_name: null, min_directs: 25, team_business: 50000, cash_amount: 1000, allows_cash: 1 },
  { program: 'daily_growth', sort_order: 5, title: 'Daily Growth 5', gift_name: 'Car', rank_name: null, min_directs: 50, team_business: 100000, cash_amount: 2000, allows_cash: 1 },
  { program: 'lifetime', sort_order: 1, title: 'Life Time 1', gift_name: 'Smart Mobile', rank_name: 'Gold Manager', min_directs: 50, team_business: 205625, cash_amount: 0, allows_cash: 0 },
  { program: 'lifetime', sort_order: 2, title: 'Life Time 2', gift_name: 'Bullet Bike', rank_name: 'Platinum Manager', min_directs: 50, team_business: 708125, cash_amount: 0, allows_cash: 0 },
  { program: 'lifetime', sort_order: 3, title: 'Life Time 3', gift_name: 'Car (Dzire)', rank_name: 'Ruby Director', min_directs: 50, team_business: 3090625, cash_amount: 0, allows_cash: 0 },
  { program: 'lifetime', sort_order: 4, title: 'Life Time 4', gift_name: 'Mercedes C', rank_name: 'Emerald Director', min_directs: 50, team_business: 10953125, cash_amount: 0, allows_cash: 0 },
  { program: 'lifetime', sort_order: 5, title: 'Life Time 5', gift_name: 'Range Rover', rank_name: 'Diamond Director', min_directs: 50, team_business: 408828125, cash_amount: 0, allows_cash: 0 },
  { program: 'lifetime', sort_order: 6, title: 'Life Time 6', gift_name: 'Luxury Villa', rank_name: 'Crown Legend', min_directs: 50, team_business: 90765625, cash_amount: 0, allows_cash: 0 },
];

function deleteUploadFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(uploadDir, String(filename)));
  } catch (_) {
    /* ignore missing file */
  }
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getTeamStats(conn, memberId) {
  const [[directs]] = await conn.query(
    `SELECT COUNT(*) AS c FROM members WHERE sponsor_id = ? AND status = 'active'`,
    [memberId],
  );

  const [[team]] = await conn.query(
    `WITH RECURSIVE downline AS (
       SELECT id, package_amount, status
       FROM members WHERE sponsor_id = ?
       UNION ALL
       SELECT m.id, m.package_amount, m.status
       FROM members m
       INNER JOIN downline d ON m.sponsor_id = d.id
     )
     SELECT COALESCE(SUM(CASE WHEN status = 'active' THEN package_amount ELSE 0 END), 0) AS team_business
     FROM downline`,
    [memberId],
  );

  return {
    active_directs: num(directs?.c),
    team_business: parseFloat(num(team?.team_business).toFixed(2)),
  };
}

function isQualified(stats, tier) {
  return (
    stats.active_directs >= num(tier.min_directs) &&
    stats.team_business + 1e-9 >= num(tier.team_business)
  );
}

async function listTiers(conn, program = null, { activeOnly = false } = {}) {
  let sql = 'SELECT * FROM reward_plan_tiers';
  const params = [];
  const where = [];
  if (program) {
    where.push('program = ?');
    params.push(program);
  }
  if (activeOnly) {
    where.push('is_active = 1');
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY program ASC, sort_order ASC, id ASC';
  const [rows] = await conn.query(sql, params);
  return rows;
}

async function loadClaimsByTier(conn, memberId, program) {
  const [rows] = await conn.query(
    `SELECT * FROM reward_claim_requests
     WHERE member_id = ? AND program = ?
     ORDER BY id DESC`,
    [memberId, program],
  );
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.tier_id)) latest.set(row.tier_id, row);
  }
  return latest;
}

function buildTierProgress(tier, stats, claim, previousApproved) {
  const minDirects = num(tier.min_directs);
  const targetBiz = num(tier.team_business);
  const directsDone = stats.active_directs;
  const businessDone = stats.team_business;
  const directsLeft = Math.max(0, minDirects - directsDone);
  const businessLeft = parseFloat(Math.max(0, targetBiz - businessDone).toFixed(2));
  const qualified = isQualified(stats, tier);
  const allowsCash = Number(tier.allows_cash) === 1;
  let status = 'in_progress';
  if (claim?.status === 'approved') status = 'approved';
  else if (claim?.status === 'pending') status = 'pending';
  else if (!previousApproved) status = 'locked_previous';
  else if (qualified) status = 'unlocked';
  else if (claim?.status === 'rejected') status = 'rejected';

  const canClaim = status === 'unlocked' || status === 'rejected';

  return {
    id: tier.id,
    program: tier.program,
    sort_order: tier.sort_order,
    title: tier.title,
    gift_name: tier.gift_name,
    gift_image: tier.gift_image,
    rank_name: tier.rank_name,
    min_directs: minDirects,
    team_business: targetBiz,
    cash_amount: num(tier.cash_amount),
    allows_cash: allowsCash,
    is_active: Number(tier.is_active) === 1,
    directs_done: directsDone,
    directs_left: directsLeft,
    business_done: businessDone,
    business_left: businessLeft,
    directs_pct: minDirects > 0 ? Math.min(100, Math.round((directsDone / minDirects) * 100)) : 100,
    business_pct: targetBiz > 0 ? Math.min(100, Math.round((businessDone / targetBiz) * 100)) : 100,
    qualified,
    previous_approved: previousApproved,
    status,
    can_claim: canClaim,
    claim: claim
      ? {
          id: claim.id,
          choice: claim.choice,
          status: claim.status,
          cash_amount: num(claim.cash_amount),
          gift_name: claim.gift_name,
          rank_name: claim.rank_name,
          admin_note: claim.admin_note,
          created_at: claim.created_at,
          reviewed_at: claim.reviewed_at,
        }
      : null,
  };
}

async function buildProgramProgress(conn, memberId, program, stats) {
  const tiers = await listTiers(conn, program, { activeOnly: true });
  const claims = await loadClaimsByTier(conn, memberId, program);
  let previousApproved = true;
  return tiers.map((tier) => {
    const claim = claims.get(tier.id) || null;
    const row = buildTierProgress(tier, stats, claim, previousApproved);
    previousApproved = claim?.status === 'approved';
    return row;
  });
}

async function buildMemberRewardProgress(conn, memberId) {
  const [[member]] = await conn.query(
    'SELECT id, status, lifetime_rank FROM members WHERE id = ?',
    [memberId],
  );
  if (!member) return null;
  const stats = await getTeamStats(conn, memberId);
  const daily_growth = await buildProgramProgress(conn, memberId, 'daily_growth', stats);
  const lifetime = await buildProgramProgress(conn, memberId, 'lifetime', stats);
  const currentLifetime = [...lifetime].reverse().find((t) => t.status === 'approved');
  return {
    member_status: member.status,
    lifetime_rank: currentLifetime?.rank_name || member.lifetime_rank || null,
    stats,
    daily_growth,
    lifetime,
  };
}

async function createClaim(conn, memberId, tierId, choiceRaw) {
  const [[member]] = await conn.query(
    'SELECT id, status, name FROM members WHERE id = ? FOR UPDATE',
    [memberId],
  );
  if (!member) return { error: 'Member not found', status: 404 };
  if (member.status !== 'active') return { error: 'Only active members can claim rewards', status: 400 };

  const [[tier]] = await conn.query(
    'SELECT * FROM reward_plan_tiers WHERE id = ? FOR UPDATE',
    [tierId],
  );
  if (!tier || Number(tier.is_active) !== 1) return { error: 'Reward tier not found', status: 404 };

  const allowsCash = Number(tier.allows_cash) === 1;
  let choice = String(choiceRaw || '').toLowerCase();
  if (tier.program === 'lifetime' || !allowsCash) {
    choice = 'gift';
  }
  if (choice !== 'cash' && choice !== 'gift') {
    return { error: 'Choose cash or gift', status: 400 };
  }
  if (choice === 'cash' && !allowsCash) {
    return { error: 'This reward is gift only', status: 400 };
  }
  if (choice === 'cash' && num(tier.cash_amount) <= 0) {
    return { error: 'Cash amount is not set for this reward', status: 400 };
  }

  const stats = await getTeamStats(conn, memberId);
  if (!isQualified(stats, tier)) {
    return {
      error: `Need ${tier.min_directs} active directs and ${tier.team_business} team business`,
      status: 400,
    };
  }

  const prevTiers = await listTiers(conn, tier.program, { activeOnly: true });
  const earlier = prevTiers.filter((t) => Number(t.sort_order) < Number(tier.sort_order));
  for (const prev of earlier) {
    const [[ok]] = await conn.query(
      `SELECT id FROM reward_claim_requests
       WHERE member_id = ? AND tier_id = ? AND status = 'approved' LIMIT 1`,
      [memberId, prev.id],
    );
    if (!ok) {
      return { error: `Complete ${prev.title} first`, status: 400 };
    }
  }

  const [[open]] = await conn.query(
    `SELECT id, status FROM reward_claim_requests
     WHERE member_id = ? AND tier_id = ? AND status IN ('pending','approved')
     ORDER BY id DESC LIMIT 1`,
    [memberId, tierId],
  );
  if (open?.status === 'pending') return { error: 'A request is already pending for this reward', status: 400 };
  if (open?.status === 'approved') return { error: 'This reward is already claimed', status: 400 };

  const cashAmount = choice === 'cash' ? num(tier.cash_amount) : 0;
  const [ins] = await conn.query(
    `INSERT INTO reward_claim_requests
      (member_id, tier_id, program, choice, status, cash_amount, gift_name, rank_name,
       directs_at_claim, team_business_at_claim)
     VALUES (?,?,?,?,'pending',?,?,?,?,?)`,
    [
      memberId,
      tierId,
      tier.program,
      choice,
      cashAmount,
      tier.gift_name,
      tier.rank_name,
      stats.active_directs,
      stats.team_business,
    ],
  );

  return { id: ins.insertId, choice, gift_name: tier.gift_name, cash_amount: cashAmount };
}

async function approveClaim(conn, requestId, adminId, adminNote) {
  const [[row]] = await conn.query(
    'SELECT * FROM reward_claim_requests WHERE id = ? FOR UPDATE',
    [requestId],
  );
  if (!row) return { error: 'Request not found', status: 404 };
  if (row.status === 'approved') return { error: 'Already approved', status: 400 };
  if (row.status === 'rejected') return { error: 'This request was rejected — member must submit again', status: 400 };

  const note = adminNote != null ? String(adminNote).trim() : null;

  if (row.choice === 'cash' && num(row.cash_amount) > 0) {
    await recordTransaction(conn, {
      member_id: Number(row.member_id),
      income_type: 'reward_income',
      amount: num(row.cash_amount),
      description: `Daily Growth Reward cash: ${row.gift_name}`,
      reference_id: Number(row.id),
      reference_type: 'reward_claim',
      dedup_key: `reward_income|claim${Number(row.id)}`,
    });
  }

  await conn.query(
    `INSERT INTO reward_records (member_id, reward_title, reward_description, reward_value, reward_type, created_by)
     VALUES (?,?,?,?,?,?)`,
    [
      row.member_id,
      row.program === 'lifetime'
        ? `${row.gift_name}${row.rank_name ? ` · ${row.rank_name}` : ''}`
        : row.choice === 'cash'
          ? `${row.gift_name} (cash)`
          : row.gift_name,
      row.program === 'lifetime'
        ? `Life Time Reward approved`
        : `Daily Growth Reward — ${row.choice}`,
      row.choice === 'cash' ? num(row.cash_amount) : 0,
      row.choice === 'cash' ? 'cash' : 'gift',
      adminId,
    ],
  );

  if (row.program === 'lifetime' && row.rank_name) {
    await conn.query('UPDATE members SET lifetime_rank = ? WHERE id = ?', [row.rank_name, row.member_id]);
  }

  await conn.query(
    `UPDATE reward_claim_requests
     SET status = 'approved', admin_note = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [note, adminId, requestId],
  );

  return { ok: true };
}

async function rejectClaim(conn, requestId, adminId, adminNote) {
  const [[row]] = await conn.query(
    'SELECT * FROM reward_claim_requests WHERE id = ? FOR UPDATE',
    [requestId],
  );
  if (!row) return { error: 'Request not found', status: 404 };
  if (row.status !== 'pending') return { error: 'Only pending requests can be rejected', status: 400 };
  const note = adminNote != null ? String(adminNote).trim() : null;
  await conn.query(
    `UPDATE reward_claim_requests
     SET status = 'rejected', admin_note = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [note, adminId, requestId],
  );
  return { ok: true };
}

async function updateTier(conn, tierId, body, file, { removeImage = false } = {}) {
  const [[tier]] = await conn.query('SELECT * FROM reward_plan_tiers WHERE id = ?', [tierId]);
  if (!tier) return { error: 'Tier not found', status: 404 };

  const fields = [];
  const vals = [];
  const setStr = (col, value) => {
    fields.push(`${col} = ?`);
    vals.push(value);
  };

  if (body.title != null) setStr('title', String(body.title).trim() || tier.title);
  if (body.gift_name != null) setStr('gift_name', String(body.gift_name).trim() || tier.gift_name);
  if (body.rank_name !== undefined) {
    const r = body.rank_name == null ? '' : String(body.rank_name).trim();
    setStr('rank_name', r || null);
  }
  if (body.min_directs != null && body.min_directs !== '') {
    const n = parseInt(body.min_directs, 10);
    if (!Number.isFinite(n) || n < 0) return { error: 'Invalid directs target', status: 400 };
    setStr('min_directs', n);
  }
  if (body.team_business != null && body.team_business !== '') {
    const n = Number(body.team_business);
    if (!Number.isFinite(n) || n < 0) return { error: 'Invalid team business target', status: 400 };
    setStr('team_business', parseFloat(n.toFixed(2)));
  }
  if (body.cash_amount != null && body.cash_amount !== '') {
    const n = Number(body.cash_amount);
    if (!Number.isFinite(n) || n < 0) return { error: 'Invalid cash amount', status: 400 };
    setStr('cash_amount', parseFloat(n.toFixed(4)));
  }
  if (body.allows_cash !== undefined) {
    setStr('allows_cash', body.allows_cash === true || body.allows_cash === 1 || body.allows_cash === '1' ? 1 : 0);
  }
  if (body.is_active !== undefined) {
    setStr('is_active', body.is_active === false || body.is_active === 0 || body.is_active === '0' ? 0 : 1);
  }

  if (file?.filename) {
    if (tier.gift_image) deleteUploadFile(tier.gift_image);
    setStr('gift_image', file.filename);
  } else if (removeImage) {
    if (tier.gift_image) deleteUploadFile(tier.gift_image);
    setStr('gift_image', null);
  }

  if (!fields.length) return { error: 'Nothing to update', status: 400 };
  vals.push(tierId);
  await conn.query(`UPDATE reward_plan_tiers SET ${fields.join(', ')} WHERE id = ?`, vals);
  const [[updated]] = await conn.query('SELECT * FROM reward_plan_tiers WHERE id = ?', [tierId]);
  return { tier: updated };
}

async function seedDefaultTiers(conn) {
  const [[row]] = await conn.query('SELECT COUNT(*) AS c FROM reward_plan_tiers');
  if (num(row?.c) > 0) return;
  const own = typeof conn.getConnection === 'function';
  const c = own ? await conn.getConnection() : conn;
  try {
    if (c.beginTransaction) await c.beginTransaction();
    for (const t of DEFAULT_TIERS) {
      await c.query(
        `INSERT INTO reward_plan_tiers
          (program, sort_order, title, gift_name, rank_name, min_directs, team_business, cash_amount, allows_cash)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          t.program, t.sort_order, t.title, t.gift_name, t.rank_name,
          t.min_directs, t.team_business, t.cash_amount, t.allows_cash,
        ],
      );
    }
    if (c.commit) await c.commit();
  } catch (e) {
    if (c.rollback) await c.rollback();
    throw e;
  } finally {
    if (own) c.release();
  }
}

module.exports = {
  PROGRAMS,
  DEFAULT_TIERS,
  getTeamStats,
  listTiers,
  buildMemberRewardProgress,
  createClaim,
  approveClaim,
  rejectClaim,
  updateTier,
  seedDefaultTiers,
};
