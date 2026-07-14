const bcrypt = require('bcryptjs');
const db = require('../db');

const [, , username, password] = process.argv;

if (!username || !password) {
  console.error('Usage: npm run set-password -- <username> <new-password>');
  process.exit(1);
}

const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`User "${username}" does not exist.`);
  process.exit(1);
}

const passHash = bcrypt.hashSync(password, 12);
db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, user.id);

console.log(`Password updated for "${username}".`);
