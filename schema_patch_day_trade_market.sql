-- Run once on DBs created before exchange-style day trades.
USE crypto_mlm;

ALTER TABLE day_trades
  ADD COLUMN last_price DECIMAL(15,4) DEFAULT 0 AFTER min_invest,
  ADD COLUMN open_price DECIMAL(15,4) DEFAULT NULL AFTER last_price,
  ADD COLUMN day_high DECIMAL(15,4) DEFAULT NULL AFTER open_price,
  ADD COLUMN day_low DECIMAL(15,4) DEFAULT NULL AFTER day_high,
  ADD COLUMN change_pct DECIMAL(12,4) DEFAULT 0 AFTER day_low,
  ADD COLUMN chart_json TEXT NULL AFTER change_pct;

ALTER TABLE day_trade_investments
  ADD COLUMN quantity DECIMAL(18,6) DEFAULT NULL AFTER invest_amount,
  ADD COLUMN price_at_buy DECIMAL(15,4) DEFAULT NULL AFTER quantity;
