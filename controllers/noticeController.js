const db = require('../config/db');

exports.listForMembers = async (req, res) => {
  try {
    if (req.user.role !== 'member') {
      return res.status(403).json({ error: 'Members only' });
    }
    const [rows] = await db.query(
      `SELECT id, title, body, created_at
       FROM member_notices
       WHERE is_active = 1
       ORDER BY sort_order ASC, id DESC
       LIMIT 50`,
    );
    res.json({ notices: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminList = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT n.id, n.title, n.body, n.is_active, n.sort_order, n.created_at, n.updated_at,
              n.created_by_admin_id, a.username AS created_by_name
       FROM member_notices n
       LEFT JOIN admins a ON a.id = n.created_by_admin_id
       ORDER BY n.sort_order ASC, n.id DESC`,
    );
    res.json({ notices: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminCreate = async (req, res) => {
  try {
    const { title, body, is_active, sort_order } = req.body;
    const t = title != null ? String(title).trim() : '';
    const b = body != null ? String(body).trim() : '';
    if (!t) return res.status(400).json({ error: 'Title required' });
    if (!b) return res.status(400).json({ error: 'Message required' });
    const active = is_active === false || is_active === 0 || is_active === '0' ? 0 : 1;
    const ord = sort_order != null && sort_order !== '' ? Number(sort_order) : 0;
    const [r] = await db.query(
      `INSERT INTO member_notices (title, body, is_active, sort_order, created_by_admin_id)
       VALUES (?,?,?,?,?)`,
      [t, b, active, Number.isFinite(ord) ? ord : 0, req.user.id],
    );
    res.json({ message: 'Notice created', id: r.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { title, body, is_active, sort_order } = req.body;
    const fields = [];
    const vals = [];
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t) return res.status(400).json({ error: 'Title empty' });
      fields.push('title = ?');
      vals.push(t);
    }
    if (body !== undefined) {
      const b = String(body).trim();
      if (!b) return res.status(400).json({ error: 'Message empty' });
      fields.push('body = ?');
      vals.push(b);
    }
    if (is_active !== undefined) {
      fields.push('is_active = ?');
      vals.push(is_active === false || is_active === 0 || is_active === '0' ? 0 : 1);
    }
    if (sort_order !== undefined) {
      const o = Number(sort_order);
      fields.push('sort_order = ?');
      vals.push(Number.isFinite(o) ? o : 0);
    }
    if (!fields.length) return res.status(400).json({ error: 'Send at least one field to update' });
    vals.push(id);
    const [r] = await db.query(`UPDATE member_notices SET ${fields.join(', ')} WHERE id = ?`, vals);
    if (!r.affectedRows) return res.status(404).json({ error: 'Notice not found' });
    res.json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

exports.adminDelete = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const [r] = await db.query('DELETE FROM member_notices WHERE id = ?', [id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Notice not found' });
    res.json({ message: 'Deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
