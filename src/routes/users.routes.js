const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const ROLES = ['admin', 'editor', 'viewer'];

router.get('/', requireRole('admin'), (req, res) => {
  const users = db
    .prepare('SELECT id, name, username, role, can_takeoff, created_at FROM users ORDER BY name')
    .all();
  res.json({ users: users.map((u) => ({ ...u, can_takeoff: !!u.can_takeoff })) });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, username, password, role, can_takeoff } = req.body;
  if (!name || !username || !password || !role) {
    return res.status(400).json({ error: 'name, username, password and role are required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }

  const passHash = bcrypt.hashSync(password, 12);
  try {
    const result = db
      .prepare('INSERT INTO users (name, username, pass_hash, role, can_takeoff) VALUES (?, ?, ?, ?, ?)')
      .run(name, username, passHash, role, can_takeoff ? 1 : 0);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { role, can_takeoff, password } = req.body;
  const targetId = Number(req.params.id);

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    }
    if (targetId === req.session.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
  }
  if (password !== undefined && !password) {
    return res.status(400).json({ error: 'Password cannot be blank' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  if (can_takeoff !== undefined) {
    db.prepare('UPDATE users SET can_takeoff = ? WHERE id = ?').run(can_takeoff ? 1 : 0, targetId);
  }
  if (password) {
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), targetId);
  }
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
