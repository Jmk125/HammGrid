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
const markupsRoutes = require('./routes/markups.routes');
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
app.use('/api/sheet-versions', sheetVersionsRoutes);
app.use('/api/projects/:projectId/documents', documentsRoutes);
app.use('/api/documents', documentFilesRoutes);
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
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Drawing app server listening on port ${config.port}`);
});
