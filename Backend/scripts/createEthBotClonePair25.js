#!/usr/bin/env node
/**
 * Create a new ETH stat-arb bot by cloning pair 25's row, adding the seven
 * profitability columns, and leaving pair 25 COMPLETELY UNTOUCHED.
 *
 * Pair 25 is read only. No UPDATE runs against it. Its `tradingEnabled`,
 * `status`, and session fields are not modified.
 *
 *   node scripts/createEthBotClonePair25.js           # dry-run — prints payload
 *   node scripts/createEthBotClonePair25.js --live    # inserts new row
 *
 * Guarantees
 *   • SOURCE_PAIR_ID must be 25 and its agentName/symbol1 must contain "ETH".
 *   • FORBIDDEN_PAIR_IDS (BTC and friends) are NEVER read-for-write.
 *   • Writes exactly ONE new row (INSERT). Nothing else is mutated.
 *   • After insert, re-reads pair 25 and asserts its updatedAt did not change.
 *
 * Rollback (after --live)
 *   UPDATE "statarb_inputs" SET status = 'inactive', "tradingEnabled" = false WHERE id = <NEW_ID>;
 *   -- or hard delete (no trades yet): DELETE FROM "statarb_inputs" WHERE id = <NEW_ID>;
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sequelize, StatArbInput } = require('../src/models');

const SOURCE_PAIR_ID     = 25;
const FORBIDDEN_PAIR_IDS = [20, 21, 22, 23, 24];

// ── Overrides applied on top of the pair-25 clone ───────────────────────────
// Keep arithmetic where we can so future-you can see the intent.
function buildOverrides() {
  const ts = new Date().toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14); // YYYYMMDDhhmmss
  return {
    // Identity
    agentName: `ETH_Options_Hedge_V2-${ts}`,

    // Start safe — user flips tradingEnabled via UI after inspection
    tradingEnabled: false,
    status: 'active',

    // Executor: null → V1 (unilateralExecutor.js), same file pair 25 runs on.
    executorVersion: null,

    // ── New profitability config (same values as applyEthConfigPair25.js) ──
    fixedTpUsd:             3.50,
    maxSingleTradeLossUsd:  20,
    grossNegativeScratchMs: 45000,
    entryRequoteOnMovePx:   0.40,
    adaptMinTpSlRatio:      2.0,
    trendPauseJumpPct:      0.20,
    trendPauseDurationMs:   300000,

    // ── Tighten existing knobs for the new bot ─────────────────────────────
    entryPollTimeoutMs: 30000,     // was 90000 on pair 25
    maxHoldMs:          600000,    // 10 min hard hold cap
    adaptTpSigma:       2.5,
    adaptSlSigma:       1.0,
    adaptSigmaMin:      1.2,
    adaptSigmaMax:      3.0,

    // ── Reset every session / lifetime tracking field ──────────────────────
    sessionStartedAt:    null,
    sessionStoppedAt:    null,
    sessionStartBalance: null,
    sessionEndBalance:   null,
    sessionPnl:          null,
    botStartBalance:     null,
    botStartedAt:        null,
    botEndBalance:       null,
    botPnl:              null,
    peakEquity:          null,
    totalUptimeMs:       0,
    lastStopReason:      null,
    lastDisabledAt:      null,
  };
}

// Never copy these from pair 25 — id is auto-increment, timestamps are fresh.
const EXCLUDE_FROM_CLONE = new Set([
  'id',
  'createdAt',
  'updatedAt',
]);

async function main() {
  const live = process.argv.includes('--live');

  if (FORBIDDEN_PAIR_IDS.includes(SOURCE_PAIR_ID)) {
    throw new Error(`REFUSING: source pair ${SOURCE_PAIR_ID} is in forbidden list ${FORBIDDEN_PAIR_IDS}`);
  }

  const src = await StatArbInput.findByPk(SOURCE_PAIR_ID, { raw: true });
  if (!src) throw new Error(`source pair ${SOURCE_PAIR_ID} not found`);

  const agentUpper = (src.agentName || '').toUpperCase();
  const sym1Upper  = (src.symbol1   || '').toUpperCase();
  if (!agentUpper.includes('ETH')) {
    throw new Error(`REFUSING: source pair ${SOURCE_PAIR_ID} agentName="${src.agentName}" does not contain "ETH"`);
  }
  if (!sym1Upper.includes('ETH')) {
    throw new Error(`REFUSING: source pair ${SOURCE_PAIR_ID} symbol1="${src.symbol1}" does not contain "ETH"`);
  }

  // Verify the seven new columns exist on the model (server restart picked up migration).
  const modelAttrs = StatArbInput.rawAttributes || {};
  const requiredNewCols = [
    'fixedTpUsd', 'maxSingleTradeLossUsd', 'grossNegativeScratchMs',
    'entryRequoteOnMovePx', 'adaptMinTpSlRatio',
    'trendPauseJumpPct', 'trendPauseDurationMs',
  ];
  const missing = requiredNewCols.filter((k) => !(k in modelAttrs));
  if (missing.length > 0) {
    throw new Error(
      `REFUSING: new columns not on model: ${missing.join(', ')}. ` +
      `Restart the API so sequelize.sync({alter:true}) creates them.`
    );
  }

  // Build the payload: clone all DB columns from pair 25, then apply overrides.
  const overrides = buildOverrides();
  const payload = {};
  for (const key of Object.keys(modelAttrs)) {
    if (EXCLUDE_FROM_CLONE.has(key)) continue;
    if (key in overrides) {
      payload[key] = overrides[key];
    } else if (key in src) {
      payload[key] = src[key];
    }
  }

  // ── Print what we're about to do ───────────────────────────────────────
  console.log('='.repeat(78));
  console.log('CREATE NEW ETH BOT (clone of pair 25, PAIR 25 ITSELF WILL NOT BE TOUCHED)');
  console.log('='.repeat(78));
  console.log(`Source pair (read-only):  ${SOURCE_PAIR_ID}  agent=${src.agentName}`);
  console.log(`Forbidden (never read-for-write): ${FORBIDDEN_PAIR_IDS.join(', ')}`);
  console.log(`Executor for new bot:     unilateralExecutor.js  (V1)`);
  console.log('');
  console.log('Key fields on the new pair:');
  const highlight = [
    'agentName', 'exchange1', 'symbol1', 'type1', 'exchange2', 'symbol2', 'type2',
    'tradeLeg', 'tradeAccountA', 'tradeAccountB',
    'qty1', 'maxQty1', 'maxPositions',
    'spreadEntryLevels', 'maxSpreadCap',
    'tpSpreadDelta', 'slSpreadDelta',
    'adaptLevels', 'adaptSigmaMin', 'adaptSigmaMax', 'adaptTpSigma', 'adaptSlSigma',
    'entryPollTimeoutMs', 'maxHoldMs',
    'priceUpperLimit', 'priceLowerLimit', 'optionInstruments', 'optionProfitTargetUsd',
    'maxNetQtyImbalance', 'dailyLossLimitUsd', 'drawdownPct', 'maxDrawdownUsd',
    'executorVersion', 'tradingEnabled', 'status',
    // New profitability columns
    'fixedTpUsd', 'maxSingleTradeLossUsd', 'grossNegativeScratchMs',
    'entryRequoteOnMovePx', 'adaptMinTpSlRatio',
    'trendPauseJumpPct', 'trendPauseDurationMs',
  ];
  for (const k of highlight) {
    if (!(k in payload)) continue;
    const v = payload[k];
    const src25 = src[k];
    const differs = String(v) !== String(src25);
    const tag = differs ? ' (override)' : '';
    const truncated = v == null ? 'null'
      : typeof v === 'string' && v.length > 70 ? v.slice(0, 67) + '...'
      : String(v);
    console.log(`  ${k.padEnd(28)} ${truncated}${tag}`);
  }

  if (!live) {
    console.log('\n(dry-run — re-run with --live to INSERT the new row)');
    await sequelize.close();
    return;
  }

  // Snapshot pair 25 updatedAt so we can prove we did not touch it.
  const pair25BeforeUpdatedAt = src.updatedAt ? new Date(src.updatedAt).getTime() : null;

  console.log('\nInserting new row...');
  const created = await StatArbInput.create(payload);
  console.log(`  Created pair id = ${created.id}  agent=${created.agentName}`);
  console.log(`  tradingEnabled=${created.tradingEnabled}  status=${created.status}`);

  // Sanity: re-read pair 25 and assert it was not modified.
  const pair25After = await StatArbInput.findByPk(SOURCE_PAIR_ID, { raw: true });
  const pair25AfterUpdatedAt = pair25After && pair25After.updatedAt
    ? new Date(pair25After.updatedAt).getTime() : null;
  console.log('\nSanity check — pair 25 NOT modified:');
  console.log(`  pair 25 updatedAt before = ${pair25BeforeUpdatedAt ? new Date(pair25BeforeUpdatedAt).toISOString() : 'n/a'}`);
  console.log(`  pair 25 updatedAt after  = ${pair25AfterUpdatedAt  ? new Date(pair25AfterUpdatedAt).toISOString()  : 'n/a'}`);
  console.log(`  pair 25 tradingEnabled   = ${pair25After.tradingEnabled}   (unchanged)`);
  if (pair25BeforeUpdatedAt !== pair25AfterUpdatedAt) {
    console.error('  *** WARNING: pair 25 updatedAt changed unexpectedly. Investigate.');
  } else {
    console.log('  OK — pair 25 untouched.');
  }

  // Sanity: confirm every forbidden pair is still intact (no new cols leaked).
  console.log('\nSanity check — forbidden pairs still have new columns = NULL:');
  for (const forbId of FORBIDDEN_PAIR_IDS) {
    const ref = await StatArbInput.findByPk(forbId, { raw: true });
    if (!ref) { console.log(`  pair ${forbId}: (not in DB)`); continue; }
    const leaked = requiredNewCols.filter((k) => ref[k] != null);
    if (leaked.length > 0) {
      console.error(`  *** WARNING: pair ${forbId} has non-NULL new cols: ${leaked.join(', ')}`);
    } else {
      console.log(`  pair ${forbId} (${ref.agentName})  OK — all new cols NULL`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`DONE. New pair id = ${created.id}. tradingEnabled=false.`);
  console.log('Next: inspect via UI, then flip tradingEnabled=true when ready.');
  console.log('='.repeat(78));

  await sequelize.close();
}

main().catch(async (e) => {
  console.error('ERR:', e.message, e.stack);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
