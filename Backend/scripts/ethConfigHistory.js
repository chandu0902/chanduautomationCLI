#!/usr/bin/env node
/**
 * ethConfigHistory.js
 * Dumps all ETH bot configs (previous + current) for ETHHIDDEN_ROAD
 * into a structured text file for comparison.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { StatArbInput, sequelize } = require('../src/models');

const TRADING_PARAMS = [
  // Identity
  ['exchange1','exchange2','symbol1','symbol2','tradeLeg','unilateralMode','executorVersion'],
  // Sizing
  ['qty1','maxQty1','maxLegAQty','maxLegBQty','maxPositions','maxNetQtyImbalance'],
  // Entry
  ['zEntryThreshold','zEntryMax','profitFeeMultiplier','minEdgeUsd','entryPollTimeoutMs','entryRequoteOnMovePx'],
  // Levels (static)
  ['spreadEntryLevels','maxSpreadCap','tpSpreadDelta','slSpreadDelta'],
  // Adaptive
  ['adaptLevels','adaptSigmaMin','adaptSigmaMax','adaptTpSigma','adaptSlSigma','adaptMinTpSlRatio',
   'adaptIntervalUsaMs','adaptIntervalOffHoursMs'],
  // Fixed TP / loss guards
  ['fixedTpUsd','profitTarget','maxSingleTradeLossUsd','grossNegativeScratchMs'],
  // Timing
  ['maxHoldMs','stopRepriceIntervalMs','stopUseMarketOnBreach','stopStreakN','stopStreakCooldownN','disableIstHours'],
  // Kill-switch
  ['priceUpperLimit','priceLowerLimit','dailyLossLimitUsd','dailyLossLimitPct',
   'maxDrawdownUsd','drawdownPct'],
  // Trend filter
  ['trendPauseJumpPct','trendPauseDurationMs','trendFilterPct','trendFilterWindowMs'],
  // Options
  ['optionInstruments','optionProfitTargetUsd'],
  // Lifecycle
  ['tradingEnabled','status','createdAt','botStartedAt','botStartBalance',
   'sessionStartedAt','sessionStartBalance','lastStopReason'],
];
const ALL_PARAMS = TRADING_PARAMS.flat();

const SECTION_LABELS = [
  'IDENTITY',
  'SIZING',
  'ENTRY FILTERS',
  'SPREAD LEVELS (static)',
  'ADAPTIVE LEVELS',
  'FIXED TP / LOSS GUARDS',
  'TIMING',
  'KILL-SWITCH',
  'TREND FILTER',
  'OPTIONS',
  'LIFECYCLE',
];

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean')        return v ? 'true' : 'false';
  if (v instanceof Date)             return new Date(v).toISOString();
  return String(v);
}

function changed(bots, key) {
  const vals = bots.map(b => fmt(b[key]));
  return new Set(vals).size > 1;
}

(async () => {
  const bots = await StatArbInput.findAll({
    where: { tradeAccountA: 'ETHHIDDEN_ROAD' },
    order: [['createdAt', 'ASC']],
  });

  const L = [];
  const HR = '═'.repeat(90);
  const hr = '─'.repeat(90);
  const now = new Date().toISOString();

  L.push(HR);
  L.push('  ETH BOT CONFIG HISTORY — ETHHIDDEN_ROAD  (all pairs, inception → now)');
  L.push(`  Generated : ${now}`);
  L.push(`  Pairs     : ${bots.map(b=>`${b.id}:${b.agentName}`).join('  |  ')}`);
  L.push(HR);
  L.push('');

  const botList = bots.map(b => b.toJSON());
  const colW = 28;

  // Header row: pair ids
  const hdr = 'PARAMETER'.padEnd(colW) + botList.map(b => `P${b.id}: ${b.agentName}`.slice(0,26).padEnd(28)).join('');
  L.push(hdr);
  L.push('─'.repeat(colW + botList.length * 28));

  let secIdx = 0;
  for (const group of TRADING_PARAMS) {
    L.push('');
    L.push(`  ┌─ ${SECTION_LABELS[secIdx]} ${'─'.repeat(80 - SECTION_LABELS[secIdx].length - 5)}`);
    secIdx++;
    for (const key of group) {
      const vals = botList.map(b => fmt(b[key]));
      const isChanged = new Set(vals).size > 1;
      const marker    = isChanged ? ' ◄' : '';
      const label     = key.padEnd(colW - 2) + (isChanged ? '▲ ' : '  ');
      const row       = label + vals.map(v => v.slice(0, 27).padEnd(28)).join('') + marker;
      L.push(row);
    }
  }

  L.push('');
  L.push(HR);
  L.push('  ▲ ◄  = parameter changed across versions');
  L.push(HR);
  L.push('');

  // Section 2: full per-bot config dump
  L.push('');
  L.push(HR);
  L.push('  FULL CONFIG PER BOT  (every field)');
  L.push(HR);

  for (const b of botList) {
    L.push('');
    const status = b.tradingEnabled ? '[ACTIVE]' : '[INACTIVE]';
    L.push(`  ${'═'.repeat(86)}`);
    L.push(`  Pair ${b.id}  |  ${b.agentName}  |  ${status}`);
    L.push(`  createdAt : ${fmt(b.createdAt)}   botStartedAt : ${fmt(b.botStartedAt)}`);
    L.push(`  ${'─'.repeat(86)}`);

    let sec2 = 0;
    for (const group of TRADING_PARAMS) {
      L.push(`  ── ${SECTION_LABELS[sec2]} ──`);
      sec2++;
      for (const key of group) {
        const val = fmt(b[key]);
        if (val === '—') continue;  // skip nulls
        L.push(`    ${key.padEnd(30)} ${val}`);
      }
    }
  }

  L.push('');
  L.push(HR);
  L.push(`  Generated : ${now}`);
  L.push(HR);

  const report = L.join('\n');
  console.log(report);

  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'reports', `eth_config_history_${ts}.txt`);
  fs.writeFileSync(out, report, 'utf8');
  console.log(`\nSaved: ${out}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
