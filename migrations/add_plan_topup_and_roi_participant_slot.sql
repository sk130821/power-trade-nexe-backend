-- Plan top-ups (ROI ladder 0-8) + participant slot snapshot. Run once.
USE crypto_mlm;

ALTER TABLE members
  ADD COLUMN plan_topup_count TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ROI slots 0-8';

ALTER TABLE roi_trade_participants
  ADD COLUMN topup_slot TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Slot 0-8 for session payout' AFTER member_id;
