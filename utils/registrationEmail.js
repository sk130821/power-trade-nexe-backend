const { sendMail } = require('./mail');
const {
  brandedEmail,
  emailHeading,
  emailParagraph,
  emailGreeting,
  emailDetailsTable,
  emailInfoBox,
  emailSmallPrint,
  escapeHtml,
  brandWebsiteUrl,
  websiteDisplay,
} = require('./emailTemplate');

function fmtUsd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v}` : '—';
}

/** Send welcome email after registration payment submitted — pending admin approval. */
async function sendRegistrationWelcomeEmail(member, plainPassword) {
  const name = member.name || 'Member';
  const email = member.email;
  const pw = plainPassword ? String(plainPassword) : '(use the password you set during registration)';

  const bodyHtml = `
    ${emailHeading('Registration complete')}
    ${emailGreeting(name)}
    ${emailParagraph('Welcome to <strong>Power Trade Nexus</strong>. Your package payment has been received and your registration is complete.')}
    ${emailInfoBox(
      '<strong>Status:</strong> Pending admin approval — you can sign in now; trading and withdrawals unlock after activation.',
    )}
    ${emailDetailsTable([
      ['Member ID', escapeHtml(member.referral_code || '—')],
      ['Name', escapeHtml(name)],
      ['Email (login)', escapeHtml(email)],
      ['Contact', escapeHtml(member.contact || '—')],
      ['Package', escapeHtml(fmtUsd(member.package_amount))],
      ['Password', escapeHtml(pw)],
    ])}
    ${emailParagraph('Save this email in a secure place. Admin will review your payment and activate your account shortly.')}
    ${emailSmallPrint(
      `Visit your member portal at <a href="${escapeHtml(brandWebsiteUrl())}" style="color:#c9a227;text-decoration:none;font-weight:600;">${escapeHtml(websiteDisplay())}</a>.`,
    )}
  `;

  await sendMail({
    to: email,
    subject: 'Welcome to Power Trade Nexus — Payment received',
    html: brandedEmail({
      title: 'Registration complete',
      preheader: `Payment received for ${name}. Member ID: ${member.referral_code || ''}`,
      bodyHtml,
    }),
  });
}

/** Send email when admin activates the member account. */
async function sendMemberActivationEmail(member) {
  const name = member.name || 'Member';
  const email = member.email;

  const bodyHtml = `
    ${emailHeading('Account activated')}
    ${emailGreeting(name)}
    ${emailParagraph('Great news — your <strong>Power Trade Nexus</strong> account has been <strong>approved by admin</strong>.')}
    ${emailInfoBox(
      '<strong>Status:</strong> Active — Exchange Trading, Live Trades, withdrawals, and sponsoring are now unlocked.',
    )}
    ${emailDetailsTable([
      ['Member ID', escapeHtml(member.referral_code || '—')],
      ['Name', escapeHtml(name)],
      ['Email (login)', escapeHtml(email)],
      ['Package', escapeHtml(fmtUsd(member.package_amount))],
    ])}
    ${emailParagraph('Sign in to your member dashboard and start trading.')}
    ${emailSmallPrint(
      `Visit <a href="${escapeHtml(brandWebsiteUrl())}" style="color:#c9a227;text-decoration:none;font-weight:600;">${escapeHtml(websiteDisplay())}</a>.`,
    )}
  `;

  await sendMail({
    to: email,
    subject: 'Power Trade Nexus — Your account is now active',
    html: brandedEmail({
      title: 'Account activated',
      preheader: `${name}, your member account is active.`,
      bodyHtml,
    }),
  });
}

module.exports = { sendRegistrationWelcomeEmail, sendMemberActivationEmail };
