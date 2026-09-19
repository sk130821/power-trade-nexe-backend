#!/usr/bin/env node
/**
 * Local SMTP check — does not touch OTP tables.
 *
 *   SMTP_DEBUG=1 node scripts/test-smtp.js you@example.com
 *   npm run test:smtp -- you@example.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run test:smtp -- recipient@email.com');
  process.exit(1);
}

const { getSmtpConfig, getMailFrom, verifySmtpConnection, sendMail } = require('../utils/mail');

async function main() {
  const cfg = getSmtpConfig();
  if (!cfg) {
    console.error('Missing SMTP_HOST / SMTP_USER / SMTP_PASS in backend/.env');
    process.exit(1);
  }
  console.log('SMTP config:', {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.auth.user,
    from: getMailFrom(),
    debug: process.env.SMTP_DEBUG || '(off — set SMTP_DEBUG=1 for verbose nodemailer logs)',
  });

  await verifySmtpConnection();
  console.log('verify(): OK');

  const info = await sendMail({
    to,
    subject: 'Power Trade Nexus — SMTP test',
    html: '<p>If you see this, SMTP send from your machine works.</p>',
    text: 'If you see this, SMTP send from your machine works.',
  });
  console.log('sendMail(): OK', {
    messageId: info.messageId,
    response: info.response,
    accepted: info.accepted,
    rejected: info.rejected,
  });
  console.log(`Check inbox/spam for: ${to}`);
}

main().catch((e) => {
  console.error('SMTP test failed:', e.message);
  if (e.cause) console.error('cause:', e.cause.message || e.cause);
  process.exit(1);
});
