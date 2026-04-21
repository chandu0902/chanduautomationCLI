/**
 * Compute implied annualised carry rate from BTC-24APR26 vs BTC-PERPETUAL basis.
 * Fair basis = Perp × r × (DTE / 365)
 * Implied rate = (Basis / Perp) × (365 / DTE) × 100
 *
 * BTC-24APR26 expiry: 2026-04-24 08:00 UTC
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
  const url = `https://www.deribit.com/api/v2/public/get_tradingview_chart_data` +
    `?instrument_name=${encodeURIComponent(instrument)}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${resolution}`;
  const r = await axios.get(url);
  return r.data.result;
}
async function deribitGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}

// BTC-24APR26 expiry — Deribit quarterly expiry 08:00 UTC on last Friday of month
const EXPIRY_MS = new Date('2026-04-24T08:00:00.000Z').getTime();
const MS_PER_DAY = 86400000;

function dte(ts) {
  return (EXPIRY_MS - ts) / MS_PER_DAY; // fractional days to expiry
}

function impliedRate(basis, perpPrice, dteDays) {
  if (dteDays <= 0 || perpPrice <= 0) return null;
  return (basis / perpPrice) * (365 / dteDays) * 100; // annualised %
}

function fairSpread(perpPrice, ratePct, dteDays) {
  return perpPrice * (ratePct / 100) * (dteDays / 365);
}

function stddev(arr, mean) {
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

(async () => {
  try {
    await sequelize.authenticate();
    const account = await AccountDetails.findOne({
      where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' }
    });
    const { apiKey, secret } = getCredentials(account);
    const token = await getDeribitToken(apiKey, secret);

    const btcIndex = await deribitGet('/api/v2/public/get_index_price?index_name=btc_usd', token);
    const btcPrice = btcIndex.index_price;

    const botStartMs = new Date('2026-03-23T13:45:00.000Z').getTime();
    const nowMs      = Date.now();

    console.log('Fetching 1-min candles...');
    const [futC, perpC] = await Promise.all([
      getCandles('BTC-24APR26',   botStartMs, nowMs, '1'),
      getCandles('BTC-PERPETUAL', botStartMs, nowMs, '1'),
    ]);
    console.log(`  Futures: ${futC.ticks?.length} candles  |  Perp: ${perpC.ticks?.length} candles`);

    // Build maps
    const futMap  = new Map();
    const perpMap = new Map();
    futC.ticks.forEach((t, i)  => futMap.set(t,  futC.close[i]));
    perpC.ticks.forEach((t, i) => perpMap.set(t, perpC.close[i]));

    // Compute implied rate at each minute
    const rows = [];
    for (const [ts, futPrice] of futMap) {
      if (!perpMap.has(ts)) continue;
      const perpPrice = perpMap.get(ts);
      const basis     = futPrice - perpPrice;
      const dteDays   = dte(ts);
      const rate      = impliedRate(basis, perpPrice, dteDays);
      if (rate === null) continue;
      rows.push({ ts, futPrice, perpPrice, basis, dteDays, rate });
    }
    rows.sort((a, b) => a.ts - b.ts);

    const rates   = rows.map(r => r.rate);
    const bases   = rows.map(r => r.basis);
    const meanRate = rates.reduce((s, v) => s + v, 0) / rates.length;
    const maxRate  = Math.max(...rates);
    const minRate  = Math.min(...rates);
    const sdRate   = stddev(rates, meanRate);

    const meanBasis = bases.reduce((s, v) => s + v, 0) / bases.length;
    const maxBasis  = Math.max(...bases);
    const minBasis  = Math.min(...bases);

    const maxRateRow  = rows.find(r => r.rate === maxRate);
    const minRateRow  = rows.find(r => r.rate === minRate);

    // Current DTE and fair spread at mean rate
    const nowDte         = dte(nowMs);
    const fairSpreadNow  = fairSpread(btcPrice, meanRate, nowDte);
    const currentBasis   = (rows[rows.length - 1]?.basis) || 0;
    const currentRate    = rows[rows.length - 1]?.rate || 0;

    // Rate buckets
    const buckets = [
      { label: '< 5%',   fn: r => r < 5 },
      { label: '5–10%',  fn: r => r >= 5  && r < 10 },
      { label: '10–15%', fn: r => r >= 10 && r < 15 },
      { label: '15–20%', fn: r => r >= 15 && r < 20 },
      { label: '20–25%', fn: r => r >= 20 && r < 25 },
      { label: '> 25%',  fn: r => r >= 25 },
    ].map(b => ({ ...b, count: rates.filter(b.fn).length }));

    // Hourly implied rate
    const hourlyRate = {};
    for (const row of rows) {
      const h = new Date(row.ts);
      h.setMinutes(0, 0, 0);
      const hts = h.getTime();
      if (!hourlyRate[hts]) hourlyRate[hts] = [];
      hourlyRate[hts].push(row.rate);
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  BTC BASIS — IMPLIED ANNUALISED CARRY RATE');
    console.log('  Period : 2026-03-23 13:45 UTC → now');
    console.log('  Model  : Rate = (Basis / Perp) × (365 / DTE) × 100');
    console.log('  Expiry : BTC-24APR26  →  2026-04-24 08:00 UTC');
    console.log('══════════════════════════════════════════════════════════════');
    console.log(`\n  BTC index price now  : $${btcPrice.toLocaleString()}`);
    console.log(`  Days to expiry now   : ${nowDte.toFixed(2)} days`);
    console.log(`  Minutes of data      : ${rows.length}`);

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  SPREAD (USD ABSOLUTE)');
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  Mean spread          : $${meanBasis.toFixed(2)}`);
    console.log(`  Max  spread          : $${maxBasis.toFixed(2)}`);
    console.log(`  Min  spread          : $${minBasis.toFixed(2)}`);
    console.log(`  Current spread       : $${currentBasis.toFixed(2)}`);

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  IMPLIED ANNUALISED CARRY RATE (% per annum)');
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  Mean rate            : ${meanRate.toFixed(4)}% p.a.`);
    console.log(`  Std deviation        : ±${sdRate.toFixed(4)}%`);
    console.log(`  1σ band              : ${(meanRate - sdRate).toFixed(4)}% — ${(meanRate + sdRate).toFixed(4)}%`);
    console.log('');
    console.log(`  Max  rate            : ${maxRate.toFixed(4)}% p.a.`);
    console.log(`    at ${new Date(maxRateRow.ts).toISOString()}  DTE=${maxRateRow.dteDays.toFixed(2)}d  basis=$${maxRateRow.basis.toFixed(2)}  perp=$${maxRateRow.perpPrice.toFixed(2)}`);
    console.log(`  Min  rate            : ${minRate.toFixed(4)}% p.a.`);
    console.log(`    at ${new Date(minRateRow.ts).toISOString()}  DTE=${minRateRow.dteDays.toFixed(2)}d  basis=$${minRateRow.basis.toFixed(2)}  perp=$${minRateRow.perpPrice.toFixed(2)}`);
    console.log('');
    console.log(`  Current rate         : ${currentRate.toFixed(4)}% p.a.  (basis=$${currentBasis.toFixed(2)}, DTE=${nowDte.toFixed(2)}d)`);

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  FAIR SPREAD AT MEAN RATE (what basis SHOULD be at mean rate)');
    console.log('──────────────────────────────────────────────────────────────');
    console.log(`  Fair spread now      : $${fairSpreadNow.toFixed(2)}  (at ${meanRate.toFixed(4)}% p.a., DTE=${nowDte.toFixed(2)}d)`);
    console.log(`  Actual spread now    : $${currentBasis.toFixed(2)}`);
    console.log(`  Deviation from fair  : $${(currentBasis - fairSpreadNow).toFixed(2)}  (${(((currentBasis - fairSpreadNow) / fairSpreadNow) * 100).toFixed(2)}%)`);
    console.log('');
    // Fair spread at bot start DTE
    const startDte = dte(botStartMs);
    const fairSpreadStart = fairSpread(71000, meanRate, startDte); // approx perp at start
    console.log(`  Fair spread at start : $${fairSpreadStart.toFixed(2)}  (DTE=${startDte.toFixed(2)}d, perp≈$71,000)`);
    console.log(`  Fair spread now      : $${fairSpreadNow.toFixed(2)}  (DTE=${nowDte.toFixed(2)}d)`);
    console.log(`  Theta (spread decay) : $${(fairSpreadStart - fairSpreadNow).toFixed(2)} over the trading period`);

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  RATE DISTRIBUTION');
    console.log('──────────────────────────────────────────────────────────────');
    for (const b of buckets) {
      const pct = (b.count / rows.length * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(parseFloat(pct) / 2));
      console.log(`  ${b.label.padEnd(8)}: ${String(b.count).padStart(5)} min (${pct.padStart(5)}%)  ${bar}`);
    }

    console.log('\n──────────────────────────────────────────────────────────────');
    console.log('  HOURLY IMPLIED RATE (mean rate per hour)');
    console.log('──────────────────────────────────────────────────────────────');
    for (const [hts, rateArr] of Object.entries(hourlyRate)) {
      const avg = rateArr.reduce((s, v) => s + v, 0) / rateArr.length;
      const mx  = Math.max(...rateArr);
      const mn  = Math.min(...rateArr);
      console.log(`  ${new Date(parseInt(hts)).toISOString().slice(0,16)}  avg=${avg.toFixed(4)}%  range=[${mn.toFixed(4)}% – ${mx.toFixed(4)}%]`);
    }

    console.log('\n══════════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
