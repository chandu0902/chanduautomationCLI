/**
 * Compute max/min basis spread between BTC-24APR26 and BTC-PERPETUAL
 * since bot start (2026-03-23 13:45 UTC) using 1-minute OHLCV candles.
 */
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
  Trade_Account: DataTypes.STRING,
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

async function getCandles(instrument, startMs, endMs, resolution = '1') {
  // Deribit tradingview chart data — resolution in minutes or 'D'
  const url = `https://www.deribit.com/api/v2/public/get_tradingview_chart_data` +
    `?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${resolution}`;
  const r = await axios.get(url);
  return r.data.result; // { ticks, open, high, low, close, volume, status }
}

(async () => {
  try {
    await sequelize.authenticate();
    const account = await AccountDetails.findOne({
      where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' }
    });
    const { apiKey, secret } = getCredentials(account);
    const token = await getDeribitToken(apiKey, secret);

    const botStartMs = new Date('2026-03-23T13:45:00.000Z').getTime();
    const nowMs      = Date.now();

    console.log('Fetching 1-min candles for BTC-24APR26...');
    const futCandles = await getCandles('BTC-24APR26',   botStartMs, nowMs, '1');
    console.log(`  Got ${futCandles.ticks?.length || 0} candles`);

    console.log('Fetching 1-min candles for BTC-PERPETUAL...');
    const perpCandles = await getCandles('BTC-PERPETUAL', botStartMs, nowMs, '1');
    console.log(`  Got ${perpCandles.ticks?.length || 0} candles`);

    if (!futCandles.ticks?.length || !perpCandles.ticks?.length) {
      console.error('No candle data returned'); process.exit(1);
    }

    // Build maps: timestamp → close price
    const futMap  = new Map();
    const perpMap = new Map();
    futCandles.ticks.forEach((t, i)  => futMap.set(t,  futCandles.close[i]));
    perpCandles.ticks.forEach((t, i) => perpMap.set(t, perpCandles.close[i]));

    // Intersect timestamps
    const spreads = [];
    for (const [ts, futPrice] of futMap) {
      if (perpMap.has(ts)) {
        const perpPrice = perpMap.get(ts);
        const spread    = futPrice - perpPrice;  // basis = futures - perp
        const spreadPct = (spread / perpPrice) * 100;
        spreads.push({ ts, futPrice, perpPrice, spread, spreadPct });
      }
    }

    spreads.sort((a, b) => a.ts - b.ts);

    if (spreads.length === 0) { console.error('No overlapping timestamps'); process.exit(1); }

    // Statistics
    const spreadValues = spreads.map(s => s.spread);
    const maxSpread    = Math.max(...spreadValues);
    const minSpread    = Math.min(...spreadValues);
    const avgSpread    = spreadValues.reduce((a, b) => a + b, 0) / spreadValues.length;
    const currentSpread = spreads[spreads.length - 1].spread;

    const maxRow = spreads.find(s => s.spread === maxSpread);
    const minRow = spreads.find(s => s.spread === minSpread);

    // Distribution: how many candles had spread > 10, > 20, > 30, > 50, > 100
    const dist = [5, 10, 20, 30, 50, 100].map(thresh => ({
      thresh,
      count: spreadValues.filter(v => Math.abs(v) > thresh).length,
      pct:   (spreadValues.filter(v => Math.abs(v) > thresh).length / spreadValues.length * 100).toFixed(1),
    }));

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  BTC BASIS SPREAD ANALYSIS — 2026-03-23 13:45 UTC → now');
    console.log('  Spread = BTC-24APR26 (futures) MINUS BTC-PERPETUAL (perp)');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Candles analysed   : ${spreads.length} minutes`);
    console.log(`  Period             : ${new Date(spreads[0].ts).toISOString()} → ${new Date(spreads[spreads.length-1].ts).toISOString()}`);
    console.log('');
    console.log(`  Current spread     : $${currentSpread.toFixed(2)}  (${spreads[spreads.length-1].spreadPct.toFixed(4)}%)`);
    console.log(`  Average spread     : $${avgSpread.toFixed(2)}`);
    console.log('');
    console.log(`  ┌─ MAX spread      : $${maxSpread.toFixed(2)}  at ${new Date(maxRow.ts).toISOString()}`);
    console.log(`  │    futures       : $${maxRow.futPrice.toFixed(2)}`);
    console.log(`  │    perp          : $${maxRow.perpPrice.toFixed(2)}`);
    console.log(`  │    spread %      : ${maxRow.spreadPct.toFixed(4)}%`);
    console.log('  │');
    console.log(`  └─ MIN spread      : $${minSpread.toFixed(2)}  at ${new Date(minRow.ts).toISOString()}`);
    console.log(`       futures       : $${minRow.futPrice.toFixed(2)}`);
    console.log(`       perp          : $${minRow.perpPrice.toFixed(2)}`);
    console.log(`       spread %      : ${minRow.spreadPct.toFixed(4)}%`);

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  SPREAD DISTRIBUTION (|spread| > threshold)');
    console.log('──────────────────────────────────────────────────────────');
    for (const d of dist) {
      const bar = '█'.repeat(Math.round(parseFloat(d.pct) / 2));
      console.log(`  >$${String(d.thresh).padEnd(4)} : ${String(d.count).padStart(5)} min (${d.pct.padStart(5)}%)  ${bar}`);
    }

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  TOP 10 WIDEST SPREADS (by absolute $)');
    console.log('──────────────────────────────────────────────────────────');
    const top10 = [...spreads].sort((a,b) => Math.abs(b.spread) - Math.abs(a.spread)).slice(0, 10);
    for (const r of top10) {
      console.log(`  ${new Date(r.ts).toISOString()}  spread=$${r.spread.toFixed(2).padStart(8)}  fut=$${r.futPrice.toFixed(2)}  perp=$${r.perpPrice.toFixed(2)}`);
    }

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  HOURLY SPREAD SUMMARY (close of each hour)');
    console.log('──────────────────────────────────────────────────────────');
    const hourly = {};
    for (const s of spreads) {
      const h = new Date(s.ts);
      h.setMinutes(0, 0, 0);
      hourly[h.getTime()] = s; // last candle in hour overwrites
    }
    for (const [hts, s] of Object.entries(hourly)) {
      console.log(`  ${new Date(parseInt(hts)).toISOString().slice(0,16)}  spread=$${s.spread.toFixed(2).padStart(8)}  (${s.spreadPct.toFixed(3)}%)`);
    }

    console.log('\n══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
