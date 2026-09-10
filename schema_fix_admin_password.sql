-- Fixes default admin so plain-text login "password" works (bcryptjs).
-- Run: mysql -u root -p crypto_mlm < backend/schema_fix_admin_password.sql
USE crypto_mlm;
UPDATE admins SET password = '$2a$10$XfhbLh37OFLi5/pQ3Bc2Zewt.esho5Y64gr1fSRd20Yp7WR2JhHs6' WHERE email = 'admin@cryptomlm.com';
