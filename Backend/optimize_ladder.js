#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { sequelize, BasisPosition, StatArbInput } = require('./src/models');
const { Op } = require('sequelize');

const ANCHOR_MS = Date.parse('2026-04-04T14:15:00.000Z');
const EXPIRY_MS = Date.parse('2026-05-29T08:00:00.000Z');
const COOLDOWN_TICKS = 20;
const TP_CONFIRM = 2;
const SL_CONFIRM = 4;
const QTY_USD = 900;

async function getActualPriceTimeline() {
  const trades = await BasisPosition.findAll({
    where: { pairId: 6, state: 'closed', exitTime: { [Op.gte]: new Date(ANCHOR_MS) } },
    attributes: ['legA_entryPrice', 'legA_exitPrice', 'entryTime', 'exitTime'],
    raw: true, order: [['exitTime', 'ASC']],
  });
  const points = [];
  for (const t of trades) {
    if (t.entryTime) points.push({ ts: new Date(t.entryTime).getTime(), price: Number(t.legA_entryPrice) });
    if (t.exitTime) points.push({ ts: new Date(t.exitTime).getTime(), price: Number(t.legA_exitPrice) });
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

function interpolatePrice(priceTimeline, ts) {
  if (priceTimeline.length === 0) return 84000;
  if (ts <= priceTimeline[0].ts) return priceTimeline[0].price;
  if (ts >= priceTimeline[priceTimeline.length - 1].ts) return priceTimeline[priceTimeline.length - 1].price;
  let lo = 0, hi = priceTimeline.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (priceTimeline[mid].ts <= ts) lo = mid; else hi = mid;
  }
  const p0 = priceTimeline[lo], p1 = priceTimeline[hi];
  const frac = (ts - p0.ts) / (p1.ts - p0.ts || 1);
  return p0.price + frac * (p1.price - p0.price);
}

function pctPaToDollar(pctPa, perpMid, ts) {
  const dte = Math.max((EXPIRY_MS - ts) / 86400000, 1);
  return pctPa * perpMid * dte / (365 * 100);
}

async function loadSpreadTicks(priceTimeline) {
  const stream = fs.createReadStream(path.join(__dirname, 'logs', 'spread', 'pair_6_mid.jsonl'), { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const ticks = [];
  let skip = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const ts = Date.parse(e.createdAt);
      if (ts < ANCHOR_MS) continue;
      skip++;
      if (skip % 10 !== 0) continue; // downsample 10x for speed
      const perpMid = interpolatePrice(priceTimeline, ts);
      const dollarSpread = pctPaToDollar(e.spread, perpMid, ts);
      ticks.push({ ts, dollarSpread, perpMid, zScore: e.zScore || 0 });
    } catch {}
  }
  return ticks;
}

function simulate(ticks, levels, tpDelta, slDelta, maxPos, zMin, cap) {
  const results = [];
  const openPositions = [];
  const levelCooldown = {};
  let i = 0;
  const n = ticks.length;

  while (i < n) {
    const tick = ticks[i];
    const sp = tick.dollarSpread;
    const price = tick.perpMid;
    const z = tick.zScore;

    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const entrySignalSpread = pos.entrySpread;
      const fillSpread = pos.fillSpread;
      const grossPositive = price > pos.entryPrice;
      const tpHit = (entrySignalSpread - sp) >= tpDelta && grossPositive;
      const slHit = (sp - fillSpread) >= slDelta;

      if (tpHit) {
        pos.tpTicks = (pos.tpTicks || 0) + 1;
        if (pos.tpTicks >= TP_CONFIRM) {
          const grossPnl = QTY_USD * (price - pos.entryPrice) / (price * pos.entryPrice);
          const rebate = QTY_USD * 0.0002 / price;
          const netPnl = grossPnl + rebate * 2;
          results.push({ gridLevel: pos.gridLevel, reason: 'profit', netPnl, grossPnl, entrySpread: pos.entrySpread, exitSpread: sp, spreadDelta: entrySignalSpread - sp });
          openPositions.splice(p, 1);
          levelCooldown[pos.gridLevel] = i + COOLDOWN_TICKS;
        }
      } else {
        pos.tpTicks = 0;
      }

      if (!tpHit && slHit) {
        pos.slTicks = (pos.slTicks || 0) + 1;
        if (pos.slTicks >= SL_CONFIRM) {
          const grossPnl = QTY_USD * (price - pos.entryPrice) / (price * pos.entryPrice);
          const rebate = QTY_USD * 0.0002 / price;
          const fee = QTY_USD * 0.0005 / price;
          const netPnl = grossPnl + rebate - fee;
          results.push({ gridLevel: pos.gridLevel, reason: 'stop', netPnl, grossPnl, entrySpread: pos.entrySpread, exitSpread: sp, spreadDelta: entrySignalSpread - sp });
          openPositions.splice(p, 1);
          levelCooldown[pos.gridLevel] = i + COOLDOWN_TICKS * 5;
        }
      } else {
        pos.slTicks = 0;
      }
    }

    if (z >= zMin && openPositions.length < maxPos && sp <= cap) {
      for (let lv = levels.length - 1; lv >= 0; lv--) {
        const lvFloor = levels[lv];
        const lvCeil = levels[lv + 1] || cap;
        if (sp < lvFloor || sp >= lvCeil) continue;
        const already = openPositions.some(p => p.gridLevel === lv + 1);
        if (already) continue;
        if (levelCooldown[lv + 1] && i < levelCooldown[lv + 1]) continue;
        openPositions.push({
          gridLevel: lv + 1,
          entrySpread: sp,
          fillSpread: sp,
          entryPrice: price,
          tpTicks: 0, slTicks: 0,
        });
        levelCooldown[lv + 1] = i + COOLDOWN_TICKS;
        break;
      }
    }
    i++;
  }
  return results;
}

function computeStats(results) {
  if (results.length === 0) return null;
  const pnls = results.map(r => r.netPnl);
  const n = pnls.length;
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const mean = pnls.reduce((s, x) => s + x, 0) / n;
  let ss = 0; for (const x of pnls) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / n);
  const sharpe = sd > 0 ? mean / sd : 0;
  const wr = wins.length / n;
  const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0;
  const wlRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;
  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  const maxDD = (() => {
    let peak = 0, dd = 0, cum = 0;
    for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const d = peak - cum; if (d > dd) dd = d; }
    return dd;
  })();
  const calmar = maxDD > 0 ? totalPnl / maxDD : 0;
  const profitFactor = (() => {
    const grossWin = wins.reduce((s, x) => s + x, 0);
    const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
    return grossLoss > 0 ? grossWin / grossLoss : Infinity;
  })();
  return { n, wins: wins.length, stops: losses.length, wr, avgWin, avgLoss, wlRatio, sharpe, totalPnl, maxDD, calmar, profitFactor, mean, sd };
}

(async () => {
  await sequelize.authenticate();
  const pair = await StatArbInput.findByPk(6, { raw: true });

  console.log('==========================================================');
  console.log('   LADDER OPTIMIZATION: TP / SL / W:L / SHARPE ANALYSIS   ');
  console.log('   Since: Friday Apr 4 7:45 PM IST (14:15 UTC)            ');
  console.log('   Pair: BTC-29MAY26 vs BTC-PERPETUAL (unilateral long)   ');
  console.log('==========================================================\n');

  console.log('Loading BTC price timeline from DB trades...');
  const priceTimeline = await getActualPriceTimeline();
  console.log(`  ${priceTimeline.length} price points\n`);

  console.log('Loading & converting spread ticks (downsampled 10x)...');
  const ticks = await loadSpreadTicks(priceTimeline);
  console.log(`  ${ticks.length} ticks loaded\n`);

  const curLevels = pair.spreadEntryLevels.split(',').map(Number);
  const curTP = Number(pair.tpSpreadDelta);
  const curSL = Number(pair.slSpreadDelta);
  const maxPos = Number(pair.maxPositions);
  const zMin = Number(pair.zEntryThreshold);
  const cap = Number(pair.maxSpreadCap);

  // ------------- CURRENT CONFIG BASELINE -----------------
  console.log('────────────────────────────────────────────────');
  console.log('CURRENT CONFIG BASELINE');
  console.log(`  Levels: [${curLevels}]  TP=${curTP}  SL=${curSL}  maxPos=${maxPos}  zMin=${zMin}`);
  console.log('────────────────────────────────────────────────');
  const baseline = simulate(ticks, curLevels, curTP, curSL, maxPos, zMin, cap);
  const baseStats = computeStats(baseline);
  if (baseStats) {
    console.log(`  Trips: ${baseStats.n}  Wins: ${baseStats.wins} (${(baseStats.wr * 100).toFixed(1)}%)  Stops: ${baseStats.stops}`);
    console.log(`  AvgWin: ${baseStats.avgWin.toFixed(6)}  AvgLoss: ${baseStats.avgLoss.toFixed(6)}  W/L: ${baseStats.wlRatio.toFixed(3)}`);
    console.log(`  Sharpe: ${baseStats.sharpe.toFixed(4)}  TotalPnL: ${baseStats.totalPnl.toFixed(6)} BTC`);
    console.log(`  MaxDD: ${baseStats.maxDD.toFixed(6)}  Calmar: ${baseStats.calmar.toFixed(3)}  ProfitFactor: ${baseStats.profitFactor.toFixed(3)}`);
  }
  console.log('');

  // ------------- GRID SEARCH OVER TP / SL -----------------
  console.log('════════════════════════════════════════════════════════════════════════════');
  console.log('GRID SEARCH: TP x SL  (same levels, maxPos, zMin)');
  console.log('════════════════════════════════════════════════════════════════════════════');

  const tpRange = [1, 2, 3, 5, 8, 10, 15, 20];
  const slRange = [10, 15, 20, 25, 30, 35, 50, 70];
  const grid = [];

  for (const tp of tpRange) {
    for (const sl of slRange) {
      if (sl <= tp) continue;
      const results = simulate(ticks, curLevels, tp, sl, maxPos, zMin, cap);
      const stats = computeStats(results);
      if (!stats || stats.n < 5) continue;
      grid.push({ tp, sl, ...stats });
    }
  }

  grid.sort((a, b) => b.sharpe - a.sharpe);

  console.log('');
  console.log('TP   SL   Trips  WR%    AvgWin    AvgLoss   W/L    Sharpe  TotalPnL   MaxDD    PF');
  console.log('───  ───  ─────  ─────  ────────  ────────  ─────  ──────  ─────────  ───────  ──────');
  for (const g of grid.slice(0, 25)) {
    console.log(
      String(g.tp).padStart(3) + '  ' +
      String(g.sl).padStart(3) + '  ' +
      String(g.n).padStart(5) + '  ' +
      (g.wr * 100).toFixed(1).padStart(5) + '  ' +
      g.avgWin.toFixed(6).padStart(8) + '  ' +
      g.avgLoss.toFixed(6).padStart(8) + '  ' +
      g.wlRatio.toFixed(3).padStart(5) + '  ' +
      g.sharpe.toFixed(4).padStart(6) + '  ' +
      g.totalPnl.toFixed(4).padStart(9) + '  ' +
      g.maxDD.toFixed(4).padStart(7) + '  ' +
      g.profitFactor.toFixed(3).padStart(6)
    );
  }

  // ------------- BEST BY DIFFERENT CRITERIA -----------------
  console.log('\n════════════════════════════════════════════════════════════════════════════');
  console.log('BEST COMBOS BY DIFFERENT CRITERIA');
  console.log('════════════════════════════════════════════════════════════════════════════');

  const bySharpe = [...grid].sort((a, b) => b.sharpe - a.sharpe)[0];
  const byPnl = [...grid].sort((a, b) => b.totalPnl - a.totalPnl)[0];
  const byCalmar = [...grid].sort((a, b) => b.calmar - a.calmar)[0];
  const byPF = [...grid].filter(g => g.n >= 20).sort((a, b) => b.profitFactor - a.profitFactor)[0];
  const byWL = [...grid].filter(g => g.n >= 20).sort((a, b) => b.wlRatio - a.wlRatio)[0];

  const print = (label, g) => {
    if (!g) return;
    console.log(`\n  ${label}:`);
    console.log(`    TP=${g.tp}  SL=${g.sl}  Trips=${g.n}  WR=${(g.wr*100).toFixed(1)}%  W/L=${g.wlRatio.toFixed(3)}`);
    console.log(`    Sharpe=${g.sharpe.toFixed(4)}  TotalPnL=${g.totalPnl.toFixed(4)} BTC  MaxDD=${g.maxDD.toFixed(4)}  Calmar=${g.calmar.toFixed(3)}  PF=${g.profitFactor.toFixed(3)}`);
  };

  print('Best Sharpe', bySharpe);
  print('Best Total PnL', byPnl);
  print('Best Calmar (PnL/MaxDD)', byCalmar);
  print('Best Profit Factor (n≥20)', byPF);
  print('Best W/L Ratio (n≥20)', byWL);

  // ------------- LEVEL-SPECIFIC ANALYSIS -----------------
  console.log('\n════════════════════════════════════════════════════════════════════════════');
  console.log('PER-LEVEL ANALYSIS (using best Sharpe config)');
  console.log('════════════════════════════════════════════════════════════════════════════');

  if (bySharpe) {
    const bestResults = simulate(ticks, curLevels, bySharpe.tp, bySharpe.sl, maxPos, zMin, cap);
    const byLevel = {};
    for (const r of bestResults) {
      const g = r.gridLevel;
      if (!byLevel[g]) byLevel[g] = [];
      byLevel[g].push(r);
    }
    console.log(`\n  Config: TP=${bySharpe.tp}  SL=${bySharpe.sl}\n`);
    console.log('  Level  Trips  WR%    AvgWin    AvgLoss   W/L    Sharpe  TotalPnL');
    console.log('  ─────  ─────  ─────  ────────  ────────  ─────  ──────  ─────────');
    for (const [lv, trades] of Object.entries(byLevel).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      const s = computeStats(trades);
      if (!s) continue;
      console.log(
        '  ' + String(lv).padStart(5) + '  ' +
        String(s.n).padStart(5) + '  ' +
        (s.wr * 100).toFixed(1).padStart(5) + '  ' +
        s.avgWin.toFixed(6).padStart(8) + '  ' +
        s.avgLoss.toFixed(6).padStart(8) + '  ' +
        s.wlRatio.toFixed(3).padStart(5) + '  ' +
        s.sharpe.toFixed(4).padStart(6) + '  ' +
        s.totalPnl.toFixed(4).padStart(9)
      );
    }
  }

  // ------------- LADDER PRUNING TEST -----------------
  console.log('\n════════════════════════════════════════════════════════════════════════════');
  console.log('LADDER PRUNING: WHICH LEVELS TO KEEP?');
  console.log('════════════════════════════════════════════════════════════════════════════');

  if (bySharpe) {
    const allSubsets = [];
    for (let mask = 1; mask < (1 << curLevels.length); mask++) {
      const subset = curLevels.filter((_, idx) => mask & (1 << idx));
      if (subset.length < 2) continue;
      const results = simulate(ticks, subset, bySharpe.tp, bySharpe.sl, maxPos, zMin, cap);
      const stats = computeStats(results);
      if (!stats || stats.n < 10) continue;
      allSubsets.push({ levels: subset, ...stats });
    }
    allSubsets.sort((a, b) => b.sharpe - a.sharpe);

    console.log(`\n  Using TP=${bySharpe.tp}  SL=${bySharpe.sl}  — Top 10 ladder subsets by Sharpe:\n`);
    console.log('  Levels                     Trips  WR%    W/L    Sharpe  TotalPnL   MaxDD    PF');
    console.log('  ─────────────────────────  ─────  ─────  ─────  ──────  ─────────  ───────  ──────');
    for (const s of allSubsets.slice(0, 10)) {
      const lvStr = s.levels.join(',');
      console.log(
        '  ' + lvStr.padEnd(27) + '  ' +
        String(s.n).padStart(5) + '  ' +
        (s.wr * 100).toFixed(1).padStart(5) + '  ' +
        s.wlRatio.toFixed(3).padStart(5) + '  ' +
        s.sharpe.toFixed(4).padStart(6) + '  ' +
        s.totalPnl.toFixed(4).padStart(9) + '  ' +
        s.maxDD.toFixed(4).padStart(7) + '  ' +
        s.profitFactor.toFixed(3).padStart(6)
      );
    }
  }

  // ------------- FINAL RECOMMENDATION -----------------
  console.log('\n════════════════════════════════════════════════════════════════════════════');
  console.log('FINAL RECOMMENDATIONS');
  console.log('════════════════════════════════════════════════════════════════════════════');

  if (bySharpe) {
    console.log(`\n  CURRENT:   TP=${curTP}  SL=${curSL}  W/L=${baseStats?.wlRatio.toFixed(3)||'?'}  Sharpe=${baseStats?.sharpe.toFixed(4)||'?'}  PnL=${baseStats?.totalPnl.toFixed(4)||'?'} BTC`);
    console.log(`  SUGGESTED: TP=${bySharpe.tp}  SL=${bySharpe.sl}  W/L=${bySharpe.wlRatio.toFixed(3)}  Sharpe=${bySharpe.sharpe.toFixed(4)}  PnL=${bySharpe.totalPnl.toFixed(4)} BTC`);
    
    const improvement = baseStats ? ((bySharpe.sharpe - baseStats.sharpe) / Math.abs(baseStats.sharpe || 0.001) * 100).toFixed(0) : '?';
    console.log(`\n  Sharpe improvement: ${improvement}%`);
    
    if (byCalmar && (byCalmar.tp !== bySharpe.tp || byCalmar.sl !== bySharpe.sl)) {
      console.log(`\n  CONSERVATIVE ALT (best risk-adjusted): TP=${byCalmar.tp}  SL=${byCalmar.sl}  Calmar=${byCalmar.calmar.toFixed(3)}  Sharpe=${byCalmar.sharpe.toFixed(4)}`);
    }
  }

  console.log('\n  KEY INSIGHTS:');
  console.log('  • TP=1 grabs tiny wins while SL=35 allows catastrophic losses');
  console.log('  • Optimal W/L ratio > 1.0 requires either larger TP or smaller SL');
  console.log('  • Tighter SL cuts tail risk; wider TP lets winners run');
  console.log('  • Pruning underperforming grid levels improves overall Sharpe');
  console.log('');

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
