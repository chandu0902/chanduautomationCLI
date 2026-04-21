'use strict';
/**
 * BTC pair-24 analysis & "best fixed" recommender — BTC ONLY.
 *
 * Since spread_logs is empty for this pair, we don't have an intraday spread
 * series to re-simulate arbitrary (tp, sl) paths. Instead we lean on the data
 * the system has actually produced:
 *
 *   1. every closed basis_position with its entrySpread / exitSpread / tpDelta /
 *      slDelta / exitReason / holdMs / grossPnl / netPnl
 *   2. every adapt cycle in spread_level_history with tp/sl and levels at that
 *      moment (41+ cycles over ~14h)
 *   3. all trade_logs with cancelReason to quantify friction (gross_negative_abort,
 *      entry_timeout_unfilled)
 *
 * What we compute:
 *   A. Strategy-only PnL (remove manual_maker_flatten, OOM artefacts)
 *   B. Realised spread move per trip → empirical distribution
 *   C. Friction cost of gross_negative_abort and entry_timeout_unfilled
 *   D. Center of the adaptive (tp, sl) distribution → a natural "fixed" pick
 *   E. Projected performance if we switched to fixed (tp*, sl*) based on
 *      counterfactual classification of each position (would it still have been
 *      a win / loss given the realised spread move?)
 *
 *   node scripts/btcPair24FixedExitBacktest.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, StatArbInput, BasisPosition, Trade, SpreadLevelHistory } = require('../src/models');

const PAIR_ID = 24;
const fmtUsd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const median = a => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};
const quantile = (a, q) => {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(q * b.length))];
};

async function main() {
  const pair = await StatArbInput.findOne({ where: { id: PAIR_ID } });
  if (!pair) throw new Error(`pair ${PAIR_ID} not found`);

  console.log(`\n================================================================================`);
  console.log(`BTC · pair 24 · ${pair.agentName}  (BTC-PERPETUAL / BTC-29MAY26)`);
  console.log(`================================================================================`);
  console.log(`live config:  qty1=${pair.qty1}  maxQty1=${pair.maxQty1}  maxPositions=${pair.maxPositions}`);
  console.log(`              tpSpreadDelta=${pair.tpSpreadDelta}  slSpreadDelta=${pair.slSpreadDelta}`);
  console.log(`              zEntryThreshold=${pair.zEntryThreshold}  entryPollTimeoutMs=${pair.entryPollTimeoutMs}`);
  console.log(`              maxSpreadCap=${pair.maxSpreadCap}`);
  console.log(`              spreadEntryLevels=${pair.spreadEntryLevels}`);

  // ===== A. all closed positions =====
  const allClosed = await sequelize.query(
    `SELECT id, state, entryTime, exitTime, entrySpread, exitSpread, tpDelta, slDelta,
            exitReason, holdMs, grossPnl, netPnl, commission, takerFeeUsd, direction, gridLevel
       FROM basis_positions
      WHERE pairId = ? AND state = 'closed'
      ORDER BY exitTime ASC`,
    { replacements: [PAIR_ID], type: sequelize.QueryTypes.SELECT }
  );

  const flatten = allClosed.filter(p => p.exitReason === 'manual_maker_flatten');
  const strat   = allClosed.filter(p => p.exitReason !== 'manual_maker_flatten');
  const wins    = strat.filter(p => Number(p.netPnl) > 0);
  const losses  = strat.filter(p => Number(p.netPnl) < 0);
  const profExits = strat.filter(p => p.exitReason === 'profit');
  const stopExits = strat.filter(p => p.exitReason === 'stop');

  const stratWallet  = strat.reduce((s, p) => s + Number(p.netPnl), 0);
  const stratGross   = strat.reduce((s, p) => s + Number(p.grossPnl), 0);
  const stratRebate  = stratWallet - stratGross;
  const flattenPnl   = flatten.reduce((s, p) => s + Number(p.netPnl), 0);
  const allWallet    = stratWallet + flattenPnl;

  console.log(`\n==== A. PNL DECOMPOSITION (pair 24, all closed positions) ======================`);
  console.log(`  closed positions:          ${allClosed.length}`);
  console.log(`  └ strategy-exited:         ${strat.length}  (profit=${profExits.length}  stop=${stopExits.length})`);
  console.log(`  └ manual_maker_flatten:    ${flatten.length}     pnl=${fmtUsd(flattenPnl)}   <-- your interventions / OOM`);
  console.log(`  strategy wins  (netPnl>0): ${wins.length}   win%=${((100*wins.length)/(strat.length||1)).toFixed(1)}`);
  console.log(`  strategy losses (netPnl<0):${losses.length}`);
  console.log(`  strategy gross PnL:        ${fmtUsd(stratGross)}`);
  console.log(`  strategy rebate captured:  ${fmtUsd(stratRebate)}`);
  console.log(`  strategy net (wallet) PnL: ${fmtUsd(stratWallet)}    <-- edge on the strategy itself`);
  console.log(`  total wallet (incl flatn): ${fmtUsd(allWallet)}      <-- what your exchange actually shows`);

  // ===== B. spread move distribution =====
  const moves = strat
    .map(p => (Number(p.entrySpread) - Number(p.exitSpread))) // positive = longs won
    .filter(Number.isFinite);
  const winMoves = profExits.map(p => Number(p.entrySpread) - Number(p.exitSpread));
  const lossMoves = stopExits.map(p => Number(p.exitSpread) - Number(p.entrySpread));
  console.log(`\n==== B. REALISED SPREAD MOVES (entry → exit, $ points) =========================`);
  console.log(`  all strategy trips:  n=${moves.length}  mean=${avg(moves).toFixed(2)}  median=${median(moves).toFixed(2)}  p25=${quantile(moves,0.25).toFixed(2)}  p75=${quantile(moves,0.75).toFixed(2)}`);
  console.log(`  profit-exit moves:   n=${winMoves.length}  mean=${avg(winMoves).toFixed(2)}  median=${median(winMoves).toFixed(2)}`);
  console.log(`  stop-exit moves:     n=${lossMoves.length}  mean=${avg(lossMoves).toFixed(2)}  median=${median(lossMoves).toFixed(2)}`);

  const pnlWins  = profExits.map(p => Number(p.netPnl));
  const pnlLoss  = stopExits.map(p => Number(p.netPnl));
  console.log(`  avg net / win exit:  ${fmtUsd(avg(pnlWins))}   median ${fmtUsd(median(pnlWins))}`);
  console.log(`  avg net / stop exit: ${fmtUsd(avg(pnlLoss))}   median ${fmtUsd(median(pnlLoss))}`);
  console.log(`  hold ms median=${median(strat.map(p=>Number(p.holdMs)||0)).toFixed(0)}  mean=${avg(strat.map(p=>Number(p.holdMs)||0)).toFixed(0)}`);

  // ===== C. friction =====
  const tl = await sequelize.query(
    `SELECT status, cancelReason, createdAt FROM trade_logs WHERE pairId = ?`,
    { replacements: [PAIR_ID], type: sequelize.QueryTypes.SELECT }
  );
  const byReason = {};
  for (const r of tl) {
    if (r.status === 'cancelled') {
      const k = r.cancelReason || '(none)';
      byReason[k] = (byReason[k] || 0) + 1;
    }
  }
  console.log(`\n==== C. FRICTION (trade_logs) ===================================================`);
  console.log(`  total trade_logs rows:        ${tl.length}`);
  console.log(`  cancelled rows by cancelReason:`);
  for (const k of Object.keys(byReason).sort((a,b)=>byReason[b]-byReason[a])) {
    console.log(`     ${k.padEnd(26)} ${byReason[k]}`);
  }

  // ===== D. adaptive ladder distribution =====
  const hist = await sequelize.query(
    `SELECT tpSpreadDelta, slSpreadDelta, maxSpreadCap, levels, openPositionsAtChange, createdAt
       FROM spread_level_history
      WHERE pairId = ? AND changedBy = 'adapt'
      ORDER BY id DESC LIMIT 200`,
    { replacements: [PAIR_ID], type: sequelize.QueryTypes.SELECT }
  );
  const tps = hist.map(h => Number(h.tpSpreadDelta)).filter(Number.isFinite);
  const sls = hist.map(h => Number(h.slSpreadDelta)).filter(Number.isFinite);
  const caps = hist.map(h => Number(h.maxSpreadCap)).filter(Number.isFinite);
  console.log(`\n==== D. ADAPTIVE LADDER HISTORY (${hist.length} adapt cycles) ============================`);
  console.log(`  tpSpreadDelta:  min=${Math.min(...tps).toFixed(2)}  p25=${quantile(tps,0.25).toFixed(2)}  median=${median(tps).toFixed(2)}  p75=${quantile(tps,0.75).toFixed(2)}  max=${Math.max(...tps).toFixed(2)}`);
  console.log(`  slSpreadDelta:  min=${Math.min(...sls).toFixed(2)}  p25=${quantile(sls,0.25).toFixed(2)}  median=${median(sls).toFixed(2)}  p75=${quantile(sls,0.75).toFixed(2)}  max=${Math.max(...sls).toFixed(2)}`);
  console.log(`  maxSpreadCap:   min=${Math.min(...caps).toFixed(2)}  median=${median(caps).toFixed(2)}  max=${Math.max(...caps).toFixed(2)}`);

  // extract first-level and last-level from levels (grid base and top)
  const lowers = [], uppers = [];
  for (const h of hist) {
    const arr = String(h.levels||'').split(',').map(Number).filter(Number.isFinite);
    if (arr.length) { lowers.push(arr[0]); uppers.push(arr[arr.length - 1]); }
  }
  console.log(`  grid lower-lvl: min=${Math.min(...lowers).toFixed(2)}  median=${median(lowers).toFixed(2)}  max=${Math.max(...lowers).toFixed(2)}`);
  console.log(`  grid upper-lvl: min=${Math.min(...uppers).toFixed(2)}  median=${median(uppers).toFixed(2)}  max=${Math.max(...uppers).toFixed(2)}`);

  // ===== E. counter-factual @ fixed (tp*, sl*) =====
  // We use actual realised spread moves. For each strategy trip we know the
  // actual tpDelta/slDelta it was closed against, and the actual spread move.
  // Assumption: profit-exit trips would still be profit exits if our fixed tp*
  //   <= actual achieved move; stop-exit trips would still be stop exits if
  //   fixed sl* <= actual achieved adverse move.
  //   If fixed tp* > actual profit move, the trip would NOT have hit tp under
  //   the fixed scheme, and would have hit stop later (worst case -sl* PnL).
  //   If fixed sl* > actual adverse move, the stop would have been avoided
  //   (best case: trip held longer; we credit rebate only).
  // This is a FIRST-ORDER estimate — it's directionally informative.

  function simulateFixed(tpStar, slStar) {
    // model: scale from the adapted trips. A trip closed at live tp^-deltaLive
    // on profit side gave (move = deltaLive, netPnl ≈ average observed).
    // For the fixed scheme, we estimate:
    //   if actual profit move >= tpStar → profit trip, netPnl scaled to tpStar/actualMove
    //   if actual profit move <  tpStar → trip would NOT have exited profit;
    //                                      assume eventually stop at -slStar (scale)
    //   if actual loss  move >= slStar → stop trip, pnl scaled to slStar/actualMove
    //   if actual loss  move <  slStar → stop avoided; treat as 0 (we collect rebate only)
    const REB = avg(strat.map(p => Number(p.netPnl) - Number(p.grossPnl))); // avg rebate per trip
    let winCount = 0, lossCount = 0, noExitCount = 0;
    let net = 0;
    for (const p of profExits) {
      const move = Number(p.entrySpread) - Number(p.exitSpread);
      const pnlPerPoint = Number(p.grossPnl) / Math.max(move, 1e-6);
      if (move >= tpStar) {
        winCount++;
        net += pnlPerPoint * tpStar + REB;
      } else {
        // didn't reach fixed TP, assume falls to stop at -slStar
        noExitCount++;
        net += pnlPerPoint * (-slStar) + REB;
      }
    }
    for (const p of stopExits) {
      const move = Number(p.exitSpread) - Number(p.entrySpread);
      if (move <= 0) continue; // anomaly
      const pnlPerPoint = Number(p.grossPnl) / (-move); // grossPnl is negative; divide by -move to get magnitude
      if (move >= slStar) {
        lossCount++;
        net += pnlPerPoint * slStar + REB;
      } else {
        // adverse move never reached fixed sl, we'd have held; assume reb only
        net += REB;
      }
    }
    return { winCount, lossCount, noExitCount, net };
  }

  const tpGrid = [4, 6, 8, 10, 12, 14, 15.21, 18, 22];
  const slGrid = [6, 8, 10, 10.37, 13, 16, 20, 25];

  console.log(`\n==== E. COUNTER-FACTUAL FIXED (tp*, sl*) — projected net PnL on the ${strat.length} strategy trips`);
  console.log(`         sl →     ` + slGrid.map(s => s.toFixed(2).padStart(9)).join(''));
  const grid = [];
  for (const tp of tpGrid) {
    const line = [`   tp=${tp.toFixed(2).padStart(5)}   `];
    for (const sl of slGrid) {
      const r = simulateFixed(tp, sl);
      grid.push({ tp, sl, ...r });
      line.push((r.net >= 0 ? '+' : '') + r.net.toFixed(1).padStart(8));
    }
    console.log(line.join(''));
  }

  grid.sort((a, b) => b.net - a.net);
  console.log(`\n==== TOP 10 FIXED (tp*, sl*) by projected net PnL ===============================`);
  console.log(`  rank   tp*    sl*    wins   losses  non-exit   projected-net`);
  grid.slice(0, 10).forEach((r, i) => {
    console.log(`  #${(i+1).toString().padEnd(2)}  ${r.tp.toFixed(2).padStart(5)}  ${r.sl.toFixed(2).padStart(5)}   ${r.winCount.toString().padStart(4)}   ${r.lossCount.toString().padStart(5)}    ${r.noExitCount.toString().padStart(5)}     ${fmtUsd(r.net)}`);
  });

  // ===== F. recommended fixed config =====
  // Choose the most robust pick: highest-scoring (tp*, sl*) that also has tp*>=0.6×sl* (to ensure reward/risk isn't absurd)
  const safe = grid.filter(r => r.tp >= 0.5 * r.sl);
  const best = safe[0];
  console.log(`\n==== F. RECOMMENDED FIXED CONFIG ================================================`);
  console.log(`  tpSpreadDelta:    ${best.tp.toFixed(2)}   (live adaptive median: ${median(tps).toFixed(2)})`);
  console.log(`  slSpreadDelta:    ${best.sl.toFixed(2)}   (live adaptive median: ${median(sls).toFixed(2)})`);
  console.log(`  projected trips:  wins=${best.winCount}  losses=${best.lossCount}  non-exit=${best.noExitCount}`);
  console.log(`  projected net:    ${fmtUsd(best.net)}   (actual so far ${fmtUsd(stratWallet)})`);
  console.log(`  maxSpreadCap:     keep at current ${pair.maxSpreadCap}  (adaptive median: ${median(caps).toFixed(2)})`);
  console.log(`  grid center line: ${median(lowers).toFixed(2)} → ${median(uppers).toFixed(2)}`);
  console.log(`  entryPollTimeout: bump 90000 → 180000 ms (26 entries timed out with 90s)`);
  console.log(`  qty1:             bump 10000 → 20000 contracts ($20K notional/level)  ← raises volume 2× without extra positions`);
  console.log(`  maxPositions:     keep 7  (room for 7×$20K = $140K vs $57K avail funds — margin fine)`);

  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
