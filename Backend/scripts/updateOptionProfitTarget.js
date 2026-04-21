#!/usr/bin/env node
/**
 * Set optionProfitTargetUsd = 2000 for BTC (pair 24) and ETH (pair 25).
 *
 *   node scripts/updateOptionProfitTarget.js
 *   node scripts/updateOptionProfitTarget.js --pairIds=24,25 --target=2000
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { StatArbInput, sequelize } = require('../src/models');

const args = process.argv.slice(2);
const pairIdsArg = args.find(a => a.startsWith('--pairIds='));
const targetArg  = args.find(a => a.startsWith('--target='));

const pairIds = pairIdsArg
  ? pairIdsArg.replace('--pairIds=', '').split(',').map(Number)
  : [24, 25];
const target = targetArg
  ? parseFloat(targetArg.replace('--target=', ''))
  : 2000;

(async () => {
  try {
    for (const id of pairIds) {
      const pair = await StatArbInput.findByPk(id);
      if (!pair) {
        console.warn(`  Pair ${id} not found — skipping`);
        continue;
      }
      const old = pair.optionProfitTargetUsd;
      await pair.update({ optionProfitTargetUsd: target });
      console.log(`  Pair ${id} (${pair.agentName || 'no agent'}): optionProfitTargetUsd ${old} → ${target}`);
    }
    console.log('\nDone.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
})();
