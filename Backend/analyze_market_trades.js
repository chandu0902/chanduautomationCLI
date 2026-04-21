/**
 * Exchange-only trade analytics from Deribit fills (market truth).
 * Supports unilateral single-instrument bots (e.g. BTC-PERPETUAL only) and two-symbol pairs.
 *
 *   node analyze_market_trades.js
 *   node analyze_market_trades.js --pairId=6
 *   node analyze_market_trades.js --hours=72
 *   node analyze_market_trades.js --since=2026-04-04T00:00:00.000Z
 *
 * Writes: Backend/reports/market_trades_analysis_<ts>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { sequelize, StatArbInput, AccountDetails } = require('./src/models');

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { pairId: null, since: null, hours: null, account: null };
  for (const a of argv) {
    if (a.startsWith('--pairId=')) o.pairId = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--since=')) o.since = a.slice('--since='.length);
    else if (a.startsWith('--hours=')) o.hours = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--account=')) o.account = a.split('=')[1];
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

async function dGet(path, token, params = {}) {
  const r = await axios.get(`https://www.deribit.com/api/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 20000,
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

async function fetchFills(currency, token, startMs) {
  const all = [];
  let curStart = startMs;
  for (let page = 0; page < 80; page++) {
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        currency,
        start_timestamp: curStart,
        end_timestamp: Date.now(),
        count: 1000,
        sorting: 'asc',
      },
      timeout: 25000,
    });
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    all.push(...trades);
    if (!res.has_more) break;
    curStart = trades[trades.length - 1].timestamp + 1;
    await new Promise((x) => setTimeout(x, 300));
  }
  return all;
}

function currencyFromSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.startsWith('ETH')) return 'ETH';
  if (s.includes('USDC')) return 'USDC';
  return 'BTC';
}

function analyzeInstrument(fills, indexPrice) {
  let volUsd = 0;
  let plBtc = 0;
  let feeBtc = 0;
  let rebateBtc = 0;
  let paidBtc = 0;
  const closing = [];
  for (const f of fills) {
    const amt = Math.abs(Number(f.amount) || 0);
    volUsd += amt;
    const pl = Number(f.profit_loss) || 0;
    const fee = Number(f.fee) || 0;
    plBtc += pl;
    feeBtc += fee;
    if (fee < 0) rebateBtc += -fee;
    else if (fee > 0) paidBtc += fee;
    if (pl !== 0) {
      const netBtc = pl + fee;
      closing.push({
        ts: f.timestamp,
        trade_id: f.trade_id,
        direction: f.direction,
        amount: f.amount,
        price: f.price,
        pl,
        fee,
        netBtc,
        win: netBtc > 0,
      });
    }
  }
  const wins = closing.filter((c) => c.win);
  const losses = closing.filter((c) => !c.win);
  const netRealizedBtc = plBtc + feeBtc;
  return {
    nFills: fills.length,
    volUsd,
    plBtc,
    feeBtc,
    rebateBtc,
    paidBtc,
    netRealizedBtc,
    closing,
    closeN: closing.length,
    winN: wins.length,
    lossN: losses.length,
    winRate: closing.length ? wins.length / closing.length : 0,
    sumWinBtc: wins.reduce((s, c) => s + c.netBtc, 0),
    sumLossBtc: losses.reduce((s, c) => s + c.netBtc, 0),
    netUsd: indexPrice != null ? netRealizedBtc * indexPrice : null,
    plUsd: indexPrice != null ? plBtc * indexPrice : null,
    feeUsd: indexPrice != null ? feeBtc * indexPrice : null,
    rebateUsd: indexPrice != null ? rebateBtc * indexPrice : null,
  };
}

async function main() {
  const opts = parseArgs();
  await sequelize.authenticate();

  let pairs;
  if (opts.pairId != null) {
    const p = await StatArbInput.findByPk(opts.pairId);
    pairs = p ? [p] : [];
  } else {
    pairs = await StatArbInput.findAll({
      where: { status: 'active', tradingEnabled: true },
      order: [['id', 'ASC']],
    });
    if (pairs.length === 0) {
      const any = await StatArbInput.findAll({ where: { status: 'active' }, order: [['id', 'DESC']], limit: 1 });
      pairs = any;
    }
  }

  if (pairs.length === 0) {
    console.error('No pair found. Use --pairId=');
    process.exit(1);
  }

  const pair = pairs[0];
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.tradeLeg === 'A' ? pair.symbol1 : pair.symbol2 || pair.symbol1;
  const instA = pair.symbol1;
  const instB = pair.symbol2;
  const currency = currencyFromSymbol(instA || instB);

  let startMs;
  let windowLabel;
  if (opts.since) {
    startMs = Date.parse(opts.since);
    windowLabel = `since ${opts.since}`;
  } else if (opts.hours != null && Number.isFinite(opts.hours)) {
    startMs = Date.now() - opts.hours * 3600000;
    windowLabel = `last ${opts.hours} hours`;
  } else {
    startMs = Date.now() - 7 * 86400000;
    windowLabel = 'last 7 days (default)';
  }
  if (Number.isNaN(startMs)) {
    console.error('Invalid --since');
    process.exit(1);
  }

  const acctName = opts.account || pair.tradeAccountA || pair.tradeAccountB;
  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) throw new Error(`Account not found: ${acctName}`);
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token = await getToken(apiKey, secret);

  const indexResult = await dGet('/public/get_index_price', token, {
    index_name: `${currency.toLowerCase()}_usd`,
  }).catch(() => null);
  const indexPrice = indexResult?.index_price != null ? Number(indexResult.index_price) : null;

  const lines = [];
  const log = (s) => lines.push(s);

  log('================================================================================');
  log('MARKET (EXCHANGE) TRADE ANALYSIS — Deribit fills');
  log(`Generated: ${new Date().toISOString()}`);
  log(`Pair id=${pair.id}  agent=${pair.agentName}`);
  log(`tradeLeg=${pair.tradeLeg || 'n/a'}  executed instrument: ${execSym}`);
  log(`symbol1 / symbol2: ${instA} / ${instB}`);
  log(`Window: ${windowLabel}`);
  log(`UTC: ${new Date(startMs).toISOString()} → now`);
  log(`Account: ${acctName}  Currency: ${currency}`);
  log(`BTC/USD index (ref): ${indexPrice != null ? indexPrice.toFixed(2) : 'n/a'}`);
  log('================================================================================');
  log('');

  log('Fetching fills (paginated)...');
  const allFills = await fetchFills(currency, token, startMs);
  log(`Total fills (all instruments): ${allFills.length}`);
  log('');

  const byInst = {};
  for (const f of allFills) {
    const n = f.instrument_name;
    if (!byInst[n]) byInst[n] = [];
    byInst[n].push(f);
  }

  const fillsExec = allFills.filter((f) => f.instrument_name === execSym);
  const fillsA = instA ? allFills.filter((f) => f.instrument_name === instA) : [];
  const fillsB = instB ? allFills.filter((f) => f.instrument_name === instB) : [];

  log('=== PER INSTRUMENT (all fills in window) ===');
  for (const [inst, arr] of Object.entries(byInst).sort((a, b) => b[1].length - a[1].length)) {
    const a = analyzeInstrument(arr, indexPrice);
    log(`  ${inst}`);
    log(`    fills=${a.nFills}  volume |amount| sum=$${a.volUsd.toFixed(2)} USD`);
    log(`    sum(profit_loss)=${a.plBtc.toFixed(8)} BTC  ~$${a.plUsd != null ? a.plUsd.toFixed(4) : 'n/a'}`);
    log(`    sum(fee)=${a.feeBtc.toFixed(8)} BTC  rebate|fee|=${a.rebateBtc.toFixed(8)}  paid=${a.paidBtc.toFixed(8)}`);
    log(`    realized+fee (pl+fee)=${a.netRealizedBtc.toFixed(8)} BTC  ~$${a.netUsd != null ? a.netUsd.toFixed(4) : 'n/a'}`);
    log(`    closing fills (profit_loss≠0): ${a.closeN}  wins=${a.winN} losses=${a.lossN} winRate=${(a.winRate * 100).toFixed(2)}%`);
    log('');
  }

  log('=== EXECUTED LEG ONLY (bot primary market) ===');
  const ex = analyzeInstrument(fillsExec, indexPrice);
  log(`  Instrument: ${execSym}`);
  log(`  Fills: ${ex.nFills}`);
  log(`  Total volume (sum |amount| USD): $${ex.volUsd.toFixed(2)}`);
  log(`  Sum profit_loss (BTC): ${ex.plBtc.toFixed(8)}  USD ~$${ex.plUsd != null ? ex.plUsd.toFixed(4) : 'n/a'}`);
  log(`  Sum fee (BTC): ${ex.feeBtc.toFixed(8)}  USD ~$${ex.feeUsd != null ? ex.feeUsd.toFixed(4) : 'n/a'}`);
  log(`  Maker rebate |fee| (BTC): ${ex.rebateBtc.toFixed(8)}  USD ~$${ex.rebateUsd != null ? ex.rebateUsd.toFixed(4) : 'n/a'}`);
  log(`  Taker / positive fee (BTC): ${ex.paidBtc.toFixed(8)}`);
  log(`  Net realized on leg (pl+fee, BTC): ${ex.netRealizedBtc.toFixed(8)}  USD ~$${ex.netUsd != null ? ex.netUsd.toFixed(4) : 'n/a'}`);
  log('');
  log('  Closing-fill events (each row = exchange reported realized slice, often partial):');
  log(`    Count: ${ex.closeN}`);
  log(`    Profitable (pl+fee > 0): ${ex.winN}`);
  log(`    Unprofitable (pl+fee ≤ 0): ${ex.lossN}`);
  log(`    Win rate (by closing slice): ${(ex.winRate * 100).toFixed(2)}%`);
  log(`    Sum net on wins (BTC): ${ex.sumWinBtc.toFixed(8)}  Sum net on losses (BTC): ${ex.sumLossBtc.toFixed(8)}`);
  log('');

  if (instA && instB && instA !== instB && fillsA.length && fillsB.length) {
    log('=== TWO-LEG NOTE ===');
    log('  Basis round-trips pair futures+perp closes within 60s in exchange_analytics.js.');
    log('  This script focuses on executed leg for unilateral PERP bots.');
    log('');
  }

  log('=== METHOD NOTES ===');
  log('  • profit_loss on each fill = Deribit realized PnL for that trade (position change).');
  log('  • fee in BTC: negative = maker rebate credited, positive = cost.');
  log('  • Net per closing slice = profit_loss + fee (both in BTC).');
  log('  • One DB "round trip" can be multiple closing fills; counts here are exchange-native.');
  log('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `market_trades_analysis_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
