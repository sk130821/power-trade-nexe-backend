/**
 * Deterministic intraday OHLC-style series for UI (NSE/BSE–style chart demo).
 */
function generateIntradayChart({ open, last, high, low }) {
  const o = Number(open);
  const c = Number(last);
  let h = high != null && high !== '' ? Number(high) : Math.max(o, c) * 1.004;
  let l = low != null && low !== '' ? Number(low) : Math.min(o, c) * 0.996;
  if (h < Math.max(o, c)) h = Math.max(o, c) * 1.002;
  if (l > Math.min(o, c)) l = Math.min(o, c) * 0.998;

  const n = 36;
  const out = [];
  let prevClose = o;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const smooth = t * t * (3 - 2 * t);
    let price = o + (c - o) * smooth;
    const w = Math.sin(t * Math.PI * 5) * (h - l) * 0.025;
    price = Math.min(h, Math.max(l, price + w));
    if (i === n - 1) price = c;

    const hh = Math.min(h, price + (h - l) * 0.015);
    const ll = Math.max(l, price - (h - l) * 0.015);
    const mins = 9 * 60 + Math.round(((17 - 9) * 60) * t);
    const hr = Math.floor(mins / 60);
    const mn = mins % 60;
    const barOpen = i === 0 ? o : prevClose;
    const barClose = price;
    prevClose = barClose;

    out.push({
      time: `${String(hr).padStart(2, '0')}:${String(mn).padStart(2, '0')}`,
      open: barOpen,
      high: Math.max(barOpen, barClose, hh),
      low: Math.min(barOpen, barClose, ll),
      close: barClose,
    });
  }

  return out;
}

function parseStoredChart(raw) {
  if (raw == null || raw === '') return null;
  if (Array.isArray(raw)) return raw;
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

function enrichTradeChart(trade) {
  const { chart_json: _cj, ...rest } = trade;
  const chart = parseStoredChart(trade.chart_json);
  if (chart && chart.length) {
    return { ...rest, chart };
  }
  const op = trade.open_price != null ? Number(trade.open_price) : Number(trade.last_price || 0);
  const lp = Number(trade.last_price || 0);
  if (!lp && !op) return { ...rest, chart: [] };
  const synthetic = generateIntradayChart({
    open: op || lp,
    last: lp || op,
    high: trade.day_high,
    low: trade.day_low,
  });
  return { ...rest, chart: synthetic };
}

module.exports = { generateIntradayChart, enrichTradeChart, parseStoredChart };
