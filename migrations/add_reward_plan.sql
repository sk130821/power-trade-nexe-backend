-- Daily Growth Reward + Life Time Reward (idempotent via schemaEnsure.js)

ALTER TABLE members
  ADD COLUMN lifetime_rank VARCHAR(255) NULL
  COMMENT 'Highest approved Life Time Reward rank'
  AFTER total_daily_bonus_income;

CREATE TABLE IF NOT EXISTS reward_plan_tiers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  program ENUM('daily_growth','lifetime') NOT NULL,
  sort_order INT NOT NULL DEFAULT 1,
  title VARCHAR(255) NOT NULL,
  gift_name VARCHAR(255) NOT NULL,
  gift_image VARCHAR(500) NULL,
  rank_name VARCHAR(255) NULL,
  min_directs INT NOT NULL DEFAULT 0,
  team_business DECIMAL(18,2) NOT NULL DEFAULT 0,
  cash_amount DECIMAL(15,4) NOT NULL DEFAULT 0,
  allows_cash TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reward_program_order (program, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS reward_claim_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  tier_id INT NOT NULL,
  program ENUM('daily_growth','lifetime') NOT NULL,
  choice ENUM('cash','gift') NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  cash_amount DECIMAL(15,4) NOT NULL DEFAULT 0,
  gift_name VARCHAR(255) NOT NULL,
  rank_name VARCHAR(255) NULL,
  directs_at_claim INT NOT NULL DEFAULT 0,
  team_business_at_claim DECIMAL(18,2) NOT NULL DEFAULT 0,
  admin_note TEXT NULL,
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rcr_member (member_id),
  KEY idx_rcr_tier (tier_id),
  KEY idx_rcr_status (status, program),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (tier_id) REFERENCES reward_plan_tiers(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES admins(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
