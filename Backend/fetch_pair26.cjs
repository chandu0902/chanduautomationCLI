const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Sequelize } = require('sequelize');

const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  dialect: 'mysql',
  logging: false
});

s.query("SELECT * FROM StatArbInputs WHERE pairIndex = 26 ORDER BY id DESC LIMIT 3")
  .then(([rows]) => { console.log(JSON.stringify(rows, null, 2)); s.close(); })
  .catch(e => { console.error(e.message); s.close(); });
