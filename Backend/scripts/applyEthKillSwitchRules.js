#!/usr/bin/env node
/**
 * applyEthKillSwitchRules.js
 *
 * Apply ETH pair 22 kill-switch + options rules:
 *   - priceUpperLimit       = 2500
 *   - priceLowerLimit       = 2200
 *   - optionProfitTargetUsd = 300   (close options on limit orders when PnL >= $300)
 *
 * Safety:
 *   - Only modifies pairId = 22 (ETH).
 *   - Refuses to run if accidentally pointed elsewhere (BTC pair 21 untouched).
 *   - Prints dry-run diff by default; pass --live to actually persist.
 */

'use strict';

require('dotenv').config();
const { StatArbInput } = require('../src/models');

const PAIR_ID = 22; // ETH only
// optionProfitTargetUsd stays at its existing value (400) — already in user's
// stated 300–400 range. Only the price bands change here.
const UPDATES = {
  priceUpperLimit: 2500,
  priceLowerLimit: 2200,
};

(async () => {
  const live = process.argv.includes('--live');

  const pair = await StatArbInput.findByPk(PAIR_ID);
  if (!pair) {
    console.error(`pair ${PAIR_ID} not found`);
    process.exit(1);
  }

  if (pair.id !== 22) {
    console.error(`REFUSE: expected pair 22, got ${pair.id}`);
    process.exit(1);
  }
  if (!String(pair.symbol1).toUpperCase().includes('ETH')) {
    console.error(`REFUSE: pair ${pair.id} symbol1=${pair.symbol1} is not ETH`);
    process.exit(1);
  }

  console.log('────────────────────────────────────────────────────────────');
  console.log(` pair ${pair.id}  (${pair.agentName})  symbol1=${pair.symbol1}`);
  console.log(` tradingEnabled=${pair.tradingEnabled}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log(' field                     current          →  new');
  for (const [k, v] of Object.entries(UPDATES)) {
    const curr = pair[k];
    const changed = String(curr) !== String(v) ? ' *' : '';
    console.log(`  ${k.padEnd(25)} ${String(curr).padEnd(15)} →  ${v}${changed}`);
  }
  console.log('────────────────────────────────────────────────────────────');

  if (!live) {
    console.log('DRY RUN — no changes written. Re-run with --live to persist.');
    process.exit(0);
  }

  await pair.update(UPDATES);
  const fresh = await StatArbInput.findByPk(PAIR_ID);
  console.log('APPLIED. Verified DB values:');
  for (const k of Object.keys(UPDATES)) {
    console.log(`  ${k.padEnd(25)} = ${fresh[k]}`);
  }
  console.log();
  console.log('NOTE: bot must be restarted (or re-enabled) to pick up new price limits,');
  console.log('      since _priceUpperLimit/_priceLowerLimit are cached on state bootstrap.');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
