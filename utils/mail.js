const nodemailer = require('nodemailer');
const { isSmtpDebug, smtpDebug } = require('./mailDebug');

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
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 12000,
    ...(port === 587 && !secure ? { requireTLS: true } : {}),
  };
}

/** Build RFC5322 From — fixes hosting panels that set SMTP_FROM to display name only. */
function getMailFrom() {
  const user = cleanEnv(process.env.SMTP_USER);
  const fromRaw = cleanEnv(process.env.SMTP_FROM);
  const defaultName = 'Power Trade Nexus';

  if (!fromRaw) {
    return user ? `${defaultName} <${user}>` : defaultName;
  }

  if (/<[^>]+@[^>]+>/.test(fromRaw)) {
    return fromRaw;
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromRaw)) {
    return `${defaultName} <${fromRaw}>`;
  }

  if (user && !fromRaw.includes('@')) {
    return `${fromRaw} <${user}>`;
  }

  return fromRaw;
}

function getTransporter() {
  if (transporter) return transporter;
  const cfg = getSmtpConfig();
  if (!cfg) return null;
  const verbose = String(process.env.SMTP_DEBUG_VERBOSE || '').trim().toLowerCase();
  const nodemailerVerbose = verbose === '1' || verbose === 'true';
  transporter = nodemailer.createTransport({
    ...cfg,
    ...(isSmtpDebug() && nodemailerVerbose ? { logger: true, debug: true } : {}),
  });
  if (isSmtpDebug()) {
    smtpDebug('transporter created', {
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      user: cfg.auth.user,
      from: getMailFrom(),
    });
  }
  return transporter;
}

function smtpErrorMessage(err) {
  const msg = String(err?.message || err || '');
  if (/535|authentication failed|invalid login/i.test(msg)) {
    return 'SMTP login failed — check cPanel email password and SMTP_USER (full email address).';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|Greeting never received/i.test(msg)) {
    return 'Cannot reach mail server — check SMTP_HOST, port 465 + SMTP_SECURE=true, or try port 587.';
  }
  return msg;
}

async function verifySmtpConnection() {
  const tx = getTransporter();
  if (!tx) {
    throw new Error('Email is not configured on the server (SMTP_HOST / SMTP_USER / SMTP_PASS)');
  }
  smtpDebug('verify() start');
  await tx.verify();
  smtpDebug('verify() OK');
  return true;
}

async function sendMail({ to, subject, html, text, headers }) {
  const tx = getTransporter();
  if (!tx) {
    throw new Error('Email is not configured on the server (SMTP_HOST / SMTP_USER / SMTP_PASS)');
  }
  const from = getMailFrom();
  const payload = {
    from,
    to,
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
  };
  smtpDebug('sendMail start', { from, to, subject });
  try {
    const info = await tx.sendMail(payload);
    smtpDebug('sendMail OK', {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
      envelope: info.envelope,
    });
    if (isSmtpDebug()) {
      smtpDebug(
        'delivery note: 250 OK = hosting mail server (Exim) accepted. Gmail inbox is a later step — use cPanel → Track Delivery if mail is missing.',
      );
    }
    return info;
  } catch (err) {
    smtpDebug('sendMail FAILED', {
      message: err?.message,
      code: err?.code,
      command: err?.command,
      response: err?.response,
      responseCode: err?.responseCode,
    });
    const wrapped = new Error(smtpErrorMessage(err));
    wrapped.cause = err;
    throw wrapped;
  }
}

module.exports = {
  sendMail,
  verifySmtpConnection,
  getSmtpConfig,
  getMailFrom,
  smtpErrorMessage,
};
