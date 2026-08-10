require('dotenv').config();
const path = require('path');

module.exports = {
  port: process.env.PORT || 3010,
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db'),
  nodeEnv: process.env.NODE_ENV || 'development',
  storageDir: process.env.STORAGE_DIR || path.join(__dirname, '..', 'data'),
  pythonPath: process.env.PYTHON_PATH || 'python',
  tesseractPath: process.env.TESSERACT_PATH || 'tesseract',
  // Defaults point at the mkcert-issued files already sitting next to
  // server.js (src/10.0.30.50-key.pem / .pem) so this works unmodified on
  // the current box - override via env if the cert ever moves, gets
  // reissued under a different name, or a future host needs a different
  // one (see CLAUDE.md: host must stay easily configurable).
  tlsKeyPath: process.env.TLS_KEY_PATH || path.join(__dirname, '10.0.30.50-key.pem'),
  tlsCertPath: process.env.TLS_CERT_PATH || path.join(__dirname, '10.0.30.50.pem'),
};
