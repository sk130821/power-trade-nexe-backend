-- Run once if your DB was created before ROI participation tracking.
USE crypto_mlm;

CREATE TABLE IF NOT EXISTS roi_trade_participants (
  id INT PRIMARY KEY AUTO_INCREMENT,
  roi_trade_id INT NOT NULL,
  member_id INT NOT NULL,
  topup_slot TINYINT UNSIGNED NOT NULL DEFAULT 0,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roi_trade_member_slot (roi_trade_id, member_id, topup_slot),
  FOREIGN KEY (roi_trade_id) REFERENCES roi_trades(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
