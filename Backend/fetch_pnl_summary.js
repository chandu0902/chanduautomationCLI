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
const Trade = sequelize.define('Trade', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  pairId: DataTypes.INTEGER,
  status: DataTypes.STRING,
  pnl: DataTypes.DOUBLE,
  legA_filledAt: DataTypes.DATE,
  legB_filledAt: DataTypes.DATE,
  createdAt: DataTypes.DATE,
}, { tableName: 'trade_logs', timestamps: true });

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

    // First trade date for pair 55
    const firstTrade = await Trade.findOne({
      where: { pairId: 55 },
      order: [['createdAt', 'ASC']],
    });
    const firstDate = firstTrade ? new Date(firstTrade.createdAt) : null;
    console.log(`\nPair 55 first DB trade : ${firstDate ? firstDate.toISOString() : 'none'}`);

    // Get Deribit creds
    const account = await AccountDetails.findOne({
      where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' }
    });
    const { apiKey, secret } = getCredentials(account);
    const token = await getDeribitToken(apiKey, secret);

    // Current account summary
    const summary = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token);
    const btcIndex = await deribitGet('/api/v2/public/get_index_price?index_name=btc_usd', token);
    const btcPrice = btcIndex.index_price;

    // Deribit transaction log — earliest deposits / transfers to find starting balance
    // get_transaction_log covers settlements, deposits, withdrawals, trades
    const now = Date.now();
    // look back 30 days
    const startTs = now - (30 * 24 * 60 * 60 * 1000);
    let txLog = null;
    try {
      txLog = await deribitGet(
        `/api/v2/private/get_transaction_log?currency=BTC&start_timestamp=${startTs}&end_timestamp=${now}&count=100`,
        token
      );
    } catch(e) {
      console.log('Transaction log not available:', e.message);
    }

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  DERIBIT BTC ACCOUNT — P&L SUMMARY');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Current equity    : ${summary.equity.toFixed(8)} BTC   ($${(summary.equity * btcPrice).toFixed(2)})`);
    console.log(`  Current balance   : ${summary.balance.toFixed(8)} BTC   ($${(summary.balance * btcPrice).toFixed(2)})`);
    console.log(`  BTC price         : $${btcPrice.toLocaleString()}`);

    if (txLog && txLog.logs) {
      // Filter deposits, withdrawals, settlements
      const deposits     = txLog.logs.filter(l => l.type === 'deposit');
      const withdrawals  = txLog.logs.filter(l => l.type === 'withdrawal');
      const settlements  = txLog.logs.filter(l => l.type === 'settlement');
      const transfers    = txLog.logs.filter(l => l.type === 'transfer');

      const totalDeposited   = deposits.reduce((s, l)    => s + (l.amount || 0), 0);
      const totalWithdrawn   = withdrawals.reduce((s, l) => s + (l.amount || 0), 0);

      console.log('\n──────────────────────────────────────────────────────────');
      console.log('  TRANSACTION LOG (last 30 days)');
      console.log('──────────────────────────────────────────────────────────');
      console.log(`  Deposits (${deposits.length})     : +${totalDeposited.toFixed(8)} BTC`);
      for (const d of deposits) {
        const ts = new Date(d.timestamp).toISOString();
        console.log(`    ${ts}  +${(d.amount||0).toFixed(8)} BTC  ${d.info||''}`);
      }
      console.log(`  Withdrawals (${withdrawals.length})  : -${totalWithdrawn.toFixed(8)} BTC`);
      for (const w of withdrawals) {
        const ts = new Date(w.timestamp).toISOString();
        console.log(`    ${ts}  -${(w.amount||0).toFixed(8)} BTC`);
      }
      console.log(`  Transfers (${transfers.length})`);
      for (const t of transfers) {
        const ts = new Date(t.timestamp).toISOString();
        console.log(`    ${ts}  ${t.amount >= 0 ? '+' : ''}${(t.amount||0).toFixed(8)} BTC  ${t.info||''}`);
      }

      // Net deposited = what went in minus what came out
      const netFunded = totalDeposited - totalWithdrawn;
      const tradingPnL = summary.balance - netFunded;

      console.log('\n──────────────────────────────────────────────────────────');
      console.log('  P&L CALCULATION (30-day window)');
      console.log('──────────────────────────────────────────────────────────');
      console.log(`  Net funded (deposits - withdrawals) : ${netFunded.toFixed(8)} BTC`);
      console.log(`  Current balance                     : ${summary.balance.toFixed(8)} BTC`);
      console.log(`  Trading P&L (balance - funded)      : ${tradingPnL >= 0 ? '+' : ''}${tradingPnL.toFixed(8)} BTC  ($${(tradingPnL * btcPrice).toFixed(2)})`);
      console.log(`  In profit?  ${tradingPnL >= 0 ? '✅ YES' : '❌ NO'}`);

      if (settlements.length > 0) {
        console.log(`\n  Settlements (${settlements.length} events):`);
        for (const s of settlements.slice(0, 10)) {
          const ts = new Date(s.timestamp).toISOString();
          console.log(`    ${ts}  ${s.amount >= 0 ? '+' : ''}${(s.amount||0).toFixed(8)} BTC  ${s.instrument_name||''}`);
        }
      }
    } else {
      console.log('\n  Transaction log unavailable — cannot compute exact starting balance.');
      console.log('  Known reference point from this morning\'s investigation (08:00 UTC):');
      console.log('    equity at 08:00 : 0.07036417 BTC   ($4,989 @ ~$70,900)');
      console.log(`    equity now      : ${summary.equity.toFixed(8)} BTC   ($${(summary.equity * btcPrice).toFixed(2)})`);
      const delta = summary.equity - 0.07036417;
      console.log(`    change since 08:00 : ${delta >= 0 ? '+' : ''}${delta.toFixed(8)} BTC  ($${(delta * btcPrice).toFixed(2)})`);
    }

    console.log('\n══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
