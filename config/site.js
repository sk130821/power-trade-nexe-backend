const DEFAULT_FRONTEND_URL = 'https://front.powertradenexus.com';

function parseFrontendUrls() {
  const raw = process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL;
  return String(raw)
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function frontendBaseUrl() {
  return parseFrontendUrls()[0] || DEFAULT_FRONTEND_URL;
}

module.exports = {
  DEFAULT_FRONTEND_URL,
  frontendBaseUrl,
  parseFrontendUrls,
};
