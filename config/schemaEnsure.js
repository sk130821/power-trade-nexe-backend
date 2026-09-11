/**
 * Lightweight idempotent DDL for existing DBs (no separate migrate step needed).
 */
const db = require('./db');

let ensured = false;

async function ensureSchema() {
  if (ensured) return;
  try {
    const [cols] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'payments'
         AND COLUMN_NAME = 'payment_for'`,
    );
    if (Number(cols[0]?.c) === 0) {
      await db.query(
        `ALTER TABLE payments
         ADD COLUMN payment_for VARCHAR(40) NULL DEFAULT NULL
         COMMENT 'registration | trading_topup | plan_topup'
         AFTER status`,
      );
      console.log('[db] Added column payments.payment_for');
    }

    const [rpOldRows] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'roi_trade_participants'
         AND INDEX_NAME = 'uq_roi_trade_member'
         AND NON_UNIQUE = 0`,
    );
    if (Number(rpOldRows[0]?.c) > 0) {
      /** InnoDB uses indexes for FK lookups — the old UNIQUE(a,b) must not be dropped until separate indexes exist. */
      const [iTrade] = await db.query(
        `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'roi_trade_participants'
           AND INDEX_NAME = 'idx_rtp_roi_trade_id'`,
      );
      if (Number(iTrade[0]?.c) === 0) {
        await db.query(
          `ALTER TABLE roi_trade_participants ADD INDEX idx_rtp_roi_trade_id (roi_trade_id)`,
        );
        console.log('[db] Added idx_rtp_roi_trade_id (FK support before unique migration)');
      }
      const [iMem] = await db.query(
        `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'roi_trade_participants'
           AND INDEX_NAME = 'idx_rtp_member_id'`,
      );
      if (Number(iMem[0]?.c) === 0) {
        await db.query(
          `ALTER TABLE roi_trade_participants ADD INDEX idx_rtp_member_id (member_id)`,
        );
        console.log('[db] Added idx_rtp_member_id (FK support before unique migration)');
      }
      await db.query(`ALTER TABLE roi_trade_participants DROP INDEX uq_roi_trade_member`);
      console.log('[db] Dropped uq_roi_trade_member (per-slot ROI joins)');
    }
    const [rpNewRows] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'roi_trade_participants'
         AND INDEX_NAME = 'uq_roi_trade_member_slot'
         AND NON_UNIQUE = 0`,
    );
    if (Number(rpNewRows[0]?.c) === 0) {
      await db.query(
        `ALTER TABLE roi_trade_participants ADD UNIQUE KEY uq_roi_trade_member_slot (roi_trade_id, member_id, topup_slot)`,
      );
      console.log('[db] Added uq_roi_trade_member_slot');
    }

    const [noticeTbl] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_notices'`,
    );
    if (Number(noticeTbl[0]?.c) === 0) {
      await db.query(`
        CREATE TABLE member_notices (
          id INT PRIMARY KEY AUTO_INCREMENT,
          title VARCHAR(255) NOT NULL,
          body TEXT NOT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_by_admin_id INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
        )`);
      console.log('[db] Created member_notices');
    }

    const [mWal] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = 'wallet_address'`,
    );
    if (Number(mWal[0]?.c) === 0) {
      await db.query(
        `ALTER TABLE members ADD COLUMN wallet_address VARCHAR(42) NULL
         COMMENT 'Member MetaMask — withdrawals' AFTER created_at`,
      );
      console.log('[db] Added members.wallet_address');
    }

    const [wdrTbl] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'withdrawal_requests'`,
    );
    if (Number(wdrTbl[0]?.c) === 0) {
      await db.query(`
        CREATE TABLE withdrawal_requests (
          id INT PRIMARY KEY AUTO_INCREMENT,
          member_id INT NOT NULL,
          wallet_type ENUM('exchange_wallet','trading_wallet','salary_wallet') NOT NULL,
          amount DECIMAL(15,4) NOT NULL,
          fee_percent DECIMAL(6,3) NOT NULL DEFAULT 12.000,
          fee_amount DECIMAL(15,4) NOT NULL DEFAULT 0,
          net_amount DECIMAL(15,4) NOT NULL DEFAULT 0,
          destination_address VARCHAR(42) NOT NULL,
          status ENUM('pending','rejected','paid') NOT NULL DEFAULT 'pending',
          member_note TEXT,
          admin_note TEXT,
          payout_tx_hash VARCHAR(88) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (member_id) REFERENCES members(id)
        )`);
      console.log('[db] Created withdrawal_requests');
    }

    const withdrawalFeeCols = [
      {
        name: 'fee_percent',
        ddl: `ALTER TABLE withdrawal_requests ADD COLUMN fee_percent DECIMAL(6,3) NOT NULL DEFAULT 12.000
         COMMENT 'Portal fee % deducted from withdrawal' AFTER amount`,
      },
      {
        name: 'fee_amount',
        ddl: `ALTER TABLE withdrawal_requests ADD COLUMN fee_amount DECIMAL(15,4) NOT NULL DEFAULT 0
         COMMENT 'Portal fee in USD' AFTER fee_percent`,
      },
      {
        name: 'net_amount',
        ddl: `ALTER TABLE withdrawal_requests ADD COLUMN net_amount DECIMAL(15,4) NOT NULL DEFAULT 0
         COMMENT 'Amount paid to member after portal fee' AFTER fee_amount`,
      },
    ];
    for (const col of withdrawalFeeCols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'withdrawal_requests' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added withdrawal_requests.${col.name}`);
      }
    }
    // Backfill fee/net for any legacy rows created before the portal fee.
    await db.query(
      `UPDATE withdrawal_requests
       SET fee_amount = ROUND(amount * fee_percent / 100, 4),
           net_amount = ROUND(amount - (amount * fee_percent / 100), 4)
       WHERE net_amount <= 0`,
    );

    const [admQr] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'metamask_qr_image'`,
    );
    if (Number(admQr[0]?.c) === 0) {
      await db.query(
        `ALTER TABLE admins ADD COLUMN metamask_qr_image VARCHAR(500) NULL
         COMMENT 'QR/barcode for MetaMask address' AFTER metamask_address`,
      );
      console.log('[db] Added admins.metamask_qr_image');
    }

    const loginPopupCols = [
      {
        name: 'login_popup_video',
        ddl: `ALTER TABLE admins ADD COLUMN login_popup_video VARCHAR(500) NULL
         COMMENT 'Member login welcome video filename' AFTER metamask_qr_image`,
      },
      {
        name: 'login_popup_image',
        ddl: `ALTER TABLE admins ADD COLUMN login_popup_image VARCHAR(500) NULL
         COMMENT 'Member login image popup after video' AFTER login_popup_video`,
      },
    ];
    for (const col of loginPopupCols) {
      const [r] = await db.query(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(r[0]?.c) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added admins.${col.name}`);
      }
    }

    const web3Cols = [
      {
        name: 'web3_chain_id',
        ddl: `ALTER TABLE admins ADD COLUMN web3_chain_id INT UNSIGNED NULL
         COMMENT 'MetaMask chainId; overrides WEB3_CHAIN_ID' AFTER cod_details`,
      },
      {
        name: 'web3_payment_token',
        ddl: `ALTER TABLE admins ADD COLUMN web3_payment_token VARCHAR(100) NULL
         COMMENT 'ERC20 address; overrides WEB3_PAYMENT_TOKEN' AFTER web3_chain_id`,
      },
      {
        name: 'web3_token_decimals',
        ddl: `ALTER TABLE admins ADD COLUMN web3_token_decimals SMALLINT UNSIGNED NULL
         COMMENT 'overrides WEB3_TOKEN_DECIMALS' AFTER web3_payment_token`,
      },
      {
        name: 'web3_native_usd_price',
        ddl: `ALTER TABLE admins ADD COLUMN web3_native_usd_price DECIMAL(20,8) NULL
         COMMENT '1 native in USD; overrides WEB3_NATIVE_USD_PRICE' AFTER web3_token_decimals`,
      },
    ];
    for (const col of web3Cols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added admins.${col.name}`);
      }
    }

    const incomeCapCols = [
      {
        name: 'income_cap_base',
        ddl: `ALTER TABLE members ADD COLUMN income_cap_base DECIMAL(15,4) NOT NULL DEFAULT 0
         COMMENT 'Plan + topups — base for 2x/3x cap (excludes day trade)' AFTER total_income`,
      },
      {
        name: 'capped_income_floor',
        ddl: `ALTER TABLE members ADD COLUMN capped_income_floor DECIMAL(15,4) NOT NULL DEFAULT 0
         COMMENT 'Capped income total at last top-up cycle start' AFTER income_cap_base`,
      },
    ];
    for (const col of incomeCapCols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added members.${col.name}`);
      }
    }
    await db.query(
      `UPDATE members SET income_cap_base = package_amount
       WHERE status = 'active' AND COALESCE(income_cap_base, 0) <= 0`,
    );

    const roiCols = [
      {
        name: 'topup_tiers',
        ddl: `ALTER TABLE roi_trades ADD COLUMN topup_tiers LONGTEXT NULL
         COMMENT 'JSON array of ladder USD tiers' AFTER close_time`,
      },
      {
        name: 'slot_windows',
        ddl: `ALTER TABLE roi_trades ADD COLUMN slot_windows LONGTEXT NULL
         COMMENT 'JSON [{open_time,close_time,trade_name,description}] per slot' AFTER topup_tiers`,
      },
    ];
    for (const col of roiCols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roi_trades' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added roi_trades.${col.name}`);
      }
    }

    const [slotTable] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roi_trade_slots'`,
    );
    if (Number(slotTable[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE roi_trade_slots (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[db] Created roi_trade_slots table');
    }

    const [cycleTable] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_income_cycles'`,
    );
    if (Number(cycleTable[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE member_income_cycles (
          id INT PRIMARY KEY AUTO_INCREMENT,
          member_id INT NOT NULL,
          cycle_level SMALLINT UNSIGNED NOT NULL COMMENT '0=plan, 1+=retopup count',
          slot_index TINYINT UNSIGNED NOT NULL COMMENT 'cycle_level % 12',
          cap_base DECIMAL(15,4) NOT NULL DEFAULT 0,
          capped_earned DECIMAL(15,4) NOT NULL DEFAULT 0,
          cap_closed TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_member_cycle (member_id, cycle_level),
          KEY idx_mic_member_slot (member_id, slot_index, cap_closed),
          FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[db] Created member_income_cycles table');
    }

    const monthlySalaryCols = [
      {
        name: 'total_level_monthly_salary',
        ddl: `ALTER TABLE members ADD COLUMN total_level_monthly_salary DECIMAL(15,4) NOT NULL DEFAULT 0
         AFTER total_reward_income`,
      },
      {
        name: 'total_direct_monthly_salary',
        ddl: `ALTER TABLE members ADD COLUMN total_direct_monthly_salary DECIMAL(15,4) NOT NULL DEFAULT 0
         AFTER total_level_monthly_salary`,
      },
    ];
    for (const col of monthlySalaryCols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added members.${col.name}`);
      }
    }

    const [txnEnum] = await db.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'income_type'`,
    );
    const enumType = txnEnum[0]?.COLUMN_TYPE || '';
    if (enumType && !enumType.includes('daily_bonus_income')) {
      await db.query(
        `ALTER TABLE transactions MODIFY income_type
         ENUM('roi_income','direct_income','level_income','salary_income','trading_income','reward_income',
              'level_monthly_salary','direct_monthly_salary','daily_bonus_income') NOT NULL`,
      );
      console.log('[db] Extended transactions.income_type for daily_bonus_income');
    } else if (enumType && !enumType.includes('level_monthly_salary')) {
      await db.query(
        `ALTER TABLE transactions MODIFY income_type
         ENUM('roi_income','direct_income','level_income','salary_income','trading_income','reward_income',
              'level_monthly_salary','direct_monthly_salary') NOT NULL`,
      );
      console.log('[db] Extended transactions.income_type for monthly salaries');
    }

    // Hard guard against any double income: unique dedup_key on transactions.
    // Existing rows stay NULL (MySQL UNIQUE allows multiple NULLs), so adding
    // the index never fails on legacy/duplicate data.
    const [dedupCol] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'dedup_key'`,
    );
    if (Number(dedupCol[0]?.n) === 0) {
      await db.query(
        `ALTER TABLE transactions ADD COLUMN dedup_key VARCHAR(191) NULL
         COMMENT 'Idempotency key — blocks duplicate income at DB level' AFTER reference_type`,
      );
      console.log('[db] Added transactions.dedup_key');
    }
    const [dedupIdx] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
         AND INDEX_NAME = 'uq_txn_dedup_key' AND NON_UNIQUE = 0`,
    );
    if (Number(dedupIdx[0]?.n) === 0) {
      await db.query(
        `ALTER TABLE transactions ADD UNIQUE KEY uq_txn_dedup_key (dedup_key)`,
      );
      console.log('[db] Added uq_txn_dedup_key (duplicate income guard)');
    }

    const [mseTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_salary_entitlements'`,
    );
    if (Number(mseTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE member_salary_entitlements (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[db] Created member_salary_entitlements');
    }

    const [mspTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'member_salary_payouts'`,
    );
    if (Number(mspTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE member_salary_payouts (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[db] Created member_salary_payouts');
    }

    const dtiSnapshotCols = [
      {
        name: 'trade_name_at_buy',
        ddl: `ALTER TABLE day_trade_investments ADD COLUMN trade_name_at_buy VARCHAR(255) NULL AFTER day_trade_id`,
      },
      {
        name: 'trade_symbol_at_buy',
        ddl: `ALTER TABLE day_trade_investments ADD COLUMN trade_symbol_at_buy VARCHAR(50) NULL AFTER trade_name_at_buy`,
      },
      {
        name: 'session_date_at_buy',
        ddl: `ALTER TABLE day_trade_investments ADD COLUMN session_date_at_buy DATE NULL AFTER trade_symbol_at_buy`,
      },
    ];
    for (const col of dtiSnapshotCols) {
      const [has] = await db.query(
        `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'day_trade_investments' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(has[0]?.c) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added day_trade_investments.${col.name}`);
      }
    }

    const [dtDeleted] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'day_trades' AND COLUMN_NAME = 'deleted_at'`,
    );
    if (Number(dtDeleted[0]?.c) === 0) {
      await db.query(
        `ALTER TABLE day_trades ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER created_at`,
      );
      console.log('[db] Added day_trades.deleted_at (soft delete)');
    }

    await db.query(
      `UPDATE day_trade_investments dti
       INNER JOIN day_trades dt ON dt.id = dti.day_trade_id
       SET dti.trade_name_at_buy = COALESCE(NULLIF(dti.trade_name_at_buy, ''), dt.trade_name),
           dti.trade_symbol_at_buy = COALESCE(dti.trade_symbol_at_buy, dt.trade_symbol),
           dti.session_date_at_buy = COALESCE(dti.session_date_at_buy, dt.trade_date, DATE(dti.invested_at))
       WHERE dti.trade_name_at_buy IS NULL OR dti.trade_name_at_buy = ''`,
    );

    const [prtTbl] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'password_reset_tokens'`,
    );
    if (Number(prtTbl[0]?.c) === 0) {
      await db.query(
        `CREATE TABLE password_reset_tokens (
          id INT PRIMARY KEY AUTO_INCREMENT,
          member_id INT NOT NULL,
          token_hash VARCHAR(64) NOT NULL,
          expires_at DATETIME NOT NULL,
          used_at DATETIME NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_prt_member (member_id),
          INDEX idx_prt_hash (token_hash),
          FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
        )`,
      );
      console.log('[db] Created password_reset_tokens');
    }

    const [eocTbl] = await db.query(
      `SELECT COUNT(*) AS c FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_otp_challenges'`,
    );
    if (Number(eocTbl[0]?.c) === 0) {
      await db.query(
        `CREATE TABLE email_otp_challenges (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(191) NOT NULL,
          purpose ENUM('registration','withdrawal') NOT NULL,
          member_id INT NULL,
          otp_hash VARCHAR(64) NOT NULL,
          payload_json LONGTEXT NULL,
          expires_at DATETIME NOT NULL,
          used_at DATETIME NULL DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_eoc_email_purpose (email, purpose),
          INDEX idx_eoc_member (member_id),
          FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
        )`,
      );
      console.log('[db] Created email_otp_challenges');
    }

    const dailyBonusCols = [
      {
        name: 'activated_at',
        ddl: `ALTER TABLE members ADD COLUMN activated_at DATETIME NULL
         COMMENT 'When member status became active' AFTER status`,
      },
      {
        name: 'total_daily_bonus_income',
        ddl: `ALTER TABLE members ADD COLUMN total_daily_bonus_income DECIMAL(15,4) NOT NULL DEFAULT 0
         AFTER total_direct_monthly_salary`,
      },
    ];
    for (const col of dailyBonusCols) {
      const [c] = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (Number(c[0]?.n) === 0) {
        await db.query(col.ddl);
        console.log(`[db] Added members.${col.name}`);
      }
    }

    await db.query(
      `UPDATE members SET activated_at = created_at
       WHERE status = 'active' AND activated_at IS NULL`,
    );

    const [dbpTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_bonus_pairs'`,
    );
    if (Number(dbpTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE daily_bonus_pairs (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log('[db] Created daily_bonus_pairs');
    }

    const [ltRank] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'members' AND COLUMN_NAME = 'lifetime_rank'`,
    );
    if (Number(ltRank[0]?.n) === 0) {
      await db.query(
        `ALTER TABLE members ADD COLUMN lifetime_rank VARCHAR(255) NULL
         COMMENT 'Highest approved Life Time Reward rank'
         AFTER total_daily_bonus_income`,
      );
      console.log('[db] Added members.lifetime_rank');
    }

    const [rptTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reward_plan_tiers'`,
    );
    if (Number(rptTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE reward_plan_tiers (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      console.log('[db] Created reward_plan_tiers');
    }

    const [rcrTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reward_claim_requests'`,
    );
    if (Number(rcrTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE reward_claim_requests (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      console.log('[db] Created reward_claim_requests');
    }

    const { seedDefaultTiers } = require('../utils/rewardPlan');
    await seedDefaultTiers(db);

    const [wbTbl] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'website_banners'`,
    );
    if (Number(wbTbl[0]?.n) === 0) {
      await db.query(`
        CREATE TABLE website_banners (
          id INT PRIMARY KEY AUTO_INCREMENT,
          image VARCHAR(500) NOT NULL,
          alt_text VARCHAR(255) NOT NULL DEFAULT 'Banner',
          sort_order INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_by INT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES admins(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      console.log('[db] Created website_banners');
    }
  } catch (e) {
    console.error('[db] Schema ensure failed:', e.message);
    throw e;
  }
  ensured = true;
}

module.exports = { ensureSchema };
