const express = require('express');
const db = require('../db');
const { resolveShare, getShareSheets, getShareDocuments, canAccessShareDocument, logShareActivity } = require('../lib/shareAccess');
const { streamZip, streamMergedPdf } = require('../lib/exportPdfs');
const { streamFile } = require('../lib/streamFile');

const router = express.Router();

function requireValidShare(req, res, next) {
  const { share, error, status } = resolveShare(req.params.token);
  if (error) return res.status(status).json({ error });
  req.share = share;
  next();
}

// Only allow asset access to versions that are actually part of this share's
// current allowed set - prevents a share token being used to fetch sheets
// outside its scope/discipline filter/snapshot cutoff.
function requireVersionInShare(req, res, next) {
  const sheets = getShareSheets(req.share);
  const match = sheets.find((s) => String(s.version_id) === req.params.versionId);
  if (!match) return res.status(404).json({ error: 'Not found' });
  next();
}

router.get('/:token', requireValidShare, (req, res) => {
  const project = db.prepare('SELECT name, number FROM projects WHERE id = ?').get(req.share.project_id);
  const sheets = getShareSheets(req.share);
  logShareActivity(req.share, 'share_access', { sheet_count: sheets.length });
  res.json({
    project,
    scope: req.share.scope,
    discipline_filter: req.share.discipline_filter,
    permissions: {
      allow_personal_markups: Boolean(req.share.allow_personal_markups),
      allow_documents: Boolean(req.share.allow_documents),
      document_folder_ids: JSON.parse(req.share.document_folder_ids || '[]'),
    },
    sheets: sheets.map((s) => ({
      id: s.id,
      sheet_number: s.sheet_number,
      discipline: s.discipline,
      title: s.title,
      version_id: s.version_id,
    })),
  });
});

function serveShareFile(pathColumn, contentType) {
  return (req, res) => {
    const row = db.prepare(`SELECT ${pathColumn} AS p FROM sheet_versions WHERE id = ?`).get(req.params.versionId);
    if (!row || !row.p) return res.status(404).end();
    streamFile(res, row.p, contentType);
  };
}


router.get('/:token/sheet-versions/:versionId/markups', requireValidShare, requireVersionInShare, (req, res) => {
  const sheet = getShareSheets(req.share).find((s) => String(s.version_id) === req.params.versionId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const published = db
    .prepare(`SELECT id, 'published' AS source, type, geometry, style, linked_document_id FROM markups WHERE sheet_id = ? AND visibility = 'published' ORDER BY created_at`)
    .all(sheet.id)
    .map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style || '{}') }));
  const personal = db
    .prepare(`SELECT id, 'personal' AS source, type, geometry, style, NULL AS linked_document_id FROM share_markups WHERE share_id = ? AND sheet_id = ? ORDER BY created_at`)
    .all(req.share.id, sheet.id)
    .map((m) => ({ ...m, geometry: JSON.parse(m.geometry), style: JSON.parse(m.style || '{}') }));
  res.json({ markups: [...published, ...personal] });
});

router.post('/:token/sheet-versions/:versionId/markups', requireValidShare, requireVersionInShare, (req, res) => {
  if (!req.share.allow_personal_markups) return res.status(403).json({ error: 'Personal markups are not enabled for this link' });
  const sheet = getShareSheets(req.share).find((s) => String(s.version_id) === req.params.versionId);
  if (!sheet) return res.status(404).json({ error: 'Not found' });
  const { type, geometry, style } = req.body;
  if (!['line', 'arrow', 'cloud', 'text', 'rect'].includes(type)) return res.status(400).json({ error: 'Invalid markup type' });
  const result = db.prepare('INSERT INTO share_markups (share_id, sheet_id, type, geometry, style) VALUES (?, ?, ?, ?, ?)')
    .run(req.share.id, sheet.id, type, JSON.stringify(geometry || {}), JSON.stringify(style || {}));
  const markup = db.prepare(`SELECT id, 'personal' AS source, type, geometry, style, NULL AS linked_document_id FROM share_markups WHERE id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ markup: { ...markup, geometry: JSON.parse(markup.geometry), style: JSON.parse(markup.style || '{}') } });
});

router.get('/:token/documents', requireValidShare, (req, res) => {
  if (!req.share.allow_documents) return res.status(403).json({ error: 'Documents are not enabled for this link' });
  res.json(getShareDocuments(req.share));
});

router.get('/:token/documents/:documentId/pdf', requireValidShare, (req, res) => {
  const document = canAccessShareDocument(req.share, req.params.documentId);
  if (!document) return res.status(404).json({ error: 'Not found' });
  const row = db
    .prepare(`SELECT dv.pdf_path AS p FROM documents d JOIN document_versions dv ON dv.id = d.current_version_id WHERE d.id = ?`)
    .get(document.id);
  if (!row || !row.p) return res.status(404).end();
  streamFile(res, row.p, 'application/pdf');
});

router.get('/:token/sheet-versions/:versionId/pdf', requireValidShare, requireVersionInShare, serveShareFile('pdf_path', 'application/pdf'));
router.get('/:token/sheet-versions/:versionId/thumb', requireValidShare, requireVersionInShare, serveShareFile('thumb_path', 'image/webp'));
router.get('/:token/sheet-versions/:versionId/preview', requireValidShare, requireVersionInShare, serveShareFile('preview_path', 'image/webp'));

router.get('/:token/export/zip', requireValidShare, (req, res) => {
  const sheets = getShareSheets(req.share);
  const entries = sheets.map((s) => ({
    sheet_number: s.sheet_number,
    pdf_path: db.prepare('SELECT pdf_path FROM sheet_versions WHERE id = ?').get(s.version_id).pdf_path,
  }));
  logShareActivity(req.share, 'export_zip', { sheet_count: entries.length });
  streamZip(res, entries);
});

router.get('/:token/export/merged-pdf', requireValidShare, async (req, res) => {
  const sheets = getShareSheets(req.share);
  const entries = sheets.map((s) => ({
    sheet_number: s.sheet_number,
    title: s.title,
    pdf_path: db.prepare('SELECT pdf_path FROM sheet_versions WHERE id = ?').get(s.version_id).pdf_path,
  }));
  logShareActivity(req.share, 'export_merged_pdf', { sheet_count: entries.length });
  try {
    await streamMergedPdf(res, entries);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
