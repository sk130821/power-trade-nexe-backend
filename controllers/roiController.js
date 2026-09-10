  const db = require('../config/db');
  const { recordTransaction } = require('../utils/transaction');
  const { fetchMemberTopupPaymentStats, fetchMemberPlanTopupHistory } = require('../utils/memberTopupPaymentStats');
  const {
    istNow,
    toMySqlTime,
    sqlTimeToHms,
    sessionEnvelope,
    istTimeInSlotWindowInclusive,
    isWeekendIST,
    isRoiTradingDayIST,
    istWeekdayName,
  } = require('../utils/roiTime');
  const {
    isPremiumPlan,
    isPremiumJoinSlot,
    premiumJoinSlots,
    premiumJoinSlotsForOpenCycles,
    isPremiumJoinSlotForOpenCycles,
    openCyclesMatchingPremiumSlot,
    premiumSlotRoiShare,
    premiumSlotShareLabel,
    computePremiumSlotRoi,
  } = require('../utils/roiPremium');
  const {
    buildMemberRoiParticipationStats,
    listMemberParticipationMonths,
  } = require('../utils/roiParticipation');
  const { buildNonWorking2xParticipationWindow } = require('../utils/nonWorking2xWindow');
  const { isMemberWorking } = require('../utils/incomeCap');
  const {
    enrichTradeWithSlotRows,
    upsertSlotRow,
    syncAllSlotRowsFromArrays,
    cloneSlotRows,
    migrateTradeSlotsFromJson,
    migrateAllTradesFromJson,
    reconcileSessionStatusFromSlots,
    syncSlotStatusesFromClock,
    reopenSlotIfExtended,
    fetchSlotRows,
  } = require('../utils/roiTradeSlots');
  const {
    fetchOpenCyclesForSlot,
    fetchOldestOpenCycle,
    fetchAllOpenCycles,
    ensureMemberCycles,
    ROI_LADDER_SLOTS,
    nextRetopupSlotIndex,
    cycleLevelsForSlot,
  } = require('../utils/retopupCycles');
  const { LEVEL_PERCENTS } = require('../config/levelIncome');
  const { memberQualifiesForLevelIncome } = require('../utils/levelIncomeQualify');
  const { getRoiPercent } = require('../utils/roiPercent');

  /** Admin-defined ladder length: 1..MAX inclusive (slot indices 0..length-1). */
  const MIN_ROI_SLOTS = 1;
  const MAX_ROI_SLOTS = 48;
  const DEFAULT_ROI_SLOTS = 12;

  function parseNumericArrayField(rawField) {
    let raw = rawField;
    if (raw == null) return [];
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return [];
      }
    }
    if (Buffer.isBuffer(raw)) {
      try {
        raw = JSON.parse(raw.toString('utf8'));
      } catch {
        return [];
      }
    }
    if (!Array.isArray(raw)) return [];
    return raw;
  }

  function resolveSlotCount(body) {
    const rawTiers = parseNumericArrayField(body?.topup_tiers);
    const rawWin = (() => {
      let w = body?.slot_windows;
      if (w == null) return [];
      if (typeof w === 'string') {
        try {
          w = JSON.parse(w);
        } catch {
          return [];
        }
      }
      if (!Array.isArray(w)) return [];
      return w;
    })();
    let n = Math.max(rawTiers.length, rawWin.length);
    if (n === 0) n = DEFAULT_ROI_SLOTS;
    return Math.min(MAX_ROI_SLOTS, Math.max(MIN_ROI_SLOTS, n));
  }

  function normalizeTopupTiers(body) {
    const raw = parseNumericArrayField(body?.topup_tiers);
    const slotCount = resolveSlotCount(body);
    const norm = [];
    for (let i = 0; i < slotCount; i++) {
      const n = Number(raw[i]);
      norm[i] = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    return norm;
  }

  function tradeNameFromBody(body) {
    const s = body?.trade_name != null ? String(body.trade_name).trim() : '';
    return s || 'Daily Trade Session';
  }

  function tradeDescriptionFromBody(body) {
    if (body?.description == null || body.description === '') return null;
    const s = String(body.description).trim();
    return s || null;
  }

  function parseTradeTopup(trade) {
    if (!trade) return trade;
    const out = { ...trade };
    const arr = parseNumericArrayField(out.topup_tiers);
    if (!arr.length) {
      out.topup_tiers = [0];
      return out;
    }
    const norm = [];
    for (let i = 0; i < arr.length && i < MAX_ROI_SLOTS; i++) {
      const n = Number(arr[i]);
      norm.push(Number.isFinite(n) && n >= 0 ? n : 0);
    }
    if (!norm.length) norm.push(0);
    out.topup_tiers = norm;
    return out;
  }

  function slotMetaFromObject(entry) {
    let trade_name = null;
    let description = null;
    if (entry && typeof entry === 'object') {
      const tn = entry.trade_name ?? entry.tradeName;
      if (tn != null && String(tn).trim()) trade_name = String(tn).trim();
      const desc = entry.description ?? entry.desc;
      if (desc != null && String(desc).trim()) description = String(desc).trim();
    }
    return { trade_name, description };
  }

  /** Build slot windows from DB JSON or fallback to global open/close for every tier index. */
  function slotWindowsFromRow(rawField, fallbackOpen, fallbackClose, tierCount) {
    const o = sqlTimeToHms(fallbackOpen);
    const c = sqlTimeToHms(fallbackClose);
    let raw = rawField;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = null;
      }
    }
    if (Buffer.isBuffer(raw)) {
      try {
        raw = JSON.parse(raw.toString('utf8'));
      } catch {
        raw = null;
      }
    }
    const n = Math.min(MAX_ROI_SLOTS, Math.max(MIN_ROI_SLOTS, Number(tierCount) || 1));
    const norm = [];
    for (let i = 0; i < n; i++) {
      if (Array.isArray(raw) && raw[i] && typeof raw[i] === 'object') {
        const openH = toMySqlTime(raw[i].open_time ?? raw[i].open, 12, 0);
        const closeH = toMySqlTime(raw[i].close_time ?? raw[i].close, 13, 0);
        const meta = slotMetaFromObject(raw[i]);
        norm.push({ open_time: openH, close_time: closeH, trade_name: meta.trade_name, description: meta.description });
      } else {
        norm.push({ open_time: o, close_time: c, trade_name: null, description: null });
      }
    }
    return norm;
  }

  function parseFullTrade(row) {
    if (!row) return row;
    const t = parseTradeTopup(row);
    t.open_time = sqlTimeToHms(row.open_time);
    t.close_time = sqlTimeToHms(row.close_time);
    t.slot_windows = slotWindowsFromRow(
      row.slot_windows,
      t.open_time,
      t.close_time,
      t.topup_tiers.length
    ).map((w) => ({
      open_time: sqlTimeToHms(w.open_time),
      close_time: sqlTimeToHms(w.close_time),
      trade_name: w.trade_name ?? null,
      description: w.description ?? null,
    }));
    return t;
  }

  /** Validate & normalize per-slot windows + optional per-slot trade_name / description. */
  function normalizeSlotWindowsInput(body, defaultOpenHms, defaultCloseHms) {
    const topupTiers = normalizeTopupTiers(body);
    const slotCount = topupTiers.length;
    const raw = body?.slot_windows;
    let parsed = null;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    } else if (Array.isArray(raw)) {
      parsed = raw;
    }
    const out = [];
    for (let i = 0; i < slotCount; i++) {
      let o = defaultOpenHms;
      let c = defaultCloseHms;
      let trade_name = null;
      let description = null;
      if (parsed && parsed[i] && typeof parsed[i] === 'object') {
        o = toMySqlTime(parsed[i].open_time ?? parsed[i].open ?? o, 12, 0);
        c = toMySqlTime(parsed[i].close_time ?? parsed[i].close ?? c, 13, 0);
        const meta = slotMetaFromObject(parsed[i]);
        trade_name = meta.trade_name;
        description = meta.description;
      }
      if (c <= o) {
        return {
          error: `Slot ${i}: set close_time after open_time (IST)`,
        };
      }
      out.push({ open_time: o, close_time: c, trade_name, description });
    }
    const env = sessionEnvelope(out);
    if (env.sessionClose <= env.sessionOpen) {
      return { error: 'Full session: latest close must be after earliest open.' };
    }
    return { slotWindows: out, envelope: env, topupTiers };
  }

  /** Trade principal for a ladder slot: admin tier amount if > 0, else member package. */
  function roiBaseForSlot(tiers, slot, packageAmount) {
    const maxIdx = Math.max(0, (Array.isArray(tiers) ? tiers.length : 1) - 1);
    const s = Math.min(Math.max(0, Number(slot) || 0), maxIdx);
    const tierVal = Number(tiers[s] ?? 0);
    if (tierVal > 0) return tierVal;
    return Number(packageAmount || 0);
  }

  function maxPlanTopupIndexForTiers(tiers) {
    const n = Array.isArray(tiers) ? tiers.length : 0;
    return Math.max(0, n - 1);
  }

  /** Today’s session ladder → max plan_topup_count (slot index for join). */
  async function getMaxPlanTopupForToday() {
    const { dateStr } = istNow();
    const [rows] = await db.query(
      `SELECT topup_tiers FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
      [dateStr]
    );
    if (!rows.length) return MAX_ROI_SLOTS - 1;
    const fake = { topup_tiers: rows[0].topup_tiers };
    const { topup_tiers: tiers } = parseTradeTopup(fake);
    return maxPlanTopupIndexForTiers(tiers);
  }

  exports.getMaxPlanTopupForToday = getMaxPlanTopupForToday;

  async function getTodayTopupTiersArray() {
    const { dateStr } = istNow();
    const [rows] = await db.query(
      `SELECT topup_tiers FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
      [dateStr]
    );
    if (!rows.length) {
      /** Same phantom length as getMaxPlanTopupForToday() when no session row exists */
      return Array.from({ length: MAX_ROI_SLOTS }, () => 0);
    }
    const { topup_tiers } = parseTradeTopup({ topup_tiers: rows[0].topup_tiers });
    return topup_tiers;
  }

  /**
   * Amount member must pay to advance plan_topup_count by +1 on today’s Trade ladder (slot goes to plan_topup_count + 1).
   */
  exports.computeNextPlanTopupPayment = async function computeNextPlanTopupPayment(planTopupCount, packageAmount) {
    const tiers = await getTodayTopupTiersArray();
    const rawC = Math.max(0, Number(planTopupCount) || 0);
    const nextSlot = nextRetopupSlotIndex(rawC);
    const nextCycleLevel = rawC + 1;
    const amount = roiBaseForSlot(tiers, nextSlot, Number(packageAmount));
    return {
      ok: true,
      next_slot_index: nextSlot,
      next_cycle_level: nextCycleLevel,
      amount_due_usd: parseFloat(Number(amount).toFixed(2)),
      ladder_slots: ROI_LADDER_SLOTS,
      plan_topup_count_current: rawC,
      unlimited_retopup: true,
    };
  };

  /** @deprecated No-op: each slot join is a separate row; plan TOP-UP does not overwrite past joins. */
  exports.syncOpenRoiParticipantSlotForMember = async function syncOpenRoiParticipantSlotForMember(memberId) {
    void memberId;
  };

  /** Participant JOIN miss / legacy data: resolve slot from txn description (creditRoiPayoutsForMembers text). */
  function ladderSlotForReportRow(ladderSlotFromJoin, txnDescription) {
    if (ladderSlotFromJoin != null && ladderSlotFromJoin !== '') {
      const n = Number(ladderSlotFromJoin);
      if (Number.isFinite(n)) return n;
    }
    const m = String(txnDescription || '').match(/\bladder\s+slot\s+(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /** True if this member already received roi_income for this trade session + slot (and optional cycle). */
  async function roiPayoutAlreadyRecorded(conn, memberId, tradeId, slot, cycleLevel = null) {
    const slotNeedle = `%| slot ${Number(slot)} |%`;
    if (cycleLevel != null && Number.isFinite(Number(cycleLevel))) {
      const cycleNeedle = `%| slot ${Number(slot)} | cycle ${Number(cycleLevel)} |%`;
      const [rows] = await conn.query(
        `SELECT id FROM transactions
         WHERE member_id = ? AND income_type = 'roi_income'
           AND reference_type = 'roi_trade' AND reference_id = ?
           AND description LIKE ?
         LIMIT 1`,
        [memberId, tradeId, cycleNeedle],
      );
      return rows.length > 0;
    }
    const [rows] = await conn.query(
      `SELECT id FROM transactions
       WHERE member_id = ? AND income_type = 'roi_income'
         AND reference_type = 'roi_trade' AND reference_id = ?
         AND description LIKE ?
       LIMIT 1`,
      [memberId, tradeId, slotNeedle],
    );
    return rows.length > 0;
  }

  /** Credit Trade + level income; separate payout per open cycle on the slot. */
  async function creditRoiPayoutsForMembers(conn, tradeRow, members, tid) {
    if (!members.length) return 0;
    const { topup_tiers: tiers } = parseTradeTopup(tradeRow);
    let batchRoiSum = 0;
    const participantRowIds = [];
    const directCountCache = new Map();
    for (const member of members) {
      const rowId = Number(member.participant_row_id);
      const slot = Math.min(Math.max(0, Number(member.participant_topup_slot) || 0), ROI_LADDER_SLOTS - 1);
      const pkg = Number(member.package_amount) || 0;
      const premium = isPremiumPlan(pkg);
      let participantSettled = false;

      await ensureMemberCycles(
        conn,
        member.id,
        member.package_amount,
        member.plan_topup_count,
        null
      );

      if (premium) {
        const openPremiumCycles = await fetchAllOpenCycles(conn, member.id);
        const matchingCycles = openCyclesMatchingPremiumSlot(slot, openPremiumCycles, pkg);
        if (!matchingCycles.length) continue;

        const roiAmount = computePremiumSlotRoi(pkg);
        if (roiAmount <= 0) continue;
        const shareLabel = premiumSlotShareLabel(pkg) || '';

        for (const cycle of matchingCycles) {
          if (await roiPayoutAlreadyRecorded(conn, member.id, tid, slot, cycle.cycle_level)) continue;

          const txn = await recordTransaction(conn, {
            member_id: member.id,
            income_type: 'roi_income',
            amount: roiAmount,
            income_cycle_id: cycle.id,
            description: `Daily Trade | $${pkg} plan | slot ${slot} | cycle ${cycle.cycle_level} | ${shareLabel} share | base $${pkg}`,
            reference_id: tid,
            reference_type: 'roi_trade',
            dedup_key: `roi_income|t${tid}|m${member.id}|s${slot}|c${cycle.cycle_level}`,
          });
          if (!txn) continue;
          batchRoiSum += roiAmount;
          participantSettled = true;

          let currentId = member.sponsor_id;
          let level = 0;
          while (currentId && level < LEVEL_PERCENTS.length) {
            const levelPercent = LEVEL_PERCENTS[level];
            if (!levelPercent) break;
            const levelAmount = parseFloat(((roiAmount * levelPercent) / 100).toFixed(6));
            if (levelAmount > 0) {
              const qualifies = await memberQualifiesForLevelIncome(
                conn,
                currentId,
                level,
                directCountCache
              );
              if (qualifies) {
                await recordTransaction(conn, {
                  member_id: currentId,
                  income_type: 'level_income',
                  amount: levelAmount,
                  description: `Level ${level + 1} from ${member.name} | $${pkg} slot ${slot} cycle ${cycle.cycle_level} ${shareLabel} | Trade $${roiAmount}`,
                  reference_id: tid,
                  reference_type: 'roi_trade',
                  from_member_id: member.id,
                  level_no: level + 1,
                  dedup_key: `level_income|t${tid}|to${currentId}|fm${member.id}|s${slot}|c${cycle.cycle_level}|L${level + 1}`,
                });
              }
            }
            const [upline] = await conn.query('SELECT sponsor_id FROM members WHERE id=?', [currentId]);
            currentId = upline[0]?.sponsor_id;
            level++;
          }
        }
        if (participantSettled && Number.isFinite(rowId) && rowId > 0) participantRowIds.push(rowId);
        continue;
      }

      const openCycles = await fetchOpenCyclesForSlot(conn, member.id, slot);
      if (!openCycles.length) continue;

      for (const cycle of openCycles) {
        if (await roiPayoutAlreadyRecorded(conn, member.id, tid, slot, cycle.cycle_level)) continue;
        const tierBase = roiBaseForSlot(tiers, slot, member.package_amount);
        const base =
          Number(cycle.cap_base) > 0 ? Number(cycle.cap_base) : tierBase;
        const roiPercent = getRoiPercent(base);
        const roiAmount = parseFloat(((base * roiPercent) / 100).toFixed(4));
        if (roiAmount <= 0) continue;

        const txn = await recordTransaction(conn, {
          member_id: member.id,
          income_type: 'roi_income',
          amount: roiAmount,
          income_cycle_id: cycle.id,
          description: `Daily Trade | slot ${slot} | cycle ${cycle.cycle_level} | base $${base} | ${roiPercent}%`,
          reference_id: tid,
          reference_type: 'roi_trade',
          dedup_key: `roi_income|t${tid}|m${member.id}|s${slot}|c${cycle.cycle_level}`,
        });
        if (!txn) continue;
        batchRoiSum += roiAmount;
        participantSettled = true;

        let currentId = member.sponsor_id;
        let level = 0;
        while (currentId && level < LEVEL_PERCENTS.length) {
          const levelPercent = LEVEL_PERCENTS[level];
          if (!levelPercent) break;
          const levelAmount = parseFloat(((roiAmount * levelPercent) / 100).toFixed(6));
          if (levelAmount > 0) {
            const qualifies = await memberQualifiesForLevelIncome(
              conn,
              currentId,
              level,
              directCountCache
            );
            if (qualifies) {
              await recordTransaction(conn, {
                member_id: currentId,
                income_type: 'level_income',
                amount: levelAmount,
                description: `Level ${level + 1} from ${member.name} | slot ${slot} cycle ${cycle.cycle_level} | Trade $${roiAmount}`,
                reference_id: tid,
                reference_type: 'roi_trade',
                from_member_id: member.id,
                level_no: level + 1,
                dedup_key: `level_income|t${tid}|to${currentId}|fm${member.id}|s${slot}|c${cycle.cycle_level}|L${level + 1}`,
              });
            }
          }
          const [upline] = await conn.query('SELECT sponsor_id FROM members WHERE id=?', [currentId]);
          currentId = upline[0]?.sponsor_id;
          level++;
        }
      }
      if (participantSettled && Number.isFinite(rowId) && rowId > 0) participantRowIds.push(rowId);
    }

    if (participantRowIds.length) {
      const ph = participantRowIds.map(() => '?').join(',');
      await conn.query(
        `UPDATE roi_trade_participants SET roi_settled_at = NOW() WHERE roi_trade_id = ? AND id IN (${ph}) AND roi_settled_at IS NULL`,
        [tid, ...participantRowIds]
      );
    }

    return batchRoiSum;
  }

  /** Per-slot Trade distribution (used by auto-settle cron and optional admin override). */
  async function executeDistributeRoiSlot(tradeId, slotIndex) {
    const tid = Number(tradeId);
    const slot = Number(slotIndex);
    if (!Number.isInteger(slot) || slot < 0) {
      return { ok: false, message: 'Invalid slot' };
    }

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [trade] = await conn.query(`SELECT * FROM roi_trades WHERE id=? FOR UPDATE`, [tid]);
      if (!trade.length) {
        await conn.rollback();
        return { ok: false, message: 'Trade not found' };
      }

      const [[slotMeta]] = await conn.query(
        `SELECT id, status FROM roi_trade_slots WHERE roi_trade_id = ? AND slot_index = ? LIMIT 1 FOR UPDATE`,
        [tid, slot]
      );
      if (slotMeta?.status === 'closed') {
        const [[td0]] = await conn.query(
          `SELECT COALESCE(total_distributed,0) AS t FROM roi_trades WHERE id=?`,
          [tid]
        );
        await conn.commit();
        return {
          ok: true,
          message: `Slot ${slot}: already settled.`,
          batchRoiSum: 0,
          payeeCount: 0,
          totalDistributed: Number(td0?.t ?? 0),
        };
      }

      const tw = parseFullTrade(trade[0]);
      const maxIdx = maxPlanTopupIndexForTiers(tw.topup_tiers);
      if (slot > maxIdx) {
        await conn.rollback();
        return { ok: false, message: `Slot must be between 0 and ${maxIdx}` };
      }

      const [members] = await conn.query(
        `SELECT m.*, p.id AS participant_row_id, p.topup_slot AS participant_topup_slot
        FROM roi_trade_participants p
        INNER JOIN members m ON m.id = p.member_id
        WHERE p.roi_trade_id = ? AND p.topup_slot = ? AND p.roi_settled_at IS NULL AND m.status = 'active'
        FOR UPDATE`,
        [tid, slot]
      );

      if (!members.length) {
        const [[pending]] = await conn.query(
          `SELECT COUNT(*) AS n FROM roi_trade_participants
           WHERE roi_trade_id = ? AND topup_slot = ? AND roi_settled_at IS NULL`,
          [tid, slot]
        );
        if (Number(pending?.n ?? 0) === 0 && slotMeta?.id) {
          await conn.query(
            `UPDATE roi_trade_slots SET status = 'closed', closed_at = NOW() WHERE id = ? AND status <> 'closed'`,
            [slotMeta.id]
          );
        }
        const [[td0]] = await conn.query(
          `SELECT COALESCE(total_distributed,0) AS t FROM roi_trades WHERE id=?`,
          [tid]
        );
        await conn.commit();
        return {
          ok: true,
          message: `Slot ${slot}: no active members with pending payout (or no one joined this slot).`,
          batchRoiSum: 0,
          payeeCount: 0,
          totalDistributed: Number(td0?.t ?? 0),
        };
      }

      const batchRoiSum = await creditRoiPayoutsForMembers(conn, trade[0], members, tid);
      const [[tdRow]] = await conn.query(
        `SELECT COALESCE(total_distributed,0) AS t FROM roi_trades WHERE id=? FOR UPDATE`,
        [tid]
      );
      const newTotal = Number(tdRow.t) + batchRoiSum;
      await conn.query(`UPDATE roi_trades SET total_distributed=? WHERE id=?`, [newTotal, tid]);
      if (slotMeta?.id) {
        await conn.query(
          `UPDATE roi_trade_slots SET status = 'closed', closed_at = NOW() WHERE id = ?`,
          [slotMeta.id]
        );
      }

      await conn.commit();
      return {
        ok: true,
        message: `Slot ${slot}: $${batchRoiSum.toFixed(4)} Trade (batch) — ${members.length} member(s). Level income credited too.`,
        batchRoiSum,
        payeeCount: members.length,
        totalDistributed: newTotal,
      };
    } catch (err) {
      await conn.rollback();
      return { ok: false, message: err.message };
    } finally {
      conn.release();
    }
  }

  exports.distributeRoiSlot = async (req, res) => {
    const tradeId = Number(req.params.trade_id);
    const slot = Number(req.params.slot);
    if (!Number.isFinite(tradeId) || tradeId < 1) {
      return res.status(400).json({ error: 'Invalid trade id' });
    }
    const r = await executeDistributeRoiSlot(tradeId, slot);
    if (!r.ok) return res.status(400).json({ error: r.message });
    res.json(r);
  };

  /** Close one open Trade trade: pay any remaining unsettled active members, then close. */
  async function executeCloseRoiTrade(tradeId) {
    const tid = Number(tradeId);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [trade] = await conn.query(
        `SELECT * FROM roi_trades WHERE id=? AND status IN ('open','scheduled') FOR UPDATE`,
        [tid]
      );
      if (!trade.length) {
        await conn.rollback();
        return { ok: false, message: 'Trade not found or already closed' };
      }

      const [[{ n: joinedN }]] = await conn.query(
        `SELECT COUNT(*) AS n FROM roi_trade_participants WHERE roi_trade_id=?`,
        [tid]
      );

      if (!joinedN) {
        await conn.query(
          `UPDATE roi_trades SET status='closed', closed_at=NOW(), total_distributed=0 WHERE id=?`,
          [tid]
        );
        await conn.commit();
        return {
          ok: true,
          message: 'Trade session closed. No members had joined this session — nothing was distributed.',
          totalDistributed: 0,
          payeeCount: 0,
        };
      }

      const [members] = await conn.query(
        `SELECT m.*, p.id AS participant_row_id, p.topup_slot AS participant_topup_slot
        FROM roi_trade_participants p
        INNER JOIN members m ON m.id = p.member_id
        WHERE p.roi_trade_id = ? AND p.roi_settled_at IS NULL AND m.status = 'active'
        FOR UPDATE`,
        [tid]
      );

      let batchRoiSum = 0;
      if (members.length) {
        batchRoiSum = await creditRoiPayoutsForMembers(conn, trade[0], members, tid);
      }

      const [[tdRow]] = await conn.query(
        `SELECT COALESCE(total_distributed,0) AS t FROM roi_trades WHERE id=? FOR UPDATE`,
        [tid]
      );
      const newTotal = Number(tdRow.t) + batchRoiSum;

      await conn.query(
        `UPDATE roi_trades SET status='closed', closed_at=NOW(), total_distributed=? WHERE id=?`,
        [newTotal, tid]
      );

      await conn.commit();
      return {
        ok: true,
        message:
          members.length > 0
            ? `trade session closed. This batch: $${batchRoiSum.toFixed(4)} — ${members.length} member(s). Session Trade total (admin field): $${newTotal.toFixed(4)}.`
            : `trade session closed. All payouts were already distributed slot-wise — no new Trade at this step. Session Trade total: $${newTotal.toFixed(4)}.`,
        totalDistributed: newTotal,
        payeeCount: members.length,
        batchRoiSum,
      };
    } catch (err) {
      await conn.rollback();
      return { ok: false, message: err.message };
    } finally {
      conn.release();
    }
  }

  /**
   * If today (IST) has no roi_trades row, clone the latest past session’s name, tiers and slot windows.
   * First deployment / empty table still needs one manual Create; after that new days are filled automatically.
   */
  async function ensureTodayRoiFromPreviousSession() {
    const { dateStr } = istNow();
    if (!isRoiTradingDayIST(dateStr)) return;
    const [exist] = await db.query(`SELECT id FROM roi_trades WHERE trade_date = ? LIMIT 1`, [dateStr]);
    if (exist.length) return;

    const [prevRows] = await db.query(
      `SELECT id, trade_name, description, open_time, close_time, topup_tiers, slot_windows
      FROM roi_trades WHERE trade_date < ? ORDER BY trade_date DESC, id DESC LIMIT 1`,
      [dateStr]
    );
    if (!prevRows.length) return;

    const t = prevRows[0];
    const tiersFallback = JSON.stringify(Array.from({ length: DEFAULT_ROI_SLOTS }, () => 0));
    const [result] = await db.query(
      `INSERT INTO roi_trades (trade_date, trade_name, description, opened_by, status, open_time, close_time, topup_tiers, slot_windows)
      VALUES (?, ?, ?, NULL, 'scheduled', ?, ?, ?, ?)`,
      [
        dateStr,
        String(t.trade_name || '').trim() || 'Daily Trade Session',
        t.description ?? null,
        t.open_time,
        t.close_time,
        t.topup_tiers != null && String(t.topup_tiers).length ? t.topup_tiers : tiersFallback,
        t.slot_windows ?? null,
      ]
    );
    await cloneSlotRows(t.id, result.insertId);
    await reconcileSessionStatusFromSlots(result.insertId);
    console.log(`[ROI] Auto-created scheduled session for ${dateStr} from previous trade config`);
  }

  let roiTickInFlight = false;
  let roiTickLastAt = 0;
  const Trade_TICK_MIN_MS = 15000;

  /** Settle one slot when its IST close time has passed (distribute Trade + mark slot closed). */
  async function settleRoiSlotIfDue(tradeId, slot, timeStr) {
    if (slot.status === 'closed') return null;
    const c = sqlTimeToHms(slot.close_time);
    if (timeStr < c) return null;

    const r = await executeDistributeRoiSlot(tradeId, Number(slot.slot_index));
    if (r.ok) {
      await db.query(`UPDATE roi_trade_slots SET status = 'closed', closed_at = NOW() WHERE id = ?`, [slot.id]);
      console.log(`[ROI] Auto-settled slot ${slot.slot_index} #${tradeId}: ${r.message}`);
      return r;
    }
    console.error(`[ROI] Auto-settle slot ${slot.slot_index} failed #${tradeId}: ${r.message}`);
    return r;
  }

  /**
   * Each slot is a separate row (roi_trade_slots): auto-open at open_time IST,
   * auto-settle (Trade payout + close) at close_time IST — no admin action required.
   */
  exports.tickRoiAutomation = async () => {
    if (roiTickInFlight) return;
    roiTickInFlight = true;
    try {
      const { dateStr, timeStr } = istNow();
      if (!isRoiTradingDayIST(dateStr)) return;
      await ensureTodayRoiFromPreviousSession();

      const [trades] = await db.query(
        `SELECT * FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (!trades.length) return;

      const row = trades[0];
      await migrateTradeSlotsFromJson(row, slotWindowsFromRow);
      const slotRows = await fetchSlotRows(row.id);
      if (!slotRows.length) return;

      await syncSlotStatusesFromClock(row.id);
      const liveSlots = await fetchSlotRows(row.id);

      for (const slot of liveSlots) {
        if (slot.status === 'closed') continue;
        const o = sqlTimeToHms(slot.open_time);
        const c = sqlTimeToHms(slot.close_time);

        if (timeStr >= c) {
          await settleRoiSlotIfDue(row.id, slot, timeStr);
        } else if (timeStr >= o && slot.status === 'scheduled') {
          await db.query(`UPDATE roi_trade_slots SET status = 'open' WHERE id = ?`, [slot.id]);
          console.log(`[ROI] Auto-opened slot ${slot.slot_index} for trade #${row.id} (${o.slice(0, 5)} IST)`);
        }
      }
      await reconcileSessionStatusFromSlots(row.id);
    } finally {
      roiTickInFlight = false;
      roiTickLastAt = Date.now();
    }
  };

  /** Throttled tick — runs when admin/member loads Trade pages (backup if cron missed a minute). */
  exports.maybeTickRoiAutomation = async () => {
    if (roiTickInFlight) return;
    if (Date.now() - roiTickLastAt < Trade_TICK_MIN_MS) return;
    await exports.tickRoiAutomation();
  };

  exports.getMemberRoiStatus = async (req, res) => {
    try {
      await exports.maybeTickRoiAutomation();
      await ensureTodayRoiFromPreviousSession();
      const memberId = req.user.id;
      const [memRows] = await db.query(
        `SELECT status, package_amount, plan_topup_count FROM members WHERE id=?`,
        [memberId]
      );
      const mem = memRows[0];
      const [topup_payment_stats, plan_topup_history] = await Promise.all([
        fetchMemberTopupPaymentStats(memberId),
        fetchMemberPlanTopupHistory(memberId),
      ]);
      topup_payment_stats.plan_topup_ladder_level = Number(mem?.plan_topup_count) || 0;
      const eligible = mem?.status === 'active';
      const pkg = Number(mem?.package_amount || 0);
      const premium = isPremiumPlan(pkg);
      const { dateStr, timeStr } = istNow();
      const weekend = isWeekendIST(dateStr);
      const roiTradingToday = isRoiTradingDayIST(dateStr);
      const participation_stats = await buildMemberRoiParticipationStats(db, memberId, pkg, null);
      const memberWorking = await isMemberWorking(db, memberId);
      const non_working_2x_window = await buildNonWorking2xParticipationWindow(
        db,
        memberId,
        pkg,
        { working: memberWorking },
      );

      const roiStatusExtras = {
        is_weekend: weekend,
        is_roi_trading_day: roiTradingToday,
        ist_weekday: istWeekdayName(dateStr),
        ist_clock: { date: dateStr, time: timeStr.slice(0, 5), full_time: timeStr },
        participation_stats,
        non_working_2x_window,
        premium_plan: premium,
        premium_join_slots: premium ? premiumJoinSlots(pkg) : null,
        premium_slot_roi_share: premium ? premiumSlotRoiShare(pkg) : null,
      };

      const [tradeRows] = await db.query(
        `SELECT * FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (!tradeRows.length) {
        const planTopups = Number(mem?.plan_topup_count) || 0;
        return res.json({
          trade: null,
          joined: false,
          joined_slots: [],
          participantCount: 0,
          eligible,
          member_status: mem?.status ?? null,
          plan_topup_count: planTopups,
          ladder_slots: ROI_LADDER_SLOTS,
          unlimited_retopup: true,
          slot_count: 0,
          topup_slot: Math.min(planTopups, ROI_LADDER_SLOTS - 1),
          package_amount: pkg,
          roiPercent: getRoiPercent(pkg),
          estimatedRoi: 0,
          estimated_roi_all_slots: 0,
          in_slot_join_window: false,
          slot_window: null,
          slot_join_list: [],
          live_roi_slots: [],
          join_hint: 'no_session',
          topup_payment_stats,
          plan_topup_history,
          ...roiStatusExtras,
        });
      }

      await migrateTradeSlotsFromJson(tradeRows[0], slotWindowsFromRow);
      let trade = await enrichTradeWithSlotRows(tradeRows[0], parseFullTrade);
      await syncSlotStatusesFromClock(trade.id);
      trade = await enrichTradeWithSlotRows(tradeRows[0], parseFullTrade);
      const planTopups = Math.max(0, Number(mem?.plan_topup_count) || 0);
      await ensureMemberCycles(db, memberId, pkg, planTopups, plan_topup_history);
      const openPremiumCycles = premium ? await fetchAllOpenCycles(db, memberId) : [];
      const memberPremiumSlots = premium
        ? premiumJoinSlotsForOpenCycles(openPremiumCycles, pkg)
        : [];
      if (premium) {
        roiStatusExtras.premium_join_slots = memberPremiumSlots;
      }
      const ladderSlotCount = Math.min(
        ROI_LADDER_SLOTS,
        Array.isArray(trade.topup_tiers) ? trade.topup_tiers.length : ROI_LADDER_SLOTS
      );
      const slotByIndex = new Map((trade.slots || []).map((s) => [Number(s.slot_index), s]));

      const tierEstimateBase = roiBaseForSlot(trade.topup_tiers, 0, pkg);
      const roiPercent = getRoiPercent(tierEstimateBase);

      let participantCount = 0;
      let joined = false;
      let joined_slots = [];
      let in_slot_join_window = false;
      let slot_window = null;
      const slot_join_list = [];

      const [[cnt]] = await db.query(
        `SELECT COUNT(*) AS n FROM roi_trade_participants WHERE roi_trade_id = ?`,
        [trade.id]
      );
      participantCount = Number(cnt?.n ?? 0);

      const [pjRows] = await db.query(
        `SELECT topup_slot FROM roi_trade_participants WHERE roi_trade_id = ? AND member_id = ? ORDER BY topup_slot ASC`,
        [trade.id, memberId]
      );
      const joinedSlotsSet = new Set();
      for (const r of pjRows) {
        const s = Math.min(Math.max(0, Number(r.topup_slot) || 0), ROI_LADDER_SLOTS - 1);
        joinedSlotsSet.add(s);
      }
      joined_slots = [...joinedSlotsSet].sort((a, b) => a - b);
      joined = joined_slots.length > 0;

      for (let s = 0; s < ladderSlotCount; s++) {
        const w = Array.isArray(trade.slot_windows) ? trade.slot_windows[s] : null;
        const slotMeta = slotByIndex.get(s);
        const joined_this = joinedSlotsSet.has(s);
        const openCycles = await fetchOpenCyclesForSlot(db, memberId, s);
        const cycleLevels = cycleLevelsForSlot(planTopups, s);
        const inWindowByClock =
          w && roiTradingToday
            ? istTimeInSlotWindowInclusive(timeStr, w.open_time, w.close_time)
            : false;
        const slotLive = slotMeta
          ? slotMeta.status !== 'closed' || inWindowByClock
          : trade.status === 'open' || trade.status === 'scheduled' || inWindowByClock;

        let can_join;
        let cap_closed;
        let premium_slot;
        if (premium) {
          const matchingPremiumCycles = openCyclesMatchingPremiumSlot(s, openPremiumCycles, pkg);
          premium_slot = isPremiumJoinSlotForOpenCycles(s, pkg, openPremiumCycles);
          if (!premium_slot) {
            can_join = false;
            cap_closed = false;
          } else {
            can_join = matchingPremiumCycles.length > 0 && roiTradingToday;
            cap_closed = matchingPremiumCycles.length === 0;
          }
        } else {
          premium_slot = false;
          can_join = openCycles.length > 0 && roiTradingToday;
          cap_closed = openCycles.length === 0;
        }

        if (
          non_working_2x_window?.applies &&
          (non_working_2x_window.window_expired || !non_working_2x_window.can_join_today)
        ) {
          can_join = false;
        }

        const in_win = slotLive && can_join && inWindowByClock;
        if (slotLive && can_join && !joined_this && in_win) {
          in_slot_join_window = true;
        }
        const roi_running = joined_this && inWindowByClock && slotLive && roiTradingToday;
        slot_join_list.push({
          slot: s,
          open_time: w?.open_time ?? null,
          close_time: w?.close_time ?? null,
          trade_name: w?.trade_name ?? null,
          description: w?.description ?? null,
          slot_status: slotMeta?.status ?? null,
          joined: joined_this,
          in_window: in_win,
          roi_running,
          can_join,
          cap_closed,
          premium_slot,
          participation_window_expired: !!(
            non_working_2x_window?.applies && non_working_2x_window.window_expired
          ),
          roi_share: premium && premium_slot ? premiumSlotRoiShare(pkg) : null,
          open_cycle_levels: premium
            ? openCyclesMatchingPremiumSlot(s, openPremiumCycles, pkg).map((c) => Number(c.cycle_level))
            : openCycles.map((c) => Number(c.cycle_level)),
          open_cycles_count: premium
            ? openCyclesMatchingPremiumSlot(s, openPremiumCycles, pkg).length
            : openCycles.length,
          all_cycle_levels: cycleLevels,
        });
      }

      const focus =
        slot_join_list.find((x) => x.can_join && !x.joined && x.in_window) ||
        slot_join_list.find((x) => x.can_join) ||
        slot_join_list[0] ||
        null;
      if (focus?.open_time) {
        slot_window = {
          open_time: focus.open_time,
          close_time: focus.close_time,
          trade_name: focus.trade_name,
          description: focus.description,
        };
      }

      let estimated_roi_all_slots = 0;
      let estimatedRoiJoined = 0;
      if (premium) {
        const perSlot = computePremiumSlotRoi(pkg);
        estimated_roi_all_slots = parseFloat((perSlot * memberPremiumSlots.length).toFixed(4));
        estimatedRoiJoined = parseFloat(
          (joined_slots.filter((s) => memberPremiumSlots.includes(s)).length * perSlot).toFixed(4),
        );
      } else {
        for (let s = 0; s < ladderSlotCount; s++) {
          const openCycles = await fetchOpenCyclesForSlot(db, memberId, s);
          for (const cycle of openCycles) {
            const base =
              Number(cycle.cap_base) > 0
                ? Number(cycle.cap_base)
                : roiBaseForSlot(trade.topup_tiers, s, pkg);
            estimated_roi_all_slots += parseFloat(((base * getRoiPercent(base)) / 100).toFixed(4));
          }
        }
        for (const s of joined_slots) {
          const openCycles = await fetchOpenCyclesForSlot(db, memberId, s);
          for (const cycle of openCycles) {
            const base =
              Number(cycle.cap_base) > 0
                ? Number(cycle.cap_base)
                : roiBaseForSlot(trade.topup_tiers, s, pkg);
            estimatedRoiJoined += parseFloat(((base * getRoiPercent(base)) / 100).toFixed(4));
          }
        }
      }

      const estimatedRoi = in_slot_join_window || joined ? estimatedRoiJoined : trade.status === 'closed' ? 0 : estimatedRoiJoined;

      const roiPercentOut = trade.status === 'closed' ? roiPercent : getRoiPercent(tierEstimateBase);

      let join_hint = 'ready';
      if (!roiTradingToday) join_hint = 'weekend';
      else if (!eligible) join_hint = 'not_active';
      else if (in_slot_join_window) join_hint = 'in_window';
      else if (trade.status === 'closed') join_hint = 'session_closed';
      else if (!slot_join_list.some((r) => r.can_join && !r.joined)) join_hint = 'no_unlocked_slots';
      else join_hint = 'wait_for_window';

      const live_roi_slots = slot_join_list.filter((r) => r.roi_running);

      return res.json({
        trade,
        joined,
        joined_slots,
        participantCount,
        eligible,
        member_status: mem?.status ?? null,
        plan_topup_count: planTopups,
        ladder_slots: ROI_LADDER_SLOTS,
        unlimited_retopup: true,
        slot_count: ladderSlotCount,
        topup_slot: Math.min(planTopups, ROI_LADDER_SLOTS - 1),
        package_amount: pkg,
        roiPercent: roiPercentOut,
        estimatedRoi,
        estimated_roi_all_slots,
        in_slot_join_window,
        slot_window,
        slot_join_list,
        live_roi_slots,
        join_hint,
        topup_payment_stats,
        plan_topup_history,
        ...roiStatusExtras,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  /** Member: monthly Trade join / lapse history (any past month). */
  exports.getMemberRoiParticipation = async (req, res) => {
    try {
      const memberId = req.user.id;
      const month = req.query.month ? String(req.query.month).trim() : null;
      if (month && !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }

      const [memRows] = await db.query(
        'SELECT package_amount FROM members WHERE id = ?',
        [memberId],
      );
      if (!memRows.length) return res.status(404).json({ error: 'Member not found' });

      const pkg = Number(memRows[0].package_amount) || 0;
      const available_months = await listMemberParticipationMonths(db, memberId);
      const participation = await buildMemberRoiParticipationStats(db, memberId, pkg, month, { fullMonth: true });
      const non_working_2x_window = await buildNonWorking2xParticipationWindow(db, memberId, pkg);

      res.json({
        participation,
        non_working_2x_window,
        available_months,
        package_amount: pkg,
        premium_plan: isPremiumPlan(pkg),
        premium_join_slots: isPremiumPlan(pkg) ? premiumJoinSlots(pkg) : null,
        premium_slot_roi_share: isPremiumPlan(pkg) ? premiumSlotRoiShare(pkg) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  exports.joinRoiTrade = async (req, res) => {
    try {
      await exports.maybeTickRoiAutomation();
      await ensureTodayRoiFromPreviousSession();
      const memberId = req.user.id;
      const [memRows] = await db.query(
        `SELECT status, plan_topup_count, package_amount FROM members WHERE id=?`,
        [memberId]
      );
      if (!memRows.length || memRows[0].status !== 'active') {
        return res.status(400).json({ error: 'Only approved active members can join the trade session' });
      }

      const { dateStr, timeStr } = istNow();
      if (!isRoiTradingDayIST(dateStr)) {
        return res.status(400).json({
          error: 'Trade trading is closed on Saturday & Sunday (IST). Join Mon–Fri only.',
        });
      }

      const [tradeRows] = await db.query(
        `SELECT * FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (!tradeRows.length) {
        return res.status(400).json({
          error:
            'Session is not ready yet — after the first session exists in the DB, the server copies it daily for each new day (server + cron must be running). Until then, admin must Create at least once.',
        });
      }

      await migrateTradeSlotsFromJson(tradeRows[0], slotWindowsFromRow);
      let trade = await enrichTradeWithSlotRows(tradeRows[0], parseFullTrade);
      await syncSlotStatusesFromClock(trade.id);
      trade = await enrichTradeWithSlotRows(tradeRows[0], parseFullTrade);
      const tradeRow = tradeRows[0];

      const pkg = Number(memRows[0].package_amount) || 0;
      const premium = isPremiumPlan(pkg);
      const planTopups = Math.max(0, Number(memRows[0].plan_topup_count) || 0);
      await ensureMemberCycles(db, memberId, memRows[0].package_amount, planTopups, null);

      const nonWorkingWindow = await buildNonWorking2xParticipationWindow(db, memberId, pkg);
      if (nonWorkingWindow.applies && nonWorkingWindow.window_expired) {
        return res.status(400).json({
          error: `Your 2× Trade participation period ended on ${nonWorkingWindow.window_end_date} (IST). You can only earn Trade for days you joined during that window. Plan TOP-UP starts a new cycle.`,
        });
      }

      const rawSlot = req.body?.slot;
      if (rawSlot === undefined || rawSlot === null || rawSlot === '') {
        return res.status(400).json({
          error:
            'Join each slot separately — send `slot` (0–11) in the JSON body.',
        });
      }
      const requestedSlot = Number(rawSlot);
      if (!Number.isInteger(requestedSlot) || requestedSlot < 0 || requestedSlot >= ROI_LADDER_SLOTS) {
        return res.status(400).json({
          error: `You can join slots 0 through ${ROI_LADDER_SLOTS - 1} only.`,
        });
      }

      let openCycles;
      let memberPremiumSlots = null;
      if (premium) {
        const allOpenPremium = await fetchAllOpenCycles(db, memberId);
        memberPremiumSlots = premiumJoinSlotsForOpenCycles(allOpenPremium, pkg);
        const shareLabel = premiumSlotShareLabel(pkg);
        if (!isPremiumJoinSlotForOpenCycles(requestedSlot, pkg, allOpenPremium)) {
          return res.status(400).json({
            error: `Plan $${pkg}: slot ${requestedSlot} is not unlocked — your open slots: ${memberPremiumSlots.join(', ') || 'none'} (${shareLabel} daily Trade each).`,
          });
        }
        openCycles = openCyclesMatchingPremiumSlot(requestedSlot, allOpenPremium, pkg);
        if (!openCycles.length) {
          return res.status(400).json({
            error: 'Your income cap cycles are complete on this slot — Trade is closed until retopup.',
          });
        }
      } else {
        openCycles = await fetchOpenCyclesForSlot(db, memberId, requestedSlot);
        if (!openCycles.length) {
          const levels = cycleLevelsForSlot(planTopups, requestedSlot);
          return res.status(400).json({
            error:
              levels.length === 0
                ? `Slot ${requestedSlot} is not unlocked yet — complete a retopup first.`
                : `Slot ${requestedSlot}: all cycles (2×/3×) are complete — Trade is closed on this slot.`,
          });
        }
      }
      const win = trade.slot_windows && trade.slot_windows[requestedSlot];
      if (!win || !istTimeInSlotWindowInclusive(timeStr, win.open_time, win.close_time)) {
        const o = win ? win.open_time.slice(0, 5) : '?';
        const c = win ? win.close_time.slice(0, 5) : '?';
        return res.status(400).json({
          error:
            `Slot ${requestedSlot} can only be joined between ${o}–${c} IST. You are outside that window now.`,
        });
      }

      const slotRows = await fetchSlotRows(trade.id);
      const slotRow = slotRows.find((r) => Number(r.slot_index) === requestedSlot);
      if (slotRow?.status === 'closed') {
        return res.status(400).json({
          error: `Slot ${requestedSlot} is closed — you cannot join again in this window.`,
        });
      }
      if (slotRow && slotRow.status === 'scheduled' && timeStr >= sqlTimeToHms(win.open_time)) {
        await db.query(`UPDATE roi_trade_slots SET status = 'open' WHERE id = ?`, [slotRow.id]);
        await reconcileSessionStatusFromSlots(trade.id);
      } else if (tradeRow.status === 'scheduled') {
        await db.query(`UPDATE roi_trades SET status='open' WHERE id=? AND status='scheduled'`, [tradeRow.id]);
      }

      try {
        await db.query(
          `INSERT INTO roi_trade_participants (roi_trade_id, member_id, topup_slot) VALUES (?,?,?)`,
          [tradeRow.id, memberId, requestedSlot]
        );
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(400).json({
            error: `You already joined slot (${requestedSlot}) — duplicate join is not allowed.`,
          });
        }
        throw e;
      }

      const msg = premium
        ? `Joined slot ${requestedSlot} (${premiumSlotShareLabel(pkg)} of daily Trade). Open slots today: ${(memberPremiumSlots || []).join(', ') || 'none'}.`
        : `Joined slot ${requestedSlot}. Trade is paid on close: cycles ${openCycles.map((c) => c.cycle_level).join(', ')} (each open cycle separately).`;

      res.json({
        message: msg,
        trade_id: tradeRow.id,
        topup_slot: requestedSlot,
        open_cycle_levels: openCycles.map((c) => Number(c.cycle_level)),
        premium_plan: premium,
        roi_share: premium ? premiumSlotRoiShare(pkg) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  exports.createRoiTrade = async (req, res) => {
    try {
      const { dateStr } = istNow();
      const [any] = await db.query(`SELECT id, status FROM roi_trades WHERE trade_date = ? LIMIT 1`, [dateStr]);
      if (any.length) {
        return res.status(400).json({
          error: 'A session already exists for today.',
        });
      }
      const openT = toMySqlTime(req.body?.open_time, 12, 0);
      const closeT = toMySqlTime(req.body?.close_time, 13, 0);
      const swIn = normalizeSlotWindowsInput(req.body, openT, closeT);
      if (swIn.error) {
        return res.status(400).json({ error: swIn.error });
      }
      const { slotWindows, envelope, topupTiers } = swIn;
      const tradeName = tradeNameFromBody(req.body);
      const tradeDesc = tradeDescriptionFromBody(req.body);
      const tiersJson = JSON.stringify(topupTiers);
      const swJson = JSON.stringify(slotWindows);
      const [result] = await db.query(
        `INSERT INTO roi_trades (trade_date, trade_name, description, opened_by, status, open_time, close_time, topup_tiers, slot_windows)
        VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
        [dateStr, tradeName, tradeDesc, req.user.id, envelope.sessionOpen, envelope.sessionClose, tiersJson, swJson]
      );
      await syncAllSlotRowsFromArrays(
        result.insertId,
        topupTiers,
        slotWindows,
        envelope.sessionOpen,
        envelope.sessionClose
      );
      await reconcileSessionStatusFromSlots(result.insertId);
      res.json({
        message: `trade session created. Auto-open ~${envelope.sessionOpen.slice(0, 5)} IST, auto-close & pay ~${envelope.sessionClose.slice(0, 5)} IST (combined across all slots).`,
        trade_id: result.insertId,
        open_time: envelope.sessionOpen,
        close_time: envelope.sessionClose,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  /** Admin: update today's session (name, tiers, slot_windows). */
  exports.updateTodayRoiTrade = async (req, res) => {
    try {
      const { dateStr } = istNow();
      const [rows] = await db.query(
        `SELECT id, status FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Today's session has not been created yet. Click Create first." });
      }
      const openT = toMySqlTime(req.body?.open_time, 12, 0);
      const closeT = toMySqlTime(req.body?.close_time, 13, 0);
      const swIn = normalizeSlotWindowsInput(req.body, openT, closeT);
      if (swIn.error) {
        return res.status(400).json({ error: swIn.error });
      }
      const { slotWindows, envelope, topupTiers } = swIn;
      const tradeName = tradeNameFromBody(req.body);
      const tradeDesc = tradeDescriptionFromBody(req.body);
      const tiersJson = JSON.stringify(topupTiers);
      const swJson = JSON.stringify(slotWindows);
      await db.query(
        `UPDATE roi_trades SET trade_name = ?, description = ?, open_time = ?, close_time = ?, topup_tiers = ?, slot_windows = ? WHERE id = ?`,
        [tradeName, tradeDesc, envelope.sessionOpen, envelope.sessionClose, tiersJson, swJson, rows[0].id]
      );
      await syncAllSlotRowsFromArrays(
        rows[0].id,
        topupTiers,
        slotWindows,
        envelope.sessionOpen,
        envelope.sessionClose
      );
      const newStatus = await reconcileSessionStatusFromSlots(rows[0].id);
      let message = "Today's session saved — each slot is a separate row (roi_trade_slots).";
      if (rows[0].status === 'closed' && newStatus !== 'closed') {
        message +=
          newStatus === 'open'
            ? ' Session reopened — members can join remaining slot windows.'
            : ' Session rescheduled — it will auto-open at the first slot IST time.';
      }
      res.json({
        message,
        trade_id: rows[0].id,
        status: newStatus,
        open_time: envelope.sessionOpen,
        close_time: envelope.sessionClose,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  /** Admin: save USD + open/close + optional slot title/desc for one slot — today's session must exist. */
  exports.updateTodayRoiSlot = async (req, res) => {
    try {
      const slot = Number(req.params.slot);
      if (!Number.isInteger(slot) || slot < 0) {
        return res.status(400).json({ error: 'slot index must be 0 or greater' });
      }

      const { dateStr } = istNow();
      const [full] = await db.query(
        `SELECT * FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (!full.length) {
        return res.status(404).json({ error: "Create today's session first — then you can save a slot." });
      }

      const trade = await enrichTradeWithSlotRows(full[0], parseFullTrade);
      if (slot >= trade.topup_tiers.length) {
        return res.status(400).json({ error: `This session only has slots 0–${trade.topup_tiers.length - 1}` });
      }

      const openIn = req.body?.open_time ?? req.body?.open;
      const closeIn = req.body?.close_time ?? req.body?.close;
      if (openIn == null || closeIn == null || String(openIn).trim() === '' || String(closeIn).trim() === '') {
        return res.status(400).json({ error: 'Send both open_time and close_time for this slot' });
      }
      const openH = toMySqlTime(openIn, 12, 0);
      const closeH = toMySqlTime(closeIn, 13, 0);
      if (closeH <= openH) {
        return res.status(400).json({ error: `Slot ${slot}: close time must be after open time (IST).` });
      }

      let amount = trade.topup_tiers[slot];
      if (req.body?.amount !== undefined && req.body?.amount !== null && req.body?.amount !== '') {
        const n = Number(req.body.amount);
        amount = Number.isFinite(n) && n >= 0 ? n : amount;
      }
      let tradeName = trade.slot_windows[slot]?.trade_name ?? null;
      let description = trade.slot_windows[slot]?.description ?? null;
      if (req.body?.trade_name !== undefined) {
        const s = req.body.trade_name == null ? '' : String(req.body.trade_name).trim();
        tradeName = s || null;
      }
      if (req.body?.description !== undefined) {
        const s = req.body.description == null ? '' : String(req.body.description).trim();
        description = s || null;
      }

      const saved = await upsertSlotRow(full[0].id, slot, {
        open_time: openH,
        close_time: closeH,
        amount,
        trade_name: tradeName,
        description,
      });
      await reopenSlotIfExtended(full[0].id, slot);
      const newStatus = await reconcileSessionStatusFromSlots(full[0].id);
      const slotRows = await fetchSlotRows(full[0].id);
      const windows = slotRows.map((r) => ({
        open_time: sqlTimeToHms(r.open_time),
        close_time: sqlTimeToHms(r.close_time),
        trade_name: r.trade_name ?? null,
        description: r.description ?? null,
        status: r.status,
      }));
      const tiers = slotRows.map((r) => Number(r.amount ?? 0));
      const env = sessionEnvelope(windows);

      let message = `Slot ${slot} saved (roi_trade_slots row).`;
      if (full[0].status === 'closed' && newStatus !== 'closed') {
        message +=
          newStatus === 'open'
            ? ' Session reopened — members can join this slot window.'
            : ' Session rescheduled — slot will auto-open at its IST time.';
      }

      res.json({
        message,
        status: newStatus,
        slot,
        slot_row: saved,
        slot_window: windows[slot],
        slot_windows: windows,
        topup_tiers: tiers,
        open_time: env.sessionOpen,
        close_time: env.sessionClose,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  exports.openRoiTrade = async (req, res) => {
    try {
      const { dateStr } = istNow();
      const [alreadyOpen] = await db.query(
        `SELECT id FROM roi_trades WHERE trade_date = ? AND status = 'open' LIMIT 1`,
        [dateStr]
      );
      if (alreadyOpen.length) {
        return res.status(400).json({ error: 'Trade already open for today' });
      }

      const [sched] = await db.query(
        `SELECT id FROM roi_trades WHERE trade_date = ? AND status = 'scheduled' ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      if (sched.length) {
        await db.query(`UPDATE roi_trades SET status = 'open' WHERE id = ?`, [sched[0].id]);
        return res.json({ message: 'trade session opened — members can join', trade_id: sched[0].id });
      }

      const openT = toMySqlTime(req.body?.open_time, 12, 0);
      const closeT = toMySqlTime(req.body?.close_time, 13, 0);
      const swIn = normalizeSlotWindowsInput(req.body, openT, closeT);
      if (swIn.error) {
        return res.status(400).json({ error: swIn.error });
      }
      const { slotWindows, envelope, topupTiers } = swIn;
      const tradeName = tradeNameFromBody(req.body);
      const tradeDesc = tradeDescriptionFromBody(req.body);
      const tiersJson = JSON.stringify(topupTiers);
      const swJson = JSON.stringify(slotWindows);
      const [result] = await db.query(
        `INSERT INTO roi_trades (trade_date, trade_name, description, opened_by, status, open_time, close_time, topup_tiers, slot_windows)
        VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
        [dateStr, tradeName, tradeDesc, req.user.id, envelope.sessionOpen, envelope.sessionClose, tiersJson, swJson]
      );
      res.json({ message: 'Trade Income created and opened', trade_id: result.insertId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  exports.closeRoiTrade = async (req, res) => {
    const r = await executeCloseRoiTrade(req.params.trade_id);
    if (!r.ok) return res.status(400).json({ error: r.message });
    res.json({ message: r.message });
  };

  const ALLOWED_PACKAGE_AMOUNTS = new Set([11, 22, 51, 101, 201, 501, 1001]);

  function parsePackagesQuery(q) {
    if (q == null || q === '') return null;
    const nums = String(q)
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && ALLOWED_PACKAGE_AMOUNTS.has(n));
    return nums.length ? [...new Set(nums)] : null;
  }

  function parseSlotsQuery(q, maxIdx) {
    if (q == null || q === '') return null;
    const cap = Math.min(MAX_ROI_SLOTS - 1, Math.max(0, Number(maxIdx) || 0));
    const nums = String(q)
      .split(',')
      .map((s) => parseInt(String(s).trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= cap);
    return nums.length ? [...new Set(nums)] : null;
  }

  /** Admin: full audit for one trade session (saved in `transactions` per member). Query: packages=11,101 & slots=0,1 */
  exports.getRoiDistributionReport = async (req, res) => {
    try {
      const tradeId = Number(req.params.id);
      const [tradeRows] = await db.query(
        `SELECT rt.*, a.username AS opened_by_name
        FROM roi_trades rt
        LEFT JOIN admins a ON rt.opened_by = a.id
        WHERE rt.id = ?`,
        [tradeId]
      );
      if (!tradeRows.length) return res.status(404).json({ error: 'Trade not found' });
      const trade = parseFullTrade(tradeRows[0]);
      const maxSlotIdx = Math.max(0, (trade.topup_tiers?.length ?? 1) - 1);

      const pkgFilter = parsePackagesQuery(req.query.packages);
      const slotFilter = parseSlotsQuery(req.query.slots, maxSlotIdx);
      const filterActive = Boolean((pkgFilter && pkgFilter.length) || (slotFilter && slotFilter.length));

      let participantSql = `
        SELECT p.member_id, m.name, m.email, m.package_amount, m.plan_topup_count,
              p.topup_slot, p.joined_at, p.roi_settled_at
        FROM roi_trade_participants p
        JOIN members m ON m.id = p.member_id
        WHERE p.roi_trade_id = ?`;
      const participantParams = [tradeId];
      if (pkgFilter?.length) {
        participantSql += ` AND m.package_amount IN (${pkgFilter.map(() => '?').join(',')})`;
        participantParams.push(...pkgFilter);
      }
      if (slotFilter?.length) {
        participantSql += ` AND p.topup_slot IN (${slotFilter.map(() => '?').join(',')})`;
        participantParams.push(...slotFilter);
      }
      participantSql += ' ORDER BY p.joined_at';
      const [participants] = await db.query(participantSql, participantParams);

      const filteredMemberIds = participants.map((p) => p.member_id);

      let roiSql = `
        SELECT t.member_id, m.name, m.email, m.package_amount,
              t.amount AS roi_amount, t.txn_id, t.created_at
        FROM transactions t
        JOIN members m ON m.id = t.member_id
        WHERE t.reference_type = 'roi_trade' AND t.reference_id = ? AND t.income_type = 'roi_income'`;
      const roiParams = [tradeId];
      if (filterActive) {
        if (!filteredMemberIds.length) {
          roiSql += ' AND 1=0';
        } else {
          roiSql += ` AND t.member_id IN (${filteredMemberIds.map(() => '?').join(',')})`;
          roiParams.push(...filteredMemberIds);
        }
      }
      roiSql += ' ORDER BY m.name';
      const [roiPaid] = await db.query(roiSql, roiParams);

      let levelSql = `
        SELECT t.member_id, m.name, m.email, m.package_amount,
              SUM(t.amount) AS level_total
        FROM transactions t
        JOIN members m ON m.id = t.member_id
        WHERE t.reference_type = 'roi_trade' AND t.reference_id = ? AND t.income_type = 'level_income'`;
      const levelParams = [tradeId];
      if (filterActive) {
        if (!filteredMemberIds.length) {
          levelSql += ' AND 1=0';
        } else {
          levelSql += ` AND t.from_member_id IS NOT NULL AND t.from_member_id IN (${filteredMemberIds.map(() => '?').join(',')})`;
          levelParams.push(...filteredMemberIds);
        }
      }
      levelSql += ' GROUP BY t.member_id, m.name, m.email, m.package_amount ORDER BY m.name';
      const [levelPaid] = await db.query(levelSql, levelParams);

      const [[tRoi]] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
        WHERE reference_type = 'roi_trade' AND reference_id = ? AND income_type = 'roi_income'`,
        [tradeId]
      );
      const [[tLvl]] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
        WHERE reference_type = 'roi_trade' AND reference_id = ? AND income_type = 'level_income'`,
        [tradeId]
      );

      const [metaRows] = await db.query(
        `SELECT COUNT(DISTINCT p.member_id) AS n_joined,
                GROUP_CONCAT(DISTINCT m.package_amount ORDER BY m.package_amount) AS pkgs,
                GROUP_CONCAT(DISTINCT p.topup_slot ORDER BY p.topup_slot) AS slots
        FROM roi_trade_participants p
        JOIN members m ON m.id = p.member_id
        WHERE p.roi_trade_id = ?`,
        [tradeId]
      );
      const meta0 = metaRows[0] || {};
      const distinctPackages = String(meta0.pkgs || '')
        .split(',')
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n));
      const distinctSlots = String(meta0.slots || '')
        .split(',')
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isInteger(n));

      const roiFilteredSum = roiPaid.reduce((s, r) => s + Number(r.roi_amount || 0), 0);
      const levelFilteredSum = levelPaid.reduce((s, r) => s + Number(r.level_total || 0), 0);

      res.json({
        trade,
        participants,
        roiPaidToMembers: roiPaid,
        levelIncomeByMember: levelPaid,
        totalsFromLedger: {
          roi_to_participants: Number(tRoi?.s ?? 0),
          level_income_total: Number(tLvl?.s ?? 0),
          distribution_grand_total: Number(tRoi?.s ?? 0) + Number(tLvl?.s ?? 0),
        },
        filter: {
          active: filterActive,
          packages: pkgFilter,
          slots: slotFilter,
        },
        filteredTotals: {
          participant_count: participants.length,
          roi_paid_sum: roiFilteredSum,
          level_income_sum: levelFilteredSum,
          distribution_sum: roiFilteredSum + levelFilteredSum,
        },
        sessionMeta: {
          total_participants: Number(meta0.n_joined ?? 0),
          distinct_packages: distinctPackages,
          distinct_slots: distinctSlots,
          max_slot_index: maxSlotIdx,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  exports.getRoiTrades = async (req, res) => {
    try {
      const [trades] = await db.query(
        `SELECT rt.*, a.username as opened_by_name
        FROM roi_trades rt LEFT JOIN admins a ON rt.opened_by=a.id
        ORDER BY rt.created_at DESC LIMIT 30`
      );
      res.json(trades.map(parseFullTrade));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  async function slotParticipantStats(tradeId, tierLen) {
    const joined = new Array(tierLen).fill(0);
    const pending = new Array(tierLen).fill(0);
    if (!tierLen || !tradeId) return { slotJoinedCounts: joined, slotPendingCounts: pending };
    const [rows] = await db.query(
      `SELECT topup_slot AS s,
              COUNT(*) AS total,
              SUM(CASE WHEN roi_settled_at IS NULL THEN 1 ELSE 0 END) AS pend
      FROM roi_trade_participants WHERE roi_trade_id = ? GROUP BY topup_slot`,
      [tradeId]
    );
    for (const r of rows) {
      const s = Number(r.s);
      if (s >= 0 && s < tierLen) {
        joined[s] = Number(r.total ?? 0);
        pending[s] = Number(r.pend ?? 0);
      }
    }
    return { slotJoinedCounts: joined, slotPendingCounts: pending };
  }

  exports.getTodayRoiTrade = async (req, res) => {
    try {
      await exports.maybeTickRoiAutomation();
      await ensureTodayRoiFromPreviousSession();
      const { dateStr } = istNow();
      const [rows] = await db.query(
        `SELECT * FROM roi_trades WHERE trade_date = ? ORDER BY id DESC LIMIT 1`,
        [dateStr]
      );
      const tradeRaw = rows[0];
      if (!tradeRaw) return res.json(null);
      await migrateTradeSlotsFromJson(tradeRaw, slotWindowsFromRow);
      const trade = await enrichTradeWithSlotRows(tradeRaw, parseFullTrade);
      const tierLen = trade.topup_tiers?.length ?? 0;
      const stats = await slotParticipantStats(trade.id, tierLen);

      const [[cnt]] = await db.query(
        `SELECT COUNT(*) AS n FROM roi_trade_participants WHERE roi_trade_id = ?`,
        [trade.id]
      );
      const [[lr]] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
        WHERE reference_type = 'roi_trade' AND reference_id = ? AND income_type = 'roi_income'`,
        [trade.id]
      );
      const [[ll]] = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
        WHERE reference_type = 'roi_trade' AND reference_id = ? AND income_type = 'level_income'`,
        [trade.id]
      );
      const participantCount = Number(cnt?.n ?? 0);
      const ledgerRoiPaid = Number(lr?.s ?? 0);
      const ledgerLevelPaid = Number(ll?.s ?? 0);

      return res.json({
        ...trade,
        participantCount,
        ledgerRoiPaid,
        ledgerLevelPaid,
        ledgerDistributionTotal: ledgerRoiPaid + ledgerLevelPaid,
        ...stats,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  /** Roll up slot/plan from one day's Trade rows (admin reports). */
  function aggregateRoiRowsBySlot(rows) {
    const m = new Map();
    for (const r of rows || []) {
      const slot = r.topup_slot != null && r.topup_slot !== '' ? Number(r.topup_slot) : null;
      const key = Number.isInteger(slot) && slot >= 0 ? slot : -1;
      if (!m.has(key)) {
        m.set(key, {
          ladder_slot: key,
          roi_total_usd: 0,
          payout_count: 0,
          memberIds: new Set(),
        });
      }
      const x = m.get(key);
      x.roi_total_usd += Number(r.roi_amount || 0);
      x.payout_count += 1;
      x.memberIds.add(r.member_id);
    }
    return [...m.values()]
      .map((x) => ({
        ladder_slot: x.ladder_slot === -1 ? null : x.ladder_slot,
        label: x.ladder_slot === -1 ? '— no slot' : `Slot ${x.ladder_slot}`,
        roi_total_usd: parseFloat(x.roi_total_usd.toFixed(6)),
        payout_count: x.payout_count,
        unique_members: x.memberIds.size,
      }))
      .sort((a, b) => {
        const as = a.ladder_slot == null ? 999 : a.ladder_slot;
        const bs = b.ladder_slot == null ? 999 : b.ladder_slot;
        return as - bs;
      });
  }

  function aggregateRoiRowsByPlan(rows) {
    const m = new Map();
    for (const r of rows || []) {
      const pkg = Number(r.package_amount);
      const key = Number.isFinite(pkg) ? pkg : -1;
      if (!m.has(key)) {
        m.set(key, {
          package_amount: key === -1 ? null : key,
          roi_total_usd: 0,
          payout_count: 0,
          memberIds: new Set(),
        });
      }
      const x = m.get(key);
      x.roi_total_usd += Number(r.roi_amount || 0);
      x.payout_count += 1;
      x.memberIds.add(r.member_id);
    }
    return [...m.values()]
      .map((x) => ({
        package_amount: x.package_amount,
        roi_total_usd: parseFloat(x.roi_total_usd.toFixed(6)),
        payout_count: x.payout_count,
        unique_members: x.memberIds.size,
      }))
      .sort((a, b) => {
        const ap = Number(a.package_amount ?? -999);
        const bp = Number(b.package_amount ?? -999);
        return ap - bp;
      });
  }

  exports.getAdminRoiReportByDay = async (req, res) => {
    try {
      const dateStr = String(req.query.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: 'date=YYYY-MM-DD (Trade credit din, Asia/Kolkata)' });
      }

      const [rows] = await db.query(
        `SELECT t.member_id, m.name, m.email, m.package_amount, m.plan_topup_count,
                t.amount AS roi_amount, t.txn_id, t.created_at, t.description AS txn_desc,
                t.reference_id AS roi_trade_id,
                rt.trade_date AS session_trade_date,
                rt.trade_name AS session_name,
                rtp.topup_slot AS ladder_slot
        FROM transactions t
        JOIN members m ON m.id = t.member_id
        LEFT JOIN roi_trades rt ON rt.id = t.reference_id
        LEFT JOIN roi_trade_participants rtp
          ON rtp.roi_trade_id = t.reference_id AND rtp.member_id = t.member_id
        WHERE t.income_type = 'roi_income' AND t.reference_type = 'roi_trade'
          AND DATE(CONVERT_TZ(t.created_at, '+00:00', '+05:30')) = ?
        ORDER BY t.created_at ASC, m.name ASC`,
        [dateStr]
      );

      let roiSum = 0;
      const rowObjs = [];
      const members = rows.map((r) => {
        const amt = Number(r.roi_amount || 0);
        roiSum += amt;
        const topup_slot = ladderSlotForReportRow(r.ladder_slot, r.txn_desc);
        const o = {
          member_id: r.member_id,
          name: r.name,
          email: r.email,
          package_amount: Number(r.package_amount),
          plan_topup_count: r.plan_topup_count,
          topup_slot,
          roi_amount: amt,
          txn_id: r.txn_id,
          credited_at: r.created_at,
          roi_trade_id: r.roi_trade_id,
          session_trade_date: r.session_trade_date,
          session_name: r.session_name,
        };
        rowObjs.push({ ...o, roi_amount: amt });
        return o;
      });

      res.json({
        date: dateStr,
        timezone: 'Asia/Kolkata (credit timestamp UTC → IST date)',
        uniqueMembers: new Set(members.map((m) => m.member_id)).size,
        payoutRows: members.length,
        roiTotalUsd: parseFloat(roiSum.toFixed(6)),
        members,
        by_slot: aggregateRoiRowsBySlot(rowObjs),
        by_plan: aggregateRoiRowsByPlan(rowObjs),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  function monthPadYm(year, month, day) {
    const p = (n) => String(n).padStart(2, '0');
    return `${year}-${p(month)}-${p(day)}`;
  }

  /** Per member total Trade for one day (sum of multiple credits). */
  function summarizeMembersForDay(payoutRows) {
    const map = new Map();
    for (const r of payoutRows || []) {
      const id = r.member_id;
      const amt = Number(r.roi_amount || 0);
      if (!map.has(id)) {
        map.set(id, {
          member_id: id,
          name: r.name,
          email: r.email,
          package_amount: Number(r.package_amount),
          plan_topup_count: r.plan_topup_count,
          roi_total_usd: 0,
          credit_rows: 0,
        });
      }
      const x = map.get(id);
      x.roi_total_usd = parseFloat((x.roi_total_usd + amt).toFixed(6));
      x.credit_rows += 1;
    }
    return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  /**
   * Admin: Trade trade total per IST calendar day (`roi_income` credits).
   * Query: year=2026 & month=5
   * Each day: `members` (each credit row) + `member_summary` (member-wise totals).
   */
  exports.getAdminRoiReportMonthly = async (req, res) => {
    try {
      const year = parseInt(req.query.year, 10);
      const month = parseInt(req.query.month, 10);
      if (!Number.isInteger(year) || year < 2020 || year > 2100) {
        return res.status(400).json({ error: 'year invalid' });
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: 'month=1..12' });
      }

      const lastDay = new Date(year, month, 0).getDate();
      const start = monthPadYm(year, month, 1);
      const end = monthPadYm(year, month, lastDay);

      const [agg] = await db.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(t.created_at, '+00:00', '+05:30'), '%Y-%m-%d') AS d,
                COALESCE(SUM(t.amount), 0) AS roi_total,
                COUNT(*) AS payout_count,
                COUNT(DISTINCT t.member_id) AS unique_members
        FROM transactions t
        WHERE t.income_type = 'roi_income' AND t.reference_type = 'roi_trade'
          AND DATE(CONVERT_TZ(t.created_at, '+00:00', '+05:30')) BETWEEN ? AND ?
        GROUP BY DATE_FORMAT(CONVERT_TZ(t.created_at, '+00:00', '+05:30'), '%Y-%m-%d')
        ORDER BY d ASC`,
        [start, end]
      );

      const [detailRows] = await db.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(t.created_at, '+00:00', '+05:30'), '%Y-%m-%d') AS ist_date,
                t.member_id, m.name, m.email, m.package_amount, m.plan_topup_count,
                t.amount AS roi_amount, t.txn_id, t.created_at, t.description AS txn_desc,
                t.reference_id AS roi_trade_id,
                rt.trade_date AS session_trade_date,
                rt.trade_name AS session_name,
                rtp.topup_slot AS ladder_slot
        FROM transactions t
        JOIN members m ON m.id = t.member_id
        LEFT JOIN roi_trades rt ON rt.id = t.reference_id
        LEFT JOIN roi_trade_participants rtp
          ON rtp.roi_trade_id = t.reference_id AND rtp.member_id = t.member_id
        WHERE t.income_type = 'roi_income' AND t.reference_type = 'roi_trade'
          AND DATE(CONVERT_TZ(t.created_at, '+00:00', '+05:30')) BETWEEN ? AND ?
        ORDER BY ist_date ASC, t.created_at ASC, m.name ASC`,
        [start, end]
      );

      /** Flat ledger for UI filters (slot/plan). */
      const ledger = detailRows.map((r) => ({
        ist_date: String(r.ist_date || '').slice(0, 10),
        member_id: r.member_id,
        name: r.name,
        email: r.email,
        package_amount: Number(r.package_amount),
        plan_topup_count: r.plan_topup_count,
        topup_slot: ladderSlotForReportRow(r.ladder_slot, r.txn_desc),
        roi_amount: Number(r.roi_amount),
        txn_id: r.txn_id,
        credited_at: r.created_at,
        roi_trade_id: r.roi_trade_id,
        session_trade_date: r.session_trade_date,
        session_name: r.session_name,
      }));

      const membersByDate = {};
      for (const row of ledger) {
        const dk = row.ist_date;
        if (!membersByDate[dk]) membersByDate[dk] = [];
        membersByDate[dk].push({
          member_id: row.member_id,
          name: row.name,
          email: row.email,
          package_amount: row.package_amount,
          plan_topup_count: row.plan_topup_count,
          topup_slot: row.topup_slot,
          roi_amount: row.roi_amount,
          txn_id: row.txn_id,
          credited_at: row.credited_at,
          roi_trade_id: row.roi_trade_id,
          session_trade_date: row.session_trade_date,
          session_name: row.session_name,
        });
      }

      const byKey = {};
      for (const r of agg) {
        const dk = String(r.d || '').slice(0, 10);
        const txs = membersByDate[dk] || [];
        byKey[dk] = {
          date: dk,
          roi_total: Number(r.roi_total),
          payout_count: Number(r.payout_count),
          unique_members: Number(r.unique_members),
          members: txs,
          member_summary: summarizeMembersForDay(txs),
        };
      }

      const days = [];
      let monthRoiTotal = 0;
      let monthPayoutRows = 0;
      for (let day = 1; day <= lastDay; day++) {
        const ds = monthPadYm(year, month, day);
        if (byKey[ds]) {
          days.push(byKey[ds]);
        } else {
          days.push({
            date: ds,
            roi_total: 0,
            payout_count: 0,
            unique_members: 0,
            members: [],
            member_summary: [],
          });
        }
        monthRoiTotal += days[days.length - 1].roi_total;
        monthPayoutRows += days[days.length - 1].payout_count;
      }

      res.json({
        year,
        month,
        monthLabel: `${year}-${String(month).padStart(2, '0')}`,
        range: { start, end },
        timezone: 'Asia/Kolkata (daily bucket = IST date of credit)',
        days,
        ledger,
        by_plan_month: aggregateRoiRowsByPlan(ledger),
        monthSummary: {
          roi_total_usd: parseFloat(monthRoiTotal.toFixed(6)),
          payout_row_count: monthPayoutRows,
          days_with_payout: agg.length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  /** Startup: JSON slot_windows → roi_trade_slots rows (ek baar per trade). */
  exports.migrateExistingRoiSlots = async () => {
    await migrateAllTradesFromJson(slotWindowsFromRow);
  };
