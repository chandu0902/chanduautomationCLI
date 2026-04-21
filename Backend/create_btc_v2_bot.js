/**
 * create_btc_v2_bot.js
 *
 * Inserts a new BTC basis-trading pair (executorVersion='v2') using current
 * market spread stats derived from the running V1 bot (pair 15) as the baseline.
 *
 * Differences from pair 15:
 *  - executorVersion = 'v2'    → routes to UnilateralExecutorV2
 *  - agentName       = 'V2-REGIME-BTC-<timestamp>'
 *  - tradingEnabled  = false   (start manually after server restart)
 *  - maxPositions    = 3
 *  - All spread levels / TP / SL cloned from pair 15's current adapted values
 *
 * Run once:
 *   node create_btc_v2_bot.js
 */

'use strict';
require('dotenv').config();

const { sequelize, StatArbInput } = require('./src/services/../models');

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ alter: true });

  const source = await StatArbInput.findByPk(15);
  if (!source) { console.error('Pair 15 not found — run restart_btc_bot_pair13.js first.'); process.exit(1); }

  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  const newPair = await StatArbInput.create({
    agentName:          `V2-REGIME-BTC-${ts}`,
    symbol1:            source.symbol1,         // BTC-29MAY26 (futures)
    symbol2:            source.symbol2,         // BTC-PERPETUAL
    exchange1:          source.exchange1,       // deribit
    exchange2:          source.exchange2,       // deribit
    tradeAccountA:      source.tradeAccountA,   // deribit hiddenroad
    type1:              source.type1,           // future
    type2:              source.type2,           // perps
    unilateralMode:     true,
    tradeLeg:           source.tradeLeg,        // B  (buy/sell BTC-PERPETUAL)
    qty1:               source.qty1,            // 2700 USD notional per position
    spreadEntryLevels:  source.spreadEntryLevels,
    tpSpreadDelta:      source.tpSpreadDelta,
    slSpreadDelta:      source.slSpreadDelta,
    maxPositions:       source.maxPositions,
    maxSpreadCap:       source.maxSpreadCap,
    zEntryThreshold:    source.zEntryThreshold,  // z >= 1 required
    zEntryMax:          source.zEntryMax,         // z <= 5 cap
    adaptLevels:        true,
    adaptSigmaMin:      source.adaptSigmaMin,
    adaptSigmaMax:      source.adaptSigmaMax,
    adaptTpSigma:       source.adaptTpSigma,
    adaptSlSigma:       source.adaptSlSigma,
    dailyLossLimitUsd:  source.dailyLossLimitUsd,
    maxDrawdownUsd:     source.maxDrawdownUsd,
    drawdownPct:        source.drawdownPct,
    // V2 executor routing
    executorVersion:    'v2',
    status:             'active',
    tradingEnabled:     false,   // enable manually after confirming server sees the pair
    botStartBalance:    source.botStartBalance ?? null,
    botStartedAt:       new Date(),
  });

  console.log(`\nV2 BTC bot created:`);
  console.log(`  id            = ${newPair.id}`);
  console.log(`  agentName     = ${newPair.agentName}`);
  console.log(`  executorVersion = v2`);
  console.log(`  symbol1       = ${newPair.symbol1}`);
  console.log(`  symbol2       = ${newPair.symbol2}`);
  console.log(`  tradeLeg      = ${newPair.tradeLeg}`);
  console.log(`  qty1          = ${newPair.qty1}`);
  console.log(`  levels        = ${newPair.spreadEntryLevels}`);
  console.log(`  tpSpreadDelta = $${newPair.tpSpreadDelta}`);
  console.log(`  slSpreadDelta = $${newPair.slSpreadDelta}`);
  console.log(`  maxPositions  = ${newPair.maxPositions}`);
  console.log(`  maxSpreadCap  = $${newPair.maxSpreadCap}`);
  console.log(`  zEntry        = [${newPair.zEntryThreshold}, ${newPair.zEntryMax}]`);
  console.log(`  tradingEnabled = false  ← enable via API or DB after restart`);
  console.log(`\nNext steps:`);
  console.log(`  1. Restart the Node.js server so it sees the new executorVersion column.`);
  console.log(`  2. Enable trading: PUT /api/pairs/${newPair.id}/enable  (or UPDATE statarb_inputs SET tradingEnabled=1 WHERE id=${newPair.id})`);

  await sequelize.close();
})().catch(e => { console.error(e.message); process.exit(1); });
