const crypto = require('crypto');
const db = require('../config/db');
const { sendMail } = require('./mail');
const {
  brandedEmail,
  emailHeading,
  emailParagraph,
  emailGreeting,
  emailOtpBox,
  emailInfoBox,
  emailSmallPrint,
} = require('./emailTemplate');

const OTP_EXPIRY_MINUTES = 15;
const RESEND_COOLDOWN_SEC = 60;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

function otpEmailHtml({ otp, purpose, name }) {
  const titles = {
    registration: 'Verify your email',
    withdrawal: 'Confirm your withdrawal',
  };
  const bodies = {
    registration:
      'Enter the verification code below on the registration page to confirm your email and complete your <strong>Power Trade Nexus</strong> member signup.',
    withdrawal:
      'Enter the code below on the withdrawal page to submit your payout request. If you did not request this, please ignore this email.',
  };
  const title = titles[purpose] || 'Verification code';
  const body = bodies[purpose] || 'Use this code to continue.';

  const bodyHtml = `
    ${emailHeading(title)}
    ${emailGreeting(name)}
    ${emailParagraph(body)}
    ${emailOtpBox(otp, OTP_EXPIRY_MINUTES)}
    ${emailInfoBox('<strong>Security tip:</strong> Never share this code with anyone. Our team will never ask for your OTP.')}
    ${emailSmallPrint('If you did not request this code, you can safely ignore this message.')}
  `;

  return brandedEmail({
    title,
    preheader: `Your verification code: ${otp}`,
    bodyHtml,
  });
}

async function invalidatePending(email, purpose) {
  await db.query(
    `UPDATE email_otp_challenges SET used_at = NOW()
     WHERE email = ? AND purpose = ? AND used_at IS NULL`,
    [normalizeEmail(email), purpose],
  );
}

async function checkResendCooldown(email, purpose) {
  const [rows] = await db.query(
    `SELECT created_at FROM email_otp_challenges
     WHERE email = ? AND purpose = ? AND used_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [normalizeEmail(email), purpose],
  );
  if (!rows.length) return null;
  const last = new Date(rows[0].created_at).getTime();
  const elapsed = (Date.now() - last) / 1000;
  if (elapsed < RESEND_COOLDOWN_SEC) {
    return Math.ceil(RESEND_COOLDOWN_SEC - elapsed);
  }
  return null;
}

async function createEmailOtp({ email, purpose, memberId = null, payload = null, name = null }) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return { ok: false, status: 400, error: 'Email is required' };
  }
  if (!['registration', 'withdrawal'].includes(purpose)) {
    return { ok: false, status: 400, error: 'Invalid OTP purpose' };
  }

  const waitSec = await checkResendCooldown(normalized, purpose);
  if (waitSec) {
    return { ok: false, status: 429, error: `Please wait ${waitSec} seconds before requesting a new OTP` };
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await invalidatePending(normalized, purpose);

  await db.query(
    `INSERT INTO email_otp_challenges (email, purpose, member_id, otp_hash, payload_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      normalized,
      purpose,
      memberId,
      otpHash,
      payload != null ? JSON.stringify(payload) : null,
      expiresAt,
    ],
  );

  const subjects = {
    registration: 'Power Trade Nexus — Registration OTP',
    withdrawal: 'Power Trade Nexus — Withdrawal OTP',
  };

  try {
    await sendMail({
      to: normalized,
      subject: subjects[purpose] || 'Your verification OTP',
      html: otpEmailHtml({ otp, purpose, name }),
      text: `Power Trade Nexus — Your verification code is: ${otp}\n\nValid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.`,
    });
  } catch (err) {
    console.error('[mail] OTP send failed:', err.message);
    return {
      ok: false,
      status: 503,
      error: 'Could not send OTP email. Check SMTP settings or try again later.',
    };
  }

  return {
    ok: true,
    message: `OTP sent to ${normalized}. Valid for ${OTP_EXPIRY_MINUTES} minutes.`,
    expires_minutes: OTP_EXPIRY_MINUTES,
  };
}

async function verifyEmailOtp({ email, otp, purpose, memberId = null }) {
  const normalized = normalizeEmail(email);
  const code = String(otp || '').trim();
  if (!normalized || !code) {
    return { ok: false, status: 400, error: 'Email and OTP are required' };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, status: 400, error: 'OTP must be a 6-digit code' };
  }

  const params = [normalizeEmail(email), purpose, hashOtp(code)];
  let sql = `SELECT id, member_id, payload_json, expires_at, used_at
     FROM email_otp_challenges
     WHERE email = ? AND purpose = ? AND otp_hash = ?
     ORDER BY id DESC LIMIT 1`;
  if (memberId != null) {
    sql = `SELECT id, member_id, payload_json, expires_at, used_at
     FROM email_otp_challenges
     WHERE email = ? AND purpose = ? AND otp_hash = ? AND member_id = ?
     ORDER BY id DESC LIMIT 1`;
    params.push(memberId);
  }

  const [rows] = await db.query(sql, params);
  if (!rows.length) {
    return { ok: false, status: 400, error: 'Invalid OTP' };
  }
  const row = rows[0];
  if (row.used_at) {
    return { ok: false, status: 400, error: 'OTP already used — request a new one' };
  }
  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, status: 400, error: 'OTP expired — request a new one' };
  }

  await db.query('UPDATE email_otp_challenges SET used_at = NOW() WHERE id = ?', [row.id]);

  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch (_) {
      payload = null;
    }
  }

  return { ok: true, challenge_id: row.id, payload, member_id: row.member_id };
}

module.exports = {
  createEmailOtp,
  verifyEmailOtp,
  OTP_EXPIRY_MINUTES,
};
