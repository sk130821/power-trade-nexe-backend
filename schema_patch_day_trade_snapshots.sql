-- Day trade purchase snapshots + soft delete (auto-applied via schemaEnsure on server start).
USE crypto_mlm;

ALTER TABLE day_trade_investments
  ADD COLUMN IF NOT EXISTS trade_name_at_buy VARCHAR(255) NULL AFTER day_trade_id,
  ADD COLUMN IF NOT EXISTS trade_symbol_at_buy VARCHAR(50) NULL AFTER trade_name_at_buy,
  ADD COLUMN IF NOT EXISTS session_date_at_buy DATE NULL AFTER trade_symbol_at_buy;

ALTER TABLE day_trades
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL DEFAULT NULL AFTER created_at;

UPDATE day_trade_investments dti
INNER JOIN day_trades dt ON dt.id = dti.day_trade_id
SET dti.trade_name_at_buy = COALESCE(NULLIF(dti.trade_name_at_buy, ''), dt.trade_name),
    dti.trade_symbol_at_buy = COALESCE(dti.trade_symbol_at_buy, dt.trade_symbol),
    dti.session_date_at_buy = COALESCE(dti.session_date_at_buy, dt.trade_date, DATE(dti.invested_at))
WHERE dti.trade_name_at_buy IS NULL OR dti.trade_name_at_buy = '';
