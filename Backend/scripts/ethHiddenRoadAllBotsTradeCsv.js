#!/usr/bin/env node
/**
 * ethHiddenRoadAllBotsTradeCsv.js
 *
 * For every ETH bot that has ever run on tradeAccountA = 'ETHHIDDEN_ROAD',
 * pull ALL ETH-PERPETUAL fills from Deribit and write one CSV per bot.
 *
 * Because the bots share one exchange sub-account and are created sequentially,
 * each bot's window is:
 *    createdAt   →   NEXT bot's createdAt        (a "new bot start")
 * and the most-recently-created bot's window is:
 *    createdAt   →   now
 *
 * Data source: /private/get_transaction_log  (filtered to type='trade',
 *   instrument_name='ETH-PERPETUAL'). This is the exchange's authoritative
 *   log and is the only endpoint that still returns older fills (the
 *   get_user_trades_*_time endpoints drop trades after a few days).
 *
 * Output:
 *   reports/ethhiddenroad_trades_pair<ID>_<agentName>.csv
 *   reports/ethhiddenroad_trades_INDEX.txt
 *
 * CSV columns:
 *   trade_id, order_id, timestamp_ms, datetime_utc, instrument,
 *   direction, side, amount_usd, price, liquidity, fee_role,
 *   fee_eth, fee_usd, rebate_eth, realized_pnl_eth, realized_pnl_usd,
 *   balance_change_eth, running_position_usd, running_balance_eth,
 *   mark_price, index_price
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { StatArbInput, AccountDetails, sequelize } = require('../src/models');

const ACCOUNT    = 'ETHHIDDEN_ROAD';
const INSTRUMENT = 'ETH-PERPETUAL';
const CCY        = 'ETH';

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

/* ── fetch ALL type='trade' transaction-log entries in [startMs, endMs] ─ */
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
        params,
        timeout: 30000,
        validateStatus: () => true,
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
  'fee_eth', 'fee_usd', 'rebate_eth',
  'realized_pnl_eth', 'realized_pnl_usd',
  'balance_change_eth', 'running_position_usd', 'running_balance_eth',
  'mark_price', 'index_price',
];

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function deriveDirection(side) {
  // side examples: 'open buy', 'close buy', 'open sell', 'close sell'
  if (!side) return '';
  return side.includes('buy') ? 'buy' : side.includes('sell') ? 'sell' : '';
}

function logToRow(l, ethIdx) {
  // Sign convention per Deribit transaction_log:
  //   commission < 0  → maker rebate (credited to account)
  //   commission > 0  → taker fee (debited from account)
  //   cashflow         → realized PnL in ETH (0 for opening leg)
  //   change           → net balance delta (= cashflow - commission)
  const commission = parseFloat(l.commission || 0);
  const cashflow   = parseFloat(l.cashflow || 0);
  const change     = parseFloat(l.change || 0);
  const amount     = parseFloat(l.amount || 0);
  const role       = l.user_role || l.fee_role || '';
  const liq        = role === 'maker' ? 'M' : role === 'taker' ? 'T' : '';

  // Normalize fee to the convention used in get_user_trades (positive=cost, negative=rebate)
  // transaction_log `commission` is already signed that way for rebates (negative=rebate).
  // Keep it as-is so users see "-0.0005" for a rebate.
  const feeEth    = commission;
  const rebateEth = commission < 0 ? Math.abs(commission) : 0;

  return [
    l.trade_id,
    l.order_id,
    l.timestamp,
    new Date(l.timestamp).toISOString(),
    l.instrument_name,
    deriveDirection(l.side),
    l.side,
    amount,
    l.price,
    liq,
    role,
    feeEth,
    (feeEth * ethIdx).toFixed(6),
    rebateEth,
    cashflow,
    (cashflow * ethIdx).toFixed(6),
    change,
    l.position,
    l.balance,
    l.mark_price,
    l.index_price,
  ].map(csvEscape).join(',');
}

function writeCsv(filePath, logs, ethIdx) {
  const lines = [CSV_HEADERS.join(',')];
  for (const l of logs) lines.push(logToRow(l, ethIdx));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

/* ── summary helpers ──────────────────────────────────────────────── */
function summary(logs) {
  const buys  = logs.filter(l => deriveDirection(l.side) === 'buy');
  const sells = logs.filter(l => deriveDirection(l.side) === 'sell');
  const makers = logs.filter(l => (l.user_role || l.fee_role) === 'maker');
  const takers = logs.filter(l => (l.user_role || l.fee_role) === 'taker');
  const vol   = logs.reduce((s,l)=>s+parseFloat(l.amount||0),0);
  const pnl   = logs.reduce((s,l)=>s+parseFloat(l.cashflow||0),0);
  const fee   = logs.reduce((s,l)=>s+parseFloat(l.commission||0),0);
  return {
    n: logs.length,
    buys: buys.length, sells: sells.length,
    makers: makers.length, takers: takers.length,
    vol, pnl, fee,
  };
}

function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/[._]+$/g, '');
}

/* ── main ─────────────────────────────────────────────────────────── */
(async () => {
  const bots = await StatArbInput.findAll({
    where: { tradeAccountA: ACCOUNT },
    attributes: [
      'id', 'agentName', 'symbol1', 'status', 'tradingEnabled',
      'createdAt', 'botStartedAt', 'botEndBalance', 'botStartBalance', 'lastStopReason',
    ],
    order: [['createdAt', 'ASC']],
  });

  if (!bots.length) { console.error(`No bots found for account ${ACCOUNT}`); process.exit(1); }

  const bot0 = bots[0];
  if (!bot0.createdAt) throw new Error(`First bot has no createdAt`);

  const globalStartMs = new Date(bot0.createdAt).getTime();
  const globalEndMs   = Date.now();

  console.log(`\nAccount : ${ACCOUNT}`);
  console.log(`Bots    : ${bots.length}`);
  console.log(`Window  : ${new Date(globalStartMs).toISOString()}  →  ${new Date(globalEndMs).toISOString()}`);
  console.log(`Instrument: ${INSTRUMENT}\n`);

  for (const b of bots) {
    const ca = new Date(b.createdAt).toISOString();
    const sa = b.botStartedAt ? new Date(b.botStartedAt).toISOString() : 'null';
    console.log(`  • Pair ${b.id}  ${b.agentName}  createdAt=${ca}  botStartedAt=${sa}  tradingEnabled=${b.tradingEnabled}`);
  }
  console.log();

  const acc = await AccountDetails.findOne({ where: { Trade_Account: ACCOUNT } });
  if (!acc) throw new Error(`AccountDetails not found for ${ACCOUNT}`);
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  let ethIdx = 0;
  try {
    const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd', { timeout: 8000 });
    ethIdx = r?.data?.result?.index_price || 0;
  } catch { /* ignore */ }

  console.log(`Fetching all ${INSTRUMENT} trade-type transaction log entries from ${new Date(globalStartMs).toISOString()} → ${new Date(globalEndMs).toISOString()} …`);
  const allLogs = await fetchTradeLogs(token, globalStartMs, globalEndMs);
  console.log(`Total ${INSTRUMENT} fills: ${allLogs.length}\n`);

  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const windows = bots.map((b, i) => {
    const startMs = new Date(b.createdAt).getTime();
    const nextMs  = i + 1 < bots.length ? new Date(bots[i + 1].createdAt).getTime() : globalEndMs;
    return { bot: b, startMs, endMs: nextMs };
  });

  const indexLines = [
    `ETHHIDDEN_ROAD — per-bot ${INSTRUMENT} trade CSVs`,
    `Generated: ${new Date().toISOString()}`,
    `ETH index used for USD conversion: $${ethIdx.toFixed(2)}`,
    `Source  : Deribit /private/get_transaction_log  (type='trade', instrument='${INSTRUMENT}')`,
    ``,
    `Sign conventions (match the exchange's raw log):`,
    `  fee_eth  : negative = MAKER REBATE (credit), positive = TAKER FEE (debit)`,
    `  cashflow : realized ETH PnL on the closing leg of a round-trip (0 on open)`,
    `  balance_change_eth = cashflow - fee_eth`,
    ``,
    `Trade windows are sequential by DB row createdAt — each bot owns the`,
    `window from its own createdAt up to the NEXT bot's createdAt (a "new`,
    `bot start"). The most-recently-created bot's window ends at 'now'. All`,
    `bots share the same exchange sub-account (${ACCOUNT}).`,
    ``,
    `Columns: ${CSV_HEADERS.join(', ')}`,
    ``,
  ];

  for (const w of windows) {
    const { bot, startMs, endMs } = w;
    const logs = allLogs.filter(l => l.timestamp >= startMs && l.timestamp < endMs);
    const s    = summary(logs);

    const fname = `ethhiddenroad_trades_pair${bot.id}_${safeName(bot.agentName)}.csv`;
    const fpath = path.join(reportsDir, fname);
    writeCsv(fpath, logs, ethIdx);

    const lines = [
      `Pair ${bot.id}  ${bot.agentName}`,
      `  window  : ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`,
      `  fills   : ${s.n}  (buys ${s.buys} / sells ${s.sells} | makers ${s.makers} / takers ${s.takers})`,
      `  volume  : $${Math.round(s.vol).toLocaleString()}  notional`,
      `  realized: ${s.pnl.toFixed(6)} ETH  (~$${(s.pnl * ethIdx).toFixed(2)})`,
      `  fees    : ${s.fee.toFixed(6)} ETH  (~$${(s.fee * ethIdx).toFixed(2)})   [negative = net maker rebate]`,
      `  net     : ${(s.pnl - s.fee).toFixed(6)} ETH  (~$${((s.pnl - s.fee) * ethIdx).toFixed(2)})   [cashflow − fee]`,
      `  file    : reports/${fname}`,
    ];
    for (const ln of lines) console.log(ln);
    console.log();
    indexLines.push(...lines, '');
  }

  const indexPath = path.join(reportsDir, 'ethhiddenroad_trades_INDEX.txt');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf8');
  console.log(`Index summary: ${indexPath}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
