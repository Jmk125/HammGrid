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
