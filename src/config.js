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
};
