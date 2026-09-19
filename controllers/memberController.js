const db = require('../config/db');
const {
  getMaxPlanTopupForToday,
  syncOpenRoiParticipantSlotForMember,
  computeNextPlanTopupPayment,
} = require('./roiController');
const bcrypt = require('bcryptjs');
const { recordTransaction } = require('../utils/transaction');
const { initIncomeCapOnActivation } = require('../utils/incomeCap');
const { buildNonWorking2xParticipationWindow } = require('../utils/nonWorking2xWindow');
const { isDayTradeVisibleToMember, isDayTradeBuyWindowOpen, getTodayIstYmd } = require('../utils/dayTradeIstWindow');
const {
  initPlanCycle,
  addRetopupCycle,
  buildMemberCycleCapOverview,
  ensureMemberCycles,
} = require('../utils/retopupCycles');
const { getTradingWalletWithdrawable } = require('../utils/tradingWalletWithdrawable');

function isEvmTxHash(v) {
  if (v == null || typeof v !== 'string') return false;
  return /^0x[a-fA-F0-9]{64}$/.test(v.trim());
}

const TRUST_PAYMENT_TYPES = ['trust_wallet', 'metamask'];

function isTrustWalletPaymentType(t) {
  return TRUST_PAYMENT_TYPES.includes(t);
}

function trustTxHashOk(payment_type, transaction_id) {
  return isTrustWalletPaymentType(payment_type) && isEvmTxHash(transaction_id);
}

function normalizeTrustPaymentType(payment_type) {
  if (payment_type === 'metamask') return 'trust_wallet';
  return payment_type;
}

function omitPassword(row) {
  if (!row || typeof row !== 'object') return row;
  const { password: _pw, ...rest } = row;
  return rest;
}

const { fetchMemberTopupPaymentStats, fetchMemberPlanTopupHistory } = require('../utils/memberTopupPaymentStats');
const {
  evaluateMonthlySalariesForUpline,
  processMonthlySalaryPayouts,
  buildMemberSalaryStatus,
} = require('../utils/monthlySalary');
const { processDailyBonusOnActivation } = require('../utils/dailyBonus');
const { MAX_NETWORK_LEVELS } = require('../config/levelIncome');
const { buildLevelBusinessSummary } = require('../utils/levelBusiness');
const { sendRegistrationWelcomeEmail, sendMemberActivationEmail } = require('../utils/registrationEmail');
const { generateUniqueMemberId, normalizeMemberIdInput } = require('../utils/memberId');

const REGISTRATION_PACKAGES = [11, 22, 51, 101, 201, 501, 1001];

function parseRegistrationBody(body, files) {
  const name = body.name != null ? String(body.name).trim() : '';
  const email = body.email != null ? String(body.email).trim().toLowerCase() : '';
  const contact = body.contact != null ? String(body.contact).trim() : '';
  const aadhaar_no = body.aadhaar_no != null ? String(body.aadhaar_no).trim() : '';
  const password = body.password != null ? String(body.password) : '';
  const dob = body.dob != null ? String(body.dob).trim() : '';
  const sponsor_code = body.sponsor_code != null ? normalizeMemberIdInput(body.sponsor_code) : '';
  const package_amount = Number(body.package_amount);
  const aadhaar_photo = files?.aadhaar_photo?.[0]?.filename || null;

  if (!name || !email || !contact || !aadhaar_no || !dob) {
    return { error: 'All personal fields are required', status: 400 };
  }
  if (!REGISTRATION_PACKAGES.includes(package_amount)) {
    return { error: 'Invalid package amount', status: 400 };
  }
  if (!password || password.length < 6) {
    return { error: 'Password must be at least 6 characters', status: 400 };
  }
  if (!aadhaar_photo) {
    return { error: 'Aadhaar photo is required', status: 400 };
  }

  return {
    name,
    email,
    contact,
    aadhaar_no,
    password,
    dob,
    sponsor_code,
    package_amount,
    aadhaar_photo,
  };
}

async function resolveSponsorId(sponsor_code) {
  const code = normalizeMemberIdInput(sponsor_code);
  if (!code) return null;
  const [sp] = await db.query(
    'SELECT id FROM members WHERE UPPER(referral_code) = ? LIMIT 1',
    [code],
  );
  return sp.length ? sp[0].id : null;
}

// Public: resolve a sponsor referral code to its member name (used on the
// registration page so the user can confirm who their sponsor is).
exports.lookupSponsor = async (req, res) => {
  try {
    const code = normalizeMemberIdInput(req.params.code || req.query.code || '');
    if (!code) return res.json({ found: false });
    const [sp] = await db.query(
      'SELECT name, referral_code FROM members WHERE UPPER(referral_code) = ? LIMIT 1',
      [code],
    );
    if (!sp.length) return res.json({ found: false });
    return res.json({
      found: true,
      name: sp[0].name,
      referral_code: sp[0].referral_code,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function registrationApiPayload(result) {
  return {
    member_id: result.member_id,
    member_code: result.referral_code,
    referral_code: result.referral_code,
  };
}

async function assertRegistrationNotDuplicate(email, aadhaar_no) {
  const [byEmail] = await db.query('SELECT id FROM members WHERE LOWER(email) = ?', [email]);
  if (byEmail.length) return { error: 'Email already registered', status: 400 };
  const [byAd] = await db.query('SELECT id FROM members WHERE aadhaar_no = ?', [aadhaar_no]);
  if (byAd.length) return { error: 'Aadhaar already registered', status: 400 };
  return null;
}

async function fetchRegistrationPayment(memberId) {
  const [rows] = await db.query(
    `SELECT id, status, amount FROM payments
     WHERE member_id = ? AND (payment_for IS NULL OR payment_for = 'registration')
     ORDER BY id DESC LIMIT 1`,
    [memberId]
  );
  return rows[0] || null;
}

async function hasRegistrationPayment(memberId) {
  return !!(await fetchRegistrationPayment(memberId));
}

/** SQL fragment — member has submitted registration payment (hide unpaid OTP-only signups). */
const SQL_HAS_REGISTRATION_PAYMENT = `EXISTS (
  SELECT 1 FROM payments pr
  WHERE pr.member_id = m.id
    AND (pr.payment_for IS NULL OR pr.payment_for = 'registration')
)`;

/** OTP done but registration package payment not submitted yet. */
const SQL_NO_REGISTRATION_PAYMENT = `NOT EXISTS (
  SELECT 1 FROM payments pr
  WHERE pr.member_id = m.id
    AND (pr.payment_for IS NULL OR pr.payment_for = 'registration')
)`;

exports.hasRegistrationPayment = hasRegistrationPayment;
exports.SQL_HAS_REGISTRATION_PAYMENT = SQL_HAS_REGISTRATION_PAYMENT;
exports.SQL_NO_REGISTRATION_PAYMENT = SQL_NO_REGISTRATION_PAYMENT;

const { getRoiPercent } = require('../utils/roiPercent');

async function insertPendingMember({
  name, email, contact, aadhaar_no, password, dob, sponsor_id, package_amount, aadhaar_photo,
}) {
  const VALID_PACKAGES = [11, 22, 51, 101, 201, 501, 1001];
  if (!VALID_PACKAGES.includes(Number(package_amount))) {
    return { error: 'Invalid package amount', status: 400 };
  }
  if (!password || String(password).length < 6) {
    return { error: 'Password must be at least 6 characters', status: 400 };
  }

  const password_hash = await bcrypt.hash(String(password), 10);
  const referral_code = await generateUniqueMemberId();

  const [result] = await db.query(
    `INSERT INTO members (name,email,contact,aadhaar_no,password,aadhaar_photo,dob,sponsor_id,referral_code,package_amount,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
    [name, email, contact, aadhaar_no, password_hash, aadhaar_photo, dob, sponsor_id, referral_code, package_amount],
  );

  return { member_id: result.insertId, referral_code };
}

exports.register = async (req, res) => {
  return res.status(400).json({
    error:
      'Complete registration with package payment on the register page. Payment is required before signup finishes.',
  });
};

/** Create pending member after details + package (no email OTP). */
exports.sendRegistrationOtp = async (req, res) => {
  try {
    const parsed = parseRegistrationBody(req.body, req.files);
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });

    const dup = await assertRegistrationNotDuplicate(parsed.email, parsed.aadhaar_no);
    if (dup) return res.status(dup.status).json({ error: dup.error });

    let sponsor_id = null;
    if (parsed.sponsor_code) {
      sponsor_id = await resolveSponsorId(parsed.sponsor_code);
      if (!sponsor_id) {
        return res.status(400).json({ error: 'Sponsor Member ID not found — use a valid PTN code' });
      }
    }

    const result = await insertPendingMember({
      name: parsed.name,
      email: parsed.email,
      contact: parsed.contact,
      aadhaar_no: parsed.aadhaar_no,
      password: parsed.password,
      dob: parsed.dob,
      sponsor_id,
      package_amount: parsed.package_amount,
      aadhaar_photo: parsed.aadhaar_photo,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    res.json({
      message: 'Registration started — submit package payment to complete signup.',
      registration_complete: false,
      payment_required: true,
      ...registrationApiPayload(result),
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or Aadhaar already registered' });
    res.status(500).json({ error: err.message });
  }
};

/** Legacy — OTP removed. */
exports.verifyRegistrationOtp = async (req, res) => {
  res.status(410).json({ error: 'Email OTP is disabled. Continue registration from the package step.' });
};

/** Logged-in member registers a new downline under their own sponsor ID. */
exports.registerDownline = async (req, res) => {
  return res.status(400).json({
    error: 'Use Add Member with package payment. Payment is required to complete registration.',
  });
};

/** Create downline pending member (no email OTP). */
exports.sendDownlineRegistrationOtp = async (req, res) => {
  try {
    const sponsorId = req.user.id;
    const [sp] = await db.query('SELECT id, status, referral_code FROM members WHERE id = ?', [sponsorId]);
    if (!sp.length) return res.status(404).json({ error: 'Sponsor not found' });
    if (sp[0].status !== 'active') {
      return res.status(400).json({ error: 'Only active members can register new members' });
    }

    const parsed = parseRegistrationBody(req.body, req.files);
    if (parsed.error) return res.status(parsed.status).json({ error: parsed.error });

    const dup = await assertRegistrationNotDuplicate(parsed.email, parsed.aadhaar_no);
    if (dup) return res.status(dup.status).json({ error: dup.error });

    const result = await insertPendingMember({
      name: parsed.name,
      email: parsed.email,
      contact: parsed.contact,
      aadhaar_no: parsed.aadhaar_no,
      password: parsed.password,
      dob: parsed.dob,
      sponsor_id: sponsorId,
      package_amount: parsed.package_amount,
      aadhaar_photo: parsed.aadhaar_photo,
    });
    if (result.error) return res.status(result.status).json({ error: result.error });

    res.json({
      message: 'Member created — submit package payment to complete registration.',
      registration_complete: false,
      payment_required: true,
      ...registrationApiPayload(result),
      sponsor_code: sp[0].referral_code,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email or Aadhaar already registered' });
    res.status(500).json({ error: err.message });
  }
};

exports.verifyDownlineRegistrationOtp = async (req, res) => {
  res.status(410).json({ error: 'Email OTP is disabled. Continue from Add Member package step.' });
};

exports.getRegistrationPaymentInfo = async (req, res) => {
  try {
    const memberId = req.user.id;
    const [rows] = await db.query(
      `SELECT id, referral_code, package_amount, status, email, name FROM members WHERE id = ?`,
      [memberId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const m = rows[0];
    const regPay = await fetchRegistrationPayment(memberId);
    res.json({
      member_id: m.id,
      referral_code: m.referral_code,
      package_amount: m.package_amount,
      status: m.status,
      payment_required: !regPay,
      payment_status: regPay?.status || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.submitPayment = async (req, res) => {
  try {
    const { member_id, transaction_id, remark, amount } = req.body;
    let memberId = Number(member_id);
    if (req.user?.role === 'member') {
      memberId = req.user.id;
    }
    if (!Number.isFinite(memberId) || memberId <= 0) {
      return res.status(400).json({ error: 'Valid member_id is required' });
    }

    let payment_type = normalizeTrustPaymentType(req.body.payment_type);
    const receipt_image = req.files?.receipt?.[0]?.filename || null;
    if (!isTrustWalletPaymentType(payment_type)) {
      return res.status(400).json({ error: 'payment_type must be trust_wallet' });
    }
    if (!receipt_image && !trustTxHashOk(payment_type, transaction_id)) {
      return res.status(400).json({
        error: 'Upload receipt or enter BSC tx hash (0x…) in Transaction ID after Trust Wallet payment',
      });
    }

    const [members] = await db.query('SELECT * FROM members WHERE id = ?', [memberId]);
    if (!members.length) {
      return res.status(404).json({ error: 'Member not found' });
    }
    const member = members[0];

    const existingPay = await fetchRegistrationPayment(memberId);
    if (existingPay) {
      return res.status(400).json({ error: 'Registration payment already submitted for this member' });
    }

    const amt = amount != null && amount !== '' ? Number(amount) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    if (Number(member.package_amount) !== amt) {
      return res.status(400).json({
        error: `Payment amount must match selected package ($${member.package_amount})`,
      });
    }

    await db.query(
      `INSERT INTO payments (member_id,payment_type,transaction_id,receipt_image,amount,remark,status,payment_for)
       VALUES (?,?,?,?,?,?,'pending','registration')`,
      [memberId, payment_type, transaction_id || null, receipt_image, amt, remark || null]
    );

    try {
      await sendRegistrationWelcomeEmail({ ...omitPassword(member), id: memberId }, null);
    } catch (mailErr) {
      console.error('[mail] Welcome email failed:', mailErr.message);
    }

    res.json({
      message: 'Payment submitted — registration complete. Awaiting admin approval.',
      registration_complete: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Logged-in member: trading wallet top-up — awaits admin approval before wallet credit. */
exports.submitTradingTopup = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const memberId = req.user.id;
    const { transaction_id, remark, amount } = req.body;
    let payment_type = normalizeTrustPaymentType(req.body.payment_type);
    const receipt_image = req.files?.receipt?.[0]?.filename || null;
    const amt = amount != null && amount !== '' ? Number(amount) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }
    if (!isTrustWalletPaymentType(payment_type)) {
      return res.status(400).json({ error: 'payment_type must be trust_wallet' });
    }
    if (!receipt_image && !trustTxHashOk(payment_type, transaction_id)) {
      return res.status(400).json({
        error:
          'Upload receipt or enter BSC tx hash (0x…) in Transaction ID after Trust Wallet payment',
      });
    }

    await conn.beginTransaction();
    const [mem] = await conn.query('SELECT id, status FROM members WHERE id = ? FOR UPDATE', [memberId]);
    if (!mem.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Member not found' });
    }
    if (mem[0].status !== 'active') {
      await conn.rollback();
      return res.status(400).json({ error: 'Only active members can add trading wallet funds' });
    }

    const [dup] = await conn.query(
      `SELECT id FROM payments WHERE member_id = ? AND status = 'pending' AND payment_for = 'trading_topup' LIMIT 1`,
      [memberId]
    );
    if (dup.length) {
      await conn.rollback();
      return res.status(400).json({
        error:
          'A trading wallet payment is already pending — you cannot submit another until admin approves it',
      });
    }

    await conn.query(
      `INSERT INTO payments (member_id,payment_type,transaction_id,receipt_image,amount,remark,status,payment_for)
       VALUES (?,?,?,?,?,?,'pending','trading_topup')`,
      [memberId, payment_type, transaction_id || null, receipt_image, amt, remark || null]
    );
    await conn.commit();
    res.json({
      message: `Trading wallet payment of $${amt.toFixed(2)} submitted. Admin will approve it — then your wallet will be credited.`,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

/** Member: next plan TOP-UP amount + pending request (if any). */
exports.getPlanTopupInfo = async (req, res) => {
  try {
    const memberId = req.user.id;
    const [memRows] = await db.query(
      `SELECT package_amount, plan_topup_count, status FROM members WHERE id = ?`,
      [memberId]
    );
    if (!memRows.length) return res.status(404).json({ error: 'Member not found' });
    const m = memRows[0];

    const [pendRows] = await db.query(
      `SELECT id, amount, payment_type, transaction_id, created_at, status
       FROM payments
       WHERE member_id = ? AND payment_for = 'plan_topup' AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [memberId]
    );
    const [pendTradingRows] = await db.query(
      `SELECT id, amount, payment_type, transaction_id, created_at, status
       FROM payments
       WHERE member_id = ? AND payment_for = 'trading_topup' AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [memberId]
    );

    const next = await computeNextPlanTopupPayment(m.plan_topup_count, m.package_amount);
    const [topup_payment_stats, plan_topup_history] = await Promise.all([
      fetchMemberTopupPaymentStats(memberId),
      fetchMemberPlanTopupHistory(memberId),
    ]);
    topup_payment_stats.plan_topup_ladder_level = Number(m.plan_topup_count) || 0;
    res.json({
      member_status: m.status,
      pending_plan_topup_payment: pendRows[0] || null,
      pending_trading_topup_payment: pendTradingRows[0] || null,
      next_payment: next.ok
        ? { amount_due_usd: next.amount_due_usd, next_slot_index: next.next_slot_index }
        : null,
      ladder_blocked: !next.ok,
      ladder_message: next.ok ? null : next.message,
      topup_payment_stats,
      plan_topup_history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Member: submit proof for next plan TOP-UP — awaits admin approval (like registration payment). */
exports.submitPlanTopupPayment = async (req, res) => {
  try {
    const memberId = req.user.id;
    const { transaction_id, remark, amount } = req.body;
    let payment_type = normalizeTrustPaymentType(req.body.payment_type);
    const receipt_image = req.files?.receipt?.[0]?.filename || null;

    if (!isTrustWalletPaymentType(payment_type)) {
      return res.status(400).json({ error: 'payment_type must be trust_wallet' });
    }
    if (!receipt_image && !trustTxHashOk(payment_type, transaction_id)) {
      return res.status(400).json({
        error:
          'Upload receipt or enter BSC tx hash (0x…) in Transaction ID after Trust Wallet payment',
      });
    }

    const [memRows] = await db.query(
      `SELECT id, status, package_amount, plan_topup_count FROM members WHERE id = ?`,
      [memberId]
    );
    if (!memRows.length) return res.status(404).json({ error: 'Member not found' });
    const m = memRows[0];
    if (m.status !== 'active') {
      return res.status(400).json({ error: 'Only active members can submit plan TOP-UP payments' });
    }

    const [dup] = await db.query(
      `SELECT id FROM payments WHERE member_id = ? AND status = 'pending' AND payment_for = 'plan_topup' LIMIT 1`,
      [memberId]
    );
    if (dup.length) {
      return res.status(400).json({
        error: 'A plan TOP-UP payment is already pending — you cannot submit another until admin approves it',
      });
    }

    const next = await computeNextPlanTopupPayment(m.plan_topup_count, m.package_amount);
    if (!next.ok) {
      return res.status(400).json({ error: next.message || 'Plan TOP-UP is not available right now' });
    }

    const amt = amount != null && amount !== '' ? Number(amount) : NaN;
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'Valid amount required' });
    }
    const expected = next.amount_due_usd;
    if (Math.abs(amt - expected) > 0.02) {
      return res.status(400).json({
        error: `Payment amount for this step must be exactly $${expected.toFixed(
          2
        )} (per today's Trade ladder).`,
        expected_amount: expected,
      });
    }

    await db.query(
      `INSERT INTO payments (member_id,payment_type,transaction_id,receipt_image,amount,remark,status,payment_for)
       VALUES (?,?,?,?,?,?,'pending','plan_topup')`,
      [memberId, payment_type, transaction_id || null, receipt_image, amt, remark || null]
    );
    res.json({
      message:
        'Plan TOP-UP payment submitted. Admin will approve it — then your ladder slot will increase by 1.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Build downline from sponsor_id tree — Level 1 = direct, Level 2 = their directs, … */
exports.getMemberGenealogy = async (req, res) => {
  try {
    const rootId = req.user.id;
    const maxLevel = Math.min(
      MAX_NETWORK_LEVELS,
      Math.max(1, Number(req.query.max_level) || MAX_NETWORK_LEVELS)
    );
    const levels = [];
    let frontier = [rootId];
    const IN_CHUNK = 400;

    for (let depth = 1; depth <= maxLevel; depth++) {
      if (!frontier.length) break;

      const batchRows = [];
      for (let i = 0; i < frontier.length; i += IN_CHUNK) {
        const chunk = frontier.slice(i, i + IN_CHUNK);
        const ph = chunk.map(() => '?').join(',');
        const [rows] = await db.query(
          `SELECT id, sponsor_id, name, email, contact, referral_code, package_amount, status, created_at
           FROM members WHERE sponsor_id IN (${ph})
             AND EXISTS (
               SELECT 1 FROM payments pr
               WHERE pr.member_id = members.id
                 AND (pr.payment_for IS NULL OR pr.payment_for = 'registration')
             )
           ORDER BY id ASC`,
          chunk
        );
        batchRows.push(...rows);
      }

      if (!batchRows.length) break;

      levels.push({
        level: depth,
        count: batchRows.length,
        members: batchRows.map((m) => ({
          id: m.id,
          sponsor_id: m.sponsor_id,
          name: m.name,
          email: m.email,
          contact: m.contact,
          referral_code: m.referral_code,
          package_amount: m.package_amount,
          status: m.status,
          created_at: m.created_at,
          level: depth,
        })),
      });

      frontier = batchRows.map((r) => r.id);
    }

    const total_downline = levels.reduce((s, L) => s + L.count, 0);
    const deepest_level = levels.length ? levels[levels.length - 1].level : 0;
    const flat_members = levels.flatMap((L) => L.members);

    res.json({
      levels,
      flat_members,
      total_downline,
      deepest_level,
      max_level_query: maxLevel,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMemberLevelBusiness = async (req, res) => {
  try {
    const summary = await buildLevelBusinessSummary(db, req.user.id);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Logged-in member: verify current password and set a new one. */
exports.changeMemberPassword = async (req, res) => {
  try {
    if (req.user.role !== 'member') {
      return res.status(403).json({ error: 'Only members can change password here' });
    }
    const memberId = req.user.id;
    const { current_password, new_password } = req.body;
    if (current_password == null || new_password == null) {
      return res.status(400).json({ error: 'current_password and new_password required' });
    }
    const cur = String(current_password);
    const nw = String(new_password);
    if (nw.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const [rows] = await db.query(
      'SELECT id, password, aadhaar_no, status FROM members WHERE id = ?',
      [memberId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const m = rows[0];
    if (m.status !== 'active') {
      return res.status(400).json({ error: 'Password can only be changed after your account is active' });
    }

    let valid = false;
    if (m.password) {
      valid = await bcrypt.compare(cur, m.password);
    } else {
      valid = String(m.aadhaar_no) === cur;
    }
    if (!valid) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(nw, 10);
    await db.query('UPDATE members SET password = ? WHERE id = ?', [password_hash, memberId]);
    res.json({ message: 'Password updated. Log in with your new password next time.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMemberDashboard = async (req, res) => {
  try {
    const memberId = req.user.id;
    const [member] = await db.query(
      `SELECT m.*, s.name as sponsor_name, s.referral_code as sponsor_code 
       FROM members m LEFT JOIN members s ON m.sponsor_id = s.id WHERE m.id = ?`, [memberId]
    );
    if (!member.length) return res.status(404).json({ error: 'Member not found' });

    // All transactions for this member
    const [transactions] = await db.query(
      `SELECT t.*, m.name as from_name 
       FROM transactions t 
       LEFT JOIN members m ON t.from_member_id = m.id
       WHERE t.member_id = ? ORDER BY t.created_at DESC LIMIT 50`, [memberId]
    );

    // Income breakdown from transactions
    const [incomeByType] = await db.query(
      `SELECT income_type, SUM(amount) as total, COUNT(*) as count
       FROM transactions WHERE member_id = ? GROUP BY income_type`, [memberId]
    );

    const [myReferrals] = await db.query(
      `SELECT id, name, email, referral_code, package_amount, status, created_at
       FROM members
       WHERE sponsor_id = ?
         AND EXISTS (
           SELECT 1 FROM payments pr
           WHERE pr.member_id = members.id
             AND (pr.payment_for IS NULL OR pr.payment_for = 'registration')
         )`,
      [memberId],
    );

    const [rewards] = await db.query(
      `SELECT * FROM reward_records WHERE member_id = ? ORDER BY created_at DESC`, [memberId]
    );

    const [salaries] = await db.query(
      `SELECT * FROM salary_records WHERE member_id = ? ORDER BY created_at DESC`, [memberId]
    );

    const [topup_payment_stats, plan_topup_history] = await Promise.all([
      fetchMemberTopupPaymentStats(memberId),
      fetchMemberPlanTopupHistory(memberId),
    ]);
    topup_payment_stats.plan_topup_ladder_level = Number(member[0].plan_topup_count) || 0;

    const income_cap = await buildMemberCycleCapOverview(db, member[0].id);
    const non_working_2x_window = await buildNonWorking2xParticipationWindow(
      db,
      memberId,
      Number(member[0].package_amount) || 0,
      { working: income_cap.working },
    );
    const monthly_salary = await buildMemberSalaryStatus(db, memberId);

    const [incomeTrendRaw] = await db.query(
      `SELECT DATE(created_at) AS day, SUM(amount) AS amount, COUNT(*) AS count
       FROM transactions
       WHERE member_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [memberId],
    );

    const memberRow = omitPassword(member[0]);
    memberRow.member_code = memberRow.referral_code;
    const regPay = await fetchRegistrationPayment(memberId);
    const trading_wallet_info = await getTradingWalletWithdrawable(memberId);

    const todayIst = getTodayIstYmd();
    const [dailyGrowthTodayRows] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS today
       FROM transactions
       WHERE member_id = ? AND income_type = 'daily_bonus_income' AND DATE(created_at) = ?`,
      [memberId, todayIst],
    );
    const [liveTradeWins] = await db.query(
      `SELECT MIN(dti.id) AS id,
              dti.day_trade_id,
              SUM(dti.invest_amount) AS invest_amount,
              SUM(dti.result_amount) AS result_amount,
              MAX(COALESCE(dti.trade_name_at_buy, dt.trade_name)) AS trade_name,
              MAX(COALESCE(dti.trade_symbol_at_buy, dt.trade_symbol)) AS trade_symbol,
              MAX(COALESCE(dti.session_date_at_buy, dt.trade_date, DATE(dti.invested_at))) AS trade_date,
              MAX(dt.closed_at) AS closed_at
       FROM day_trade_investments dti
       INNER JOIN day_trades dt ON dt.id = dti.day_trade_id AND dt.is_winner = 1
       INNER JOIN transactions t
         ON t.member_id = dti.member_id
        AND t.income_type = 'trading_income'
        AND t.reference_type = 'day_trade'
        AND t.reference_id = dti.day_trade_id
        AND t.dedup_key = CONCAT('trading_income|dt', dti.day_trade_id, '|inv', dti.id)
       WHERE dti.member_id = ? AND dti.status = 'doubled'
         AND DATE(t.created_at) = ?
       GROUP BY dti.day_trade_id
       ORDER BY closed_at DESC`,
      [memberId, todayIst],
    );

    res.json({
      member: memberRow,
      registration_payment_pending: !regPay,
      registration_payment_status: regPay?.status || null,
      transactions,
      incomeByType,
      income_trend: incomeTrendRaw,
      myReferrals,
      rewards,
      salaries,
      topup_payment_stats,
      plan_topup_history,
      income_cap,
      non_working_2x_window,
      monthly_salary,
      trading_wallet_info,
      live_trade_wins: liveTradeWins,
      daily_growth_income: {
        total: Number(memberRow.total_daily_bonus_income) || 0,
        today: Number(dailyGrowthTodayRows[0]?.today) || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.buyDayTrade = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { trade_id, quantity, amount: amountLegacy } = req.body;
    const memberId = req.user.id;

    const [memCheck] = await conn.query('SELECT status FROM members WHERE id = ?', [memberId]);
    if (!memCheck.length || memCheck[0].status !== 'active') {
      await conn.rollback();
      return res.status(400).json({
        error: 'Only active members can buy live trades. Wait for admin approval.',
      });
    }

    if (!isDayTradeBuyWindowOpen()) {
      await conn.rollback();
      return res.status(400).json({
        error: 'Live trades open from 9:00 AM IST. Buying stays open until admin settles the session.',
      });
    }

    const todayIst = getTodayIstYmd();
    const [trade] = await conn.query(
      `SELECT * FROM day_trades
       WHERE id = ? AND deleted_at IS NULL AND status = 'active' AND trade_date = ?`,
      [trade_id, todayIst],
    );
    if (!trade.length) { await conn.rollback(); return res.status(400).json({ error: 'Trade not available' }); }

    const lastPrice = Number(trade[0].last_price || 0);
    if (!lastPrice || !Number.isFinite(lastPrice)) {
      await conn.rollback();
      return res.status(400).json({ error: 'Trade price (LTP) is not set. Ask admin to recreate trade with price.' });
    }

    let qty;
    let amount;
    if (quantity != null && quantity !== '') {
      qty = Number(quantity);
      if (!Number.isFinite(qty) || qty < 1 || Math.floor(qty) !== qty) {
        await conn.rollback();
        return res.status(400).json({ error: 'Quantity must be a whole number of at least 1' });
      }
      qty = Math.floor(qty);
      amount = parseFloat((qty * lastPrice).toFixed(4));
    } else if (amountLegacy != null && amountLegacy !== '') {
      amount = Number(amountLegacy);
      if (!Number.isFinite(amount) || amount <= 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'Invalid amount' });
      }
      qty = parseFloat((amount / lastPrice).toFixed(8));
    } else {
      await conn.rollback();
      return res.status(400).json({ error: 'Send quantity (buy-only) or legacy amount' });
    }

    const minInv = Number(trade[0].min_invest || 1);
    if (amount < minInv) {
      await conn.rollback();
      return res.status(400).json({ error: `Minimum order value is $${minInv.toFixed(2)} (qty × LTP)` });
    }

    const [member] = await conn.query('SELECT trading_wallet FROM members WHERE id = ? FOR UPDATE', [memberId]);
    if (!member.length || Number(member[0].trading_wallet) < amount) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient trading wallet balance' });
    }

    const [existing] = await conn.query(
      `SELECT id FROM day_trade_investments
       WHERE member_id = ? AND day_trade_id = ? AND DATE(invested_at) = ?`,
      [memberId, trade_id, todayIst],
    );
    if (existing.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'You already bought this script today (one buy per script per day).' });
    }

    await conn.query('UPDATE members SET trading_wallet = trading_wallet - ? WHERE id = ?', [amount, memberId]);
    const sessionDate = trade[0].trade_date
      ? String(trade[0].trade_date).slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    await conn.query(
      `INSERT INTO day_trade_investments (
         member_id, day_trade_id, trade_name_at_buy, trade_symbol_at_buy, session_date_at_buy,
         invest_amount, quantity, price_at_buy
       ) VALUES (?,?,?,?,?,?,?,?)`,
      [
        memberId,
        trade_id,
        trade[0].trade_name,
        trade[0].trade_symbol || null,
        sessionDate,
        amount,
        qty,
        lastPrice,
      ]
    );

    await conn.commit();
    res.json({ message: 'Purchase successful', quantity: qty, price: lastPrice, total: amount });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
};

/** Member: live trades they have bought (all sessions). */
exports.getMyDayTradeInvestments = async (req, res) => {
  try {
    const memberId = req.user.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    let where = 'dti.member_id = ?';
    const params = [memberId];
    if (req.query.date_from) {
      where += ' AND DATE(COALESCE(dti.session_date_at_buy, dti.invested_at)) >= ?';
      params.push(req.query.date_from);
    }
    if (req.query.date_to) {
      where += ' AND DATE(COALESCE(dti.session_date_at_buy, dti.invested_at)) <= ?';
      params.push(req.query.date_to);
    }
    if (req.query.status && ['active', 'doubled', 'zeroed'].includes(req.query.status)) {
      where += ' AND dti.status = ?';
      params.push(req.query.status);
    }

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM day_trade_investments dti WHERE ${where}`,
      params,
    );

    const [rows] = await db.query(
      `SELECT dti.id,
              dti.day_trade_id,
              dti.invest_amount,
              dti.quantity,
              dti.price_at_buy,
              dti.result_amount,
              dti.status AS investment_status,
              dti.invested_at,
              COALESCE(dti.trade_name_at_buy, dt.trade_name) AS trade_name,
              COALESCE(dti.trade_symbol_at_buy, dt.trade_symbol) AS trade_symbol,
              dt.last_price AS trade_last_price,
              COALESCE(dti.session_date_at_buy, dt.trade_date, DATE(dti.invested_at)) AS trade_date,
              dt.status AS trade_status,
              dt.result AS trade_result,
              dti.trade_name_at_buy,
              dti.session_date_at_buy
       FROM day_trade_investments dti
       LEFT JOIN day_trades dt ON dt.id = dti.day_trade_id
       WHERE ${where}
       ORDER BY dti.invested_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const [[summary]] = await db.query(
      `SELECT COUNT(*) AS total_trades,
              COALESCE(SUM(invest_amount), 0) AS total_invested,
              COALESCE(SUM(CASE WHEN status = 'doubled' THEN result_amount ELSE 0 END), 0) AS total_payout,
              SUM(CASE WHEN status = 'doubled' THEN 1 ELSE 0 END) AS wins,
              SUM(CASE WHEN status = 'zeroed' THEN 1 ELSE 0 END) AS losses,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS pending
       FROM day_trade_investments
       WHERE member_id = ?`,
      [memberId],
    );

    res.json({ rows, total, page, limit, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const MEMBERS_EXPORT_MAX = 25000;
const MEMBERS_PAGE_MAX = 200;

// Admin: Get all members (search, status, plan, pagination, IST registration date, export)
exports.getAllMembers = async (req, res) => {
  try {
    const {
      status,
      q,
      search,
      package_amount: pkgRaw,
      page = 1,
      limit = 20,
      pending_payment: pendingPaymentRaw,
      unpaid_registration: unpaidRegistrationRaw,
      date_from,
      date_to,
      export: exportRaw,
    } = req.query;
    const exportMode = ['1', 'true', 'yes'].includes(String(exportRaw || '').toLowerCase());
    const rawQ = q != null && q !== '' ? q : search;
    const term = rawQ != null ? String(rawQ).trim() : '';

    const conds = [];
    const params = [];
    if (status) {
      conds.push('m.status = ?');
      params.push(status);
    }
    if (pkgRaw != null && String(pkgRaw).trim() !== '') {
      const pkg = Number(pkgRaw);
      if (Number.isFinite(pkg)) {
        conds.push('m.package_amount = ?');
        params.push(pkg);
      }
    }
    if (term) {
      const like = `%${term}%`;
      conds.push(
        '(m.name LIKE ? OR m.email LIKE ? OR m.contact LIKE ? OR m.aadhaar_no LIKE ? OR CAST(m.id AS CHAR) LIKE ? OR m.referral_code LIKE ?)'
      );
      params.push(like, like, like, like, like, like);
    }
    const pendingPaymentOnly =
      pendingPaymentRaw === '1' || pendingPaymentRaw === 'true' || pendingPaymentRaw === 'yes';
    const unpaidRegistrationOnly =
      unpaidRegistrationRaw === '1' || unpaidRegistrationRaw === 'true' || unpaidRegistrationRaw === 'yes';
    if (unpaidRegistrationOnly) {
      conds.push(`m.status = 'pending'`);
      conds.push(SQL_NO_REGISTRATION_PAYMENT);
    } else if (pendingPaymentOnly) {
      conds.push(`(
        (m.status = 'pending' AND ${SQL_HAS_REGISTRATION_PAYMENT})
        OR EXISTS (
          SELECT 1 FROM payments px
          WHERE px.member_id = m.id AND px.status = 'pending'
            AND px.payment_for IN ('plan_topup', 'trading_topup')
        )
      )`);
    } else {
      conds.push(SQL_HAS_REGISTRATION_PAYMENT);
    }
    addIstMemberDateFilters(conds, params, date_from, date_to);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [count] = await db.query(`SELECT COUNT(*) as total FROM members m ${where}`, params);
    const total = Number(count[0]?.total ?? 0);

    let lim;
    let offset;
    let pg;
    if (exportMode) {
      lim = Math.min(MEMBERS_EXPORT_MAX, Math.max(0, total));
      offset = 0;
      pg = 1;
    } else {
      lim = Math.min(MEMBERS_PAGE_MAX, Math.max(1, Number(limit) || 20));
      pg = Math.max(1, Number(page) || 1);
      offset = (pg - 1) * lim;
    }

    /** Latest payment row per member — duplicate JOIN rows avoid */
    const [members] = await db.query(
      `SELECT m.*, s.name as sponsor_name,
       p.id as latest_payment_id,
       p.payment_type, p.receipt_image, p.status as payment_status, p.remark as payment_remark,
       p.payment_for as payment_for, p.amount as latest_payment_amount,
       (SELECT p2.id FROM payments p2 WHERE p2.member_id = m.id AND p2.status = 'pending' ORDER BY p2.id DESC LIMIT 1) AS pending_payment_id,
       (SELECT p2.payment_for FROM payments p2 WHERE p2.member_id = m.id AND p2.status = 'pending' ORDER BY p2.id DESC LIMIT 1) AS pending_payment_for,
       (SELECT p2.amount FROM payments p2 WHERE p2.member_id = m.id AND p2.status = 'pending' ORDER BY p2.id DESC LIMIT 1) AS pending_payment_amount
       FROM members m
       LEFT JOIN members s ON m.sponsor_id = s.id
       LEFT JOIN payments p ON p.id = (
         SELECT p2.id FROM payments p2 WHERE p2.member_id = m.id ORDER BY p2.id DESC LIMIT 1
       )
       ${where}
       ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    res.json({
      members: members.map(omitPassword),
      total,
      page: pg,
      limit: lim,
      exportMode: Boolean(exportMode),
      exportTruncated: exportMode && total > MEMBERS_EXPORT_MAX,
      exportMax: MEMBERS_EXPORT_MAX,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: Approve/reject member
exports.updateMemberStatus = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { status } = req.body;

    // FOR UPDATE: serialize concurrent approve requests so two parallel
    // activations can't both read status='pending' and both pay direct income.
    const [member] = await conn.query('SELECT * FROM members WHERE id = ? FOR UPDATE', [id]);
    if (!member.length) { await conn.rollback(); return res.status(404).json({ error: 'Member not found' }); }

    if (status === 'active') {
      const [regPay] = await conn.query(
        `SELECT id FROM payments
         WHERE member_id = ? AND (payment_for IS NULL OR payment_for = 'registration')
         LIMIT 1`,
        [id]
      );
      if (!regPay.length) {
        await conn.rollback();
        return res.status(400).json({ error: 'Cannot activate member without registration payment on file.' });
      }
    }

    const payStatus = status === 'active' ? 'approved' : 'rejected';
    if (member[0].status === 'pending') {
      await conn.query(
        `UPDATE payments p
         INNER JOIN members m ON m.id = p.member_id
         SET p.status = ?
         WHERE p.member_id = ? AND p.status = 'pending' AND m.status = 'pending'
           AND (p.payment_for IS NULL OR p.payment_for = 'registration')`,
        [payStatus, id]
      );
    }

    await conn.query('UPDATE members SET status = ? WHERE id = ?', [status, id]);

    if (status === 'active') {
      await initIncomeCapOnActivation(conn, id);
      await initPlanCycle(conn, id, member[0].package_amount);
    }

    // Direct sponsor income on activation → exchange_wallet
    if (status === 'active' && member[0].status !== 'active' && member[0].sponsor_id) {
      // Idempotency: never pay direct income twice for the same member join
      // (guards re-activation after rejected→active, and any retry/double-click).
      const [alreadyPaid] = await conn.query(
        `SELECT id FROM transactions
         WHERE income_type = 'direct_income'
           AND reference_type = 'member_join'
           AND reference_id = ?
         LIMIT 1`,
        [Number(id)]
      );
      if (!alreadyPaid.length) {
        const directIncome = member[0].package_amount * 0.05;
        await recordTransaction(conn, {
          member_id: member[0].sponsor_id,
          income_type: 'direct_income',
          amount: directIncome,
          description: `Direct sponsor income from ${member[0].name} (Package: $${member[0].package_amount})`,
          reference_id: Number(id),
          reference_type: 'member_join',
          from_member_id: Number(id),
          dedup_key: `direct_income|join${Number(id)}`
        });
      }
    }

    if (status === 'active' && member[0].status !== 'active') {
      await evaluateMonthlySalariesForUpline(conn, Number(id));
      await processMonthlySalaryPayouts(conn);
      await processDailyBonusOnActivation(conn, Number(id));
    }

    await conn.commit();

    if (status === 'active' && member[0].status !== 'active') {
      try {
        await sendMemberActivationEmail(omitPassword(member[0]));
      } catch (mailErr) {
        console.error('[mail] Activation email failed:', mailErr.message);
      }
    }

    res.json({ message: `Member ${status} successfully` });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
};

const VALID_PACKAGES = [11, 22, 51, 101, 201, 501, 1001];

function memberPasswordInfo(row) {
  const hasPassword = !!(row.password && String(row.password).trim());
  return {
    has_password: hasPassword,
    login_hint: hasPassword
      ? 'Password set (encrypted — original cannot be read)'
      : 'No password set — member may login using Aadhaar number',
  };
}

/** Admin: single member with sponsor + payment + password meta (no hash). */
exports.getAdminMemberById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT m.*, s.name AS sponsor_name, s.referral_code AS sponsor_referral_code,
       p.id AS latest_payment_id, p.payment_type, p.receipt_image, p.status AS payment_status,
       p.remark AS payment_remark, p.payment_for, p.amount AS latest_payment_amount
       FROM members m
       LEFT JOIN members s ON m.sponsor_id = s.id
       LEFT JOIN payments p ON p.id = (
         SELECT p2.id FROM payments p2 WHERE p2.member_id = m.id ORDER BY p2.id DESC LIMIT 1
       )
       WHERE m.id = ?`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const row = rows[0];
    const plan_topup_history = await fetchMemberPlanTopupHistory(row.id);
    res.json({
      member: {
        ...omitPassword(row),
        password_info: memberPasswordInfo(row),
      },
      plan_topup_history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Admin: update member profile fields. */
exports.updateAdminMember = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      contact,
      aadhaar_no,
      dob,
      package_amount,
      sponsor_id,
      sponsor_referral_code,
      wallet_address,
      plan_topup_count,
    } = req.body;

    const [existing] = await db.query('SELECT * FROM members WHERE id = ?', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Member not found' });
    const cur = existing[0];

    const updates = {};
    if (name != null && String(name).trim()) updates.name = String(name).trim();
    if (email != null && String(email).trim()) {
      const em = String(email).trim().toLowerCase();
      const [dup] = await db.query('SELECT id FROM members WHERE email = ? AND id != ?', [em, id]);
      if (dup.length) return res.status(400).json({ error: 'Email already used by another member' });
      updates.email = em;
    }
    if (contact != null && String(contact).trim()) updates.contact = String(contact).trim();
    if (aadhaar_no != null && String(aadhaar_no).trim()) {
      const ad = String(aadhaar_no).trim();
      const [dup] = await db.query('SELECT id FROM members WHERE aadhaar_no = ? AND id != ?', [ad, id]);
      if (dup.length) return res.status(400).json({ error: 'Aadhaar already used by another member' });
      updates.aadhaar_no = ad;
    }
    if (dob != null && String(dob).trim()) updates.dob = String(dob).trim();
    if (package_amount != null) {
      const pkg = Number(package_amount);
      if (!VALID_PACKAGES.includes(pkg)) {
        return res.status(400).json({ error: 'Invalid package amount' });
      }
      updates.package_amount = pkg;
    }
    if (wallet_address !== undefined) {
      const wa = wallet_address == null || String(wallet_address).trim() === ''
        ? null
        : String(wallet_address).trim();
      if (wa && !/^0x[a-fA-F0-9]{40}$/.test(wa)) {
        return res.status(400).json({ error: 'Wallet address must be a valid 0x address or empty' });
      }
      updates.wallet_address = wa;
    }
    if (plan_topup_count != null && plan_topup_count !== '') {
      const n = parseInt(plan_topup_count, 10);
      if (!Number.isFinite(n) || n < 0 || n > 255) {
        return res.status(400).json({ error: 'Plan top-up count must be 0–255' });
      }
      updates.plan_topup_count = n;
    }

    let resolvedSponsorId = undefined;
    if (sponsor_referral_code !== undefined) {
      const code = normalizeMemberIdInput(sponsor_referral_code);
      if (!code) {
        resolvedSponsorId = null;
      } else {
        const [sp] = await db.query('SELECT id FROM members WHERE UPPER(referral_code) = ?', [code]);
        if (!sp.length) return res.status(400).json({ error: 'Sponsor Member ID not found' });
        if (sp[0].id === Number(id)) return res.status(400).json({ error: 'Member cannot sponsor themselves' });
        resolvedSponsorId = sp[0].id;
      }
    } else if (sponsor_id !== undefined) {
      if (sponsor_id == null || sponsor_id === '') {
        resolvedSponsorId = null;
      } else {
        const sid = Number(sponsor_id);
        if (!Number.isFinite(sid)) return res.status(400).json({ error: 'Invalid sponsor ID' });
        if (sid === Number(id)) return res.status(400).json({ error: 'Member cannot sponsor themselves' });
        const [sp] = await db.query('SELECT id FROM members WHERE id = ?', [sid]);
        if (!sp.length) return res.status(400).json({ error: 'Sponsor member not found' });
        resolvedSponsorId = sid;
      }
    }
    if (resolvedSponsorId !== undefined) updates.sponsor_id = resolvedSponsorId;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db.query(`UPDATE members SET ${sets} WHERE id = ?`, [...Object.values(updates), id]);

    const [fresh] = await db.query(
      `SELECT m.*, s.name AS sponsor_name FROM members m LEFT JOIN members s ON m.sponsor_id = s.id WHERE m.id = ?`,
      [id],
    );
    res.json({
      message: 'Member updated',
      member: { ...omitPassword(fresh[0]), password_info: memberPasswordInfo(fresh[0]) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Admin: set member password (returns plain password once so admin can share with member). */
exports.adminSetMemberPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { new_password } = req.body;
    if (new_password == null || String(new_password).length < 6) {
      return res.status(400).json({ error: 'new_password required (min 6 characters)' });
    }
    const plain = String(new_password);
    const [rows] = await db.query('SELECT id FROM members WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });

    const password_hash = await bcrypt.hash(plain, 10);
    await db.query('UPDATE members SET password = ? WHERE id = ?', [password_hash, id]);
    res.json({
      message: 'Password updated',
      password: plain,
      password_info: { has_password: true, login_hint: 'Password set (encrypted — original cannot be read)' },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: Give salary to member
exports.giveSalary = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { member_id, amount, month_year, remark } = req.body;

    if (!member_id || amount == null || amount === '' || !month_year) {
      await conn.rollback();
      return res.status(400).json({ error: 'member_id, amount and month_year are required' });
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'amount must be greater than 0' });
    }

    // Idempotency: never credit salary twice for the same member + month.
    // FOR UPDATE serializes concurrent / double-click submissions.
    const [dup] = await conn.query(
      `SELECT id FROM salary_records WHERE member_id = ? AND month_year = ? LIMIT 1 FOR UPDATE`,
      [member_id, month_year]
    );
    if (dup.length) {
      await conn.rollback();
      return res.status(400).json({
        error: `Salary for ${month_year} is already credited to this member. Duplicate salary is not allowed.`,
      });
    }

    const [result] = await conn.query(
      `INSERT INTO salary_records (member_id,amount,month_year,remark,created_by) VALUES (?,?,?,?,?)`,
      [member_id, amt, month_year, remark, req.user.id]
    );

    const [m] = await conn.query('SELECT name FROM members WHERE id = ?', [member_id]);
    await recordTransaction(conn, {
      member_id: Number(member_id),
      income_type: 'salary_income',
      amount: amt,
      description: `Salary for ${month_year}${remark ? ' - ' + remark : ''}`,
      reference_id: result.insertId,
      reference_type: 'salary',
      dedup_key: `salary_income|m${Number(member_id)}|${month_year}`
    });

    await conn.commit();
    res.json({ message: 'Salary credited to salary wallet' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
};

// Admin: Give reward to member
exports.giveReward = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { member_id, reward_title, reward_description, reward_value, reward_type } = req.body;

    const [result] = await conn.query(
      `INSERT INTO reward_records (member_id,reward_title,reward_description,reward_value,reward_type,created_by)
       VALUES (?,?,?,?,?,?)`,
      [member_id, reward_title, reward_description, reward_value || 0, reward_type || 'gift', req.user.id]
    );

    // Only credit cash to wallet if reward has cash value
    if (Number(reward_value) > 0) {
      await recordTransaction(conn, {
        member_id: Number(member_id),
        income_type: 'reward_income',
        amount: Number(reward_value),
        description: `Reward: ${reward_title}${reward_description ? ' - ' + reward_description : ''}`,
        reference_id: result.insertId,
        reference_type: 'reward',
        dedup_key: `reward_income|rec${result.insertId}`
      });
    } else {
      // Just update reward_income count (non-cash gifts tracked separately)
      await conn.query(`UPDATE members SET total_reward_income = total_reward_income + 0 WHERE id = ?`, [member_id]);
    }

    await conn.commit();
    res.json({ message: 'Reward assigned to member' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
};

// Admin: Add trading wallet funds
exports.addTradingWallet = async (req, res) => {
  try {
    const { member_id, amount } = req.body;
    await db.query('UPDATE members SET trading_wallet = trading_wallet + ? WHERE id = ?', [amount, member_id]);
    res.json({ message: 'Trading wallet funded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** YYYY-MM-DD filter on member registration created_at (Asia/Kolkata calendar day). */
function addIstMemberDateFilters(conds, params, dateFrom, dateTo) {
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom))) {
    conds.push(`DATE(CONVERT_TZ(m.created_at, '+00:00', '+05:30')) >= ?`);
    params.push(String(dateFrom));
  }
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) {
    conds.push(`DATE(CONVERT_TZ(m.created_at, '+00:00', '+05:30')) <= ?`);
    params.push(String(dateTo));
  }
}

/** YYYY-MM-DD filter on payment created_at (Asia/Kolkata calendar day). */
function addIstPaymentDateFilters(conds, params, dateFrom, dateTo) {
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom))) {
    conds.push(`DATE(CONVERT_TZ(p.created_at, '+00:00', '+05:30')) >= ?`);
    params.push(String(dateFrom));
  }
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) {
    conds.push(`DATE(CONVERT_TZ(p.created_at, '+00:00', '+05:30')) <= ?`);
    params.push(String(dateTo));
  }
}

/** YYYY-MM-DD filter on credit time (Asia/Kolkata calendar day). */
function addIstDateFilters(conds, params, dateFrom, dateTo) {
  if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(String(dateFrom))) {
    conds.push(`DATE(CONVERT_TZ(t.created_at, '+00:00', '+05:30')) >= ?`);
    params.push(String(dateFrom));
  }
  if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(String(dateTo))) {
    conds.push(`DATE(CONVERT_TZ(t.created_at, '+00:00', '+05:30')) <= ?`);
    params.push(String(dateTo));
  }
}

const TXN_EXPORT_MAX = 25000;
const TXN_PAGE_MAX = 200;

// Admin: Get all transactions (global report) — date filter IST, pagination, export=all rows in range
exports.getAllTransactions = async (req, res) => {
  try {
    const {
      income_type,
      wallet_type,
      member_id,
      date_from,
      date_to,
      page = 1,
      limit = 50,
      export: exportRaw,
    } = req.query;
    const exportMode = ['1', 'true', 'yes'].includes(String(exportRaw || '').toLowerCase());
    const conds = [];
    const params = [];
    if (income_type) {
      conds.push('t.income_type = ?');
      params.push(income_type);
    }
    if (wallet_type) {
      conds.push('t.wallet_type = ?');
      params.push(wallet_type);
    }
    if (member_id) {
      conds.push('t.member_id = ?');
      params.push(Number(member_id));
    }
    addIstDateFilters(conds, params, date_from, date_to);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [countRows] = await db.query(`SELECT COUNT(*) as total FROM transactions t ${where}`, params);
    const total = Number(countRows[0]?.total ?? 0);

    let lim;
    let offset;
    if (exportMode) {
      lim = Math.min(TXN_EXPORT_MAX, Math.max(0, total));
      offset = 0;
    } else {
      lim = Math.min(TXN_PAGE_MAX, Math.max(1, Number(limit) || 50));
      const pg = Math.max(1, Number(page) || 1);
      offset = (pg - 1) * lim;
    }

    const [txns] = await db.query(
      `SELECT t.*, m.name as member_name, m.email as member_email, fm.name as from_name
       FROM transactions t
       JOIN members m ON t.member_id = m.id
       LEFT JOIN members fm ON t.from_member_id = fm.id
       ${where}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    const [summary] = await db.query(
      `SELECT income_type, wallet_type, SUM(amount) as total, COUNT(*) as count
       FROM transactions t ${where} GROUP BY income_type, wallet_type`,
      params
    );
    res.json({
      transactions: txns,
      total,
      summary,
      page: exportMode ? 1 : Math.max(1, Number(page) || 1),
      limit: lim,
      exportMode: Boolean(exportMode),
      exportTruncated: exportMode && total > TXN_EXPORT_MAX,
      exportMax: TXN_EXPORT_MAX,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Member: own transactions only — same filters & pagination
exports.getMyTransactions = async (req, res) => {
  try {
    const memberId = req.user?.id;
    if (!memberId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      income_type,
      wallet_type,
      date_from,
      date_to,
      page = 1,
      limit = 50,
      export: exportRaw,
    } = req.query;
    const exportMode = ['1', 'true', 'yes'].includes(String(exportRaw || '').toLowerCase());
    const conds = ['t.member_id = ?'];
    const params = [memberId];
    if (income_type) {
      conds.push('t.income_type = ?');
      params.push(income_type);
    }
    if (wallet_type) {
      conds.push('t.wallet_type = ?');
      params.push(wallet_type);
    }
    addIstDateFilters(conds, params, date_from, date_to);
    const where = `WHERE ${conds.join(' AND ')}`;

    const [countRows] = await db.query(`SELECT COUNT(*) as total FROM transactions t ${where}`, params);
    const total = Number(countRows[0]?.total ?? 0);

    let lim;
    let offset;
    if (exportMode) {
      lim = Math.min(TXN_EXPORT_MAX, Math.max(0, total));
      offset = 0;
    } else {
      lim = Math.min(TXN_PAGE_MAX, Math.max(1, Number(limit) || 50));
      const pg = Math.max(1, Number(page) || 1);
      offset = (pg - 1) * lim;
    }

    const [txns] = await db.query(
      `SELECT t.*, fm.name as from_name
       FROM transactions t
       LEFT JOIN members fm ON t.from_member_id = fm.id
       ${where}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );
    const [summary] = await db.query(
      `SELECT income_type, wallet_type, SUM(amount) as total, COUNT(*) as count
       FROM transactions t ${where} GROUP BY income_type, wallet_type`,
      params
    );
    res.json({
      transactions: txns,
      total,
      summary,
      page: exportMode ? 1 : Math.max(1, Number(page) || 1),
      limit: lim,
      exportMode: Boolean(exportMode),
      exportTruncated: exportMode && total > TXN_EXPORT_MAX,
      exportMax: TXN_EXPORT_MAX,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: Dashboard stats
exports.getAdminStats = async (req, res) => {
  try {
    const [[totalMembers]] = await db.query('SELECT COUNT(*) as count FROM members WHERE status="active"');
    const [[pendingMembers]] = await db.query(
      `SELECT COUNT(*) as count FROM members m
       WHERE m.status='pending' AND ${SQL_HAS_REGISTRATION_PAYMENT}`
    );
    const [[unpaidRegistrations]] = await db.query(
      `SELECT COUNT(*) as count FROM members m
       WHERE m.status='pending' AND ${SQL_NO_REGISTRATION_PAYMENT}`
    );
    const [[totalBusiness]] = await db.query('SELECT SUM(package_amount) as total FROM members WHERE status="active"');
    const [[pendingPayments]] = await db.query(
      `SELECT COUNT(*) as count FROM payments p
       INNER JOIN members m ON m.id = p.member_id
       WHERE p.status='pending' AND (
         (m.status='pending' AND (p.payment_for IS NULL OR p.payment_for = 'registration'))
         OR (m.status='active' AND p.payment_for IN ('plan_topup', 'trading_topup'))
       )`
    );
    const [[todayRoi]] = await db.query(`SELECT SUM(amount) as total FROM transactions WHERE income_type='roi_income' AND DATE(created_at)=CURDATE()`);
    const [[activeTrades]] = await db.query(
      `SELECT COUNT(*) as count FROM day_trades
       WHERE deleted_at IS NULL AND status='active' AND trade_date = ?`,
      [getTodayIstYmd()],
    );
    const [incomeBreakdown] = await db.query(`SELECT income_type, SUM(amount) as total FROM transactions GROUP BY income_type`);

    res.json({
      totalMembers: totalMembers.count,
      pendingMembers: pendingMembers.count,
      unpaidRegistrations: unpaidRegistrations.count,
      totalBusiness: totalBusiness.total || 0,
      pendingPayments: pendingPayments.count,
      todayRoi: todayRoi.total || 0,
      activeTrades: activeTrades.count,
      incomeBreakdown
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get all rewards list (admin)
exports.getAllRewards = async (req, res) => {
  try {
    const [rewards] = await db.query(
      `SELECT r.*, m.name as member_name, m.email as member_email
       FROM reward_records r JOIN members m ON r.member_id = m.id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get all salaries (admin)
exports.getAllSalaries = async (req, res) => {
  try {
    const [salaries] = await db.query(
      `SELECT s.*, m.name as member_name, m.email as member_email
       FROM salary_records s JOIN members m ON s.member_id = m.id
       ORDER BY s.created_at DESC LIMIT 100`
    );
    res.json(salaries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: approve member-submitted plan TOP-UP payment (plan_topup_count +1).
exports.approvePlanTopupPayment = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const paymentId = Number(req.params.paymentId);
    if (!Number.isFinite(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: 'Invalid payment id' });
    }

    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT p.id AS payment_id, p.member_id, p.status, p.amount, p.payment_for,
              m.status AS member_status, m.plan_topup_count, m.package_amount
       FROM payments p
       INNER JOIN members m ON m.id = p.member_id
       WHERE p.id = ? FOR UPDATE`,
      [paymentId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Payment not found' });
    }
    const row = rows[0];
    if (row.payment_for !== 'plan_topup') {
      await conn.rollback();
      return res.status(400).json({ error: 'This is not a plan TOP-UP request' });
    }
    if (row.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ error: 'Payment has already been processed' });
    }
    if (row.member_status !== 'active') {
      await conn.rollback();
      return res.status(400).json({ error: 'Member is not active' });
    }

    const next = await computeNextPlanTopupPayment(row.plan_topup_count, row.package_amount);
    if (!next.ok) {
      await conn.rollback();
      return res.status(400).json({ error: next.message || 'Could not calculate retopup amount.' });
    }
    const expected = next.amount_due_usd;
    if (Math.abs(Number(row.amount) - expected) > 0.02) {
      await conn.rollback();
      return res.status(400).json({
        error: `Amount mismatch: payment $${Number(row.amount).toFixed(
          2
        )} vs expected on ladder now $${expected.toFixed(
          2
        )}. Reject and ask the member to submit again.`,
        expected_amount: expected,
      });
    }

    await conn.query(`UPDATE payments SET status = 'approved' WHERE id = ?`, [paymentId]);
    await conn.query(`UPDATE members SET plan_topup_count = plan_topup_count + 1 WHERE id = ?`, [
      row.member_id,
    ]);
    const newCount = Number(row.plan_topup_count) + 1;
    await addRetopupCycle(conn, row.member_id, newCount, Number(row.amount));
    await conn.commit();

    try {
      await syncOpenRoiParticipantSlotForMember(row.member_id);
    } catch (_) {
      /* ignore */
    }

    res.json({ message: 'Plan TOP-UP approved — ladder +1' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

// Admin: reject pending plan TOP-UP payment (no ladder change).
exports.rejectPlanTopupPayment = async (req, res) => {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!Number.isFinite(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: 'Invalid payment id' });
    }
    const [r] = await db.query(
      `UPDATE payments SET status = 'rejected'
       WHERE id = ? AND payment_for = 'plan_topup' AND status = 'pending'`,
      [paymentId]
    );
    if (!r.affectedRows) {
      return res.status(400).json({ error: 'Pending plan TOP-UP payment not found' });
    }
    res.json({ message: 'Plan TOP-UP payment rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: approve member-submitted trading wallet top-up (credit trading_wallet).
exports.approveTradingTopupPayment = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const paymentId = Number(req.params.paymentId);
    if (!Number.isFinite(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: 'Invalid payment id' });
    }

    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT p.id AS payment_id, p.member_id, p.status, p.amount, p.payment_for,
              m.status AS member_status, m.trading_wallet
       FROM payments p
       INNER JOIN members m ON m.id = p.member_id
       WHERE p.id = ? FOR UPDATE`,
      [paymentId]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Payment not found' });
    }
    const row = rows[0];
    if (row.payment_for !== 'trading_topup') {
      await conn.rollback();
      return res.status(400).json({ error: 'This is not a trading wallet top-up request' });
    }
    if (row.status !== 'pending') {
      await conn.rollback();
      return res.status(400).json({ error: 'Payment has already been processed' });
    }
    if (row.member_status !== 'active') {
      await conn.rollback();
      return res.status(400).json({ error: 'Member is not active' });
    }

    const amt = Number(row.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    await conn.query(`UPDATE payments SET status = 'approved' WHERE id = ?`, [paymentId]);
    await conn.query('UPDATE members SET trading_wallet = trading_wallet + ? WHERE id = ?', [amt, row.member_id]);
    await conn.commit();

    res.json({
      message: `Trading wallet credited: $${amt.toFixed(2)}`,
      new_trading_wallet: parseFloat((Number(row.trading_wallet) + amt).toFixed(4)),
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

// Admin: reject pending trading wallet top-up (no wallet credit).
exports.rejectTradingTopupPayment = async (req, res) => {
  try {
    const paymentId = Number(req.params.paymentId);
    if (!Number.isFinite(paymentId) || paymentId < 1) {
      return res.status(400).json({ error: 'Invalid payment id' });
    }
    const [r] = await db.query(
      `UPDATE payments SET status = 'rejected'
       WHERE id = ? AND payment_for = 'trading_topup' AND status = 'pending'`,
      [paymentId]
    );
    if (!r.affectedRows) {
      return res.status(400).json({ error: 'Pending trading wallet payment not found' });
    }
    res.json({ message: 'Trading wallet payment rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: paginated payment history (date filter IST, search, approve from list)
exports.getAdminPayments = async (req, res) => {
  try {
    const {
      status,
      payment_for: paymentForRaw,
      q,
      search,
      date_from,
      date_to,
      page = 1,
      limit = 25,
    } = req.query;

    const conds = [];
    const params = [];
    const rawQ = q != null && q !== '' ? q : search;
    const term = rawQ != null ? String(rawQ).trim() : '';

    if (status && ['pending', 'approved', 'rejected'].includes(String(status))) {
      conds.push('p.status = ?');
      params.push(status);
    }
    const pf = paymentForRaw != null ? String(paymentForRaw).trim() : '';
    if (pf === 'registration') {
      conds.push('(p.payment_for IS NULL OR p.payment_for = ?)');
      params.push('registration');
    } else if (pf === 'plan_topup' || pf === 'trading_topup') {
      conds.push('p.payment_for = ?');
      params.push(pf);
    }
    if (term) {
      const like = `%${term}%`;
      conds.push(
        '(m.name LIKE ? OR m.email LIKE ? OR m.contact LIKE ? OR CAST(p.id AS CHAR) LIKE ? OR p.transaction_id LIKE ? OR m.referral_code LIKE ?)'
      );
      params.push(like, like, like, like, like, like);
    }
    addIstPaymentDateFilters(conds, params, date_from, date_to);

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const lim = Math.min(100, Math.max(1, Number(limit) || 25));
    const pg = Math.max(1, Number(page) || 1);
    const offset = (pg - 1) * lim;

    const [payments] = await db.query(
      `SELECT p.id, p.member_id, p.payment_type, p.transaction_id, p.receipt_image,
              p.amount, p.remark, p.status, p.payment_for, p.created_at,
              m.name AS member_name, m.email AS member_email, m.contact AS member_contact,
              m.status AS member_status, m.referral_code AS member_referral_code,
              m.package_amount AS member_package_amount
       FROM payments p
       INNER JOIN members m ON m.id = p.member_id
       ${where}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lim, offset]
    );

    const [[countRow]] = await db.query(
      `SELECT COUNT(*) AS total FROM payments p INNER JOIN members m ON m.id = p.member_id ${where}`,
      params
    );

    const [[summary]] = await db.query(
      `SELECT
         COUNT(*) AS total_count,
         COALESCE(SUM(p.amount), 0) AS total_amount,
         SUM(CASE WHEN p.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) AS pending_amount,
         SUM(CASE WHEN p.status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
         COALESCE(SUM(CASE WHEN p.status = 'approved' THEN p.amount ELSE 0 END), 0) AS approved_amount,
         SUM(CASE WHEN p.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
       FROM payments p
       INNER JOIN members m ON m.id = p.member_id
       ${where}`,
      params
    );

    res.json({
      payments,
      total: countRow.total,
      page: pg,
      limit: lim,
      summary: {
        total_count: Number(summary.total_count) || 0,
        total_amount: Number(summary.total_amount) || 0,
        pending_count: Number(summary.pending_count) || 0,
        pending_amount: Number(summary.pending_amount) || 0,
        approved_count: Number(summary.approved_count) || 0,
        approved_amount: Number(summary.approved_amount) || 0,
        rejected_count: Number(summary.rejected_count) || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Admin: record one plan top-up (Trade ladder; cap = today's session slots − 1, else global max)
exports.incrementMemberPlanTopup = async (req, res) => {
  const conn = await db.getConnection();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid member id' });
    }
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT plan_topup_count, package_amount, status FROM members WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Member not found' });
    }
    if (rows[0].status !== 'active') {
      await conn.rollback();
      return res.status(400).json({ error: 'Only active members can receive plan top-ups' });
    }
    const c = Number(rows[0].plan_topup_count ?? 0);
    const next = await computeNextPlanTopupPayment(c, rows[0].package_amount);
    if (!next.ok) {
      await conn.rollback();
      return res.status(400).json({ error: next.message || 'Could not calculate retopup amount.' });
    }
    await conn.query('UPDATE members SET plan_topup_count = plan_topup_count + 1 WHERE id = ?', [id]);
    await addRetopupCycle(conn, id, c + 1, Number(rows[0].package_amount));
    await conn.commit();
    try {
      await syncOpenRoiParticipantSlotForMember(id);
    } catch (_) {
      /* trade session missing */
    }
    res.json({ message: 'Plan top-up recorded', plan_topup_count: c + 1, unlimited_retopup: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

