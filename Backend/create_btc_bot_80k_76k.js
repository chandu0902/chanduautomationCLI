/**
 * create_btc_bot_80k_76k.js
 *
 * Clones pair 21 (BTC_Options_Hedge) into a new StatArbInput row with:
 *   - priceUpperLimit = 80000
 *   - priceLowerLimit = 76000
 *   - tradingEnabled  = true
 *   - fresh agentName / session tracking
 *
 * All other fields (sizing, TP/SL, adaptive scheduler, options hedge, kill
 * switch limits, account) copied from pair 21 as-is.
 *
 * Usage:
 *   node create_btc_bot_80k_76k.js
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { sequelize, StatArbInput } = require('./src/models');

(async () => {
  await sequelize.authenticate();

  const src = await StatArbInput.findByPk(21);
  if (!src) {
    console.error('Source pair 21 not found.');
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 14);
  const agentName = `BTC_Options_Hedge-${ts}`;

  const clone = {
    exchange1: src.exchange1,
    type1: src.type1,
    symbol1: src.symbol1,
    exchange2: src.exchange2,
    type2: src.type2,
    symbol2: src.symbol2,
    agentName,
    tradeAccountA: src.tradeAccountA,
    qty1: src.qty1,
    tradeAccountB: src.tradeAccountB,
    qty2: src.qty2,
    maxQty1: src.maxQty1,
    beta: src.beta,
    dailyLossLimitPct: src.dailyLossLimitPct,
    dailyLossLimitUsd: src.dailyLossLimitUsd,
    dailyProfitLimitPct: src.dailyProfitLimitPct,
    zEntryThreshold: src.zEntryThreshold,
    zEntryMax: src.zEntryMax,
    maxPositions: src.maxPositions,
    maxLegAQty: src.maxLegAQty,
    maxLegBQty: src.maxLegBQty,
    maxNetQtyImbalance: src.maxNetQtyImbalance,
    profitTarget: src.profitTarget,
    profitFeeMultiplier: src.profitFeeMultiplier,
    unilateralMode: src.unilateralMode,
    tradeLeg: src.tradeLeg,
    tpSpreadDelta: src.tpSpreadDelta,
    slSpreadDelta: src.slSpreadDelta,
    stopLoss: src.stopLoss,
    maxHoldMs: src.maxHoldMs,
    spreadEntryLevels: src.spreadEntryLevels,
    maxSpreadCap: src.maxSpreadCap,
    adaptLevels: src.adaptLevels,
    adaptSigmaMin: src.adaptSigmaMin,
    adaptSigmaMax: src.adaptSigmaMax,
    adaptTpSigma: src.adaptTpSigma,
    adaptSlSigma: src.adaptSlSigma,
    entryPollTimeoutMs: src.entryPollTimeoutMs,
    adaptIntervalUsaMs: src.adaptIntervalUsaMs,
    adaptIntervalOffHoursMs: src.adaptIntervalOffHoursMs,
    executorVersion: src.executorVersion,

    // OVERRIDES
    priceUpperLimit: 80000,
    priceLowerLimit: 76000,

    optionInstruments: src.optionInstruments,
    optionProfitTargetUsd: src.optionProfitTargetUsd,

    // START STATE — fresh tracking
    tradingEnabled: true,
    sessionStartedAt: null,
    sessionStoppedAt: null,
    sessionStartBalance: null,
    sessionEndBalance: null,
    sessionPnl: null,
    botStartBalance: null,
    botStartedAt: null,
    botEndBalance: null,
    botPnl: null,
    peakEquity: null,
    totalUptimeMs: 0,
    maxDrawdownUsd: src.maxDrawdownUsd,
    drawdownPct: src.drawdownPct,
    lastStopReason: null,
    lastDisabledAt: null,
    status: 'active',
  };

  const created = await StatArbInput.create(clone);

  console.log('');
  console.log('NEW BTC BOT CREATED');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  id                   = ${created.id}`);
  console.log(`  agentName            = ${created.agentName}`);
  console.log(`  account              = ${created.tradeAccountB}`);
  console.log(`  perp                 = ${created.symbol2}`);
  console.log(`  future               = ${created.symbol1}`);
  console.log(`  qty1 / maxQty1       = $${created.qty1} / $${created.maxQty1}`);
  console.log(`  maxPositions         = ${created.maxPositions}`);
  console.log(`  tpSpreadDelta        = $${created.tpSpreadDelta}`);
  console.log(`  slSpreadDelta        = $${created.slSpreadDelta}`);
  console.log(`  spreadEntryLevels    = ${created.spreadEntryLevels}`);
  console.log(`  maxSpreadCap         = $${created.maxSpreadCap}`);
  console.log(`  PRICE BAND           = [$${created.priceLowerLimit}, $${created.priceUpperLimit}]`);
  console.log(`  dailyLossLimitUsd    = $${created.dailyLossLimitUsd}`);
  console.log(`  maxDrawdownUsd       = $${created.maxDrawdownUsd}`);
  console.log(`  drawdownPct          = ${created.drawdownPct}%`);
  console.log(`  optionProfitTargetUsd= $${created.optionProfitTargetUsd}`);
  console.log(`  optionInstruments    = ${created.optionInstruments}`);
  console.log(`  tradingEnabled       = ${created.tradingEnabled}`);
  console.log(`  status               = ${created.status}`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('⚠️  BTC index is ~$75,023. With priceLowerLimit=$76,000, the');
  console.log('    price-band kill switch will fire on the next tick unless BTC');
  console.log('    moves above $76K first. Options + perps would be closed and');
  console.log('    the bot stopped.');
  console.log('');

  await sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
