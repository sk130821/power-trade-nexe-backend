const db = require('../config/db');
const { getTodayIstYmd, getIstYmdDaysAgo, dayTradeSessionYmd, normalizeIstSessionYmd } = require('../utils/dayTradeIstWindow');

function liveTradeWinCalendarDay(row) {
  return dayTradeSessionYmd(row.invested_at) || normalizeIstSessionYmd(row.session_date_at_buy);
}

function liveTradeSettlementDay(row) {
  return (
    dayTradeSessionYmd(row.closed_at) ||
    dayTradeSessionYmd(row.credited_at) ||
    liveTradeWinCalendarDay(row)
  );
}

async function main() {
  const memberId = Number(process.argv[2] || 40);
  const todayIst = getTodayIstYmd();
  const yesterdayIst = getIstYmdDaysAgo(1);
  const winLookbackFrom = getIstYmdDaysAgo(3);
  const [raw] = await db.query(
    `SELECT dti.id, dti.day_trade_id, dti.invest_amount, dti.result_amount, dti.session_date_at_buy, dti.invested_at,
      COALESCE(dti.trade_name_at_buy, dt.trade_name) AS trade_name,
      COALESCE(dti.session_date_at_buy, dt.trade_date, DATE(dti.invested_at)) AS trade_date,
      dt.closed_at, t.created_at AS credited_at
     FROM day_trade_investments dti
     INNER JOIN day_trades dt ON dt.id = dti.day_trade_id AND dt.is_winner = 1
     LEFT JOIN transactions t ON t.member_id = dti.member_id AND t.income_type = 'trading_income'
       AND t.reference_type = 'day_trade' AND t.reference_id = dti.day_trade_id
       AND t.dedup_key = CONCAT('trading_income|dt', dti.day_trade_id, '|inv', dti.id)
     WHERE dti.member_id = ? AND dti.status = 'doubled'
       AND COALESCE(dt.closed_at, t.created_at, dti.invested_at) >= DATE_SUB(?, INTERVAL 2 DAY)
     ORDER BY dti.id DESC LIMIT 50`,
    [memberId, winLookbackFrom],
  );
  const withDay = (raw || []).map((r) => ({
    id: r.id,
    trade_name: r.trade_name,
    win_day: liveTradeWinCalendarDay(r),
    settle_day: liveTradeSettlementDay(r),
    invested: r.invested_at,
    closed: r.closed_at,
  }));
  const recent = withDay.filter((r) => {
    if (!r.win_day) return false;
    if (r.settle_day !== todayIst && r.settle_day !== yesterdayIst) return false;
    return r.win_day === todayIst || r.win_day === yesterdayIst;
  });
  const winDaysSet = new Set(recent.map((r) => r.win_day).filter(Boolean));
  let liveTradeWinDay = null;
  if (winDaysSet.has(todayIst)) liveTradeWinDay = todayIst;
  else if (winDaysSet.has(yesterdayIst)) liveTradeWinDay = yesterdayIst;
  const filtered = liveTradeWinDay ? recent.filter((r) => r.win_day === liveTradeWinDay) : [];
  console.log(JSON.stringify({
    todayIst,
    yesterdayIst,
    winLookbackFrom,
    rawCount: raw.length,
    winDays: [...winDaysSet],
    liveTradeWinDay,
    filteredCount: filtered.length,
    filtered,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});