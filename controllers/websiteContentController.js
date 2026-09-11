const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { uploadDir } = require('../config/paths');

function deleteUploadFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(uploadDir, String(filename)));
  } catch (_) {
    /* ignore missing file */
  }
}

exports.getPublicBanners = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, image, alt_text, sort_order
       FROM website_banners
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`,
    );
    res.json({ banners: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.getPublicLoginPopups = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT login_popup_video, login_popup_image FROM admins WHERE id = 1`,
    );
    const row = rows[0] || {};
    res.json({
      video: row.login_popup_video || null,
      image: row.login_popup_image || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminListBanners = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT b.*, a.username AS created_by_name
       FROM website_banners b
       LEFT JOIN admins a ON a.id = b.created_by
       ORDER BY b.sort_order ASC, b.id ASC`,
    );
    res.json({ banners: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminCreateBanner = async (req, res) => {
  try {
    const file = req.files?.website_banner_image?.[0];
    if (!file) return res.status(400).json({ error: 'Banner image is required' });

    const alt_text = String(req.body.alt_text || 'Banner').trim() || 'Banner';
    const sort_order = Number(req.body.sort_order);
    const is_active =
      req.body.is_active === false || req.body.is_active === 0 || req.body.is_active === '0' ? 0 : 1;

    const [r] = await db.query(
      `INSERT INTO website_banners (image, alt_text, sort_order, is_active, created_by)
       VALUES (?,?,?,?,?)`,
      [
        file.filename,
        alt_text,
        Number.isFinite(sort_order) ? sort_order : 0,
        is_active,
        req.user.id,
      ],
    );
    res.json({ message: 'Banner added', id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminUpdateBanner = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [[row]] = await db.query('SELECT * FROM website_banners WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Banner not found' });

    const fields = [];
    const vals = [];

    if (req.body.alt_text !== undefined) {
      fields.push('alt_text = ?');
      vals.push(String(req.body.alt_text).trim() || 'Banner');
    }
    if (req.body.sort_order !== undefined && req.body.sort_order !== '') {
      const n = parseInt(req.body.sort_order, 10);
      if (!Number.isFinite(n)) return res.status(400).json({ error: 'Invalid sort order' });
      fields.push('sort_order = ?');
      vals.push(n);
    }
    if (req.body.is_active !== undefined) {
      fields.push('is_active = ?');
      vals.push(
        req.body.is_active === false || req.body.is_active === 0 || req.body.is_active === '0' ? 0 : 1,
      );
    }

    const file = req.files?.website_banner_image?.[0];
    if (file) {
      deleteUploadFile(row.image);
      fields.push('image = ?');
      vals.push(file.filename);
    } else if (req.body.remove_image === '1' || req.body.remove_image === 'true') {
      return res.status(400).json({ error: 'Cannot remove image without uploading a replacement' });
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    await db.query(`UPDATE website_banners SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ message: 'Banner updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminDeleteBanner = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [[row]] = await db.query('SELECT image FROM website_banners WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Banner not found' });

    await db.query('DELETE FROM website_banners WHERE id = ?', [id]);
    deleteUploadFile(row.image);
    res.json({ message: 'Banner deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
