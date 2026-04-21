#!/usr/bin/env node
/**
 * updateBtcPair24Limits.js
 *
 * Fetch live BTC index price, compute ±$2000 price band around it,
 * save the previous pair-24 config as a JSON backup, update the DB,
 * and re-enable trading.
 *
 * Usage:
 *   node scripts/updateBtcPair24Limits.js           # dry-run
 *   node scripts/updateBtcPair24Limits.js --live    # apply + enable bot
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { StatArbInput, sequelize } = require('../src/models');

const PAIR_ID    = 24;
const HALF_BAND  = 2000;
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

async function fetchBtcPrice() {
  const r = await axios.get(
    'https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd',
    { timeout: 10000 }
  );
  return r.data.result.index_price;
}

(async () => {
  const live = process.argv.includes('--live');

  // ── 1. Fetch current price ───────────────────────────────────────────────
  const btcPrice  = await fetchBtcPrice();
  const lowerLimit = Math.round(btcPrice - HALF_BAND);
  const upperLimit = Math.round(btcPrice + HALF_BAND);

  console.log('────────────────────────────────────────────────────────────');
  console.log(` Live BTC index price : $${btcPrice.toLocaleString()}`);
  console.log(` New priceLowerLimit  : $${lowerLimit.toLocaleString()}  (price − $${HALF_BAND})`);
  console.log(` New priceUpperLimit  : $${upperLimit.toLocaleString()}  (price + $${HALF_BAND})`);
  console.log('────────────────────────────────────────────────────────────');

  // ── 2. Load current pair from DB ─────────────────────────────────────────
  await sequelize.authenticate();
  const pair = await StatArbInput.findByPk(PAIR_ID);
  if (!pair) {
    console.error(`ERROR: pair ${PAIR_ID} not found in DB`);
    process.exit(1);
  }
  if (!String(pair.symbol1).toUpperCase().includes('BTC') &&
      !String(pair.symbol2).toUpperCase().includes('BTC')) {
    console.error(`REFUSE: pair ${pair.id} does not appear to be a BTC pair (symbol1=${pair.symbol1})`);
    process.exit(1);
  }

  // ── 3. Print diff ─────────────────────────────────────────────────────────
  console.log(` pair ${pair.id}  (${pair.agentName})  symbol1=${pair.symbol1}`);
  console.log(` tradingEnabled  : ${pair.tradingEnabled}  →  true`);
  console.log('────────────────────────────────────────────────────────────');
  const fields = ['priceLowerLimit', 'priceUpperLimit', 'tradingEnabled'];
  const proposed = { priceLowerLimit: lowerLimit, priceUpperLimit: upperLimit, tradingEnabled: true };
  console.log(' field                     current          →  new');
  for (const k of fields) {
    const curr    = pair[k];
    const next    = proposed[k];
    const changed = String(curr) !== String(next) ? ' ←' : '';
    console.log(`  ${k.padEnd(25)} ${String(curr).padEnd(16)} →  ${next}${changed}`);
  }
  console.log('────────────────────────────────────────────────────────────');

  if (!live) {
    console.log('\nDRY RUN — no changes written. Re-run with --live to apply.\n');
    await sequelize.close();
    process.exit(0);
  }

  // ── 4. Save old config backup ─────────────────────────────────────────────
  const ts         = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, 'Z');
  const backupFile = path.join(REPORTS_DIR, `btc_pair24_config_backup_${ts}.json`);
  const snapshot   = pair.toJSON();
  fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2));
  console.log(`\nBackup saved → ${backupFile}`);

  // ── 5. Apply updates ───────────────────────────────────────────────────────
  await pair.update(proposed);

  const fresh = await StatArbInput.findByPk(PAIR_ID);
  console.log('\nAPPLIED. Verified DB values:');
  for (const k of fields) {
    console.log(`  ${k.padEnd(25)} = ${fresh[k]}`);
  }

  console.log('\n✓ Bot re-enabled. Price band set to');
  console.log(`  [$${lowerLimit.toLocaleString()} – $${upperLimit.toLocaleString()}]`);
  console.log('  The running executor will pick up tradingEnabled=true on its next loop tick.\n');

  await sequelize.close();
  process.exit(0);
})().catch(e => {
  console.error(e.response?.data || e.message || e);
  process.exit(1);
});
