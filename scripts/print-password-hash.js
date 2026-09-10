/** Usage: node scripts/print-password-hash.js [plainPassword] */
const bcrypt = require('bcryptjs');
const plain = process.argv[2] || 'password';
const hash = bcrypt.hashSync(plain, 10);
if (!bcrypt.compareSync(plain, hash)) process.exit(1);
console.log(hash);
