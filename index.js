const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
require('dotenv').config();

const { uploadDir } = require('./config/paths');

const app = express();
const routes = require('./routes');
const db = require('./config/db');
const { ensureSchema } = require('./config/schemaEnsure');
const { tickRoiAutomation, maybeTickRoiAutomation, migrateExistingRoiSlots } = require('./controllers/roiController');
const { runMonthlySalaryJob } = require('./utils/monthlySalary');
const { parseFrontendUrls } = require('./config/site');

const envOrigins = parseFrontendUrls();
const localDevOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      const normalized = String(origin).trim().replace(/\/$/, '');
      if (envOrigins.includes(normalized)) return cb(null, true);
      if (process.env.NODE_ENV !== 'production' && localDevOrigin.test(normalized)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'crypto-mlm-api' }));

app.use('/api', routes);

// Health check
app.get('/', (req, res) => res.json({ status: 'Power Trade Nexus API Running' }));

// Live Trades: members buy from 9 AM IST until admin settles (no 5 PM auto-close).

// trade session: each minute check IST clock vs slot open/close (auto-open, auto-settle Trade — no admin click)
cron.schedule('* * * * *', async () => {
  try {
    await tickRoiAutomation();
  } catch (e) {
    console.error('Trade automation:', e.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Backup interval (helps on Windows / if cron minute was missed while server was busy)
setInterval(async () => {
  try {
    await maybeTickRoiAutomation();
  } catch (e) {
    console.error('Trade automation (interval):', e.message);
  }
}, 30000);

// Direct monthly salary payouts — daily check, anniversary date (3 payouts max)
cron.schedule('5 0 * * *', async () => {
  try {
    await runMonthlySalaryJob();
  } catch (e) {
    console.error('Monthly salary job:', e.message);
  }
}, { timezone: 'Asia/Kolkata' });

const PORT = process.env.PORT || 5000;

async function start() {
  await ensureSchema();
  await migrateExistingRoiSlots();
  try {
    await tickRoiAutomation();
  } catch (e) {
    console.error('Trade automation (startup):', e.message);
  }
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error('Server failed to start:', e);
  process.exit(1);
});
