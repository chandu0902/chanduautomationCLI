/**
 * Complete exchange report — everything from Deribit, all in tables.
 * Sections: balances · session PnL · margin · open orders · perp position ·
 *           options positions (live) · perp fills · options fills ·
 *           transaction log · settlements · daily breakdown
 *
 *   node scripts/exchangeSimpleReport.js
 *   node scripts/exchangeSimpleReport.js --pairIds=24,25
 *   node scripts/exchangeSimpleReport.js --pairIds=24 --hours=24
 *   node scripts/exchangeSimpleReport.js --pairIds=25 --since=2026-04-17T00:00:00Z
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails, Trade, BasisPosition, BotSessionLog }
  = require('../src/models');
const { currencyFromSymbol } = require('../lib/btcDeribitReconcileSection');

// ─── auth helpers ────────────────────────────────────────────────────────────

function decryptText(k64, enc, iv64) {
  const dec = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k64, 'base64'), Buffer.from(iv64, 'base64'));
  return dec.update(enc, 'base64', 'utf8') + dec.final('utf8');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function deribitAuth(acct) {
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
}

async function deribitPrivate(method, params, token) {
  const r = await axios.post(
    `https://www.deribit.com/api/v2/private/${method}`,
    { jsonrpc: '2.0', id: 1, method: `private/${method}`, params: params || {} },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

// paginated fills for one instrument
async function fetchFillsForInstrument(token, currency, startMs, instrument) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(450);
    let r;
    for (let attempt = 0; attempt < 5; attempt++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
        headers: { Authorization: `Bearer ${token}` },
        params: { currency, start_timestamp: cur, end_timestamp: Date.now(), count: 1000, sorting: 'asc' },
        timeout: 25000, validateStatus: () => true,
      });
      if (r.status === 429 || r.data?.error?.code === 10028) { await sleep(5000 * (attempt + 1)); continue; }
      break;
    }
    if (r.status >= 400) throw new Error(`get_user_trades HTTP ${r.status}`);
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res    = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    for (const t of trades) { if (t.instrument_name === instrument) all.push(t); }
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

// all fills for currency (no instrument filter) — for options
async function fetchAllFillsCurrency(token, currency, startMs) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(450);
    let r;
    for (let attempt = 0; attempt < 5; attempt++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
        headers: { Authorization: `Bearer ${token}` },
        params: { currency, start_timestamp: cur, end_timestamp: Date.now(), count: 1000, sorting: 'asc' },
        timeout: 25000, validateStatus: () => true,
      });
      if (r.status === 429 || r.data?.error?.code === 10028) { await sleep(5000 * (attempt + 1)); continue; }
      break;
    }
    if (r.status >= 400) throw new Error(`get_user_trades HTTP ${r.status}`);
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res    = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    all.push(...trades);
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

// transaction log (ledger: fee, transfer, deposit, etc.)
async function fetchTransactionLog(token, currency, startMs) {
  const all = [];
  let offset = 0;
  const count = 100;
  for (let page = 0; page < 60; page++) {
    await sleep(350);
    let res;
    try {
      res = await deribitPrivate('get_transaction_log', {
        currency,
        start_timestamp: startMs,
        end_timestamp: Date.now(),
        count,
        offset,
      }, token);
    } catch { break; }
    const logs = res?.logs || [];
    all.push(...logs);
    if (logs.length < count) break;
    offset += count;
  }
  return all;
}

// settlement history
async function fetchSettlements(token, currency, startMs) {
  const all = [];
  let cont = null;
  for (let page = 0; page < 20; page++) {
    await sleep(350);
    let res;
    try {
      res = await deribitPrivate('get_settlement_history_by_currency', {
        currency,
        type: 'settlement',
        count: 50,
        ...(cont ? { continuation: cont } : {}),
      }, token);
    } catch { break; }
    const settles = res?.settlements || [];
    for (const s of settles) {
      if (Number(s.timestamp) >= startMs) all.push(s);
    }
    cont = res?.continuation;
    if (!cont || !settles.length) break;
  }
  return all;
}

// ─── table helpers ───────────────────────────────────────────────────────────

function table(lines, cols, rows) {
  const pad = (s, w, a) => {
    const t   = String(s ?? '');
    const show = t.length > w ? t.slice(0, Math.max(1, w - 1)) + '…' : t;
    const sp  = Math.max(0, w - show.length);
    return a === 'r' ? ' '.repeat(sp) + show : show + ' '.repeat(sp);
  };
  const sep = () => '  +' + cols.map(c => '-'.repeat(c.w + 2)).join('+') + '+';
  const row = cells => '  |' + cells.map((c, i) => ' ' + pad(c, cols[i].w, cols[i].a || 'l') + ' ').join('|') + '|';
  lines.push(sep());
  lines.push(row(cols.map(c => c.h)));
  lines.push(sep());
  for (const r of rows) lines.push(row(r));
  lines.push(sep());
}

function divRow(cols) {
  return cols.map(c => '─'.repeat(c.w));
}

function hdr(lines, title) {
  lines.push('');
  lines.push(`  ┌─ ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}┐`);
}

function n$(v, d = 2) { return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-'; }
function u$(v, idx)   { const n = Number(v); return Number.isFinite(n) && idx ? '$' + (n * idx).toFixed(2) : '-'; }
function pct(a, b)    { return (a + b) > 0 ? ((a / (a + b)) * 100).toFixed(1) + '%' : 'n/a'; }
function ts(ms)       { return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-'; }

// aggregate fill stats
function aggregateFills(fills, execInstrument) {
  const filtered = execInstrument ? fills.filter(f => f.instrument_name === execInstrument) : fills;
  let vol = 0, pl = 0, fee = 0, reb = 0, tak = 0, nClose = 0, nOpen = 0;
  const wins = [], losses = [];
  let minPx = Infinity, maxPx = -Infinity;
  const daily = {};
  for (const f of filtered) {
    const amt  = Math.abs(Number(f.amount) || 0);
    const fpl  = Number(f.profit_loss) || 0;
    const ffee = Number(f.fee) || 0;
    const px   = Number(f.price) || 0;
    const fts  = Number(f.timestamp);
    vol += amt; pl += fpl; fee += ffee;
    if (ffee < 0) reb += -ffee; else tak += ffee;
    if (fpl !== 0) { nClose++; const w = fpl + ffee; if (w > 0) wins.push(w); else losses.push(w); }
    else nOpen++;
    if (px) { if (px < minPx) minPx = px; if (px > maxPx) maxPx = px; }
    if (fts) {
      const d = new Date(fts).toISOString().slice(0, 10);
      if (!daily[d]) daily[d] = { vol: 0, pl: 0, fee: 0, reb: 0, n: 0 };
      daily[d].vol += amt; daily[d].pl += fpl; daily[d].fee += ffee;
      daily[d].reb += ffee < 0 ? -ffee : 0; daily[d].n++;
    }
  }
  return {
    count: filtered.length, vol, pl, fee, reb, tak, nClose, nOpen,
    wallet: pl + fee, plPlusReb: pl + reb,
    wins, losses, wR: wins.length, lR: losses.length,
    minPx, maxPx, daily,
    totWinUsd:  wins.reduce((s, x) => s + x, 0),
    totLossUsd: losses.reduce((s, x) => s + x, 0),
    avgWin:  wins.length  ? wins.reduce((s, x) => s + x, 0)  / wins.length  : null,
    avgLoss: losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : null,
  };
}

// emit fills analysis table
function emitFillsTable(lines, stat, currency, idx, label) {
  const cols = [{ h: label || 'Metric', w: 44 }, { h: currency, w: 18, a: 'r' }, { h: '~ USD', w: 16, a: 'r' }];
  table(lines, cols, [
    ['Total fills',                         String(stat.count),                                                  ''],
    ['  Closing slices  (profit_loss ≠ 0)', String(stat.nClose),                                                 ''],
    ['  Opening slices  (profit_loss = 0)', String(stat.nOpen),                                                  ''],
    ['Volume  Σ |amount|',                  '',                                                                  `$${n$(stat.vol, 0)}`],
    ['Price range',                         '',                                                                  stat.minPx < Infinity ? `$${n$(stat.minPx,2)}–$${n$(stat.maxPx,2)}` : 'n/a'],
    divRow(cols),
    ['Profit fills  (pl+fee > 0)',          `${stat.wR} fills`,                                                  u$(stat.totWinUsd,  idx)],
    ['Loss fills    (pl+fee < 0)',          `${stat.lR} fills`,                                                  u$(stat.totLossUsd, idx)],
    ['Win rate',                            '',                                                                  pct(stat.wR, stat.lR)],
    ['W/L ratio',                           '',                                                                  stat.lR > 0 ? (stat.wR/stat.lR).toFixed(3) : stat.wR > 0 ? 'inf' : 'n/a'],
    ['Avg win  / profit fill',              stat.avgWin  != null ? n$(stat.avgWin,  8) + ` ${currency}` : 'n/a', stat.avgWin  != null ? u$(stat.avgWin,  idx) : ''],
    ['Avg loss / loss fill',                stat.avgLoss != null ? n$(stat.avgLoss, 8) + ` ${currency}` : 'n/a', stat.avgLoss != null ? u$(stat.avgLoss, idx) : ''],
    divRow(cols),
    ['Mark PnL  Σ profit_loss',             n$(stat.pl,        8) + ` ${currency}`,                              u$(stat.pl,        idx)],
    ['Maker rebates  (fee < 0)',            n$(stat.reb,       8) + ` ${currency}`,                              u$(stat.reb,       idx)],
    ['Taker fees paid',                     n$(stat.tak,       8) + ` ${currency}`,                              stat.tak > 0 ? u$(stat.tak, idx) : '$0.00'],
    ['Net fee  (= −rebates + taker)',       n$(stat.fee,       8) + ` ${currency}`,                              ''],
    ['Mark PnL + rebates',                  n$(stat.plPlusReb, 8) + ` ${currency}`,                              u$(stat.plPlusReb, idx)],
    ['Wallet on fills  (pl + fee)',         n$(stat.wallet,    8) + ` ${currency}`,                              u$(stat.wallet,    idx)],
  ]);
}

// ─── window resolver ─────────────────────────────────────────────────────────

async function resolveStart(pairId, opts) {
  if (opts.since) { const x = Date.parse(opts.since); if (!isNaN(x)) return { startMs: x, label: opts.since }; }
  if (opts.hours) return { startMs: Date.now() - opts.hours * 3600000, label: `last ${opts.hours}h` };
  const tMin  = await Trade.min('createdAt', { where: { pairId } });
  const bpMin = await BasisPosition.min('entryTime', { where: { pairId } });
  const times = [tMin, bpMin].filter(Boolean).map(d => new Date(d).getTime()).filter(n => !isNaN(n));
  if (!times.length) return { startMs: Date.now() - 7 * 86400000, label: 'default 7d' };
  return { startMs: Math.max(Math.min(...times), Date.now() - 90 * 86400000), label: 'from pair start' };
}

// ─── main report builder ─────────────────────────────────────────────────────

async function buildReport(pair, opts) {
  const pid      = pair.id;
  const execSym  = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  const { startMs, label: winLabel } = await resolveStart(pid, opts);
  const startDate = new Date(startMs);

  const lines = [];
  const L = s => lines.push(s);

  L('');
  L('  ' + '═'.repeat(76));
  L(`  ${currency} · PAIR ${pid}  —  ${pair.agentName || ''}`);
  L(`  Account   : ${acctName}`);
  L(`  Instrument: ${execSym}   │   Signal: ${pair.tradeLeg === 'B' ? pair.symbol1 : pair.symbol2}`);
  L(`  Window    : ${winLabel}   ${startDate.toISOString()} → ${new Date().toISOString()}`);
  L('  ' + '═'.repeat(76));

  // ── auth + index ──────────────────────────────────────────────────────────
  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) { L(`  ERROR: No credentials for ${acctName}`); return lines; }
  const token = await deribitAuth(acct);

  const ixR = await axios.get('https://www.deribit.com/api/v2/public/get_index_price',
    { params: { index_name: `${currency.toLowerCase()}_usd` } }).catch(() => ({ data: {} }));
  const idx = Number(ixR.data?.result?.index_price) || 0;

  // ── bot session ───────────────────────────────────────────────────────────
  const sessions   = await BotSessionLog.findAll({ where: { pairId: pid }, order: [['enabledAt', 'DESC']], limit: 10 });
  const curSession = sessions.find(s => !s.disabledAt);
  const lastSess   = sessions[0];

  // ── account summary ───────────────────────────────────────────────────────
  const sum = await deribitPrivate('get_account_summary', { currency, extended: true }, token);
  await sleep(250);

  const equity    = Number(sum.equity)          || 0;
  const balance   = Number(sum.balance)         || 0;
  const avail     = Number(sum.available_funds) || 0;
  const mrgBal    = Number(sum.margin_balance)  || 0;
  const initMrg   = Number(sum.initial_margin)  || 0;
  const maintMrg  = Number(sum.maintenance_margin) || 0;
  const sesUpl    = Number(sum.session_upl)     || 0;
  const sesRpl    = Number(sum.session_rpl)     || 0;
  const totalPl   = Number(sum.total_pl);
  const fuUpl     = sum.futures_session_upl  != null ? Number(sum.futures_session_upl)  : null;
  const fuRpl     = sum.futures_session_rpl  != null ? Number(sum.futures_session_rpl)  : null;
  const opUpl     = sum.options_session_upl  != null ? Number(sum.options_session_upl)  : null;
  const opRpl     = sum.options_session_rpl  != null ? Number(sum.options_session_rpl)  : null;
  const implStart = equity - sesUpl - sesRpl;

  // ── 1. BALANCES ───────────────────────────────────────────────────────────
  hdr(lines, '1. BALANCES');
  const balRows = [
    ['Equity  (incl. UPL)',        n$(equity,  8), u$(equity,  idx)],
    ['Wallet balance',             n$(balance, 8), u$(balance, idx)],
    ['Available funds',            n$(avail,   8), u$(avail,   idx)],
    ['Margin balance',             n$(mrgBal,  8), u$(mrgBal,  idx)],
  ];
  if (curSession?.startBalance != null)
    balRows.push(['Bot session start equity (DB)', '–', `$${Number(curSession.startBalance).toFixed(2)}`]);
  else if (lastSess?.startBalance != null)
    balRows.push(['Bot last session start equity (DB)', '–', `$${Number(lastSess.startBalance).toFixed(2)}`]);
  table(lines, [{ h: 'Field', w: 38 }, { h: currency, w: 16, a: 'r' }, { h: '~ USD', w: 16, a: 'r' }], balRows);

  // ── 2. SESSION PnL ────────────────────────────────────────────────────────
  hdr(lines, '2. SESSION PnL  (Deribit session, resets ~00:00 UTC)');
  const sesColDef = [{ h: 'Field', w: 38 }, { h: currency, w: 16, a: 'r' }, { h: '~ USD', w: 16, a: 'r' }];
  const sesRows = [
    ['Session start equity (implied)',  n$(implStart, 8), u$(implStart, idx)],
    ['Session UPL  (unrealised)',       n$(sesUpl,    8), u$(sesUpl,    idx)],
    ['Session RPL  (realised)',         n$(sesRpl,    8), u$(sesRpl,    idx)],
    ['Session total  UPL + RPL',       n$(sesUpl + sesRpl, 8), u$(sesUpl + sesRpl, idx)],
    divRow(sesColDef),
  ];
  if (fuUpl != null) sesRows.push(['  Futures UPL / RPL', `${n$(fuUpl,8)} / ${n$(fuRpl,8)}`, `${u$(fuUpl,idx)} / ${u$(fuRpl,idx)}`]);
  if (opUpl  != null) sesRows.push(['  Options UPL / RPL', `${n$(opUpl,8)} / ${n$(opRpl,8)}`,  `${u$(opUpl,idx)} / ${u$(opRpl,idx)}`]);
  sesRows.push(divRow(sesColDef));
  sesRows.push(['All-time total_pl', n$(totalPl, 8), u$(totalPl, idx)]);
  table(lines, sesColDef, sesRows);

  // ── 3. MARGIN ─────────────────────────────────────────────────────────────
  hdr(lines, '3. MARGIN');
  table(lines, [{ h: 'Field', w: 38 }, { h: currency, w: 16, a: 'r' }, { h: '~ USD', w: 16, a: 'r' }], [
    ['Initial margin',       n$(initMrg,  8), u$(initMrg,  idx)],
    ['Maintenance margin',   n$(maintMrg, 8), u$(maintMrg, idx)],
    ['Available funds',      n$(avail,    8), u$(avail,    idx)],
    ['Margin utilisation',   '', initMrg > 0 && equity > 0 ? pct(initMrg * 100, (equity - initMrg) * 100) : '-'],
  ]);

  // ── 4. OPEN ORDERS ────────────────────────────────────────────────────────
  hdr(lines, '4. OPEN ORDERS');
  await sleep(250);
  const openOrders = await deribitPrivate('get_open_orders_by_currency', { currency, type: 'all' }, token).catch(() => []);
  await sleep(250);
  if (!openOrders.length) {
    L('  (none)');
  } else {
    table(lines, [
      { h: 'Order ID',       w: 20 },
      { h: 'Instrument',     w: 26 },
      { h: 'Dir',            w: 5 },
      { h: 'Type',           w: 8 },
      { h: 'Price',          w: 12, a: 'r' },
      { h: 'Amount',         w: 10, a: 'r' },
      { h: 'Filled',         w: 10, a: 'r' },
      { h: 'Created',        w: 22 },
    ], openOrders.map(o => [
      String(o.order_id || '').slice(-18),
      o.instrument_name,
      o.direction,
      o.order_type,
      n$(o.price, 2),
      n$(o.amount, 0),
      n$(o.filled_amount, 0),
      ts(o.creation_timestamp),
    ]));
  }

  // ── 5. PERP POSITION ──────────────────────────────────────────────────────
  hdr(lines, '5. PERP POSITION');
  const positions = await deribitPrivate('get_positions', { currency }, token).catch(() => []);
  await sleep(250);
  const perpPos = positions.filter(p => p.kind === 'future');
  const optPos  = positions.filter(p => p.kind === 'option' && p.size !== 0);

  if (!perpPos.length) { L('  (none)'); }
  else {
    table(lines, [
      { h: 'Instrument',      w: 20 },
      { h: 'Dir',             w: 5 },
      { h: 'Size USD',        w: 12, a: 'r' },
      { h: 'Avg Entry $',     w: 14, a: 'r' },
      { h: 'Mark $',          w: 14, a: 'r' },
      { h: `UPL ${currency}`, w: 16, a: 'r' },
      { h: `RPL ${currency}`, w: 16, a: 'r' },
      { h: 'UPL USD',         w: 14, a: 'r' },
    ], perpPos.map(p => [
      p.instrument_name, p.direction,
      n$(p.size, 0),
      n$(p.average_price, 2), n$(p.mark_price, 2),
      n$(p.floating_profit_loss, 8),
      n$(p.realized_profit_loss, 8),
      u$(p.floating_profit_loss, idx),
    ]));
  }

  // ── 6. OPTIONS POSITIONS (live only) ──────────────────────────────────────
  hdr(lines, '6. OPTIONS POSITIONS  (live, size ≠ 0)');
  if (!optPos.length) { L('  (none)'); }
  else {
    table(lines, [
      { h: 'Instrument',      w: 26 },
      { h: 'Dir',             w: 5 },
      { h: 'Size',            w: 6,  a: 'r' },
      { h: 'Avg USD',         w: 12, a: 'r' },
      { h: 'Mark',            w: 10, a: 'r' },
      { h: 'UPL USD',         w: 14, a: 'r' },
      { h: 'RPL USD',         w: 14, a: 'r' },
      { h: 'Delta',           w: 8,  a: 'r' },
      { h: 'Theta',           w: 10, a: 'r' },
      { h: 'Vega',            w: 10, a: 'r' },
    ], optPos.map(p => [
      p.instrument_name, p.direction,
      n$(p.size, 0),
      '$' + n$(p.average_price_usd, 2),
      n$(p.mark_price, 6),
      '$' + n$(p.floating_profit_loss_usd, 2),
      '$' + n$((Number(p.realized_profit_loss)||0) * idx, 2),
      n$(p.delta, 4), n$(p.theta, 2), n$(p.vega, 2),
    ]));
    const totUpl   = optPos.reduce((s, p) => s + (Number(p.floating_profit_loss_usd)||0), 0);
    const totDelta = optPos.reduce((s, p) => s + (Number(p.delta)||0), 0);
    const totTheta = optPos.reduce((s, p) => s + (Number(p.theta)||0), 0);
    const totVega  = optPos.reduce((s, p) => s + (Number(p.vega) ||0), 0);
    table(lines, [
      { h: 'Summary',   w: 26 },
      { h: 'UPL USD',   w: 14, a: 'r' },
      { h: 'Net Delta', w: 10, a: 'r' },
      { h: 'Net Theta', w: 10, a: 'r' },
      { h: 'Net Vega',  w: 10, a: 'r' },
    ], [['All options', '$' + n$(totUpl,2), n$(totDelta,4), n$(totTheta,2), n$(totVega,2)]]);
  }

  // ── 7. PERP FILLS ─────────────────────────────────────────────────────────
  hdr(lines, `7. PERP FILLS  —  ${execSym}  (${winLabel})`);
  L(`  Fetching perp fills from ${startDate.toISOString()} ...`);
  const perpFills = await fetchFillsForInstrument(token, currency, startMs, execSym);
  const ps = aggregateFills(perpFills, null);
  emitFillsTable(lines, ps, currency, idx, 'Metric');

  // ── 8. OPTIONS FILLS ──────────────────────────────────────────────────────
  hdr(lines, `8. OPTIONS FILLS  —  all ${currency} options  (${winLabel})`);
  L(`  Fetching all ${currency} fills from ${startDate.toISOString()} ...`);
  const allFills  = await fetchAllFillsCurrency(token, currency, startMs);
  const optFills  = allFills.filter(f => f.instrument_name !== execSym && f.instrument_kind === 'option');
  if (!optFills.length) {
    L('  (no options fills in window)');
  } else {
    // per-instrument breakdown
    const byInstr = {};
    for (const f of optFills) {
      const k = f.instrument_name;
      if (!byInstr[k]) byInstr[k] = [];
      byInstr[k].push(f);
    }
    const instrRows = [];
    let totOptVol = 0, totOptPl = 0, totOptReb = 0, totOptFee = 0, totOptN = 0;
    for (const [instr, flist] of Object.entries(byInstr)) {
      const s = aggregateFills(flist, null);
      totOptVol += s.vol; totOptPl += s.pl; totOptReb += s.reb; totOptFee += s.fee; totOptN += s.count;
      instrRows.push([
        instr, String(s.count),
        n$(s.pl,   8) + ` ${currency}`, u$(s.pl,   idx),
        n$(s.reb,  8) + ` ${currency}`, u$(s.reb,  idx),
        n$(s.wallet,8) + ` ${currency}`, u$(s.wallet,idx),
      ]);
    }
    instrRows.push(
      ['─'.repeat(24),'─'.repeat(6),'─'.repeat(16),'─'.repeat(12),'─'.repeat(16),'─'.repeat(12),'─'.repeat(16),'─'.repeat(12)],
      ['TOTAL', String(totOptN),
        n$(totOptPl, 8)+` ${currency}`,  u$(totOptPl,  idx),
        n$(totOptReb,8)+` ${currency}`,  u$(totOptReb, idx),
        n$(totOptPl+totOptFee,8)+` ${currency}`, u$(totOptPl+totOptFee, idx)],
    );
    table(lines, [
      { h: 'Instrument',         w: 24 },
      { h: 'Fills',              w: 6,  a: 'r' },
      { h: `Mark PnL ${currency}`, w: 16, a: 'r' },
      { h: '~ USD',              w: 12, a: 'r' },
      { h: `Rebates ${currency}`, w: 16, a: 'r' },
      { h: '~ USD',              w: 12, a: 'r' },
      { h: `Wallet ${currency}`,  w: 16, a: 'r' },
      { h: '~ USD',              w: 12, a: 'r' },
    ], instrRows);
  }

  // ── 9. TRANSACTION LOG ────────────────────────────────────────────────────
  hdr(lines, `9. TRANSACTION LOG  (${winLabel})`);
  L('  Fetching transaction log ...');
  const txLogs = await fetchTransactionLog(token, currency, startMs);
  if (!txLogs.length) {
    L('  (no transactions in window)');
  } else {
    // group by type
    const byType = {};
    for (const t of txLogs) {
      const k = t.type || 'unknown';
      if (!byType[k]) byType[k] = { count: 0, amount: 0 };
      byType[k].count++;
      byType[k].amount += Number(t.amount) || 0;
    }
    const typeRows = Object.entries(byType).sort((a,b) => Math.abs(b[1].amount) - Math.abs(a[1].amount)).map(([type, v]) => [
      type, String(v.count), n$(v.amount, 8) + ` ${currency}`, u$(v.amount, idx),
    ]);
    table(lines, [
      { h: 'Type',    w: 22 },
      { h: 'Count',   w: 6,  a: 'r' },
      { h: currency,  w: 18, a: 'r' },
      { h: '~ USD',   w: 14, a: 'r' },
    ], typeRows);

    // last 15 transactions detail
    L('');
    L('  Last 15 transactions (newest first):');
    table(lines, [
      { h: 'Time (UTC)',   w: 20 },
      { h: 'Type',         w: 18 },
      { h: 'Info',         w: 24 },
      { h: currency,       w: 16, a: 'r' },
      { h: '~ USD',        w: 14, a: 'r' },
    ], txLogs.slice(-15).reverse().map(t => [
      ts(t.timestamp),
      t.type || '-',
      (t.instrument_name || t.info || '').toString().slice(0, 24),
      n$(t.amount, 8),
      u$(t.amount, idx),
    ]));
  }

  // ── 10. SETTLEMENTS ───────────────────────────────────────────────────────
  hdr(lines, `10. SETTLEMENTS  (${winLabel})`);
  L('  Fetching settlements ...');
  const settles = await fetchSettlements(token, currency, startMs);
  if (!settles.length) {
    L('  (none in window)');
  } else {
    table(lines, [
      { h: 'Time (UTC)',        w: 20 },
      { h: 'Instrument',        w: 26 },
      { h: 'Type',              w: 12 },
      { h: `Session PnL ${currency}`, w: 18, a: 'r' },
      { h: '~ USD',             w: 14, a: 'r' },
    ], settles.map(s => [
      ts(s.timestamp),
      s.instrument_name || '-',
      s.type || '-',
      n$(s.session_profit_loss, 8),
      u$(s.session_profit_loss, idx),
    ]));
  }

  // ── 11. DAILY BREAKDOWN ───────────────────────────────────────────────────
  const days = Object.keys(ps.daily).sort();
  if (days.length) {
    hdr(lines, '11. DAILY BREAKDOWN  (perp fills)');
    const scale = idx || 1;
    const dayRows = days.map(d => {
      const row = ps.daily[d];
      return [d, String(row.n), '$'+n$(row.vol,0), '$'+n$(row.pl*scale,2), '$'+n$(row.reb*scale,2), '$'+n$((row.pl+row.fee)*scale,2)];
    });
    const tV = days.reduce((s,d)=>s+ps.daily[d].vol,0);
    const tP = days.reduce((s,d)=>s+ps.daily[d].pl, 0);
    const tR = days.reduce((s,d)=>s+ps.daily[d].reb,0);
    const tW = days.reduce((s,d)=>s+ps.daily[d].pl+ps.daily[d].fee,0);
    const tN = days.reduce((s,d)=>s+ps.daily[d].n,  0);
    dayRows.push(
      ['─'.repeat(12),'─'.repeat(6),'─'.repeat(16),'─'.repeat(14),'─'.repeat(14),'─'.repeat(14)],
      ['TOTAL', String(tN), '$'+n$(tV,0), '$'+n$(tP*scale,2), '$'+n$(tR*scale,2), '$'+n$(tW*scale,2)]
    );
    table(lines, [
      { h: 'Date',        w: 12 },
      { h: 'Fills',       w: 6,  a: 'r' },
      { h: 'Volume USD',  w: 16, a: 'r' },
      { h: 'PnL USD',     w: 14, a: 'r' },
      { h: 'Rebates USD', w: 14, a: 'r' },
      { h: 'Wallet USD',  w: 14, a: 'r' },
    ], dayRows);
  }

  L('');
  L(`  Index ref: ${currency}/USD = $${idx ? idx.toFixed(2) : 'n/a'}  at report time`);
  L('  ' + '═'.repeat(76));
  return lines;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const o = { pairIds: [24, 25], since: null, hours: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairIds='))
      o.pairIds = a.slice(10).split(',').map(x => parseInt(x, 10)).filter(Number.isFinite);
    else if (a.startsWith('--hours='))  o.hours = parseFloat(a.split('=')[1]);
    else if (a.startsWith('--since='))  o.since = a.split('=')[1];
  }
  if (!o.pairIds.length) o.pairIds = [24, 25];
  return o;
}

async function main() {
  const opts = parseArgs();
  await sequelize.authenticate();

  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const allLines = [
    '', '  ' + '═'.repeat(76),
    `  COMPLETE EXCHANGE REPORT  —  Generated ${new Date().toISOString()}`,
    `  Pairs: ${opts.pairIds.join(', ')}`,
    '  ' + '═'.repeat(76),
  ];

  for (const pairId of opts.pairIds) {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) { console.error(`Pair ${pairId} not found — skipping`); continue; }
    console.log(`\nBuilding pair ${pairId} (${pair.agentName}) ...`);
    const lines = await buildReport(pair, opts);
    allLines.push(...lines);
  }

  allLines.push('');
  const text = allLines.join('\n');

  const outDir  = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `exchange_complete_pairs${opts.pairIds.join('_')}_${ts}.txt`;
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, text, 'utf8');

  console.log(text);
  console.log('\nWrote', outPath);
  await sequelize.close();
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
