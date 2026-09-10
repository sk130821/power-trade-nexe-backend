-- Run once on existing DB that was created before member passwords
USE crypto_mlm;
ALTER TABLE members ADD COLUMN password VARCHAR(255) DEFAULT NULL AFTER aadhaar_no;
