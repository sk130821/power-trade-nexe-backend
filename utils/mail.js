const nodemailer = require('nodemailer');

let transporter = null;

function cleanEnv(v) {
  if (v == null) return '';
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s;
}

function getSmtpConfig() {
  const host = cleanEnv(process.env.SMTP_HOST);
  const user = cleanEnv(process.env.SMTP_USER);
  const pass = cleanEnv(process.env.SMTP_PASS);
  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE === 'false' || process.env.SMTP_SECURE === '0' ? false : port === 465;

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    ...(port === 587 && !secure ? { requireTLS: true } : {}),
  };
}

function getMailFrom() {
  const from = cleanEnv(process.env.SMTP_FROM);
  if (from) return from;
  const user = cleanEnv(process.env.SMTP_USER);
  return user ? `Power Trade Nexus <${user}>` : 'Power Trade Nexus';
}

function getTransporter() {
  if (transporter) return transporter;
  const cfg = getSmtpConfig();
  if (!cfg) return null;
  transporter = nodemailer.createTransport(cfg);
  return transporter;
}

function smtpErrorMessage(err) {
  const msg = String(err?.message || err || '');
  if (/535|authentication failed|invalid login/i.test(msg)) {
    return 'SMTP login failed — check cPanel email password and SMTP_USER (full email address).';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i.test(msg)) {
    return 'Cannot reach mail server — set SMTP_HOST to mail.yourdomain.com from cPanel → Email → Connect Devices.';
  }
  return msg;
}

async function sendMail({ to, subject, html, text }) {
  const tx = getTransporter();
  if (!tx) {
    throw new Error('Email is not configured on the server (SMTP_HOST / SMTP_USER / SMTP_PASS)');
  }
  try {
    await tx.sendMail({
      from: getMailFrom(),
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  } catch (err) {
    const wrapped = new Error(smtpErrorMessage(err));
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = { sendMail, getSmtpConfig, smtpErrorMessage };
