#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, BasisPosition } = require('../src/models');

(async () => {
  await sequelize.authenticate();
  const closed = await BasisPosition.findAll({ where: { pairId: 20, state: 'closed' }, raw: true });
  const profits = closed.filter(x => x.exitReason === 'profit');
  const stops   = closed.filter(x => x.exitReason === 'stop');

  const absSpreadChanges = profits.map(x => Math.abs(Number(x.spreadChange) || 0));
  absSpreadChanges.sort((a, b) => a - b);

  console.log('=== PROFIT EXIT |spreadChange| distribution ===');
  for (const p of [10, 25, 50, 75, 90, 95, 99]) {
    const idx = Math.floor(absSpreadChanges.length * p / 100);
    console.log(`  P${p}: ${absSpreadChanges[idx]?.toFixed(2)}`);
  }
  console.log(`  mean: ${(absSpreadChanges.reduce((s, x) => s + x, 0) / absSpreadChanges.length).toFixed(2)}`);

  for (const th of [5, 8, 10, 15, 20, 25, 30]) {
    const n = absSpreadChanges.filter(x => x >= th).length;
    console.log(`  |d| >= ${th}: ${n}/${absSpreadChanges.length} = ${(n / absSpreadChanges.length * 100).toFixed(1)}%`);
  }

  console.log('\n=== PROFIT PER TRADE by spread change bucket ===');
  for (const [lo, hi] of [[0, 5], [5, 10], [10, 20], [20, 40], [40, 100]]) {
    const inB = profits.filter(x => {
      const a = Math.abs(Number(x.spreadChange) || 0);
      return a >= lo && a < hi;
    });
    if (!inB.length) continue;
    const sumNet  = inB.reduce((s, x) => s + (Number(x.netPnl) || 0), 0);
    const avgNet  = sumNet / inB.length;
    const avgHold = inB.reduce((s, x) => s + (Number(x.holdMs) || 0), 0) / inB.length;
    console.log(`  |d| ${lo}-${hi}: ${inB.length} trades, avg net=$${avgNet.toFixed(4)}, sum=$${sumNet.toFixed(2)}, avg hold=${(avgHold / 60000).toFixed(1)}min`);
  }

  console.log('\n=== STOP EXITS ===');
  for (const s of stops) {
    console.log(`  id=${s.id} net=$${Number(s.netPnl).toFixed(2)} gross=$${Number(s.grossPnl).toFixed(2)} ` +
      `tpFrz=$${Number(s.tpDelta).toFixed(2)} slFrz=$${Number(s.slDelta).toFixed(2)} ` +
      `hold=${(Number(s.holdMs) / 60000).toFixed(1)}min spreadChg=${s.spreadChange}`);
  }

  // Revenue efficiency
  const totalNotional = closed.reduce((s, x) => s + Math.abs(Number(x.legA_entryQty) || 0), 0);
  const totalNet   = closed.reduce((s, x) => s + (Number(x.netPnl) || 0), 0);
  const totalGross = closed.reduce((s, x) => s + (Number(x.grossPnl) || 0), 0);
  const totalComm  = closed.reduce((s, x) => s + (Number(x.commission) || 0), 0);

  console.log('\n=== EFFICIENCY ===');
  console.log(`  total notional: $${totalNotional.toFixed(0)}`);
  console.log(`  total netPnl:   $${totalNet.toFixed(4)}`);
  console.log(`  total grossPnl: $${totalGross.toFixed(4)}`);
  console.log(`  rebates:        $${totalComm.toFixed(4)}`);
  console.log(`  rebates as % of netPnl: ${(totalComm / totalNet * 100).toFixed(1)}%`);
  console.log(`  net per $10K notional: $${totalNotional > 0 ? (totalNet / (totalNotional / 10000)).toFixed(4) : 'n/a'}`);

  // Expectancy math
  const winRate = profits.length / closed.length;
  const avgWin  = profits.reduce((s, x) => s + (Number(x.netPnl) || 0), 0) / profits.length;
  const avgLoss = stops.length ? Math.abs(stops.reduce((s, x) => s + (Number(x.netPnl) || 0), 0) / stops.length) : 0;
  console.log('\n=== EXPECTANCY ===');
  console.log(`  win rate: ${(winRate * 100).toFixed(2)}%`);
  console.log(`  avg win:  $${avgWin.toFixed(4)}`);
  console.log(`  avg loss: $${avgLoss.toFixed(4)}`);
  console.log(`  loss/win: ${(avgLoss / avgWin).toFixed(2)}x  (each stop wipes ${(avgLoss / avgWin).toFixed(1)} wins)`);
  console.log(`  E(trade): $${(winRate * avgWin - (1 - winRate) * avgLoss).toFixed(4)}`);

  // Simulate new parameters
  console.log('\n=== SIMULATED SCENARIOS ===');
  // If TP was bigger and SL was tighter, win rate drops but R:R improves
  // Using current avg std of $8.33
  const STD = 8.33;
  const scenarios = [
    { name: 'CURRENT',    tpSig: 1.5, slSig: 2.8 },
    { name: 'MODERATE',   tpSig: 2.0, slSig: 1.8 },
    { name: 'AGGRESSIVE', tpSig: 2.5, slSig: 1.5 },
    { name: 'BALANCED',   tpSig: 2.2, slSig: 1.6 },
  ];
  for (const sc of scenarios) {
    const tp = sc.tpSig * STD;
    const sl = sc.slSig * STD;
    const rr = tp / sl;
    const be = sl / (tp + sl); // breakeven win rate
    // Estimate win rate: based on spread change distribution
    const wouldTP = absSpreadChanges.filter(x => x >= tp).length;
    const estWinPct = wouldTP / absSpreadChanges.length;
    const estE = estWinPct * tp / 100 - (1 - estWinPct) * sl / 100; // rough $/contract
    console.log(`  ${sc.name}: TP=$${tp.toFixed(1)} SL=$${sl.toFixed(1)} R:R=${rr.toFixed(2)} ` +
      `breakeven=${(be * 100).toFixed(1)}% estWinRate=${(estWinPct * 100).toFixed(1)}% ` +
      `edgeVsBreakeven=${((estWinPct - be) * 100).toFixed(1)}pp`);
  }

  await sequelize.close();
})().catch(e => { console.error(e.message); process.exit(1); });
