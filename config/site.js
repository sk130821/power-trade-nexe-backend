const DEFAULT_FRONTEND_URL = 'https://front.powertradenexus.com';
const DEFAULT_WEBSITE_URL = 'https://www.powertradenexus.com';

function parseFrontendUrls() {
  const parts = [];
  const push = (raw) => {
    String(raw || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean)
      .forEach((u) => parts.push(u));
  };
  push(process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL);
  push(process.env.WEBSITE_URL || DEFAULT_WEBSITE_URL);
  return [...new Set(parts)];
}

function frontendBaseUrl() {
  return parseFrontendUrls()[0] || DEFAULT_FRONTEND_URL;
}

module.exports = {
  DEFAULT_FRONTEND_URL,
  frontendBaseUrl,
  parseFrontendUrls,
};
