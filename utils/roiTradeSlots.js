const db = require('../config/db');
const { sqlTimeToHms, sessionEnvelope, istNow } = require('./roiTime');

function slotRowToApi(row) {
  return {
    id: row.id,
    slot_index: Number(row.slot_index),
    trade_name: row.trade_name ?? null,
    description: row.description ?? null,
    open_time: sqlTimeToHms(row.open_time),
    close_time: sqlTimeToHms(row.close_time),
    amount: Number(row.amount ?? 0),
    status: row.status || 'scheduled',
    closed_at: row.closed_at ?? null,
  };
}

function slotRowToWindow(row) {
  return {
    open_time: sqlTimeToHms(row.open_time),
    close_time: sqlTimeToHms(row.close_time),
    trade_name: row.trade_name ?? null,
    description: row.description ?? null,
    status: row.status || 'scheduled',
    slot_index: Number(row.slot_index),
  };
}

async function fetchSlotRows(tradeId) {
  const [rows] = await db.query(
    `SELECT * FROM roi_trade_slots WHERE roi_trade_id = ? ORDER BY slot_index ASC`,
    [tradeId]
  );
  return rows;
}

function applySlotRowsToTrade(trade, slotRows) {
  if (!trade || !slotRows?.length) return trade;
  trade.slots = slotRows.map(slotRowToApi);
  trade.slot_windows = slotRows.map(slotRowToWindow);
  trade.topup_tiers = slotRows.map((r) => Number(r.amount ?? 0));
  const env = sessionEnvelope(trade.slot_windows);
  trade.open_time = env.sessionOpen;
  trade.close_time = env.sessionClose;
  return trade;
}

async function enrichTradeWithSlotRows(trade, parseFullTradeFn) {
  if (!trade?.id) return parseFullTradeFn(trade);
  const base = parseFullTradeFn(trade);
  const slotRows = await fetchSlotRows(trade.id);
  if (!slotRows.length) return base;
  return applySlotRowsToTrade(base, slotRows);
}

function parseJsonField(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  return raw;
}

function inferSlotStatus(openTime, closeTime, timeStr, previousStatus) {
  const o = sqlTimeToHms(openTime);
  const c = sqlTimeToHms(closeTime);
  if (timeStr >= c) return 'closed';
  if (timeStr >= o) return 'open';
  if (previousStatus === 'closed') return 'scheduled';
  return previousStatus || 'scheduled';
}

async function syncJsonCacheFromSlotRows(tradeId) {
  const slotRows = await fetchSlotRows(tradeId);
  if (!slotRows.length) return null;
  const windows = slotRows.map(slotRowToWindow);
  const tiers = slotRows.map((r) => Number(r.amount ?? 0));
  const env = sessionEnvelope(windows);
  await db.query(
    `UPDATE roi_trades SET slot_windows = ?, topup_tiers = ?, open_time = ?, close_time = ? WHERE id = ?`,
    [JSON.stringify(windows), JSON.stringify(tiers), env.sessionOpen, env.sessionClose, tradeId]
  );
  return { windows, tiers, envelope: env };
}

async function upsertSlotRow(tradeId, slotIndex, fields) {
  const [existing] = await db.query(
    `SELECT id, status FROM roi_trade_slots WHERE roi_trade_id = ? AND slot_index = ? LIMIT 1`,
    [tradeId, slotIndex]
  );
  const { timeStr } = istNow();
  const openTime = sqlTimeToHms(fields.open_time);
  const closeTime = sqlTimeToHms(fields.close_time);
  const amount = Number(fields.amount ?? 0);
  const tradeName = fields.trade_name ?? null;
  const description = fields.description ?? null;
  const prevStatus = existing[0]?.status || 'scheduled';
  const newStatus = inferSlotStatus(openTime, closeTime, timeStr, prevStatus);

  if (existing.length) {
    await db.query(
      `UPDATE roi_trade_slots
       SET trade_name = ?, description = ?, open_time = ?, close_time = ?, amount = ?, status = ?,
           closed_at = CASE WHEN ? = 'closed' AND status != 'closed' THEN NOW()
                            WHEN ? != 'closed' THEN NULL ELSE closed_at END
       WHERE id = ?`,
      [tradeName, description, openTime, closeTime, amount, newStatus, newStatus, newStatus, existing[0].id]
    );
  } else {
    await db.query(
      `INSERT INTO roi_trade_slots
       (roi_trade_id, slot_index, trade_name, description, open_time, close_time, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tradeId, slotIndex, tradeName, description, openTime, closeTime, amount, newStatus]
    );
  }

  await syncJsonCacheFromSlotRows(tradeId);
  const [saved] = await db.query(
    `SELECT * FROM roi_trade_slots WHERE roi_trade_id = ? AND slot_index = ? LIMIT 1`,
    [tradeId, slotIndex]
  );
  return saved[0] ? slotRowToApi(saved[0]) : null;
}

async function syncAllSlotRowsFromArrays(tradeId, tiers, windows, defaultOpen, defaultClose) {
  const n = Math.max(tiers?.length || 0, windows?.length || 0);
  for (let i = 0; i < n; i++) {
    const w = windows[i] || {};
    await upsertSlotRow(tradeId, i, {
      open_time: w.open_time ?? defaultOpen,
      close_time: w.close_time ?? defaultClose,
      trade_name: w.trade_name ?? null,
      description: w.description ?? null,
      amount: tiers[i] ?? 0,
    });
  }
  const slotRows = await fetchSlotRows(tradeId);
  const keep = new Set(Array.from({ length: n }, (_, i) => i));
  for (const row of slotRows) {
    if (!keep.has(Number(row.slot_index))) {
      await db.query(`DELETE FROM roi_trade_slots WHERE id = ?`, [row.id]);
    }
  }
  await syncJsonCacheFromSlotRows(tradeId);
}

async function migrateTradeSlotsFromJson(tradeRow, slotWindowsFromRowFn) {
  const tradeId = tradeRow.id;
  const [exist] = await db.query(
    `SELECT id FROM roi_trade_slots WHERE roi_trade_id = ? LIMIT 1`,
    [tradeId]
  );
  if (exist.length) return false;

  const tierLen = parseJsonField(tradeRow.topup_tiers)?.length || 9;
  const windows = slotWindowsFromRowFn(
    tradeRow.slot_windows,
    tradeRow.open_time,
    tradeRow.close_time,
    tierLen
  );
  let tiers = parseJsonField(tradeRow.topup_tiers);
  if (!Array.isArray(tiers)) tiers = [];
  const { timeStr } = istNow();
  const sessionClosed = tradeRow.status === 'closed';

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    let status = inferSlotStatus(w.open_time, w.close_time, timeStr, 'scheduled');
    if (sessionClosed && timeStr < sqlTimeToHms(w.close_time)) {
      status = inferSlotStatus(w.open_time, w.close_time, timeStr, 'closed');
    }
    await db.query(
      `INSERT INTO roi_trade_slots
       (roi_trade_id, slot_index, trade_name, description, open_time, close_time, amount, status, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tradeId,
        i,
        w.trade_name ?? null,
        w.description ?? null,
        sqlTimeToHms(w.open_time),
        sqlTimeToHms(w.close_time),
        Number(tiers[i] ?? 0),
        status,
        status === 'closed' ? tradeRow.closed_at || new Date() : null,
      ]
    );
  }
  await syncJsonCacheFromSlotRows(tradeId);
  return true;
}

async function cloneSlotRows(fromTradeId, toTradeId) {
  const rows = await fetchSlotRows(fromTradeId);
  if (rows.length) {
    for (const r of rows) {
      await db.query(
        `INSERT INTO roi_trade_slots
         (roi_trade_id, slot_index, trade_name, description, open_time, close_time, amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
        [
          toTradeId,
          r.slot_index,
          r.trade_name,
          r.description,
          sqlTimeToHms(r.open_time),
          sqlTimeToHms(r.close_time),
          Number(r.amount ?? 0),
        ]
      );
    }
    await syncJsonCacheFromSlotRows(toTradeId);
    return;
  }

  const [fromTrade] = await db.query(`SELECT * FROM roi_trades WHERE id = ?`, [fromTradeId]);
  if (!fromTrade.length) return;

  const tierLen = parseJsonField(fromTrade[0].topup_tiers)?.length || 9;
  const parsed = parseJsonField(fromTrade[0].slot_windows);
  for (let i = 0; i < tierLen; i++) {
    const e = Array.isArray(parsed) ? parsed[i] : null;
    await db.query(
      `INSERT INTO roi_trade_slots
       (roi_trade_id, slot_index, trade_name, description, open_time, close_time, amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
      [
        toTradeId,
        i,
        e?.trade_name ?? null,
        e?.description ?? null,
        sqlTimeToHms(e?.open_time ?? fromTrade[0].open_time),
        sqlTimeToHms(e?.close_time ?? fromTrade[0].close_time),
        Number(parseJsonField(fromTrade[0].topup_tiers)?.[i] ?? 0),
      ]
    );
  }
  await syncJsonCacheFromSlotRows(toTradeId);
}

/**
 * Align slot rows with current IST clock before join/settle logic runs.
 * Reopens slots that were marked closed while their window is still active.
 */
async function syncSlotStatusesFromClock(tradeId) {
  const slotRows = await fetchSlotRows(tradeId);
  if (!slotRows.length) return null;
  const { timeStr } = istNow();

  for (const slot of slotRows) {
    const o = sqlTimeToHms(slot.open_time);
    const c = sqlTimeToHms(slot.close_time);
    if (timeStr >= c) continue;

    const desired = timeStr >= o ? 'open' : 'scheduled';
    if (slot.status !== desired) {
      await db.query(`UPDATE roi_trade_slots SET status = ?, closed_at = NULL WHERE id = ?`, [
        desired,
        slot.id,
      ]);
    }
  }

  return reconcileSessionStatusFromSlots(tradeId);
}

async function reconcileSessionStatusFromSlots(tradeId) {
  const slotRows = await fetchSlotRows(tradeId);
  if (!slotRows.length) return null;
  const { timeStr } = istNow();
  const env = sessionEnvelope(slotRows.map(slotRowToWindow));
  const anyOpen = slotRows.some((s) => s.status === 'open');
  const allClosed = slotRows.every((s) => s.status === 'closed');

  let newStatus;
  if (allClosed) {
    newStatus = 'closed';
  } else if (anyOpen) {
    newStatus = 'open';
  } else if (timeStr < env.sessionOpen) {
    newStatus = 'scheduled';
  } else {
    newStatus = 'open';
  }

  if (newStatus === 'closed') {
    await db.query(
      `UPDATE roi_trades SET status = 'closed', closed_at = COALESCE(closed_at, NOW()),
       open_time = ?, close_time = ? WHERE id = ?`,
      [env.sessionOpen, env.sessionClose, tradeId]
    );
  } else {
    await db.query(
      `UPDATE roi_trades SET status = ?, closed_at = NULL, open_time = ?, close_time = ? WHERE id = ?`,
      [newStatus, env.sessionOpen, env.sessionClose, tradeId]
    );
  }
  return newStatus;
}

async function reopenSlotIfExtended(tradeId, slotIndex) {
  const [rows] = await db.query(
    `SELECT * FROM roi_trade_slots WHERE roi_trade_id = ? AND slot_index = ? LIMIT 1`,
    [tradeId, slotIndex]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.status !== 'closed') return row.status;
  const { timeStr } = istNow();
  const c = sqlTimeToHms(row.close_time);
  if (timeStr >= c) return 'closed';
  const o = sqlTimeToHms(row.open_time);
  const newStatus = timeStr < o ? 'scheduled' : 'open';
  await db.query(`UPDATE roi_trade_slots SET status = ?, closed_at = NULL WHERE id = ?`, [
    newStatus,
    row.id,
  ]);
  await reconcileSessionStatusFromSlots(tradeId);
  return newStatus;
}

async function migrateAllTradesFromJson(slotWindowsFromRowFn) {
  const [trades] = await db.query(`SELECT * FROM roi_trades ORDER BY id ASC`);
  for (const t of trades) {
    await migrateTradeSlotsFromJson(t, slotWindowsFromRowFn);
  }
}

module.exports = {
  fetchSlotRows,
  slotRowToApi,
  slotRowToWindow,
  applySlotRowsToTrade,
  enrichTradeWithSlotRows,
  syncJsonCacheFromSlotRows,
  upsertSlotRow,
  syncAllSlotRowsFromArrays,
  migrateTradeSlotsFromJson,
  migrateAllTradesFromJson,
  cloneSlotRows,
  reconcileSessionStatusFromSlots,
  syncSlotStatusesFromClock,
  reopenSlotIfExtended,
  inferSlotStatus,
};
