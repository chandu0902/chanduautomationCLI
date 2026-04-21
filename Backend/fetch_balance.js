require('dotenv').config();
const crypto  = require('crypto');
const axios   = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);
const AccountDetails = sequelize.define('AccountDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  Trade_Account: DataTypes.STRING, Exchange: DataTypes.STRING,
  Api_Key: DataTypes.TEXT, Secret_Key: DataTypes.TEXT,
  Status: DataTypes.STRING,
}, { tableName: 'AccountDetails', timestamps: false });

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv  = Buffer.from(ivBase64,  'base64');
  const dc  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return dc.update(encryptedText, 'base64', 'utf8') + dc.final('utf8');
}
function getCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
  const secret = decryptText(sk2, sk1, sk0);
  return { apiKey, secret };
}
async function getDeribitToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret, scope: 'trade:read_write' }
  });
  return r.data.result.access_token;
}
async function deribitGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}

(async () => {
  try {
    await sequelize.authenticate();
    const account = await AccountDetails.findOne({
      where: { Trade_Account: 'Deribit-H4', Status: 'Active' }
    });
    if (!account) { console.error('Account not found'); process.exit(1); }
    const { apiKey, secret } = getCredentials(account);
    const token = await getDeribitToken(apiKey, secret);

    const summary = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token);
    const btcIndex = await deribitGet('/api/v2/public/get_index_price?index_name=btc_usd', token);
    const btcPrice = btcIndex.index_price;

    console.log('\n══════════════════════════════════════════════');
    console.log('  DERIBIT ACCOUNT — LIVE BALANCE (BTC)');
    console.log('══════════════════════════════════════════════');
    console.log(`  equity          : ${summary.equity.toFixed(8)} BTC`);
    console.log(`  balance         : ${summary.balance.toFixed(8)} BTC`);
    console.log(`  unrealized PnL  : ${summary.total_pl.toFixed(8)} BTC`);
    console.log(`  margin balance  : ${(summary.margin_balance || summary.equity).toFixed(8)} BTC`);
    console.log(`  delta total     : ${(summary.delta_total || 0).toFixed(6)} BTC`);
    console.log(`\n  BTC index price : $${btcPrice.toLocaleString()}`);
    console.log(`\n  Equity in USD   : $${(summary.equity * btcPrice).toFixed(2)}`);
    console.log(`  Balance in USD  : $${(summary.balance * btcPrice).toFixed(2)}`);

    // Open positions
    const positions = await deribitGet('/api/v2/private/get_positions?currency=BTC&kind=future', token);
    const open = positions.filter(p => p.size !== 0);
    console.log('\n──────────────────────────────────────────────');
    console.log('  OPEN POSITIONS');
    console.log('──────────────────────────────────────────────');
    if (open.length === 0) {
      console.log('  FLAT — no open positions');
    } else {
      for (const p of open) {
        const side = p.size > 0 ? 'LONG' : 'SHORT';
        console.log(`  ${p.instrument_name.padEnd(18)} ${side.padEnd(6)} ${Math.abs(p.size)} contracts = $${Math.abs(p.size * 10)} | avg=$${p.average_price} | uPnL=${p.floating_profit_loss.toFixed(8)} BTC`);
      }
    }

    // Open orders
    const orders = await deribitGet('/api/v2/private/get_open_orders_by_currency?currency=BTC', token);
    console.log('\n──────────────────────────────────────────────');
    console.log('  OPEN ORDERS');
    console.log('──────────────────────────────────────────────');
    if (!orders || orders.length === 0) {
      console.log('  None');
    } else {
      for (const o of orders) {
        console.log(`  ${o.instrument_name.padEnd(18)} ${o.direction.toUpperCase().padEnd(5)} ${o.amount} @ $${o.price}  id=${o.order_id}  state=${o.order_state}`);
      }
    }

    console.log('\n══════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
