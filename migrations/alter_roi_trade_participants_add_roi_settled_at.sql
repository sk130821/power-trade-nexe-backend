-- Per-slot / partial ROI payout tracking (NULL = not yet credited for this session row)
ALTER TABLE roi_trade_participants
  ADD COLUMN roi_settled_at TIMESTAMP NULL DEFAULT NULL
    COMMENT 'When this participant received ROI for this roi_trade_id' AFTER joined_at;
