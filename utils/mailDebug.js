/** SMTP / OTP verbose logs — set SMTP_DEBUG=1 in .env (local only; never on public production). */
function isSmtpDebug() {
  const v = String(process.env.SMTP_DEBUG || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function smtpDebug(label, detail) {
  if (!isSmtpDebug()) return;
  const ts = new Date().toISOString();
  if (detail === undefined) {
    console.log(`[smtp][debug] ${ts} ${label}`);
    return;
  }
  console.log(`[smtp][debug] ${ts} ${label}`, detail);
}

/** Local: do not call SMTP (saves cPanel ~100 emails/hour quota during dev). */
function isSmtpDryRun() {
  if (process.env.NODE_ENV === 'production') return false;
  const v = String(process.env.SMTP_DRY_RUN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Local only: return OTP in API JSON when SMTP_DEBUG or SMTP_DRY_RUN (not production). */
function shouldExposeDevOtpInApi() {
  if (process.env.NODE_ENV === 'production') return false;
  return isSmtpDebug() || isSmtpDryRun();
}

module.exports = { isSmtpDebug, smtpDebug, isSmtpDryRun, shouldExposeDevOtpInApi };
