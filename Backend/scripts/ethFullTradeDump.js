#!/usr/bin/env node
/**
 * ETH full trade dump — every single exchange fill + every DB round-trip.
 *
 *   node scripts/ethFullTradeDump.js
 *   node scripts/ethFullTradeDump.js --pairId=22
 *
 * Pulls LIVE from Deribit and joins with DB basis_positions.
 * Writes: Backend/reports/eth_full_trade_dump_pair<N>_<ts>.txt
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const {
  sequelize, StatArbInput, AccountDetails,
  SpreadLevelHistory, BasisPosition, Trade,
} = require('../src/models');
const { currencyFromSymbol } = require('../lib/btcDeribitReconcileSection');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const LEGACY_BOT_START_MS = Date.UTC(2026, 3, 15, 14, 35, 0, 0);

function decryptText(k, enc, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return dc.update(enc, 'base64', 'utf8') + dc.final('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: {
      grant_type: 'client_credentials', client_id: apiKey,
      client_secret: secret, scope: 'trade:read_write',
    },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}

async function dRpc(token, method, params = {}) {
  for (let i = 0; i < 8; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/private/${method}`,
      { jsonrpc: '2.0', id: 1, method: `private/${method}`, params },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true });
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(5000 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${method} HTTP ${r.status}`);
    if (e) throw new Error(e.message);
    return r.data.result;
  }
  throw new Error(`${method}: too many retries`);
}

async function fetchAllTrades(token, currency, startMs) {
  const all = []; let cur = startMs;
  for (let p = 0; p < 200; p++) {
    await sleep(700);
    const res = await dRpc(token, 'get_user_trades_by_currency_and_time', {
      currency, start_timestamp: cur, end_timestamp: Date.now(),
      count: 1000, sorting: 'asc',
    });
    const t = res.trades || [];
    if (!t.length) break;
    all.push(...t);
    if (!res.has_more) break;
    cur = t[t.length - 1].timestamp + 1;
  }
  return all;
}

function fmtTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function fmtUsd(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(d);
}
function fmt(n, d = 8) {
  return n == null || !Number.isFinite(n) ? '-' : Number(n).toFixed(d);
}
function durStr(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function main() {
  let pairId = 22;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairId=')) pairId = parseInt(a.split('=')[1], 10) || 22;
  }

  await sequelize.authenticate();

  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) { console.error('pair not found'); process.exit(1); }
  const botStartMs = pair.botStartedAt
    ? new Date(pair.botStartedAt).getTime()
    : LEGACY_BOT_START_MS;
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const token = await getToken(decryptText(ak2, ak1, ak0), decryptText(sk2, sk1, sk0));
  await sleep(1200);

  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price',
    { params: { index_name: `${currency.toLowerCase()}_usd` } }).catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;
  const toUsd = (eth) => idx > 0 && Number.isFinite(Number(eth)) ? Number(eth) * idx : null;

  console.error(`Fetching fills from Deribit since ${new Date(botStartMs).toISOString()}...`);
  const allFills = await fetchAllTrades(token, currency, botStartMs);
  const execFills = allFills.filter((t) => t.instrument_name === execSym);
  console.error(`Got ${execFills.length} fills on ${execSym}.`);

  const bp = await BasisPosition.findAll({
    where: { pairId }, order: [['id', 'ASC']],
  });
  const trades = await Trade.findAll({
    where: { pairId }, order: [['id', 'ASC']],
  });
  const adapts = await SpreadLevelHistory.findAll({
    where: { pairId, changedBy: 'adapt' }, order: [['id', 'ASC']],
  });

  const lines = [];
  const L = (s) => lines.push(s);

  L('╔══════════════════════════════════════════════════════════════════════════════╗');
  L('║  ETH BOT — FULL TRADE DUMP (EVERY FILL + EVERY ROUND-TRIP)                  ║');
  L(`║  Agent:    ${pair.agentName}`);
  L(`║  pairId:   ${pairId}      Account: ${acctName}      Instrument: ${execSym}`);
  L(`║  Generated (UTC): ${new Date().toISOString()}`);
  L(`║  Window:   ${new Date(botStartMs).toISOString()}  →  ${new Date().toISOString()}`);
  L(`║  ETH idx:  ${fmtUsd(idx)}`);
  L('╚══════════════════════════════════════════════════════════════════════════════╝');
  L('');

  L('================================================================================');
  L('TABLE OF CONTENTS');
  L('================================================================================');
  L('  SECTION 1 — EVERY EXCHANGE FILL (chronological)');
  L('  SECTION 2 — EVERY CLOSED ROUND-TRIP (DB basis_positions)');
  L('  SECTION 3 — OPEN / PENDING / FAILED ROUND-TRIPS');
  L('  SECTION 4 — EVERY ADAPT EVENT (sheet adaptations)');
  L('  SECTION 5 — EVERY TRADE LOG ROW (DB trade_logs)');
  L('  SECTION 6 — AGGREGATE TOTALS');
  L('');

  L('════════════════════════════════════════════════════════════════════════════════');
  L(`SECTION 1 — EVERY EXCHANGE FILL  (${execFills.length} fills)`);
  L('════════════════════════════════════════════════════════════════════════════════');
  L('  Each row is one fill on ' + execSym + '.');
  L('  Columns: # | time (UTC) | side | amount USD | px | PnL ETH | PnL USD | fee ETH | fee USD | liquidity | trade_id');
  L('');
  L('  +------+---------------------+------+---------------+---------+---------------+---------------+---------------+---------------+--------+--------------+');
  L('  |   #  | time                | side |   amount USD  |    px   |    PnL ETH    |    PnL USD    |    fee ETH    |    fee USD    | liq    | trade_id     |');
  L('  +------+---------------------+------+---------------+---------+---------------+---------------+---------------+---------------+--------+--------------+');
  let i = 0;
  let sumPl = 0, sumFee = 0, sumVol = 0, sumPlUsd = 0, sumFeeUsd = 0;
  for (const t of execFills) {
    i++;
    const amtUsd = Math.abs(Number(t.amount) || 0);
    const pl = Number(t.profit_loss) || 0;
    const fee = Number(t.fee) || 0;
    const plUsd = toUsd(pl) || 0;
    const feeUsd = toUsd(fee) || 0;
    sumPl += pl; sumFee += fee; sumVol += amtUsd;
    sumPlUsd += plUsd; sumFeeUsd += feeUsd;
    const liq = t.liquidity || '-';
    L(
      `  | ${String(i).padStart(4, ' ')} | ${fmtTs(t.timestamp).padEnd(19, ' ')} | ` +
      `${String(t.direction || '-').padEnd(4, ' ')} | ${fmtUsd(amtUsd, 0).padStart(13, ' ')} | ` +
      `${String(Number(t.price).toFixed(2)).padStart(7, ' ')} | ` +
      `${fmt(pl, 8).padStart(13, ' ')} | ${fmtUsd(plUsd, 4).padStart(13, ' ')} | ` +
      `${fmt(fee, 8).padStart(13, ' ')} | ${fmtUsd(feeUsd, 4).padStart(13, ' ')} | ` +
      `${String(liq).padEnd(6, ' ')} | ${String(t.trade_id || '-').padEnd(12, ' ')} |`
    );
  }
  L('  +------+---------------------+------+---------------+---------+---------------+---------------+---------------+---------------+--------+--------------+');
  L(`  TOTAL  volume=${fmtUsd(sumVol, 2)}  Σpl=${fmt(sumPl, 8)} ETH (${fmtUsd(sumPlUsd, 2)})  Σfee=${fmt(sumFee, 8)} ETH (${fmtUsd(sumFeeUsd, 2)})`);
  L(`  [negative fee = maker rebate earned; positive fee = taker fee paid]`);
  L('');

  // Closed round-trips (basis positions)
  const closed = bp.filter((x) => x.state === 'closed');
  L('════════════════════════════════════════════════════════════════════════════════');
  L(`SECTION 2 — EVERY CLOSED ROUND-TRIP  (${closed.length} positions)`);
  L('════════════════════════════════════════════════════════════════════════════════');
  L('  Columns: id | grid | dir | entry $ | exit $ | Δ spread | netPnl | grossPnl | commission | hold | entryTime → exitTime | exit reason');
  L('');
  L('  +------+------+-----+---------+---------+---------+-----------+-----------+------------+-----------------+-------------------------+-------------------------+------------+');
  L('  |  id  | grid | dir | entry $ | exit $  |  Δsprd  |  netPnl   | grossPnl  | commission | hold            | entryTime (UTC)         | exitTime (UTC)          | exit       |');
  L('  +------+------+-----+---------+---------+---------+-----------+-----------+------------+-----------------+-------------------------+-------------------------+------------+');
  let sumNet = 0, sumGross = 0, sumComm = 0, prof = 0, stop = 0;
  for (const x of closed) {
    const net = Number(x.netPnl || 0);
    const gross = Number(x.grossPnl || 0);
    const comm = Number(x.commission || 0);
    sumNet += net; sumGross += gross; sumComm += comm;
    if (x.exitReason === 'profit') prof++;
    else if (x.exitReason === 'stop') stop++;
    const delta = (Number(x.exitSpread || 0) - Number(x.entrySpread || 0));
    L(
      `  | ${String(x.id).padStart(4, ' ')} | ${String(x.gridLevel || '-').padStart(4, ' ')} | ` +
      `${String(x.direction || '-').padEnd(3, ' ')} | ${fmtUsd(Number(x.entrySpread || 0)).padStart(7, ' ')} | ` +
      `${fmtUsd(Number(x.exitSpread || 0)).padStart(7, ' ')} | ${(delta >= 0 ? '+' : '') + delta.toFixed(2)} | ` +
      `${fmtUsd(net).padStart(9, ' ')} | ${fmtUsd(gross).padStart(9, ' ')} | ` +
      `${fmtUsd(comm).padStart(10, ' ')} | ${durStr(x.holdMs).padEnd(15, ' ')} | ` +
      `${(x.entryTime ? fmtTs(new Date(x.entryTime).getTime()) : '-').padEnd(23, ' ')} | ` +
      `${(x.exitTime ? fmtTs(new Date(x.exitTime).getTime()) : '-').padEnd(23, ' ')} | ` +
      `${String(x.exitReason || '-').padEnd(10, ' ')} |`
    );
  }
  L('  +------+------+-----+---------+---------+---------+-----------+-----------+------------+-----------------+-------------------------+-------------------------+------------+');
  L(`  TOTAL closed: ${closed.length}   profit: ${prof}   stop: ${stop}   win rate: ${closed.length ? ((prof / closed.length) * 100).toFixed(2) : '-'}%`);
  L(`  Σ netPnl=${fmtUsd(sumNet)}   Σ grossPnl=${fmtUsd(sumGross)}   Σ commission(rebate)=${fmtUsd(sumComm)}`);
  L('');

  // Open / pending / failed
  const openish = bp.filter((x) => ['open', 'pending_entry', 'pending_exit'].includes(x.state));
  const failed = bp.filter((x) => x.state === 'failed');
  L('════════════════════════════════════════════════════════════════════════════════');
  L(`SECTION 3 — OPEN / PENDING / FAILED ROUND-TRIPS  (open: ${openish.length} · failed: ${failed.length})`);
  L('════════════════════════════════════════════════════════════════════════════════');
  L(`  3A. Currently OPEN / PENDING (${openish.length})`);
  for (const x of openish) {
    const held = x.entryTime ? Date.now() - new Date(x.entryTime).getTime() : 0;
    L(`    id=${x.id} state=${x.state} grid=${x.gridLevel} dir=${x.direction || '-'} ` +
      `entrySpread=${fmtUsd(Number(x.entrySpread || 0))} entryTime=${x.entryTime ? fmtTs(new Date(x.entryTime).getTime()) : '-'} ` +
      `hold=${durStr(held)}`);
  }
  L('');
  L(`  3B. FAILED (${failed.length}, showing all)`);
  for (const x of failed) {
    L(`    id=${x.id} grid=${x.gridLevel} dir=${x.direction || '-'} ` +
      `entrySpread=${fmtUsd(Number(x.entrySpread || 0))} ` +
      `entryTime=${x.entryTime ? fmtTs(new Date(x.entryTime).getTime()) : '-'} ` +
      `exitTime=${x.exitTime ? fmtTs(new Date(x.exitTime).getTime()) : '-'} ` +
      `reason=${x.exitReason || '-'}`);
  }
  L('');

  // Adapts
  L('════════════════════════════════════════════════════════════════════════════════');
  L(`SECTION 4 — EVERY ADAPT EVENT  (${adapts.length} sheet adaptations)`);
  L('════════════════════════════════════════════════════════════════════════════════');
  L('  Columns: id | time UTC | grid range | mean | std | open | tp / sl / cap | levels | tpSlUpdated');
  L('');
  for (const r of adapts) {
    const lv = Array.isArray(r.levels) ? r.levels.map((x) => Number(x).toFixed(4)).join(',') : '-';
    L(`  id=${r.id} ${fmtTs(new Date(r.createdAt).getTime())} ` +
      `grid=[${fmtUsd(Number(r.levels?.[0] || 0))} – ${fmtUsd(Number(r.levels?.[r.levels.length - 1] || 0))}] ` +
      `mean=${fmtUsd(Number(r.dollarMean || 0))} std=${fmtUsd(Number(r.dollarStd || 0))} ` +
      `open=${r.openPositions ?? '-'} ` +
      `tp=${fmt(Number(r.tpSpreadDelta), 4)} sl=${fmt(Number(r.slSpreadDelta), 4)} cap=${fmt(Number(r.maxSpreadCap), 4)} ` +
      `tpSlUpdated=${r.tpSlUpdated ? 'YES' : 'NO'}`);
    L(`     levels=[${lv}]`);
  }
  L('');

  // Trade logs
  L('════════════════════════════════════════════════════════════════════════════════');
  L(`SECTION 5 — EVERY TRADE LOG ROW  (${trades.length} rows)`);
  L('════════════════════════════════════════════════════════════════════════════════');
  const byStatus = {};
  for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  L(`  status counts: ${JSON.stringify(byStatus)}`);
  L('');
  L('  Columns: id | side | status | symbol | legA side | qty | price | filledAt | PnL | cancelReason');
  L('');
  for (const t of trades) {
    const la = t.legA_filledAt ? fmtTs(new Date(t.legA_filledAt).getTime()) : '-';
    L(`  id=${t.id} ${t.side} status=${t.status} ${t.legA_symbol || '-'} ${t.legA_side || '-'} ` +
      `qty=${t.legA_qty} px=${t.legA_price} filledAt=${la} ` +
      `pnl=${t.pnl != null ? fmtUsd(Number(t.pnl)) : '-'} ` +
      `cancel=${t.cancelReason || '-'}`);
  }
  L('');

  // Aggregates
  L('════════════════════════════════════════════════════════════════════════════════');
  L('SECTION 6 — AGGREGATE TOTALS (live)');
  L('════════════════════════════════════════════════════════════════════════════════');
  const summary = await dRpc(token, 'get_account_summary', { currency, extended: true });
  const profitFills = execFills.filter((t) => Number(t.profit_loss) > 0);
  const lossFills = execFills.filter((t) => Number(t.profit_loss) < 0);
  const openFills = execFills.filter((t) => Number(t.profit_loss) === 0);
  const sumWinPl = profitFills.reduce((s, t) => s + Number(t.profit_loss || 0), 0);
  const sumLossPl = lossFills.reduce((s, t) => s + Number(t.profit_loss || 0), 0);
  const rebates = execFills.filter((t) => Number(t.fee) < 0).reduce((s, t) => s + Math.abs(Number(t.fee || 0)), 0);
  const takerFees = execFills.filter((t) => Number(t.fee) > 0).reduce((s, t) => s + Number(t.fee || 0), 0);

  L(`  Equity:                  ${fmtUsd(Number(summary.equity) * idx, 2)}    (${fmt(Number(summary.equity))} ETH)`);
  L(`  Wallet balance:          ${fmtUsd(Number(summary.balance) * idx, 2)}    (${fmt(Number(summary.balance))} ETH)`);
  L(`  Session UPL:             ${fmtUsd(Number(summary.session_upl) * idx, 2)}`);
  L(`  Session RPL:             ${fmtUsd(Number(summary.session_rpl) * idx, 2)}`);
  L('');
  L(`  Total fills:             ${execFills.length}`);
  L(`  Profit exits:            ${profitFills.length}`);
  L(`  Loss exits:              ${lossFills.length}`);
  L(`  Open (pl=0) fills:       ${openFills.length}`);
  L(`  Win rate (fills):        ${((profitFills.length / (profitFills.length + lossFills.length)) * 100).toFixed(2)}%`);
  L('');
  L(`  Σ wins (price PnL):      ${fmt(sumWinPl, 8)} ETH    ${fmtUsd(sumWinPl * idx, 2)}`);
  L(`  Σ losses (price PnL):    ${fmt(sumLossPl, 8)} ETH    ${fmtUsd(sumLossPl * idx, 2)}`);
  L(`  Net realized:            ${fmt(sumWinPl + sumLossPl, 8)} ETH    ${fmtUsd((sumWinPl + sumLossPl) * idx, 2)}`);
  L('');
  L(`  Avg win per fill:        ${fmt(sumWinPl / Math.max(1, profitFills.length), 8)} ETH    ${fmtUsd((sumWinPl / Math.max(1, profitFills.length)) * idx, 4)}`);
  L(`  Avg loss per fill:       ${fmt(sumLossPl / Math.max(1, lossFills.length), 8)} ETH    ${fmtUsd((sumLossPl / Math.max(1, lossFills.length)) * idx, 4)}`);
  L('');
  L(`  Maker rebates earned:    ${fmt(rebates, 8)} ETH    ${fmtUsd(rebates * idx, 2)}`);
  L(`  Taker fees paid:         ${fmt(takerFees, 8)} ETH    ${fmtUsd(takerFees * idx, 2)}`);
  L(`  Total volume Σ|amount|:  ${fmtUsd(sumVol, 2)}`);
  L('');
  L(`  Round-trips closed:      ${closed.length}  (profit: ${prof} · stop: ${stop})`);
  L(`  Round-trips open:        ${openish.length}`);
  L(`  Round-trips failed:      ${failed.length}`);
  L(`  Win rate (round-trip):   ${closed.length ? ((prof / closed.length) * 100).toFixed(2) : '-'}%`);
  L(`  Σ netPnl (round-trip):   ${fmtUsd(sumNet)}`);
  L('');
  L(`  Sheet adaptations:       ${adapts.length}`);
  L('');

  L('================================================================================');
  L('END OF REPORT');
  L('================================================================================');

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outName = `eth_full_trade_dump_pair${pairId}_${ts}.txt`;
  const outPath = path.join(REPORTS_DIR, outName);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.error('Wrote', outPath);

  await sequelize.close();
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
