/**
 * Clean one-page summary: DB vs EXCHANGE for the same bot (pair).
 * Round trips, profit, volume — aligned window from first DB activity on the pair.
 *
 *   node report_bot_db_exchange_summary.js
 *   node report_bot_db_exchange_summary.js --pairId=6
 *
 * Writes: Backend/reports/bot_db_exchange_summary_<ts>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const { sequelize, StatArbInput, Trade, BasisPosition, AccountDetails } = require('./src/models');

function parsePairId() {
  const a = process.argv.find((x) => x.startsWith('--pairId='));
  if (!a) return null;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) ? n : null;
}

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
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

async function fetchFillsInstrument(currency, token, startMs, instrumentName) {
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
    for (const t of trades) {
      if (t.instrument_name === instrumentName) all.push(t);
    }
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

async function main() {
  const forceId = parsePairId();
  await sequelize.authenticate();

  let pairs;
  if (forceId != null) {
    const p = await StatArbInput.findByPk(forceId);
    pairs = p ? [p] : [];
  } else {
    pairs = await StatArbInput.findAll({
      where: { status: 'active', tradingEnabled: true },
      order: [['id', 'ASC']],
    });
  }
  if (pairs.length === 0) {
    console.error('No pair. Use --pairId=6');
    process.exit(1);
  }

  const pair = pairs[0];
  const pid = pair.id;
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.tradeLeg === 'A' ? pair.symbol1 : pair.symbol2 || pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);

  const closed = await BasisPosition.findAll({
    where: { pairId: pid, state: 'closed' },
    order: [['id', 'ASC']],
  });

  let dbNet = 0;
  for (const p of closed) dbNet += Number(p.netPnl) || 0;

  const exits = await Trade.findAll({
    where: { pairId: pid, status: 'filled', side: 'exit' },
    order: [['id', 'ASC']],
  });
  const entries = await Trade.findAll({
    where: { pairId: pid, status: 'filled', side: 'entry' },
    order: [['id', 'ASC']],
  });

  let startMs = Date.now();
  const anyBp = await BasisPosition.findAll({
    where: { pairId: pid },
    attributes: ['entryTime', 'createdAt'],
    order: [['id', 'ASC']],
  });
  for (const p of anyBp) {
    if (p.entryTime) startMs = Math.min(startMs, new Date(p.entryTime).getTime());
    if (p.createdAt) startMs = Math.min(startMs, new Date(p.createdAt).getTime());
  }
  for (const p of closed) {
    if (p.exitTime) startMs = Math.min(startMs, new Date(p.exitTime).getTime());
  }
  const firstTrade = await Trade.findOne({
    where: { pairId: pid },
    order: [['createdAt', 'ASC']],
  });
  if (firstTrade?.createdAt) startMs = Math.min(startMs, new Date(firstTrade.createdAt).getTime());
  if (startMs >= Date.now()) startMs = Date.now() - 86400000;

  const volStart = new Date(startMs);
  const inWin = (t) => {
    const a = t.legA_filledAt ? new Date(t.legA_filledAt) : null;
    const c = t.createdAt ? new Date(t.createdAt) : null;
    return (a && a >= volStart) || (c && c >= volStart);
  };
  let volEntry = 0;
  let volExit = 0;
  for (const t of entries) if (inWin(t)) volEntry += Math.abs(Number(t.legA_qty) || 0);
  for (const t of exits) if (inWin(t)) volExit += Math.abs(Number(t.legA_qty) || 0);

  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) throw new Error(`Account not found: ${acctName}`);
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const token = await getToken(decryptText(ak2, ak1, ak0), decryptText(sk2, sk1, sk0));

  const ix = await axios
    .get('https://www.deribit.com/api/v2/public/get_index_price', {
      params: { index_name: `${currency.toLowerCase()}_usd` },
    })
    .catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;

  const fills = await fetchFillsInstrument(currency, token, startMs, execSym);
  let exVol = 0;
  let exPl = 0;
  let exFee = 0;
  let exCloseSlices = 0;
  for (const f of fills) {
    exVol += Math.abs(Number(f.amount) || 0);
    exPl += Number(f.profit_loss) || 0;
    exFee += Number(f.fee) || 0;
    if (Number(f.profit_loss) !== 0) exCloseSlices++;
  }
  const exNetBtc = exPl + exFee;
  const exNetUsd = idx ? exNetBtc * idx : null;
  const exPlUsd = idx ? exPl * idx : null;

  const lines = [];
  const L = (s) => lines.push(s);

  L('================================================================================');
  L('BOT SUMMARY — DATABASE vs EXCHANGE (since first activity on this pair)');
  L(`Generated: ${new Date().toISOString()}`);
  L(`Pair id=${pid}  ${pair.agentName}`);
  L(`Executed market: ${execSym}`);
  L(`Exchange window UTC: ${new Date(startMs).toISOString()} → now (from earliest DB trade/position time)`);
  L(`BTC/USD index (for EX USD): ${idx ? idx.toFixed(2) : 'n/a'}`);
  L('================================================================================');
  L('');
  L('┌────────────────────────────────┬─────────────────────┬─────────────────────┐');
  L('│                                │ DATABASE            │ EXCHANGE            │');
  L('├────────────────────────────────┼─────────────────────┼─────────────────────┤');
  L(`│ Total round trips              │ ${String(closed.length).padEnd(19)} │ ${'n/a'.padEnd(19)} │`);
  L(`│ Fills / close slices (EX only) │ ${'—'.padEnd(19)} │ ${(fills.length + ' / ' + exCloseSlices).padEnd(19)} │`);
  L('├────────────────────────────────┼─────────────────────┼─────────────────────┤');
  L(`│ Profit                         │ ${('$' + dbNet.toFixed(2)).padEnd(19)} │ ${(exNetUsd != null ? '~$' + exNetUsd.toFixed(2) : 'n/a').padEnd(19)} │`);
  L('├────────────────────────────────┼─────────────────────┼─────────────────────┤');
  L(`│ Volume (USD)                   │ ${('$' + (volEntry + volExit).toFixed(0)).padEnd(19)} │ ${('$' + exVol.toFixed(0)).padEnd(19)} │`);
  L('└────────────────────────────────┴─────────────────────┴─────────────────────┘');
  L('');
  L('DATABASE — definitions');
  L(`  • Round trips: closed rows in basis_positions (${closed.length}).`);
  L(`  • Profit: sum of netPnl (USD), strategy book.`);
  L(`  • Volume: sum |legA_qty| on entry+exit rows with fill/created time ≥ window start = $${(volEntry + volExit).toFixed(2)} (aligned with EX).`);
  L('');
  L('EXCHANGE — definitions');
  L(`  • Round trips: not one-per-row; use fills=${fills.length}, closing slices (pl≠0)=${exCloseSlices}.`);
  L(`  • Profit: sum(profit_loss)+sum(fee) on ${execSym} fills in window, USD ≈ at spot index.`);
  L(`    (profit_loss alone ≈ $${exPlUsd != null ? exPlUsd.toFixed(2) : 'n/a'}.)`);
  L(`  • Volume: sum |amount| on every fill (opens + closes + partials) = $${exVol.toFixed(2)}.`);
  L('');
  L('WHY NUMBERS DIFFER');
  L('  • DB counts one round trip per strategy close; exchange counts many fills per trip.');
  L('  • DB profit is modeled in USD; exchange is BTC ledger converted at one index.');
  L('  • DB volume is one notional per entry/exit record; exchange sums every fill.');
  L('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `bot_db_exchange_summary_${ts}.txt`);
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
