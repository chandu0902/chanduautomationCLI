/**
 * Fetches current Deribit balance + session P&L fields directly from account summary.
 * Also pulls settlement history (variation margin settlements) since bot start.
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
async function deribitGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}
async function deribitPost(method, params, token) {
  const r = await axios.post('https://www.deribit.com/api/v2/private/' + method, {
    jsonrpc: '2.0', id: 1, method: 'private/' + method, params
  }, { headers: { Authorization: `Bearer ${token}` } });
  return r.data.result;
}

(async () => {
  try {
    await sequelize.authenticate();
    const account = await AccountDetails.findOne({
      where: { Trade_Account: 'Deribit-H4', Status: 'Active' }
    });
    const { apiKey, secret } = getCredentials(account);
    const token = await getDeribitToken(apiKey, secret);

    const btcIndex = await deribitGet('/api/v2/public/get_index_price?index_name=btc_usd', token);
    const btcPrice = btcIndex.index_price;

    // Extended account summary — includes session_rpl, session_upl, projected_initial_margin etc
    const s = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token);

    // Settlement history since bot start
    const botStartMs = new Date('2026-03-23T13:45:00.000Z').getTime();
    let settlements = [];
    try {
      const sr = await deribitPost('get_settlement_history_by_currency', {
        currency: 'BTC',
        start_timestamp: botStartMs,
        count: 100,
      }, token);
      settlements = sr.settlements || [];
    } catch(e) { console.log('Settlement fetch error:', e.message); }

    // Sum settlement P&L (variation margin moved to balance)
    const settlePnlBtc = settlements.reduce((s, x) => s + (x.profit_loss || 0), 0);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  DERIBIT — CURRENT BALANCE & SESSION P&L');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  BTC price now        : $${btcPrice.toLocaleString()}`);
    console.log('');
    console.log(`  equity               : ${s.equity.toFixed(8)} BTC   = $${(s.equity * btcPrice).toFixed(2)}`);
    console.log(`  balance (settled)    : ${s.balance.toFixed(8)} BTC   = $${(s.balance * btcPrice).toFixed(2)}`);
    console.log(`  unrealized PnL       : ${(s.total_pl||0).toFixed(8)} BTC`);

    // Session fields — present in extended summary
    const sessionRpl = s.session_rpl;
    const sessionUpl = s.session_upl;
    console.log('');
    if (sessionRpl !== undefined) {
      console.log(`  session realized PnL : ${sessionRpl >= 0 ? '+' : ''}${sessionRpl.toFixed(8)} BTC   = $${(sessionRpl * btcPrice).toFixed(2)}`);
    }
    if (sessionUpl !== undefined) {
      console.log(`  session unrealized   : ${sessionUpl >= 0 ? '+' : ''}${sessionUpl.toFixed(8)} BTC   = $${(sessionUpl * btcPrice).toFixed(2)}`);
    }

    // All summary keys for reference
    const interestingKeys = ['delta_total','initial_margin','maintenance_margin',
      'available_funds','available_withdrawal_funds','futures_session_rpl',
      'futures_session_upl','options_session_rpl','options_session_upl',
      'options_pl','options_delta','futures_pl'];
    console.log('');
    for (const k of interestingKeys) {
      if (s[k] !== undefined && s[k] !== null && s[k] !== 0) {
        console.log(`  ${k.padEnd(30)}: ${typeof s[k] === 'number' ? s[k].toFixed(8) : s[k]}`);
      }
    }

    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  SETTLEMENTS since bot start (2026-03-23 13:45 UTC)');
    console.log('──────────────────────────────────────────────────────────');
    if (settlements.length === 0) {
      console.log('  None');
    } else {
      for (const x of settlements) {
        const ts = new Date(x.timestamp).toISOString();
        const pl = x.profit_loss || 0;
        console.log(`  ${ts}  ${(x.instrument_name||'').padEnd(18)} pnl=${pl >= 0 ? '+' : ''}${pl.toFixed(8)} BTC ($${(pl * btcPrice).toFixed(4)})`);
      }
      console.log(`  TOTAL settlement PnL : ${settlePnlBtc >= 0 ? '+' : ''}${settlePnlBtc.toFixed(8)} BTC ($${(settlePnlBtc * btcPrice).toFixed(2)})`);
    }

    // Reference point from this morning's investigation (08:00 UTC)
    const refEquity = 0.07036417;
    const refBalance = 0.06897316;
    const equityDelta = s.equity - refEquity;
    const balanceDelta = s.balance - refBalance;
    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  REFERENCE: vs this morning 08:00 UTC snapshot');
    console.log('──────────────────────────────────────────────────────────');
    console.log(`  equity  at 08:00 UTC : ${refEquity.toFixed(8)} BTC   ($${(refEquity * btcPrice).toFixed(2)})`);
    console.log(`  equity  now          : ${s.equity.toFixed(8)} BTC   ($${(s.equity * btcPrice).toFixed(2)})`);
    console.log(`  equity  change       : ${equityDelta >= 0 ? '+' : ''}${equityDelta.toFixed(8)} BTC   ($${(equityDelta * btcPrice).toFixed(2)})`);
    console.log('');
    console.log(`  balance at 08:00 UTC : ${refBalance.toFixed(8)} BTC   ($${(refBalance * btcPrice).toFixed(2)})`);
    console.log(`  balance now          : ${s.balance.toFixed(8)} BTC   ($${(s.balance * btcPrice).toFixed(2)})`);
    console.log(`  balance change       : ${balanceDelta >= 0 ? '+' : ''}${balanceDelta.toFixed(8)} BTC   ($${(balanceDelta * btcPrice).toFixed(2)})`);

    console.log('\n══════════════════════════════════════════════════════════\n');
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
  }
})();
