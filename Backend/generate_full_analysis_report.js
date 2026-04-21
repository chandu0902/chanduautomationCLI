/**
 * Full quantitative + narrative analysis report (TXT) for spread / stat-arb bots.
 *
 *   node generate_full_analysis_report.js
 *   node generate_full_analysis_report.js --active-only
 *   node generate_full_analysis_report.js --pairIds=3,4
 *
 * Writes: Backend/reports/full_analysis_<timestamp>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Op } = require('sequelize');
const { StatArbInput, Trade, BasisPosition, BotSessionLog, sequelize } = require('./src/models');

const SPREAD_LOG_DIR = path.join(__dirname, 'logs', 'spread');

function fmt(n, d = 6) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}

function median(sortedOrArr) {
  const a = Array.isArray(sortedOrArr) ? [...sortedOrArr].sort((x, y) => x - y) : sortedOrArr;
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stdSample(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function parseLevels(str) {
  return String(str || '')
    .split(',')
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
}

/**
 * Stream a JSONL spread file and aggregate regime / z / spread stats.
 */
/** Online stats to avoid huge arrays (stack overflow on spread). */
function createOnlineStats() {
  return {
    n: 0,
    min: Infinity,
    max: -Infinity,
    sum: 0,
    sumSq: 0,
    // for |x| stats on deviation
    sumAbs: 0,
  };
}

function onlinePush(st, x) {
  if (!Number.isFinite(x)) return;
  st.n++;
  st.sum += x;
  st.sumSq += x * x;
  st.sumAbs += Math.abs(x);
  if (x < st.min) st.min = x;
  if (x > st.max) st.max = x;
}

function onlineMean(st) {
  return st.n ? st.sum / st.n : null;
}

function onlineStd(st) {
  if (st.n < 2) return null;
  const m = st.sum / st.n;
  const v = st.sumSq / st.n - m * m;
  return Math.sqrt(Math.max(0, v));
}

/** Reservoir sample for approximate median on huge streams (max k items). */
function reservoirCreate(k) {
  return { k, buf: [], seen: 0 };
}

function reservoirPush(r, x) {
  if (!Number.isFinite(x)) return;
  r.seen++;
  if (r.buf.length < r.k) {
    r.buf.push(x);
    return;
  }
  const j = Math.floor(Math.random() * r.seen);
  if (j < r.k) r.buf[j] = x;
}

async function aggregateSpreadFile(filePath, acc) {
  if (!fs.existsSync(filePath)) return;
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    acc.lines++;
    if (e.spread != null && Number.isFinite(e.spread)) {
      const sp = Number(e.spread);
      onlinePush(acc.spreadStat, sp);
    }
    if (e.mean != null && e.spread != null && Number.isFinite(e.mean) && Number.isFinite(e.spread)) {
      onlinePush(acc.devStat, Number(e.spread) - Number(e.mean));
    }
    if (e.zScore != null && Number.isFinite(e.zScore)) onlinePush(acc.zStat, Number(e.zScore));
    if (e.velocity != null && Number.isFinite(e.velocity)) onlinePush(acc.velStat, Number(e.velocity));
    if (e.regimeScore != null && Number.isFinite(e.regimeScore)) {
      const rs = Number(e.regimeScore);
      onlinePush(acc.regimeStat, rs);
      reservoirPush(acc.regimeReservoir, rs);
      if (rs < 0.5) acc.meanRevertingTicks++;
      else acc.trendingTicks++;
    } else {
      acc.unknownRegime++;
    }
    if (e.zScore != null && Number.isFinite(e.zScore)) reservoirPush(acc.zReservoir, Number(e.zScore));
  }
}

async function aggregateAllSpreadLogsForPairs(pairIds) {
  const sides = ['sell', 'buy', 'mid'];
  const acc = {
    lines: 0,
    spreadStat: createOnlineStats(),
    devStat: createOnlineStats(),
    zStat: createOnlineStats(),
    velStat: createOnlineStats(),
    regimeStat: createOnlineStats(),
    regimeReservoir: reservoirCreate(25000),
    zReservoir: reservoirCreate(25000),
    meanRevertingTicks: 0,
    trendingTicks: 0,
    unknownRegime: 0,
    filesRead: 0,
    filesMissing: 0,
  };

  for (const pid of pairIds) {
    for (const side of sides) {
      const fp = path.join(SPREAD_LOG_DIR, `pair_${pid}_${side}.jsonl`);
      const existed = fs.existsSync(fp);
      const before = acc.lines;
      await aggregateSpreadFile(fp, acc);
      if (acc.lines === before && !existed) acc.filesMissing++;
      else acc.filesRead++;
    }
  }
  return acc;
}

function ratioRangeDeviation(closedBps) {
  /** |exitSpread/entrySpread - 1| when both non-zero; else skip */
  const ratios = [];
  const devs = [];
  for (const bp of closedBps) {
    const es = Number(bp.entrySpread);
    const xs = Number(bp.exitSpread);
    if (!Number.isFinite(es) || !Number.isFinite(xs) || Math.abs(es) < 1e-9) continue;
    const r = xs / es;
    ratios.push(r);
    devs.push(Math.abs(r - 1));
  }
  return {
    count: devs.length,
    ratios,
    devs,
    minDev: devs.length ? Math.min(...devs) : null,
    maxDev: devs.length ? Math.max(...devs) : null,
    rangeDev: devs.length ? Math.max(...devs) - Math.min(...devs) : null,
    medianDev: median(devs),
    meanDev: mean(devs),
    medianRatio: median(ratios),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const activeOnly = argv.includes('--active-only');
  let pairIdsFilter = null;
  const pidArg = argv.find((a) => a.startsWith('--pairIds='));
  if (pidArg) {
    pairIdsFilter = pidArg
      .split('=')[1]
      .split(',')
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n));
  }

  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };

  await sequelize.authenticate();

  const wherePair = {};
  if (activeOnly) wherePair.status = 'active';
  let pairs = await StatArbInput.findAll({ where: wherePair, order: [['id', 'ASC']] });
  if (pairIdsFilter && pairIdsFilter.length) {
    pairs = pairs.filter((p) => pairIdsFilter.includes(p.id));
  }
  const pairIds = pairs.map((p) => p.id);
  if (pairIds.length === 0) {
    log('No pairs in scope.');
    process.exit(0);
  }

  const trades = await Trade.findAll({
    where: { pairId: { [Op.in]: pairIds } },
    order: [['id', 'ASC']],
  });
  const positions = await BasisPosition.findAll({
    where: { pairId: { [Op.in]: pairIds } },
  });
  const sessions = await BotSessionLog.findAll({
    where: { pairId: { [Op.in]: pairIds } },
    order: [['enabledAt', 'ASC']],
  });

  const closedBp = positions.filter((p) => p.state === 'closed');
  const openBp = positions.filter((p) => ['open', 'pending_entry', 'pending_exit'].includes(p.state));
  const failedBp = positions.filter((p) => p.state === 'failed');

  function holdMsFor(bp) {
    if (bp.holdMs != null && Number.isFinite(bp.holdMs) && bp.holdMs > 0) return Number(bp.holdMs);
    if (bp.entryTime && bp.exitTime) {
      const ms = new Date(bp.exitTime).getTime() - new Date(bp.entryTime).getTime();
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    return null;
  }
  const holdMsList = closedBp.map(holdMsFor).filter((x) => x != null);
  const spreadChangeList = closedBp.map((p) => p.spreadChange).filter((x) => x != null && Number.isFinite(x));

  const entryZFromTrade = trades
    .filter((t) => t.side === 'entry' && t.zScoreAtEntry != null && Number.isFinite(t.zScoreAtEntry))
    .map((t) => Number(t.zScoreAtEntry));
  const entryZFromBp = closedBp
    .filter((p) => p.entryZScore != null && Number.isFinite(p.entryZScore))
    .map((p) => Number(p.entryZScore));

  const cancelByReason = {};
  for (const t of trades) {
    if (t.status !== 'cancelled') continue;
    const r = t.cancelReason || '(null)';
    cancelByReason[r] = (cancelByReason[r] || 0) + 1;
  }

  const statusCount = {};
  for (const t of trades) {
    statusCount[t.status] = (statusCount[t.status] || 0) + 1;
  }

  const exitReasonCount = {};
  for (const bp of closedBp) {
    const r = bp.exitReason || '(null)';
    exitReasonCount[r] = (exitReasonCount[r] || 0) + 1;
  }

  const gridLevelCount = {};
  for (const bp of positions) {
    const g = bp.gridLevel;
    const key = g == null ? '(null)' : String(g);
    gridLevelCount[key] = (gridLevelCount[key] || 0) + 1;
  }

  const rr = ratioRangeDeviation(closedBp);

  log(`Generated: ${new Date().toISOString()}`);
  log('');
  log('================================================================================');
  log('  FULL ANALYSIS REPORT — spread bots / stat-arb (DB + spread JSONL)');
  log('================================================================================');
  log('');
  log(`Scope: ${activeOnly ? 'status=active pairs only' : 'all pairs matching filter'}`);
  log(`Pair IDs: ${pairIds.join(', ')} (${pairs.length} pairs)`);
  log('');

  log('=== 1. TRADE LOGS (trade_logs) ===');
  log(`  Total trade rows: ${trades.length}`);
  for (const [k, v] of Object.entries(statusCount).sort((a, b) => b[1] - a[1])) {
    log(`    status=${k}: ${v}`);
  }
  log(`  Filled: ${statusCount.filled || 0} | Cancelled: ${statusCount.cancelled || 0} | Other: ${trades.length - (statusCount.filled || 0) - (statusCount.cancelled || 0)}`);
  log('  Cancelled by cancelReason:');
  for (const [r, n] of Object.entries(cancelByReason).sort((a, b) => b[1] - a[1])) {
    log(`    ${r}: ${n}`);
  }
  const staleHints = ['entry_timeout', 'timeout', 'unfilled', 'missing', 'cleanup', 'reject'];
  let staleish = 0;
  for (const [r, n] of Object.entries(cancelByReason)) {
    if (staleHints.some((h) => r.toLowerCase().includes(h))) staleish += n;
  }
  log(`  "Stale / timeout-ish" cancelled (heuristic: reason contains ${staleHints.join(', ')}): ${staleish}`);
  log('');

  log('=== 2. BASIS POSITIONS (basis_positions) ===');
  log(`  Total rows: ${positions.length}`);
  log(`  Closed: ${closedBp.length} | Open/pending: ${openBp.length} | Failed: ${failedBp.length}`);
  log('  By gridLevel (all states):');
  for (const [g, n] of Object.entries(gridLevelCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    log(`    grid ${g}: ${n}`);
  }
  log('  Closed exitReason:');
  for (const [r, n] of Object.entries(exitReasonCount).sort((a, b) => b[1] - a[1])) {
    log(`    ${r}: ${n}`);
  }
  log(`  Closed sum grossPnl: $${fmt(closedBp.reduce((s, p) => s + Number(p.grossPnl || 0), 0))}`);
  log(`  Closed sum netPnl:   $${fmt(closedBp.reduce((s, p) => s + Number(p.netPnl || 0), 0))}`);
  log('');

  log('=== 3. HOLD TIME (closed roundtrips, holdMs) ===');
  log(`  Count with holdMs: ${holdMsList.length}`);
  log(`  Average hold (ms): ${holdMsList.length ? fmt(mean(holdMsList), 0) : '-'}`);
  log(`  Average hold (min): ${holdMsList.length ? fmt(mean(holdMsList) / 60000, 2) : '-'}`);
  log(`  Median hold (ms): ${holdMsList.length ? fmt(median(holdMsList), 0) : '-'}`);
  log(`  Median hold (min): ${holdMsList.length ? fmt(median(holdMsList) / 60000, 2) : '-'}`);
  log(`  Min / Max hold (min): ${holdMsList.length ? fmt(Math.min(...holdMsList) / 60000, 2) : '-'} / ${holdMsList.length ? fmt(Math.max(...holdMsList) / 60000, 2) : '-'}`);
  log('');

  log('=== 4. SPREAD CHANGE (closed: exitSpread - entrySpread, basis field spreadChange) ===');
  log(`  Count: ${spreadChangeList.length}`);
  log(`  Mean: ${spreadChangeList.length ? fmt(mean(spreadChangeList)) : '-'}`);
  log(`  Median: ${spreadChangeList.length ? fmt(median(spreadChangeList)) : '-'}`);
  log(`  Std (sample): ${spreadChangeList.length ? fmt(stdSample(spreadChangeList)) : '-'}`);
  log(`  Min / Max: ${spreadChangeList.length ? fmt(Math.min(...spreadChangeList)) : '-'} / ${spreadChangeList.length ? fmt(Math.max(...spreadChangeList)) : '-'}`);
  log('  Interpretation (typical short-basis): negative spreadChange often = spread narrowed = favorable exit.');
  log('');

  log('=== 5. EXIT/ENTRY SPREAD RATIO DEVIATION (closed, |exit/entry - 1|) ===');
  log(`  Usable rows (both spreads, entrySpread≠0): ${rr.count}`);
  log(`  Median |ratio-1|: ${rr.medianDev != null ? fmt(rr.medianDev) : '-'}`);
  log(`  Mean |ratio-1|: ${rr.meanDev != null ? fmt(rr.meanDev) : '-'}`);
  log(`  Min / Max |ratio-1|: ${rr.minDev != null ? fmt(rr.minDev) : '-'} / ${rr.maxDev != null ? fmt(rr.maxDev) : '-'}`);
  log(`  Range (max-min) of |ratio-1|: ${rr.rangeDev != null ? fmt(rr.rangeDev) : '-'}`);
  log(`  Median raw ratio exit/entry: ${rr.medianRatio != null ? fmt(rr.medianRatio) : '-'}`);
  log('');

  log('=== 6. Z-SCORE AT ENTRY (proxy for signal strength) ===');
  log(`  From trade_logs (entry rows): n=${entryZFromTrade.length}  mean=${entryZFromTrade.length ? fmt(mean(entryZFromTrade)) : '-'}  median=${entryZFromTrade.length ? fmt(median(entryZFromTrade)) : '-'}`);
  log(`  From basis_positions (closed): n=${entryZFromBp.length}  mean=${entryZFromBp.length ? fmt(mean(entryZFromBp)) : '-'}  median=${entryZFromBp.length ? fmt(median(entryZFromBp)) : '-'}`);
  log('');

  log('=== 7. CONFIG: SPREAD STOP-LOSS / TAKE-PROFIT / GRID (per pair) ===');
  for (const p of pairs) {
    const levels = parseLevels(p.spreadEntryLevels);
    log(`  pair ${p.id} ${p.agentName || ''}`);
    log(`    unilateral=${!!p.unilateralMode} tradeLeg=${p.tradeLeg || 'A'}`);
    log(`    spreadEntryLevels raw: ${p.spreadEntryLevels || '-'}`);
    log(`    parsed grid level count: ${levels.length}  thresholds: [${levels.map((x) => fmt(x, 2)).join(', ')}]`);
    log(`    tpSpreadDelta (TP vs entry spread, $): ${p.tpSpreadDelta ?? '-'}`);
    log(`    slSpreadDelta (SL vs entry spread, $): ${p.slSpreadDelta ?? '-'}`);
    log(`    maxSpreadCap: ${p.maxSpreadCap ?? '-'}  zEntryThreshold: ${p.zEntryThreshold ?? '-'}  zEntryMax: ${p.zEntryMax ?? '-'}`);
    log(`    stopLoss (pair $): ${p.stopLoss ?? '-'}  profitTarget: ${p.profitTarget ?? '-'}`);
  }
  log('');
  log('  Cross-check: closed exits tagged "stop" vs "profit" should align with slSpreadDelta/tpSpreadDelta in unilateral bots.');
  log(`  Closed stop exits: ${exitReasonCount.stop || 0} | profit exits: ${exitReasonCount.profit || 0}`);
  log('');

  log('=== 8. SESSIONS / "DISCONNECTIONS" (bot_session_logs) ===');
  const completed = sessions.filter((s) => s.disabledAt != null);
  const running = sessions.filter((s) => s.disabledAt == null);
  log(`  Total session rows: ${sessions.length}`);
  log(`  Completed sessions (disabledAt set): ${completed.length}`);
  log(`  Open-ended rows (disabledAt null, likely current): ${running.length}`);
  const downtimeList = completed.map((s) => s.downtimeMs).filter((x) => x != null && Number.isFinite(x) && x > 0);
  log(`  Downtime gaps (downtimeMs>0): count=${downtimeList.length} median_ms=${downtimeList.length ? fmt(median(downtimeList), 0) : '-'} mean_ms=${downtimeList.length ? fmt(mean(downtimeList), 0) : '-'}`);
  const stopReasons = {};
  for (const s of completed) {
    const r = s.stopReason || '(null)';
    stopReasons[r] = (stopReasons[r] || 0) + 1;
  }
  log('  Stop reason (completed sessions):');
  for (const [r, n] of Object.entries(stopReasons).sort((a, b) => b[1] - a[1])) {
    log(`    ${r}: ${n}`);
  }
  log('  Note: each completed row is one enable→disable cycle (restart, manual stop, limit breach, crash, etc.).');
  log('');

  log('=== 9. SPREAD JSONL — REGIME / MEAN REVERSION / DEVIATION FROM ROLLING MEAN ===');
  log(`  Log directory: ${SPREAD_LOG_DIR}`);
  const sp = await aggregateAllSpreadLogsForPairs(pairIds);
  log(`  Files read (pair×side with ≥1 line): ${sp.filesRead}  missing/empty: ${sp.filesMissing}`);
  log(`  Total tick lines read: ${sp.lines}`);
  if (sp.lines === 0) {
    log('  (No JSONL data — bots may not have run long enough or logs cleared.)');
  } else {
    const mrPct = sp.meanRevertingTicks + sp.trendingTicks > 0
      ? (100 * sp.meanRevertingTicks) / (sp.meanRevertingTicks + sp.trendingTicks)
      : null;
    const rn = sp.regimeStat.n;
    log(`  Regime score (|fastMean-slowMean|/slowStd): samples with numeric regimeScore: ${rn}`);
    log(`  Mean regimeScore: ${rn ? fmt(onlineMean(sp.regimeStat)) : '-'}`);
    log(`  Median regimeScore (~reservoir ${sp.regimeReservoir.buf.length}): ${sp.regimeReservoir.buf.length ? fmt(median(sp.regimeReservoir.buf)) : '-'}`);
    log(`  Std regimeScore (population): ${rn > 1 ? fmt(onlineStd(sp.regimeStat)) : '-'}`);
    log(`  Min / max regimeScore: ${rn ? fmt(sp.regimeStat.min) + ' / ' + fmt(sp.regimeStat.max) : '-'}`);
    log(`  Mean-reverting ticks (regimeScore < 0.5): ${sp.meanRevertingTicks}`);
    log(`  Trending ticks (regimeScore >= 0.5): ${sp.trendingTicks}`);
    log(`  Mean-reversion share of classified ticks: ${mrPct != null ? fmt(mrPct, 2) + '%' : '-'}`);
    log(`  Ticks without regimeScore in file: ${sp.unknownRegime}`);
    const dn = sp.devStat.n;
    log(`  Spread deviation from rolling mean (spread - mean): n=${dn}`);
    if (dn) {
      log(`    mean |spread-mean|: ${fmt(sp.devStat.sumAbs / dn)}  (mean signed dev: ${fmt(onlineMean(sp.devStat))})`);
      log(`    min / max (spread-mean): ${fmt(sp.devStat.min)} / ${fmt(sp.devStat.max)}`);
    }
    const zn = sp.zStat.n;
    log(`  Z-score in logs: n=${zn} mean=${zn ? fmt(onlineMean(sp.zStat)) : '-'} std=${zn > 1 ? fmt(onlineStd(sp.zStat)) : '-'}`);
    log(`  Median z-score (~reservoir): ${sp.zReservoir.buf.length ? fmt(median(sp.zReservoir.buf)) : '-'}`);
    const sn = sp.spreadStat.n;
    log(`  Spread level in logs: min=${sn ? fmt(sp.spreadStat.min) : '-'} max=${sn ? fmt(sp.spreadStat.max) : '-'} range=${sn ? fmt(sp.spreadStat.max - sp.spreadStat.min) : '-'}`);
  }
  log('');

  log('=== 10. SHORT ANALYSIS ===');
  log('  • Trade count reflects every logged leg/event; roundtrips are best tracked via basis_positions closed + open.');
  log('  • Median/average hold time summarizes how long capital stayed in closed trades.');
  log('  • Spread SL/TP config lives on statarb_inputs; compare to exitReason stop/profit counts.');
  log('  • High mean regimeScore ⇒ more trending (fast vs slow mean diverge); low share of mean-reverting ticks ⇒ harder mean-reversion execution.');
  log('  • Ratio deviation range shows how volatile exit vs entry spread ratios were on closed trades.');
  log('  • Session log counts reflect operational interruptions and manual stops — not TCP disconnects per se.');
  log('');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `full_analysis_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
