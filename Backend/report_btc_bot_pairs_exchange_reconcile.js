/**
 * Complete trade report per BTC bot pair + Deribit exchange reconcile (same window).
 *
 *   node report_btc_bot_pairs_exchange_reconcile.js
 *   node report_btc_bot_pairs_exchange_reconcile.js --pairIds=15,16
 *   node report_btc_bot_pairs_exchange_reconcile.js --since=2026-04-01T00:00:00.000Z
 *   node report_btc_bot_pairs_exchange_reconcile.js --hours=168
 *
 * Writes one txt per pair:
 *   Backend/reports/btc_bot_pair_<id>_complete_trade_report_<ts>.txt
 *
 * Exchange reconcile implementation: lib/btcDeribitReconcileSection.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { sequelize, StatArbInput, Trade, BasisPosition, BotSessionLog } = require('./src/models');
const { resolveStartMs, appendExchangeReconcile } = require('./lib/btcDeribitReconcileSection');

function fmt(n, d = 6) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { pairIds: [15, 16], since: null, hours: null };
  for (const a of argv) {
    if (a.startsWith('--pairIds=')) {
      o.pairIds = a
        .slice('--pairIds='.length)
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } else if (a.startsWith('--since=')) o.since = a.slice('--since='.length);
    else if (a.startsWith('--hours=')) o.hours = parseFloat(a.split('=')[1]);
  }
  if (!o.pairIds.length) o.pairIds = [15, 16];
  return o;
}

async function buildReportForPair(pair, opts, outTs) {
  const pid = pair.id;
  const { startMs, label: windowLabel } = await resolveStartMs(pid, opts);

  const trades = await Trade.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });
  const bp = await BasisPosition.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });
  const sessions = await BotSessionLog.findAll({
    where: { pairId: pid },
    order: [['enabledAt', 'DESC']],
    limit: 20,
  });

  const lines = [];
  const log = (s) => lines.push(s);

  log('================================================================================');
  log('COMPLETE TRADE REPORT — single pair (DB: trade_logs + basis_positions + bot_session_logs)');
  log(`Generated (UTC): ${new Date().toISOString()}`);
  log(`pairId: ${pid}  agentName: ${pair.agentName}`);
  log(`Reconcile window: ${windowLabel}`);
  log(`Reconcile startMs: ${new Date(startMs).toISOString()}`);
  log('================================================================================');
  log('');

  log('--------------------------------------------------------------------------------');
  log(`PAIR id=${pid}`);
  log('--------------------------------------------------------------------------------');
  log(`  agentName:        ${pair.agentName}`);
  log(`  symbol1/symbol2:  ${pair.symbol1} / ${pair.symbol2}`);
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  log(`  tradeLeg:         ${pair.tradeLeg} (executed: ${execSym})`);
  log(`  executorVersion:  ${pair.executorVersion || '(v1 default)'}`);
  log(`  status:           ${pair.status}  tradingEnabled: ${pair.tradingEnabled}`);
  log(`  qty1 / maxQty1:   ${pair.qty1} / ${pair.maxQty1}`);
  log(`  spreadEntryLevels:${pair.spreadEntryLevels || '-'}`);
  log(`  maxPositions:     ${pair.maxPositions}`);
  log(`  tpSpreadDelta:    ${pair.tpSpreadDelta}  slSpreadDelta: ${pair.slSpreadDelta}`);
  log(`  zEntryThreshold:  ${pair.zEntryThreshold}  zEntryMax: ${pair.zEntryMax}`);
  log(`  maxSpreadCap:     ${pair.maxSpreadCap}`);
  log(`  entryPollTimeoutMs: ${pair.entryPollTimeoutMs}`);
  log('');

  const byStatus = {};
  for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  log('--- trade_logs ---');
  log(`  Total rows: ${trades.length}`);
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    log(`    status ${k}: ${v}`);
  }
  const filled = trades.filter((t) => t.status === 'filled');
  const cancelled = trades.filter((t) => t.status === 'cancelled');
  log(
    `  Filled: ${filled.length} | Cancelled: ${cancelled.length} | Open/other: ${trades.length - filled.length - cancelled.length}`
  );
  const cr = {};
  for (const t of cancelled) {
    const r = t.cancelReason || '(null)';
    cr[r] = (cr[r] || 0) + 1;
  }
  log('  Cancelled by cancelReason:');
  for (const [r, n] of Object.entries(cr).sort((a, b) => b[1] - a[1])) log(`    ${r}: ${n}`);
  let sumLeg = 0;
  let sumComm = 0;
  let sumTaker = 0;
  for (const t of filled) {
    sumLeg += (Number(t.legA_pnl) || 0) + (Number(t.legB_pnl) || 0);
    if (t.commission != null) sumComm += Number(t.commission);
    if (t.takerFeeUsd != null) sumTaker += Number(t.takerFeeUsd);
  }
  log(`  Filled — sum legA_pnl+legB_pnl: $${fmt(sumLeg)}`);
  log(`  Filled — sum commission: $${fmt(sumComm)}`);
  log(`  Filled — sum takerFeeUsd: $${fmt(sumTaker)}`);
  log(`  Filled — net (legs+comm-taker): $${fmt(sumLeg + sumComm - sumTaker)}`);
  const entries = filled.filter((t) => t.side === 'entry');
  const exits = filled.filter((t) => t.side === 'exit');
  log(`  Filled entries: ${entries.length} | Filled exits: ${exits.length}`);
  log('');

  log('--- basis_positions ---');
  const closed = bp.filter((p) => p.state === 'closed');
  const openish = bp.filter((p) => ['open', 'pending_entry', 'pending_exit'].includes(p.state));
  const failed = bp.filter((p) => p.state === 'failed');
  log(`  Total rows: ${bp.length}`);
  log(`  Closed: ${closed.length} | Open/pending: ${openish.length} | Failed: ${failed.length}`);
  const byExit = {};
  for (const p of closed) {
    const r = p.exitReason || '(null)';
    byExit[r] = (byExit[r] || 0) + 1;
  }
  log('  Closed by exitReason:');
  for (const [r, n] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) log(`    ${r}: ${n}`);
  let sg = 0;
  let sn = 0;
  for (const p of closed) {
    sg += Number(p.grossPnl || 0);
    sn += Number(p.netPnl || 0);
  }
  log(`  Closed sum grossPnl: $${fmt(sg)}`);
  log(`  Closed sum netPnl:   $${fmt(sn)}`);
  const holds = closed.map((p) => p.holdMs).filter((x) => x != null && x > 0);
  if (holds.length) {
    log(
      `  Hold time closed (ms): median=${fmt(median(holds), 0)} mean=${fmt(mean(holds), 0)} min=${Math.min(...holds)} max=${Math.max(...holds)}`
    );
  }
  const gridCount = {};
  for (const p of bp) {
    const g = p.gridLevel == null ? 'null' : String(p.gridLevel);
    gridCount[g] = (gridCount[g] || 0) + 1;
  }
  log('  By gridLevel (all states):');
  for (const [g, n] of Object.entries(gridCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    log(`    grid ${g}: ${n}`);
  }
  if (openish.length) {
    log('  Open / pending (detail):');
    for (const p of openish) {
      log(
        `    id=${p.id} state=${p.state} grid=${p.gridLevel} entrySpread=${p.entrySpread} dir=${p.direction || '-'} entryTime=${p.entryTime || '-'}`
      );
    }
  }
  log('');

  log('--- bot_session_logs (last 20) ---');
  if (sessions.length === 0) log('  (none)');
  for (const s of sessions) {
    log(
      `  id=${s.id} enabledAt=${s.enabledAt} disabledAt=${s.disabledAt || '(running)'} stopReason=${s.stopReason || '-'} sessionPnl=${s.sessionPnl != null ? fmt(s.sessionPnl) : '-'} uptimeMs=${s.uptimeMs || '-'}`
    );
  }
  log('');

  log('--- Last 25 trade_logs (newest first) ---');
  const recent = await Trade.findAll({
    where: { pairId: pid },
    order: [['id', 'DESC']],
    limit: 25,
  });
  for (const t of recent) {
    log(
      `  id=${t.id} ${t.side} status=${t.status} ${t.legA_symbol} ${t.legA_side} qty=${t.legA_qty} px=${t.legA_price} pnl=${t.pnl != null ? fmt(t.pnl) : '-'} cancel=${t.cancelReason || '-'}`
    );
  }
  log('');

  log('--- All trade_logs (chronological, id order) — full list ---');
  for (const t of trades) {
    const la = t.legA_filledAt ? new Date(t.legA_filledAt).toISOString() : '-';
    log(
      `  id=${t.id} ${t.side} status=${t.status} ${t.legA_symbol} ${t.legA_side} qty=${t.legA_qty} px=${t.legA_price} legA_filledAt=${la} pnl=${t.pnl != null ? fmt(t.pnl) : '-'} cancel=${t.cancelReason || '-'}`
    );
  }
  log('');

  log('--- All basis_positions (chronological, id order) — summary ---');
  for (const p of bp) {
    log(
      `  id=${p.id} state=${p.state} grid=${p.gridLevel} netPnl=${p.netPnl != null ? fmt(p.netPnl) : '-'} gross=${p.grossPnl != null ? fmt(p.grossPnl) : '-'} exit=${p.exitReason || '-'} entryTime=${p.entryTime || '-'} exitTime=${p.exitTime || '-'}`
    );
  }
  log('');

  await appendExchangeReconcile(lines, pair, startMs, windowLabel);

  log('');
  log('================================================================================');
  log('END OF REPORT');
  log('================================================================================');

  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `btc_bot_pair_${pid}_complete_trade_report_${outTs}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

async function main() {
  const opts = parseArgs();
  await sequelize.authenticate();
  const outTs = new Date().toISOString().replace(/[:.]/g, '-');

  const written = [];
  for (const pairId of opts.pairIds) {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) {
      console.error(`Pair ${pairId} not found — skip`);
      continue;
    }
    const outPath = await buildReportForPair(pair, opts, outTs);
    written.push(outPath);
    console.log('Wrote', outPath);
  }

  await sequelize.close();
  if (!written.length) {
    console.error('No reports written.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
