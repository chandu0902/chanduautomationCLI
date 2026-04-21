/**
 * Pull ALL paginated Deribit transaction logs (BTC wallet) and attribute balance/equity change.
 *
 *   node analyze_exchange_balance_attribution.js
 *   node analyze_exchange_balance_attribution.js --days=14
 *   node analyze_exchange_balance_attribution.js --account="deribit hiddenroad"
 *   node analyze_exchange_balance_attribution.js --initialUsd=4680
 *
 * Anchored report (screenshot baseline + log from anchor → now):
 *   node analyze_exchange_balance_attribution.js --anchorIso=2026-04-04T19:45:00+05:30 \
 *     --screenshotEquityUsd=4648.24 --screenshotBtc=0.0691 --screenshotIndexUsd=67205.03 --screenshotUsdc=0.49
 *
 * Use the correct timezone in anchorIso for "7:45 PM" local (e.g. +05:30, America/New_York as offset).
 *
 * Writes: Backend/reports/exchange_balance_attribution_<ts>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);
const AccountDetails = sequelize.define(
  'AccountDetails',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    Trade_Account: DataTypes.STRING,
    Api_Key: DataTypes.TEXT,
    Secret_Key: DataTypes.TEXT,
    Status: DataTypes.STRING,
  },
  { tableName: 'AccountDetails', timestamps: false }
);

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = {
    days: 30,
    account: 'deribit hiddenroad',
    initialUsd: null,
    anchorIso: null,
    screenshotEquityUsd: null,
    screenshotBtc: null,
    screenshotIndexUsd: null,
    screenshotUsdc: null,
    lookbackDaysBeforeAnchor: 90,
  };
  for (const a of argv) {
    if (a.startsWith('--days=')) o.days = Math.min(365, Math.max(1, parseInt(a.split('=')[1], 10) || 30));
    else if (a.startsWith('--account=')) o.account = a.split('=')[1].replace(/^"|"$/g, '');
    else if (a.startsWith('--initialUsd=')) o.initialUsd = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--anchorIso=')) o.anchorIso = a.slice('--anchorIso='.length);
    else if (a.startsWith('--screenshotEquityUsd=')) o.screenshotEquityUsd = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--screenshotBtc=')) o.screenshotBtc = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--screenshotIndexUsd=')) o.screenshotIndexUsd = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--screenshotUsdc=')) o.screenshotUsdc = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--lookbackDaysBeforeAnchor='))
      o.lookbackDaysBeforeAnchor = Math.min(365, Math.max(1, parseInt(a.split('=')[1], 10) || 90));
  }
  return o;
}

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0',
    id: 1,
    method: 'public/auth',
    params: {
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secret,
      scope: 'trade:read_write',
    },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
}

async function txLogPage(token, startMs, endMs, continuation) {
  const params = new URLSearchParams({
    currency: 'BTC',
    start_timestamp: String(startMs),
    end_timestamp: String(endMs),
    count: '250',
  });
  if (continuation != null) params.set('continuation', String(continuation));
  const r = await axios.get(`https://www.deribit.com/api/v2/private/get_transaction_log?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BOT_SYMS = new Set(['BTC-PERPETUAL', 'BTC-29MAY26']);

async function fetchAllTxLogs(token, startMs, endMs, onPage) {
  const allLogs = [];
  let cont = null;
  let pages = 0;
  do {
    await sleep(1100);
    const page = await txLogPage(token, startMs, endMs, cont);
    const chunk = page.logs || [];
    allLogs.push(...chunk);
    cont = page.continuation;
    pages++;
    if (typeof onPage === 'function') onPage(pages, chunk.length, allLogs.length);
    if (pages > 800) break;
  } while (cont != null);
  return { allLogs, pages };
}

function aggregateLogs(allLogs, btcUsd) {
  const byType = {};
  const byTypeChangeBtc = {};
  const byTypeCashflowBtc = {};
  let sumChangeBtc = 0;
  let sumCashflowBtc = 0;
  let botTradeCount = 0;
  let botTradeSumChange = 0;
  let botTradeSumCf = 0;

  for (const row of allLogs) {
    const t = row.type || '(null)';
    byType[t] = (byType[t] || 0) + 1;
    const ch = Number(row.change) || 0;
    const cf = Number(row.cashflow) || 0;
    byTypeChangeBtc[t] = (byTypeChangeBtc[t] || 0) + ch;
    byTypeCashflowBtc[t] = (byTypeCashflowBtc[t] || 0) + cf;
    sumChangeBtc += ch;
    sumCashflowBtc += cf;
    if (t === 'trade' && row.instrument_name && BOT_SYMS.has(row.instrument_name)) {
      botTradeCount++;
      botTradeSumChange += ch;
      botTradeSumCf += cf;
    }
  }
  return {
    byType,
    byTypeChangeBtc,
    byTypeCashflowBtc,
    sumChangeBtc,
    sumCashflowBtc,
    botTradeCount,
    botTradeSumChange,
    botTradeSumCf,
    typesSorted: Object.keys(byTypeChangeBtc).sort((a, b) => Math.abs(byTypeChangeBtc[b]) - Math.abs(byTypeChangeBtc[a])),
  };
}

function equityAtOrBeforeAnchor(logsBeforeAnchor, anchorMs) {
  const eligible = logsBeforeAnchor.filter((r) => Number(r.timestamp) <= anchorMs);
  if (!eligible.length) return null;
  eligible.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const last = eligible[eligible.length - 1];
  return {
    timestamp: last.timestamp,
    equity: last.equity != null ? Number(last.equity) : null,
    balance: last.balance != null ? Number(last.balance) : null,
    id: last.id,
    type: last.type,
  };
}

async function main() {
  const opts = parseArgs();
  const endMs = Date.now();
  const anchorMs = opts.anchorIso ? Date.parse(opts.anchorIso) : null;
  if (opts.anchorIso && Number.isNaN(anchorMs)) {
    console.error('Invalid --anchorIso (use ISO-8601 with zone, e.g. 2026-04-04T19:45:00+05:30)');
    process.exit(1);
  }
  const startMs = anchorMs != null ? anchorMs : endMs - opts.days * 86400000;

  await sequelize.authenticate();
  const accRow = await AccountDetails.findOne({ where: { Trade_Account: opts.account } });
  if (!accRow?.Api_Key || !accRow?.Secret_Key) {
    console.error('Account not found or missing keys:', opts.account);
    process.exit(1);
  }
  const [ak0, ak1, ak2] = accRow.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = accRow.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);

  const token = await getToken(apiKey, secret);

  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
    params: { index_name: 'btc_usd' },
  });
  const btcUsd = Number(ix.data?.result?.index_price) || 0;

  const sumR = await axios.get(
    `https://www.deribit.com/api/v2/private/get_account_summary?currency=BTC&extended=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (sumR.data.error) throw new Error(sumR.data.error.message);
  const s = sumR.data.result;

  const lines = [];
  const log = (x) => lines.push(x);

  log('================================================================================');
  log('DERIBIT BALANCE / PnL ATTRIBUTION (transaction log, full pagination)');
  log(`Generated: ${new Date().toISOString()}`);
  if (anchorMs != null) {
    log(`Mode: ANCHORED from snapshot time`);
    log(`Anchor: ${opts.anchorIso}  (= ${new Date(anchorMs).toISOString()} instant)`);
    log(`Log window: ${new Date(anchorMs).toISOString()} → now`);
  } else {
    log(`Window: last ${opts.days} days (${new Date(startMs).toISOString()} → now)`);
  }
  log(`Account: ${opts.account}`);
  log('================================================================================');
  log('');

  if (opts.screenshotEquityUsd != null || opts.screenshotBtc != null) {
    log('--- Your screenshot baseline (Apr 4 2026 ~7:45 PM per your note) ---');
    if (opts.screenshotEquityUsd != null) log(`  Total account value (USD): $${opts.screenshotEquityUsd.toFixed(2)}`);
    if (opts.screenshotBtc != null) log(`  BTC quantity (NAV):        ${opts.screenshotBtc} BTC`);
    if (opts.screenshotIndexUsd != null) log(`  BTC index / mark (USD):    $${opts.screenshotIndexUsd.toFixed(2)}`);
    if (opts.screenshotUsdc != null) log(`  USDC (from screenshot):      $${opts.screenshotUsdc.toFixed(2)}`);
    log('  Subaccount (from screenshot): hrp9870441587  user_id 433390');
    log('  Note: API credentials must be for this same wallet; transaction log is BTC wallet only.');
    log('');
  }

  log('--- Current get_account_summary (BTC) ---');
  log(`  equity (BTC): ${s.equity}`);
  log(`  balance (BTC): ${s.balance}`);
  log(`  available_funds (BTC): ${s.available_funds}`);
  log(`  session_upl (BTC): ${s.session_upl}`);
  log(`  session_rpl (BTC): ${s.session_rpl}`);
  log(`  BTC index (USD): ${btcUsd.toFixed(2)}`);
  log(`  equity ~ USD: $${(Number(s.equity) * btcUsd).toFixed(2)}`);
  log(`  session_upl ~ USD: $${(Number(s.session_upl || 0) * btcUsd).toFixed(4)}`);
  log(`  session_rpl ~ USD: $${(Number(s.session_rpl || 0) * btcUsd).toFixed(4)}`);
  log('');

  let apiAtAnchor = null;
  if (anchorMs != null) {
    const lookbackStart = anchorMs - opts.lookbackDaysBeforeAnchor * 86400000;
    log(`--- API equity at/before anchor (logs: ${opts.lookbackDaysBeforeAnchor}d before anchor → anchor) ---`);
    const pre = await fetchAllTxLogs(token, lookbackStart, anchorMs);
    log(`  Pages: ${pre.pages}  Rows in range: ${pre.allLogs.length}`);
    apiAtAnchor = equityAtOrBeforeAnchor(pre.allLogs, anchorMs);
    if (apiAtAnchor && apiAtAnchor.equity != null) {
      log(`  Last log at/before anchor: ${new Date(apiAtAnchor.timestamp).toISOString()}  id=${apiAtAnchor.id}  type=${apiAtAnchor.type}`);
      log(`  equity (BTC) after that row: ${apiAtAnchor.equity}`);
      log(`  balance (BTC) after that row: ${apiAtAnchor.balance}`);
      log(`  Same equity repriced @ TODAY index: $${(apiAtAnchor.equity * btcUsd).toFixed(2)}`);
    } else {
      log('  Could not resolve equity from logs in lookback; rely on screenshot baseline.');
    }
    log('');
  }

  log('--- Fetching transaction_log (anchor → now; max 250/page, 1s between pages) ---');
  const { allLogs, pages } = await fetchAllTxLogs(token, startMs, endMs);
  log(`  Pages: ${pages}  Total log rows: ${allLogs.length}`);
  log('');

  const agg = aggregateLogs(allLogs, btcUsd);
  const { byType, byTypeChangeBtc, sumChangeBtc, sumCashflowBtc, botTradeCount, botTradeSumChange, botTradeSumCf, typesSorted } = agg;

  log('=== AGGREGATE BY type (anchor → now): sum `change` = wallet cash delta per row ===');
  for (const t of typesSorted) {
    const ch = byTypeChangeBtc[t];
    const usd = ch * btcUsd;
    log(`  ${t}: rows=${byType[t]}  sumChangeBTC=${ch.toFixed(8)}  ~USD=${usd.toFixed(4)}`);
  }
  log('');
  log(`  TOTAL sum(change):   ${sumChangeBtc.toFixed(8)} BTC  ~ $${(sumChangeBtc * btcUsd).toFixed(2)}`);
  log(`  TOTAL sum(cashflow): ${sumCashflowBtc.toFixed(8)} BTC  ~ $${(sumCashflowBtc * btcUsd).toFixed(2)}`);
  log('');

  log('=== Bot instruments (BTC-PERPETUAL, BTC-29MAY26) anchor → now ===');
  log(`  trade rows: ${botTradeCount}`);
  log(`  sum(change):   ${botTradeSumChange.toFixed(8)} BTC  ~ $${(botTradeSumChange * btcUsd).toFixed(2)}`);
  log(`  sum(cashflow): ${botTradeSumCf.toFixed(8)} BTC  ~ $${(botTradeSumCf * btcUsd).toFixed(2)}`);
  log('  Note: perp realized PnL and funding also hit `settlement` and trade `cashflow` on closes.');
  log('');

  if (anchorMs != null && opts.screenshotBtc != null && opts.screenshotIndexUsd != null) {
    const eqUsdNow = Number(s.equity) * btcUsd;
    const eqUsdThenShot = opts.screenshotEquityUsd;
    const idx0 = opts.screenshotIndexUsd;
    const btc0 = opts.screenshotBtc;
    log('=== USD bridge vs your screenshot (approximate) ===');
    log(`  Screenshot total USD (then):     $${eqUsdThenShot != null ? eqUsdThenShot.toFixed(2) : 'n/a'}`);
    log(`  Current equity USD (@now index): $${eqUsdNow.toFixed(2)}`);
    if (eqUsdThenShot != null) log(`  Delta (now vs screenshot):       $${(eqUsdNow - eqUsdThenShot).toFixed(2)}`);
    const markOnlyUsd = btc0 * (btcUsd - idx0);
    log(`  Fixed ${btc0} BTC mark-to-market:   $${markOnlyUsd.toFixed(2)} (= ${btc0} × ($${btcUsd.toFixed(2)} − $${idx0.toFixed(2)}))`);
    if (eqUsdThenShot != null) {
      const residual = eqUsdNow - eqUsdThenShot - markOnlyUsd;
      log(`  Residual after mark component:   $${residual.toFixed(2)} (BTC qty change, fees, funding, UPL, USDC, UI rounding)`);
    }
    if (apiAtAnchor && apiAtAnchor.equity != null) {
      const dEqBtc = Number(s.equity) - apiAtAnchor.equity;
      log(`  API equity delta (BTC):          ${dEqBtc.toFixed(8)} (= now ${s.equity} − anchor log ${apiAtAnchor.equity})`);
      log(`  API equity delta @ today index:  $${(dEqBtc * btcUsd).toFixed(2)}`);
    }
    log('');
  }

  log('=== Reference: why USD equity moves ===');
  log('  1) Equity USD = equity_BTC × BTCUSD.');
  log('  2) Net BTC equity changes from trading, settlements, fees, deposits.');
  log('  3) Open positions add session_upl (screenshot showed 0 positions at anchor).');
  if (opts.initialUsd != null) {
    const eqUsd = Number(s.equity) * btcUsd;
    log(`  Legacy --initialUsd=$${opts.initialUsd} vs now $${eqUsd.toFixed(2)}`);
  }
  log('');

  log('=== Last 40 log rows since anchor (newest first in API order) ===');
  const sample = allLogs.slice(0, 40);
  for (const row of sample) {
    const ts = new Date(row.timestamp).toISOString();
    log(
      `  ${ts}  ${row.type}  ch=${Number(row.change).toFixed(8)}  cf=${Number(row.cashflow).toFixed(8)}  ` +
        `${row.instrument_name || '-'}  ${row.side || '-'}  id=${row.id}`
    );
  }

  log('');
  log('================================================================================');
  log('END');
  log('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const anchorTag = anchorMs != null ? `_anchored_${String(opts.anchorIso).replace(/[^0-9A-Za-z+-]/g, '_')}` : '';
  const outPath = path.join(outDir, `exchange_balance_attribution${anchorTag}_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
