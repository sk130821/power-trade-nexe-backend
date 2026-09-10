const path = require('path');

/** Backend package root (folder that contains index.js). */
const backendRoot = path.join(__dirname, '..');

/** Writable upload directory; respects UPLOAD_DIR in .env (relative → under backend/). */
const rawUpload = String(process.env.UPLOAD_DIR || 'uploads').trim();
const uploadDir = path.isAbsolute(rawUpload) ? rawUpload : path.join(backendRoot, rawUpload);

module.exports = { backendRoot, uploadDir };
