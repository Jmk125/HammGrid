const express = require('express');
const db = require('../db');
const { requireTakeoff } = require('../middleware/auth');

const router = express.Router();

router.patch('/:id', requireTakeoff, (req, res) => {
  const instance = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (instance.created_by !== user.id && user.role === 'viewer') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { geometry, quantity } = req.body;
  if (!geometry) return res.status(400).json({ error: 'geometry is required' });
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  db.prepare('UPDATE take_off_instances SET geometry = ?, quantity = ? WHERE id = ?').run(
    JSON.stringify(geometry),
    quantity,
    instance.id
  );
  const updated = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(instance.id);
  res.json({ instance: { ...updated, geometry: JSON.parse(updated.geometry) } });
});

router.delete('/:id', requireTakeoff, (req, res) => {
  const instance = db.prepare('SELECT * FROM take_off_instances WHERE id = ?').get(req.params.id);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  const user = req.session.user;
  if (instance.created_by !== user.id && user.role === 'viewer') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare('DELETE FROM take_off_instances WHERE id = ?').run(instance.id);
  res.json({ ok: true });
});

module.exports = router;
