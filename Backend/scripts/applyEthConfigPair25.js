#!/usr/bin/env node
/**
 * Apply ETH-only (pair 25) profitability rewrite config.
 * Writes to Backend/src/models/Pair.js columns for pair 25 ONLY.
 * BTC pair 24 (and all other pairs) are NEVER read-for-write, NEVER modified.
 *
 *   node scripts/applyEthConfigPair25.js            # dry-run diff
 *   node scripts/applyEthConfigPair25.js --live     # write to DB (pair 25 ONLY)
 *
 * Guarantees
 *   • Refuses if TARGET_PAIR_ID is in FORBIDDEN_PAIR_IDS.
 *   • Refuses if pair.agentName does not contain "ETH".
 *   • Refuses if pair.symbol1 does not contain "ETH".
 *   • After write, re-reads FORBIDDEN pairs to print their updatedAt +
 *     critical fields as a sanity check (nothing should have changed).
 *
 * Rollback
 *   UPDATE "StatArbInputs" SET
 *     "fixedTpUsd" = NULL,
 *     "maxSingleTradeLossUsd" = NULL,
 *     "grossNegativeScratchMs" = NULL,
 *     "entryRequoteOnMovePx" = NULL,
 *     "adaptMinTpSlRatio" = NULL,
 *     "trendPauseJumpPct" = NULL,
 *     "trendPauseDurationMs" = NULL
 *   WHERE id = 25;
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, StatArbInput } = require('../src/models');

const TARGET_PAIR_ID     = 25;
const FORBIDDEN_PAIR_IDS = [20, 21, 22, 23, 24];

// ── Proposed pair-25 values ─────────────────────────────────────────────────
// NEW fields require the Pair.js migration (adds 7 nullable columns).
// Existing fields are tightened / backfilled.
const NEW = {
  // Existing fields
  entryPollTimeoutMs:    30000,      // was 90000 — tighter, fewer stale quotes
  maxHoldMs:             600000,     // 10 min hard hold cap
  adaptTpSigma:          2.5,
  adaptSlSigma:          1.0,
  adaptSigmaMin:         1.2,
  adaptSigmaMax:         3.0,

  // NEW columns (all NULL on BTC → no-op on BTC)
  fixedTpUsd:            3.50,       // primary profitability lever
  maxSingleTradeLossUsd: 20,         // hard per-RT loss cap
  grossNegativeScratchMs: 45000,     // kills abort cascade
  entryRequoteOnMovePx:  0.40,       // re-quote on mid drift
  adaptMinTpSlRatio:     2.0,        // TP floor in adapter
  trendPauseJumpPct:     0.20,       // pause entries on 20%+ cap jumps
  trendPauseDurationMs:  300000,     // pause for 5 min
};

// Keys that are NEW in the model (used to warn if the column is missing,
// e.g. if server.js hasn't been restarted to pick up the migration yet).
const NEW_KEYS = new Set([
  'fixedTpUsd',
  'maxSingleTradeLossUsd',
  'grossNegativeScratchMs',
  'entryRequoteOnMovePx',
  'adaptMinTpSlRatio',
  'trendPauseJumpPct',
  'trendPauseDurationMs',
]);

async function main() {
  const live = process.argv.includes('--live');

  // Guard 1: target pair must not be in forbidden list.
  if (FORBIDDEN_PAIR_IDS.includes(TARGET_PAIR_ID)) {
    throw new Error(`REFUSING: target pair ${TARGET_PAIR_ID} is in forbidden list ${FORBIDDEN_PAIR_IDS}`);
  }

  // Guard 2: target pair must exist.
  const pair = await StatArbInput.findByPk(TARGET_PAIR_ID);
  if (!pair) throw new Error(`pair ${TARGET_PAIR_ID} not found`);

  // Guard 3: agent name must contain ETH.
  const name = (pair.agentName || '').toUpperCase();
  if (!name.includes('ETH')) {
    throw new Error(`REFUSING: pair ${TARGET_PAIR_ID} agent ${pair.agentName} does not contain "ETH" — refusing to write.`);
  }

  // Guard 4: symbol1 must contain ETH (defence-in-depth).
  const sym1 = (pair.symbol1 || '').toUpperCase();
  if (!sym1.includes('ETH')) {
    throw new Error(`REFUSING: pair ${TARGET_PAIR_ID} symbol1=${pair.symbol1} does not contain "ETH" — refusing to write.`);
  }

  // Guard 5: verify the model has the new columns (server must have been
  // restarted after the Pair.js migration so sync({alter:true}) created them).
  const modelAttrs = StatArbInput.rawAttributes || {};
  const missing = [...NEW_KEYS].filter((k) => !(k in modelAttrs));
  if (missing.length > 0) {
    throw new Error(
      `REFUSING: new columns not present on model: ${missing.join(', ')}. ` +
      `Restart the API (server.js sequelize.sync({alter:true})) to create them first.`
    );
  }

  console.log(`Target pair:        ${TARGET_PAIR_ID}  agent=${pair.agentName}  symbol=${pair.symbol1}`);
  console.log(`Forbidden pairs:    ${FORBIDDEN_PAIR_IDS.join(', ')}  (reference only, never written)`);
  console.log(`Executor:           unilateralExecutor.js  (V1)`);
  console.log('');
  console.log('Proposed changes (diff):');
  console.log('  field                       current               proposed');
  console.log('  ----                        -------               --------');

  const changes = [];
  for (const k of Object.keys(NEW)) {
    const cur  = pair[k];
    const next = NEW[k];
    const tag  = NEW_KEYS.has(k) ? ' [NEW]' : '';
    if (String(cur) !== String(next)) {
      changes.push([k, cur, next]);
      console.log(`  ${k.padEnd(27)} ${String(cur).padEnd(20)} -> ${next}${tag}`);
    } else {
      console.log(`  ${k.padEnd(27)} ${String(cur).padEnd(20)} (unchanged)${tag}`);
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
    console.log(`  ${k.padEnd(27)} now = ${after[k]}`);
  }

  // Sanity check: re-read each forbidden pair and show it has NOT changed.
  console.log('\nSanity check — forbidden pairs NOT modified:');
  for (const forbId of FORBIDDEN_PAIR_IDS) {
    const ref = await StatArbInput.findByPk(forbId, { raw: true });
    if (!ref) { console.log(`  pair ${forbId}: (not in DB)`); continue; }
    console.log(
      `  pair ${forbId}  updatedAt=${new Date(ref.updatedAt).toISOString()}  ` +
      `agent=${ref.agentName}`
    );
    // Confirm every NEW column is still NULL on the forbidden pair.
    const leaked = [...NEW_KEYS].filter((k) => ref[k] != null);
    if (leaked.length > 0) {
      console.error(`  *** WARNING: pair ${forbId} has non-NULL new columns: ${leaked.join(', ')}`);
      console.error('      (This script did NOT set them; investigate DB state.)');
    } else {
      console.log(`    new columns all NULL  OK`);
    }
  }

  await sequelize.close();
}

main().catch(async (e) => {
  console.error('ERR:', e.message, e.stack);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
