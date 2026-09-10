/** Level N Trade income requires at least N active direct referrals (L3 → 3 directs). */

async function countActiveDirectReferrals(conn, memberId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS c FROM members WHERE sponsor_id = ? AND status = 'active'`,
    [memberId]
  );
  return Number(row?.c || 0);
}

/** levelIndex 0 = L1 → needs 1 direct. */
function directsRequiredForLevelIndex(levelIndex) {
  return levelIndex + 1;
}

async function memberQualifiesForLevelIncome(conn, memberId, levelIndex, cache) {
  const required = directsRequiredForLevelIndex(levelIndex);
  let count;
  if (cache && cache.has(memberId)) {
    count = cache.get(memberId);
  } else {
    count = await countActiveDirectReferrals(conn, memberId);
    if (cache) cache.set(memberId, count);
  }
  return count >= required;
}

module.exports = {
  countActiveDirectReferrals,
  directsRequiredForLevelIndex,
  memberQualifiesForLevelIncome,
};
