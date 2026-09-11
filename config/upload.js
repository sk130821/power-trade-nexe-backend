const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadDir } = require('./paths');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|gif|webp|pdf/;
  const ext = allowed.test(path.extname(file.originalname).toLowerCase());
  if (ext) cb(null, true);
  else cb(new Error('Only images and PDF allowed'));
};

const adminSettingsFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === 'login_popup_video') {
    if (/\.(mp4|webm|mov|m4v)$/i.test(ext)) return cb(null, true);
    return cb(new Error('Login popup video must be MP4, WebM, MOV, or M4V'));
  }
  if (file.fieldname === 'login_popup_image' || file.fieldname === 'metamask_qr') {
    if (/\.(jpe?g|png|gif|webp|pdf)$/i.test(ext)) return cb(null, true);
    return cb(new Error('Image must be JPEG, PNG, GIF, WebP, or PDF'));
  }
  return cb(new Error('Unexpected upload field'));
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

const uploadAdminSettings = multer({
  storage,
  fileFilter: adminSettingsFileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = upload;
module.exports.uploadAdminSettings = uploadAdminSettings;
