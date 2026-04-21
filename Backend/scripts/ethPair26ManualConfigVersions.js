#!/usr/bin/env node
/**
 * ethPair26ManualConfigVersions.js
 * Shows full config at each MANUAL version applied to pair 26.
 * Excludes adaptive level changes (those run automatically every 20-45 min).
 *
 * Known manual config versions:
 *   V1 : Created  2026-04-18T08:51  — initial row (createPair26v3.js / createEthBotV2.js)
 *   V2 : Updated  2026-04-18T17:50  — tuning run (applyEthConfigFull → pair 22, but V2 script touched 26)
 *   V3 : Backup   before_v3.json    — 2026-04-18 state before v3 edits
 *   V4 : Backup   before_v4         — 2026-04-19T06:14 state before v4
 *   V5 : Applied  applyPair26v4     — 2026-04-19T06:18 (current botStartedAt)
 *   LIVE: Current DB state          — pulled live
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { StatArbInput, sequelize } = require('../src/models');

const REPORTS = path.join(__dirname, '..', 'reports');

/* ── Load snapshots ──────────────────────────────────────────────── */
const v3Raw   = JSON.parse(fs.readFileSync(path.join(REPORTS, 'eth_pair26_config_backup_before_v3.json'), 'utf8'));
const v4Raw   = JSON.parse(fs.readFileSync(path.join(REPORTS, 'eth_pair26_config_backup_before_v4_2026-04-19T06-14-37-418Z.json'), 'utf8'));

/* ── v4 changes (from applyPair26v4.cjs) ───────────────────────── */
const v4Overrides = {
  tpSpreadDelta:         0.50,
  slSpreadDelta:         0.25,
  fixedTpUsd:            null,
  maxSingleTradeLossUsd: 8,
  maxHoldMs:             90000,
  adaptSigmaMin:         2.2,
  adaptTpSigma:          2.0,
  adaptSlSigma:          1.0,
  maxPositions:          1,
  qty1:                  47000,
  maxQty1:               47000,
  maxLegAQty:            47000,
  dailyLossLimitUsd:     300,
  maxDrawdownUsd:        300,
  priceUpperLimit:       2600,
  priceLowerLimit:       2050,
  tradingEnabled:        1,
};

/* Build synthetic v4 snapshot (v4Raw + overrides) */
const v4Applied = { ...v4Raw, ...v4Overrides };

const TRADING_PARAMS = [
  ['SIZING',
    ['qty1','maxQty1','maxLegAQty','maxPositions','maxNetQtyImbalance']],
  ['ENTRY',
    ['zEntryThreshold','zEntryMax','profitFeeMultiplier','entryPollTimeoutMs','entryRequoteOnMovePx']],
  ['SPREAD LEVELS (seed — overwritten by adapt each cycle)',
    ['spreadEntryLevels','maxSpreadCap','tpSpreadDelta','slSpreadDelta']],
  ['ADAPTIVE CONFIG',
    ['adaptLevels','adaptSigmaMin','adaptSigmaMax','adaptTpSigma','adaptSlSigma',
     'adaptMinTpSlRatio','adaptIntervalUsaMs','adaptIntervalOffHoursMs']],
  ['LOSS GUARDS',
    ['fixedTpUsd','maxSingleTradeLossUsd','grossNegativeScratchMs']],
  ['TIMING',
    ['maxHoldMs','stopRepriceIntervalMs','stopUseMarketOnBreach',
     'stopStreakN','stopStreakCooldownN']],
  ['KILL-SWITCH',
    ['priceUpperLimit','priceLowerLimit','dailyLossLimitUsd','maxDrawdownUsd','drawdownPct']],
  ['TREND FILTER',
    ['trendFilterPct','trendFilterWindowMs','trendPauseJumpPct','trendPauseDurationMs','minEdgeUsd']],
  ['OPTIONS',
    ['optionInstruments','optionProfitTargetUsd']],
  ['EXECUTOR / IDENTITY',
    ['executorVersion','tradeLeg','unilateralMode','agentName']],
];

function fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return new Date(v).toISOString();
  return String(v);
}

function diff(a, b) {
  return fmt(a) !== fmt(b);
}

(async () => {
  const live = (await StatArbInput.findByPk(26)).toJSON();
  await sequelize.close();

  /* Versions in chronological order */
  const versions = [
    {
      label: 'V1 — INITIAL CREATE',
      ts:    '2026-04-18T08:51:27Z  (createdAt)',
      desc:  'Row created by createEthBotV2.js / createPair26v3.js. First ever config.',
      data:  v3Raw,   // v3Raw IS the backup "before v3 edits" = original create config
    },
    {
      label: 'V2 — BEFORE V3 EDITS  (backup: eth_pair26_config_backup_before_v3.json)',
      ts:    '2026-04-18T17:50:17Z  (updatedAt in backup)',
      desc:  'State after initial tuning sessions (Apr 18 dailyLoss kill). Pre-v3 backup.',
      data:  v3Raw,
    },
    {
      label: 'V3 — BEFORE V4 APPLY  (backup: eth_pair26_config_backup_before_v4_*.json)',
      ts:    '2026-04-19T06:14:37Z  (backup timestamp)',
      desc:  'State after v3 changes. adaptSigmaMin=1.6, maxPositions=2, qty=94k, mdd=$500.',
      data:  v4Raw,
    },
    {
      label: 'V4 — AFTER applyPair26v4.cjs',
      ts:    '2026-04-19T06:18:18Z  (botStartedAt of V4)',
      desc:  'V4 profitability plan applied: half-size, single grid, tighter guards.',
      data:  v4Applied,
    },
    {
      label: 'V5 — CURRENT LIVE  (DB as of now)',
      ts:    `${fmt(live.updatedAt)}  (updatedAt)`,
      desc:  'Current state after further tuning (adaptSigmaMin=2, adaptTpSigma=2.45, dailyLoss=$100, trendFilter added, executorVersion=OPTD_S1, maxHoldMs=null).',
      data:  live,
    },
  ];

  const L = [];
  const HR = '═'.repeat(110);
  const hr = '─'.repeat(110);
  const now = new Date().toISOString();

  L.push(HR);
  L.push('  PAIR 26 — MANUAL CONFIG VERSION HISTORY');
  L.push('  Only manual/scripted changes shown — adaptive level changes excluded.');
  L.push(`  Generated : ${now}`);
  L.push(HR);

  /* ── Side-by-side comparison table ──────────────────────────────── */
  const colW  = 28;
  const valW  = 18;
  const vLabels = ['V1/V2-ORIG', 'V3-pre-v4', 'V4-applied', 'V5-LIVE'];
  const vDatas  = [v3Raw, v4Raw, v4Applied, live];

  L.push('');
  L.push('  SIDE-BY-SIDE COMPARISON  (▲ = changed vs previous version)');
  L.push(hr);
  L.push('  ' + 'PARAMETER'.padEnd(colW) + vLabels.map(v => v.padEnd(valW)).join(''));
  L.push('  ' + '─'.repeat(colW + vLabels.length * valW));

  for (const [section, keys] of TRADING_PARAMS) {
    L.push('');
    L.push(`  ── ${section} ──`);
    for (const key of keys) {
      const vals = vDatas.map(d => fmt(d?.[key]));
      const anyChange = vals.some((v, i) => i > 0 && v !== vals[i - 1]);
      const marker = anyChange ? ' ◄' : '';
      const markedVals = vals.map((v, i) => {
        const changed = i > 0 && v !== vals[i - 1];
        const display = v.length > valW - 2 ? v.slice(0, valW - 3) + '…' : v;
        return (changed ? '▲' : ' ') + display.padEnd(valW - 1);
      });
      L.push('  ' + key.padEnd(colW) + markedVals.join('') + marker);
    }
  }

  L.push('');
  L.push(HR);
  L.push('  ▲ = changed vs the previous version column    ◄ = row has at least one change');
  L.push(HR);

  /* ── Full config per version ─────────────────────────────────────── */
  L.push('');
  L.push(HR);
  L.push('  FULL CONFIG PER VERSION');
  L.push(HR);

  for (const ver of versions) {
    L.push('');
    L.push(`  ${'─'.repeat(106)}`);
    L.push(`  ${ver.label}`);
    L.push(`  Timestamp : ${ver.ts}`);
    L.push(`  Note      : ${ver.desc}`);
    L.push(`  ${'─'.repeat(106)}`);
    for (const [section, keys] of TRADING_PARAMS) {
      const nonNull = keys.filter(k => ver.data?.[k] != null);
      if (!nonNull.length) continue;
      L.push(`  ── ${section}`);
      for (const k of nonNull) {
        const v = fmt(ver.data[k]);
        L.push(`    ${k.padEnd(30)} ${v}`);
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
  const out = path.join(REPORTS, `eth_pair26_manual_config_versions_${ts}.txt`);
  fs.writeFileSync(out, report, 'utf8');
  console.log(`\nSaved: ${out}`);
})().catch(e => { console.error(e); process.exit(1); });
