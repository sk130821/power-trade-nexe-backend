/**
 * Power Trade Nexus — branded HTML emails (black & gold).
 * Logo / site URL configurable via .env; defaults match front.powertradenexus.com
 */

const COMPANY_NAME = 'Power Trade Nexus';
const DEFAULT_LOGO_URL = 'https://front.powertradenexus.com/power-trade-nexus-logo.png';
const DEFAULT_WEBSITE_URL = 'https://front.powertradenexus.com/';

const GOLD = '#c9a227';
const GOLD_LIGHT = '#e8c547';
const BLACK = '#0a0a0a';
const TEXT = '#1a1a1a';
const MUTED = '#5c5c5c';

function brandLogoUrl() {
  const u = process.env.EMAIL_LOGO_URL || process.env.BRAND_LOGO_URL;
  return (u && String(u).trim()) || DEFAULT_LOGO_URL;
}

function brandWebsiteUrl() {
  const u = process.env.BRAND_WEBSITE_URL || process.env.EMAIL_WEBSITE_URL || process.env.FRONTEND_URL;
  const raw = (u && String(u).split(',')[0].trim()) || DEFAULT_WEBSITE_URL;
  return raw.replace(/\/$/, '');
}

function websiteDisplay() {
  return brandWebsiteUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Wrap inner HTML in full branded layout.
 * @param {{ title: string, preheader?: string, bodyHtml: string }} opts
 */
function brandedEmail({ title, preheader = '', bodyHtml }) {
  const logo = escapeHtml(brandLogoUrl());
  const site = escapeHtml(brandWebsiteUrl());
  const siteLabel = escapeHtml(websiteDisplay());
  const year = new Date().getFullYear();
  const pre = escapeHtml(preheader);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(title)}</title>
  <style type="text/css">
    :root { color-scheme: light only; supported-color-schemes: light; }
    .email-body, .email-body p, .email-body h1 { color: #1a1a1a !important; }
    .otp-wrap { background-color: #fff8e7 !important; }
    .otp-digit {
      color: #000000 !important;
      background-color: #ffffff !important;
      -webkit-text-fill-color: #000000 !important;
    }
    .otp-plain { color: #000000 !important; -webkit-text-fill-color: #000000 !important; }
    @media (prefers-color-scheme: dark) {
      .email-body { background-color: #ffffff !important; }
      .otp-wrap { background-color: #fff8e7 !important; }
      .otp-digit { color: #000000 !important; background-color: #ffffff !important; }
      .otp-plain { color: #000000 !important; }
    }
    @media only screen and (max-width: 480px) {
      .otp-digit { font-size: 26px !important; padding: 10px 6px !important; }
      .email-body { padding: 24px 16px !important; }
    }
  </style>
  <!--[if mso]><style>table{border-collapse:collapse;}td{font-family:Arial,sans-serif;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Segoe UI',Arial,Helvetica,sans-serif;-webkit-text-fill-color:#1a1a1a;">
  ${pre ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${pre}</div>` : ''}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
          <!-- Header bar -->
          <tr>
            <td style="background:linear-gradient(135deg,${BLACK} 0%,#1a1510 50%,${BLACK} 100%);border-radius:16px 16px 0 0;padding:28px 32px 24px;text-align:center;border-bottom:3px solid ${GOLD};">
              <a href="${site}" style="text-decoration:none;display:inline-block;">
                <img src="${logo}" alt="${escapeHtml(COMPANY_NAME)}" width="220" style="display:block;margin:0 auto;max-width:220px;height:auto;border:0;" />
              </a>
              <p style="margin:14px 0 0;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:${GOLD_LIGHT};font-weight:600;">
                Smart Crypto Trading &amp; Investment Platform
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td class="email-body" bgcolor="#ffffff" style="background:#ffffff;padding:36px 32px 28px;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;color:#1a1a1a;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:${BLACK};border-radius:0 0 16px 16px;padding:24px 32px;text-align:center;border-top:1px solid #2a2418;">
              <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:${GOLD_LIGHT};">${escapeHtml(COMPANY_NAME)}</p>
              <p style="margin:0 0 14px;font-size:12px;color:#9a9a9a;">
                <a href="${site}" style="color:${GOLD};text-decoration:none;">${siteLabel}</a>
              </p>
              <p style="margin:0;font-size:11px;color:#666;line-height:1.6;">
                This is an automated message from ${escapeHtml(COMPANY_NAME)}.<br />
                Please do not reply directly to this email.<br />
                &copy; ${year} ${escapeHtml(COMPANY_NAME)}. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function emailHeading(text) {
  return `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:${TEXT};line-height:1.3;">${escapeHtml(text)}</h1>`;
}

function emailParagraph(text, opts = {}) {
  const color = opts.muted ? MUTED : TEXT;
  const size = opts.small ? '13px' : '15px';
  return `<p style="margin:0 0 16px;font-size:${size};line-height:1.65;color:${color};">${text}</p>`;
}

function emailGreeting(name) {
  const n = name ? escapeHtml(name) : 'Member';
  return emailParagraph(`Hi <strong style="color:${TEXT};">${n}</strong>,`);
}

function emailButton(href, label) {
  const url = escapeHtml(href);
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
      <tr>
        <td style="border-radius:10px;background:linear-gradient(135deg,${GOLD_LIGHT} 0%,${GOLD} 50%,#a67c00 100%);">
          <a href="${url}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:${BLACK};text-decoration:none;border-radius:10px;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>`;
}

function emailOtpBox(otp, expiryMinutes) {
  const digits = String(otp || '')
    .replace(/\D/g, '')
    .slice(0, 6)
    .split('');
  while (digits.length < 6) digits.push('0');

  const digitCells = digits
    .map(
      (d) => `
        <td class="otp-digit" align="center" valign="middle" bgcolor="#ffffff" style="width:44px;min-width:36px;padding:14px 8px;font-size:32px;font-weight:800;color:#000000;background-color:#ffffff;border:2px solid #c9a227;border-radius:8px;font-family:Arial,Helvetica,sans-serif;line-height:1;mso-line-height-rule:exactly;">
          ${escapeHtml(d)}
        </td>
        <td width="6" style="font-size:0;line-height:0;">&nbsp;</td>`,
    )
    .join('');

  const plainCode = escapeHtml(digits.join(''));

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
      <tr>
        <td class="otp-wrap" align="center" bgcolor="#fff8e7" style="background-color:#fff8e7;border:2px solid #c9a227;border-radius:12px;padding:20px 12px;">
          <p style="margin:0 0 14px;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#5c5c5c;font-weight:700;">Your verification code</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
            <tr>${digitCells}</tr>
          </table>
          <p class="otp-plain" style="margin:16px 0 0;font-size:22px;font-weight:800;color:#000000;letter-spacing:4px;font-family:Arial,Helvetica,sans-serif;line-height:1.4;">
            ${plainCode}
          </p>
          <p style="margin:12px 0 0;font-size:12px;color:#5c5c5c;">Valid for ${Number(expiryMinutes) || 15} minutes</p>
        </td>
      </tr>
    </table>`;
}

function emailInfoBox(html) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;">
      <tr>
        <td style="background:#fafafa;border-left:4px solid ${GOLD};border-radius:0 8px 8px 0;padding:14px 18px;font-size:14px;line-height:1.6;color:${TEXT};">
          ${html}
        </td>
      </tr>
    </table>`;
}

function emailDetailsTable(rows) {
  const trs = rows
    .map(
      ([label, value], i) => `
      <tr>
        <td style="padding:12px 14px;font-size:13px;color:${MUTED};border-bottom:1px solid #eee;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:12px 14px;font-size:14px;color:${TEXT};border-bottom:1px solid #eee;font-weight:${label === 'Password' ? '700' : '500'};${label === 'Password' || label === 'Referral code' ? `font-family:'Courier New',Courier,monospace;` : ''}">${value}</td>
      </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;border:1px solid #eee;border-radius:10px;overflow:hidden;">
      <tr>
        <td colspan="2" style="background:linear-gradient(90deg,${BLACK},#1f1a12);padding:12px 14px;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${GOLD_LIGHT};">
          Account details
        </td>
      </tr>
      ${trs}
    </table>`;
}

function emailDivider() {
  return `<hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />`;
}

function emailSmallPrint(text) {
  return `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#888;">${text}</p>`;
}

module.exports = {
  COMPANY_NAME,
  brandedEmail,
  emailHeading,
  emailParagraph,
  emailGreeting,
  emailButton,
  emailOtpBox,
  emailInfoBox,
  emailDetailsTable,
  emailDivider,
  emailSmallPrint,
  escapeHtml,
  brandWebsiteUrl,
  websiteDisplay,
};
