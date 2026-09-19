const crypto = require('crypto');
const db = require('../config/db');
const { sendMail } = require('./mail');
const { isSmtpDebug, smtpDebug, isSmtpDryRun, shouldExposeDevOtpInApi } = require('./mailDebug');
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

function useBrandedOtpEmail() {
  const v = String(process.env.OTP_BRANDED_EMAIL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Minimal HTML — better Gmail deliverability than heavy branded templates + remote logo. */
function otpEmailSimpleHtml({ otp, purpose }) {
  const line =
    purpose === 'withdrawal'
      ? 'Enter this code on the withdrawal page to confirm your payout request.'
      : 'Enter this code on the registration page to verify your email.';
  return `<!DOCTYPE html>
<html lang="en"><body style="font-family:Arial,sans-serif;color:#111;line-height:1.5;">
<p>Power Trade Nexus verification code:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px;margin:16px 0;">${otp}</p>
<p>${line}</p>
<p style="color:#555;font-size:13px;">Valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.</p>
</body></html>`;
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

function otpMaxSendsPerHour() {
  const n = Number(process.env.OTP_MAX_SENDS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

/** cPanel often caps ~100 emails/hour per domain — stay below to avoid "Message discarded". */
async function checkHourlyOtpSendCap() {
  const max = otpMaxSendsPerHour();
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS c FROM email_otp_challenges
     WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
  );
  const count = Number(row?.c) || 0;
  if (count >= max) {
    return {
      blocked: true,
      error: `Too many OTP emails this hour (${count}/${max}). Hosting allows ~100/hour for the domain — wait until the next hour or use OTP shown in dev mode. Contact hosting to raise the limit if needed.`,
    };
  }
  return { blocked: false, count, max };
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
  smtpDebug('createEmailOtp called', {
    purpose,
    memberId,
    email: normalized || '(empty)',
    hasPayload: payload != null,
  });
  if (!normalized) {
    smtpDebug('createEmailOtp abort — no email on member/account');
    return { ok: false, status: 400, error: 'Email is required' };
  }
  if (!['registration', 'withdrawal'].includes(purpose)) {
    return { ok: false, status: 400, error: 'Invalid OTP purpose' };
  }

  const waitSec = await checkResendCooldown(normalized, purpose);
  if (waitSec) {
    smtpDebug('createEmailOtp cooldown', { waitSec, purpose, email: normalized });
    return { ok: false, status: 429, error: `Please wait ${waitSec} seconds before requesting a new OTP` };
  }

  const hourly = await checkHourlyOtpSendCap();
  if (hourly.blocked) {
    smtpDebug('createEmailOtp hourly cap', hourly);
    return { ok: false, status: 429, error: hourly.error };
  }

  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await invalidatePending(normalized, purpose);

  const [insertResult] = await db.query(
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
  const challengeId = insertResult?.insertId;
  smtpDebug('createEmailOtp DB row inserted', { challengeId, expiresAt: expiresAt.toISOString() });

  const subjects = {
    registration: 'Power Trade Nexus — Registration OTP',
    withdrawal: 'Power Trade Nexus — Withdrawal OTP',
  };

  const textBody = `Power Trade Nexus — Your verification code is: ${otp}\n\nValid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.`;
  const htmlBody = useBrandedOtpEmail()
    ? otpEmailHtml({ otp, purpose, name })
    : otpEmailSimpleHtml({ otp, purpose });

  try {
    if (isSmtpDryRun()) {
      smtpDebug('SMTP_DRY_RUN=1 — email not sent (OTP still valid in DB / dev_otp in API)');
      console.log(`[smtp][dry-run] purpose=${purpose} to=${normalized} otp=${otp}`);
    } else {
      const mailInfo = await sendMail({
        to: normalized,
        subject: subjects[purpose] || 'Your verification OTP',
        html: htmlBody,
        text: textBody,
        headers: {
          'X-Priority': '1',
          Importance: 'high',
        },
      });
      if (isSmtpDebug()) {
        console.log(
          `[smtp][otp-dev] purpose=${purpose} to=${normalized} otp=${otp} messageId=${mailInfo?.messageId || 'n/a'}`,
        );
      }
    }
  } catch (err) {
    console.error('[mail] OTP send failed:', err.message);
    if (challengeId) {
      try {
        await db.query('DELETE FROM email_otp_challenges WHERE id = ?', [challengeId]);
      } catch (delErr) {
        console.error('[mail] OTP rollback failed:', delErr.message);
      }
    }
    return {
      ok: false,
      status: 503,
      error: 'Could not send OTP email. Check SMTP settings or try again later.',
    };
  }

  const delivery_hint = isSmtpDryRun()
    ? 'SMTP dry run — use the dev OTP on screen (no email sent).'
    : 'If the email is not in Inbox within 2 minutes, check Spam, Promotions, and All Mail. Search for "Power Trade Nexus".';

  const sentLine = isSmtpDryRun()
    ? `OTP ready for ${normalized} (dry run, no email).`
    : `OTP sent to ${normalized}.`;

  return {
    ok: true,
    message: `${sentLine} Valid for ${OTP_EXPIRY_MINUTES} minutes. ${delivery_hint}`,
    expires_minutes: OTP_EXPIRY_MINUTES,
    delivery_hint,
    ...(shouldExposeDevOtpInApi() ? { dev_otp: otp } : {}),
  };
}

function buildOtpSuccessJson(result) {
  const body = {
    message: result.message,
    expires_minutes: result.expires_minutes,
  };
  if (result.delivery_hint) body.delivery_hint = result.delivery_hint;
  if (result.dev_otp) body.dev_otp = result.dev_otp;
  return body;
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
  buildOtpSuccessJson,
  OTP_EXPIRY_MINUTES,
};
