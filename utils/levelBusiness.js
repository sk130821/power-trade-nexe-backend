const { LEVEL_PERCENTS, MAX_NETWORK_LEVELS } = require('../config/levelIncome');

/** Per-level downline count & active plan volume (L1 = directs, L2+ = depth). */
async function buildLevelBusinessSummary(conn, memberId) {
  const [rows] = await conn.query(
    `WITH RECURSIVE downline AS (
       SELECT id, package_amount, status, 1 AS depth
       FROM members WHERE sponsor_id = ?
       UNION ALL
       SELECT m.id, m.package_amount, m.status, d.depth + 1
       FROM members m
       INNER JOIN downline d ON m.sponsor_id = d.id
       WHERE d.depth < ?
     )
     SELECT depth AS level,
            COUNT(*) AS member_count,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
            COALESCE(SUM(CASE WHEN status = 'active' THEN package_amount ELSE 0 END), 0) AS business_volume
     FROM downline
     GROUP BY depth
     ORDER BY depth ASC`,
    [memberId, MAX_NETWORK_LEVELS],
  );

  const byLevel = new Map(rows.map((r) => [Number(r.level), r]));
  const levels = [];
  let totalMembers = 0;
  let totalBusiness = 0;

  for (let L = 1; L <= MAX_NETWORK_LEVELS; L += 1) {
    const row = byLevel.get(L);
    const memberCount = Number(row?.member_count || 0);
    const activeCount = Number(row?.active_count || 0);
    const businessVolume = Number(row?.business_volume || 0);
    totalMembers += memberCount;
    totalBusiness += businessVolume;
    levels.push({
      level: L,
      level_percent: LEVEL_PERCENTS[L - 1],
      member_count: memberCount,
      active_count: activeCount,
      business_volume: businessVolume,
    });
  }

  return {
    levels,
    total_members: totalMembers,
    total_business: parseFloat(totalBusiness.toFixed(4)),
    max_levels: MAX_NETWORK_LEVELS,
  };
}

module.exports = { buildLevelBusinessSummary };
