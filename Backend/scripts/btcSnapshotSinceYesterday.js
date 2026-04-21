#!/usr/bin/env node
/**
 * One-screen snapshot for a BTC basis pair (default 19).
 * Default window: UTC midnight yesterday → now.
 * Optional: --hours=24 for rolling last 24 hours (same sections, same reconcile window).
 *
 *   node scripts/btcSnapshotSinceYesterday.js
 *   node scripts/btcSnapshotSinceYesterday.js --pairId=16 --hours=24
 *   node scripts/btcSnapshotSinceYesterday.js --hours=24 --no-file   # stdout only (no reports/*.txt)
 *
 * Prints: full Deribit exchange snapshot (account_summary, positions, open orders,
 * all fills in window by instrument), start/current balances, DB round trips, and
 * DB vs exchange reconciliation for the chosen window.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize, StatArbInput, BasisPosition, AccountDetails } = require('../src/models');
const { currencyFromSymbol, appendExchangeReconcile, asciiTablePush } = require('../lib/btcDeribitReconcileSection');

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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One or two light pages (count=1000) to avoid rate limits. */
async function fetchTxLogsNearAnchor(token, currency, anchorMs) {
  const all = [];
  const startMs = anchorMs - 21 * 86400000;
  const endMs = anchorMs + 120000;
  let cont = undefined;
  for (let page = 0; page < 2; page++) {
    await sleep(1600);
    const params = { currency, start_timestamp: startMs, end_timestamp: endMs, count: 1000 };
    if (cont != null) params.continuation = cont;
    let r;
    for (let attempt = 0; attempt < 6; attempt++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log', {
        headers: { Authorization: `Bearer ${token}` },
        params,
        timeout: 30000,
        validateStatus: () => true,
      });
      const err = r.data?.error;
      if (r.status === 429 || err?.code === 10028) {
        await sleep(6000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (r.status >= 400) {
      throw new Error(`get_transaction_log HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    }
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const logs = res.logs || [];
    all.push(...logs);
    cont = res.continuation;
    if (!cont) break;
  }
  return all;
}

function stateAtOrBefore(logs, anchorMs) {
  const eligible = logs.filter((r) => Number(r.timestamp) <= anchorMs);
  if (!eligible.length) return null;
  eligible.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  const last = eligible[eligible.length - 1];
  return {
    timestamp: last.timestamp,
    equity: last.equity != null ? Number(last.equity) : null,
    balance: last.balance != null ? Number(last.balance) : null,
  };
}

function parseSnapshotArgs() {
  let pairId = 19;
  let rollingHours = null;
  let noFile = false;
  for (const x of process.argv.slice(2)) {
    if (x.startsWith('--pairId=')) {
      const n = parseInt(x.split('=')[1], 10);
      pairId = Number.isFinite(n) && n > 0 ? n : 19;
    } else if (x.startsWith('--hours=')) {
      const h = parseFloat(x.split('=')[1]);
      if (Number.isFinite(h) && h > 0) rollingHours = Math.min(168, h);
    } else if (x === '--no-file' || x === '--stdout-only') {
      noFile = true;
    }
  }
  return { pairId, rollingHours, noFile };
}

async function deribitGetSummary(token, currency) {
  const r = await axios.post(
    'https://www.deribit.com/api/v2/private/get_account_summary',
    { jsonrpc: '2.0', id: 1, method: 'private/get_account_summary', params: { currency, extended: true } },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

async function deribitPrivateRpc(token, method, params = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await axios.post(
      `https://www.deribit.com/api/v2/private/${method}`,
      { jsonrpc: '2.0', id: 1, method: `private/${method}`, params },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true }
    );
    const err = r.data?.error;
    if (r.status === 429 || err?.code === 10028) {
      await sleep(4000 * (attempt + 1));
      continue;
    }
    if (r.status >= 400) throw new Error(`${method} HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    if (err) throw new Error(err.message || JSON.stringify(err));
    return r.data.result;
  }
  throw new Error(`${method}: too many rate-limit retries`);
}

function formatSummaryValue(v, maxLen = 240) {
  if (v == null) return '';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > maxLen ? s.slice(0, Math.max(0, maxLen - 3)) + '...' : s;
  }
  const s = String(v);
  return s.length > maxLen ? s.slice(0, Math.max(0, maxLen - 3)) + '...' : s;
}

/** Monospace ASCII table via shared lib. */
function emitAsciiTable(L, colDefs, rows) {
  const buf = [];
  asciiTablePush(buf, colDefs, rows);
  for (const line of buf) L(line);
}

function appendExchangeAccountSummaryFull(L, summary, idx, currency) {
  const redactKeys = new Set(['email', 'deposit_address']);
  L('');
  L('================================================================================');
  L(`EXCHANGE · get_account_summary (${currency}, extended=true) — all fields (table)`);
  L('================================================================================');
  const keys = Object.keys(summary).sort();
  const valW = 92;
  const keyW = Math.min(34, Math.max(12, ...keys.map((k) => k.length)));
  const rows = [];
  for (const k of keys) {
    const v = redactKeys.has(k) ? '[redacted]' : formatSummaryValue(summary[k], valW);
    rows.push([k, v]);
  }
  emitAsciiTable(L, [
    { h: 'field', w: keyW },
    { h: 'value', w: valW },
  ], rows);
  const usd = (x) => (idx > 0 && x != null && Number.isFinite(Number(x)) ? (Number(x) * idx).toFixed(2) : 'n/a');
  L(`(reference index ${currency}/USD for manual check: $${idx ? idx.toFixed(2) : 'n/a'})`);
}

function appendExchangePositions(L, positions, idx, currency) {
  L('');
  L('================================================================================');
  L(`EXCHANGE · get_positions (${currency})`);
  L('================================================================================');
  const arr = Array.isArray(positions) ? positions : [];
  const nonZero = arr.filter((p) => Number(p.size) !== 0);
  L(`total rows: ${arr.length}  non-zero size: ${nonZero.length}`);
  const usd = (x) => (idx > 0 && Number.isFinite(Number(x)) ? (Number(x) * idx).toFixed(4) : 'n/a');
  if (nonZero.length) {
    const rows = [];
    for (const p of nonZero) {
      const fu =
        p.floating_profit_loss_usd != null
          ? Number(p.floating_profit_loss_usd)
          : p.floating_profit_loss != null && idx
            ? Number(p.floating_profit_loss) * idx
            : null;
      rows.push([
        p.instrument_name || '-',
        String(p.size ?? ''),
        p.direction || '-',
        String(p.average_price ?? '-'),
        fu != null ? `$${fu.toFixed(4)}` : `$${usd(p.floating_profit_loss)}`,
        p.delta != null && Number.isFinite(Number(p.delta)) ? Number(p.delta).toFixed(6) : '-',
        p.initial_margin != null ? String(p.initial_margin) : '-',
      ]);
    }
    emitAsciiTable(
      L,
      [
        { h: 'instrument', w: 22 },
        { h: 'size', w: 8, align: 'r' },
        { h: 'dir', w: 5 },
        { h: 'avg', w: 12, align: 'r' },
        { h: 'upl~$', w: 12, align: 'r' },
        { h: 'delta', w: 12, align: 'r' },
        { h: 'im', w: 14, align: 'r' },
      ],
      rows
    );
  }
  const flat = arr.filter((p) => Number(p.size) === 0);
  if (flat.length) L(`(flat positions omitted: ${flat.length} instruments)`);
}

function appendExchangeOpenOrders(L, orders, maxLines = 120) {
  L('');
  L('================================================================================');
  L('EXCHANGE · get_open_orders_by_currency');
  L('================================================================================');
  const arr = Array.isArray(orders) ? orders : [];
  L(`count: ${arr.length}`);
  const slice = arr.slice(0, maxLines);
  if (slice.length) {
    const rows = slice.map((o) => [
      String(o.order_id ?? ''),
      o.instrument_name || '-',
      o.direction || '-',
      String(o.amount ?? ''),
      String(o.price ?? ''),
      o.order_state || '-',
      (o.label || '-').slice(0, 18),
    ]);
    emitAsciiTable(
      L,
      [
        { h: 'order_id', w: 14, align: 'r' },
        { h: 'instrument', w: 20 },
        { h: 'dir', w: 5 },
        { h: 'amt', w: 8, align: 'r' },
        { h: 'px', w: 10, align: 'r' },
        { h: 'state', w: 10 },
        { h: 'label', w: 18 },
      ],
      rows
    );
  }
  if (arr.length > maxLines) L(`... truncated (${arr.length - maxLines} more orders)`);
}

async function fetchAllUserTradesCurrencyWindow(token, currency, startMs) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(700);
    const res = await deribitPrivateRpc(token, 'get_user_trades_by_currency_and_time', {
      currency,
      start_timestamp: cur,
      end_timestamp: Date.now(),
      count: 1000,
      sorting: 'asc',
    });
    const trades = res.trades || [];
    if (!trades.length) break;
    all.push(...trades);
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

function appendExchangeFillsByInstrument(L, trades, idx) {
  L('');
  L('================================================================================');
  L('EXCHANGE · all user trades in window (by instrument)');
  L('================================================================================');
  L(`total fill rows: ${trades.length}`);
  const by = {};
  for (const t of trades) {
    const name = t.instrument_name || '(unknown)';
    if (!by[name]) {
      by[name] = { n: 0, vol: 0, pl: 0, fee: 0, rebate: 0, takerPaid: 0 };
    }
    const b = by[name];
    b.n++;
    b.vol += Math.abs(Number(t.amount) || 0);
    b.pl += Number(t.profit_loss) || 0;
    const fee = Number(t.fee) || 0;
    b.fee += fee;
    if (fee < 0) b.rebate += -fee;
    else if (fee > 0) b.takerPaid += fee;
  }
  const names = Object.keys(by).sort();
  let totVol = 0;
  let totPl = 0;
  const usd = (btc) => (idx > 0 && Number.isFinite(btc) ? btc * idx : null);
  const instRows = [];
  for (const name of names) {
    const b = by[name];
    totVol += b.vol;
    totPl += b.pl;
    const wBtc = b.pl + b.fee;
    instRows.push([
      name,
      String(b.n),
      `$${b.vol.toFixed(2)}`,
      wBtc.toFixed(8),
      usd(wBtc) != null ? `$${usd(wBtc).toFixed(2)}` : 'n/a',
      b.pl.toFixed(8),
      b.rebate.toFixed(8),
      b.takerPaid.toFixed(8),
    ]);
  }
  if (instRows.length) {
    emitAsciiTable(
      L,
      [
        { h: 'instrument', w: 22 },
        { h: 'fills', w: 6, align: 'r' },
        { h: 'volUSD', w: 12, align: 'r' },
        { h: 'wallet_BTC', w: 14, align: 'r' },
        { h: 'wallet_$', w: 12, align: 'r' },
        { h: 'pl_BTC', w: 14, align: 'r' },
        { h: 'rebate+', w: 12, align: 'r' },
        { h: 'taker+', w: 12, align: 'r' },
      ],
      instRows
    );
  }
  let totFee = 0;
  let totRebateBtc = 0;
  let totPaidBtc = 0;
  for (const t of trades) {
    const fee = Number(t.fee) || 0;
    totFee += fee;
    if (fee < 0) totRebateBtc += -fee;
    else if (fee > 0) totPaidBtc += fee;
  }
  const totNet = totPl + totFee;
  const plMinusNegRebate = totPl + totRebateBtc;
  L('--- totals (all instruments) ---');
  emitAsciiTable(
    L,
    [
      { h: 'metric', w: 52 },
      { h: 'value', w: 54 },
    ],
    [
      ['sum |amount| (USD notional)', `$${totVol.toFixed(2)}`],
      ['wallet on fills (sum pl+fee, BTC)', `${totNet.toFixed(8)}  (~$${usd(totNet)?.toFixed(4) ?? 'n/a'})`],
      ['pl − rebate(+wallet) + taker (BTC)', `${totPl.toFixed(8)} − ${totRebateBtc.toFixed(8)} + ${totPaidBtc.toFixed(8)} = ${totNet.toFixed(8)}`],
      [
        'mark PnL − (−rebate) = pl + rebate+ (BTC)',
        `${plMinusNegRebate.toFixed(8)}  (~$${usd(plMinusNegRebate)?.toFixed(4) ?? 'n/a'})`,
      ],
      ['sum profit_loss (price-only, BTC)', `${totPl.toFixed(8)}  (~$${usd(totPl)?.toFixed(4) ?? 'n/a'})`],
      ['sum fee (= −rebates + taker, BTC)', totFee.toFixed(8)],
      ['maker rebates to wallet (+, BTC)', `${totRebateBtc.toFixed(8)}  (~$${usd(totRebateBtc)?.toFixed(4) ?? 'n/a'})`],
      ['taker paid (BTC)', totPaidBtc.toFixed(8)],
    ]
  );
}

async function main() {
  const { pairId, rollingHours, noFile } = parseSnapshotArgs();
  await sequelize.authenticate();

  const now = new Date();
  const endMs = now.getTime();
  let windowStartMs;
  let windowLine;
  let reconcileLabel;
  let fileSlug;
  if (rollingHours != null) {
    windowStartMs = endMs - rollingHours * 3600000;
    windowLine = `last ${rollingHours}h rolling  ${new Date(windowStartMs).toISOString()}  →  ${now.toISOString()}`;
    reconcileLabel = `last ${rollingHours}h rolling (same window as snapshot above)`;
    fileSlug = `last${rollingHours}h`;
  } else {
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth();
    const d = now.getUTCDate();
    windowStartMs = Date.UTC(y, mo, d - 1, 0, 0, 0, 0);
    windowLine = `${new Date(windowStartMs).toISOString()} (UTC yesterday 00:00)  →  ${now.toISOString()}`;
    reconcileLabel = 'since yesterday 00:00 UTC (same window as snapshot above)';
    fileSlug = 'since_yesterday';
  }

  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) {
    console.error(`pairId ${pairId} not found`);
    process.exit(1);
  }

  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  if (!acctName) {
    console.error('No tradeAccount on pair');
    process.exit(1);
  }

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    console.error('AccountDetails missing for', acctName);
    process.exit(1);
  }
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token = await getToken(apiKey, secret);
  await sleep(1500);

  const ix = await axios
    .get('https://www.deribit.com/api/v2/public/get_index_price', {
      params: { index_name: `${currency.toLowerCase()}_usd` },
    })
    .catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;
  const usd = (btc) => (idx > 0 && btc != null && Number.isFinite(Number(btc)) ? Number(btc) * idx : null);

  const since = new Date(windowStartMs);
  const closed = await BasisPosition.findAll({
    where: {
      pairId,
      state: 'closed',
      exitTime: { [Op.gte]: since },
    },
    attributes: ['id', 'exitReason', 'netPnl'],
    raw: true,
  });

  let wins = 0;
  let losses = 0;
  let pnlDb = 0;
  for (const row of closed) {
    pnlDb += Number(row.netPnl) || 0;
    const er = row.exitReason;
    if (er === 'profit') wins++;
    else if (er === 'stop') losses++;
  }
  const decided = wins + losses;
  const winLossRatio = decided > 0 ? wins / losses : null;

  const summary = await deribitGetSummary(token, currency);
  const curEquity = Number(summary.equity);
  const curBalance = Number(summary.balance);

  await sleep(1600);
  const positions = await deribitPrivateRpc(token, 'get_positions', { currency });
  await sleep(1600);
  const openOrders = await deribitPrivateRpc(token, 'get_open_orders_by_currency', { currency });
  await sleep(2000);
  const allTrades = await fetchAllUserTradesCurrencyWindow(token, currency, windowStartMs);
  await sleep(1600);
  const txLogs = await fetchTxLogsNearAnchor(token, currency, windowStartMs);
  const atStart = stateAtOrBefore(txLogs, windowStartMs);

  const lines = [];
  const L = (s) => {
    lines.push(s);
    console.log(s);
  };

  L('================================================================================');
  L('BTC SNAPSHOT');
  L('================================================================================');
  emitAsciiTable(L, [
    { h: 'field', w: 28 },
    { h: 'value', w: 86 },
  ], [
    ['pairId', String(pairId)],
    ['agent', pair.agentName || ''],
    ['window', windowLine],
    ['executed instrument', execSym],
    ['account', acctName],
  ]);
  L('================================================================================');

  appendExchangeAccountSummaryFull(L, summary, idx, currency);
  appendExchangePositions(L, positions, idx, currency);
  appendExchangeOpenOrders(L, openOrders);
  appendExchangeFillsByInstrument(L, allTrades, idx);

  L('');
  L('Exchange balances (anchor vs now)');
  const anchorLabel = rollingHours != null ? 'window start (UTC)' : 'yesterday 00:00 UTC';
  const balRows = [
    [
      `Start balance ${currency} @ ${anchorLabel}`,
      atStart?.balance != null ? atStart.balance.toFixed(8) : 'n/a (no tx log in lookback)',
    ],
    [`Start equity ${currency} @ ${anchorLabel}`, atStart?.equity != null ? atStart.equity.toFixed(8) : 'n/a'],
  ];
  if (atStart && idx > 0) {
    balRows.push(['Start balance ~ USD @ index', `$${usd(atStart.balance)?.toFixed(2) ?? 'n/a'}`]);
    balRows.push(['Start equity ~ USD @ index', `$${usd(atStart.equity)?.toFixed(2) ?? 'n/a'}`]);
  }
  balRows.push(
    [
      `Current balance ${currency}`,
      Number.isFinite(curBalance) ? curBalance.toFixed(8) : String(summary.balance),
    ],
    [
      `Current equity ${currency}`,
      Number.isFinite(curEquity) ? curEquity.toFixed(8) : String(summary.equity),
    ],
    ['Current balance ~ USD @ index', `$${usd(curBalance)?.toFixed(2) ?? 'n/a'}`],
    ['Current equity ~ USD @ index', `$${usd(curEquity)?.toFixed(2) ?? 'n/a'}`]
  );
  emitAsciiTable(
    L,
    [
      { h: 'metric', w: 52 },
      { h: 'value', w: 30 },
    ],
    balRows
  );
  L('');
  L('DB round trips (basis_positions closed in window)');
  emitAsciiTable(
    L,
    [
      { h: 'metric', w: 52 },
      { h: 'value', w: 30 },
    ],
    [
      ['PnL (sum netPnl, USD)', `$${pnlDb.toFixed(4)}`],
      ['Wins (exitReason=profit)', String(wins)],
      ['Losses (exitReason=stop)', String(losses)],
      [
        'Win/loss ratio (wins÷losses, stops>0)',
        winLossRatio != null && Number.isFinite(winLossRatio) ? winLossRatio.toFixed(4) : 'n/a',
      ],
      ['Closed positions (all exit reasons in PnL sum)', String(closed.length)],
    ]
  );
  L('');

  await sleep(2500);
  const reconLines = [];
  await appendExchangeReconcile(reconLines, pair, windowStartMs, reconcileLabel);
  for (const line of reconLines) {
    L(line);
  }

  L('');
  L(
    `Notes: Start balance/equity from transaction_log (21d lookback ending just after window start). Subaccount = whole wallet.`
  );
  L('================================================================================');

  if (noFile) {
    console.log('\n(--no-file: snapshot printed above only; no report file written.)');
  } else {
    const outDir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const ts = now.toISOString().replace(/[:.]/g, '-');
    const outPath = path.join(outDir, `btc_snapshot_pair${pairId}_${fileSlug}_${ts}.txt`);
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log('\nWrote', outPath);
  }

  await sequelize.close();
}

main().catch((e) => {
  if (e.response) console.error('HTTP', e.response.status, e.response.data);
  console.error(e.message || e);
  process.exit(1);
});
