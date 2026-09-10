async function fetchAllOpenCycles(conn, memberId) {
  const [rows] = await conn.query(
    `SELECT * FROM member_income_cycles
     WHERE member_id = ? AND cap_closed = 0
     ORDER BY cycle_level ASC`,
    [memberId],
  );
  return rows;
}

async function fetchOldestOpenCycle(conn, memberId) {
  const rows = await fetchAllOpenCycles(conn, memberId);
  return rows[0] || null;
}

module.exports = {
  fetchAllOpenCycles,
  fetchOldestOpenCycle,
};
