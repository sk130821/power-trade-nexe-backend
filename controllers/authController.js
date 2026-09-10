const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const path = require('path');
const fs = require('fs');
const { uploadDir } = require('../config/paths');
const { requestMemberPasswordReset, resetMemberPasswordWithToken } = require('../utils/passwordReset');
const { getRoiPercent } = require('../utils/roiPercent');

const PACKAGES = [11, 22, 51, 101, 201, 501, 1001];

function deleteUploadFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(uploadDir, String(filename)));
  } catch (_) {
    /* ignore missing file */
  }
}

function envTokenDecimals() {
  if (process.env.WEB3_TOKEN_DECIMALS != null && String(process.env.WEB3_TOKEN_DECIMALS).trim() !== '') {
    const d = parseInt(process.env.WEB3_TOKEN_DECIMALS, 10);
    return Number.isFinite(d) ? d : 18;
  }
  return 18;
}

function web3ConfigFromEnv() {
  const chainRaw = process.env.WEB3_CHAIN_ID;
  const chain_id = chainRaw != null && String(chainRaw).trim() !== '' ? parseInt(chainRaw, 10) : null;
  const token_decimals = envTokenDecimals();
  let native_usd_price = null;
  if (process.env.WEB3_NATIVE_USD_PRICE != null && String(process.env.WEB3_NATIVE_USD_PRICE).trim() !== '') {
    const p = parseFloat(process.env.WEB3_NATIVE_USD_PRICE);
    native_usd_price = Number.isFinite(p) ? p : null;
  }
  return {
    chain_id: Number.isFinite(chain_id) ? chain_id : null,
    payment_token: process.env.WEB3_PAYMENT_TOKEN || null,
    token_decimals: Number.isFinite(token_decimals) ? token_decimals : 18,
    native_usd_price,
  };
}

/** Parse admin / FormData body; empty strings → null (use .env fallback). */
function parseWeb3OverridesFromBody(body) {
  const chainRaw = body.web3_chain_id;
  let web3_chain_id = null;
  if (chainRaw != null && String(chainRaw).trim() !== '') {
    const n = parseInt(String(chainRaw).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error('Chain ID must be a positive number (e.g. 56 BSC, 137 Polygon)');
    }
    web3_chain_id = n;
  }

  let web3_payment_token = null;
  const tok = body.web3_payment_token;
  if (tok != null && String(tok).trim() !== '') {
    const t = String(tok).trim();
    if (!/^0x[a-fA-F0-9]{40}$/i.test(t)) {
      throw new Error('Payment token must be empty or a valid 0x contract address (e.g. USDC)');
    }
    web3_payment_token = t;
  }

  let web3_token_decimals = null;
  const dec = body.web3_token_decimals;
  if (dec != null && String(dec).trim() !== '') {
    const d = parseInt(String(dec).trim(), 10);
    if (!Number.isFinite(d) || d < 0 || d > 36) {
      throw new Error('Token decimals must be between 0 and 36');
    }
    web3_token_decimals = d;
  }

  let web3_native_usd_price = null;
  const nusd = body.web3_native_usd_price;
  if (nusd != null && String(nusd).trim() !== '') {
    const p = parseFloat(String(nusd).trim());
    if (!Number.isFinite(p) || p <= 0) {
      throw new Error('Native / USD price must be greater than 0 when set');
    }
    web3_native_usd_price = p;
  }

  return { web3_chain_id, web3_payment_token, web3_token_decimals, web3_native_usd_price };
}

exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM admins WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: admin.id, role: 'admin', email: admin.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: admin.id, email: admin.email, role: 'admin', username: admin.username } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.memberLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query('SELECT * FROM members WHERE email = ?', [email]);
    if (!rows.length) {
      const [admins] = await db.query('SELECT id FROM admins WHERE email = ?', [email]);
      if (admins.length) {
        return res.status(401).json({
          error: 'This email is an admin account. Use Admin Login (/admin/login), not Member Login.',
        });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const member = rows[0];
    if (member.status === 'rejected') {
      return res.status(401).json({
        error: 'Your registration was rejected. Please contact support.',
      });
    }

    const [regPay] = await db.query(
      `SELECT id, status FROM payments
       WHERE member_id = ? AND (payment_for IS NULL OR payment_for = 'registration')
       ORDER BY id DESC LIMIT 1`,
      [member.id]
    );
    const registrationPaymentPending = !regPay.length;

    let valid = false;
    if (member.password) {
      valid = await bcrypt.compare(password, member.password);
    } else {
      valid = member.aadhaar_no === password;
    }
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ id: member.id, role: 'member', email: member.email }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      token,
      user: {
        id: member.id,
        email: member.email,
        role: 'member',
        name: member.name,
        referral_code: member.referral_code,
        member_code: member.referral_code,
        wallet_address: member.wallet_address || null,
        status: member.status,
        member_status: member.status,
        package_amount: member.package_amount,
        registration_payment_pending: registrationPaymentPending,
        registration_payment_status: regPay[0]?.status || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getWeb3Config = async (req, res) => {
  try {
    const envCfg = web3ConfigFromEnv();
    const [rows] = await db.query(
      `SELECT web3_chain_id, web3_payment_token, web3_token_decimals, web3_native_usd_price
       FROM admins WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];

    const chain_id =
      row?.web3_chain_id != null && Number.isFinite(Number(row.web3_chain_id))
        ? Number(row.web3_chain_id)
        : envCfg.chain_id;

    const payment_token =
      row?.web3_payment_token != null && String(row.web3_payment_token).trim() !== ''
        ? String(row.web3_payment_token).trim()
        : envCfg.payment_token;

    let token_decimals = envCfg.token_decimals;
    if (row?.web3_token_decimals != null && String(row.web3_token_decimals).trim() !== '') {
      const d = parseInt(row.web3_token_decimals, 10);
      if (Number.isFinite(d)) token_decimals = d;
    }

    let native_usd_price = envCfg.native_usd_price;
    if (row?.web3_native_usd_price != null && row.web3_native_usd_price !== '') {
      const p = parseFloat(row.web3_native_usd_price);
      if (Number.isFinite(p)) native_usd_price = p;
    }

    const outChain = Number.isFinite(chain_id) ? chain_id : null
    const outTok = token_decimals
    const outNat = native_usd_price

    res.json({
      chain_id: outChain,
      payment_token: payment_token || null,
      token_decimals: Number.isFinite(outTok) ? outTok : 18,
      native_usd_price:
        outNat != null && Number.isFinite(outNat) ? Number(outNat) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAdminSettings = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT metamask_address, metamask_qr_image, cod_details,
        web3_chain_id, web3_payment_token, web3_token_decimals, web3_native_usd_price
       FROM admins WHERE id = 1`,
    );
    res.json(rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAdminLoginPopup = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT login_popup_video, login_popup_image FROM admins WHERE id = 1`,
    );
    const row = rows[0] || {};
    res.json({
      video: row.login_popup_video || null,
      image: row.login_popup_image || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateLoginPopupVideo = async (req, res) => {
  try {
    const [oldRows] = await db.query(
      `SELECT login_popup_video FROM admins WHERE id = ?`,
      [req.user.id],
    );
    const prev = oldRows[0]?.login_popup_video;

    let next = prev;
    if (req.files?.login_popup_video?.[0]) {
      deleteUploadFile(prev);
      next = req.files.login_popup_video[0].filename;
    } else if (req.body.remove === '1' || req.body.remove === 'true') {
      deleteUploadFile(prev);
      next = null;
    }

    await db.query(`UPDATE admins SET login_popup_video = ? WHERE id = ?`, [next ?? null, req.user.id]);
    res.json({ message: 'Login video saved', video: next ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateLoginPopupImage = async (req, res) => {
  try {
    const [oldRows] = await db.query(
      `SELECT login_popup_image FROM admins WHERE id = ?`,
      [req.user.id],
    );
    const prev = oldRows[0]?.login_popup_image;

    let next = prev;
    if (req.files?.login_popup_image?.[0]) {
      deleteUploadFile(prev);
      next = req.files.login_popup_image[0].filename;
    } else if (req.body.remove === '1' || req.body.remove === 'true') {
      deleteUploadFile(prev);
      next = null;
    }

    await db.query(`UPDATE admins SET login_popup_image = ? WHERE id = ?`, [next ?? null, req.user.id]);
    res.json({ message: 'Login image saved', image: next ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMemberLoginPopups = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT login_popup_video, login_popup_image FROM admins WHERE id = 1`,
    );
    const row = rows[0] || {};
    res.json({
      video: row.login_popup_video || null,
      image: row.login_popup_image || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateAdminSettings = async (req, res) => {
  try {
    const hasWeb3Fields =
      req.body.web3_chain_id !== undefined ||
      req.body.web3_payment_token !== undefined ||
      req.body.web3_token_decimals !== undefined ||
      req.body.web3_native_usd_price !== undefined;

    if (hasWeb3Fields) {
      const w3 = parseWeb3OverridesFromBody(req.body);
      await db.query(
        `UPDATE admins SET web3_chain_id=?, web3_payment_token=?, web3_token_decimals=?, web3_native_usd_price=? WHERE id=1`,
        [w3.web3_chain_id, w3.web3_payment_token, w3.web3_token_decimals, w3.web3_native_usd_price],
      );
    }

    const [oldRows] = await db.query(
      `SELECT metamask_qr_image FROM admins WHERE id = ?`,
      [req.user.id],
    );
    const prev = oldRows[0] || {};

    const metamask_address = req.body.metamask_address;
    const cod_details = req.body.cod_details;
    let metamask_qr_image = prev.metamask_qr_image;

    if (req.files?.metamask_qr?.[0]) {
      deleteUploadFile(prev.metamask_qr_image);
      metamask_qr_image = req.files.metamask_qr[0].filename;
    }

    await db.query(
      `UPDATE admins SET metamask_address = ?, cod_details = ?, metamask_qr_image = ? WHERE id = ?`,
      [metamask_address ?? null, cod_details ?? null, metamask_qr_image ?? null, req.user.id],
    );
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getPackages = (req, res) => {
  const packages = PACKAGES.map((amount) => ({
    amount,
    roi_percent: getRoiPercent(amount),
  }));
  res.json(packages);
};

exports.memberForgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const result = await requestMemberPasswordReset(email);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json({ message: result.message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.memberResetPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body;
    const result = await resetMemberPasswordWithToken(token, new_password);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    res.json({ message: result.message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/** Admin: issue member JWT without password (impersonation). */
exports.adminImpersonateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM members WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const member = rows[0];
    if (member.status === 'rejected') {
      return res.status(400).json({ error: 'Cannot login as a rejected/blocked member' });
    }
    const [regPay] = await db.query(
      `SELECT id, status FROM payments
       WHERE member_id = ? AND (payment_for IS NULL OR payment_for = 'registration')
       ORDER BY id DESC LIMIT 1`,
      [member.id]
    );
    const token = jwt.sign(
      { id: member.id, role: 'member', email: member.email, impersonated_by: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '4h' },
    );
    res.json({
      token,
      user: {
        id: member.id,
        email: member.email,
        role: 'member',
        name: member.name,
        referral_code: member.referral_code,
        member_code: member.referral_code,
        wallet_address: member.wallet_address || null,
        impersonated: true,
        status: member.status,
        member_status: member.status,
        package_amount: member.package_amount,
        registration_payment_pending: !regPay.length,
        registration_payment_status: regPay[0]?.status || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
