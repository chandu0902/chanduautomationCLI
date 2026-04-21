#!/usr/bin/env node
'use strict';
require('dotenv').config();
const { sequelize, BasisPosition, StatArbInput } = require('./src/models');
const { Op } = require('sequelize');

const ANCHOR_MS = Date.parse('2026-04-04T14:15:00.000Z');

function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.min(Math.floor(p * s.length), s.length - 1)]; }
function avg(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0; }
function med(arr) { return pct(arr, 0.5); }
function stddev(arr) { const m = avg(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length); }

function computeMetrics(pnls) {
  if (pnls.length === 0) return null;
  const n = pnls.length;
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const mean = avg(pnls);
  const sd = stddev(pnls);
  const sharpe = sd > 0 ? mean / sd : 0;
  const wr = wins.length / n;
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const wlRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : Infinity;
  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  let peak = 0, maxDD = 0, cum = 0;
  for (const p of pnls) { cum += p; if (cum > peak) peak = cum; const d = peak - cum; if (d > maxDD) maxDD = d; }
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const kelly = wr > 0 && avgLoss !== 0 ? wr - (1 - wr) / wlRatio : 0;
  return { n, wins: wins.length, stops: losses.length, wr, avgWin, avgLoss, wlRatio, sharpe, totalPnl, maxDD, pf, kelly, mean, sd };
}

function fmtBtc(v, d = 6) { return v.toFixed(d); }
function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }

(async () => {
  await sequelize.authenticate();
  const pair = await StatArbInput.findByPk(6, { raw: true });
  const closed = await BasisPosition.findAll({
    where: { pairId: 6, state: 'closed', exitTime: { [Op.gte]: new Date(ANCHOR_MS) } },
    attributes: ['entrySpread', 'exitSpread', 'spreadChange', 'netPnl', 'grossPnl', 'commission',
      'exitReason', 'gridLevel', 'legA_entryPrice', 'legA_exitPrice', 'holdMs', 'entryTime', 'exitTime'],
    raw: true, order: [['exitTime', 'ASC']],
  });

  const curLevels = pair.spreadEntryLevels.split(',').map(Number);
  const curTP = Number(pair.tpSpreadDelta);
  const curSL = Number(pair.slSpreadDelta);

  const W = process.stdout.columns || 90;
  const sep = '═'.repeat(W);
  const line = '─'.repeat(W);

  console.log(sep);
  console.log('  LADDER + TP / SL OPTIMIZATION REPORT');
  console.log(`  Pair 6: BTC-29MAY26 vs BTC-PERPETUAL (unilateral long perp)`);
  console.log(`  Window: Apr 4 14:15 UTC → now  |  ${closed.length} closed round trips`);
  console.log(`  Current: levels=[${curLevels}]  TP=${curTP}  SL=${curSL}`);
  console.log(sep);

  // ─── SECTION 1: CURRENT PERFORMANCE ────────────────────────────────
  console.log('\n1. CURRENT PERFORMANCE (actual DB trades)\n');

  const allPnls = closed.map(r => Number(r.netPnl) || 0);
  const overall = computeMetrics(allPnls);
  console.log(`  Total Trips: ${overall.n}   TP wins: ${overall.wins}   SL stops: ${overall.stops}`);
  console.log(`  Win Rate:    ${fmtPct(overall.wr)}`);
  console.log(`  Avg Win:     ${fmtBtc(overall.avgWin)} BTC    Avg Loss: ${fmtBtc(overall.avgLoss)} BTC`);
  console.log(`  W/L Ratio:   ${overall.wlRatio.toFixed(3)}    (need ≥1.0 at 50% WR, or ≥${((1 - overall.wr) / overall.wr).toFixed(2)} at ${fmtPct(overall.wr)} WR)`);
  console.log(`  Sharpe:      ${overall.sharpe.toFixed(4)}   PF: ${overall.pf.toFixed(3)}   Kelly: ${(overall.kelly * 100).toFixed(1)}%`);
  console.log(`  Total PnL:   ${fmtBtc(overall.totalPnl)} BTC`);
  console.log(`  Max DD:      ${fmtBtc(overall.maxDD)} BTC`);

  // Break-even requirement
  const beWR = 1 / (1 + overall.wlRatio);
  console.log(`\n  Break-even WR needed at current W/L=${overall.wlRatio.toFixed(3)}: ${fmtPct(beWR)}`);
  console.log(`  Your actual WR ${fmtPct(overall.wr)} ${overall.wr > beWR ? '>' : '<'} ${fmtPct(beWR)} → ${overall.wr > beWR ? 'PROFITABLE' : 'UNPROFITABLE'}`);

  // ─── SECTION 2: PER-LEVEL BREAKDOWN ─────────────────────────────────
  console.log('\n' + line);
  console.log('2. PER-LEVEL BREAKDOWN\n');

  const byLevel = {};
  for (const r of closed) {
    const g = r.gridLevel ?? 0;
    if (!byLevel[g]) byLevel[g] = { trades: [] };
    byLevel[g].trades.push(r);
  }

  console.log('  Lvl  Spread Range  Trips  WR%    AvgWin    AvgLoss   W/L    Sharpe  Net PnL    Kelly');
  console.log('  ───  ────────────  ─────  ─────  ────────  ────────  ─────  ──────  ─────────  ─────');
  for (const [lv, data] of Object.entries(byLevel).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const pnls = data.trades.map(r => Number(r.netPnl) || 0);
    const s = computeMetrics(pnls);
    const spreads = data.trades.map(r => Number(r.entrySpread));
    const minSp = Math.min(...spreads).toFixed(0);
    const maxSp = Math.max(...spreads).toFixed(0);
    console.log(
      '  ' + String(lv).padStart(3) + '  ' +
      `${minSp}-${maxSp}`.padEnd(12) + '  ' +
      String(s.n).padStart(5) + '  ' +
      fmtPct(s.wr).padStart(5) + '  ' +
      fmtBtc(s.avgWin).padStart(8) + '  ' +
      fmtBtc(s.avgLoss).padStart(8) + '  ' +
      s.wlRatio.toFixed(3).padStart(5) + '  ' +
      s.sharpe.toFixed(4).padStart(6) + '  ' +
      fmtBtc(s.totalPnl).padStart(9) + '  ' +
      (s.kelly * 100).toFixed(1).padStart(5) + '%'
    );
    data.metrics = s;
  }

  // ─── SECTION 3: PnL DISTRIBUTIONS ───────────────────────────────────
  console.log('\n' + line);
  console.log('3. PnL DISTRIBUTIONS\n');

  const tpTrades = closed.filter(r => r.exitReason === 'profit');
  const slTrades = closed.filter(r => r.exitReason === 'stop');
  const tpPnls = tpTrades.map(r => Number(r.netPnl));
  const slPnls = slTrades.map(r => Number(r.netPnl));

  console.log('  TP EXITS (n=' + tpPnls.length + '):');
  console.log(`    P10: ${fmtBtc(pct(tpPnls, 0.1))}  P25: ${fmtBtc(pct(tpPnls, 0.25))}  Median: ${fmtBtc(med(tpPnls))}  P75: ${fmtBtc(pct(tpPnls, 0.75))}  P90: ${fmtBtc(pct(tpPnls, 0.9))}`);
  console.log(`    Mean: ${fmtBtc(avg(tpPnls))}  StdDev: ${fmtBtc(stddev(tpPnls))}`);

  const tpSpreadDeltas = tpTrades.map(r => Number(r.entrySpread) - Number(r.exitSpread));
  console.log(`    Spread narrowing: avg=${avg(tpSpreadDeltas).toFixed(1)}  med=${med(tpSpreadDeltas).toFixed(1)}  min=${Math.min(...tpSpreadDeltas).toFixed(1)}  max=${Math.max(...tpSpreadDeltas).toFixed(1)}`);

  const tpPriceDeltas = tpTrades.map(r => Number(r.legA_exitPrice) - Number(r.legA_entryPrice));
  console.log(`    Price move (perp): avg=$${avg(tpPriceDeltas).toFixed(1)}  med=$${med(tpPriceDeltas).toFixed(1)}`);

  console.log('\n  SL EXITS (n=' + slPnls.length + '):');
  console.log(`    P10: ${fmtBtc(pct(slPnls, 0.1))}  P25: ${fmtBtc(pct(slPnls, 0.25))}  Median: ${fmtBtc(med(slPnls))}  P75: ${fmtBtc(pct(slPnls, 0.75))}  P90: ${fmtBtc(pct(slPnls, 0.9))}`);
  console.log(`    Mean: ${fmtBtc(avg(slPnls))}  StdDev: ${fmtBtc(stddev(slPnls))}`);

  const slSpreadDeltas = slTrades.map(r => Number(r.entrySpread) - Number(r.exitSpread));
  console.log(`    Spread widening: avg=${avg(slSpreadDeltas).toFixed(1)}  med=${med(slSpreadDeltas).toFixed(1)}`);

  const slPriceDeltas = slTrades.map(r => Number(r.legA_exitPrice) - Number(r.legA_entryPrice));
  console.log(`    Price move (perp): avg=$${avg(slPriceDeltas).toFixed(1)}  med=$${med(slPriceDeltas).toFixed(1)}`);

  const bigLosses = slTrades.filter(r => Number(r.netPnl) < -0.2);
  console.log(`\n    Catastrophic SL (loss > 0.2 BTC): ${bigLosses.length} trades (${(bigLosses.length / slTrades.length * 100).toFixed(0)}% of stops)`);
  console.log(`    These ${bigLosses.length} trades lost ${fmtBtc(bigLosses.reduce((s, r) => s + Number(r.netPnl), 0))} BTC total`);

  // ─── SECTION 4: OPTIMAL TP / SL ESTIMATION ──────────────────────────
  console.log('\n' + line);
  console.log('4. OPTIMAL TP / SL ESTIMATION (from actual trade data)\n');

  // Method: for each SL trade, estimate what loss would have been with a tighter SL
  // Assumption: loss scales roughly with spreadDelta. If SL was X instead of 35,
  // the trade would have exited when spread widened by X. The price loss at that point
  // is approximately (X/actualSpreadDelta) * actualLoss.
  // This is an approximation — in reality the price path is not linear.
  // For TP: increasing TP means some current TP exits might not fire (spread didn't narrow enough).
  // We check: how many TP exits had spread narrowing >= newTP.

  const scenarios = [];
  const tpCandidates = [1, 2, 3, 5, 8, 10, 15, 20];
  const slCandidates = [10, 15, 20, 25, 30, 35, 50, 70];

  for (const newTP of tpCandidates) {
    for (const newSL of slCandidates) {
      if (newSL <= newTP) continue;
      const simPnls = [];

      for (const r of tpTrades) {
        const spreadDelta = Number(r.entrySpread) - Number(r.exitSpread);
        const priceDelta = Number(r.legA_exitPrice) - Number(r.legA_entryPrice);

        // Would this trade still be a TP exit with new TP?
        // TP condition: spread narrows by >= newTP AND price positive
        // We only have the final state; if spreadDelta >= newTP, it would have hit TP at some point.
        // If spreadDelta < newTP, the trade wouldn't have hit TP — it either hits SL or stays open.
        // For spreadDelta < 0 (spread widened), this definitely wouldn't be a TP.
        // For current TP=1, most exits have spreadDelta well above 1 (avg 20.6), so raising TP
        // just filters out the edge cases.

        if (spreadDelta >= newTP && priceDelta > 0) {
          // Still a TP. But with higher TP threshold, we assume the trade stayed in longer,
          // and the actual PnL is at least what it was (conservative: same PnL).
          simPnls.push(Number(r.netPnl));
        } else {
          // This TP would now be unknown — might become SL or breakeven.
          // Conservative: assume it becomes a SL loss at the new SL level.
          // Estimate loss: median SL loss scaled by newSL/curSL.
          const estLoss = med(slPnls) * (newSL / curSL);
          simPnls.push(estLoss);
        }
      }

      for (const r of slTrades) {
        const actualSpreadDelta = Number(r.exitSpread) - Number(r.entrySpread); // positive = widened
        const actualLoss = Number(r.netPnl);

        if (newSL <= curSL) {
          // Tighter SL: trade exits earlier with proportionally smaller loss.
          // The actual spread widened by actualSpreadDelta (which >= curSL for confirmed stops).
          // With newSL < curSL, exit happens when spread widens by newSL.
          // Estimate loss: actualLoss * (newSL / max(actualSpreadDelta, curSL))
          const ratio = Math.min(newSL / Math.max(actualSpreadDelta, curSL), 1);
          simPnls.push(actualLoss * ratio);
        } else {
          // Wider SL: trade might have recovered. Check if it would have hit TP first.
          // We don't have the path, so conservative: same loss (it was already SL=35 triggered)
          // For a wider SL, the trade would have continued. It might have:
          //  a) recovered to TP → gain
          //  b) lost more → bigger loss
          // Without path data, assume same outcome (conservative for wider SL).
          simPnls.push(actualLoss);
        }
      }

      const m = computeMetrics(simPnls);
      if (m) {
        scenarios.push({ tp: newTP, sl: newSL, ...m });
      }
    }
  }

  scenarios.sort((a, b) => b.sharpe - a.sharpe);

  console.log('  TP  SL   Trips  WR%    AvgWin    AvgLoss   W/L    Sharpe  Net PnL    MaxDD    PF     Kelly');
  console.log('  ──  ──   ─────  ─────  ────────  ────────  ─────  ──────  ─────────  ───────  ─────  ─────');

  const printed = new Set();
  for (const s of scenarios.slice(0, 30)) {
    const key = `${s.tp}_${s.sl}`;
    if (printed.has(key)) continue;
    printed.add(key);
    const isCur = s.tp === curTP && s.sl === curSL;
    const marker = isCur ? ' ← CURRENT' : '';
    console.log(
      '  ' + String(s.tp).padStart(2) + '  ' +
      String(s.sl).padStart(2) + '   ' +
      String(s.n).padStart(5) + '  ' +
      fmtPct(s.wr).padStart(5) + '  ' +
      fmtBtc(s.avgWin).padStart(8) + '  ' +
      fmtBtc(s.avgLoss).padStart(8) + '  ' +
      s.wlRatio.toFixed(3).padStart(5) + '  ' +
      s.sharpe.toFixed(4).padStart(6) + '  ' +
      fmtBtc(s.totalPnl).padStart(9) + '  ' +
      fmtBtc(s.maxDD).padStart(7) + '  ' +
      s.pf.toFixed(3).padStart(5) + '  ' +
      (s.kelly * 100).toFixed(1).padStart(5) + '%' + marker
    );
  }

  // ─── SECTION 5: W/L ANALYSIS ────────────────────────────────────────
  console.log('\n' + line);
  console.log('5. WIN / LOSS RATIO DEEP DIVE\n');

  console.log('  For profitability:  WR × AvgWin  >  (1-WR) × |AvgLoss|');
  console.log('  Equivalently:       W/L ratio    >  (1-WR) / WR\n');

  const wrTargets = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80];
  console.log('  WR%    Min W/L needed    Current W/L gap');
  console.log('  ─────  ───────────────   ───────────────');
  for (const wr of wrTargets) {
    const minWL = (1 - wr) / wr;
    const gap = overall.wlRatio - minWL;
    console.log(`  ${fmtPct(wr).padStart(5)}  ${minWL.toFixed(3).padStart(15)}   ${gap > 0 ? '+' : ''}${gap.toFixed(3).padStart(14)}  ${gap > 0 ? 'OK' : 'NOT ENOUGH'}`);
  }

  // ─── SECTION 6: LEVEL ELIMINATION ───────────────────────────────────
  console.log('\n' + line);
  console.log('6. LEVEL ANALYSIS — WHICH LEVELS TO DROP?\n');

  const levelsToAnalyze = Object.entries(byLevel)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([lv, d]) => ({ lv: Number(lv), ...d.metrics, label: `Level ${lv} (${curLevels[Number(lv) - 1] || '?'}+)` }));

  console.log('  Level analysis summary:');
  for (const lv of levelsToAnalyze) {
    const verdict = lv.sharpe > 0.05 ? 'KEEP' : (lv.sharpe > -0.05 ? 'MARGINAL' : 'DROP');
    console.log(`    ${lv.label.padEnd(18)} Sharpe=${lv.sharpe.toFixed(4)}  PnL=${fmtBtc(lv.totalPnl)}  Kelly=${(lv.kelly * 100).toFixed(1)}%  → ${verdict}`);
  }

  // Without-level simulation
  console.log('\n  Impact of dropping each level (from current config):\n');
  for (let drop = 0; drop < curLevels.length; drop++) {
    const remaining = closed.filter(r => (r.gridLevel ?? 0) !== drop + 1);
    const pnls = remaining.map(r => Number(r.netPnl) || 0);
    const s = computeMetrics(pnls);
    if (!s) continue;
    const delta = s.sharpe - overall.sharpe;
    console.log(`    Drop level ${drop + 1} (${curLevels[drop]}): Sharpe ${overall.sharpe.toFixed(4)} → ${s.sharpe.toFixed(4)} (${delta > 0 ? '+' : ''}${delta.toFixed(4)})  PnL ${fmtBtc(overall.totalPnl)} → ${fmtBtc(s.totalPnl)}`);
  }

  // ─── SECTION 7: FINAL RECOMMENDATIONS ──────────────────────────────
  console.log('\n' + sep);
  console.log('  FINAL RECOMMENDATIONS');
  console.log(sep);

  const best = scenarios[0];
  const bestBalanced = scenarios.find(s => s.wr >= 0.55 && s.wr <= 0.85 && s.n >= 50 && s.wlRatio >= 0.3);
  const bestConservative = [...scenarios].sort((a, b) => (b.totalPnl / Math.max(b.maxDD, 0.001)) - (a.totalPnl / Math.max(a.maxDD, 0.001)))[0];

  console.log('\n  CURRENT CONFIG:');
  console.log(`    TP=${curTP}  SL=${curSL}  WR=${fmtPct(overall.wr)}  W/L=${overall.wlRatio.toFixed(3)}  Sharpe=${overall.sharpe.toFixed(4)}  Net=${fmtBtc(overall.totalPnl)} BTC`);

  if (best) {
    console.log('\n  AGGRESSIVE (best Sharpe):');
    console.log(`    TP=${best.tp}  SL=${best.sl}  WR=${fmtPct(best.wr)}  W/L=${best.wlRatio.toFixed(3)}  Sharpe=${best.sharpe.toFixed(4)}  Net=${fmtBtc(best.totalPnl)} BTC`);
  }

  if (bestBalanced && (bestBalanced.tp !== best?.tp || bestBalanced.sl !== best?.sl)) {
    console.log('\n  BALANCED (good Sharpe + reasonable WR):');
    console.log(`    TP=${bestBalanced.tp}  SL=${bestBalanced.sl}  WR=${fmtPct(bestBalanced.wr)}  W/L=${bestBalanced.wlRatio.toFixed(3)}  Sharpe=${bestBalanced.sharpe.toFixed(4)}  Net=${fmtBtc(bestBalanced.totalPnl)} BTC`);
  }

  if (bestConservative && (bestConservative.tp !== best?.tp || bestConservative.sl !== best?.sl)) {
    console.log('\n  CONSERVATIVE (best PnL/MaxDD):');
    console.log(`    TP=${bestConservative.tp}  SL=${bestConservative.sl}  WR=${fmtPct(bestConservative.wr)}  W/L=${bestConservative.wlRatio.toFixed(3)}  Sharpe=${bestConservative.sharpe.toFixed(4)}  Net=${fmtBtc(bestConservative.totalPnl)} BTC`);
  }

  // Compute required WR for break-even at different W/L ratios
  console.log('\n  STRATEGY INSIGHTS:');
  console.log(`    • Your avg TP win  = ${fmtBtc(avg(tpPnls))} BTC (${(avg(tpPnls)*84000).toFixed(0)} USD)`);
  console.log(`    • Your avg SL loss = ${fmtBtc(avg(slPnls))} BTC (${(avg(slPnls)*84000).toFixed(0)} USD)`);
  console.log(`    • Each SL wipes ${Math.abs(avg(slPnls) / avg(tpPnls)).toFixed(1)} TP wins`);
  console.log(`    • ${bigLosses.length} catastrophic SLs (>${fmtBtc(0.2)}) cost ${fmtBtc(Math.abs(bigLosses.reduce((s, r) => s + Number(r.netPnl), 0)))} total`);
  console.log(`    • Cutting those would improve net PnL by ~${fmtBtc(Math.abs(bigLosses.reduce((s, r) => s + Number(r.netPnl), 0)) - bigLosses.length * Math.abs(avg(slPnls)))} BTC`);
  console.log(`    • A tighter SL (e.g. 20) saves on avg ${fmtBtc(Math.abs(avg(slPnls)) * (1 - 20/35))} BTC per stop`);
  console.log(`    • But tighter SL may slightly increase stop frequency (whipsaw risk)`);

  console.log('\n  CONCRETE CHANGES TO MAKE:');
  
  const droppable = levelsToAnalyze.filter(l => l.sharpe < -0.05);
  if (droppable.length > 0) {
    console.log(`    1. DROP underperforming levels: ${droppable.map(l => `Level ${l.lv} (${curLevels[l.lv - 1]})`).join(', ')}`);
  }
  if (best) {
    console.log(`    2. SET TP=${best.tp} SL=${best.sl} (best Sharpe from data analysis)`);
    if (bestBalanced && (bestBalanced.tp !== best.tp || bestBalanced.sl !== best.sl)) {
      console.log(`       OR TP=${bestBalanced.tp} SL=${bestBalanced.sl} (balanced alternative)`);
    }
  }
  console.log(`    3. REDUCE maxPositions from ${pair.maxPositions} to ${Math.max(pair.maxPositions - droppable.length, 2)} (fewer levels = fewer simultaneous positions)`);
  console.log(`    4. RAISE zEntryThreshold from ${pair.zEntryThreshold} to 1.5 (filter out marginal z-score entries)`);
  console.log('');

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
