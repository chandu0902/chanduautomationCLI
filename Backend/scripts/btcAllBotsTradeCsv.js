#!/usr/bin/env node
/**
 * btcAllBotsTradeCsv.js
 *
 * Generates per-bot BTC-PERPETUAL trade CSVs for every BTC bot on the
 * ETHHIDDEN_ROAD-equivalent accounts.
 *
 * BTC accounts:
 *   • "deribit hiddenroad" — pairs 1–19 (Apr 02 → Apr 15)
 *       API key NO LONGER HELD — exchange fills cannot be re-fetched.
 *       A placeholder CSV (header-only) is written with a note.
 *   • "Deribit-H4"         — pairs 20, 21, 24 (Apr 15 → now)
 *       API key available → full BTC-PERPETUAL fills via get_transaction_log.
 *
 * Each bot's window:
 *   createdAt  →  NEXT bot's createdAt   (within the same account)
 *   last bot   →  now
 *
 * Output (in Backend/reports/):
 *   btch4_trades_pair<ID>_<agentName>.csv   (Deribit-H4, with fills)
 *   btchid_trades_pair<ID>_<agentName>.csv  (hiddenroad, header-only + note)
 *   btc_trades_INDEX.txt                    (summary)
 *
 * CSV columns:
 *   trade_id, order_id, timestamp_ms, datetime_utc, instrument,
 *   direction, side, amount_usd, price, liquidity, fee_role,
 *   fee_btc, fee_usd, rebate_btc,
 *   realized_pnl_btc, realized_pnl_usd,
 *   balance_change_btc, running_position_usd, running_balance_btc,
 *   mark_price, index_price
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { Op } = require('sequelize');
const { StatArbInput, AccountDetails, sequelize } = require('../src/models');

const H4_ACCOUNT   = 'Deribit-H4';
const INSTRUMENT   = 'BTC-PERPETUAL';
const CCY          = 'BTC';
const BTC_PAIR_IDS = [1,2,3,4,5,6,7,8,9,12,13,15,16,17,18,19,20,21,24];
const HID_IDS      = [1,2,3,4,5,6,7,8,9,12,13,15,16,17,18,19];
const H4_IDS       = [20,21,24];

/* ── auth ─────────────────────────────────────────────────────────── */
function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(enc, 'base64', 'utf8') + d.final('utf8');
}
function creds(acc) {
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  return { apiKey: decrypt(ak2, ak1, ak0), secretKey: decrypt(sk2, sk1, sk0) };
}
async function auth(apiKey, secretKey) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── fetch ALL BTC-PERP fills via transaction log ─────────────────── */
async function fetchTradeLogs(token, startMs, endMs) {
  const all = [];
  let cont;
  for (let page = 0; page < 500; page++) {
    await sleep(350);
    const params = {
      currency: CCY,
      start_timestamp: startMs,
      end_timestamp: endMs,
      count: 1000,
      query: 'trade',
    };
    if (cont) params.continuation = cont;

    let r;
    for (let a = 0; a < 5; a++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log', {
        headers: { Authorization: `Bearer ${token}` },
        params, timeout: 30000, validateStatus: () => true,
      });
      if (r.status === 429 || r.data?.error?.code === 10028) { await sleep(6000 * (a + 1)); continue; }
      break;
    }
    if (r.data?.error) throw new Error(JSON.stringify(r.data.error));

    const logs = r?.data?.result?.logs || [];
    all.push(...logs);
    process.stdout.write(`\r  txlog entries: ${all.length}`);
    cont = r?.data?.result?.continuation;
    if (!cont || logs.length === 0) break;
  }
  process.stdout.write('\n');
  return all
    .filter(l => l.type === 'trade' && l.instrument_name === INSTRUMENT)
    .sort((a, b) => a.timestamp - b.timestamp || a.user_seq - b.user_seq);
}

/* ── CSV helpers ──────────────────────────────────────────────────── */
const CSV_HEADERS = [
  'trade_id', 'order_id', 'timestamp_ms', 'datetime_utc', 'instrument',
  'direction', 'side', 'amount_usd', 'price', 'liquidity', 'fee_role',
  'fee_btc', 'fee_usd', 'rebate_btc',
  'realized_pnl_btc', 'realized_pnl_usd',
  'balance_change_btc', 'running_position_usd', 'running_balance_btc',
  'mark_price', 'index_price',
];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function deriveDir(side) {
  if (!side) return '';
  return side.includes('buy') ? 'buy' : side.includes('sell') ? 'sell' : '';
}

function logToRow(l, btcIdx) {
  const commission = parseFloat(l.commission || 0);
  const cashflow   = parseFloat(l.cashflow   || 0);
  const change     = parseFloat(l.change     || 0);
  const amount     = parseFloat(l.amount     || 0);
  const role       = l.user_role || l.fee_role || '';
  const liq        = role === 'maker' ? 'M' : role === 'taker' ? 'T' : '';
  const rebateBtc  = commission < 0 ? Math.abs(commission) : 0;

  return [
    l.trade_id,
    l.order_id,
    l.timestamp,
    new Date(l.timestamp).toISOString(),
    l.instrument_name,
    deriveDir(l.side),
    l.side,
    amount,
    l.price,
    liq,
    role,
    commission,
    (commission * btcIdx).toFixed(6),
    rebateBtc,
    cashflow,
    (cashflow * btcIdx).toFixed(6),
    change,
    l.position,
    l.balance,
    l.mark_price,
    l.index_price,
  ].map(csvEscape).join(',');
}

function writeCsv(filePath, logs, btcIdx) {
  const lines = [CSV_HEADERS.join(',')];
  for (const l of logs) lines.push(logToRow(l, btcIdx));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function writeNoKeyCsv(filePath, bot) {
  const note = `# No exchange fills available — "deribit hiddenroad" API key not held.\n` +
    `# Bot: ${bot.agentName}  (pair ${bot.id})\n` +
    `# Window: ${new Date(bot.createdAt).toISOString()}\n` +
    `# Use DB data (basis_positions / trade_logs tables) for this account.\n`;
  fs.writeFileSync(filePath, note + CSV_HEADERS.join(',') + '\n', 'utf8');
}

/* ── summary helpers ──────────────────────────────────────────────── */
function summaryOf(logs) {
  const buys   = logs.filter(l => deriveDir(l.side) === 'buy');
  const sells  = logs.filter(l => deriveDir(l.side) === 'sell');
  const makers = logs.filter(l => (l.user_role || l.fee_role) === 'maker');
  const takers = logs.filter(l => (l.user_role || l.fee_role) === 'taker');
  const vol    = logs.reduce((s,l)=>s+parseFloat(l.amount||0),0);
  const pnl    = logs.reduce((s,l)=>s+parseFloat(l.cashflow||0),0);
  const fee    = logs.reduce((s,l)=>s+parseFloat(l.commission||0),0);
  return { n: logs.length, buys: buys.length, sells: sells.length,
    makers: makers.length, takers: takers.length, vol, pnl, fee };
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/[._]+$/g, '');
}

/* ── main ─────────────────────────────────────────────────────────── */
(async () => {
  const allBots = await StatArbInput.findAll({
    where: { id: { [Op.in]: BTC_PAIR_IDS } },
    attributes: [
      'id', 'agentName', 'tradeAccountA', 'symbol1', 'tradingEnabled',
      'createdAt', 'botStartedAt', 'botStartBalance', 'lastStopReason',
    ],
    order: [['createdAt', 'ASC']],
  });

  const hidBots = allBots.filter(b => HID_IDS.includes(b.id));
  const h4Bots  = allBots.filter(b => H4_IDS.includes(b.id));

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  BTC-PERPETUAL — PER-BOT TRADE CSV GENERATOR');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Instrument : ${INSTRUMENT}`);
  console.log(`  BTC bots   : ${allBots.length}  (hiddenroad: ${hidBots.length}, H4: ${h4Bots.length})\n`);

  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const indexLines = [
    `BTC-PERPETUAL — per-bot trade CSVs`,
    `Generated : ${new Date().toISOString()}`,
    `Instrument: ${INSTRUMENT}`,
    ``,
    `Sign conventions:`,
    `  fee_btc  : negative = MAKER REBATE (credit), positive = TAKER FEE (debit)`,
    `  cashflow : realized BTC PnL on the closing leg of a round-trip (0 on open)`,
    `  balance_change_btc = cashflow - fee_btc`,
    ``,
    `Columns: ${CSV_HEADERS.join(', ')}`,
    ``,
    `════════════════════════════════════════════════════════`,
    `PHASE 1 — deribit hiddenroad  (pairs 1–19, Apr 02 → Apr 15)`,
    `API key NO LONGER HELD — only placeholder CSVs generated.`,
    `Use the basis_positions / trade_logs DB tables for this account.`,
    `════════════════════════════════════════════════════════`,
    ``,
  ];

  /* ── Phase 1: hiddenroad — header-only CSVs ──────────────────────── */
  console.log('── Phase 1 : deribit hiddenroad  (pairs 1–19) ──────────────────');
  console.log('   API key NOT available → placeholder CSVs only.\n');

  const hidWindows = hidBots.map((b, i) => {
    const startMs = new Date(b.createdAt).getTime();
    const nextMs  = i + 1 < hidBots.length ? new Date(hidBots[i + 1].createdAt).getTime() : Date.now();
    return { bot: b, startMs, endMs: nextMs };
  });

  for (const w of hidWindows) {
    const { bot, startMs, endMs } = w;
    const fname = `btchid_trades_pair${bot.id}_${safeName(bot.agentName)}.csv`;
    const fpath = path.join(reportsDir, fname);
    writeNoKeyCsv(fpath, bot);

    const lines = [
      `Pair ${bot.id}  ${bot.agentName}  [${bot.tradeAccountA}]`,
      `  window  : ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`,
      `  fills   : N/A (no API key)`,
      `  note    : placeholder CSV — use DB tables for performance data`,
      `  file    : reports/${fname}`,
    ];
    for (const ln of lines) console.log(ln);
    console.log();
    indexLines.push(...lines, '');
  }

  /* ── Phase 2: Deribit-H4 — full fills ───────────────────────────── */
  console.log('── Phase 2 : Deribit-H4  (pairs 20, 21, 24) ──────────────────');

  const h4Acc = await AccountDetails.findOne({ where: { Trade_Account: H4_ACCOUNT } });
  if (!h4Acc) throw new Error(`AccountDetails not found for ${H4_ACCOUNT}`);
  const { apiKey, secretKey } = creds(h4Acc);
  const token = await auth(apiKey, secretKey);

  let btcIdx = 0;
  try {
    const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd', { timeout: 8000 });
    btcIdx = r?.data?.result?.index_price || 0;
  } catch { /* ignore */ }
  console.log(`  BTC index : $${btcIdx.toFixed(2)}\n`);

  const h4Start = new Date(h4Bots[0].createdAt).getTime();
  const h4End   = Date.now();

  console.log(`  Fetching all ${INSTRUMENT} fills from ${new Date(h4Start).toISOString()} → ${new Date(h4End).toISOString()} …`);
  const allLogs = await fetchTradeLogs(token, h4Start, h4End);
  console.log(`  Total ${INSTRUMENT} fills: ${allLogs.length}\n`);

  indexLines.push(
    `════════════════════════════════════════════════════════`,
    `PHASE 2 — Deribit-H4  (pairs 20, 21, 24, Apr 15 → now)`,
    `Full exchange fills from Deribit /private/get_transaction_log.`,
    `BTC index used for USD conversion: $${btcIdx.toFixed(2)}`,
    `════════════════════════════════════════════════════════`,
    ``,
  );

  const h4Windows = h4Bots.map((b, i) => {
    const startMs = new Date(b.createdAt).getTime();
    const nextMs  = i + 1 < h4Bots.length ? new Date(h4Bots[i + 1].createdAt).getTime() : h4End;
    return { bot: b, startMs, endMs: nextMs };
  });

  for (const w of h4Windows) {
    const { bot, startMs, endMs } = w;
    const logs = allLogs.filter(l => l.timestamp >= startMs && l.timestamp < endMs);
    const s    = summaryOf(logs);

    const fname = `btch4_trades_pair${bot.id}_${safeName(bot.agentName)}.csv`;
    const fpath = path.join(reportsDir, fname);
    writeCsv(fpath, logs, btcIdx);

    const lines = [
      `Pair ${bot.id}  ${bot.agentName}  [${bot.tradeAccountA}]`,
      `  window  : ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`,
      `  fills   : ${s.n}  (buys ${s.buys} / sells ${s.sells} | makers ${s.makers} / takers ${s.takers})`,
      `  volume  : $${Math.round(s.vol).toLocaleString()}  notional`,
      `  realized: ${s.pnl.toFixed(8)} BTC  (~$${(s.pnl * btcIdx).toFixed(2)})`,
      `  fees    : ${s.fee.toFixed(8)} BTC  (~$${(s.fee * btcIdx).toFixed(2)})   [negative = net maker rebate]`,
      `  net     : ${(s.pnl - s.fee).toFixed(8)} BTC  (~$${((s.pnl - s.fee) * btcIdx).toFixed(2)})   [cashflow − fee]`,
      `  file    : reports/${fname}`,
    ];
    for (const ln of lines) console.log(ln);
    console.log();
    indexLines.push(...lines, '');
  }

  const indexPath = path.join(reportsDir, 'btc_trades_INDEX.txt');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf8');
  console.log(`Index summary: ${indexPath}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
