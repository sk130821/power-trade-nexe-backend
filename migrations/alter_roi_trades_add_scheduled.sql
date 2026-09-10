-- Add 'scheduled' so admin can create today's session before opening it for members.
USE crypto_mlm;

ALTER TABLE roi_trades
MODIFY COLUMN status ENUM('scheduled', 'open', 'closed') NOT NULL DEFAULT 'scheduled';
