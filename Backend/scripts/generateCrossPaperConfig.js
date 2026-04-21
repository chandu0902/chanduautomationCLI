#!/usr/bin/env node
'use strict';

/**
 * Build crossPaperBootstrap-style JSON from cross_spread_snapshots_*.jsonl files.
 *
 * Usage:
 *   node scripts/generateCrossPaperConfig.js
 *   node scripts/generateCrossPaperConfig.js --reports-dir=../reports --out=../src/config/crossPaperBootstrap.generated.json
 *   node scripts/generateCrossPaperConfig.js --files=../reports/cross_spread_snapshots_ETH.jsonl
 *   node scripts/generateCrossPaperConfig.js --session=2026-04-13T15-30-00-000
 *
 * Picks latest snapshot file per pair id (ETH, BTC, …) when --files not set.
 */

const fs = require('fs');
const path = require('path');

const profiles = require('../src/config/crossPaperProfiles.json');
const defaultBootstrap = require('../src/config/crossPaperBootstrap.json');

function parseArgs() {
  const out = { reportsDir: null, outPath: null, files: null, capital: 10000, session: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--reports-dir=')) out.reportsDir = a.slice('--reports-dir='.length);
    else if (a.startsWith('--out=')) out.outPath = a.slice('--out='.length);
    else if (a.startsWith('--files=')) out.files = a.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--capital=')) out.capital = parseFloat(a.slice('--capital='.length)) || 10000;
    else if (a.startsWith('--session=')) out.session = a.slice('--session='.length).trim();
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function sortedNums(arr) {
  return [...arr].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

function readJsonl(filePath) {
  const rows = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch (_) {}
  }
  return rows;
}

function latestSnapshotPerPair(reportsDir, pairIds, sessionSubstr) {
  const byPair = {};
  let files;
  try {
    files = fs.readdirSync(reportsDir);
  } catch (e) {
    console.error('Cannot read reports dir:', reportsDir, e.message);
    process.exit(1);
  }
  for (const id of pairIds) {
    const fixed = path.join(reportsDir, `cross_spread_snapshots_${id}.jsonl`);
    if (!sessionSubstr && fs.existsSync(fixed)) {
      byPair[id] = fixed;
      continue;
    }
    // Legacy timestamped filenames (only when --session=…)
    const prefix = `cross_spread_snapshots_${id}_`;
    let matches = files.filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
    if (sessionSubstr) {
      const scoped = matches.filter((f) => f.includes(sessionSubstr));
      if (scoped.length) matches = scoped;
    }
    if (!matches.length) continue;
    matches.sort();
    byPair[id] = path.join(reportsDir, matches[matches.length - 1]);
  }
  return byPair;
}

function suggestPairConfig(rows, priorPair, capital) {
  const prior = priorPair || defaultBootstrap.pairs.ETH;
  const sig = rows.map((r) => r.signalSpread).filter(Number.isFinite);
  const mid = rows.map((r) => r.midSpread).filter(Number.isFinite);
  const deribitMid = rows.map((r) => r.deribitMid).filter(Number.isFinite);
  const ss = sortedNums(sig);
  const ms = sortedNums(mid);
  const dm = sortedNums(deribitMid);
  if (!ss.length || !ms.length) return prior;

  const medS = quantile(ss, 0.5);
  const iqrS = Math.max(quantile(ss, 0.75) - quantile(ss, 0.25), 1e-12);
  const p90S = quantile(ss, 0.9);
  const p95S = quantile(ss, 0.95);
  const stdS = Math.sqrt(ss.reduce((a, x) => a + (x - medS) ** 2, 0) / ss.length) || iqrS;

  const el1 = Math.max(iqrS * 0.35, stdS * 0.4);
  const el2 = Math.max(iqrS * 0.55, stdS * 0.6);
  const el3 = Math.max((p90S - medS) * 0.5, stdS * 0.85);
  const el4 = Math.max((p95S - medS) * 0.45, stdS * 1.1);
  const entryLevels = [el1, el2, el3, el4].map((x) => Math.max(x, 1e-6));

  const anchor = quantile(dm.length ? dm : ms, 0.5);
  const rangeRaw = Math.max(
    quantile(dm.length ? dm : ms, 0.95) - quantile(dm.length ? dm : ms, 0.05),
    Math.abs(anchor) * 0.02,
    stdS * 8,
  );
  const range = Math.min(Math.max(rangeRaw, Math.abs(anchor) * 0.005), Math.abs(anchor) * 0.25);

  const tp1 = Math.max(stdS * 0.15, iqrS * 0.08);
  const tp2 = tp1 * 2;
  const tp3 = tp1 * 3.5;
  const tp4 = tp1 * 6;
  const sl = Math.max(stdS * 2.5, iqrS * 1.8, Math.abs(anchor) * 0.001);

  // Same scale as crossPaperBootstrap: (capital/3000)*10 from SOL baseline, rounded to lot step 10.
  const zoneQty = Math.max(10, Math.round(((capital / 3000) * 10) / 10) * 10);

  const mult = defaultBootstrap.stopLossRangeMult;
  const slFromRange = mult != null && range > 0
    ? Math.max(1e-8, Number((range * mult).toPrecision(8)))
    : null;

  const zones = (prior.zones || defaultBootstrap.pairs.ETH.zones).map((z, i) => {
    const tps = [tp1, tp2, tp3, tp4];
    const tp = tps[i] != null ? tps[i] : tp4;
    const slFinal = slFromRange != null ? slFromRange : Math.max(sl, z.sl * 0.25);
    return { ...z, qty: zoneQty, tp, sl: slFinal };
  });

  return {
    entryLevels: entryLevels.map((x) => Number(x.toPrecision(4))),
    zoneGrid: {
      anchorPrice: Number(anchor.toPrecision(6)),
      range: Number(range.toPrecision(4)),
      zoneCount: (prior.zoneGrid && prior.zoneGrid.zoneCount) || 4,
    },
    zones,
    _meta: {
      samples: ss.length,
      medianSignalSpread: Number(medS.toPrecision(8)),
      stdSignalSpread: Number(stdS.toPrecision(8)),
      capitalHint: capital,
      snapshotFile: prior._meta?.snapshotFile,
    },
  };
}

function main() {
  const args = parseArgs();
  const reportsDir = path.resolve(__dirname, args.reportsDir || '../reports');
  const outPath = path.resolve(__dirname, args.outPath || '../src/config/crossPaperBootstrap.generated.json');
  const pairIds = profiles.map((p) => p.id);

  let fileByPair = {};
  if (args.files && args.files.length) {
    for (const f of args.files) {
      const base = path.basename(f);
      let m = base.match(/^cross_spread_snapshots_([A-Z0-9]+)\.jsonl$/);
      if (!m) m = base.match(/^cross_spread_snapshots_([A-Z0-9]+)_/);
      if (m) fileByPair[m[1]] = path.resolve(f);
    }
  } else {
    fileByPair = latestSnapshotPerPair(reportsDir, pairIds, args.session);
  }

  const pairs = { ...defaultBootstrap.pairs };
  for (const id of pairIds) {
    const fp = fileByPair[id];
    const prior = pairs[id] || defaultBootstrap.pairs[id] || defaultBootstrap.pairs.ETH;
    if (!fp || !fs.existsSync(fp)) {
      console.warn(`[generateCrossPaperConfig] no snapshot for ${id}, keeping prior bootstrap`);
      continue;
    }
    const rows = readJsonl(fp);
    console.log(`${id}: ${rows.length} rows from ${fp}`);
    const tuned = suggestPairConfig(rows, { ...prior, _meta: { ...prior._meta, snapshotFile: path.basename(fp) } }, args.capital);
    pairs[id] = tuned;
  }

  const out = {
    _readme: 'Generated by scripts/generateCrossPaperConfig.js from JSONL spread snapshots. Review _meta and zones before production.',
    capitalPerPair: args.capital,
    dailyLossLimitPerPair: defaultBootstrap.dailyLossLimitPerPair,
    hurstGate: defaultBootstrap.hurstGate,
    cooldownMs: defaultBootstrap.cooldownMs,
    minHoldMs: defaultBootstrap.minHoldMs,
    tpConfirmTicks: defaultBootstrap.tpConfirmTicks,
    slConfirmTicks: defaultBootstrap.slConfirmTicks,
    analyticsWindow: defaultBootstrap.analyticsWindow,
    as: defaultBootstrap.as,
    bidWidenLambda: defaultBootstrap.bidWidenLambda,
    askTightenPhi: defaultBootstrap.askTightenPhi,
    stopLossRequireZoneExit: defaultBootstrap.stopLossRequireZoneExit === true,
    stopLossRangeMult: defaultBootstrap.stopLossRangeMult ?? null,
    pairs,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Wrote', outPath);
}

main();
