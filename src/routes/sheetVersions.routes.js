const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function serveFile(pathColumn, contentType) {
  return (req, res) => {
    const row = db.prepare(`SELECT ${pathColumn} AS p FROM sheet_versions WHERE id = ?`).get(req.params.id);
    if (!row || !row.p) return res.status(404).end();
    res.type(contentType);
    fs.createReadStream(row.p).pipe(res);
  };
}

router.get('/:id/thumb', requireAuth, serveFile('thumb_path', 'image/webp'));
router.get('/:id/preview', requireAuth, serveFile('preview_path', 'image/webp'));
router.get('/:id/pdf', requireAuth, serveFile('pdf_path', 'application/pdf'));
router.get('/:id/overlay', requireAuth, serveFile('overlay_path', 'image/webp'));

module.exports = router;
