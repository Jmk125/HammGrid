const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function parseSettings(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    return {};
  }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.pass_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    can_takeoff: !!user.can_takeoff,
    settings: parseSettings(user.settings),
  };
  res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

const ALLOWED_THEMES = ['default', 'light', 'dark'];

router.put('/settings', requireAuth, (req, res) => {
  const { theme, darkCanvas } = req.body || {};
  if (theme !== undefined && !ALLOWED_THEMES.includes(theme)) {
    return res.status(400).json({ error: `theme must be one of: ${ALLOWED_THEMES.join(', ')}` });
  }

  const current = req.session.user.settings || {};
  const next = { ...current };
  if (theme !== undefined) next.theme = theme;
  if (darkCanvas !== undefined) next.darkCanvas = !!darkCanvas;

  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(next), req.session.user.id);
  req.session.user.settings = next;
  res.json({ user: req.session.user });
});

module.exports = router;
