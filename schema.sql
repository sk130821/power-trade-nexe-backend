-- Crypto MLM Database Schema v2 (Updated)
CREATE DATABASE IF NOT EXISTS crypto_mlm;
USE crypto_mlm;

-- Admin table
CREATE TABLE IF NOT EXISTS admins (
  id INT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(191) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  metamask_address VARCHAR(255),
  metamask_qr_image VARCHAR(500) DEFAULT NULL COMMENT 'QR/barcode image filename for MetaMask address',
  login_popup_video VARCHAR(500) DEFAULT NULL COMMENT 'Member login welcome video filename',
  login_popup_image VARCHAR(500) DEFAULT NULL COMMENT 'Member login image popup after video',
  cod_details TEXT,
  web3_chain_id INT UNSIGNED NULL COMMENT 'MetaMask network chainId; overrides WEB3_CHAIN_ID when set',
  web3_payment_token VARCHAR(100) NULL COMMENT 'ERC20 0x...; overrides WEB3_PAYMENT_TOKEN when set',
  web3_token_decimals SMALLINT UNSIGNED NULL COMMENT 'overrides WEB3_TOKEN_DECIMALS when set',
  web3_native_usd_price DECIMAL(20,8) NULL COMMENT '1 native coin in USD; overrides WEB3_NATIVE_USD_PRICE when set',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Members table (3 wallets: exchange, trading, salary)
CREATE TABLE IF NOT EXISTS members (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(191) UNIQUE NOT NULL,
  contact VARCHAR(20) NOT NULL,
  aadhaar_no VARCHAR(20) UNIQUE NOT NULL,
  password VARCHAR(255) DEFAULT NULL,
  aadhaar_photo VARCHAR(500),
  dob DATE NOT NULL,
  sponsor_id INT,
  referral_code VARCHAR(20) UNIQUE,
  package_amount DECIMAL(10,2) NOT NULL,
  plan_topup_count TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0=plan only, each approved plan top-up +1, max 8 → ROI slot capping at 8',
  status ENUM('pending','active','rejected') DEFAULT 'pending',
  activated_at DATETIME NULL COMMENT 'When member status became active',

  exchange_wallet  DECIMAL(15,4) DEFAULT 0,
  trading_wallet   DECIMAL(15,4) DEFAULT 0,
  salary_wallet    DECIMAL(15,4) DEFAULT 0,

  total_roi_income     DECIMAL(15,4) DEFAULT 0,
  total_direct_income  DECIMAL(15,4) DEFAULT 0,
  total_level_income   DECIMAL(15,4) DEFAULT 0,
  total_salary_income  DECIMAL(15,4) DEFAULT 0,
  total_trading_income DECIMAL(15,4) DEFAULT 0,
  total_reward_income  DECIMAL(15,4) DEFAULT 0,
  total_level_monthly_salary  DECIMAL(15,4) DEFAULT 0,
  total_direct_monthly_salary DECIMAL(15,4) DEFAULT 0,
  total_daily_bonus_income    DECIMAL(15,4) DEFAULT 0,
  lifetime_rank VARCHAR(255) NULL COMMENT 'Highest approved Life Time Reward rank',
  total_income         DECIMAL(15,4) DEFAULT 0,

  income_cap_base DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'Plan + topups — base for 2x/3x income cap (excludes day trade)',
  capped_income_floor DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'Capped-income snapshot at last top-up cycle start',

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  wallet_address VARCHAR(42) DEFAULT NULL COMMENT 'Member MetaMask — withdrawals & verification',
  FOREIGN KEY (sponsor_id) REFERENCES members(id) ON DELETE SET NULL
);

-- CENTRAL TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  txn_id VARCHAR(50) UNIQUE NOT NULL,
  income_type ENUM('roi_income','direct_income','level_income','salary_income','trading_income','reward_income','level_monthly_salary','direct_monthly_salary','daily_bonus_income') NOT NULL,
  wallet_type ENUM('exchange_wallet','trading_wallet','salary_wallet') NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  description TEXT,
  reference_id INT DEFAULT NULL,
  reference_type VARCHAR(50) DEFAULT NULL,
  from_member_id INT DEFAULT NULL,
  level_no INT DEFAULT NULL,
  status ENUM('credited','pending','failed') DEFAULT 'credited',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (from_member_id) REFERENCES members(id) ON DELETE SET NULL
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  payment_type ENUM('cod','metamask') NOT NULL,
  transaction_id VARCHAR(255),
  receipt_image VARCHAR(500),
  amount DECIMAL(10,2) NOT NULL,
  remark TEXT,
  status ENUM('pending','approved','rejected') DEFAULT 'pending',
  payment_for VARCHAR(40) DEFAULT NULL COMMENT 'registration | trading_topup | plan_topup',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

-- ROI Trades table
CREATE TABLE IF NOT EXISTS roi_trades (
  id INT PRIMARY KEY AUTO_INCREMENT,
  trade_date DATE NOT NULL,
  trade_name VARCHAR(255) NOT NULL DEFAULT 'Daily ROI Session',
  description TEXT,
  open_time TIME DEFAULT '12:00:00',
  close_time TIME DEFAULT '13:00:00',
  topup_tiers LONGTEXT COMMENT 'JSON array [9] topup amounts slots 0-8 (MariaDB-safe)',
  slot_windows LONGTEXT COMMENT 'JSON [{open_time,close_time}] x9 per-slot join windows IST',
  status ENUM('scheduled','open','closed') NOT NULL DEFAULT 'scheduled',
  total_distributed DECIMAL(15,4) DEFAULT 0,
  opened_by INT,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- One row per ROI ladder slot (name, note, open/close IST, amount, status)
CREATE TABLE IF NOT EXISTS roi_trade_slots (
  id INT PRIMARY KEY AUTO_INCREMENT,
  roi_trade_id INT NOT NULL,
  slot_index TINYINT UNSIGNED NOT NULL,
  trade_name VARCHAR(255) NULL,
  description TEXT NULL,
  open_time TIME NOT NULL DEFAULT '12:00:00',
  close_time TIME NOT NULL DEFAULT '13:00:00',
  amount DECIMAL(15,4) NOT NULL DEFAULT 0,
  status ENUM('scheduled','open','closed') NOT NULL DEFAULT 'scheduled',
  closed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roi_trade_slot (roi_trade_id, slot_index),
  KEY idx_rts_trade (roi_trade_id),
  FOREIGN KEY (roi_trade_id) REFERENCES roi_trades(id) ON DELETE CASCADE
);

-- Per plan/retopup income cap cycle (12 slots, unlimited retopups — slot = cycle_level % 12)
CREATE TABLE IF NOT EXISTS member_income_cycles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  cycle_level SMALLINT UNSIGNED NOT NULL COMMENT '0=plan, 1+=retopup',
  slot_index TINYINT UNSIGNED NOT NULL COMMENT 'cycle_level % 12',
  cap_base DECIMAL(15,4) NOT NULL DEFAULT 0,
  capped_earned DECIMAL(15,4) NOT NULL DEFAULT 0,
  cap_closed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_member_cycle (member_id, cycle_level),
  KEY idx_mic_member_slot (member_id, slot_index, cap_closed),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

-- Who joined today's open ROI session (only these members get ROI when admin closes)
CREATE TABLE IF NOT EXISTS roi_trade_participants (
  id INT PRIMARY KEY AUTO_INCREMENT,
  roi_trade_id INT NOT NULL,
  member_id INT NOT NULL,
  topup_slot TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'ROI ladder slot 0-8 at join / sync time',
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  roi_settled_at TIMESTAMP NULL DEFAULT NULL COMMENT 'ROI credited for this session row',
  KEY idx_rtp_roi_trade_id (roi_trade_id),
  KEY idx_rtp_member_id (member_id),
  UNIQUE KEY uq_roi_trade_member_slot (roi_trade_id, member_id, topup_slot),
  FOREIGN KEY (roi_trade_id) REFERENCES roi_trades(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

-- Day Trades (exchange-style: LTP + OHLC + intraday chart JSON)
CREATE TABLE IF NOT EXISTS day_trades (
  id INT PRIMARY KEY AUTO_INCREMENT,
  trade_name VARCHAR(255) NOT NULL,
  trade_symbol VARCHAR(50),
  description TEXT,
  min_invest DECIMAL(10,2) DEFAULT 1.00,
  last_price DECIMAL(15,4) DEFAULT 0,
  open_price DECIMAL(15,4) DEFAULT NULL,
  day_high DECIMAL(15,4) DEFAULT NULL,
  day_low DECIMAL(15,4) DEFAULT NULL,
  change_pct DECIMAL(12,4) DEFAULT 0,
  chart_json TEXT DEFAULT NULL,
  status ENUM('active','inactive','completed') DEFAULT 'inactive',
  result ENUM('pending','doubled','zeroed') DEFAULT 'pending',
  is_winner TINYINT(1) DEFAULT 0,
  trade_date DATE,
  open_time TIME DEFAULT '09:00:00',
  close_time TIME DEFAULT '17:00:00',
  created_by INT,
  activated_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL
);

-- Member Day Trade Investments
CREATE TABLE IF NOT EXISTS day_trade_investments (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  day_trade_id INT NOT NULL,
  trade_name_at_buy VARCHAR(255) NULL,
  trade_symbol_at_buy VARCHAR(50) NULL,
  session_date_at_buy DATE NULL,
  invest_amount DECIMAL(15,4) NOT NULL,
  quantity DECIMAL(18,6) DEFAULT NULL,
  price_at_buy DECIMAL(15,4) DEFAULT NULL,
  result_amount DECIMAL(15,4) DEFAULT 0,
  status ENUM('active','doubled','zeroed') DEFAULT 'active',
  invested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id),
  FOREIGN KEY (day_trade_id) REFERENCES day_trades(id)
);

-- Salary records (admin assigns)
CREATE TABLE IF NOT EXISTS salary_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  month_year VARCHAR(10) NOT NULL,
  remark TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

-- Automated monthly salary entitlements (direct tiers)
CREATE TABLE IF NOT EXISTS member_salary_entitlements (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  program ENUM('level_monthly','direct_monthly') NOT NULL,
  tier_code VARCHAR(20) NOT NULL,
  tier_rank SMALLINT UNSIGNED NOT NULL,
  tier_label VARCHAR(120) NOT NULL,
  percent_rate DECIMAL(6,3) NOT NULL,
  status ENUM('active','superseded','expired') NOT NULL DEFAULT 'active',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_mse_member_program (member_id, program, status),
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

-- Idempotent monthly payout log
CREATE TABLE IF NOT EXISTS member_salary_payouts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  entitlement_id INT NOT NULL,
  member_id INT NOT NULL,
  period_yyyy_mm VARCHAR(7) NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  txn_id VARCHAR(50) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_entitlement_period (entitlement_id, period_yyyy_mm),
  KEY idx_msp_member (member_id),
  FOREIGN KEY (entitlement_id) REFERENCES member_salary_entitlements(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

-- Daily bonus: matched direct pairs within 12h (same package amount)
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
);

-- Reward records (admin assigns gift/cash/trophy)
CREATE TABLE IF NOT EXISTS reward_records (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  reward_title VARCHAR(255) NOT NULL,
  reward_description TEXT,
  reward_value DECIMAL(15,4) DEFAULT 0,
  reward_type ENUM('cash','gift','voucher','trophy') DEFAULT 'gift',
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

-- Member-facing notices (admin creates; active rows show in member panel)
CREATE TABLE IF NOT EXISTS member_notices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_by_admin_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
);

-- Withdrawal requests (member → MetaMask; admin marks paid after sending on-chain)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INT PRIMARY KEY AUTO_INCREMENT,
  member_id INT NOT NULL,
  wallet_type ENUM('exchange_wallet','trading_wallet','salary_wallet') NOT NULL,
  amount DECIMAL(15,4) NOT NULL,
  fee_percent DECIMAL(6,3) NOT NULL DEFAULT 12.000 COMMENT 'Portal fee % deducted from withdrawal',
  fee_amount DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'Portal fee in USD (amount * fee_percent)',
  net_amount DECIMAL(15,4) NOT NULL DEFAULT 0 COMMENT 'Amount paid to member after portal fee',
  destination_address VARCHAR(42) NOT NULL,
  status ENUM('pending','rejected','paid') NOT NULL DEFAULT 'pending',
  member_note TEXT,
  admin_note TEXT,
  payout_tx_hash VARCHAR(88) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (member_id) REFERENCES members(id)
);

-- Daily Growth Reward + Life Time Reward settings
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
);

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
);

-- Marketing website hero slider (admin uploads)
CREATE TABLE IF NOT EXISTS website_banners (
  id INT PRIMARY KEY AUTO_INCREMENT,
  image VARCHAR(500) NOT NULL,
  alt_text VARCHAR(255) NOT NULL DEFAULT 'Banner',
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
);

-- Insert default admin
INSERT INTO admins (username, email, password, metamask_address)
VALUES ('admin', 'admin@cryptomlm.com', '$2a$10$XfhbLh37OFLi5/pQ3Bc2Zewt.esho5Y64gr1fSRd20Yp7WR2JhHs6', '0xYourMetaMaskAddressHere')
ON DUPLICATE KEY UPDATE username='admin';
