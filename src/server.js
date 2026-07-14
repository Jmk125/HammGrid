const config = require('./config');
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const SqliteSessionStore = require('./db/sessionStore');
const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const projectsRoutes = require('./routes/projects.routes');
const revisionsRoutes = require('./routes/revisions.routes');
const stagedSheetsRoutes = require('./routes/stagedSheets.routes');
const sheetsRoutes = require('./routes/sheets.routes');
const sheetVersionsRoutes = require('./routes/sheetVersions.routes');
const documentsRoutes = require('./routes/documents.routes');
const documentFilesRoutes = require('./routes/documentFiles.routes');
const documentVersionsRoutes = require('./routes/documentVersions.routes');
const documentFoldersRoutes = require('./routes/documentFolders.routes');
const markupsRoutes = require('./routes/markups.routes');
const sheetLinksRoutes = require('./routes/sheetLinks.routes');
const markupByIdRoutes = require('./routes/markupById.routes');
const syncRoutes = require('./routes/sync.routes');
const sharesRoutes = require('./routes/shares.routes');
const shareAccessRoutes = require('./routes/shareAccess.routes');
const exportsRoutes = require('./routes/exports.routes');
const activityRoutes = require('./routes/activity.routes');

const app = express();

app.use(express.json());
app.use(
  session({
    store: new SqliteSessionStore(db),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/projects/:projectId/revisions', revisionsRoutes);
app.use('/api/staged-sheets', stagedSheetsRoutes);
app.use('/api/projects/:projectId/sheets', sheetsRoutes);
app.use('/api/projects/:projectId/sheets/:sheetId/links', sheetLinksRoutes);
app.use('/api/sheet-versions', sheetVersionsRoutes);
app.use('/api/projects/:projectId/documents', documentsRoutes);
app.use('/api/documents', documentFilesRoutes);
app.use('/api/document-versions', documentVersionsRoutes);
app.use('/api/document-folders', documentFoldersRoutes);
app.use('/api/sheets/:sheetId/markups', markupsRoutes);
app.use('/api/markups', markupByIdRoutes);
app.use('/api/projects/:projectId/sync', syncRoutes);
app.use('/api/projects/:projectId/shares', sharesRoutes);
app.use('/api/share', shareAccessRoutes);
app.use('/api/projects/:projectId/export', exportsRoutes);
app.use('/api/projects/:projectId/activity', activityRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  // A client that disconnects mid-request (closes the tab, navigates away,
  // or a flaky network) while a large PDF is still uploading is routine, not
  // exceptional - multer correctly forwards that as an error here rather
  // than throwing. But the connection is already gone by the time we get
  // it, so writing a response to it can itself throw (e.g. attempting to
  // .end() an already-destroyed socket) - Express's own default error
  // handler explicitly guards against this same case. Skipping the response
  // (and the try/catch below as a second layer of defense) is what actually
  // stops one aborted upload from crashing the whole server for everyone
  // else in the field.
  console.error(err);
  if (res.headersSent || res.destroyed) return next(err);
  try {
    res.status(500).json({ error: 'Internal server error' });
  } catch (writeErr) {
    console.error('Failed to write error response (connection likely already closed):', writeErr);
  }
});

// Last-resort safety net: an uncaught exception or unhandled rejection
// anywhere in the process must never take the whole server down - this is
// shared infrastructure for a live field team (per CLAUDE.md), not a
// single-user script, so "one bad request crashes it for everyone" is the
// worst possible failure mode. Route-level fixes (like the error handler
// above) are still the right first line of defense since they can respond
// to the actual request; this only catches whatever slips past that.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server staying up):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server staying up):', err);
});

app.listen(config.port, () => {
  console.log(`Drawing app server listening on port ${config.port}`);
});
