/**
 * Daily Growth Income: sponsor earns a fixed amount when two directs with the
 * same package amount activate on the same IST day between 8 AM and 8 PM.
 */
const { recordTransaction } = require('./transaction');

/** Fixed daily bonus per package tier (USD). */
const DAILY_BONUS_BY_PACKAGE = {
  11: 1,
  22: 2,
  51: 5,
  101: 10,
  201: 20,
  501: 50,
  1001: 100,
};

function getDailyBonusAmount(packageAmount) {
  const pkg = Number(packageAmount);
  if (!Number.isFinite(pkg)) return null;
  const bonus = DAILY_BONUS_BY_PACKAGE[pkg];
  return bonus != null ? Number(bonus) : null;
}
const IST_TZ = 'Asia/Kolkata';
const WINDOW_START = '08:00:00';
const WINDOW_END = '20:00:00';
const WINDOW_LABEL = '8 AM – 8 PM India Time (IST)';

function getIstDateTimeParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    timeStr: `${hour}:${get('minute')}:${get('second')}`,
  };
}

function isWithinDailyBonusWindow(date) {
  const { timeStr } = getIstDateTimeParts(date);
  return timeStr >= WINDOW_START && timeStr <= WINDOW_END;
}

function istDailyWindowBounds(date) {
  const { dateStr } = getIstDateTimeParts(date);
  return {
    dateStr,
    windowStart: new Date(`${dateStr}T08:00:00+05:30`),
    windowEnd: new Date(`${dateStr}T20:00:00+05:30`),
  };
}

async function setMemberActivatedAt(conn, memberId, activatedAt = new Date()) {
  await conn.query(
    'UPDATE members SET activated_at = ? WHERE id = ?',
    [activatedAt, memberId],
  );
  return activatedAt;
}

async function findUnpairedPartner(conn, sponsorId, newMemberId, packageAmount, activatedAt) {
  if (!isWithinDailyBonusWindow(activatedAt)) return null;

  const { windowStart, windowEnd } = istDailyWindowBounds(activatedAt);
  const [rows] = await conn.query(
    `SELECT m.id, m.activated_at
     FROM members m
     WHERE m.sponsor_id = ? AND m.status = 'active' AND m.id != ?
       AND m.package_amount = ?
       AND m.activated_at IS NOT NULL
       AND m.activated_at >= ? AND m.activated_at <= ?
       AND m.id NOT IN (
         SELECT member_a_id FROM daily_bonus_pairs WHERE sponsor_id = ?
         UNION
         SELECT member_b_id FROM daily_bonus_pairs WHERE sponsor_id = ?
       )
     ORDER BY m.activated_at ASC
     LIMIT 1`,
    [sponsorId, newMemberId, packageAmount, windowStart, windowEnd, sponsorId, sponsorId],
  );
  return rows[0] || null;
}

/**
 * Call when a member is newly activated. Pairs with an earlier unmatched direct
 * (same package, same IST day 8 AM–8 PM) and credits sponsor the fixed tier bonus.
 */
async function processDailyBonusOnActivation(conn, memberId) {
  const activatedAt = await setMemberActivatedAt(conn, memberId);

  const [[member]] = await conn.query(
    'SELECT id, sponsor_id, package_amount, status FROM members WHERE id = ?',
    [memberId],
  );
  if (!member || member.status !== 'active' || !member.sponsor_id) return null;

  if (!isWithinDailyBonusWindow(activatedAt)) return null;

  const sponsorId = member.sponsor_id;
  const packageAmount = Number(member.package_amount);
  if (!Number.isFinite(packageAmount) || packageAmount <= 0) return null;

  const partner = await findUnpairedPartner(conn, sponsorId, memberId, packageAmount, activatedAt);
  if (!partner) return null;

  const bonusAmount = getDailyBonusAmount(packageAmount);
  if (bonusAmount == null || bonusAmount <= 0) return null;

  const pairKey = `daily_bonus|${Math.min(partner.id, memberId)}|${Math.max(partner.id, memberId)}`;
  const txnId = await recordTransaction(conn, {
    member_id: sponsorId,
    income_type: 'daily_bonus_income',
    amount: bonusAmount,
    description: `Daily Growth — 2 matched directs ($${packageAmount}) · ${WINDOW_LABEL} · $${bonusAmount}`,
    reference_id: memberId,
    reference_type: 'daily_bonus',
    from_member_id: memberId,
    dedup_key: pairKey,
  });
  if (!txnId) return null;

  await conn.query(
    `INSERT INTO daily_bonus_pairs
     (sponsor_id, member_a_id, member_b_id, package_amount, bonus_amount, txn_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sponsorId, partner.id, memberId, packageAmount, bonusAmount, txnId],
  );

  return { txnId, sponsorId, partnerId: partner.id, bonusAmount, packageAmount };
}

module.exports = {
  DAILY_BONUS_BY_PACKAGE,
  getDailyBonusAmount,
  WINDOW_LABEL,
  WINDOW_START,
  WINDOW_END,
  isWithinDailyBonusWindow,
  processDailyBonusOnActivation,
};
