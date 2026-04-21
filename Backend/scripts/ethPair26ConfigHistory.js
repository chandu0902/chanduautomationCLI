#!/usr/bin/env node
/**
 * ethPair26ConfigHistory.js
 * Full config-change history for pair 26:
 *   1. Every DB field update (from StatArbInput current state)
 *   2. Every SpreadLevelHistory row — adapt + enable events
 *   3. PM2 log scan for key events (session enables, kills, adapt)
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { StatArbInput, SpreadLevelHistory, sequelize } = require('../src/models');

const PAIR_ID = 26;

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (v instanceof Date) return new Date(v).toISOString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
const HR = '═'.repeat(88);
const hr = '─'.repeat(88);

(async () => {
  const pair = await StatArbInput.findByPk(PAIR_ID);
  if (!pair) throw new Error(`Pair ${PAIR_ID} not found`);

  const history = await SpreadLevelHistory.findAll({
    where: { pairId: PAIR_ID },
    order: [['createdAt', 'ASC']],
  });

  const L = [];
  const now = new Date().toISOString();

  L.push(HR);
  L.push(`  PAIR 26 — FULL CONFIG CHANGE HISTORY`);
  L.push(`  Agent   : ${pair.agentName}`);
  L.push(`  Account : ${pair.tradeAccountA}`);
  L.push(`  Created : ${fmt(pair.createdAt)}   botStartedAt: ${fmt(pair.botStartedAt)}`);
  L.push(`  Status  : ${pair.status}  tradingEnabled=${pair.tradingEnabled}  lastStop=${pair.lastStopReason || '—'}`);
  L.push(`  Generated: ${now}`);
  L.push(HR);

  /* ── Section 1: current live config ─────────────────────────────── */
  L.push('');
  L.push('  ┌─────────────────────────────────────────────────────────────────────────');
  L.push('  │  SECTION 1 — CURRENT LIVE CONFIG  (from DB, as of now)');
  L.push('  └─────────────────────────────────────────────────────────────────────────');

  const CONFIG_GROUPS = [
    ['SIZING',         ['qty1','maxQty1','maxLegAQty','maxLegBQty','maxPositions','maxNetQtyImbalance']],
    ['ENTRY',          ['zEntryThreshold','zEntryMax','profitFeeMultiplier','minEdgeUsd','entryPollTimeoutMs','entryRequoteOnMovePx']],
    ['SPREAD LEVELS',  ['spreadEntryLevels','maxSpreadCap','tpSpreadDelta','slSpreadDelta']],
    ['ADAPTIVE',       ['adaptLevels','adaptSigmaMin','adaptSigmaMax','adaptTpSigma','adaptSlSigma','adaptMinTpSlRatio','adaptIntervalUsaMs','adaptIntervalOffHoursMs']],
    ['LOSS GUARDS',    ['fixedTpUsd','maxSingleTradeLossUsd','grossNegativeScratchMs']],
    ['TIMING',         ['maxHoldMs','stopRepriceIntervalMs','stopUseMarketOnBreach','stopStreakN','stopStreakCooldownN','disableIstHours']],
    ['KILL-SWITCH',    ['priceUpperLimit','priceLowerLimit','dailyLossLimitUsd','maxDrawdownUsd','drawdownPct']],
    ['TREND FILTER',   ['trendFilterPct','trendFilterWindowMs','trendPauseJumpPct','trendPauseDurationMs']],
    ['OPTIONS',        ['optionInstruments','optionProfitTargetUsd']],
    ['EXECUTOR',       ['executorVersion','tradeLeg','unilateralMode']],
    ['LIFECYCLE',      ['tradingEnabled','status','botStartBalance','botStartedAt','sessionStartBalance','sessionStartedAt','lastStopReason','peakEquity','totalUptimeMs']],
  ];

  const p = pair.toJSON();
  for (const [label, keys] of CONFIG_GROUPS) {
    L.push('');
    L.push(`  ── ${label} ──`);
    for (const k of keys) {
      const v = fmt(p[k]);
      if (v === '—') continue;
      L.push(`    ${k.padEnd(30)} ${v}`);
    }
  }

  /* ── Section 2: SpreadLevelHistory (all adapt + enable events) ───── */
  L.push('');
  L.push(HR);
  L.push('');
  L.push('  ┌─────────────────────────────────────────────────────────────────────────');
  L.push(`  │  SECTION 2 — LEVEL/CONFIG CHANGE LOG  (${history.length} events)`);
  L.push('  │  Sources: adapt cycle, enable, manual update');
  L.push('  └─────────────────────────────────────────────────────────────────────────');
  L.push('');
  L.push(`  ${'#'.padStart(4)}  ${'changedBy'.padEnd(16)}  ${'timestamp'.padEnd(28)}  ${'mean$'.padEnd(8)}  ${'std$'.padEnd(8)}  levels → tp / sl / cap`);
  L.push('  ' + '─'.repeat(84));

  history.forEach((row, i) => {
    const r = row.toJSON();
    const mean = r.dollarMean != null ? `$${parseFloat(r.dollarMean).toFixed(3)}` : '—';
    const std  = r.dollarStd  != null ? `$${parseFloat(r.dollarStd).toFixed(3)}`  : '—';
    const levels = r.levels || '—';
    const tp  = r.tpSpreadDelta != null ? parseFloat(r.tpSpreadDelta).toFixed(4) : '—';
    const sl  = r.slSpreadDelta != null ? parseFloat(r.slSpreadDelta).toFixed(4) : '—';
    const cap = r.maxSpreadCap  != null ? parseFloat(r.maxSpreadCap).toFixed(4)  : '—';
    const ts  = fmt(r.createdAt);
    const num = String(i + 1).padStart(4);
    const by  = (r.changedBy || '—').padEnd(16).slice(0,16);
    L.push(`  ${num}  ${by}  ${ts.padEnd(28)}  ${mean.padEnd(8)}  ${std.padEnd(8)}  [${levels}]  tp=${tp}  sl=${sl}  cap=${cap}`);

    // Show what changed vs previous (only if both exist)
    if (r.prevLevels && r.prevLevels !== r.levels) {
      L.push(`        prev levels: [${r.prevLevels}]  tp=${r.prevTpSpreadDelta != null ? parseFloat(r.prevTpSpreadDelta).toFixed(4):'—'}  sl=${r.prevSlSpreadDelta != null ? parseFloat(r.prevSlSpreadDelta).toFixed(4):'—'}  cap=${r.prevMaxSpreadCap != null ? parseFloat(r.prevMaxSpreadCap).toFixed(4):'—'}`);
    }
    if (r.tpSlUpdated != null) {
      L.push(`        tpSlUpdated=${r.tpSlUpdated}  openPositions=${r.openPositions ?? '—'}`);
    }
  });

  /* ── Section 3: PM2 log key events ───────────────────────────────── */
  L.push('');
  L.push(HR);
  L.push('');
  L.push('  ┌─────────────────────────────────────────────────────────────────────────');
  L.push('  │  SECTION 3 — PM2 LOG KEY EVENTS  (pair 26 only)');
  L.push('  │  Filtered: enable · drawdown · daily-loss · kill · hard-loss · adapt-levels');
  L.push('  └─────────────────────────────────────────────────────────────────────────');
  L.push('');

  let pmLogs = '';
  try {
    pmLogs = execSync(
      "pm2 logs 2 --lines 2000 --nostream 2>&1 | grep 'pair 26\\|pair26'",
      { maxBuffer: 10 * 1024 * 1024 }
    ).toString();
  } catch (e) { pmLogs = e.stdout?.toString() || ''; }

  const KEYWORDS = /session start equity|auto-enabled|disabled by|DRAWDOWN KILL|DAILY LOSS|KILL SWITCH|HARD_LOSS|GROSS_NEGATIVE|AdaptLevels.*pair 26.*levels=|re-tagged/i;
  const lines = pmLogs.split('\n').filter(l => KEYWORDS.test(l));
  for (const l of lines) {
    // strip pm2 prefix, keep timestamp + message
    const m = l.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+):\s*(.*)/);
    if (m) L.push(`  ${m[1]}  ${m[2]}`);
    else L.push(`  ${l.trim()}`);
  }

  if (!lines.length) L.push('  (no matching log lines found in pm2 buffer)');

  L.push('');
  L.push(HR);
  L.push(`  Generated : ${now}`);
  L.push(HR);

  const report = L.join('\n');
  console.log(report);

  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'reports', `eth_pair26_config_history_${ts}.txt`);
  fs.writeFileSync(out, report, 'utf8');
  console.log(`\nSaved: ${out}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
