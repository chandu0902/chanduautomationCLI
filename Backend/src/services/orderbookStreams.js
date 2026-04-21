const WebSocket = require('ws');
const spreadFileLogger = require('./spreadFileLogger');

// Lazy-loaded to avoid circular dependency (tradeExecutor requires orderbookManager)
let _tradeExecutor = null;
function getTradeExecutor() {
  if (!_tradeExecutor) {
    _tradeExecutor = require('./tradeExecutor');
  }
  return _tradeExecutor;
}
let _unilateralExecutor = null;
function getUnilateralExecutor() {
  if (!_unilateralExecutor) {
    _unilateralExecutor = require('./unilateralExecutor');
  }
  return _unilateralExecutor;
}
let _unilateralExecutorV2 = null;
function getUnilateralExecutorV2() {
  if (!_unilateralExecutorV2) {
    _unilateralExecutorV2 = require('./unilateralExecutorV2');
  }
  return _unilateralExecutorV2;
}

function computeVwapMetrics(bids, asks) {
  const top3Bids = bids.slice(0, 3);
  const top3Asks = asks.slice(0, 3);

  let buyNotional = 0, buyQty = 0;
  for (const b of top3Bids) {
    const px = parseFloat(b.price);
    const sz = parseFloat(b.size);
    buyNotional += px * sz;
    buyQty += sz;
  }
  const buyVwap = buyQty > 0 ? buyNotional / buyQty : 0;

  let sellNotional = 0, sellQty = 0;
  for (const a of top3Asks) {
    const px = parseFloat(a.price);
    const sz = parseFloat(a.size);
    sellNotional += px * sz;
    sellQty += sz;
  }
  const sellVwap = sellQty > 0 ? sellNotional / sellQty : 0;

  const netQty = buyQty - sellQty;

  // OBI from best bid/ask volumes
  const bestBidVol = bids.length > 0 ? parseFloat(bids[0].size) : 0;
  const bestAskVol = asks.length > 0 ? parseFloat(asks[0].size) : 0;
  const obiDenom = bestBidVol + bestAskVol;
  const obi = obiDenom > 0 ? (bestBidVol - bestAskVol) / obiDenom : 0;

  // Microprice = (BidVol * AskPrice + AskVol * BidPrice) / (BidVol + AskVol)
  const bestBidPx = bids.length > 0 ? parseFloat(bids[0].price) : 0;
  const bestAskPx = asks.length > 0 ? parseFloat(asks[0].price) : 0;
  const microprice = obiDenom > 0 ? (bestBidVol * bestAskPx + bestAskVol * bestBidPx) / obiDenom : 0;

  return { buyVwap, sellVwap, netQty, buyQty, sellQty, obi, microprice };
}

class SpreadTracker {
  // Dual-window tracker: fast window for entry signals, slow window for stable mean reference
  // Fast/slow divergence detects trending vs mean-reverting regimes
  constructor(slowWindow = 200, fastWindow = 20) {
    this.slowWindow = slowWindow;
    this.fastWindow = fastWindow;
    this._window = [];   // circular buffer of raw spread values (slow window)
    this._sum = 0;       // running sum for fast mean calculation
    this._sumSq = 0;     // running sum-of-squares for fast variance calculation
    // Fast window running stats
    this._fastSum = 0;
    this._fastSumSq = 0;
    // Spread velocity: EMA of tick-to-tick changes (momentum detection)
    this._velocityEma = 0;
    this._velocityAlpha = 0.3; // EMA smoothing for velocity (higher = more reactive)
    this.history = [];
    this.extremes = {
      highSpread: { value: -Infinity, timestamp: null },
      lowSpread: { value: Infinity, timestamp: null },
      highMean: { value: -Infinity, timestamp: null },
      lowMean: { value: Infinity, timestamp: null },
      highStd: { value: -Infinity, timestamp: null },
      lowStd: { value: Infinity, timestamp: null },
      highZScore: { value: -Infinity, timestamp: null },
      lowZScore: { value: Infinity, timestamp: null },
    };
    this._logBuffer = [];
    this._lastLogTime = 0;
  }

  _updateExtremes(timestamp, spread, mean, std, zScore) {
    if (spread > this.extremes.highSpread.value) this.extremes.highSpread = { value: spread, timestamp };
    if (spread < this.extremes.lowSpread.value)  this.extremes.lowSpread  = { value: spread, timestamp };
    if (mean > this.extremes.highMean.value)     this.extremes.highMean   = { value: mean, timestamp };
    if (mean < this.extremes.lowMean.value)      this.extremes.lowMean    = { value: mean, timestamp };
    if (std > this.extremes.highStd.value)       this.extremes.highStd    = { value: std, timestamp };
    if (std < this.extremes.lowStd.value)        this.extremes.lowStd     = { value: std, timestamp };
    if (zScore > this.extremes.highZScore.value) this.extremes.highZScore = { value: zScore, timestamp };
    if (zScore < this.extremes.lowZScore.value)  this.extremes.lowZScore  = { value: zScore, timestamp };
  }

  add(timestamp, spread, pairId, side) {
    const prevSpread = this._window.length >= 1 ? this._window[this._window.length - 1] : null;

    // Update spread velocity (EMA of tick-to-tick changes)
    if (prevSpread != null) {
      const delta = spread - prevSpread;
      this._velocityEma = this._velocityAlpha * delta + (1 - this._velocityAlpha) * this._velocityEma;
    }

    // Add new value to slow window
    this._window.push(spread);
    this._sum += spread;
    this._sumSq += spread * spread;

    // Remove oldest from slow window
    if (this._window.length > this.slowWindow) {
      const old = this._window.shift();
      this._sum -= old;
      this._sumSq -= old * old;
    }

    // Slow window stats
    const n = this._window.length;
    const mean = this._sum / n;
    const variance = Math.max(0, this._sumSq / n - mean * mean);
    const std = Math.sqrt(variance);

    // Fast window stats (last N ticks from the slow buffer)
    const fastN = Math.min(this.fastWindow, n);
    let fastSum = 0, fastSumSq = 0;
    for (let i = n - fastN; i < n; i++) {
      fastSum += this._window[i];
      fastSumSq += this._window[i] * this._window[i];
    }
    const fastMean = fastSum / fastN;
    const fastVariance = Math.max(0, fastSumSq / fastN - fastMean * fastMean);
    const fastStd = Math.sqrt(fastVariance);

    // Regime detection: |fastMean - slowMean| / slowStd
    // High = trending (fast mean diverging from slow), low = mean-reverting
    const regimeScore = (std > 0 && n >= 30) ? Math.abs(fastMean - mean) / std : 0;
    const isMeanReverting = regimeScore < 0.5; // Fast mean within 0.5σ of slow mean

    const zScore = (n >= 30 && std > 0) ? (spread - mean) / std : 0;
    const upperBand = mean + std;
    const lowerBand = mean - std;

    this._updateExtremes(timestamp, spread, mean, std, zScore);

    const point = {
      timestamp, spread, prevSpread, mean, std, zScore, upperBand, lowerBand,
      fastMean, fastStd,
      velocity: this._velocityEma,
      regimeScore,
      isMeanReverting,
    };
    this.history.push(point);
    if (this.history.length > 500) this.history = this.history.slice(-300);

    // Buffer logs and flush every 5 seconds
    this._logBuffer.push({ pairId, side, spread, mean, std, zScore, upperBand, lowerBand, fastMean, velocity: this._velocityEma, regimeScore });
    const now = Date.now();
    if (now - this._lastLogTime >= 5000 && this._logBuffer.length > 0) {
      this._lastLogTime = now;
      const batch = this._logBuffer.splice(0);
      spreadFileLogger.writeBatch(batch);
    }

    return point;
  }
}

/**
 * Lead-Lag Tracker: detects which asset's price movements predict the other's.
 * Computes rolling cross-correlation of mid-price returns at lags -3 to +3.
 * Positive leadScore = leg1 leads leg2 (CL leads BRENT).
 * Negative leadScore = leg2 leads leg1 (BRENT leads CL).
 * Also produces a directional signal: when the leader moves, predict the lagger.
 */
class LeadLagTracker {
  constructor(windowSize = 50) {
    this.windowSize = windowSize;
    this._mid1History = [];  // leg1 mid-price history
    this._mid2History = [];  // leg2 mid-price history
    this._ret1 = [];         // leg1 returns (log-returns)
    this._ret2 = [];         // leg2 returns (log-returns)
    this.leadScore = 0;      // positive = leg1 leads, negative = leg2 leads
    this.lagSignal = null;   // { direction: 'up'|'down', leader: 'leg1'|'leg2', strength: 0-1 }
    this._lastUpdateTime = 0;
  }

  update(mid1, mid2) {
    if (mid1 <= 0 || mid2 <= 0) return;

    this._mid1History.push(mid1);
    this._mid2History.push(mid2);

    // Compute log-returns
    if (this._mid1History.length >= 2) {
      const n = this._mid1History.length;
      this._ret1.push(Math.log(this._mid1History[n - 1] / this._mid1History[n - 2]));
      this._ret2.push(Math.log(this._mid2History[n - 1] / this._mid2History[n - 2]));
    }

    // Trim to window
    while (this._mid1History.length > this.windowSize + 5) {
      this._mid1History.shift();
      this._mid2History.shift();
    }
    while (this._ret1.length > this.windowSize) {
      this._ret1.shift();
      this._ret2.shift();
    }

    // Need enough data for cross-correlation
    if (this._ret1.length < 10) return;

    // Only recompute every 10 ticks (expensive)
    if (this._ret1.length % 10 !== 0) return;

    this._computeLeadLag();
    this._computeDirectionalSignal();
  }

  _computeLeadLag() {
    const n = this._ret1.length;
    const r1 = this._ret1;
    const r2 = this._ret2;

    // Mean and std of returns
    let sum1 = 0, sum2 = 0;
    for (let i = 0; i < n; i++) { sum1 += r1[i]; sum2 += r2[i]; }
    const mean1 = sum1 / n, mean2 = sum2 / n;
    let var1 = 0, var2 = 0;
    for (let i = 0; i < n; i++) {
      var1 += (r1[i] - mean1) ** 2;
      var2 += (r2[i] - mean2) ** 2;
    }
    const std1 = Math.sqrt(var1 / n);
    const std2 = Math.sqrt(var2 / n);
    if (std1 === 0 || std2 === 0) return;

    // Cross-correlation at lags -3 to +3
    // corr(r1[t-lag], r2[t]) — positive lag means r1 leads r2
    let bestLag = 0, bestCorr = -Infinity;
    for (let lag = -3; lag <= 3; lag++) {
      let sumXY = 0, count = 0;
      for (let t = Math.max(0, lag); t < n && (t - lag) >= 0 && (t - lag) < n; t++) {
        sumXY += (r1[t - lag] - mean1) * (r2[t] - mean2);
        count++;
      }
      if (count === 0) continue;
      const corr = sumXY / (count * std1 * std2);
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    // leadScore: positive lag with high correlation = leg1 leads
    // Weight by correlation strength
    this.leadScore = bestLag * Math.min(bestCorr, 1);
  }

  _computeDirectionalSignal() {
    const n = this._ret1.length;
    if (n < 3) { this.lagSignal = null; return; }

    // Look at last 3 returns of the leader to determine direction
    const isLeg1Leading = this.leadScore > 0.1;
    const isLeg2Leading = this.leadScore < -0.1;

    if (!isLeg1Leading && !isLeg2Leading) {
      this.lagSignal = null;
      return;
    }

    // Get recent returns of the leader (last 3 ticks)
    const leaderRets = isLeg1Leading ? this._ret1.slice(-3) : this._ret2.slice(-3);
    const avgRet = leaderRets.reduce((a, b) => a + b, 0) / leaderRets.length;

    // If leader moved significantly, predict lagger will follow
    const threshold = 0.0001; // Minimum return magnitude to count as a move
    if (Math.abs(avgRet) < threshold) {
      this.lagSignal = null;
      return;
    }

    this.lagSignal = {
      direction: avgRet > 0 ? 'up' : 'down',
      leader: isLeg1Leading ? 'leg1' : 'leg2',
      strength: Math.min(Math.abs(avgRet) / 0.001, 1), // Normalized 0-1
      leaderReturn: avgRet,
    };
  }
}

// Parse Deribit futures expiry from symbol, e.g. "BTC-24APR26" → Date UTC 08:00
function parseDeribitExpiry(symbol) {
  const m = symbol.match(/-(\d{1,2})([A-Z]{3})(\d{2})$/i);
  if (!m) return null;
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const mon = m[2].toUpperCase();
  if (months[mon] == null) return null;
  return new Date(Date.UTC(2000 + parseInt(m[3]), months[mon], parseInt(m[1]), 8, 0, 0));
}

class OrderbookManager {
  constructor() {
    this.streams = new Map();
    this.clients = new Set();
    this.spreadTrackers = new Map();
    this.pairBetas = new Map();
    this.pairMeta  = new Map(); // pairId → {type1,type2,exchange1,exchange2,symbol1}
    this.leadLagTrackers = new Map(); // pairId -> LeadLagTracker
    // Latest spread snapshot per pair — consumed by hourly adaptive-levels scheduler
    this.latestSpreadStats = new Map();
  }

  /**
   * Returns the most recent spread snapshot for a pair, with dollar-denominated
   * mean and std ready for adaptive level computation.
   * { mean, std, dollarMean, dollarStd, n, isDollarDirect }
   */
  getSpreadSnapshot(pairId) {
    return this.latestSpreadStats.get(pairId) || null;
  }

  /** Last mid-tracker sample (spread/mean/std/zScore). Units match executor feed (% p.a. for Deribit basis). */
  getLastMidSpreadPoint(pairId) {
    const midKey = `${pairId}_mid`;
    const tracker = this.spreadTrackers.get(midKey);
    const h = tracker?.history;
    if (!h || h.length === 0) return null;
    return h[h.length - 1];
  }

  /** Raw Deribit book snapshots for executor pricing (same shape as onSpreadUpdate ctx). */
  getLastLegOrderbooks(pairId) {
    const leg1 = this.streams.get(`${pairId}_leg1`)?.lastData;
    const leg2 = this.streams.get(`${pairId}_leg2`)?.lastData;
    if (!leg1 || !leg2) return null;
    return { leg1, leg2 };
  }

  addClient(ws) {
    this.clients.add(ws);
    for (const [, stream] of this.streams) {
      if (stream.lastData && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(stream.lastData));
      }
    }
    // Send existing spread history to new client
    const sentPairs = new Set();
    for (const [key, tracker] of this.spreadTrackers) {
      const [pairId, side] = key.split('_');
      if (sentPairs.has(pairId)) continue;

      // Mid tracker (beta/different-symbol pairs)
      const midTracker = this.spreadTrackers.get(`${pairId}_mid`);
      if (midTracker?.history.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'spread_history',
          pairId: parseInt(pairId),
          mid: { history: midTracker.history, extremes: midTracker.extremes },
        }));
        sentPairs.add(pairId);
        continue;
      }

      // Mid tracker already handles all pairs (same-symbol now uses _mid too)
      sentPairs.add(pairId);
    }
    ws.on('close', () => this.clients.delete(ws));
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  _updateSpreadStats(pairId) {
    const leg1 = this.streams.get(`${pairId}_leg1`)?.lastData;
    const leg2 = this.streams.get(`${pairId}_leg2`)?.lastData;
    if (!leg1 || !leg2) return;

    const beta = this.pairBetas.get(pairId);
    const now = Date.now();

    const meta = this.pairMeta.get(pairId);
    const _isPerp = (t) => t === 'perp' || t === 'perps' || t === 'perpetual';
    const isDeribitBasis = meta &&
      (meta.type1 === 'future' || meta.type1 === 'futures') &&
      _isPerp(meta.type2) &&
      meta.exchange1 === 'deribit' && meta.exchange2 === 'deribit';

    if (beta != null) {
      // Different symbols
      if (!leg1.sellVwap || !leg1.buyVwap || !leg2.sellVwap || !leg2.buyVwap) return;
      const mid1 = (leg1.sellVwap + leg1.buyVwap) / 2;
      const mid2 = (leg2.sellVwap + leg2.buyVwap) / 2;
      if (mid1 <= 0 || mid2 <= 0) return;

      // ── Deribit futures vs perp: spread = implied annualised interest rate (%) ──
      // All stats (mean/std/z-score) are on the interest rate, not log-ratio.
      // dollarConvFactor converts % p.a. stats → raw USD dollar spread (futuresMid − perpMid).
      let midSpread;
      let dollarConvFactor = null;
      if (isDeribitBasis) {
        const expiry = parseDeribitExpiry(meta.symbol1);
        const daysToExpiry = expiry ? Math.max((expiry - now) / 86400000, 1/24) : 30;
        const futuresMid = mid1;  // leg1 is always the futures
        const perpMid    = mid2;  // leg2 is always the perp
        midSpread = ((futuresMid / perpMid) - 1) * (365 / daysToExpiry) * 100; // % p.a.
        dollarConvFactor = perpMid * daysToExpiry / (365 * 100); // % p.a. → USD dollar spread
      } else {
        // Standard log-ratio spread = ln(mid1) - beta * ln(mid2)
        midSpread = Math.log(mid1) - beta * Math.log(mid2);
      }

      // Update lead-lag tracker with mid-prices
      if (!this.leadLagTrackers.has(pairId)) {
        this.leadLagTrackers.set(pairId, new LeadLagTracker(50));
      }
      const llTracker = this.leadLagTrackers.get(pairId);
      llTracker.update(mid1, mid2);

      const midKey = `${pairId}_mid`;
      if (!this.spreadTrackers.has(midKey)) {
        // Large window for stable mean/std; fast=100 for regime detection
        this.spreadTrackers.set(midKey, new SpreadTracker(5000, 100));
      }
      const midTracker = this.spreadTrackers.get(midKey);
      const midStats = midTracker.add(now, midSpread, pairId, 'mid');

      // For Deribit basis: include dollar-denominated equivalents so the frontend
      // can display raw USD spread instead of % p.a.
      const dollarFields = (isDeribitBasis && dollarConvFactor != null) ? {
        dollarSpread:    parseFloat((midStats.spread    * dollarConvFactor).toFixed(2)),
        dollarMean:      parseFloat((midStats.mean      * dollarConvFactor).toFixed(2)),
        dollarStd:       parseFloat((midStats.std       * dollarConvFactor).toFixed(2)),
        dollarUpperBand: parseFloat((midStats.upperBand * dollarConvFactor).toFixed(2)),
        dollarLowerBand: parseFloat((midStats.lowerBand * dollarConvFactor).toFixed(2)),
        dollarConvFactor,
      } : {};

      this.broadcast({
        type: 'spread_stats',
        pairId,
        mid: { ...midStats, ...dollarFields, extremes: midTracker.extremes },
        leadLag: { leadScore: llTracker.leadScore, lagSignal: llTracker.lagSignal },
      });

      // Cache live snapshot for adaptive-levels scheduler
      const _dcf = (isDeribitBasis && dollarConvFactor != null) ? dollarConvFactor : 1;
      this.latestSpreadStats.set(pairId, {
        mean:         midStats.mean,
        std:          midStats.std,
        dollarMean:   midStats.mean * _dcf,
        dollarStd:    midStats.std  * _dcf,
        n:            midTracker._window.length,
        isDollarDirect: !isDeribitBasis,
      });

      // Feed to executor (unilateral pairs use isolated unilateral executor)
      try {
        const exec = getUnilateralExecutor();
        exec.onSpreadUpdate(pairId, midStats, midStats, {
          leg1, leg2,
          isDeribitBasis,
          leadLag: { leadScore: llTracker.leadScore, lagSignal: llTracker.lagSignal },
          obi: { leg1: leg1.obi || 0, leg2: leg2.obi || 0 },
          microprice: { leg1: leg1.microprice || 0, leg2: leg2.microprice || 0 },
        });
      } catch (e) {}
      // V2 executor: no-op for pairs not registered in it
      try { getUnilateralExecutorV2().onSpreadUpdate(pairId, midStats, midStats, { leg1, leg2, isDeribitBasis }); } catch (_) {}
    } else {
      // Same symbol: use mid-price spread = deribit_mid - hyperliquid_mid
      if (!leg1.sellVwap || !leg1.buyVwap || !leg2.sellVwap || !leg2.buyVwap) return;

      const mid1 = (leg1.sellVwap + leg1.buyVwap) / 2;
      const mid2 = (leg2.sellVwap + leg2.buyVwap) / 2;
      if (mid1 <= 0 || mid2 <= 0) return;

      // Also compute sell/buy for trade executor signals
      let deribitLeg, hyperLeg;
      if (leg1.exchange === 'deribit') { deribitLeg = leg1; hyperLeg = leg2; }
      else if (leg2.exchange === 'deribit') { deribitLeg = leg2; hyperLeg = leg1; }
      const sellSpread = deribitLeg ? deribitLeg.sellVwap - hyperLeg.sellVwap : mid1 - mid2;
      const buySpread  = deribitLeg ? deribitLeg.buyVwap  - hyperLeg.buyVwap  : mid1 - mid2;
      const midSpread  = (sellSpread + buySpread) / 2;

      const midKey = `${pairId}_mid`;
      if (!this.spreadTrackers.has(midKey)) {
        this.spreadTrackers.set(midKey, new SpreadTracker(500));
      }
      const midTracker = this.spreadTrackers.get(midKey);
      const midStats = midTracker.add(now, midSpread, pairId, 'mid');

      this.broadcast({
        type: 'spread_stats',
        pairId,
        mid: { ...midStats, extremes: midTracker.extremes },
      });

      // Cache live snapshot for adaptive-levels scheduler (same-symbol: stats are already dollar)
      this.latestSpreadStats.set(pairId, {
        mean:         midStats.mean,
        std:          midStats.std,
        dollarMean:   midStats.mean,
        dollarStd:    midStats.std,
        n:            midTracker._window.length,
        isDollarDirect: true,
      });

      // Feed sell/buy stats to executor for entry/exit logic
      try {
        const sellStats = { spread: sellSpread, mean: midStats.mean, std: midStats.std, zScore: midStats.zScore };
        const buyStats  = { spread: buySpread,  mean: midStats.mean, std: midStats.std, zScore: midStats.zScore };
        const exec = getUnilateralExecutor();
        exec.onSpreadUpdate(pairId, sellStats, buyStats, {
          leg1, leg2,
          leadLag: null,
          obi: { leg1: leg1.obi || 0, leg2: leg2.obi || 0 },
          microprice: { leg1: leg1.microprice || 0, leg2: leg2.microprice || 0 },
        });
        // V2 executor: no-op for pairs not registered in it
        try { getUnilateralExecutorV2().onSpreadUpdate(pairId, sellStats, buyStats, { leg1, leg2 }); } catch (_) {}
      } catch (e) {}
    }
  }

  subscribe(pairId, side, exchange, type, symbol) {
    const key = `${pairId}_${side}`;
    if (this.streams.has(key)) return;

    const ex = (exchange || '').toLowerCase();
    if (ex === 'hyperliquid') {
      this._subscribeHyperliquid(key, pairId, side, type, symbol);
    } else if (ex === 'deribit') {
      this._subscribeDeribit(key, pairId, side, symbol);
    }
  }

  unsubscribe(pairId) {
    for (const side of ['leg1', 'leg2']) {
      const key = `${pairId}_${side}`;
      const stream = this.streams.get(key);
      if (stream) {
        stream.stopped = true;
        if (stream.ws) stream.ws.close();
        this.streams.delete(key);
      }
    }
  }

  _subscribeHyperliquid(key, pairId, side, type, symbol) {
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    const stream = { exchange: 'hyperliquid', type, symbol, ws, lastData: null, stopped: false };
    this.streams.set(key, stream);

    // For perps: coin is just the base name (e.g. "BTC") — strip "-PERP" suffix if present
    // For dex types: coin is "dexType:SYMBOL" (e.g. "xyz:TSLA")
    const coin = type === 'perps' ? symbol.replace(/-PERP$/i, '') : `${type}:${symbol}`;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin },
      }));
      console.log(`[WS] Hyperliquid subscribed: ${coin} (pair ${pairId} ${side})`);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.channel === 'l2Book' && msg.data) {
          const book = msg.data;
          const bids = (book.levels?.[0] || []).slice(0, 10).map((l) => ({
              price: l.px,
              size: l.sz,
            }));
          const asks = (book.levels?.[1] || []).slice(0, 10).map((l) => ({
              price: l.px,
              size: l.sz,
            }));
          const vwap = computeVwapMetrics(bids, asks);
          const data = {
            pairId,
            side,
            exchange: 'hyperliquid',
            symbol,
            type,
            bids,
            asks,
            buyVwap: vwap.buyVwap,
            sellVwap: vwap.sellVwap,
            netQty: vwap.netQty,
            buyQty: vwap.buyQty,
            sellQty: vwap.sellQty,
            obi: vwap.obi,
            microprice: vwap.microprice,
            timestamp: Date.now(),
          };
          stream.lastData = data;
          this.broadcast(data);
          this._updateSpreadStats(pairId);
        }
      } catch (e) {
        // ignore
      }
    });

    ws.on('close', () => {
      if (stream.stopped) return;
      console.log(`[WS] Hyperliquid ${coin} disconnected, reconnecting in 5s...`);
      this.streams.delete(key);
      setTimeout(() => {
        if (!stream.stopped && !this.streams.has(key)) {
          this._subscribeHyperliquid(key, pairId, side, type, symbol);
        }
      }, 5000);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Hyperliquid ${coin} error:`, err.message);
    });
  }

  _subscribeDeribit(key, pairId, side, symbol) {
    const ws = new WebSocket('wss://www.deribit.com/ws/api/v2');
    const stream = { exchange: 'deribit', symbol, ws, lastData: null, stopped: false, restFetching: false, lastRestFetch: 0 };
    this.streams.set(key, stream);

    const REST_COOLDOWN_MS = 5000; // min 5s between REST fallback calls per stream

    const processBook = (bids, asks) => {
      const vwap = computeVwapMetrics(bids, asks);
      const data = {
        pairId,
        side,
        exchange: 'deribit',
        symbol,
        bids,
        asks,
        buyVwap: vwap.buyVwap,
        sellVwap: vwap.sellVwap,
        netQty: vwap.netQty,
        buyQty: vwap.buyQty,
        sellQty: vwap.sellQty,
        obi: vwap.obi,
        microprice: vwap.microprice,
        timestamp: Date.now(),
      };
      stream.lastData = data;
      this.broadcast(data);
      this._updateSpreadStats(pairId);
    };

    const fetchRestOrderbook = async () => {
      if (stream.stopped || stream.restFetching) return;
      const now = Date.now();
      if (now - stream.lastRestFetch < REST_COOLDOWN_MS) return;
      stream.restFetching = true;
      stream.lastRestFetch = now;
      try {
        const res = await fetch(`https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(symbol)}&depth=10`);
        if (res.status === 429) {
          console.warn(`[REST] Deribit ${symbol} rate limited, backing off`);
          stream.lastRestFetch = now + 15000;
          return;
        }
        const json = await res.json();
        if (json.result) {
          const bids = (json.result.bids || []).slice(0, 10).map(b => ({
            price: String(b[0]),
            size: String(b[1]),
          }));
          const asks = (json.result.asks || []).slice(0, 10).map(a => ({
            price: String(a[0]),
            size: String(a[1]),
          }));
          if (bids.length > 0 || asks.length > 0) {
            processBook(bids, asks);
          }
        }
      } catch (e) {
        console.error(`[REST] Deribit ${symbol} orderbook fetch error:`, e.message);
      } finally {
        stream.restFetching = false;
      }
    };

    // Use grouped snapshot channel: sends full book (20 levels) every 100ms
    ws.on('open', () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'public/subscribe',
        params: { channels: [`book.${symbol}.none.20.100ms`] },
      }));
      console.log(`[WS] Deribit subscribed: ${symbol} (pair ${pairId} ${side})`);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.params?.channel?.startsWith('book.') && msg.params?.data) {
          const book = msg.params.data;
          // Grouped snapshot format: [price, amount]
          const bids = (book.bids || []).slice(0, 10).map((b) => ({
            price: String(b[0]),
            size: String(b[1]),
          }));
          const asks = (book.asks || []).slice(0, 10).map((a) => ({
            price: String(a[0]),
            size: String(a[1]),
          }));

          // If WS has enough levels (>10 combined), use it; otherwise REST fallback
          if (bids.length + asks.length >= 10) {
            processBook(bids, asks);
          } else {
            console.log(`[WS] Deribit ${symbol} sparse data (${bids.length}b/${asks.length}a), using REST fallback`);
            fetchRestOrderbook();
          }
        }
      } catch (e) {
        // ignore
      }
    });

    ws.on('close', () => {
      if (stream.stopped) return;
      console.log(`[WS] Deribit ${symbol} disconnected, reconnecting in 5s...`);
      this.streams.delete(key);
      setTimeout(() => {
        if (!stream.stopped && !this.streams.has(key)) {
          this._subscribeDeribit(key, pairId, side, symbol);
        }
      }, 5000);
    });

    ws.on('error', (err) => {
      console.error(`[WS] Deribit ${symbol} error:`, err.message);
    });
  }

  async syncWithActivePairs(pairs) {
    const activeKeys = new Set();
    for (const pair of pairs) {
      activeKeys.add(`${pair.id}_leg1`);
      activeKeys.add(`${pair.id}_leg2`);
      this.pairBetas.set(pair.id, pair.beta != null ? pair.beta : null);
      this.pairMeta.set(pair.id, {
        type1: (pair.type1 || '').toLowerCase(),
        type2: (pair.type2 || '').toLowerCase(),
        exchange1: (pair.exchange1 || '').toLowerCase(),
        exchange2: (pair.exchange2 || '').toLowerCase(),
        symbol1: pair.symbol1,
        unilateralMode: !!pair.unilateralMode,
      });
      this.subscribe(pair.id, 'leg1', pair.exchange1, pair.type1, pair.symbol1);
      this.subscribe(pair.id, 'leg2', pair.exchange2, pair.type2, pair.symbol2);
    }
    for (const [key, stream] of this.streams) {
      if (!activeKeys.has(key)) {
        stream.stopped = true;
        if (stream.ws) stream.ws.close();
        this.streams.delete(key);
      }
    }
  }
}

module.exports = new OrderbookManager();
