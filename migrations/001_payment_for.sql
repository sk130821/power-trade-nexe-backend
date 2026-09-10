-- Existing DBs: add payment categorization for plan TOP-UP vs trading vs registration.
ALTER TABLE payments
  ADD COLUMN payment_for VARCHAR(40) NULL DEFAULT NULL
  COMMENT 'registration | trading_topup | plan_topup'
  AFTER status;
