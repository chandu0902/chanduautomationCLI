#!/usr/bin/env node
/**
 * Backtest: what if adapt ran every 2h instead of the actual frequency?
 *
 * Logic:
 *   1. Pull all SpreadLevelHistory rows (changedBy='adapt') for pair 19 over the last 48h.
 *   2. Pull all BasisPosition rows (state='closed') for same window.
 *   3. For each closed position, find which adapt row was "active" at its entryTime.
 *   4. Scenario A (actual): use the real adapt row that was active.
 *   5. Scenario B (2h): only keep adapt rows that are >=2h apart; skip intermediate ones.
 *   6. For each scenario, compute which TP/SL would have applied to each trade,
 *      and whether the trade outcome changes (same position, different exit params).
 *
 *   Since we can't replay the orderbook, we approximate:
 *     - Each position's spreadDelta at exit = exitSpread - fillSpread (already recorded).
 *     - Under each scenario's TP/SL, we check: would the TP or SL have triggered first?
 *     - If the actual exit reason matches what the scenario would produce, outcome is same.
 *     - If different TP/SL would flip the exit, we flag it.
 *
 *   This is an approximation: we use the recorded spreadDelta trajectory endpoint,
 *   not the full path. But it tells us how many trades had TP/SL that was "close" to flipping.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, SpreadLevelHistory, BasisPosition } = require('../src/models');
const { Op } = require('sequelize');

const PAIR_ID = 19;
const WINDOW_HOURS = 60;

async function main() {
  await sequelize.authenticate();

  const since = new Date(Date.now() - WINDOW_HOURS * 3600000);

  const adapts = await SpreadLevelHistory.findAll({
    where: {
      pairId: PAIR_ID,
      changedBy: 'adapt',
      createdAt: { [Op.gte]: since },
    },
    order: [['createdAt', 'ASC']],
    raw: true,
  });

  const positions = await BasisPosition.findAll({
    where: {
      pairId: PAIR_ID,
      state: 'closed',
      exitTime: { [Op.gte]: since },
    },
    order: [['entryTime', 'ASC']],
    raw: true,
  });

  console.log(`Adapt rows (changedBy=adapt) in window: ${adapts.length}`);
  console.log(`Closed positions in window: ${positions.length}`);
  console.log('');

  if (adapts.length === 0) {
    console.log('No adapt rows found — nothing to backtest.');
    await sequelize.close();
    return;
  }

  // Show adapt timing
  const gaps = [];
  for (let i = 1; i < adapts.length; i++) {
    const gap = (new Date(adapts[i].createdAt) - new Date(adapts[i - 1].createdAt)) / 60000;
    gaps.push(gap);
  }
  if (gaps.length) {
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    console.log(`Adapt intervals (min): avg=${avgGap.toFixed(1)}  min=${minGap.toFixed(1)}  max=${maxGap.toFixed(1)}`);
  }

  // Scenario A: actual adapts (all of them)
  const scenA = [...adapts];

  // Scenario B: 2h filter — keep an adapt only if >=120min since last kept
  const scenB = [adapts[0]];
  for (let i = 1; i < adapts.length; i++) {
    const lastKept = scenB[scenB.length - 1];
    const gapMin = (new Date(adapts[i].createdAt) - new Date(lastKept.createdAt)) / 60000;
    if (gapMin >= 120) {
      scenB.push(adapts[i]);
    }
  }

  console.log(`Scenario A (actual): ${scenA.length} adapt events`);
  console.log(`Scenario B (2h min):  ${scenB.length} adapt events`);
  console.log('');

  // For each position, find which TP/SL was active at entry under each scenario
  function findActiveAdapt(adaptList, entryTime) {
    const et = new Date(entryTime).getTime();
    let active = null;
    for (const a of adaptList) {
      if (new Date(a.createdAt).getTime() <= et) {
        active = a;
      } else {
        break;
      }
    }
    return active;
  }

  // Analyze each position under both scenarios
  let aWins = 0, aLosses = 0, aPl = 0;
  let bWins = 0, bLosses = 0, bPl = 0;
  let flipped = 0;
  let bothSame = 0;
  let aNoAdapt = 0, bNoAdapt = 0;

  const aTpSlPairs = new Set();
  const bTpSlPairs = new Set();

  for (const pos of positions) {
    const spreadDelta = Number(pos.spreadDelta) || 0;
    const actualPnl = Number(pos.netPnl) || 0;
    const actualReason = pos.exitReason;

    // Scenario A
    const aAdapt = findActiveAdapt(scenA, pos.entryTime);
    // Scenario B
    const bAdapt = findActiveAdapt(scenB, pos.entryTime);

    if (!aAdapt) { aNoAdapt++; }
    if (!bAdapt) { bNoAdapt++; }

    // Use the adapt's TP/SL if available, otherwise use position's actual outcome
    const aTp = aAdapt ? aAdapt.tpSpreadDelta : null;
    const aSl = aAdapt ? aAdapt.slSpreadDelta : null;
    const bTp = bAdapt ? bAdapt.tpSpreadDelta : null;
    const bSl = bAdapt ? bAdapt.slSpreadDelta : null;

    if (aTp != null) aTpSlPairs.add(`${aTp.toFixed(2)}/${aSl.toFixed(2)}`);
    if (bTp != null) bTpSlPairs.add(`${bTp.toFixed(2)}/${bSl.toFixed(2)}`);

    // Under scenario A (actual), use real outcome
    aPl += actualPnl;
    if (actualReason === 'profit') aWins++;
    else if (actualReason === 'stop') aLosses++;

    // Under scenario B, check if different TP/SL would flip the outcome
    // spreadDelta > 0 means spread widened (bad for long basis); < 0 means narrowed (good)
    // TP triggers when spread narrows by >= TP (spreadNarrowing >= TP)
    // SL triggers when spread widens by >= SL (spreadDelta >= SL from fill)
    // We only have the endpoint, not the path, so we compare the actual TP/SL vs scenario B's
    if (bTp != null && aTp != null) {
      const sameTpSl = (Math.abs(aTp - bTp) < 0.01 && Math.abs(aSl - bSl) < 0.01);
      if (sameTpSl) {
        // Same params → same outcome
        bPl += actualPnl;
        if (actualReason === 'profit') bWins++;
        else if (actualReason === 'stop') bLosses++;
        bothSame++;
      } else {
        // Different TP/SL — estimate outcome
        // If actual was profit exit: spread narrowed enough for TP hit
        //   Under B's TP: if B's TP <= A's TP, it would also have hit (maybe earlier/later)
        //   If B's TP > A's TP, it might NOT have hit → could become a stop instead
        // If actual was stop exit: spread widened past SL
        //   Under B's SL: if B's SL < A's SL, it would have stopped earlier (smaller loss)
        //   If B's SL > A's SL, it might NOT have stopped → could become profit instead
        if (actualReason === 'profit') {
          // Narrowing was >= aTp. Would it also be >= bTp?
          // We don't know the peak narrowing, only that it was enough for aTp.
          // Heuristic: if bTp <= aTp, yes. If bTp > aTp, uncertain.
          if (bTp <= aTp) {
            bPl += actualPnl;
            bWins++;
          } else {
            // B's TP is harder to hit. Could flip to stop.
            // Assign as uncertain — use a scaled estimate
            // If bTp is only slightly larger, probably still hits.
            // If bTp is much larger, probably doesn't.
            const ratio = aTp / bTp;
            if (ratio > 0.7) {
              bPl += actualPnl * ratio;
              bWins++;
            } else {
              // Likely becomes a stop under B
              const estLoss = -Math.abs(bSl) * (Math.abs(actualPnl) / Math.abs(aTp));
              bPl += estLoss;
              bLosses++;
              flipped++;
            }
          }
        } else if (actualReason === 'stop') {
          // Spread widened >= aSl. Under B:
          if (bSl <= aSl) {
            // B stops earlier → smaller loss
            const scale = bSl / aSl;
            bPl += actualPnl * scale;
            bLosses++;
          } else {
            // B has wider SL. The spread might not have reached bSl.
            // If the actual widening was between aSl and bSl, it would have survived.
            // We don't know the peak widening path, but heuristic:
            const ratio = aSl / bSl;
            if (ratio > 0.8) {
              // Probably still stopped out
              bPl += actualPnl;
              bLosses++;
            } else {
              // Might have survived → could flip to profit eventually
              // Conservative: give it 0 PnL (break even)
              bPl += 0;
              flipped++;
            }
          }
        } else {
          bPl += actualPnl;
        }
      }
    } else {
      bPl += actualPnl;
      if (actualReason === 'profit') bWins++;
      else if (actualReason === 'stop') bLosses++;
    }
  }

  console.log('========================================');
  console.log('BACKTEST RESULTS (last 60h, pair 19)');
  console.log('========================================');
  console.log('');
  console.log(`Closed positions analyzed: ${positions.length}`);
  console.log(`Positions where no adapt was active yet: A=${aNoAdapt} B=${bNoAdapt}`);
  console.log(`Positions with identical TP/SL in both scenarios: ${bothSame}`);
  console.log(`Positions where outcome potentially flipped: ${flipped}`);
  console.log('');
  console.log('Scenario A (actual ~30–60min adapt):');
  console.log(`  unique TP/SL sets used: ${aTpSlPairs.size}`);
  console.log(`  wins: ${aWins}  losses: ${aLosses}  W/L: ${aLosses > 0 ? (aWins / aLosses).toFixed(4) : 'inf'}`);
  console.log(`  DB sum netPnl: $${aPl.toFixed(4)}`);
  console.log('');
  console.log('Scenario B (2h adapt, skip intermediate):');
  console.log(`  unique TP/SL sets used: ${bTpSlPairs.size}`);
  console.log(`  wins: ${bWins}  losses: ${bLosses}  W/L: ${bLosses > 0 ? (bWins / bLosses).toFixed(4) : 'inf'}`);
  console.log(`  est. sum netPnl: $${bPl.toFixed(4)}`);
  console.log('');

  const diff = bPl - aPl;
  console.log(`Difference (B − A): $${diff.toFixed(4)}  ${diff > 0 ? '(2h better)' : diff < 0 ? '(actual better)' : '(same)'}`);

  // Show the TP/SL distribution for each scenario
  console.log('');
  console.log('Scenario A — TP/SL sets used:');
  for (const s of [...aTpSlPairs].sort()) console.log(`  tp/sl = ${s}`);
  console.log('');
  console.log('Scenario B — TP/SL sets used:');
  for (const s of [...bTpSlPairs].sort()) console.log(`  tp/sl = ${s}`);

  // Also show: what was the avg TP and avg SL in each scenario across all positions
  let aTpSum = 0, aSlSum = 0, aTpN = 0;
  let bTpSum = 0, bSlSum = 0, bTpN = 0;
  for (const pos of positions) {
    const aA = findActiveAdapt(scenA, pos.entryTime);
    const bA = findActiveAdapt(scenB, pos.entryTime);
    if (aA) { aTpSum += aA.tpSpreadDelta; aSlSum += aA.slSpreadDelta; aTpN++; }
    if (bA) { bTpSum += bA.tpSpreadDelta; bSlSum += bA.slSpreadDelta; bTpN++; }
  }
  console.log('');
  console.log('Weighted avg TP/SL seen by positions:');
  if (aTpN) console.log(`  A: avgTP=${(aTpSum / aTpN).toFixed(2)}  avgSL=${(aSlSum / aTpN).toFixed(2)}  SL/TP=${(aSlSum / aTpSum).toFixed(3)}`);
  if (bTpN) console.log(`  B: avgTP=${(bTpSum / bTpN).toFixed(2)}  avgSL=${(bSlSum / bTpN).toFixed(2)}  SL/TP=${(bSlSum / bTpSum).toFixed(3)}`);

  await sequelize.close();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
