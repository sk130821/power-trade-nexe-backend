-- One ROI session row per member per ladder slot (same day multiple joins).
-- Run once on existing DBs (schemaEnsure.js also applies this on server start).
--
-- InnoDB: cannot DROP the old UNIQUE if it is the only index supporting FK on roi_trade_id / member_id —
-- add dedicated indexes first, then DROP, then ADD new UNIQUE.

ALTER TABLE roi_trade_participants ADD INDEX idx_rtp_roi_trade_id (roi_trade_id);
ALTER TABLE roi_trade_participants ADD INDEX idx_rtp_member_id (member_id);
ALTER TABLE roi_trade_participants DROP INDEX uq_roi_trade_member;
ALTER TABLE roi_trade_participants
  ADD UNIQUE KEY uq_roi_trade_member_slot (roi_trade_id, member_id, topup_slot);
