require('dotenv').config();
const crypto  = require('crypto');
const axios   = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const seq = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);
const AccountDetails = seq.define('AccountDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  Trade_Account: DataTypes.STRING,
  Api_Key: DataTypes.TEXT,
  Secret_Key: DataTypes.TEXT,
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
async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret }
  });
  return r.data.result.access_token;
}
async function dGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}
async function dPost(method, params, token) {
  const r = await axios.post(`https://www.deribit.com/api/v2/private/${method}`, {
    jsonrpc: '2.0', id: 1, method: `private/${method}`, params
  }, { headers: { Authorization: `Bearer ${token}` } });
  return r.data.result;
}

(async () => {
  try {
    await seq.authenticate();
    const account = await AccountDetails.findOne({ where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' } });
    const { apiKey, secret } = getCredentials(account);
    const token = await getToken(apiKey, secret);

    // ── 1. Cancel ALL open orders (BTC futures + perps) ───────────────
    console.log('\n─── OPEN ORDERS ──────────────────────────────────────────');
    const orders = await dGet('/api/v2/private/get_open_orders_by_currency?currency=BTC', token);
    console.log(`Found ${orders.length} open order(s)`);
    for (const o of orders) {
      process.stdout.write(`  ${o.instrument_name} ${o.direction} qty=${o.amount} @ ${o.price} id=${o.order_id} ... `);
      await dPost('cancel', { order_id: o.order_id }, token)
        .then(() => console.log('✓ cancelled'))
        .catch(e  => console.log('✗', e.response?.data?.error?.message || e.message));
    }
    if (orders.length === 0) console.log('  None — already clean');

    // Verify
    const rem = await dGet('/api/v2/private/get_open_orders_by_currency?currency=BTC', token);
    console.log(`Orders remaining: ${rem.length}`);

    // ── 2. Close all open positions ────────────────────────────────────
    console.log('\n─── OPEN POSITIONS ───────────────────────────────────────');
    const positions = await dGet('/api/v2/private/get_positions?currency=BTC&kind=future', token);
    const nonZero = positions.filter(p => parseFloat(p.size) !== 0);
    console.log(`Found ${nonZero.length} position(s)`);

    for (const pos of nonZero) {
      const size      = parseFloat(pos.size);
      const closeSide = size > 0 ? 'sell' : 'buy';
      const closeQty  = Math.abs(size);
      process.stdout.write(`  ${pos.instrument_name} size=${size} → ${closeSide} ${closeQty} market ... `);
      const method = closeSide === 'buy' ? 'buy' : 'sell';
      await dPost(method, {
        instrument_name: pos.instrument_name,
        amount: closeQty,
        type: 'market',
        reduce_only: true,
        label: 'emergency_close',
      }, token)
        .then(() => console.log('✓ closed'))
        .catch(e  => console.log('✗', e.response?.data?.error?.message || e.message));
    }
    if (nonZero.length === 0) console.log('  None — already flat');

    // Verify positions
    await new Promise(r => setTimeout(r, 2000));
    const posAfter = await dGet('/api/v2/private/get_positions?currency=BTC&kind=future', token);
    const stillOpen = posAfter.filter(p => parseFloat(p.size) !== 0);
    if (stillOpen.length === 0) {
      console.log('\n✅  Account is FLAT — no open positions');
    } else {
      console.log('\n⚠️  Still open:');
      stillOpen.forEach(p => console.log(`   ${p.instrument_name}: ${p.size}`));
    }

    // ── 3. Mark pair 62 inactive ───────────────────────────────────────
    await seq.query("UPDATE statarb_inputs SET status='inactive', tradingEnabled=0 WHERE id=63");
    console.log('✅  Pair 63 marked inactive in DB\n');

    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
