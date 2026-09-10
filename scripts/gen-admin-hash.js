/** one-off: node scripts/gen-admin-hash.js */
const bcrypt = require('bcryptjs')
console.log(bcrypt.hashSync('password', 10))
