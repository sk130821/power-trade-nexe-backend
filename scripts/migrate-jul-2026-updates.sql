-- =============================================================================
-- Power Trade Nexus — Jul 2026 DB updates
-- Daily Bonus Income + activated_at + daily_bonus_pairs table
--
-- Run in phpMyAdmin / MySQL Workbench on database: crypto_mlm
-- If a step says "Duplicate column" — skip that step (already applied).
-- =============================================================================

USE crypto_mlm;

-- -----------------------------------------------------------------------------
-- 1) members.activated_at — when status became active (for 12h daily bonus window)
-- -----------------------------------------------------------------------------
ALTER TABLE members
  ADD COLUMN activated_at DATETIME NULL
  COMMENT 'When member status became active'
  AFTER status;

-- Backfill existing active members
UPDATE members
SET activated_at = created_at
WHERE status = 'active' AND activated_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2) members.total_daily_bonus_income — running total for daily bonus
-- -----------------------------------------------------------------------------
ALTER TABLE members
  ADD COLUMN total_daily_bonus_income DECIMAL(15,4) NOT NULL DEFAULT 0
  AFTER total_direct_monthly_salary;

-- -----------------------------------------------------------------------------
-- 3) transactions.income_type — add daily_bonus_income
-- (Run even if other types already exist — full ENUM list required)
-- -----------------------------------------------------------------------------
ALTER TABLE transactions MODIFY income_type
  ENUM(
    'roi_income',
    'direct_income',
    'level_income',
    'salary_income',
    'trading_income',
    'reward_income',
    'level_monthly_salary',
    'direct_monthly_salary',
    'daily_bonus_income'
  ) NOT NULL;

-- -----------------------------------------------------------------------------
-- 4) daily_bonus_pairs — tracks matched direct pairs (12h, same package)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_bonus_pairs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sponsor_id INT NOT NULL,
  member_a_id INT NOT NULL,
  member_b_id INT NOT NULL,
  package_amount DECIMAL(10,2) NOT NULL,
  bonus_amount DECIMAL(15,4) NOT NULL,
  txn_id VARCHAR(50) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bonus_pair (member_a_id, member_b_id),
  KEY idx_dbp_sponsor (sponsor_id),
  FOREIGN KEY (sponsor_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (member_a_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (member_b_id) REFERENCES members(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- 5) OPTIONAL — stop Level Monthly Salary (L1–L11) — feature removed in app
-- Uncomment if you want to expire any still-active level monthly entitlements:
-- -----------------------------------------------------------------------------
-- UPDATE member_salary_entitlements
-- SET status = 'expired', updated_at = NOW()
-- WHERE program = 'level_monthly' AND status = 'active';

-- -----------------------------------------------------------------------------
-- NOTE: Direct Monthly Salary new % (1/2/3/4) apply when member re-qualifies
-- or gets a new entitlement. Old active entitlements keep their stored percent_rate.
-- ROI $1001 (0.5%, slots 0+6) is code-only — no DB column change needed.
-- =============================================================================
