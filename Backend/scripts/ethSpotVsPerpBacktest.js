#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const HYPER_API   = 'https://api.hyperliquid.xyz/info';

// ─── Fetch Deribit candle data ──────────────────────────────────────────────

async function fetchDeribitCandles(instrument, startMs, endMs, resolution = '1') {
  const url = `${DERIBIT_API}/get_tradingview_chart_data` +
    `?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${resolution}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.result || !data.result.ticks) {
    throw new Error(`No Deribit data for ${instrument}: ${JSON.stringify(data.error || data)}`);
  }
  const r = data.result;
  const candles = [];
  for (let i = 0; i < r.ticks.length; i++) {
    candles.push({
      timestamp: r.ticks[i],
      open:   r.open[i],
      high:   r.high[i],
      low:    r.low[i],
      close:  r.close[i],
      volume: r.volume[i],
    });
  }
  return candles;
}

// ─── Fetch Hyperliquid candle data ──────────────────────────────────────────

async function fetchHyperCandles(coin, startMs, endMs, interval = '1m') {
  const resp = await fetch(HYPER_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: startMs, endTime: endMs },
    }),
  });
  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`No Hyperliquid data for ${coin}: ${JSON.stringify(data)}`);
  }
  return data.map(c => ({
    timestamp: c.t,
    open:   parseFloat(c.o),
    high:   parseFloat(c.h),
    low:    parseFloat(c.l),
    close:  parseFloat(c.c),
    volume: parseFloat(c.v),
  }));
}

// ─── Chunked fetchers ───────────────────────────────────────────────────────

async function fetchAllDeribitCandles(instrument, startMs, endMs, resolution = '1') {
  const barMs = parseInt(resolution) * 60000;
  const maxBars = 4500;
  const chunkMs = maxBars * barMs;
  let all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    console.log(`  Deribit ${instrument} ${new Date(cursor).toISOString().slice(0,16)} → ${new Date(chunkEnd).toISOString().slice(0,16)}...`);
    const candles = await fetchDeribitCandles(instrument, cursor, chunkEnd, resolution);
    all = all.concat(candles);
    cursor = chunkEnd + barMs;
    await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchAllHyperCandles(coin, startMs, endMs) {
  const barMs = 60000;
  const maxBars = 5000;
  const chunkMs = maxBars * barMs;
  let all = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + chunkMs, endMs);
    console.log(`  Hyper ${coin} ${new Date(cursor).toISOString().slice(0,16)} → ${new Date(chunkEnd).toISOString().slice(0,16)}...`);
    const candles = await fetchHyperCandles(coin, cursor, chunkEnd);
    all = all.concat(candles);
    if (candles.length === 0) { cursor = chunkEnd + barMs; continue; }
    cursor = candles[candles.length - 1].timestamp + barMs;
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Spread Analytics ───────────────────────────────────────────────────────

class SpreadAnalytics {
  constructor(win) { this.win = win; this.spreads = []; }

  add(spread) {
    this.spreads.push(spread);
    if (this.spreads.length > this.win * 2) this.spreads = this.spreads.slice(-this.win);
  }

  stats() {
    const s = this.spreads.slice(-this.win);
    if (s.length < 5) return { mean: 0, std: 0, zScore: 0 };
    const mean = s.reduce((a, v) => a + v, 0) / s.length;
    const std  = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length);
    const zScore = std > 0 ? (s[s.length - 1] - mean) / std : 0;
    return { mean, std, zScore };
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
}

// ─── Simulation Engine ──────────────────────────────────────────────────────
//
// Mirrors unilateralExecutor.onSpreadUpdate exactly:
//   signalSpread = deribitAsk - hyperBid  (leg1 ask − leg2 bid)
//   TP: (entrySignalSpread - currentSpread) >= tpDelta
//   SL: (currentSpread - entrySignalSpread) >= slDelta + min hold
//   Grid levels: adaptive mean + sigma * std
//   Trade leg: Deribit ETH-PERPETUAL (buy when spread widens, sell to close)

function simulate(bars, cfg) {
  const analytics = new SpreadAnalytics(cfg.analyticsWindow);

  let prevSignalSpread = null;
  let lastEntryBar     = -cfg.cooldownBars;
  let dailyPnl         = 0;
  let dailyDate        = '';
  let peakEquity       = cfg.capital;
  let equity           = cfg.capital;
  let maxDrawdownUsd   = 0;
  let maxDrawdownPct   = 0;

  const positions     = [];
  const closedTrades  = [];
  const analyticsLog  = [];

  let currentLevels = cfg.initialLevels ? [...cfg.initialLevels] : [];
  let currentTp     = cfg.tpSpreadDelta;
  let currentSl     = cfg.slSpreadDelta;
  let lastAdaptBar  = -cfg.adaptIntervalBars;

  for (let bar = 0; bar < bars.length; bar++) {
    const b = bars[bar];
    const midSpread    = b.midSpread;
    const signalSpread = b.signalSpread;   // deribitAsk - hyperBid
    const ts           = new Date(b.timestamp).toISOString();
    const dayStr       = ts.slice(0, 10);

    if (dayStr !== dailyDate) { dailyPnl = 0; dailyDate = dayStr; }

    analytics.add(midSpread);

    // Adaptive levels recalc
    if (cfg.adaptLevels && bar - lastAdaptBar >= cfg.adaptIntervalBars) {
      const st = analytics.stats();
      if (st.std > 0 && analytics.spreads.length >= 60) {
        const nLevels = cfg.maxPositions;
        const newLevels = [];
        for (let i = 0; i < nLevels; i++) {
          const sigma = nLevels === 1
            ? cfg.adaptSigmaMin
            : cfg.adaptSigmaMin + (cfg.adaptSigmaMax - cfg.adaptSigmaMin) * (i / (nLevels - 1));
          const level = st.mean + sigma * st.std;
          if (level > 0) newLevels.push(parseFloat(level.toFixed(4)));
        }
        if (newLevels.length > 0) {
          currentLevels = newLevels;
          const newTp = cfg.adaptTpSigma * st.std;
          const newSl = cfg.adaptSlSigma * st.std;
          if (newTp > 0) currentTp = parseFloat(newTp.toFixed(4));
          if (newSl > 0) currentSl = parseFloat(newSl.toFixed(4));
        }
        lastAdaptBar = bar;
      }
    }

    // Analytics log every 60 bars
    if (bar > 0 && bar % 60 === 0) {
      const st  = analytics.stats();
      const h   = analytics.hurst();
      const ac  = analytics.autocorrelation();
      const hl  = analytics.halfLife();
      const reg = analytics.regime();
      analyticsLog.push({
        bar, timestamp: ts,
        deribitMid: b.deribitMid.toFixed(2), hyperMid: b.hyperMid.toFixed(2),
        midSpread: midSpread.toFixed(4), signalSpread: signalSpread.toFixed(4),
        mean: st.mean.toFixed(4), std: st.std.toFixed(4),
        hurst: h != null ? h.toFixed(4) : '-',
        ac: ac != null ? ac.toFixed(4) : '-',
        halfLife: hl != null && hl !== Infinity ? hl.toFixed(2) : '-',
        regime: reg, zScore: st.zScore.toFixed(4),
        levels: currentLevels.map(l => l.toFixed(2)).join('/'),
        tp: currentTp.toFixed(2), sl: currentSl.toFixed(2),
      });
    }

    // ── Exit checks (same as unilateralExecutor) ────────────────────────────
    const SL_CONFIRM = 7;
    const TP_CONFIRM = 3;
    const MIN_HOLD_BEFORE_SL = 15;  // ~15 ticks ≈ 15s at 1/sec, but in 1-min bars ~15 bars

    for (const pos of positions) {
      if (pos.status !== 'open') continue;
      const holdBars = bar - pos.entryBar;

      if (pos.bestSpread == null) pos.bestSpread = pos.fillSpread;
      if (signalSpread < pos.bestSpread) pos.bestSpread = signalSpread;

      const tpHit = (pos.entrySignalSpread - signalSpread) >= pos.tpDelta;
      const slHit = holdBars >= cfg.minHoldBars &&
                    (signalSpread - pos.entrySignalSpread) >= pos.slDelta;

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

      if (pos.profitTicks >= TP_CONFIRM) {
        const narrowing = pos.entrySignalSpread - signalSpread;
        const pnlUsd = narrowing * (pos.qty / pos.entryPrice);
        pos.status = 'closed'; pos.exitBar = bar; pos.exitTs = ts;
        pos.exitSpread = signalSpread; pos.pnlUsd = pnlUsd;
        pos.exitReason = 'profit'; pos.holdBars = holdBars;
        dailyPnl += pnlUsd; equity += pnlUsd;
        closedTrades.push(pos);
      } else if (pos.stopTicks >= SL_CONFIRM) {
        const narrowing = pos.entrySignalSpread - signalSpread;
        const pnlUsd = narrowing * (pos.qty / pos.entryPrice);
        pos.status = 'closed'; pos.exitBar = bar; pos.exitTs = ts;
        pos.exitSpread = signalSpread; pos.pnlUsd = pnlUsd;
        pos.exitReason = 'stop'; pos.holdBars = holdBars;
        dailyPnl += pnlUsd; equity += pnlUsd;
        closedTrades.push(pos);
      }
    }

    const open = positions.filter(p => p.status === 'open');
    positions.length = 0;
    positions.push(...open);

    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity - equity;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
    const ddPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    // ── Entry checks (same as unilateralExecutor.onSpreadUpdate) ────────────
    if (prevSignalSpread == null) { prevSignalSpread = signalSpread; continue; }
    if (bar - lastEntryBar < cfg.cooldownBars) { prevSignalSpread = signalSpread; continue; }
    if (cfg.dailyLossLimit > 0 && dailyPnl <= -cfg.dailyLossLimit) { prevSignalSpread = signalSpread; continue; }

    const st = analytics.stats();
    if (st.zScore < cfg.zEntryThreshold) { prevSignalSpread = signalSpread; continue; }
    if (cfg.zEntryMax != null && st.zScore > cfg.zEntryMax) { prevSignalSpread = signalSpread; continue; }
    if (positions.length >= cfg.maxPositions) { prevSignalSpread = signalSpread; continue; }

    // Grid crossing: signal spread crosses above a level
    for (let i = currentLevels.length - 1; i >= 0; i--) {
      const level = currentLevels[i];
      const already = positions.some(p => p.gridLevel === i + 1);
      if (already) continue;
      if (prevSignalSpread < level && signalSpread >= level) {
        positions.push({
          id: closedTrades.length + positions.length + 1,
          status: 'open', gridLevel: i + 1, qty: cfg.qtyUsd,
          entryBar: bar, entryTs: ts,
          entrySignalSpread: signalSpread, fillSpread: signalSpread,
          entryPrice: b.deribitMid,
          tpDelta: currentTp, slDelta: currentSl,
          bestSpread: signalSpread, profitTicks: 0, stopTicks: 0,
        });
        lastEntryBar = bar;
        break;
      }
    }
    prevSignalSpread = signalSpread;
  }

  // Force-close remaining
  const lastBar = bars[bars.length - 1];
  for (const pos of positions) {
    if (pos.status !== 'open') continue;
    const narrowing = pos.entrySignalSpread - lastBar.signalSpread;
    const pnlUsd = narrowing * (pos.qty / pos.entryPrice);
    pos.status = 'closed'; pos.exitBar = bars.length - 1;
    pos.exitTs = new Date(lastBar.timestamp).toISOString();
    pos.exitSpread = lastBar.signalSpread; pos.pnlUsd = pnlUsd;
    pos.exitReason = 'end_of_sim'; pos.holdBars = bars.length - 1 - pos.entryBar;
    equity += pnlUsd;
    closedTrades.push(pos);
  }

  return {
    closedTrades, analyticsLog,
    equity, peakEquity, maxDrawdownUsd, maxDrawdownPct,
    finalHurst: analytics.hurst(), finalAC: analytics.autocorrelation(),
    finalHL: analytics.halfLife(), finalReg: analytics.regime(),
    finalStats: analytics.stats(),
    finalLevels: currentLevels, finalTp: currentTp, finalSl: currentSl,
  };
}

// ─── Report Generator ────────────────────────────────────────────────────────

function generateReport(cfg, bars, result) {
  const { closedTrades, analyticsLog,
          equity, maxDrawdownUsd, maxDrawdownPct,
          finalHurst, finalAC, finalHL, finalReg, finalStats,
          finalLevels, finalTp, finalSl } = result;

  const sep = '═'.repeat(80);
  const dsep = '─'.repeat(80);
  const L = [];

  const midSpreads = bars.map(b => b.midSpread);
  const sigSpreads = bars.map(b => b.signalSpread);
  const spreadMean = midSpreads.reduce((a, v) => a + v, 0) / midSpreads.length;
  const spreadStd  = Math.sqrt(midSpreads.reduce((a, v) => a + (v - spreadMean) ** 2, 0) / midSpreads.length);
  const sorted = [...midSpreads].sort((a, b) => a - b);
  const pctile = (p) => sorted[Math.floor(sorted.length * p / 100)];

  L.push('');
  L.push(sep);
  L.push('  ETH DERIBIT PERP vs ETH HYPERLIQUID PERP — CROSS-EXCHANGE SPREAD BACKTEST');
  L.push(`  Generated: ${new Date().toISOString()}`);
  L.push(`  Same unilateral executor logic as BTC basis bot`);
  L.push(sep);

  // ── 1. Strategy ──
  L.push('');
  L.push('SECTION 1 — STRATEGY');
  L.push(dsep);
  L.push('  Leg A (signal):     ETH-PERPETUAL on Deribit     (exchange1)');
  L.push('  Leg B (trade):      ETH perp on Hyperliquid      (exchange2)');
  L.push('  Trade Leg:          A — Deribit ETH-PERPETUAL (maker limit)');
  L.push('  Signal Spread:      deribitAsk − hyperBid  (same as live executor)');
  L.push('  Mid Spread:         (deribitMid − hyperMid)  (used for stats/z-score)');
  L.push('  Direction:          SELL Deribit perp when spread widens, buy back when narrows');
  L.push(`  Backtest Window:    ${cfg.lookbackDays} days (1-min bars)`);

  // ── 2. Data Summary ──
  L.push('');
  L.push('SECTION 2 — DATA SUMMARY');
  L.push(dsep);
  L.push(`  Bars loaded:          ${bars.length}`);
  L.push(`  Time range:           ${new Date(bars[0].timestamp).toISOString().slice(0,19)} → ${new Date(bars[bars.length-1].timestamp).toISOString().slice(0,19)}`);
  L.push(`  Deribit ETH range:    $${Math.min(...bars.map(b=>b.deribitMid)).toFixed(2)} – $${Math.max(...bars.map(b=>b.deribitMid)).toFixed(2)}`);
  L.push(`  Hyper ETH range:      $${Math.min(...bars.map(b=>b.hyperMid)).toFixed(2)} – $${Math.max(...bars.map(b=>b.hyperMid)).toFixed(2)}`);
  L.push('');
  L.push('  MID SPREAD (deribitMid − hyperMid):');
  L.push(`    Mean:               $${spreadMean.toFixed(4)}`);
  L.push(`    Std:                $${spreadStd.toFixed(4)}`);
  L.push(`    Min:                $${Math.min(...midSpreads).toFixed(4)}`);
  L.push(`    Max:                $${Math.max(...midSpreads).toFixed(4)}`);
  L.push(`    Range:              $${(Math.max(...midSpreads) - Math.min(...midSpreads)).toFixed(4)}`);
  L.push(`    Mean as bps:        ${(spreadMean / bars[0].deribitMid * 10000).toFixed(2)} bps`);
  L.push(`    Std as bps:         ${(spreadStd / bars[0].deribitMid * 10000).toFixed(2)} bps`);
  L.push('');
  L.push('  SPREAD PERCENTILES:');
  for (const p of [1, 5, 10, 25, 50, 75, 90, 95, 99]) {
    L.push(`    P${String(p).padStart(2)}:               $${pctile(p).toFixed(4)}`);
  }

  // ── 3. Mean Reversion Quality ──
  L.push('');
  L.push('SECTION 3 — MEAN REVERSION QUALITY');
  L.push(dsep);
  L.push(`  Hurst Exponent:         ${finalHurst != null ? finalHurst.toFixed(4) : 'N/A'}  ${finalHurst != null ? (finalHurst < 0.4 ? '✓ MEAN REVERTING' : finalHurst > 0.6 ? '✗ TRENDING' : '~ RANDOM WALK') : ''}`);
  L.push(`  Autocorrelation (lag1): ${finalAC != null ? finalAC.toFixed(4) : 'N/A'}  ${finalAC != null ? (finalAC < -0.1 ? '✓ negative = MR' : finalAC > 0.1 ? '✗ positive = momentum' : '~ near zero') : ''}`);
  L.push(`  Half-Life:              ${finalHL != null && finalHL !== Infinity ? finalHL.toFixed(2) + ' bars (~min)' : 'N/A'}`);
  L.push(`  Regime:                 ${finalReg}`);
  L.push(`  Rolling Mean:           $${finalStats.mean.toFixed(4)}`);
  L.push(`  Rolling Std:            $${finalStats.std.toFixed(4)}`);
  L.push('');
  L.push('  MULTI-WINDOW HURST:');
  for (const win of [60, 120, 240, 480, 1440]) {
    const sa = new SpreadAnalytics(win);
    for (const b of bars) sa.add(b.midSpread);
    const h = sa.hurst();
    const hl = sa.halfLife();
    const ac = sa.autocorrelation();
    L.push(`    ${String(win).padStart(5)}-min window:  H=${h != null ? h.toFixed(4) : 'N/A'}  HL=${hl != null && hl !== Infinity ? hl.toFixed(1)+'m' : 'N/A'}  AC1=${ac != null ? ac.toFixed(4) : 'N/A'}  regime=${sa.regime()}`);
  }

  // ── 4. Sim Config ──
  L.push('');
  L.push('SECTION 4 — SIMULATION CONFIG');
  L.push(dsep);
  L.push(`  Capital:              $${cfg.capital}`);
  L.push(`  Qty per level:        $${cfg.qtyUsd} (inverse: ${(cfg.qtyUsd / bars[0].deribitMid).toFixed(2)} ETH)`);
  L.push(`  Max positions:        ${cfg.maxPositions}`);
  L.push(`  Max exposure:         $${cfg.qtyUsd * cfg.maxPositions}`);
  L.push(`  Adapt levels:         ${cfg.adaptLevels ? 'YES' : 'NO'}`);
  L.push(`  Adapt interval:       ${cfg.adaptIntervalBars} bars (~min)`);
  L.push(`  Adapt sigma range:    ${cfg.adaptSigmaMin} → ${cfg.adaptSigmaMax}`);
  L.push(`  Adapt TP sigma:       ${cfg.adaptTpSigma}`);
  L.push(`  Adapt SL sigma:       ${cfg.adaptSlSigma}`);
  L.push(`  Z-entry threshold:    ${cfg.zEntryThreshold}`);
  L.push(`  Z-entry max:          ${cfg.zEntryMax}`);
  L.push(`  Daily loss limit:     $${cfg.dailyLossLimit}`);
  L.push(`  Cooldown:             ${cfg.cooldownBars} bars`);
  L.push(`  Min hold before SL:   ${cfg.minHoldBars} bars`);
  L.push('');
  L.push(`  Final adaptive levels:  [${finalLevels.map(l => '$' + l.toFixed(4)).join(', ')}]`);
  L.push(`  Final TP delta:         $${finalTp.toFixed(4)}`);
  L.push(`  Final SL delta:         $${finalSl.toFixed(4)}`);

  // ── 5. Sim Results ──
  L.push('');
  L.push('SECTION 5 — SIMULATION RESULTS');
  L.push(dsep);
  const winners  = closedTrades.filter(t => t.pnlUsd > 0);
  const losers   = closedTrades.filter(t => t.pnlUsd <= 0);
  const tpExits  = closedTrades.filter(t => t.exitReason === 'profit');
  const slExits  = closedTrades.filter(t => t.exitReason === 'stop');
  const eosExits = closedTrades.filter(t => t.exitReason === 'end_of_sim');
  const totalPnl = closedTrades.reduce((a, t) => a + t.pnlUsd, 0);

  L.push(`  Total trades:         ${closedTrades.length}`);
  L.push(`  TP exits:             ${tpExits.length}`);
  L.push(`  SL exits:             ${slExits.length}`);
  L.push(`  End-of-sim:           ${eosExits.length}`);
  L.push(`  Win rate:             ${closedTrades.length > 0 ? (winners.length / closedTrades.length * 100).toFixed(1) : 0}%`);
  L.push(`  Winners / Losers:     ${winners.length} / ${losers.length}`);
  L.push('');
  L.push(`  Total PnL:            $${totalPnl.toFixed(4)}`);
  L.push(`  ROI:                  ${(totalPnl / cfg.capital * 100).toFixed(2)}%`);
  L.push(`  Final equity:         $${equity.toFixed(2)}`);
  L.push(`  Max drawdown (USD):   $${maxDrawdownUsd.toFixed(2)}`);
  L.push(`  Max drawdown (%):     ${maxDrawdownPct.toFixed(2)}%`);
  if (winners.length > 0) {
    L.push(`  Avg winner:           $${(winners.reduce((a, t) => a + t.pnlUsd, 0) / winners.length).toFixed(4)}`);
    L.push(`  Best trade:           $${Math.max(...winners.map(t => t.pnlUsd)).toFixed(4)}`);
  }
  if (losers.length > 0) {
    L.push(`  Avg loser:            $${(losers.reduce((a, t) => a + t.pnlUsd, 0) / losers.length).toFixed(4)}`);
    L.push(`  Worst trade:          $${Math.min(...losers.map(t => t.pnlUsd)).toFixed(4)}`);
  }
  L.push(`  Avg hold time:        ${closedTrades.length > 0 ? (closedTrades.reduce((a, t) => a + t.holdBars, 0) / closedTrades.length).toFixed(1) : 0} bars (~min)`);

  if (closedTrades.length > 1) {
    const pnls = closedTrades.map(t => t.pnlUsd);
    const m = pnls.reduce((a, v) => a + v, 0) / pnls.length;
    const s = Math.sqrt(pnls.reduce((a, v) => a + (v - m) ** 2, 0) / pnls.length);
    L.push(`  Sharpe (per-trade):   ${s > 0 ? (m / s).toFixed(4) : 'N/A'}`);
    const tpd = closedTrades.length / cfg.lookbackDays;
    L.push(`  Trades per day:       ${tpd.toFixed(1)}`);
    L.push(`  Est. daily PnL:       $${(m * tpd).toFixed(2)}`);
    const ds = s * Math.sqrt(tpd);
    L.push(`  Est. ann. Sharpe:     ${ds > 0 ? ((m * tpd) / ds * Math.sqrt(365)).toFixed(2) : 'N/A'}`);
  }

  // ── 6. Per-Level ──
  L.push('');
  L.push('SECTION 6 — PER-LEVEL BREAKDOWN');
  L.push(dsep);
  L.push('  Level  Trades  Wins  Losses  WinRate    TotalPnL    AvgPnL  AvgHold');
  L.push('  ' + '─'.repeat(72));
  for (let i = 0; i < cfg.maxPositions; i++) {
    const lt = closedTrades.filter(t => t.gridLevel === i + 1);
    if (lt.length === 0) continue;
    const lw = lt.filter(t => t.pnlUsd > 0);
    const lpnl = lt.reduce((a, t) => a + t.pnlUsd, 0);
    const avgH = lt.reduce((a, t) => a + t.holdBars, 0) / lt.length;
    L.push(
      `  L${String(i + 1).padStart(2)}    ${String(lt.length).padStart(5)}  ` +
      `${String(lw.length).padStart(4)}  ${String(lt.length - lw.length).padStart(6)}  ` +
      `${(lw.length / lt.length * 100).toFixed(1).padStart(6)}%  ` +
      `$${lpnl.toFixed(4).padStart(9)}  ` +
      `$${(lpnl / lt.length).toFixed(4).padStart(8)}  ` +
      `${avgH.toFixed(1).padStart(5)}m`
    );
  }

  // ── 7. Daily Performance ──
  L.push('');
  L.push('SECTION 7 — DAILY PERFORMANCE');
  L.push(dsep);
  const dayMap = {};
  for (const t of closedTrades) {
    const d = t.exitTs.slice(0, 10);
    if (!dayMap[d]) dayMap[d] = { trades: 0, wins: 0, pnl: 0 };
    dayMap[d].trades++;
    if (t.pnlUsd > 0) dayMap[d].wins++;
    dayMap[d].pnl += t.pnlUsd;
  }
  L.push('  Date          Trades  Wins    PnL          Cumulative');
  L.push('  ' + '─'.repeat(60));
  let cumPnl = 0;
  for (const [d, v] of Object.entries(dayMap).sort()) {
    cumPnl += v.pnl;
    L.push(`  ${d}    ${String(v.trades).padStart(4)}  ${String(v.wins).padStart(4)}  $${v.pnl.toFixed(4).padStart(10)}  $${cumPnl.toFixed(4).padStart(10)}`);
  }

  // ── 8. Hourly Spread Distribution ──
  L.push('');
  L.push('SECTION 8 — SPREAD BY HOUR (UTC)');
  L.push(dsep);
  const hb = {};
  for (const b of bars) {
    const h = new Date(b.timestamp).getUTCHours();
    if (!hb[h]) hb[h] = [];
    hb[h].push(b.midSpread);
  }
  L.push('  Hour   SpreadMean  SpreadStd  Entries');
  L.push('  ' + '─'.repeat(44));
  for (let h = 0; h < 24; h++) {
    const arr = hb[h] || [];
    if (arr.length === 0) continue;
    const m = arr.reduce((a, v) => a + v, 0) / arr.length;
    const s = Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
    const entries = closedTrades.filter(t => new Date(t.entryTs).getUTCHours() === h).length;
    L.push(`  ${String(h).padStart(2)}:00  $${m.toFixed(4).padStart(8)}  $${s.toFixed(4).padStart(7)}  ${String(entries).padStart(6)}`);
  }

  // ── 9. First 50 trades ──
  L.push('');
  L.push('SECTION 9 — TRADE LOG (first 50)');
  L.push(dsep);
  L.push('     # Entry Time           Exit Time            Lvl EntrySig ExitSig      PnL  Hold Reason');
  for (let i = 0; i < Math.min(50, closedTrades.length); i++) {
    const t = closedTrades[i];
    const sign = t.pnlUsd >= 0 ? '+' : '';
    L.push(
      `  ${String(i+1).padStart(4)} ${t.entryTs.slice(0,19).padEnd(21)}` +
      `${t.exitTs.slice(0,19).padEnd(21)}` +
      `${String(t.gridLevel).padStart(3)} ` +
      `$${t.entrySignalSpread.toFixed(3).padStart(7)} ` +
      `$${t.exitSpread.toFixed(3).padStart(6)} ` +
      `${sign}$${t.pnlUsd.toFixed(4).padStart(8)}  ` +
      `${String(t.holdBars).padStart(4)}m ${t.exitReason}`
    );
  }
  if (closedTrades.length > 50) L.push(`  ... (${closedTrades.length - 50} more)`);

  // ── 10. RECOMMENDED CONFIG ──
  L.push('');
  L.push(sep);
  L.push('  RECOMMENDED ADAPTIVE CONFIG FOR ETH DERIBIT vs HYPERLIQUID');
  L.push(sep);
  L.push('');
  L.push('  ┌──────────────────────────────────────────────────────────────────┐');
  L.push('  │  PAIR IDENTITY                                                  │');
  L.push('  ├──────────────────────────────────────────────────────────────────┤');
  L.push('  │  exchange1:       deribit                                       │');
  L.push('  │  type1:           perpetual                                     │');
  L.push('  │  symbol1:         ETH-PERPETUAL                                 │');
  L.push('  │  exchange2:       hyperliquid                                   │');
  L.push('  │  type2:           perps                                         │');
  L.push('  │  symbol2:         ETH                                           │');
  L.push('  │  tradeLeg:        A  (Deribit — maker limit on ETH-PERPETUAL)   │');
  L.push('  │  beta:            (null — same-symbol cross-exchange)            │');
  L.push('  │  unilateralMode:  true                                          │');
  L.push('  │  executorVersion: V1  (unilateralExecutor)                      │');
  L.push('  └──────────────────────────────────────────────────────────────────┘');
  L.push('');
  L.push('  ┌──────────────────────────────────────────────────────────────────┐');
  L.push('  │  SIZING                                                         │');
  L.push('  ├──────────────────────────────────────────────────────────────────┤');
  L.push(`  │  qty1:               $${cfg.qtyUsd}  (USD notional per level)${' '.repeat(20 - String(cfg.qtyUsd).length)}│`);
  L.push(`  │  maxPositions:       ${cfg.maxPositions}${' '.repeat(43)}│`);
  L.push(`  │  maxQty1:            $${cfg.qtyUsd * cfg.maxPositions}${' '.repeat(42 - String(cfg.qtyUsd * cfg.maxPositions).length)}│`);
  L.push('  └──────────────────────────────────────────────────────────────────┘');
  L.push('');
  L.push('  ┌──────────────────────────────────────────────────────────────────┐');
  L.push('  │  ADAPTIVE LEVELS                                                │');
  L.push('  ├──────────────────────────────────────────────────────────────────┤');
  L.push('  │  adaptLevels:        true                                       │');
  L.push(`  │  adaptSigmaMin:      ${cfg.adaptSigmaMin}${' '.repeat(43 - String(cfg.adaptSigmaMin).length)}│`);
  L.push(`  │  adaptSigmaMax:      ${cfg.adaptSigmaMax}${' '.repeat(43 - String(cfg.adaptSigmaMax).length)}│`);
  L.push(`  │  adaptTpSigma:       ${cfg.adaptTpSigma}${' '.repeat(43 - String(cfg.adaptTpSigma).length)}│`);
  L.push(`  │  adaptSlSigma:       ${cfg.adaptSlSigma}${' '.repeat(43 - String(cfg.adaptSlSigma).length)}│`);
  L.push(`  │  zEntryThreshold:    ${cfg.zEntryThreshold}${' '.repeat(43 - String(cfg.zEntryThreshold).length)}│`);
  L.push(`  │  zEntryMax:          ${cfg.zEntryMax}${' '.repeat(43 - String(cfg.zEntryMax).length)}│`);
  L.push('  │                                                                 │');
  L.push('  │  Current computed levels (from rolling stats):                  │');
  for (let i = 0; i < finalLevels.length; i++) {
    const sigma = cfg.maxPositions === 1 ? cfg.adaptSigmaMin : cfg.adaptSigmaMin + (cfg.adaptSigmaMax - cfg.adaptSigmaMin) * (i / (cfg.maxPositions - 1));
    L.push(`  │    L${i+1}: $${finalLevels[i].toFixed(4)}  (mean + ${sigma.toFixed(2)}σ)${' '.repeat(35 - finalLevels[i].toFixed(4).length)}│`);
  }
  L.push(`  │  TP delta:  $${finalTp.toFixed(4)}  (${cfg.adaptTpSigma}σ × std)${' '.repeat(32 - finalTp.toFixed(4).length)}│`);
  L.push(`  │  SL delta:  $${finalSl.toFixed(4)}  (${cfg.adaptSlSigma}σ × std)${' '.repeat(32 - finalSl.toFixed(4).length)}│`);
  L.push('  └──────────────────────────────────────────────────────────────────┘');
  L.push('');
  L.push('  ┌──────────────────────────────────────────────────────────────────┐');
  L.push('  │  RISK MANAGEMENT                                                │');
  L.push('  ├──────────────────────────────────────────────────────────────────┤');
  L.push(`  │  dailyLossLimitUsd:   $${cfg.dailyLossLimit}${' '.repeat(41 - String(cfg.dailyLossLimit).length)}│`);
  L.push('  │  maxDrawdownUsd:      $500  (adjust to account size)            │');
  L.push('  │  drawdownPct:         1%                                        │');
  L.push('  └──────────────────────────────────────────────────────────────────┘');

  L.push('');
  L.push(sep);
  L.push('  END OF REPORT');
  L.push(sep);
  L.push('');

  return L.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const LOOKBACK_DAYS = 14;

  const endMs   = Date.now();
  const startMs = endMs - LOOKBACK_DAYS * 86400000;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ETH Deribit Perp vs Hyperliquid Perp — Spread Backtest    ║');
  console.log('║  Same unilateral logic as BTC bot                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Lookback: ${LOOKBACK_DAYS} days`);
  console.log(`Window:   ${new Date(startMs).toISOString().slice(0,16)} → ${new Date(endMs).toISOString().slice(0,16)}`);
  console.log('');

  console.log('Fetching Deribit ETH-PERPETUAL...');
  const deribitCandles = await fetchAllDeribitCandles('ETH-PERPETUAL', startMs, endMs, '1');
  console.log(`  → ${deribitCandles.length} candles`);

  console.log('Fetching Hyperliquid ETH perp...');
  const hyperCandles = await fetchAllHyperCandles('ETH', startMs, endMs);
  console.log(`  → ${hyperCandles.length} candles`);

  // Align on minute boundaries
  console.log('');
  console.log('Aligning...');
  const snap = (ts) => Math.floor(ts / 60000) * 60000;
  const dMap = new Map();
  for (const c of deribitCandles) dMap.set(snap(c.timestamp), c);

  const bars = [];
  for (const hc of hyperCandles) {
    const key = snap(hc.timestamp);
    const dc = dMap.get(key);
    if (!dc) continue;
    const deribitMid = (dc.high + dc.low) / 2;
    const hyperMid   = (hc.high + hc.low) / 2;
    if (deribitMid <= 0 || hyperMid <= 0) continue;
    // Same-symbol spread: deribit - hyper
    // signalSpread approximation: deribitAsk ≈ dc.high, hyperBid ≈ hc.low (within 1-min bar)
    const midSpread    = deribitMid - hyperMid;
    const signalSpread = dc.high - hc.low;  // conservative: ask - bid approx from candle extremes
    bars.push({
      timestamp: key,
      deribitMid, hyperMid,
      deribitHigh: dc.high, deribitLow: dc.low,
      hyperHigh: hc.high, hyperLow: hc.low,
      midSpread, signalSpread,
      deribitVol: dc.volume, hyperVol: hc.volume,
    });
  }
  console.log(`  → ${bars.length} aligned bars`);
  if (bars.length < 100) { console.error('Not enough data. Exiting.'); process.exit(1); }

  const allMid = bars.map(b => b.midSpread);
  const sMean = allMid.reduce((a, v) => a + v, 0) / allMid.length;
  const sStd  = Math.sqrt(allMid.reduce((a, v) => a + (v - sMean) ** 2, 0) / allMid.length);

  console.log(`Spread: mean=$${sMean.toFixed(4)}  std=$${sStd.toFixed(4)}`);
  console.log('');

  // Config — same BTC approach, sized for ETH
  const SIM_CONFIG = {
    capital:            5000,
    qtyUsd:             10000,
    maxPositions:       5,
    lookbackDays:       LOOKBACK_DAYS,
    analyticsWindow:    500,     // same as orderbookStreams SpreadTracker(500)

    adaptLevels:        true,
    adaptIntervalBars:  30,
    adaptSigmaMin:      0.5,
    adaptSigmaMax:      2.0,
    adaptTpSigma:       2.2,    // same as BTC pair21
    adaptSlSigma:       1.5,    // same as BTC pair21

    tpSpreadDelta:      parseFloat((2.2 * sStd).toFixed(4)),
    slSpreadDelta:      parseFloat((1.5 * sStd).toFixed(4)),

    initialLevels: Array.from({length: 5}, (_, i) => {
      const sigma = 0.5 + (2.0 - 0.5) * (i / 4);
      return parseFloat((sMean + sigma * sStd).toFixed(4));
    }),

    zEntryThreshold:    1.2,    // same as BTC pair21
    zEntryMax:          5,      // same as BTC pair21
    cooldownBars:       5,
    minHoldBars:        3,
    dailyLossLimit:     700,    // same as BTC pair21
  };

  console.log('Running simulation...');
  const result = simulate(bars, SIM_CONFIG);
  console.log(`  → ${result.closedTrades.length} trades`);
  console.log('');

  const report = generateReport(SIM_CONFIG, bars, result);
  console.log(report);

  const outFile = path.resolve(__dirname,
    `../reports/eth_deribit_vs_hyper_backtest_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  fs.writeFileSync(outFile, report, 'utf8');
  console.log(`Report: ${outFile}`);

  const csvFile = path.resolve(__dirname,
    `../reports/eth_cross_spread_data_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`);
  const csvH = 'timestamp,deribit_mid,hyper_mid,mid_spread,signal_spread,deribit_vol,hyper_vol';
  const csvR = bars.map(b =>
    `${new Date(b.timestamp).toISOString()},${b.deribitMid.toFixed(4)},${b.hyperMid.toFixed(4)},${b.midSpread.toFixed(4)},${b.signalSpread.toFixed(4)},${b.deribitVol},${b.hyperVol}`
  );
  fs.writeFileSync(csvFile, [csvH, ...csvR].join('\n'), 'utf8');
  console.log(`CSV:    ${csvFile}`);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
