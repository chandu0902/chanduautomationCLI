#!/usr/bin/env node
/**
 * applyEthConfigFull.js
 *
 * Applies ALL pending ETH pair-22 config changes in one shot:
 *   - Fix stale optionInstruments (24APR-2300-C → 24APR-2350-C)
 *   - Sizing: qty1/qty2/maxQty1/maxLegAQty=94000, maxPositions=4, maxNetQtyImbalance=10
 *   - Sigma envelope: adaptSigmaMin=1.5, adaptSigmaMax=3.0, adaptTpSigma=3.0, adaptSlSigma=1.0
 *   - Timing: maxHoldMs=900000, entryPollTimeoutMs=90000
 *   - Bands (already live, verified): priceUpperLimit=2500, priceLowerLimit=2200
 *   - optionProfitTargetUsd=400 (already correct, verified)
 *
 * Safety guards:
 *   - Only touches pairId=22
 *   - Refuses if symbol1 doesn't include 'ETH'
 *   - Refuses if id !== 22
 *   - Prints diff and dry-runs by default; pass --live to persist
 */

'use strict';
require('dotenv').config();
const { StatArbInput } = require('../src/models');

const PAIR_ID = 22;

const UPDATES = {
  // Fix stale option watchlist (rolled from 2300-C to 2350-C)
  optionInstruments: JSON.stringify([
    { name: 'ETH-24APR26-2350-C', size: -100 },
    { name: 'ETH-29MAY26-2400-C', size: 150  },
  ]),

  // Sizing — 40 ETH max, 10 ETH/step, 4 steps
  qty1:               94000,
  qty2:               94000,
  maxQty1:            94000,
  maxLegAQty:         94000,
  maxLegBQty:         0,
  maxPositions:       4,
  maxNetQtyImbalance: 10,

  // Wider sigma envelope — levels auto-placed by scheduler each cycle
  adaptSigmaMin:  1.5,
  adaptSigmaMax:  3.0,
  adaptTpSigma:   3.0,
  adaptSlSigma:   1.0,

  // Timing
  maxHoldMs:           900000,   // 15 min (was 30 min)
  entryPollTimeoutMs:  90000,    // 90 s  (was null)

  // Bands and option profit target — already correct, re-assert
  priceUpperLimit:       2500,
  priceLowerLimit:       2200,
  optionProfitTargetUsd: 400,
};

(async () => {
  const live = process.argv.includes('--live');

  const pair = await StatArbInput.findByPk(PAIR_ID);
  if (!pair)              { console.error(`pair ${PAIR_ID} not found`); process.exit(1); }
  if (pair.id !== 22)     { console.error(`REFUSE: expected pair 22, got ${pair.id}`); process.exit(1); }
  if (!String(pair.symbol1).toUpperCase().includes('ETH')) {
    console.error(`REFUSE: pair ${pair.id} symbol1=${pair.symbol1} is not ETH`); process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  ETH pair ${pair.id}  (${pair.agentName})`);
  console.log(`║  symbol1=${pair.symbol1}   tradingEnabled=${pair.tradingEnabled}`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('  field                       current              → new');
  console.log('──────────────────────────────────────────────────────────────');

  for (const [k, v] of Object.entries(UPDATES)) {
    const curr = pair[k];
    const currStr = k === 'optionInstruments'
      ? String(curr).replace(/\s+/g, ' ').slice(0, 60)
      : String(curr);
    const newStr  = k === 'optionInstruments'
      ? String(v).replace(/\s+/g, ' ').slice(0, 60)
      : String(v);
    const changed = currStr !== newStr ? '  ← CHANGED' : '';
    console.log(`  ${k.padEnd(27)} ${currStr.padEnd(20)} → ${newStr}${changed}`);
  }

  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (!live) {
    console.log('\nDRY RUN — no changes written. Re-run with --live to persist.\n');
    process.exit(0);
  }

  await pair.update(UPDATES);

  const fresh = await StatArbInput.findByPk(PAIR_ID);
  console.log('\nAPPLIED. Verified DB values:');
  for (const k of Object.keys(UPDATES)) {
    const v = k === 'optionInstruments'
      ? String(fresh[k]).replace(/\s+/g, ' ')
      : fresh[k];
    console.log(`  ${k.padEnd(27)} = ${v}`);
  }
  console.log('\nNOTE: restart / re-enable the bot for all changes to take effect.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
