#!/usr/bin/env node
/**
 * Apply ETH-only (pair 22) config update. Reference-only use of BTC (pair 21).
 * BTC is NEVER read-for-write, NEVER modified.
 *
 *   node scripts/applyEthConfigV2.js            # dry-run diff
 *   node scripts/applyEthConfigV2.js --live     # write to DB (pair 22 ONLY)
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, StatArbInput } = require('../src/models');

const TARGET_PAIR_ID = 22;
const FORBIDDEN_PAIR_IDS = [21];

const NEW = {
  tpSpreadDelta: 0.2700,
  slSpreadDelta: 0.0800,
  maxPositions: 3,
  spreadEntryLevels: '1.832,1.893,1.954',
  maxSpreadCap: 1.994,
  adaptSigmaMin: 0.5,
  adaptSigmaMax: 2.0,
  adaptTpSigma: 2.5,
  adaptSlSigma: 1.0,
  maxHoldMs: 900000,
  maxNetQtyImbalance: 10,
  priceUpperLimit: 2460,
  priceLowerLimit: 2180,
  entryPollTimeoutMs: 90000,
  dailyLossLimitUsd: 700,
};
NEW.adaptSigmaMin = 1.0;

async function main() {
  const live = process.argv.includes('--live');

  if (FORBIDDEN_PAIR_IDS.includes(TARGET_PAIR_ID)) {
    throw new Error(`REFUSING: target pair ${TARGET_PAIR_ID} is in forbidden list ${FORBIDDEN_PAIR_IDS}`);
  }

  const pair = await StatArbInput.findByPk(TARGET_PAIR_ID);
  if (!pair) throw new Error(`pair ${TARGET_PAIR_ID} not found`);

  const name = (pair.agentName || '').toUpperCase();
  if (!name.includes('ETH')) {
    throw new Error(`REFUSING: pair ${TARGET_PAIR_ID} agent ${pair.agentName} does not contain "ETH" — refusing to write.`);
  }

  console.log(`Target pair: ${TARGET_PAIR_ID}  agent=${pair.agentName}  symbol=${pair.symbol1}`);
  console.log(`Forbidden pairs (BTC, reference only): ${FORBIDDEN_PAIR_IDS.join(',')}`);
  console.log('');
  console.log('Proposed changes (diff):');
  console.log('  field                    current               proposed');
  console.log('  ----                     -------               --------');
  const changes = [];
  for (const k of Object.keys(NEW)) {
    const cur = pair[k];
    const next = NEW[k];
    if (String(cur) !== String(next)) {
      changes.push([k, cur, next]);
      console.log(`  ${k.padEnd(24)} ${String(cur).padEnd(20)} -> ${next}`);
    } else {
      console.log(`  ${k.padEnd(24)} ${String(cur).padEnd(20)} (unchanged)`);
    }
  }
  console.log('');
  console.log(`Fields to update: ${changes.length}`);

  if (!live) {
    console.log('\n(dry-run — re-run with --live to apply to DB)');
    await sequelize.close();
    return;
  }

  await pair.update(NEW);
  console.log('\nApplied. Verifying by re-reading row...');
  const after = await StatArbInput.findByPk(TARGET_PAIR_ID);
  for (const [k] of changes) {
    console.log(`  ${k.padEnd(24)} now = ${after[k]}`);
  }

  for (const forbId of FORBIDDEN_PAIR_IDS) {
    const ref = await StatArbInput.findByPk(forbId, { raw: true });
    console.log(`\nSanity check — BTC pair ${forbId} NOT modified (updatedAt=${ref.updatedAt.toISOString()}):`);
    console.log(`  tpSpreadDelta=${ref.tpSpreadDelta} slSpreadDelta=${ref.slSpreadDelta} maxPositions=${ref.maxPositions}`);
  }

  await sequelize.close();
}

main().catch(async (e) => { console.error('ERR:', e.message, e.stack); try { await sequelize.close(); } catch (_) {} process.exit(1); });
