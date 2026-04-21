/**
 * Create a new bot row cloned from pair 8's exact config.
 * All lifetime / session tracking fields start fresh (null).
 * tradingEnabled = false — enable manually when ready.
 *
 * Usage:
 *   node create_pair8_clone.js           # create inactive row, print new ID
 *   node create_pair8_clone.js --dry-run # print JSON only, no DB write
 */
require('dotenv').config();
const { StatArbInput, sequelize } = require('./src/models');

const SOURCE_PAIR_ID = 8;

(async () => {
  const dryRun = process.argv.includes('--dry-run');

  await sequelize.authenticate();
  console.log('DB connected.');

  const src = await StatArbInput.findByPk(SOURCE_PAIR_ID, { raw: true });
  if (!src) { console.error(`Pair ${SOURCE_PAIR_ID} not found`); process.exit(1); }

  const now = new Date();
  const tag = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);   // e.g. 20260408_083000

  // Config-only fields copied exactly from pair 8
  const newRow = {
    exchange1:            src.exchange1,
    type1:                src.type1,
    symbol1:              src.symbol1,
    exchange2:            src.exchange2,
    type2:                src.type2,
    symbol2:              src.symbol2,
    agentName:            `BTC-PERP-UNI-V25-${tag}`,
    tradeAccountA:        src.tradeAccountA,
    tradeAccountB:        src.tradeAccountB,
    qty1:                 src.qty1,
    qty2:                 src.qty2,
    maxQty1:              src.maxQty1,
    beta:                 src.beta,
    dailyLossLimitPct:    src.dailyLossLimitPct,
    dailyLossLimitUsd:    src.dailyLossLimitUsd,
    dailyProfitLimitPct:  src.dailyProfitLimitPct,
    zEntryThreshold:      src.zEntryThreshold,
    zEntryMax:            src.zEntryMax,
    maxPositions:         src.maxPositions,
    maxLegAQty:           src.maxLegAQty,
    maxLegBQty:           src.maxLegBQty,
    maxNetQtyImbalance:   src.maxNetQtyImbalance,
    profitTarget:         src.profitTarget,
    profitFeeMultiplier:  src.profitFeeMultiplier,
    unilateralMode:       src.unilateralMode,
    tradeLeg:             src.tradeLeg,
    tpSpreadDelta:        src.tpSpreadDelta,
    slSpreadDelta:        src.slSpreadDelta,
    stopLoss:             src.stopLoss,
    maxHoldMs:            src.maxHoldMs,
    spreadEntryLevels:    src.spreadEntryLevels,
    maxSpreadCap:         src.maxSpreadCap,
    entryPollTimeoutMs:   src.entryPollTimeoutMs,

    // Trading state — fresh start
    tradingEnabled:       false,
    status:               'active',

    // Session fields — all null (reset for new bot)
    sessionStartedAt:     null,
    sessionStoppedAt:     null,
    sessionStartBalance:  null,
    sessionEndBalance:    null,
    sessionPnl:           null,

    // Lifetime fields — all null (will be set on first enable)
    botStartBalance:      null,
    botStartedAt:         null,
    botEndBalance:        null,
    botPnl:               null,
    totalUptimeMs:        0,
    lastStopReason:       null,
    lastDisabledAt:       null,
  };

  console.log('\n── New bot config ──');
  console.log(JSON.stringify(newRow, null, 2));

  if (dryRun) {
    console.log('\n(--dry-run: nothing written to DB)');
    await sequelize.close();
    process.exit(0);
  }

  const created = await StatArbInput.create(newRow);
  console.log(`\nCreated new pair id=${created.id}  agentName=${created.agentName}`);
  console.log('tradingEnabled=false — enable it via the UI or API when ready.');

  await sequelize.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
