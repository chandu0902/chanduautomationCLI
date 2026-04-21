/**
 * BTC pair — master report: DB analytics, exchange reconcile (volumes, rebate, EX PnL),
 * live Deribit balances / session PnL, bot_session start/end balances, spread_level_history
 * (adaptive), and deltas vs the previous run (snapshot under reports/).
 *
 *   node scripts/report_btc_master_complete.js
 *   node scripts/report_btc_master_complete.js --pairIds=19
 *   node scripts/report_btc_master_complete.js --pairIds=15,16 --hours=168
 *   node scripts/report_btc_master_complete.js --pairIds=19 --since=2026-04-01T00:00:00.000Z
 *   node scripts/report_btc_master_complete.js --no-snapshot
 *
 * Output:
 *   Backend/reports/btc_master_pair_<id>_<ts>.txt
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const { sequelize, StatArbInput, Trade, BasisPosition, BotSessionLog, SpreadLevelHistory } = require('../src/models');
const {
  resolveStartMs,
  appendExchangeReconcile,
  appendDeribitAccountSummary,
} = require('../lib/btcDeribitReconcileSection');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

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
function stableJson(x) {
  return JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function snapshotPath(pairId, ccy = 'btc') {
  return path.join(REPORTS_DIR, `.${ccy}_master_snapshot_${pairId}.json`);
}

function readSnapshot(pairId, ccy = 'btc') {
  const p = snapshotPath(pairId, ccy);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeSnapshot(pairId, obj, ccy = 'btc') {
  const p = snapshotPath(pairId, ccy);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    'utf8'
  );
}

function pickConfig(pair) {
  return {
    spreadEntryLevels: pair.spreadEntryLevels,
    tpSpreadDelta: pair.tpSpreadDelta,
    slSpreadDelta: pair.slSpreadDelta,
    maxSpreadCap: pair.maxSpreadCap,
    zEntryThreshold: pair.zEntryThreshold,
    zEntryMax: pair.zEntryMax,
    maxPositions: pair.maxPositions,
    qty1: pair.qty1,
    maxQty1: pair.maxQty1,
    tradeLeg: pair.tradeLeg,
    symbol1: pair.symbol1,
    symbol2: pair.symbol2,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { pairIds: [19], since: null, hours: null, noSnapshot: false };
  for (const a of argv) {
    if (a.startsWith('--pairIds=')) {
      o.pairIds = a
        .slice('--pairIds='.length)
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } else if (a.startsWith('--since=')) o.since = a.slice('--since='.length);
    else if (a.startsWith('--hours=')) o.hours = parseFloat(a.split('=')[1]);
    else if (a === '--no-snapshot') o.noSnapshot = true;
  }
  if (!o.pairIds.length) o.pairIds = [19];
  return o;
}

async function appendDeltaSinceLastReport(log, pairId, oldSnap, nowConfig, newAdaptsSince) {
  log('');
  log('================================================================================');
  log('DELTA VS PRIOR REPORT (from snapshot file)');
  log('================================================================================');
  if (!oldSnap || !oldSnap.generatedAt) {
    log('  (no prior snapshot — first run after deploy, or snapshot cleared)');
    log(`  snapshot path: ${snapshotPath(pairId)}`);
    return;
  }
  log(`  prior snapshot generatedAt (UTC): ${oldSnap.generatedAt}`);
  log(`  prior report file: ${oldSnap.lastReportFile || '-'}`);
  log('');

  const prev = oldSnap.config || {};
  const cur = nowConfig;
  const keys = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  let any = false;
  for (const k of [...keys].sort()) {
    const a = stableJson(prev[k]);
    const b = stableJson(cur[k]);
    if (a !== b) {
      any = true;
      log(`  CONFIG CHANGE  ${k}:`);
      log(`    was: ${a}`);
      log(`    now: ${b}`);
    }
  }
  if (!any) log('  StatArbInput config keys: no changes vs snapshot.');
  log('');
  log(`  Adaptive rows (changedBy=adapt) since prior generatedAt: ${newAdaptsSince.length}`);
  if (newAdaptsSince.length) {
    const cap = Math.min(newAdaptsSince.length, 40);
    log(`  (showing last ${cap} of those, newest first)`);
    const slice = [...newAdaptsSince].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, cap);
    for (const r of slice) {
      const lv = Array.isArray(r.levels) ? r.levels.join(',') : stableJson(r.levels);
      log(
        `    id=${r.id} at=${r.createdAt} tp=${r.tpSpreadDelta} sl=${r.slSpreadDelta} cap=${r.maxSpreadCap} ` +
          `mean=${r.dollarMean != null ? fmt(r.dollarMean) : '-'} std=${r.dollarStd != null ? fmt(r.dollarStd) : '-'} ` +
          `levels=[${lv}] tpSlUpdated=${r.tpSlUpdated}`
      );
    }
  }
}

async function appendSpreadLevelSection(log, pairId) {
  const rows = await SpreadLevelHistory.findAll({
    where: { pairId },
    order: [['id', 'DESC']],
    limit: 500,
  });
  const by = {};
  for (const r of rows) {
    const k = r.changedBy || '(null)';
    by[k] = (by[k] || 0) + 1;
  }
  log('');
  log('================================================================================');
  log('SPREAD LEVEL HISTORY (recent 500 rows)');
  log('================================================================================');
  log(`  counts by changedBy: ${stableJson(by)}`);
  const adapts = rows.filter((r) => r.changedBy === 'adapt');
  log(`  adapt rows in sample: ${adapts.length}`);
  const show = adapts.slice(0, 20);
  log('  last 20 adapt rows (newest first):');
  for (const r of show) {
    const lv = Array.isArray(r.levels) ? r.levels.join(',') : stableJson(r.levels);
    log(
      `    id=${r.id} ${r.createdAt} tp=${r.tpSpreadDelta} sl=${r.slSpreadDelta} cap=${r.maxSpreadCap} ` +
        `openPos=${r.openPositions ?? '-'} levels=[${lv}]`
    );
  }
}

async function appendSessionBalances(log, pairId) {
  const sessions = await BotSessionLog.findAll({
    where: { pairId },
    order: [['enabledAt', 'DESC']],
    limit: 25,
  });
  const running = sessions.find((s) => !s.disabledAt);
  log('');
  log('================================================================================');
  log('BOT SESSION LOGS — balances & PnL (DB snapshots at enable/disable)');
  log('  (Exchange-implied session start equity / session PnL: see DERIBIT ACCOUNT SUMMARY.)');
  log('================================================================================');
  if (running) {
    log('  CURRENT SESSION (disabledAt null):');
    log(
      `    id=${running.id} enabledAt=${running.enabledAt} startBalance=${running.startBalance != null ? '$' + fmt(running.startBalance, 4) : '-'} ` +
        `(USD-style snapshot when session started, if recorded)`
    );
    log(`    sessionPnl (if closed fields set): ${running.sessionPnl != null ? '$' + fmt(running.sessionPnl, 4) : '-'}`);
  } else {
    log('  No open session row (disabledAt set on all recent rows).');
  }
  const lastClosed = sessions.find((s) => s.disabledAt);
  if (lastClosed) {
    log('  MOST RECENT CLOSED SESSION:');
    log(
      `    id=${lastClosed.id} enabledAt=${lastClosed.enabledAt} disabledAt=${lastClosed.disabledAt} ` +
        `startBalance=${lastClosed.startBalance != null ? '$' + fmt(lastClosed.startBalance, 4) : '-'} ` +
        `endBalance=${lastClosed.endBalance != null ? '$' + fmt(lastClosed.endBalance, 4) : '-'} ` +
        `sessionPnl=${lastClosed.sessionPnl != null ? '$' + fmt(lastClosed.sessionPnl, 4) : '-'} ` +
        `stopReason=${lastClosed.stopReason || '-'}`
    );
  }
  log('');
  log('  Last 25 sessions (newest first):');
  for (const s of sessions) {
    log(
      `    id=${s.id} en=${s.enabledAt} dis=${s.disabledAt || '(running)'} start=${
        s.startBalance != null ? fmt(s.startBalance, 2) : '-'
      } end=${s.endBalance != null ? fmt(s.endBalance, 2) : '-'} pnl=${s.sessionPnl != null ? fmt(s.sessionPnl, 2) : '-'} ` +
        `reason=${s.stopReason || '-'}`
    );
  }
}

async function buildReportForPair(pair, opts, outTs) {
  const pid = pair.id;
  const sym = (pair.symbol1 || pair.symbol2 || '').toUpperCase();
  const ccy = sym.includes('_USDC') ? 'usdc' : sym.startsWith('ETH') ? 'eth' : 'btc';
  const { startMs, label: windowLabel } = await resolveStartMs(pid, opts);
  const oldSnap = opts.noSnapshot ? null : readSnapshot(pid, ccy);

  const trades = await Trade.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });
  const bp = await BasisPosition.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });

  const sinceDate = oldSnap && oldSnap.generatedAt ? new Date(oldSnap.generatedAt) : null;
  let newAdaptsSince = [];
  if (sinceDate && !Number.isNaN(sinceDate.getTime())) {
    newAdaptsSince = await SpreadLevelHistory.findAll({
      where: {
        pairId: pid,
        changedBy: 'adapt',
        createdAt: { [Op.gt]: sinceDate },
      },
      order: [['id', 'ASC']],
    });
  }

  const lines = [];
  const log = (s) => lines.push(s);

  log('================================================================================');
  log(`${ccy.toUpperCase()} MASTER COMPLETE REPORT`);
  log(`Generated (UTC): ${new Date().toISOString()}`);
  log(`pairId: ${pid}  agentName: ${pair.agentName}`);
  log(`Reconcile window: ${windowLabel}`);
  log(`Reconcile startMs: ${new Date(startMs).toISOString()}`);
  log('================================================================================');

  const freshPair = await StatArbInput.findByPk(pid);
  const cfg = pickConfig(freshPair || pair);
  await appendDeltaSinceLastReport(log, pid, oldSnap, cfg, newAdaptsSince);

  log('');
  log('--------------------------------------------------------------------------------');
  log(`PAIR id=${pid} — StatArbInput`);
  log('--------------------------------------------------------------------------------');
  const p = freshPair || pair;
  log(`  agentName:        ${p.agentName}`);
  log(`  symbol1/symbol2:  ${p.symbol1} / ${p.symbol2}`);
  const execSym = p.tradeLeg === 'B' ? p.symbol2 : p.symbol1;
  log(`  tradeLeg:         ${p.tradeLeg} (executed: ${execSym})`);
  log(`  executorVersion:  ${p.executorVersion || '(v1 default)'}`);
  log(`  status:           ${p.status}  tradingEnabled: ${p.tradingEnabled}`);
  log(`  qty1 / maxQty1:   ${p.qty1} / ${p.maxQty1}`);
  log(`  spreadEntryLevels:${stableJson(p.spreadEntryLevels)}`);
  log(`  maxPositions:     ${p.maxPositions}`);
  log(`  tpSpreadDelta:    ${p.tpSpreadDelta}  slSpreadDelta: ${p.slSpreadDelta}`);
  log(`  zEntryThreshold:  ${p.zEntryThreshold}  zEntryMax: ${p.zEntryMax}`);
  log(`  maxSpreadCap:     ${p.maxSpreadCap}`);
  log(`  entryPollTimeoutMs: ${p.entryPollTimeoutMs}`);
  log(`  tradeAccountA/B:  ${p.tradeAccountA || '-'} / ${p.tradeAccountB || '-'}`);
  log('');

  await appendSessionBalances(log, pid);
  await appendSpreadLevelSection(log, pid);

  const byStatus = {};
  for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  log('');
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
  const closed = bp.filter((x) => x.state === 'closed');
  const openish = bp.filter((x) => ['open', 'pending_entry', 'pending_exit'].includes(x.state));
  const failed = bp.filter((x) => x.state === 'failed');
  log(`  Total rows: ${bp.length}`);
  log(`  Closed: ${closed.length} | Open/pending: ${openish.length} | Failed: ${failed.length}`);
  const byExit = {};
  for (const x of closed) {
    const r = x.exitReason || '(null)';
    byExit[r] = (byExit[r] || 0) + 1;
  }
  log('  Closed by exitReason:');
  for (const [r, n] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) log(`    ${r}: ${n}`);
  let sg = 0;
  let sn = 0;
  for (const x of closed) {
    sg += Number(x.grossPnl || 0);
    sn += Number(x.netPnl || 0);
  }
  log(`  Closed sum grossPnl: $${fmt(sg)}`);
  log(`  Closed sum netPnl:   $${fmt(sn)}`);
  const holds = closed.map((x) => x.holdMs).filter((x) => x != null && x > 0);
  if (holds.length) {
    log(
      `  Hold time closed (ms): median=${fmt(median(holds), 0)} mean=${fmt(mean(holds), 0)} min=${Math.min(...holds)} max=${Math.max(...holds)}`
    );
  }
  if (openish.length) {
    log('  Open / pending (detail):');
    for (const x of openish) {
      log(
        `    id=${x.id} state=${x.state} grid=${x.gridLevel} entrySpread=${x.entrySpread} dir=${x.direction || '-'} entryTime=${x.entryTime || '-'}`
      );
    }
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
  for (const x of bp) {
    log(
      `  id=${x.id} state=${x.state} grid=${x.gridLevel} netPnl=${x.netPnl != null ? fmt(x.netPnl) : '-'} gross=${x.grossPnl != null ? fmt(x.grossPnl) : '-'} exit=${x.exitReason || '-'} entryTime=${x.entryTime || '-'} exitTime=${x.exitTime || '-'}`
    );
  }
  log('');

  await appendDeribitAccountSummary(lines, p, { startMs, execSymbol: execSym });
  await appendExchangeReconcile(lines, p, startMs, windowLabel);

  log('');
  log('================================================================================');
  log('DEVIATIONS / CROSS-CHECK (read with reconcile block above)');
  log('================================================================================');
  log('  • DB netPnl vs EX net (USD): see "Delta (DB netPnl − EX net USD)" in reconcile.');
  log('  • DB exit notionals vs EX volume: same section.');
  log('  • Session startBalance in DB vs live equity: different units/timing — compare trends only.');
  log('');

  log('================================================================================');
  log('END OF REPORT');
  log('================================================================================');

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const outName = `${ccy}_master_pair_${pid}_${outTs}.txt`;
  const outPath = path.join(REPORTS_DIR, outName);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  if (!opts.noSnapshot) {
    const lastAdapt = await SpreadLevelHistory.findOne({
      where: { pairId: pid, changedBy: 'adapt' },
      order: [['id', 'DESC']],
    });
    writeSnapshot(pid, {
      generatedAt: new Date().toISOString(),
      pairId: pid,
      lastReportFile: outName,
      config: cfg,
      lastAdaptId: lastAdapt ? lastAdapt.id : null,
      lastAdaptAt: lastAdapt ? lastAdapt.createdAt : null,
    }, ccy);
  }

  return outPath;
}

async function main() {
  const opts = parseArgs();
  await sequelize.authenticate();
  const outTs = new Date().toISOString().replace(/[:.]/g, '-');

  const written = [];
  for (const pairId of opts.pairIds) {
    const pr = await StatArbInput.findByPk(pairId);
    if (!pr) {
      console.error(`Pair ${pairId} not found — skip`);
      continue;
    }
    const outPath = await buildReportForPair(pr, opts, outTs);
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
