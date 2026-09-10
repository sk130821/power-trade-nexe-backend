const db = require('../config/db');
const { recordTransaction } = require('../utils/transaction');
const { generateIntradayChart, enrichTradeChart } = require('../utils/dayTradeChart');
const { isDayTradeActivateAllowed, isDayTradeVisibleToMember, getTodayIstYmd, dayTradeSessionYmd } = require('../utils/dayTradeIstWindow');

exports.createDayTrade = async (req, res) => {
  try {
    const {
      trade_name, trade_symbol, description, min_invest,
      last_price, trade_price, open_price, day_high, day_low,
    } = req.body;

    const name = trade_name != null ? String(trade_name).trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Trade name is required' });
    }

    const priceRaw = trade_price != null && trade_price !== '' ? trade_price : last_price;
    const lp = priceRaw != null && priceRaw !== '' ? Number(priceRaw) : 0;
    if (!Number.isFinite(lp) || lp <= 0) {
      return res.status(400).json({ error: 'Trade price is required and must be > 0' });
    }

    const op = open_price != null && open_price !== '' ? Number(open_price) : lp;
    const dh = day_high != null && day_high !== '' ? Number(day_high) : null;
    const dl = day_low != null && day_low !== '' ? Number(day_low) : null;
    const chg = op ? parseFloat((((lp - op) / op) * 100).toFixed(4)) : 0;
    const chart = generateIntradayChart({ open: op, last: lp, high: dh, low: dl });
    const chart_json = JSON.stringify(chart);

    const minInv = min_invest != null && min_invest !== '' ? Number(min_invest) : 1;
    const minFinal = Number.isFinite(minInv) && minInv > 0 ? minInv : 1;

    const [result] = await db.query(
      `INSERT INTO day_trades (
        trade_name,trade_symbol,description,min_invest,
        last_price,open_price,day_high,day_low,change_pct,chart_json,
        trade_date,status,created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'inactive',?)`,
      [
        name,
        trade_symbol || null,
        description != null && String(description).trim() !== '' ? String(description).trim() : null,
        minFinal,
        lp,
        op,
        dh,
        dl,
        chg,
        chart_json,
        req.user.id,
      ]
    );
    res.json({ message: 'Live trade created', trade_id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateDayTrade = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const [[trade]] = await db.query('SELECT * FROM day_trades WHERE id=? AND deleted_at IS NULL', [id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status === 'active') {
      return res.status(400).json({ error: 'Mark inactive before editing. Member history keeps their purchase snapshot.' });
    }

    const {
      trade_name, trade_symbol, description, min_invest,
      last_price, trade_price, open_price, day_high, day_low,
    } = req.body;

    const name = trade_name != null ? String(trade_name).trim() : trade.trade_name;
    if (!name) {
      return res.status(400).json({ error: 'Trade name is required' });
    }

    const priceRaw = trade_price != null && trade_price !== '' ? trade_price : last_price;
    const lp = priceRaw != null && priceRaw !== '' ? Number(priceRaw) : Number(trade.last_price);
    if (!Number.isFinite(lp) || lp <= 0) {
      return res.status(400).json({ error: 'Trade price must be > 0' });
    }

    const op = open_price != null && open_price !== '' ? Number(open_price) : lp;
    const dh = day_high != null && day_high !== '' ? Number(day_high) : null;
    const dl = day_low != null && day_low !== '' ? Number(day_low) : null;
    const chg = op ? parseFloat((((lp - op) / op) * 100).toFixed(4)) : 0;
    const chart = generateIntradayChart({ open: op, last: lp, high: dh, low: dl });
    const chart_json = JSON.stringify(chart);

    const minInvMerge = min_invest != null && min_invest !== '' ? Number(min_invest) : Number(trade.min_invest);
    const minFinal = Number.isFinite(minInvMerge) && minInvMerge > 0 ? minInvMerge : 1;

    const sym = trade_symbol !== undefined ? (trade_symbol ? String(trade_symbol).trim() : null) : trade.trade_symbol;
    const desc = description !== undefined
      ? (description != null && String(description).trim() !== '' ? String(description).trim() : null)
      : trade.description;

    await db.query(
      `UPDATE day_trades SET
        trade_name=?, trade_symbol=?, description=?, min_invest=?,
        last_price=?, open_price=?, day_high=?, day_low=?, change_pct=?, chart_json=?
      WHERE id=?`,
      [name, sym, desc, minFinal, lp, op, dh, dl, chg, chart_json, id]
    );
    res.json({ message: 'Live trade updated. Past member purchases keep their original trade details.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteDayTrade = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const [[trade]] = await db.query('SELECT status, deleted_at FROM day_trades WHERE id=?', [id]);
    if (!trade || trade.deleted_at) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status === 'active') {
      return res.status(400).json({ error: 'Mark inactive before deleting. Member purchase history is preserved.' });
    }
    await db.query(
      `UPDATE day_trades SET deleted_at = NOW(), status = 'inactive', closed_at = COALESCE(closed_at, NOW()) WHERE id = ?`,
      [id],
    );
    res.json({ message: 'Trade removed from catalog. Member history and settlements are unchanged.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.activateDayTrade = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const [[trade]] = await db.query(
      'SELECT id, status, trade_date FROM day_trades WHERE id=? AND deleted_at IS NULL',
      [id],
    );
    if (!trade) return res.status(404).json({ error: 'Trade not found' });

    const todayIst = getTodayIstYmd();
    if (trade.status === 'active' && dayTradeSessionYmd(trade.trade_date) === todayIst) {
      return res.status(400).json({ error: 'This trade is already active for today.' });
    }

    if (!isDayTradeActivateAllowed()) {
      return res.status(400).json({ error: 'Activation is not available right now.' });
    }

    await db.query(
      `UPDATE day_trades SET
        status='active',
        trade_date=?,
        activated_at=NOW(),
        result='pending',
        is_winner=0,
        closed_at=NULL
       WHERE id=?`,
      [todayIst, id]
    );
    res.json({ message: 'Trade activated for today — visible to members from 9:00 AM IST.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deactivateDayTrade = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const [[trade]] = await db.query('SELECT id, status FROM day_trades WHERE id=?', [id]);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.status !== 'active') {
      return res.status(400).json({ error: 'Only active trades can be marked inactive.' });
    }

    await db.query(
      `UPDATE day_trades SET status='inactive', closed_at=NOW() WHERE id=?`,
      [id]
    );
    res.json({ message: 'Trade marked inactive — members can no longer buy this script.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.settleDayTrades = async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const rawWinners = req.body.winner_trade_ids ?? req.body.winner_trade_id;
    const winnerIds = new Set(
      (Array.isArray(rawWinners) ? rawWinners : rawWinners != null ? [rawWinners] : [])
        .map((id) => Number(id))
        .filter((n) => Number.isInteger(n) && n > 0),
    );
    if (!winnerIds.size) {
      await conn.rollback();
      return res.status(400).json({ error: 'Select at least one winning trade' });
    }

    // Lock all unsettled session trades — no 5 PM auto-close; admin settles when ready.
    const [activeTrades] = await conn.query(
      `SELECT * FROM day_trades
       WHERE deleted_at IS NULL
         AND result = 'pending'
         AND status IN ('active', 'inactive')
       FOR UPDATE`,
    );
    if (!activeTrades.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'No pending trades to settle — activate scripts first' });
    }

    const todayIds = new Set(activeTrades.map((t) => Number(t.id)));
    for (const id of winnerIds) {
      if (!todayIds.has(id)) {
        await conn.rollback();
        return res.status(400).json({
          error: `Trade #${id} is not in the pending session — pick winners from the settlement list`,
        });
      }
    }

    for (const trade of activeTrades) {
      const isWinner = winnerIds.has(Number(trade.id));
      const result = isWinner ? 'doubled' : 'zeroed';

      const [investments] = await conn.query(
        `SELECT * FROM day_trade_investments
         WHERE day_trade_id=? AND status='active'`,
        [trade.id],
      );

      for (const inv of investments) {
        if (isWinner) {
          const resultAmount = parseFloat((inv.invest_amount * 2).toFixed(4));
          const label = inv.trade_name_at_buy || trade.trade_name;
          await recordTransaction(conn, {
            member_id: inv.member_id,
            income_type: 'trading_income',
            amount: resultAmount,
            description: `Live Trade WINNER: ${label} | Invested: $${inv.invest_amount} → Returned: $${resultAmount}`,
            reference_id: trade.id,
            reference_type: 'day_trade',
            dedup_key: `trading_income|dt${trade.id}|inv${inv.id}`
          });
          await conn.query(
            `UPDATE day_trade_investments SET status='doubled', result_amount=? WHERE id=?`,
            [resultAmount, inv.id]
          );
        } else {
          await conn.query(
            `UPDATE day_trade_investments SET status='zeroed', result_amount=0 WHERE id=?`, [inv.id]
          );
        }
      }

      await conn.query(
        `UPDATE day_trades SET status='completed', result=?, is_winner=?, closed_at=NOW() WHERE id=?`,
        [result, isWinner ? 1 : 0, trade.id]
      );
    }

    await conn.commit();
    const winnerCount = winnerIds.size;
    res.json({
      message: `Trades settled. ${winnerCount} winner${winnerCount === 1 ? '' : 's'} doubled (trading wallet credited), others zeroed.`,
      winner_count: winnerCount,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally { conn.release(); }
};

exports.getDayTradesAdmin = async (req, res) => {
  try {
    const filterDate = req.query.date;
    let trades;
    if (filterDate) {
      const [rows] = await db.query(
        `SELECT dt.*,
          COUNT(DISTINCT dti.member_id) AS total_investors,
          COALESCE(SUM(dti.invest_amount),0) AS total_invested,
          (SELECT COUNT(*) FROM day_trade_investments dti_all WHERE dti_all.day_trade_id = dt.id) AS investment_count
         FROM day_trades dt
         LEFT JOIN day_trade_investments dti
           ON dt.id = dti.day_trade_id AND DATE(dti.invested_at) = ?
         WHERE dt.deleted_at IS NULL AND DATE(dt.trade_date) = ?
         GROUP BY dt.id
         ORDER BY dt.created_at DESC`,
        [filterDate, filterDate]
      );
      trades = rows;
    } else {
      const [rows] = await db.query(
        `SELECT dt.*,
          COUNT(DISTINCT dti.member_id) AS total_investors,
          COALESCE(SUM(dti.invest_amount),0) AS total_invested,
          (SELECT COUNT(*) FROM day_trade_investments dti_all WHERE dti_all.day_trade_id = dt.id) AS investment_count
         FROM day_trades dt
         LEFT JOIN day_trade_investments dti
           ON dt.id = dti.day_trade_id AND DATE(dti.invested_at) = DATE(dt.trade_date)
         WHERE dt.deleted_at IS NULL
         GROUP BY dt.id
         ORDER BY dt.created_at DESC`
      );
      trades = rows;
    }
    res.json(trades.map((t) => enrichTradeChart(t)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getTradeInvestors = async (req, res) => {
  try {
    const [investors] = await db.query(
      `SELECT dti.*, m.name, m.email, m.package_amount
       FROM day_trade_investments dti JOIN members m ON dti.member_id=m.id
       WHERE dti.day_trade_id=? ORDER BY dti.invested_at DESC`, [req.params.id]
    );
    const [trade] = await db.query('SELECT * FROM day_trades WHERE id=?', [req.params.id]);
    const enriched = trade[0] ? enrichTradeChart(trade[0]) : null;
    res.json({ trade: enriched, investors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getDayTradesMember = async (req, res) => {
  try {
    if (!isDayTradeVisibleToMember()) {
      return res.json([]);
    }
    const todayIst = getTodayIstYmd();
    let rows;
    try {
      [rows] = await db.query(
        `SELECT * FROM day_trades
         WHERE deleted_at IS NULL AND status='active' AND trade_date = ?
           AND (result = 'pending' OR result IS NULL OR result = '')
         ORDER BY created_at DESC`,
        [todayIst],
      );
    } catch (qErr) {
      if (qErr?.code === 'ER_BAD_FIELD_ERROR' && String(qErr.message).includes('deleted_at')) {
        [rows] = await db.query(
          `SELECT * FROM day_trades
           WHERE status='active' AND trade_date = ?
             AND (result = 'pending' OR result IS NULL OR result = '')
           ORDER BY created_at DESC`,
          [todayIst],
        );
      } else {
        throw qErr;
      }
    }
    const out = [];
    for (const t of rows || []) {
      try {
        out.push(enrichTradeChart(t));
      } catch (chartErr) {
        console.error('[getDayTradesMember] chart enrich failed trade', t?.id, chartErr.message);
        const { chart_json: _cj, ...rest } = t;
        out.push({ ...rest, chart: [] });
      }
    }
    res.json(out);
  } catch (err) {
    console.error('[getDayTradesMember]', err);
    res.status(500).json({ error: err.message });
  }
};
