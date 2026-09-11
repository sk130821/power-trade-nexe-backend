const DEFAULT_FRONTEND_URL = 'https://front.powertradenexus.com';

/** Marketing site — both apex and www must be allowed for CORS. */
const DEFAULT_WEBSITE_ORIGINS = [
  'https://powertradenexus.com',
  'https://www.powertradenexus.com',
];

function normalizeOrigin(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

/** Add www ↔ apex pair so either hostname works when one is configured. */
function expandOriginVariants(origin) {
  const o = normalizeOrigin(origin);
  if (!o || !/^https?:\/\//i.test(o)) return [];
  const out = [o];
  try {
    const u = new URL(o);
    const host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      u.hostname = host.slice(4);
      out.push(u.origin);
    } else if (host.split('.').length >= 2) {
      u.hostname = `www.${host}`;
      out.push(u.origin);
    }
  } catch (_) {
    /* ignore invalid URL */
  }
  return out;
}

function parseFrontendUrls() {
  const parts = [];
  const push = (raw) => {
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((entry) => {
        expandOriginVariants(entry).forEach((o) => parts.push(o));
      });
  };

  push(process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL);
  if (process.env.WEBSITE_URL) {
    push(process.env.WEBSITE_URL);
  } else {
    DEFAULT_WEBSITE_ORIGINS.forEach((o) => parts.push(o));
  }

  return [...new Set(parts.map(normalizeOrigin).filter(Boolean))];
}

function frontendBaseUrl() {
  return parseFrontendUrls()[0] || DEFAULT_FRONTEND_URL;
}

module.exports = {
  DEFAULT_FRONTEND_URL,
  DEFAULT_WEBSITE_ORIGINS,
  frontendBaseUrl,
  parseFrontendUrls,
};
