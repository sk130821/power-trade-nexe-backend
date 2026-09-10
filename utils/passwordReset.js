const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { sendMail } = require('./mail');
const {
  brandedEmail,
  emailHeading,
  emailParagraph,
  emailGreeting,
  emailButton,
  emailSmallPrint,
  escapeHtml,
} = require('./emailTemplate');

const { frontendBaseUrl } = require('../config/site');

const TOKEN_BYTES = 32;
const EXPIRY_HOURS = 1;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function createAndSendMemberReset(member) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 60 * 60 * 1000);

  await db.query(
    `UPDATE password_reset_tokens SET used_at = NOW()
     WHERE member_id = ? AND used_at IS NULL`,
    [member.id]
  );

  await db.query(
    `INSERT INTO password_reset_tokens (member_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [member.id, tokenHash, expiresAt]
  );

  const resetUrl = `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const name = member.name || 'Member';

  const bodyHtml = `
    ${emailHeading('Reset your password')}
    ${emailGreeting(name)}
    ${emailParagraph('We received a request to reset your <strong>Power Trade Nexus</strong> member account password. Click the button below to choose a new password.')}
    ${emailButton(resetUrl, 'Reset password')}
    ${emailParagraph(`This link expires in <strong>${EXPIRY_HOURS} hour</strong>.`, { small: true })}
    ${emailSmallPrint(`Or copy this link into your browser:<br /><span style="word-break:break-all;color:#666;">${escapeHtml(resetUrl)}</span>`)}
    ${emailSmallPrint('If you did not request a password reset, ignore this email — your password will remain unchanged.')}
  `;

  await sendMail({
    to: member.email,
    subject: 'Reset your Power Trade Nexus password',
    html: brandedEmail({
      title: 'Password reset',
      preheader: 'Reset your member account password',
      bodyHtml,
    }),
  });
}

async function requestMemberPasswordReset(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) {
    return { ok: false, status: 400, error: 'Email is required' };
  }

  const [rows] = await db.query(
    `SELECT id, name, email, status FROM members WHERE LOWER(email) = ? LIMIT 1`,
    [normalized]
  );

  if (rows.length && rows[0].status === 'active') {
    try {
      await createAndSendMemberReset(rows[0]);
    } catch (err) {
      console.error('[mail] Password reset send failed:', err.message);
      return {
        ok: false,
        status: 503,
        error: 'Could not send reset email. Please try again later or contact support.',
      };
    }
  }

  return {
    ok: true,
    message:
      'If an active account exists for this email, you will receive a password reset link shortly.',
  };
}

async function resetMemberPasswordWithToken(token, newPassword) {
  const raw = String(token || '').trim();
  const pw = String(newPassword || '');
  if (!raw) return { ok: false, status: 400, error: 'Reset token is required' };
  if (pw.length < 6) {
    return { ok: false, status: 400, error: 'Password must be at least 6 characters' };
  }

  const tokenHash = hashToken(raw);
  const [rows] = await db.query(
    `SELECT prt.id AS prt_id, prt.member_id, prt.expires_at, prt.used_at, m.status
     FROM password_reset_tokens prt
     INNER JOIN members m ON m.id = prt.member_id
     WHERE prt.token_hash = ?
     ORDER BY prt.id DESC LIMIT 1`,
    [tokenHash]
  );

  if (!rows.length) {
    return { ok: false, status: 400, error: 'Invalid or expired reset link' };
  }
  const row = rows[0];
  if (row.used_at) {
    return { ok: false, status: 400, error: 'This reset link was already used' };
  }
  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, status: 400, error: 'Reset link has expired — request a new one' };
  }
  if (row.status !== 'active') {
    return { ok: false, status: 400, error: 'Account is not active' };
  }

  const hashed = await bcrypt.hash(pw, 10);
  await db.query('UPDATE members SET password = ? WHERE id = ?', [hashed, row.member_id]);
  await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [row.prt_id]);

  return { ok: true, message: 'Password updated. You can sign in with your new password.' };
}

module.exports = { requestMemberPasswordReset, resetMemberPasswordWithToken };
