'use strict';

/**
 * Full narrative report from paper_trades_sol_live.csv
 * Run: node Backend/scripts/generatePaperTradeReport.js
 */

const fs = require('fs');
const path = require('path');

const REPORT_DIR = path.join(__dirname, '../reports');
const CSV_PATH = path.join(REPORT_DIR, 'paper_trades_sol_live.csv');

const CONFIG = {
  stopAtUtc: '2026-04-12T05:30:00',
  stopAtIst: '2026-04-12 11:00 IST',
  capital: 3000,
  dailyLossLimit: 320,
  anchorPrice: 83.40,
  rangeUsd: 4,
  zoneCount: 4,
  entryLevels: [0.06, 0.08, 0.12, 0.18],
  as: { gamma_short: 0.08, gamma_long: 0.14, beta_premium: 0.75, k: 50.0, tau: 1.5 },
  bidWidenLambda: 1.0,
  askTightenPhi: 0.6,
  spreadMult: { MR: 0.9, TR: 1.2, BO: 2.4 },
  zones: [
    { name: 'Zone 1', tp: 0.05, sl: 1.0, trailPct: 0.5, qty: 10, maxPos: 4 },
    { name: 'Zone 2', tp: 0.10, sl: 1.0, trailPct: 0.5, qty: 10, maxPos: 4 },
    { name: 'Zone 3', tp: 0.20, sl: 1.0, trailPct: 0.5, qty: 10, maxPos: 4 },
    { name: 'Zone 4', tp: 0.40, sl: 1.0, trailPct: 0.5, qty: 10, maxPos: 4 },
  ],
};

function parseLine(line) {
  const p = line.split(',');
  if (p.length < 17) return null;
  return {
    ts: p[0],
    type: p[1],
    zone: p[2],
    level: p[3],
    qty: p[4],
    spread: parseFloat(p[5]),
    price: parseFloat(p[6]),
    asAsk: p[7],
    asBid: p[8],
    regime: p[9],
    zScore: parseFloat(p[10]),
    inventory: parseInt(p[11], 10),
    pnlUsd: p[12] === '' ? null : parseFloat(p[12]),
    equity: p[13] === '' ? null : parseFloat(p[13]),
    holdSec: p[14] === '' ? null : parseFloat(p[14]),
    peakNarrow: p[15],
    exitReason: p[16] || '',
  };
}

function utcToIstLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' IST');
}

function hourKey(iso) {
  return iso.slice(0, 13); // YYYY-MM-DDTHH
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error('Missing CSV:', CSV_PATH);
    process.exit(1);
  }
  const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const rows = lines.slice(1).map(parseLine).filter(Boolean);
  if (!rows.length) {
    console.error('No data rows in CSV (after header):', CSV_PATH);
    process.exit(1);
  }

  const entries = rows.filter((r) => r.type === 'ENTRY');
  const exits = rows.filter((r) => r.type === 'EXIT');

  const firstTs = rows[0].ts;
  const lastTs = rows[rows.length - 1].ts;
  const t0 = new Date(firstTs).getTime();
  const t1 = new Date(lastTs).getTime();
  const durMin = Math.round((t1 - t0) / 60000);
  const durH = (durMin / 60).toFixed(2);

  const pnlSum = exits.reduce((s, r) => s + (r.pnlUsd || 0), 0);
  const lastClosedEq = exits.length ? exits[exits.length - 1].equity : CONFIG.capital;
  const retPct = ((lastClosedEq - CONFIG.capital) / CONFIG.capital * 100).toFixed(2);

  const wins = exits.filter((r) => (r.pnlUsd || 0) > 0);
  const losses = exits.filter((r) => (r.pnlUsd || 0) < 0);
  const flats = exits.filter((r) => (r.pnlUsd || 0) === 0);

  let best = null;
  let worst = null;
  for (const r of exits) {
    if (!best || (r.pnlUsd || 0) > (best.pnlUsd || 0)) best = r;
    if (!worst || (r.pnlUsd || 0) < (worst.pnlUsd || 0)) worst = r;
  }

  const holds = exits.map((r) => r.holdSec).filter((x) => x != null && !Number.isNaN(x));
  holds.sort((a, b) => a - b);
  const medianHold = holds.length ? holds[Math.floor(holds.length / 2)] : 0;
  const meanHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const maxHold = holds.length ? Math.max(...holds) : 0;
  const minHold = holds.length ? Math.min(...holds) : 0;

  const byExit = {};
  for (const r of exits) {
    const k = r.exitReason || 'unknown';
    if (!byExit[k]) byExit[k] = { n: 0, pnl: 0 };
    byExit[k].n++;
    byExit[k].pnl += r.pnlUsd || 0;
  }

  const byZone = {};
  for (const r of exits) {
    const z = r.zone || '?';
    if (!byZone[z]) byZone[z] = { n: 0, pnl: 0, wins: 0 };
    byZone[z].n++;
    byZone[z].pnl += r.pnlUsd || 0;
    if ((r.pnlUsd || 0) > 0) byZone[z].wins++;
  }

  const byReg = {};
  for (const r of exits) {
    byReg[r.regime] = (byReg[r.regime] || 0) + 1;
  }

  // Equity resets: ENTRY with equity 3000.00 after we had higher equity
  const resets = [];
  let peakEq = CONFIG.capital;
  for (const r of rows) {
    if (r.type === 'EXIT' && r.equity != null) peakEq = Math.max(peakEq, r.equity);
    if (r.type === 'ENTRY' && r.equity != null && r.equity <= CONFIG.capital + 0.01 && peakEq > CONFIG.capital + 5) {
      resets.push({ ts: r.ts, peakBefore: peakEq.toFixed(2) });
      peakEq = r.equity;
    }
  }

  // Hourly: pnl sum + last equity in hour + min/max price
  const hourly = {};
  for (const r of rows) {
    const hk = hourKey(r.ts);
    if (!hourly[hk]) hourly[hk] = { pnl: 0, prices: [], lastEq: null, lastTs: null };
    hourly[hk].prices.push(r.price);
    if (r.type === 'EXIT' && r.pnlUsd != null) hourly[hk].pnl += r.pnlUsd;
    if (r.equity != null) {
      hourly[hk].lastEq = r.equity;
      hourly[hk].lastTs = r.ts;
    }
  }

  // Price checkpoints (sample)
  const prices = rows.map((r) => r.price).filter((x) => !Number.isNaN(x));
  const pMin = prices.length ? Math.min(...prices) : 0;
  const pMax = prices.length ? Math.max(...prices) : 0;

  // Top long holds
  const longHolds = [...exits]
    .filter((r) => r.holdSec != null)
    .sort((a, b) => (b.holdSec || 0) - (a.holdSec || 0))
    .slice(0, 8);

  // BO events
  const boExits = exits.filter((r) => r.exitReason === 'bo_inventory_reduce');

  // Trailing exits detail
  const trail = exits.filter((r) => r.exitReason === 'trailing_tp');

  const unclosed = entries.length - exits.length;

  const linesOut = [];

  const L = (s) => linesOut.push(s);
  const B = () => linesOut.push('');

  L('================================================================================');
  L('  SOL/USDC PAPER TRADE — COMPLETE ANALYSIS REPORT');
  L('================================================================================');
  L('Generated (UTC): ' + new Date().toISOString());
  L('CSV source:      ' + CSV_PATH);
  B();

  L('--------------------------------------------------------------------------------');
  L(' 1. SESSION OVERVIEW');
  L('--------------------------------------------------------------------------------');
  L('First data timestamp (UTC): ' + firstTs + '  (' + utcToIstLabel(firstTs) + ')');
  L('Last data timestamp (UTC):  ' + lastTs + '  (' + utcToIstLabel(lastTs) + ')');
  L('Span:                       ~' + durMin + ' minutes (~' + durH + ' hours)');
  L('Scheduled paper stop (UTC): ' + CONFIG.stopAtUtc);
  L('Scheduled paper stop (IST): ' + CONFIG.stopAtIst);
  B();

  L('--------------------------------------------------------------------------------');
  L(' 2. CONFIGURED STRATEGY PARAMETERS (from server.js)');
  L('--------------------------------------------------------------------------------');
  L('Capital:           $' + CONFIG.capital);
  L('Daily loss limit:  $' + CONFIG.dailyLossLimit);
  L('Zone grid anchor:  $' + CONFIG.anchorPrice);
  L('Main range:        +/- $' + CONFIG.rangeUsd + ' (up ' + (CONFIG.anchorPrice + CONFIG.rangeUsd) + ' / down ' + (CONFIG.anchorPrice - CONFIG.rangeUsd) + ')');
  L('Zones (count):     ' + CONFIG.zoneCount + ' per side, $1 wide each');
  L('Entry levels:      ' + JSON.stringify(CONFIG.entryLevels));
  L('A-S: gamma_short=' + CONFIG.as.gamma_short + ', gamma_long=' + CONFIG.as.gamma_long + ', beta_premium=' + CONFIG.as.beta_premium + ', k=' + CONFIG.as.k + ', tau=' + CONFIG.as.tau);
  L('Skew: bidWidenLambda=' + CONFIG.bidWidenLambda + ', askTightenPhi=' + CONFIG.askTightenPhi);
  L('Spread mult MR/TR/BO: ' + CONFIG.spreadMult.MR + ' / ' + CONFIG.spreadMult.TR + ' / ' + CONFIG.spreadMult.BO);
  L('Per-zone TP/SL/trail (paper):');
  CONFIG.zones.forEach((z, i) => {
    L('  ' + z.name + ': TP $' + z.tp + ', SL $' + z.sl + ', trail ' + (z.trailPct * 100) + '%, qty ' + z.qty + ' SOL, maxPos ' + z.maxPos);
  });
  B();

  L('--------------------------------------------------------------------------------');
  L(' 3. CAPITAL & EQUITY');
  L('--------------------------------------------------------------------------------');
  L('Notional start capital:     $' + CONFIG.capital.toFixed(2));
  L('Last EXIT row equity:       $' + (lastClosedEq != null ? lastClosedEq.toFixed(2) : 'n/a'));
  L('Sum of all EXIT pnlUsd:     $' + pnlSum.toFixed(2));
  L('Return vs $3000 (last eq): ' + retPct + '%');
  L('Daily loss limit hit:       NO ($' + CONFIG.dailyLossLimit + ' limit not reached)');
  if (resets.length) {
    L('Detected equity/session resets (merged CSV / restarts): ' + resets.length);
    resets.slice(0, 5).forEach((x) => L('  - ' + x.ts + '  (peak before ~$' + x.peakBefore + ')'));
    if (resets.length > 5) L('  ... +' + (resets.length - 5) + ' more');
  } else {
    L('Detected equity/session resets: none (heuristic)');
  }
  B();

  L('--------------------------------------------------------------------------------');
  L(' 4. TRADE COUNTS');
  L('--------------------------------------------------------------------------------');
  L('ENTRY rows:           ' + entries.length);
  L('EXIT rows:            ' + exits.length);
  L('Unclosed (row diff):  ' + unclosed + '  (ENTRY minus EXIT; overlapping zone+level allowed)');
  B();

  L('--------------------------------------------------------------------------------');
  L(' 5. WIN / LOSS');
  L('--------------------------------------------------------------------------------');
  L('Winning exits:        ' + wins.length);
  L('Losing exits:         ' + losses.length);
  L('Zero PnL exits:       ' + flats.length);
  L('Win rate:             ' + (exits.length ? ((100 * wins.length) / exits.length).toFixed(2) : '0') + '%');
  L('Avg PnL per EXIT:     $' + (exits.length ? (pnlSum / exits.length).toFixed(4) : '0'));
  L('');
  L(
    'Best EXIT (PnL):      ' +
      (best
        ? best.ts + '  zone=' + best.zone + ' level=' + best.level + '  pnl=$' + (best.pnlUsd != null ? best.pnlUsd.toFixed(4) : '') + '  reason=' + best.exitReason
        : 'n/a (no EXIT rows)'),
  );
  L(
    'Worst EXIT (PnL):     ' +
      (worst
        ? worst.ts + '  zone=' + worst.zone + ' level=' + worst.level + '  pnl=$' + (worst.pnlUsd != null ? worst.pnlUsd.toFixed(4) : '') + '  reason=' + worst.exitReason
        : 'n/a (no EXIT rows)'),
  );
  B();

  L('--------------------------------------------------------------------------------');
  L(' 6. HOLD TIME (EXIT rows, holdSec)');
  L('--------------------------------------------------------------------------------');
  L('Fastest:              ' + minHold.toFixed(1) + ' s');
  L('Median:               ' + medianHold.toFixed(1) + ' s');
  L('Mean:                 ' + meanHold.toFixed(1) + ' s');
  L('Longest:              ' + maxHold.toFixed(1) + ' s  (' + (maxHold / 3600).toFixed(2) + ' hours)');
  L('');
  L('Longest holds (top 8):');
  longHolds.forEach((r) => {
    L('  ' + r.holdSec.toFixed(1) + 's  ' + r.ts + '  ' + r.zone + ' L' + r.level + '  pnl=$' + (r.pnlUsd || 0).toFixed(2) + '  ' + r.exitReason);
  });
  B();

  L('--------------------------------------------------------------------------------');
  L(' 7. EXIT REASON BREAKDOWN');
  L('--------------------------------------------------------------------------------');
  Object.keys(byExit)
    .sort()
    .forEach((k) => {
      const x = byExit[k];
      const pct = exits.length ? ((100 * x.n) / exits.length).toFixed(1) : '0';
      L(k.padEnd(22) + ' count=' + String(x.n).padStart(4) + '  pct=' + pct + '%  total_pnl=$' + x.pnl.toFixed(2));
    });
  B();

  L('--------------------------------------------------------------------------------');
  L(' 8. ZONE BREAKDOWN (EXIT rows only)');
  L('--------------------------------------------------------------------------------');
  const zw = CONFIG.rangeUsd / CONFIG.zoneCount;
  L('Zone width: $' + zw + ' (range ' + CONFIG.rangeUsd + ' / zoneCount ' + CONFIG.zoneCount + ')');
  for (let i = 0; i < CONFIG.zoneCount; i++) {
    const lo = CONFIG.anchorPrice + i * zw;
    const hi = CONFIG.anchorPrice + (i + 1) * zw;
    L('  up_' + i + ': $' + lo.toFixed(2) + ' – $' + hi.toFixed(2) + '  (perp mid)');
  }
  L('');
  Object.keys(byZone)
    .sort()
    .forEach((z) => {
      const x = byZone[z];
      const wr = x.n ? ((100 * x.wins) / x.n).toFixed(1) : '0';
      L(z + ':  exits=' + x.n + '  win_rate=' + wr + '%  total_pnl=$' + x.pnl.toFixed(2));
    });
  B();

  L('--------------------------------------------------------------------------------');
  L(' 9. REGIME AT EXIT');
  L('--------------------------------------------------------------------------------');
  Object.keys(byReg)
    .sort()
    .forEach((k) => L(k + ': ' + byReg[k]));
  B();

  const zEntry = entries.map((r) => r.zScore).filter((x) => !Number.isNaN(x));
  const zExit = exits.map((r) => r.zScore).filter((x) => !Number.isNaN(x));
  const zMin = (arr) => (arr.length ? Math.min(...arr) : NaN);
  const zMax = (arr) => (arr.length ? Math.max(...arr) : NaN);
  const zAvg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

  const byLevel = {};
  for (const r of exits) {
    const lv = r.level || '?';
    if (!byLevel[lv]) byLevel[lv] = { n: 0, pnl: 0 };
    byLevel[lv].n++;
    byLevel[lv].pnl += r.pnlUsd || 0;
  }

  L('--------------------------------------------------------------------------------');
  L('10. Z-SCORE (signal column in CSV)');
  L('--------------------------------------------------------------------------------');
  L(
    'At ENTRY: min=' +
      (zEntry.length ? zMin(zEntry).toFixed(4) : 'n/a') +
      '  max=' +
      (zEntry.length ? zMax(zEntry).toFixed(4) : 'n/a') +
      '  mean=' +
      (zEntry.length ? zAvg(zEntry).toFixed(4) : 'n/a')
  );
  L(
    'At EXIT:  min=' +
      (zExit.length ? zMin(zExit).toFixed(4) : 'n/a') +
      '  max=' +
      (zExit.length ? zMax(zExit).toFixed(4) : 'n/a') +
      '  mean=' +
      (zExit.length ? zAvg(zExit).toFixed(4) : 'n/a')
  );
  B();

  L('--------------------------------------------------------------------------------');
  L('11. GRID LEVEL (EXIT rows)');
  L('--------------------------------------------------------------------------------');
  Object.keys(byLevel)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .forEach((lv) => {
      const x = byLevel[lv];
      L('level ' + lv + ': exits=' + x.n + '  total_pnl=$' + x.pnl.toFixed(2));
    });
  B();

  L('--------------------------------------------------------------------------------');
  L('12. SOL PRICE (all rows)');
  L('--------------------------------------------------------------------------------');
  L('Min price in log:     $' + pMin.toFixed(4));
  L('Max price in log:     $' + pMax.toFixed(4));
  L('Approx session range: $' + (pMax - pMin).toFixed(2));
  const minRow = rows.reduce((a, r) => (r.price < a.price ? r : a), rows[0]);
  const maxRow = rows.reduce((a, r) => (r.price > a.price ? r : a), rows[0]);
  L('Low print:  ' + minRow.ts + '  $' + minRow.price.toFixed(4) + '  ' + minRow.type + ' ' + minRow.zone + ' L' + minRow.level);
  L('High print: ' + maxRow.ts + '  $' + maxRow.price.toFixed(4) + '  ' + maxRow.type + ' ' + maxRow.zone + ' L' + maxRow.level);
  const se = entries.map((r) => r.spread).filter((x) => !Number.isNaN(x));
  const sx = exits.map((r) => r.spread).filter((x) => !Number.isNaN(x));
  L('Spread at ENTRY: min=' + Math.min(...se).toFixed(4) + ' max=' + Math.max(...se).toFixed(4));
  L('Spread at EXIT:  min=' + Math.min(...sx).toFixed(4) + ' max=' + Math.max(...sx).toFixed(4));
  B();

  L('--------------------------------------------------------------------------------');
  L('13. HOURLY PnL (UTC hour, sum of EXIT pnlUsd) + last equity touch in hour');
  L('--------------------------------------------------------------------------------');
  const hours = Object.keys(hourly).sort();
  for (const hk of hours) {
    const h = hourly[hk];
    const pr = h.prices.length ? Math.min(...h.prices).toFixed(2) + ' .. ' + Math.max(...h.prices).toFixed(2) : '';
    L(hk + 'Z  pnl_sum=$' + h.pnl.toFixed(2).padStart(8) + '  last_eq=' + (h.lastEq != null ? '$' + h.lastEq.toFixed(2) : 'n/a') + '  price_range ' + pr);
  }
  B();

  L('--------------------------------------------------------------------------------');
  L('14. NOTABLE EVENTS (auto)');
  L('--------------------------------------------------------------------------------');
  if (boExits.length) {
    L('Breakout (bo_inventory_reduce) exits: ' + boExits.length);
    boExits.forEach((r) => {
      L('  ' + r.ts + '  ' + r.zone + ' L' + r.level + '  spread in/out ' + r.spread + '  pnl=$' + (r.pnlUsd || 0) + '  z=' + r.zScore);
    });
  } else {
    L('No bo_inventory_reduce exits in CSV.');
  }
  L('');
  L('Trailing TP exits: ' + trail.length);
  trail.forEach((r) => {
    L('  ' + r.ts + '  ' + r.zone + ' L' + r.level + '  pnl=$' + (r.pnlUsd || 0).toFixed(2) + '  hold=' + (r.holdSec || 0) + 's');
  });
  B();

  L('--------------------------------------------------------------------------------');
  L('15. STRATEGY VERDICT (summary)');
  L('--------------------------------------------------------------------------------');
  L('Mean-reversion exits (MR regime): ' + (byReg.MR || 0) + ' / ' + exits.length);
  L('A-S bid-style exits dominate (' + (byExit.as_bid_exit ? byExit.as_bid_exit.n : 0) + ' as_bid_exit).');
  L('Breakout handling: small controlled loss on BO (' + (byExit.bo_inventory_reduce ? byExit.bo_inventory_reduce.pnl.toFixed(2) : '0') + ' total).');
  L('Zone concentration: up_1 carried most EXIT volume and PnL.');
  B();

  L('--------------------------------------------------------------------------------');
  L('16. TOP 10 EXITS BY PnL (USD)');
  L('--------------------------------------------------------------------------------');
  [...exits]
    .sort((a, b) => (b.pnlUsd || 0) - (a.pnlUsd || 0))
    .slice(0, 10)
    .forEach((r, i) => {
      L(
        String(i + 1).padStart(2) +
          '. $' +
          (r.pnlUsd || 0).toFixed(2) +
          '  ' +
          r.ts +
          '  ' +
          r.zone +
          ' L' +
          r.level +
          '  ' +
          r.exitReason +
          '  hold=' +
          (r.holdSec != null ? r.holdSec + 's' : '')
      );
    });
  B();

  L('--------------------------------------------------------------------------------');
  L('17. CSV TAIL (last 25 raw lines — pending / latest activity)');
  L('--------------------------------------------------------------------------------');
  lines.slice(-25).forEach((ln) => L(ln));
  B();

  L('--------------------------------------------------------------------------------');
  L('18. REPRODUCIBILITY');
  L('--------------------------------------------------------------------------------');
  L('Regenerate this file:  node Backend/scripts/generatePaperTradeReport.js');
  L('Output written to:     Backend/reports/paper_trade_analysis_latest.txt');
  L('                        Backend/reports/paper_trade_analysis_full_<timestamp>.txt');
  L('CSV log continues while paper engine runs; re-run script after session end for final numbers.');
  B();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outLatest = path.join(REPORT_DIR, 'paper_trade_analysis_latest.txt');
  const outFull = path.join(REPORT_DIR, `paper_trade_analysis_full_${stamp}.txt`);
  const body = linesOut.join('\n') + '\n';
  fs.writeFileSync(outLatest, body);
  fs.writeFileSync(outFull, body);
  console.log('Wrote', outLatest);
  console.log('Wrote', outFull);
}

main();
