const path = require('path');
const fs = require('fs');
const db = require('../config/db');
const { uploadDir } = require('../config/paths');

function deleteUploadFile(filename) {
  if (!filename) return;
  try {
    fs.unlinkSync(path.join(uploadDir, String(filename)));
  } catch (_) {
    /* ignore */
  }
}

exports.adminListAchievements = async (req, res) => {
  try {
    const where = [];
    const params = [];
    const q = req.query.q != null ? String(req.query.q).trim() : '';
    if (q) {
      where.push('(a.display_name LIKE ? OR a.achievement LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like);
    }
    const sql = `
      SELECT a.*, ad.username AS created_by_name
      FROM member_achievements a
      LEFT JOIN admins ad ON ad.id = a.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC
      LIMIT 500`;
    const [rows] = await db.query(sql, params);
    res.json({ achievements: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminCreateAchievement = async (req, res) => {
  try {
    const display_name = String(req.body.display_name || req.body.name || '').trim();
    const achievement = String(req.body.achievement || '').trim();
    const file = req.files?.achievement_photo?.[0];

    if (!display_name || display_name.length < 2) {
      return res.status(400).json({ error: 'Name is required (at least 2 characters)' });
    }
    if (!achievement || achievement.length < 3) {
      return res.status(400).json({ error: 'Achievement text is required' });
    }
    if (!file) return res.status(400).json({ error: 'Photo is required' });

    const is_active =
      req.body.is_active === false || req.body.is_active === 0 || req.body.is_active === '0' ? 0 : 1;

    const [r] = await db.query(
      `INSERT INTO member_achievements
        (display_name, photo, achievement, sort_order, is_active, created_by)
       VALUES (?,?,?,0,?,?)`,
      [display_name, file.filename, achievement, is_active, req.user.id],
    );
    res.json({ message: 'Achievement saved', id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminUpdateAchievement = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });

    const [[row]] = await db.query('SELECT * FROM member_achievements WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Achievement not found' });

    const fields = [];
    const vals = [];

    if (req.body.display_name != null || req.body.name != null) {
      const display_name = String(req.body.display_name ?? req.body.name ?? '').trim();
      if (!display_name || display_name.length < 2) {
        return res.status(400).json({ error: 'Name is required' });
      }
      fields.push('display_name = ?');
      vals.push(display_name);
    }

    if (req.body.achievement != null) {
      const achievement = String(req.body.achievement).trim();
      if (!achievement || achievement.length < 3) {
        return res.status(400).json({ error: 'Achievement text is required' });
      }
      fields.push('achievement = ?');
      vals.push(achievement);
    }

    if (req.body.is_active !== undefined) {
      const is_active =
        req.body.is_active === false || req.body.is_active === 0 || req.body.is_active === '0' ? 0 : 1;
      fields.push('is_active = ?');
      vals.push(is_active);
    }

    const file = req.files?.achievement_photo?.[0];
    if (file) {
      deleteUploadFile(row.photo);
      fields.push('photo = ?');
      vals.push(file.filename);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(id);
    await db.query(`UPDATE member_achievements SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ message: 'Achievement updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminDeleteAchievement = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const [[row]] = await db.query('SELECT photo FROM member_achievements WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Achievement not found' });
    await db.query('DELETE FROM member_achievements WHERE id = ?', [id]);
    deleteUploadFile(row.photo);
    res.json({ message: 'Achievement deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/** All visible achievements — same gallery for every logged-in member. */
exports.getMyAchievements = async (req, res) => {
  try {
    if (req.user.role !== 'member') {
      return res.status(403).json({ error: 'Members only' });
    }
    const [rows] = await db.query(
      `SELECT id, display_name, photo, achievement, created_at
       FROM member_achievements
       WHERE is_active = 1
       ORDER BY id DESC`,
    );
    res.json({ achievements: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/** Marketing website — active achievements carousel (newest first). */
exports.getPublicAchievements = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, display_name, photo, achievement, created_at
       FROM member_achievements
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 50`,
    );
    res.json({ achievements: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
