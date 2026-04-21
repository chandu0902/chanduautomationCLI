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

// Fetch all user trades since a start timestamp, paginating by count=1000
async function getAllFills(token, currency, startMs) {
  const fills = [];
  let offset = 0;
  while (true) {
    const res = await deribitPost('get_user_trades_by_currency', {
      currency,
      start_timestamp: startMs,
      count: 1000,
      include_old: true,
      sorting: 'asc',
      offset,
    }, token);
    const trades = res.trades || [];
    fills.push(...trades);
    if (!res.has_more) break;
    offset += trades.length;
    if (trades.length === 0) break;
  }
  return fills;
}

// Fetch settlement history since startMs
async function getSettlements(token, currency, startMs) {
  const res = await deribitPost('get_settlement_history_by_currency', {
    currency,
    type: 'settlement',
    start_timestamp: startMs,
    count: 100,
  }, token);
  return res.settlements || [];
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
    const summary = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token);

    // Bot started 2026-03-23 13:45 UTC
    const botStartMs = new Date('2026-03-23T13:45:00.000Z').getTime();

    console.log('\nFetching all fills since bot start (2026-03-23T13:45 UTC)...');
    const fills = await getAllFills(token, 'BTC', botStartMs);
    console.log(`  Total exchange fills fetched: ${fills.length}`);

    // Sum up realized PnL (profit_loss field on each fill, in BTC)
    // Sum fees (fee field, in BTC, negative = rebate credit)
    let totalProfitLossBtc = 0;
    let totalFeesBtc = 0;
    let totalVolUsd = 0;

    const byInstrument = {};
    for (const f of fills) {
      totalProfitLossBtc += (f.profit_loss || 0);
      totalFeesBtc       += (f.fee || 0);
      totalVolUsd        += Math.abs(f.amount || 0) * 10; // amount in contracts, each=$10

      const inst = f.instrument_name;
      if (!byInstrument[inst]) byInstrument[inst] = { buys: 0, sells: 0, pnlBtc: 0, feesBtc: 0, volUsd: 0 };
      if (f.direction === 'buy')  byInstrument[inst].buys++;
      else                        byInstrument[inst].sells++;
      byInstrument[inst].pnlBtc  += (f.profit_loss || 0);
      byInstrument[inst].feesBtc += (f.fee || 0);
      byInstrument[inst].volUsd  += Math.abs(f.amount || 0) * 10;
    }

    // Settlements (funding/variation margin) since bot start
    const settlements = await getSettlements(token, 'BTC', botStartMs);
    let totalSettleBtc = 0;
    for (const s of settlements) totalSettleBtc += (s.profit_loss || 0);

    // Net exchange P&L in BTC
    const netExchangePnlBtc = totalProfitLossBtc - totalFeesBtc + totalSettleBtc;
    const netExchangePnlUsd = netExchangePnlBtc * btcPrice;

    // Implied starting balance
    const currentBalance = summary.balance;
    const impliedStartBalance = currentBalance - netExchangePnlBtc;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  ACTUAL EXCHANGE P&L — since bot start 2026-03-23 13:45 UTC');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  BTC index price now      : $${btcPrice.toLocaleString()}`);
    console.log(`\n  Total fills processed    : ${fills.length}`);
    console.log(`  Total volume (fills)     : $${totalVolUsd.toLocaleString()}`);
    console.log(`\n  Realized PnL (fills)     : ${totalProfitLossBtc >= 0 ? '+' : ''}${totalProfitLossBtc.toFixed(8)} BTC   ($${(totalProfitLossBtc * btcPrice).toFixed(2)})`);
    console.log(`  Fees paid (fills)        : ${totalFeesBtc >= 0 ? '+' : ''}${totalFeesBtc.toFixed(8)} BTC   ($${(totalFeesBtc * btcPrice).toFixed(2)})  [negative = rebate]`);
    console.log(`  Settlement P&L           : ${totalSettleBtc >= 0 ? '+' : ''}${totalSettleBtc.toFixed(8)} BTC   ($${(totalSettleBtc * btcPrice).toFixed(2)})`);
    console.log(`\n  NET EXCHANGE P&L         : ${netExchangePnlBtc >= 0 ? '+' : ''}${netExchangePnlBtc.toFixed(8)} BTC   ($${netExchangePnlUsd.toFixed(2)})`);

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  BALANCE RECONCILIATION');
    console.log('──────────────────────────────────────────────────────────');
    console.log(`  Implied starting balance : ${impliedStartBalance.toFixed(8)} BTC   ($${(impliedStartBalance * btcPrice).toFixed(2)})`);
    console.log(`  Current balance (now)    : ${currentBalance.toFixed(8)} BTC   ($${(currentBalance * btcPrice).toFixed(2)})`);
    console.log(`  Current equity (now)     : ${summary.equity.toFixed(8)} BTC   ($${(summary.equity * btcPrice).toFixed(2)})`);
    console.log(`\n  Net change since start   : ${netExchangePnlBtc >= 0 ? '+' : ''}${netExchangePnlBtc.toFixed(8)} BTC   ($${netExchangePnlUsd.toFixed(2)})`);
    console.log(`  In profit?  ${netExchangePnlBtc >= 0 ? '✅ YES' : '❌ NO'}`);

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  BY INSTRUMENT');
    console.log('──────────────────────────────────────────────────────────');
    for (const [inst, d] of Object.entries(byInstrument)) {
      console.log(`  ${inst.padEnd(20)} buys=${d.buys} sells=${d.sells} | pnl=${d.pnlBtc >= 0 ? '+' : ''}${d.pnlBtc.toFixed(8)} BTC ($${(d.pnlBtc * btcPrice).toFixed(2)}) | fees=${d.feesBtc.toFixed(8)} BTC | vol=$${d.volUsd.toLocaleString()}`);
    }

    if (settlements.length > 0) {
      console.log('\n──────────────────────────────────────────────────────────');
      console.log('  SETTLEMENTS');
      console.log('──────────────────────────────────────────────────────────');
      for (const s of settlements) {
        const ts = new Date(s.timestamp).toISOString();
        console.log(`  ${ts}  ${s.instrument_name.padEnd(18)} pnl=${s.profit_loss >= 0 ? '+' : ''}${(s.profit_loss||0).toFixed(8)} BTC`);
      }
    }

    console.log('\n══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
