#!/usr/bin/env node
/**
 * Apply the data-driven optimal config (from btcFullInceptionAnalysis) to
 * the active BTC pair (default 24). Prints the BEFORE / AFTER diff and the
 * exact SQL it executed. Does NOT re-enable trading — run enable from the
 * UI / API separately.
 *
 *   node scripts/btcApplyOptimalConfigPair24.js
 *   node scripts/btcApplyOptimalConfigPair24.js --pairId=24
 *   node scripts/btcApplyOptimalConfigPair24.js --dry-run
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, StatArbInput } = require('../src/models');

function parseArgs() {
  let pairId = 24;
  let dry = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairId=')) pairId = parseInt(a.split('=')[1], 10) || 24;
    if (a === '--dry-run' || a === '--dry') dry = true;
  }
  return { pairId, dry };
}

// ── The target config (comes straight from SECTION 10 of the BTC full
// inception analysis — SIM-A/B/C/D/E composition).
const TARGET = {
  // Sizing
  maxPositions:         5,

  // Executor
  executorVersion:      'v2',

  // Entry filters
  minEdgeUsd:           1.5,
  trendFilterPct:       0.45,
  trendFilterWindowMs:  300000,
  trendPauseJumpPct:    null,
  trendPauseDurationMs: null,

  // Adaptive sigma bounds
  //   SigmaMin/Max  — entry gate, deeper entries only (SIM-C).
  //   adaptTpSigma  — KEEP WIDE (SIM-A: tighter TP hurts). 2.2 is the
  //                   current value; do not shrink.
  //   adaptSlSigma  — WIDEN (SIM-B: wider SL is the biggest +EV lever).
  //                   1.5 → 2.0 adds ~$8–10 to clamped SL given today's
  //                   rolling std; pair 24 will stop bleeding on the
  //                   sub-$25 reverts.
  adaptSigmaMin:        1.6,
  adaptSigmaMax:        2.7,
  adaptTpSigma:         2.2,
  adaptSlSigma:         2.0,

  // Exit behaviour
  // maxHoldMs 5 min replaces the previous 30 min. Any open trip older than
  // this is force-flattened (passive-first via scratch, taker if needed).
  maxHoldMs:            300000,
  grossNegativeScratchMs: 30000,

  // Risk (drawdown is measured vs session-start equity, not historical peak)
  dailyLossLimitUsd:    400,
  maxDrawdownUsd:       400,
  drawdownPct:          8,

  // NOTE: slSpreadDelta and tpSpreadDelta are adaptive and re-written by the
  // AdaptLevels scheduler on every refresh interval. Setting them in the DB
  // only changes the NEXT enable() bootstrap value. We leave them so the V2
  // floor clamp (adaptSlSigma * dollarStd) takes over immediately.
};

// SKIP_SHALLOW_LEVELS = drop the N shallowest levels from spreadEntryLevels.
// 2 is the SIM-C sweet spot (grid ≥ 3 outperformed on PF and net).
const SKIP_SHALLOW_LEVELS = 2;

async function main() {
  const { pairId, dry } = parseArgs();
  await sequelize.authenticate();

  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) { console.error(`pairId ${pairId} not found`); process.exit(1); }
  if (pair.tradingEnabled) {
    console.error(`pair ${pairId} is currently tradingEnabled=1 — stop it first, then re-run.`);
    process.exit(1);
  }

  // Trim shallow levels from spreadEntryLevels so SIM-C is enforced
  // regardless of adaptive reset.
  const origLevels = (pair.spreadEntryLevels || '').split(',').map(s=>s.trim()).filter(Boolean);
  const newLevels  = origLevels.length > SKIP_SHALLOW_LEVELS
    ? origLevels.slice(SKIP_SHALLOW_LEVELS).join(',')
    : origLevels.join(',');

  // Build diff
  const diff = [];
  for (const [k, v] of Object.entries(TARGET)) {
    const cur = pair[k];
    const same = (cur == null && v == null) || String(cur) === String(v);
    if (!same) diff.push({ col:k, before:cur, after:v });
  }
  if (newLevels !== (pair.spreadEntryLevels || '')) {
    diff.push({ col:'spreadEntryLevels', before:pair.spreadEntryLevels, after:newLevels });
  }

  if (diff.length === 0) {
    console.log(`pair ${pairId}: already at optimal config, no changes.`);
    await sequelize.close();
    return;
  }

  console.log('\n============================================================');
  console.log(` Apply optimal config — pair ${pairId} (${pair.agentName})`);
  console.log('============================================================');
  console.log('\nDIFF:');
  console.table(diff.map(d => ({ column: d.col, before: String(d.before ?? 'NULL'), after: String(d.after ?? 'NULL') })));

  if (dry) {
    console.log('\n(dry-run — no DB writes)');
    await sequelize.close();
    return;
  }

  const updatePayload = { ...TARGET, spreadEntryLevels: newLevels };
  await StatArbInput.update(updatePayload, { where:{ id:pairId } });

  console.log(`\nAPPLIED: ${diff.length} column(s) updated on statarb_inputs.id=${pairId}`);
  console.log(`New spreadEntryLevels (${newLevels.split(',').length} rungs): ${newLevels}`);
  console.log('\nNext steps:');
  console.log('  1. node scripts/btcFullInceptionAnalysis.js     # fresh report with new config ref');
  console.log('  2. Enable the pair via UI / API — enableTrading will now trigger the background');
  console.log('     inception-analysis hook and use V2 executor with widened SL + 5-min hold cap.');
  console.log();

  await sequelize.close();
}

main().catch(e => { console.error(e.stack || e.message || e); process.exit(1); });
