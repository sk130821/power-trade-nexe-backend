/**
 * User-facing strings in backend — phrase-level only.
 */
const fs = require('fs');
const path = require('path');

const TARGETS = [
  path.join(__dirname, '..', 'controllers'),
  path.join(__dirname, '..', 'utils', 'monthlySalary.js'),
  path.join(__dirname, '..', 'index.js'),
];

const RULES = [
  ['Trading Income', 'Live Trading Income'],
  ['trading income', 'live trading income'],
  ['Day Trades', 'Live Trades'],
  ['Day Trade', 'Live Trade'],
  ['day trades', 'live trades'],
  ['day trade', 'live trade'],
  ['Daily ROI', 'Daily Trade'],
  ['ROI Trade', 'Trade Income'],
  ['ROI session', 'trade session'],
  ['ROI Session', 'Trade Session'],
  ['ROI income', 'Trade income'],
  ['ROI Income', 'Trade Income'],
  ['ROI session', 'trade session'],
  ['ROI ', 'Trade '],
  [' ROI', ' Trade'],
  ['ROI.', 'Trade.'],
  ['ROI,', 'Trade,'],
  ['ROI:', 'Trade:'],
  ['ROI|', 'Trade|'],
  ['ROI$', 'Trade$'],
  ['ROI%', 'Trade%'],
  ['no ROI', 'no trade income'],
  ['join ROI', 'join trade'],
];

function processFile(p) {
  let text = fs.readFileSync(p, 'utf8');
  const original = text;
  for (const [from, to] of RULES) {
    text = text.split(from).join(to);
  }
  if (text !== original) {
    fs.writeFileSync(p, text);
    console.log('updated', p);
  }
}

function walk(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isFile()) {
    if (/\.js$/.test(p)) processFile(p);
    return;
  }
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
    if (ent.name === 'node_modules') continue;
    walk(path.join(p, ent.name));
  }
}

for (const t of TARGETS) walk(t);
console.log('done');
