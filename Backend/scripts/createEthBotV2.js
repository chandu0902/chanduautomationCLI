#!/usr/bin/env node
/**
 * createEthBotV2.js
 *
 * Creates a BRAND NEW ETH bot row (ETH_Options_Hedge v2) with all the new
 * config from this session. Old pair 22 is NOT touched and stays disabled.
 *
 * New pair:
 *   - Naming convention: ETH_Options_Hedge-YYYYMMDDHHMMSS
 *   - tradingEnabled = false  (you start it manually)
 *   - All sigma / sizing / timing / kill-switch params from v3 sheet
 *   - optionInstruments uses the LIVE strike (2350-C not stale 2300-C)
 *   - botStartBalance = current live ETH equity
 *
 * Safety:
 *   - Only inserts a new row, never touches any existing pair
 *   - Prints full config before inserting
 *   - Pass --live to actually write to DB
 */
'use strict';

require('dotenv').config();
const axios   = require('axios');
const crypto  = require('crypto');
const { StatArbInput, AccountDetails } = require('../src/models');

function dec(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(enc, 'base64', 'utf8') + d.final('utf8');
}

(async () => {
  const live = process.argv.includes('--live');

  // ── Fetch live ETH equity for botStartBalance ─────────────────────────────
  const acct = await AccountDetails.findOne({ where: { Trade_Account: 'ETHHIDDEN_ROAD' } });
  if (!acct) throw new Error('ETHHIDDEN_ROAD account not found');
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const auth = await axios.get('https://www.deribit.com/api/v2/public/auth', {
    params: { grant_type: 'client_credentials', client_id: dec(ak2, ak1, ak0), client_secret: dec(sk2, sk1, sk0) },
  });
  const tok = auth.data.result.access_token;
  const accSummary = await axios.get('https://www.deribit.com/api/v2/private/get_account_summary',
    { params: { currency: 'ETH' }, headers: { Authorization: 'Bearer ' + tok } });
  const spotRes = await axios.get('https://www.deribit.com/api/v2/public/get_index_price',
    { params: { index_name: 'eth_usd' } });
  const spot   = spotRes.data.result.index_price;
  const equity = accSummary.data.result.equity;

  // ── Generate agent name ───────────────────────────────────────────────────
  const now = new Date();
  const ts  = now.toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d+Z$/, '');            // e.g. 20260417143022
  const agentName = `ETH_Options_Hedge-${ts}`;

  // ── New bot config ────────────────────────────────────────────────────────
  const cfg = {
    // Identity
    exchange1:     'deribit',
    type1:         'perpetual',
    symbol1:       'ETH-PERPETUAL',
    exchange2:     'hyperliquid',
    type2:         'perps',
    symbol2:       'ETH',
    agentName,
    tradeAccountA: 'ETHHIDDEN_ROAD',
    tradeAccountB: 'ETHHIDDEN_ROAD',
    unilateralMode: true,
    tradeLeg:       'A',
    status:         'active',
    tradingEnabled: false,           // start manually

    // Sizing — 40 ETH max, 10 ETH/step, 4 grids
    qty1:               94000,
    qty2:               94000,
    maxQty1:            94000,
    maxLegAQty:         94000,
    maxLegBQty:         0,
    maxPositions:       4,
    maxNetQtyImbalance: 10,

    // Entry filters
    zEntryThreshold:    1.2,
    zEntryMax:          5,
    profitFeeMultiplier: 50,

    // Adaptive levels — scheduler fills in actual values on first cycle
    adaptLevels:    true,
    adaptSigmaMin:  1.5,    // L1 = μ + 1.5σ
    adaptSigmaMax:  3.0,    // L4 = μ + 3.0σ
    adaptTpSigma:   3.0,    // TP = 3.0σ  → ratio 3×
    adaptSlSigma:   1.0,    // SL = 1.0σ
    // These are overwritten by first adapt cycle; seed them so bot has
    // something valid before the cycle runs
    spreadEntryLevels: '1.9125,1.9530,1.9935,2.0340',  // μ+1.5σ…μ+3σ at σ=0.081
    maxSpreadCap:      2.0750,                            // μ+3.5σ at σ=0.081
    tpSpreadDelta:     0.2430,                            // 3.0 × 0.081
    slSpreadDelta:     0.0810,                            // 1.0 × 0.081

    // Timing
    maxHoldMs:           900000,    // 15 min max hold
    entryPollTimeoutMs:  90000,     // 90 s entry timeout

    // Kill-switch bands
    priceUpperLimit: 2500,
    priceLowerLimit: 2200,
    dailyLossLimitUsd: 700,
    maxDrawdownUsd:    700,
    drawdownPct:       1,

    // Options watchlist (live strikes as of 2026-04-17)
    optionInstruments: JSON.stringify([
      { name: 'ETH-24APR26-2350-C', size: -100 },
      { name: 'ETH-29MAY26-2400-C', size:  150 },
    ]),
    optionProfitTargetUsd: 400,

    // Lifetime balance baseline
    botStartBalance: equity,
    peakEquity:      equity,
    totalUptimeMs:   0,
  };

  // ── Print diff ────────────────────────────────────────────────────────────
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║  NEW ETH BOT — ${agentName}`);
  console.log(`║  botStartBalance = ${equity.toFixed(6)} ETH  ≈  $${(equity * spot).toFixed(2)}`);
  console.log(`║  ETH spot = $${spot}`);
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  for (const [k, v] of Object.entries(cfg)) {
    const display = k === 'optionInstruments' ? String(v).slice(0, 70) : v;
    console.log(`  ${k.padEnd(25)} = ${display}`);
  }
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log();
  console.log('Old pair 22 (ETH_Options_Hedge-20260416140615) stays as-is (disabled).');
  console.log();

  if (!live) {
    console.log('DRY RUN — no row inserted. Re-run with --live to create the bot.');
    process.exit(0);
  }

  const newPair = await StatArbInput.create(cfg);
  console.log(`\nCREATED — new pairId = ${newPair.id}  name = ${newPair.agentName}`);
  console.log('tradingEnabled = false  — enable it from the dashboard when ready.');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
