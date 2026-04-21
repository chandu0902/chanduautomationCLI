#!/usr/bin/env node
/**
 * Create Pair 26 v3 — ETH bot with profitability-plan adjustments.
 *
 * This clones Pair 26's base config and applies the recommended changes
 * from eth_pair26_profitability_plan.txt.
 *
 * tradingEnabled is set to FALSE — review the printed config, then enable
 * from the frontend when ready.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { StatArbInput, sequelize } = require('../src/models');

(async () => {
  const src = await StatArbInput.findByPk(26);
  if (!src) { console.error('Pair 26 not found'); process.exit(1); }

  const base = src.toJSON();

  // Remove fields that must be fresh for a new bot
  delete base.id;
  delete base.createdAt;
  delete base.updatedAt;
  delete base.sessionStartedAt;
  delete base.sessionStoppedAt;
  delete base.sessionStartBalance;
  delete base.sessionEndBalance;
  delete base.sessionPnl;
  delete base.botStartedAt;
  delete base.botStartBalance;
  delete base.botEndBalance;
  delete base.botPnl;
  delete base.lastStopReason;
  delete base.lastDisabledAt;
  delete base.totalUptimeMs;
  delete base.peakEquity;

  // Timestamp for uniqueness
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '');

  // ── Profitability-plan adjustments ─────────────────────────────────
  const overrides = {
    agentName:             `ETH_Options_Hedge_V3-${ts}`,
    tradingEnabled:        false,            // start disabled for review
    status:                'active',

    // #1 Remove fixedTpUsd cap (was 3.5 — biggest profit killer)
    fixedTpUsd:            null,

    // #2 Tighter hard SL (was 20, enforce real SL on exchange)
    maxSingleTradeLossUsd: 10,

    // #3 Reduce layering depth (was 4)
    maxPositions:          2,
    qty1:                  47000,
    maxQty1:               47000,
    maxLegAQty:            47000,

    // #4 Wider TP closer to pair 25's successful 0.6896 (was 0.4092)
    tpSpreadDelta:         0.55,
    slSpreadDelta:         0.25,              // was 0.1637 — slightly wider SL
    adaptTpSigma:          3.0,               // was 2.5
    adaptSlSigma:          1.2,               // was 1.0

    // #5 Higher entry threshold — filter weak signals (was 1.2)
    adaptSigmaMin:         1.6,
    zEntryThreshold:       1.6,

    // #6 Reserved — direction-specific sigma is a code change, not config
    //    For now we raise min globally; add short-side filter in code later

    // #7 Enforce maxHold (was 600000 / 10m)
    maxHoldMs:             300000,            // 5 min

    // Kill switches
    dailyLossLimitUsd:     500,               // was 700 — tighter
    maxDrawdownUsd:        500,               // align with daily loss
    optionProfitTargetUsd: 800,               // was 400 — give options room
  };

  const next = { ...base, ...overrides };

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  NEW BOT — Pair 26 v3 (ETH Options Hedge V3)');
  console.log('  tradingEnabled = FALSE   (review below, then enable)');
  console.log('══════════════════════════════════════════════════════════════════\n');

  console.log('Changes vs Pair 26:');
  for (const k of Object.keys(overrides)) {
    const oldV = base[k];
    const newV = overrides[k];
    if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
      console.log(`  ${k.padEnd(25)} ${String(oldV).padEnd(15)} →  ${newV}`);
    }
  }

  console.log('\nKept from Pair 26:');
  for (const k of ['exchange1','type1','symbol1','tradeAccountA','tradeLeg',
                   'unilateralMode','adaptLevels','adaptSigmaMax',
                   'spreadEntryLevels','maxSpreadCap','priceUpperLimit',
                   'priceLowerLimit','optionInstruments','entryPollTimeoutMs',
                   'grossNegativeScratchMs','adaptMinTpSlRatio',
                   'trendPauseJumpPct','trendPauseDurationMs']) {
    console.log(`  ${k.padEnd(25)} : ${JSON.stringify(next[k])}`);
  }

  // Prevent duplicate if script run twice — match on agentName prefix + account
  const existing = await StatArbInput.findOne({
    where: { agentName: next.agentName, tradeAccountA: next.tradeAccountA },
  });
  if (existing) {
    console.log(`\nAgent already exists (id=${existing.id}). Skipping create.`);
    await sequelize.close();
    return;
  }

  const created = await StatArbInput.create(next);
  console.log(`\n✓ Created new pair id=${created.id} agentName="${created.agentName}"`);
  console.log(`  tradingEnabled = ${created.tradingEnabled}  (enable from frontend when ready)`);

  console.log('\nFULL config of new pair:');
  const saved = created.toJSON();
  for (const [k, v] of Object.entries(saved)) {
    console.log(`  ${k.padEnd(25)} : ${JSON.stringify(v)}`);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  NEXT STEPS (manual):');
  console.log('  1. Review config above + eth_pair26_profitability_plan.txt');
  console.log('  2. Open frontend → find agent "ETH_Options_Hedge_V3-*"');
  console.log('  3. Verify SL code path actually places exchange orders');
  console.log('  4. Enable trading with qty1=24000 for first 2-3 days');
  console.log('  5. Scale up after 2 profitable sessions (PF > 1.0)');
  console.log('══════════════════════════════════════════════════════════════════\n');

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
