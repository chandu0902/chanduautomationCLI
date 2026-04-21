#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  capital:          3000,
  anchorPrice:      83.40,
  range:            4,
  zoneCount:        4,
  dailyLossLimit:   320,       // USD
  cooldownBars:     5,
  tpConfirmTicks:   3,
  slConfirmTicks:   7,
  minHoldBars:      3,
  entryLevels:      [0.06, 0.08, 0.12, 0.18],
  zones: [
    { label: 'Zone 1', qty: 10, tp: 0.05, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { label: 'Zone 2', qty: 10, tp: 0.10, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { label: 'Zone 3', qty: 10, tp: 0.20, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { label: 'Zone 4', qty: 10, tp: 0.40, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
  ],
  analyticsWindow:  60,
  zScoreMin:        0.0,
  hurstGate:        0.55,
  /** SL: true = |deribit_mid − entryPrice| ≥ sl (USD). false = spread widens from fill by ≥ sl (legacy). */
  slOnEntryPrice:   true,
};

// ─── Zone Grid (self-contained) ─────────────────────────────────────────────

class ZoneGrid {
  constructor(anchor, range, count) {
    this.anchor = anchor;
    this.range  = range;
    this.count  = count;
    this.width  = range / count;
    this.upZones   = [];
    this.downZones = [];
    for (let i = 0; i < count; i++) {
      this.upZones.push({
        id: `up_${i}`, side: 'up', index: i,
        low: anchor + i * this.width, high: anchor + (i + 1) * this.width,
      });
      this.downZones.push({
        id: `down_${i}`, side: 'down', index: i,
        low: anchor - (i + 1) * this.width, high: anchor - i * this.width,
      });
    }
  }
  getZone(price) {
    if (price >= this.anchor) {
      for (const z of this.upZones) if (price >= z.low && price < z.high) return z;
      if (price >= this.anchor + this.range - 0.001) return this.upZones[this.upZones.length - 1];
    } else {
      for (const z of this.downZones) if (price > z.low && price <= z.high) return z;
      if (price <= this.anchor - this.range + 0.001) return this.downZones[this.downZones.length - 1];
    }
    return null;
  }
}

// ─── Spread Analytics (self-contained) ──────────────────────────────────────

class SpreadAnalytics {
  constructor(win) { this.win = win; this.spreads = []; }

  add(spread) {
    this.spreads.push(spread);
    if (this.spreads.length > this.win * 2) this.spreads = this.spreads.slice(-this.win);
  }

  zScore() {
    const s = this.spreads.slice(-this.win);
    if (s.length < 20) return 0;
    const mean = s.reduce((a, v) => a + v, 0) / s.length;
    const std  = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length);
    return std > 0 ? (s[s.length - 1] - mean) / std : 0;
  }

  hurst() {
    const series = this.spreads.slice(-this.win);
    const n = series.length;
    if (n < 20) return null;
    const subSizes = [];
    for (let s = 10; s <= Math.floor(n / 2); s = Math.floor(s * 1.5)) subSizes.push(s);
    if (subSizes.length < 3) return null;
    const logN = [], logRS = [];
    for (const size of subSizes) {
      const nB = Math.floor(n / size);
      if (nB < 1) continue;
      let rsSum = 0;
      for (let b = 0; b < nB; b++) {
        const block = series.slice(b * size, (b + 1) * size);
        const mean = block.reduce((a, v) => a + v, 0) / block.length;
        let cum = 0; const cumDev = [];
        for (const v of block) { cum += v - mean; cumDev.push(cum); }
        const R = Math.max(...cumDev) - Math.min(...cumDev);
        const S = Math.sqrt(block.reduce((a, v) => a + (v - mean) ** 2, 0) / block.length);
        if (S > 0) rsSum += R / S;
      }
      const avg = rsSum / nB;
      if (avg > 0) { logN.push(Math.log(size)); logRS.push(Math.log(avg)); }
    }
    if (logN.length < 3) return null;
    const np = logN.length;
    const sx = logN.reduce((a, v) => a + v, 0), sy = logRS.reduce((a, v) => a + v, 0);
    const sxy = logN.reduce((a, v, i) => a + v * logRS[i], 0);
    const sx2 = logN.reduce((a, v) => a + v * v, 0);
    return Math.max(0, Math.min(1, (np * sxy - sx * sy) / (np * sx2 - sx * sx)));
  }

  autocorrelation(lag = 1) {
    const s = this.spreads.slice(-this.win);
    if (s.length <= lag + 1) return null;
    const ret = [];
    for (let i = 1; i < s.length; i++) ret.push(s[i] - s[i - 1]);
    if (ret.length <= lag) return null;
    const mean = ret.reduce((a, v) => a + v, 0) / ret.length;
    let num = 0, den = 0;
    for (let i = lag; i < ret.length; i++) num += (ret[i] - mean) * (ret[i - lag] - mean);
    for (const r of ret) den += (r - mean) ** 2;
    return den > 0 ? num / den : 0;
  }

  halfLife() {
    const s = this.spreads.slice(-this.win);
    if (s.length < 10) return null;
    const mean = s.reduce((a, v) => a + v, 0) / s.length;
    const y = [], x = [];
    for (let i = 1; i < s.length; i++) { y.push(s[i] - s[i - 1]); x.push(s[i - 1] - mean); }
    const sxy = x.reduce((a, v, i) => a + v * y[i], 0);
    const sx2 = x.reduce((a, v) => a + v * v, 0);
    if (sx2 === 0) return null;
    const beta = sxy / sx2;
    if (beta >= 0) return Infinity;
    return Math.max(0, -Math.log(2) / Math.log(1 + beta));
  }

  regime() {
    const h = this.hurst();
    if (h == null) return 'unknown';
    if (h < 0.4) return 'mean_reverting';
    if (h > 0.6) return 'trending';
    return 'random_walk';
  }

  microprice(bidP, askP, bidV, askV) {
    if (bidP > 0 && askP > 0 && (bidV + askV) > 0) {
      return (bidP * askV + askP * bidV) / (bidV + askV);
    }
    return (bidP + askP) / 2;
  }
}

// ─── Parse CSV ──────────────────────────────────────────────────────────────

function loadCSV(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const header = raw[0].split(',');
  return raw.slice(1).map(line => {
    const cols = line.split(',');
    return {
      timestamp:     cols[0],
      deribit_mid:   parseFloat(cols[1]),
      hyper_mid:     parseFloat(cols[2]),
      mid_spread:    parseFloat(cols[3]),
      signal_spread: parseFloat(cols[4]),
    };
  }).filter(r => !isNaN(r.deribit_mid));
}

// ─── Simulation Engine ──────────────────────────────────────────────────────

function simulate(bars, cfg) {
  const zoneGrid  = new ZoneGrid(cfg.anchorPrice, cfg.range, cfg.zoneCount);
  const analytics = new SpreadAnalytics(cfg.analyticsWindow);
  const levels    = cfg.entryLevels;

  let prevSpread    = null;
  let activeZone    = null;
  let lastEntryBar  = -cfg.cooldownBars;
  let dailyPnl      = 0;
  let dailyDate     = '';
  let peakEquity    = cfg.capital;
  let equity        = cfg.capital;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;

  const positions   = [];
  const closedTrades = [];
  const analyticsLog = [];
  const zoneTimeMap  = {};

  for (let bar = 0; bar < bars.length; bar++) {
    const b = bars[bar];
    const price  = b.deribit_mid;
    const spread = b.signal_spread;
    const ts     = b.timestamp;
    const dayStr = ts.slice(0, 10);

    if (dayStr !== dailyDate) { dailyPnl = 0; dailyDate = dayStr; }

    analytics.add(spread);
    const zone = zoneGrid.getZone(price);
    if (zone) {
      zoneTimeMap[zone.id] = (zoneTimeMap[zone.id] || 0) + 1;
    }
    const zoneIdx = zone ? zone.index : -1;
    const zoneCfg = zoneIdx >= 0 && zoneIdx < cfg.zones.length ? cfg.zones[zoneIdx] : null;

    // Log analytics every 60 bars (minutes)
    if (bar > 0 && bar % 60 === 0) {
      const h    = analytics.hurst();
      const ac   = analytics.autocorrelation();
      const hl   = analytics.halfLife();
      const reg  = analytics.regime();
      const zsc  = analytics.zScore();
      analyticsLog.push({
        bar, timestamp: ts, price: price.toFixed(2),
        zone: zone ? zone.id : 'outside',
        hurst: h != null ? h.toFixed(4) : '-',
        autocorrelation: ac != null ? ac.toFixed(4) : '-',
        halfLife: hl != null && hl !== Infinity ? hl.toFixed(2) : '-',
        regime: reg,
        zScore: zsc.toFixed(4),
        spread: spread.toFixed(4),
      });
    }

    // ── Exit checks ──────────────────────────────────────────────────────────
    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      const holdBars = bar - pos.entryBar;
      const narrowing = pos.entrySpread - spread;

      if (pos.peakNarrowing == null || narrowing > pos.peakNarrowing) {
        pos.peakNarrowing = narrowing;
      }

      if (!pos.trailingActive && narrowing >= pos.tp) {
        pos.trailingActive = true;
      }

      // Trailing TP check
      let tpHit = false;
      if (pos.trailingActive && pos.peakNarrowing > 0) {
        const trailLevel = pos.peakNarrowing * pos.trailPct;
        tpHit = narrowing <= trailLevel;
      } else if (narrowing >= pos.tp) {
        tpHit = true;
      }

      // SL check (price-based or spread-based)
      const slHit = holdBars >= cfg.minHoldBars && (
        cfg.slOnEntryPrice
          ? (Math.abs(price - pos.entryPrice) >= pos.sl)
          : ((spread - pos.fillSpread) >= pos.sl)
      );

      if (tpHit) {
        pos.profitTicks = (pos.profitTicks || 0) + 1;
        pos.stopTicks = 0;
      } else if (slHit) {
        pos.stopTicks = (pos.stopTicks || 0) + 1;
        pos.profitTicks = 0;
      } else {
        pos.profitTicks = 0;
        pos.stopTicks = 0;
      }

      if (pos.profitTicks >= cfg.tpConfirmTicks) {
        const pnlPerSol = pos.entrySpread - spread;
        const pnlUsd = pos.qty * pnlPerSol;
        pos.status = 'closed';
        pos.exitBar = bar;
        pos.exitTs = ts;
        pos.exitSpread = spread;
        pos.exitPrice = price;
        pos.pnlPerSol = pnlPerSol;
        pos.pnlUsd = pnlUsd;
        pos.exitReason = 'trailing_tp';
        pos.holdBars = bar - pos.entryBar;
        pos.peakNarrowingFinal = pos.peakNarrowing;
        dailyPnl += pnlUsd;
        equity += pnlUsd;
        closedTrades.push(pos);
      } else if (pos.stopTicks >= cfg.slConfirmTicks) {
        const pnlPerSol = pos.entrySpread - spread;
        const pnlUsd = pos.qty * pnlPerSol;
        pos.status = 'closed';
        pos.exitBar = bar;
        pos.exitTs = ts;
        pos.exitSpread = spread;
        pos.exitPrice = price;
        pos.pnlPerSol = pnlPerSol;
        pos.pnlUsd = pnlUsd;
        pos.exitReason = 'stop_loss';
        pos.holdBars = bar - pos.entryBar;
        pos.peakNarrowingFinal = pos.peakNarrowing;
        dailyPnl += pnlUsd;
        equity += pnlUsd;
        closedTrades.push(pos);
      }
    }

    // Remove closed from active list
    const openPositions = positions.filter(p => p.status === 'open');
    positions.length = 0;
    positions.push(...openPositions);

    // Track equity / drawdown
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    // ── Entry checks ─────────────────────────────────────────────────────────
    if (!zone || !zoneCfg) { prevSpread = spread; continue; }
    if (activeZone !== zone.id) {
      activeZone = zone.id;
      prevSpread = null;
    }
    if (prevSpread == null) { prevSpread = spread; continue; }
    if (bar - lastEntryBar < cfg.cooldownBars) { prevSpread = spread; continue; }
    if (dailyPnl <= -cfg.dailyLossLimit) { prevSpread = spread; continue; }

    // Analytics gates
    const h = analytics.hurst();
    if (h != null && h > cfg.hurstGate) { prevSpread = spread; continue; }
    const reg = analytics.regime();
    if (reg === 'trending') { prevSpread = spread; continue; }
    const zsc = analytics.zScore();
    if (zsc < cfg.zScoreMin) { prevSpread = spread; continue; }

    // Count zone-specific open positions
    const zoneOpen = positions.filter(p => p.zoneId === zone.id).length;
    if (zoneOpen >= zoneCfg.maxPositions) { prevSpread = spread; continue; }

    // Spread crossing check
    for (let i = levels.length - 1; i >= 0; i--) {
      const lvl = levels[i];
      const alreadyAtLevel = positions.some(p => p.gridLevel === i + 1 && p.zoneId === zone.id);
      if (alreadyAtLevel) continue;

      if (prevSpread < lvl && spread >= lvl) {
        positions.push({
          id: closedTrades.length + positions.length + 1,
          status: 'open',
          zoneId: zone.id,
          zoneIdx: zoneIdx,
          zoneSide: zone.side,
          gridLevel: i + 1,
          qty: zoneCfg.qty,
          tp: zoneCfg.tp,
          sl: zoneCfg.sl,
          trailPct: zoneCfg.trailPct,
          entryBar: bar,
          entryTs: ts,
          entrySpread: spread,
          entryPrice: price,
          fillSpread: spread,
          peakNarrowing: 0,
          trailingActive: false,
          profitTicks: 0,
          stopTicks: 0,
        });
        lastEntryBar = bar;
        break;
      }
    }

    prevSpread = spread;
  }

  // Force-close any remaining open positions at last bar
  const lastBar = bars[bars.length - 1];
  for (const pos of positions) {
    if (pos.status !== 'open') continue;
    const pnlPerSol = pos.entrySpread - lastBar.signal_spread;
    const pnlUsd = pos.qty * pnlPerSol;
    pos.status = 'closed';
    pos.exitBar = bars.length - 1;
    pos.exitTs = lastBar.timestamp;
    pos.exitSpread = lastBar.signal_spread;
    pos.exitPrice = lastBar.deribit_mid;
    pos.pnlPerSol = pnlPerSol;
    pos.pnlUsd = pnlUsd;
    pos.exitReason = 'end_of_sim';
    pos.holdBars = bars.length - 1 - pos.entryBar;
    pos.peakNarrowingFinal = pos.peakNarrowing;
    equity += pnlUsd;
    closedTrades.push(pos);
  }

  // Final analytics snapshot
  const finalHurst = analytics.hurst();
  const finalAC    = analytics.autocorrelation();
  const finalHL    = analytics.halfLife();
  const finalReg   = analytics.regime();

  return { closedTrades, analyticsLog, zoneTimeMap,
           equity, peakEquity, maxDrawdownUsd, maxDrawdownPct,
           finalHurst, finalAC, finalHL, finalReg };
}

// ─── Report Generator ───────────────────────────────────────────────────────

function generateReport(cfg, bars, result) {
  const { closedTrades, analyticsLog, zoneTimeMap,
          equity, maxDrawdownUsd, maxDrawdownPct,
          finalHurst, finalAC, finalHL, finalReg } = result;

  const sep = '='.repeat(80);
  const dsep = '-'.repeat(80);
  const lines = [];

  lines.push('');
  lines.push(sep);
  lines.push('  ZONE GRID HFT SIMULATION REPORT');
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(sep);

  // ── Section 1: Config ──
  lines.push('');
  lines.push('SECTION 1 — CONFIGURATION');
  lines.push(dsep);
  lines.push(`  Capital:              $${cfg.capital}`);
  lines.push(`  Anchor price:         $${cfg.anchorPrice}`);
  lines.push(`  Trade range:          $${(cfg.anchorPrice - cfg.range).toFixed(2)} – $${(cfg.anchorPrice + cfg.range).toFixed(2)}`);
  lines.push(`  Zone count (per side):${cfg.zoneCount}`);
  lines.push(`  Zone width:           $${(cfg.range / cfg.zoneCount).toFixed(2)}`);
  lines.push(`  Entry levels:         [${cfg.entryLevels.join(', ')}]`);
  lines.push(`  Daily loss limit:     $${cfg.dailyLossLimit}`);
  lines.push(`  Cooldown:             ${cfg.cooldownBars} bars`);
  lines.push(`  TP confirm ticks:     ${cfg.tpConfirmTicks}`);
  lines.push(`  SL confirm ticks:     ${cfg.slConfirmTicks}`);
  lines.push(`  Stop-loss mode:       ${cfg.slOnEntryPrice ? '|Deribit mid − entryPrice| ≥ SL (USD)' : 'spread − fillSpread ≥ SL (legacy)'}`);
  lines.push(`  Hurst gate:           < ${cfg.hurstGate}`);
  lines.push('');

  const zg = new ZoneGrid(cfg.anchorPrice, cfg.range, cfg.zoneCount);
  lines.push('  Zone Setup:');
  lines.push('  ' + '-'.repeat(76));
  lines.push('  Zone   Range                Qty    TP      SL    Trail%  MaxPos');
  lines.push('  ' + '-'.repeat(76));
  for (let i = 0; i < cfg.zoneCount; i++) {
    const z = cfg.zones[i];
    const up = zg.upZones[i];
    const dn = zg.downZones[i];
    lines.push(`  Up ${i}   $${up.low.toFixed(2)}-$${up.high.toFixed(2)}     ` +
      `${String(z.qty).padStart(4)}  $${z.tp.toFixed(2).padStart(5)}  $${z.sl.toFixed(2).padStart(5)}   ` +
      `${(z.trailPct * 100).toFixed(0)}%      ${z.maxPositions}`);
    lines.push(`  Dn ${i}   $${dn.low.toFixed(2)}-$${dn.high.toFixed(2)}     ` +
      `${String(z.qty).padStart(4)}  $${z.tp.toFixed(2).padStart(5)}  $${z.sl.toFixed(2).padStart(5)}   ` +
      `${(z.trailPct * 100).toFixed(0)}%      ${z.maxPositions}`);
  }

  // ── Section 2: Data Summary ──
  lines.push('');
  lines.push('SECTION 2 — DATA SUMMARY');
  lines.push(dsep);
  const prices = bars.map(b => b.deribit_mid);
  const spreads = bars.map(b => b.signal_spread);
  lines.push(`  Bars:                 ${bars.length} (1-minute)`);
  lines.push(`  Time range:           ${bars[0].timestamp} → ${bars[bars.length - 1].timestamp}`);
  lines.push(`  Price range:          $${Math.min(...prices).toFixed(2)} – $${Math.max(...prices).toFixed(2)}`);
  lines.push(`  Spread mean:          $${(spreads.reduce((a, v) => a + v, 0) / spreads.length).toFixed(6)}`);
  lines.push(`  Spread std:           $${Math.sqrt(spreads.reduce((a, v) => a + (v - spreads.reduce((x, y) => x + y, 0) / spreads.length) ** 2, 0) / spreads.length).toFixed(6)}`);

  // Zone time distribution
  lines.push('');
  lines.push('  Zone Time Distribution:');
  const totalBars = bars.length;
  for (const [zoneId, count] of Object.entries(zoneTimeMap).sort()) {
    const pct = (count / totalBars * 100).toFixed(1);
    lines.push(`    ${zoneId.padEnd(10)} ${String(count).padStart(5)} bars (${pct}%)`);
  }
  const outsideBars = totalBars - Object.values(zoneTimeMap).reduce((a, v) => a + v, 0);
  if (outsideBars > 0) {
    lines.push(`    ${'outside'.padEnd(10)} ${String(outsideBars).padStart(5)} bars (${(outsideBars / totalBars * 100).toFixed(1)}%)`);
  }

  // ── Section 3: Analytics ──
  lines.push('');
  lines.push('SECTION 3 — SPREAD ANALYTICS');
  lines.push(dsep);
  lines.push(`  Final Hurst exponent:     ${finalHurst != null ? finalHurst.toFixed(4) : 'N/A'}`);
  lines.push(`  Final autocorrelation:    ${finalAC != null ? finalAC.toFixed(4) : 'N/A'}`);
  lines.push(`  Mean reversion half-life: ${finalHL != null && finalHL !== Infinity ? finalHL.toFixed(2) + ' bars (~min)' : 'N/A'}`);
  lines.push(`  Final regime:             ${finalReg}`);
  lines.push('');
  lines.push('  Hourly Analytics Log:');
  lines.push('  ' + '-'.repeat(76));
  lines.push('  ' + 'Time'.padEnd(26) + 'Price'.padStart(8) + 'Zone'.padStart(10) +
    'Hurst'.padStart(8) + 'AutoCorr'.padStart(10) + 'HalfLife'.padStart(10) +
    'Regime'.padStart(16) + 'Z-Score'.padStart(9));
  lines.push('  ' + '-'.repeat(76));
  for (const a of analyticsLog) {
    lines.push('  ' + a.timestamp.slice(0, 19).padEnd(26) +
      a.price.padStart(8) + String(a.zone).padStart(10) +
      String(a.hurst).padStart(8) + String(a.autocorrelation).padStart(10) +
      String(a.halfLife).padStart(10) + a.regime.padStart(16) +
      String(a.zScore).padStart(9));
  }

  // ── Section 4: Simulation Results ──
  lines.push('');
  lines.push('SECTION 4 — SIMULATION RESULTS');
  lines.push(dsep);
  const winners = closedTrades.filter(t => t.pnlUsd > 0);
  const losers  = closedTrades.filter(t => t.pnlUsd <= 0);
  const tpExits = closedTrades.filter(t => t.exitReason === 'trailing_tp');
  const slExits = closedTrades.filter(t => t.exitReason === 'stop_loss');
  const eosExits = closedTrades.filter(t => t.exitReason === 'end_of_sim');
  const totalPnl = closedTrades.reduce((a, t) => a + t.pnlUsd, 0);

  lines.push(`  Total trades:             ${closedTrades.length}`);
  lines.push(`  Trailing TP exits:        ${tpExits.length}`);
  lines.push(`  Stop Loss exits:          ${slExits.length}`);
  lines.push(`  End-of-sim (forced):      ${eosExits.length}`);
  lines.push(`  Win rate:                 ${closedTrades.length > 0 ? (winners.length / closedTrades.length * 100).toFixed(1) : 0}%`);
  lines.push(`  Winners:                  ${winners.length}`);
  lines.push(`  Losers:                   ${losers.length}`);
  lines.push('');
  lines.push(`  Total PnL:                $${totalPnl.toFixed(4)}`);
  lines.push(`  Total PnL (SOL-equiv):    ${(totalPnl / cfg.anchorPrice).toFixed(4)} SOL`);
  lines.push(`  ROI on capital:           ${(totalPnl / cfg.capital * 100).toFixed(2)}%`);
  lines.push(`  Final equity:             $${equity.toFixed(2)}`);
  lines.push(`  Max drawdown (USD):       $${maxDrawdownUsd.toFixed(2)}`);
  lines.push(`  Max drawdown (%):         ${maxDrawdownPct.toFixed(2)}%`);
  if (winners.length > 0) {
    lines.push(`  Avg winner:               $${(winners.reduce((a, t) => a + t.pnlUsd, 0) / winners.length).toFixed(4)}`);
    lines.push(`  Best trade:               $${Math.max(...winners.map(t => t.pnlUsd)).toFixed(4)}`);
  }
  if (losers.length > 0) {
    lines.push(`  Avg loser:                $${(losers.reduce((a, t) => a + t.pnlUsd, 0) / losers.length).toFixed(4)}`);
    lines.push(`  Worst trade:              $${Math.min(...losers.map(t => t.pnlUsd)).toFixed(4)}`);
  }
  lines.push(`  Avg hold time:            ${closedTrades.length > 0 ? (closedTrades.reduce((a, t) => a + t.holdBars, 0) / closedTrades.length).toFixed(1) : 0} bars (~min)`);

  // ── Section 5: Per-Zone Breakdown ──
  lines.push('');
  lines.push('SECTION 5 — PER-ZONE BREAKDOWN');
  lines.push(dsep);
  lines.push('  Zone       Trades  Wins  Losses  WinRate    TotalPnL    AvgPnL  AvgHold  AvgPeak');
  lines.push('  ' + '-'.repeat(76));

  const allZoneIds = [...new Set(closedTrades.map(t => t.zoneId))].sort();
  for (const zid of allZoneIds) {
    const zt = closedTrades.filter(t => t.zoneId === zid);
    const zw = zt.filter(t => t.pnlUsd > 0);
    const zl = zt.filter(t => t.pnlUsd <= 0);
    const zpnl = zt.reduce((a, t) => a + t.pnlUsd, 0);
    const avgHold = zt.reduce((a, t) => a + t.holdBars, 0) / (zt.length || 1);
    const avgPeak = zt.reduce((a, t) => a + (t.peakNarrowingFinal || 0), 0) / (zt.length || 1);
    const zIdx = zt[0]?.zoneIdx ?? 0;
    const label = `${zid}(Z${zIdx + 1})`;
    lines.push(
      `  ${label.padEnd(12)} ${String(zt.length).padStart(4)}  ` +
      `${String(zw.length).padStart(4)}  ${String(zl.length).padStart(6)}  ` +
      `${(zt.length > 0 ? (zw.length / zt.length * 100).toFixed(1) : '0.0').padStart(6)}%  ` +
      `$${zpnl.toFixed(4).padStart(9)}  ` +
      `$${(zpnl / (zt.length || 1)).toFixed(4).padStart(8)}  ` +
      `${avgHold.toFixed(1).padStart(5)}m  ` +
      `$${avgPeak.toFixed(4).padStart(7)}`
    );
  }

  // ── Section 6: Per-Level Breakdown ──
  lines.push('');
  lines.push('SECTION 6 — PER-LEVEL BREAKDOWN');
  lines.push(dsep);
  lines.push('  Level     Trades   Wins  Losses  WinRate     TotalPnL     AvgPnL  AvgHold');
  lines.push('  ' + '-'.repeat(76));
  for (let i = 0; i < cfg.entryLevels.length; i++) {
    const lt = closedTrades.filter(t => t.gridLevel === i + 1);
    const lw = lt.filter(t => t.pnlUsd > 0);
    const ll = lt.filter(t => t.pnlUsd <= 0);
    const lpnl = lt.reduce((a, t) => a + t.pnlUsd, 0);
    const avgH = lt.reduce((a, t) => a + t.holdBars, 0) / (lt.length || 1);
    lines.push(
      `  $${cfg.entryLevels[i].toFixed(3).padStart(6)}  ` +
      `${String(lt.length).padStart(6)}  ${String(lw.length).padStart(5)}  ` +
      `${String(ll.length).padStart(6)}  ${(lt.length > 0 ? (lw.length / lt.length * 100).toFixed(1) : '0.0').padStart(6)}%  ` +
      `$${lpnl.toFixed(4).padStart(10)}  ` +
      `$${(lpnl / (lt.length || 1)).toFixed(4).padStart(9)}  ` +
      `${avgH.toFixed(1).padStart(5)}m`
    );
  }

  // ── Section 7: Hourly Performance ──
  lines.push('');
  lines.push('SECTION 7 — HOURLY PERFORMANCE');
  lines.push(dsep);
  lines.push('  Hour (UTC)        Trades   Wins          PnL');
  lines.push('  ' + '-'.repeat(50));
  const hourMap = {};
  for (const t of closedTrades) {
    const h = t.exitTs.slice(0, 13);
    if (!hourMap[h]) hourMap[h] = { trades: 0, wins: 0, pnl: 0 };
    hourMap[h].trades++;
    if (t.pnlUsd > 0) hourMap[h].wins++;
    hourMap[h].pnl += t.pnlUsd;
  }
  for (const [h, v] of Object.entries(hourMap).sort()) {
    lines.push(`  ${h.padEnd(20)} ${String(v.trades).padStart(4)}  ` +
      `${String(v.wins).padStart(5)}   $${v.pnl.toFixed(4).padStart(10)}`);
  }

  // ── Section 8: All Trades ──
  lines.push('');
  lines.push('SECTION 8 — ALL TRADES');
  lines.push(dsep);
  lines.push(
    '     # Entry Time           Exit Time            Zone      Lvl  ' +
    'EntrySprd  ExitSprd  PeakNarr      PnL   Hold Reason'
  );
  for (let i = 0; i < closedTrades.length; i++) {
    const t = closedTrades[i];
    const sign = t.pnlUsd >= 0 ? '+' : '';
    lines.push(
      `  ${String(i + 1).padStart(4)} ${t.entryTs.slice(0, 19).padEnd(21)}` +
      `${t.exitTs.slice(0, 19).padEnd(21)}` +
      `${t.zoneId.padEnd(10)}${String(t.gridLevel).padStart(3)}  ` +
      `$${t.entrySpread.toFixed(4).padStart(8)}  ` +
      `$${t.exitSpread.toFixed(4).padStart(7)}  ` +
      `$${(t.peakNarrowingFinal || 0).toFixed(4).padStart(7)}  ` +
      `${sign}$${t.pnlUsd.toFixed(4).padStart(8)}  ` +
      `${String(t.holdBars).padStart(4)}m ${t.exitReason}`
    );
  }

  // ── Section 9: Trailing TP Analysis ──
  lines.push('');
  lines.push('SECTION 9 — TRAILING TP ANALYSIS');
  lines.push(dsep);
  const tpTrades = closedTrades.filter(t => t.exitReason === 'trailing_tp');
  if (tpTrades.length > 0) {
    const avgPeak = tpTrades.reduce((a, t) => a + (t.peakNarrowingFinal || 0), 0) / tpTrades.length;
    const avgExit = tpTrades.reduce((a, t) => a + t.pnlPerSol, 0) / tpTrades.length;
    const captureRatio = avgPeak > 0 ? (avgExit / avgPeak * 100) : 0;
    lines.push(`  Trailing TP trades:       ${tpTrades.length}`);
    lines.push(`  Avg peak narrowing:       $${avgPeak.toFixed(4)}`);
    lines.push(`  Avg exit narrowing:       $${avgExit.toFixed(4)}`);
    lines.push(`  Avg capture ratio:        ${captureRatio.toFixed(1)}% of peak profit captured`);
  } else {
    lines.push('  No trailing TP exits in this simulation.');
  }

  // ── Section 10: Risk Summary ──
  lines.push('');
  lines.push('SECTION 10 — RISK SUMMARY');
  lines.push(dsep);
  lines.push(`  Starting capital:         $${cfg.capital.toFixed(2)}`);
  lines.push(`  Final equity:             $${equity.toFixed(2)}`);
  lines.push(`  Net PnL:                  $${(equity - cfg.capital).toFixed(2)}`);
  lines.push(`  ROI:                      ${((equity - cfg.capital) / cfg.capital * 100).toFixed(2)}%`);
  lines.push(`  Max drawdown (USD):       $${maxDrawdownUsd.toFixed(2)}`);
  lines.push(`  Max drawdown (%):         ${maxDrawdownPct.toFixed(2)}%`);
  lines.push(`  Daily loss limit:         $${cfg.dailyLossLimit}`);
  const maxExposure = cfg.zones.reduce((a, z) => a + z.qty * z.maxPositions, 0) * cfg.entryLevels.length;
  lines.push(`  Max theoretical exposure: ${maxExposure} SOL ($${(maxExposure * cfg.anchorPrice).toFixed(0)})`);
  const sharpe = closedTrades.length > 1
    ? (() => {
        const pnls = closedTrades.map(t => t.pnlUsd);
        const mean = pnls.reduce((a, v) => a + v, 0) / pnls.length;
        const std = Math.sqrt(pnls.reduce((a, v) => a + (v - mean) ** 2, 0) / pnls.length);
        return std > 0 ? (mean / std).toFixed(4) : 'N/A';
      })()
    : 'N/A';
  lines.push(`  Sharpe (per-trade):       ${sharpe}`);

  lines.push('');
  lines.push(sep);
  lines.push('  END OF REPORT');
  lines.push(sep);
  lines.push('');

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────

const csvPath = path.resolve(__dirname, '../../reports/sol_spread_data_2026-04-08T11-27-46.csv');
if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

console.log(`Loading spread data from: ${csvPath}`);
const bars = loadCSV(csvPath);
console.log(`Loaded ${bars.length} bars (${bars[0].timestamp} → ${bars[bars.length - 1].timestamp})`);
console.log(`Price range: $${Math.min(...bars.map(b => b.deribit_mid)).toFixed(2)} – $${Math.max(...bars.map(b => b.deribit_mid)).toFixed(2)}`);
console.log('');
console.log('Running zone grid simulation...');

const result = simulate(bars, CONFIG);
const report = generateReport(CONFIG, bars, result);

console.log(report);

const outFile = path.resolve(
  __dirname,
  `../../reports/zone_grid_sim_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`
);
fs.writeFileSync(outFile, report, 'utf8');
console.log(`Report saved to: ${outFile}`);
