const bcrypt = require('bcryptjs');
const db = require('../db');

const [, , username, name, password] = process.argv;

if (!username || !name || !password) {
  console.error('Usage: npm run create-admin -- <username> <name> <password>');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  console.error(`User "${username}" already exists.`);
  process.exit(1);
}

const passHash = bcrypt.hashSync(password, 12);
db.prepare('INSERT INTO users (name, username, pass_hash, role) VALUES (?, ?, ?, ?)').run(
  name,
  username,
  passHash,
  'admin'
);

console.log(`Admin user "${username}" created.`);
