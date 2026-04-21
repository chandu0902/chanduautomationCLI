/**
 * Get actual realized P&L per instrument since bot start by summing fill profit_loss.
 * Uses per-instrument endpoint (much faster than by_currency with offset pagination).
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
async function deribitPost(method, params, token) {
  const r = await axios.post('https://www.deribit.com/api/v2/private/' + method, {
    jsonrpc: '2.0', id: 1, method: 'private/' + method, params
  }, { headers: { Authorization: `Bearer ${token}` } });
  return r.data.result;
}
async function deribitGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}

async function getFillsForInstrument(token, instrument, startMs) {
  // Use start_seq for fast chronological fetch — no offset pagination needed
  let allFills = [];
  let startSeq = 0;
  while (true) {
    const res = await deribitPost('get_user_trades_by_instrument_and_time', {
      instrument_name: instrument,
      start_timestamp: startMs,
      end_timestamp: Date.now(),
      count: 1000,
      sorting: 'asc',
    }, token);
    const trades = res.trades || [];
    allFills.push(...trades);
    if (!res.has_more || trades.length === 0) break;
    // Advance start_timestamp past last fill to avoid re-fetching
    startMs = trades[trades.length - 1].timestamp + 1;
  }
  return allFills;
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
    const summary  = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token);

    // Bot started 2026-03-23 13:45 UTC
    const botStartMs = new Date('2026-03-23T13:45:00.000Z').getTime();

    const instruments = ['BTC-24APR26', 'BTC-PERPETUAL', 'BTC-3APR26'];
    const results = {};

    for (const inst of instruments) {
      process.stdout.write(`Fetching ${inst}...`);
      const fills = await getFillsForInstrument(token, inst, botStartMs);
      const pnlBtc  = fills.reduce((s, f) => s + (f.profit_loss || 0), 0);
      const feesBtc = fills.reduce((s, f) => s + (f.fee || 0), 0);
      const volUsd  = fills.reduce((s, f) => s + Math.abs(f.amount || 0) * 10, 0);
      const buys    = fills.filter(f => f.direction === 'buy').length;
      const sells   = fills.filter(f => f.direction === 'sell').length;
      results[inst] = { fills: fills.length, buys, sells, pnlBtc, feesBtc, volUsd };
      console.log(` ${fills.length} fills`);
    }

    const totalPnlBtc  = Object.values(results).reduce((s, r) => s + r.pnlBtc, 0);
    const totalFeesBtc = Object.values(results).reduce((s, r) => s + r.feesBtc, 0);
    const netPnlBtc    = totalPnlBtc - totalFeesBtc;
    const netPnlUsd    = netPnlBtc * btcPrice;

    // Implied starting balance = current balance - net PnL since start
    const currentBalance = summary.balance;
    const currentEquity  = summary.equity;
    const impliedStart   = currentBalance - netPnlBtc;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  ACTUAL EXCHANGE P&L SINCE BOT START (2026-03-23 13:45 UTC)');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  BTC price          : $${btcPrice.toLocaleString()}`);
    console.log('');

    for (const [inst, r] of Object.entries(results)) {
      if (r.fills === 0) continue;
      console.log(`  ${inst.padEnd(18)}: ${r.fills} fills (${r.buys}B/${r.sells}S) | vol=$${r.volUsd.toLocaleString()} | pnl=${r.pnlBtc >= 0 ? '+' : ''}${r.pnlBtc.toFixed(8)} BTC | fees=${r.feesBtc.toFixed(8)} BTC`);
    }

    console.log('');
    console.log(`  Total realized PnL : ${totalPnlBtc >= 0 ? '+' : ''}${totalPnlBtc.toFixed(8)} BTC   ($${(totalPnlBtc * btcPrice).toFixed(2)})`);
    console.log(`  Total fees paid    : ${totalFeesBtc >= 0 ? '+' : ''}${totalFeesBtc.toFixed(8)} BTC   ($${(totalFeesBtc * btcPrice).toFixed(2)})`);
    console.log(`  Net PnL (pnl-fees) : ${netPnlBtc >= 0 ? '+' : ''}${netPnlBtc.toFixed(8)} BTC   ($${netPnlUsd.toFixed(2)})`);

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  BALANCE RECONCILIATION');
    console.log('──────────────────────────────────────────────────────────');
    console.log(`  Implied start balance: ${impliedStart.toFixed(8)} BTC   ($${(impliedStart * btcPrice).toFixed(2)})`);
    console.log(`  Current balance now  : ${currentBalance.toFixed(8)} BTC   ($${(currentBalance * btcPrice).toFixed(2)})`);
    console.log(`  Current equity now   : ${currentEquity.toFixed(8)} BTC   ($${(currentEquity * btcPrice).toFixed(2)})`);
    console.log('');
    console.log(`  Net change           : ${netPnlBtc >= 0 ? '+' : ''}${netPnlBtc.toFixed(8)} BTC   ($${netPnlUsd.toFixed(2)})`);
    console.log(`  In profit?           : ${netPnlBtc >= 0 ? '✅ YES' : '❌ NO'}`);
    console.log('══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
