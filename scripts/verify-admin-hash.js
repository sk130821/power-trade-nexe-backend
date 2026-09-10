const bcrypt = require('bcryptjs')
const h = '$2a$10$XfhbLh37OFLi5/pQ3Bc2Zewt.esho5Y64gr1fSRd20Yp7WR2JhHs6'
console.log('matches password:', bcrypt.compareSync('password', h))
