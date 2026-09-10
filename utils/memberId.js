const crypto = require('crypto');
const db = require('../config/db');

const PREFIX = 'PTN';
const SUFFIX_LENGTH = 8;
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomSuffix() {
  const bytes = crypto.randomBytes(SUFFIX_LENGTH);
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

/** Public member ID, e.g. PTN0JHG5662 */
function formatMemberId(suffix) {
  return `${PREFIX}${suffix}`;
}

function normalizeMemberIdInput(raw) {
  if (raw == null) return '';
  return String(raw).trim().toUpperCase();
}

function isValidMemberIdFormat(code) {
  return new RegExp(`^${PREFIX}[0-9A-Z]{${SUFFIX_LENGTH}}$`).test(normalizeMemberIdInput(code));
}

async function generateUniqueMemberId(conn) {
  const q = conn && typeof conn.query === 'function' ? conn : db;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = formatMemberId(randomSuffix());
    const [rows] = await q.query('SELECT id FROM members WHERE referral_code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not generate unique member ID');
}

module.exports = {
  PREFIX,
  SUFFIX_LENGTH,
  formatMemberId,
  normalizeMemberIdInput,
  isValidMemberIdFormat,
  generateUniqueMemberId,
};
