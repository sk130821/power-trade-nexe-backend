-- Per-slot open/close (IST) join windows for ROI ladder
USE crypto_mlm;

ALTER TABLE roi_trades
  ADD COLUMN slot_windows LONGTEXT NULL COMMENT 'JSON [{open_time,close_time}] x9' AFTER topup_tiers;
