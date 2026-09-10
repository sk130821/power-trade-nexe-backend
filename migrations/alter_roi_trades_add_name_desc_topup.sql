-- ROI trade: name, description, 9 topup slots (0–8). Run once on existing DBs.
USE crypto_mlm;

ALTER TABLE roi_trades
  ADD COLUMN trade_name VARCHAR(255) NOT NULL DEFAULT 'Daily ROI Session' AFTER trade_date,
  ADD COLUMN description TEXT NULL AFTER trade_name,
  ADD COLUMN topup_tiers LONGTEXT NULL COMMENT 'JSON array [9] amounts for slots 0-8' AFTER close_time;
