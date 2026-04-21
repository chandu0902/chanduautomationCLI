const crypto = require('crypto');
const {
  buyorder,
  sellorder,
  cancelorder,
  deribitorderStatus,
  signedRequest,
} = require('../controllers/apicontroller');
const { StatArbInput, AccountDetails } = require('../models');
const Trade = require('../models/Trade');
const BasisPosition = require('../models/BasisPosition');
const SpreadLevelHistory = require('../models/SpreadLevelHistory');

const POLL_MS = 1500;
const ENTRY_TIMEOUT_MS = 45000;
const EXIT_TIMEOUT_MS = 30000;
const COOLDOWN_MS = 30000;

function minGrossProfitUsd() { return 0; }
function minTpSpreadFloor() { return 0; }

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function getApiCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
  const secretKey = decryptText(sk2, sk1, sk0);
  return { apiKey, secretKey };
}

class UniState {
  constructor(pairId) {
    this.pairId = pairId;
    this.enabled = false;
    this.enabledAt = null;
    this.pair = null;
    this.clientA = null;
    this.lastOrderbooks = null;
    this.openPositions = [];
    this.levelQty = [];
    this.levels = [];
    this.prevSignalSpread = null;
    this.lastEntryAt = 0;
    this.filledQty = 0;
    this.tpSpreadDelta = null;
    this.slSpreadDelta = null;
    this.entryTimeoutMs = ENTRY_TIMEOUT_MS;
    this._entryInFlight = false;
    this.tradeLeg = 'A';
    this.tradeSymbol = null;
    this.dailyPnl = 0;
    this.dailyPnlResetDate = new Date().toISOString().slice(0, 10);
    this.dailyLossLimitUsd = 0;
    this.lastStopExitAt = 0;
    this._cachedBalance = null;
    this._startBalance = null;
    this._botStartBalance = null;
    this._livePositions = [];
    this._feeLevel = null;
    this._makerRebate = null;
    this._accountRefreshTimer = null;
    this.maxDrawdownUsd = 0;
    this.drawdownPct = 0;
    this._peakEquity = null;
    this._currentEquity = null;
    this._currentDrawdownUsd = 0;
    this._currentDrawdownPct = 0;
    this._killSwitchTriggered = false;
    // Adaptive-levels state (set by hourly scheduler, never persisted to DB)
    this._adaptedAt = null;
    this._adaptedMaxSpreadCap = null;
    // Zone Grid state
    this.zoneGrid = null;
    this._activeZone = null;
    this._baselineLevels = [];
    this._baselineLevelQty = [];
    this._baselineTp = null;
    this._baselineSl = null;
    // Analytics
    this._analytics = null;
    this._lastAnalyticsLog = 0;
  }
}

// ─── Zone Grid Module ────────────────────────────────────────────────────────
//
// Divides a price range around an anchor into subset zones, each with its own
// qty, spread-entry levels, TP, SL, and maxPositions.  Activated by setting
// `zoneGridConfig` (JSON) on the pair record.
//
// Config format (JSON string on pair.zoneGridConfig):
// {
//   "anchorPrice": 80,            — centre / anchor price (e.g. SOL @ $80)
//   "range": 4,                   — dollars up AND down from anchor
//   "zoneCount": 4,               — number of subset zones per side
//   "zones": [                    — per-zone config, index 0 = closest to anchor
//     { "qty": 1.0, "levels": [50,52,54], "tp": 15, "sl": 25, "maxPositions": 3 },
//     { "qty": 0.8, "levels": [52,55],    "tp": 18, "sl": 30, "maxPositions": 2 },
//     { "qty": 0.6, "levels": [55,58],    "tp": 22, "sl": 35, "maxPositions": 2 },
//     { "qty": 0.4, "levels": [58],       "tp": 25, "sl": 40, "maxPositions": 1 }
//   ],
//   "downZones": null             — optional; if omitted, mirrors "zones" for downside
// }
//
// "levels" inside each zone are SPREAD entry thresholds (futAsk − perpBid),
// same unit as the existing spreadEntryLevels.
// "qty" is the order size for every grid level in that zone.
// "levelQty" (optional array) overrides qty per level within a zone.
// ──────────────────────────────────────────────────────────────────────────────

// ─── Life Engine ──────────────────────────────────────────────────────────────

function makeLives(n = 4) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    status: 'alive',
    currentPosId: null,
  }));
}

function freeLives(zone) {
  return zone.lives ? zone.lives.filter(l => l.status === 'alive' && l.currentPosId == null) : [];
}

function isZoneGone(zone) {
  return zone.lives ? zone.lives.every(l => l.status === 'dead') : false;
}

function reserveLife(zone, posId) {
  const l = freeLives(zone)[0];
  if (!l) return null;
  l.currentPosId = posId;
  return l;
}

function releaseLife(zone, lifeId) {
  if (!zone.lives) return;
  const l = zone.lives.find(x => x.id === lifeId);
  if (l && l.status === 'alive') l.currentPosId = null;
}

function killLife(zone, lifeId) {
  if (!zone.lives) return;
  const l = zone.lives.find(x => x.id === lifeId);
  if (!l) return;
  l.status = 'dead';
  l.currentPosId = null;
}

function _findZoneById(grid, id) {
  return [...grid.upZones, ...grid.downZones].find(z => z.id === id) || null;
}

class ZoneGrid {
  constructor(config) {
    this.anchor = config.anchorPrice;
    this.range = config.range;
    this.count = config.zoneCount || 4;
    this.zoneWidth = this.range / this.count;
    this.upZones = [];
    this.downZones = [];

    const zoneCfgs = Array.isArray(config.zones) ? config.zones : [];
    const downCfgs = Array.isArray(config.downZones) ? config.downZones : null;

    for (let i = 0; i < this.count; i++) {
      const cfg = zoneCfgs[i] || {};
      const levels = Array.isArray(cfg.levels)
        ? cfg.levels.slice().sort((a, b) => a - b)
        : [];

      this.upZones.push({
        id: `up_${i}`,
        side: 'up',
        index: i,
        low: this.anchor + i * this.zoneWidth,
        high: this.anchor + (i + 1) * this.zoneWidth,
        qty: cfg.qty ?? null,
        levelQty: Array.isArray(cfg.levelQty) ? cfg.levelQty : null,
        levels,
        tp: cfg.tp ?? null,
        sl: cfg.sl ?? null,
        trailPct: cfg.trailPct ?? null,
        maxPositions: cfg.maxPositions ?? null,
        lives: makeLives(4),
      });

      const dCfg = downCfgs ? (downCfgs[i] || {}) : cfg;
      const dLevels = downCfgs
        ? (Array.isArray(dCfg.levels) ? dCfg.levels.slice().sort((a, b) => a - b) : [])
        : levels;

      this.downZones.push({
        id: `down_${i}`,
        side: 'down',
        index: i,
        low: this.anchor - (i + 1) * this.zoneWidth,
        high: this.anchor - i * this.zoneWidth,
        qty: dCfg.qty ?? null,
        levelQty: downCfgs && Array.isArray(dCfg.levelQty) ? dCfg.levelQty : (Array.isArray(cfg.levelQty) ? cfg.levelQty : null),
        levels: dLevels,
        tp: dCfg.tp ?? null,
        sl: dCfg.sl ?? null,
        trailPct: (downCfgs ? dCfg.trailPct : cfg.trailPct) ?? null,
        maxPositions: dCfg.maxPositions ?? null,
        lives: makeLives(4),
      });
    }
  }

  getZone(price) {
    if (price >= this.anchor) {
      for (const z of this.upZones) {
        if (price >= z.low && price < z.high) return z;
      }
      if (price >= this.anchor + this.range - 0.0001) {
        return this.upZones[this.upZones.length - 1];
      }
    } else {
      for (const z of this.downZones) {
        if (price > z.low && price <= z.high) return z;
      }
      if (price <= this.anchor - this.range + 0.0001) {
        return this.downZones[this.downZones.length - 1];
      }
    }
    return null;
  }

  isInRange(price) {
    return price >= (this.anchor - this.range) && price <= (this.anchor + this.range);
  }

  getAllZones() {
    return [...this.upZones, ...this.downZones];
  }

  describe() {
    const lines = [
      `ZoneGrid anchor=$${this.anchor} range=±$${this.range} ` +
      `(${this.count} zones/side, width=$${this.zoneWidth.toFixed(2)})`
    ];
    for (const z of [...this.upZones, ...this.downZones]) {
      lines.push(
        `  ${z.id}: $${z.low.toFixed(2)}-$${z.high.toFixed(2)} ` +
        `qty=${z.qty} levels=[${z.levels}] tp=${z.tp} sl=${z.sl} maxPos=${z.maxPositions}`
      );
    }
    return lines.join('\n');
  }
}

// ─── Spread Analytics Module ─────────────────────────────────────────────────
// Rolling computation of Hurst exponent, autocorrelation, mean-reversion
// half-life, order-book imbalance (OBI), microprice, and regime classification.
// Fed on every spread tick; heavy stats recomputed once per minute.
// ──────────────────────────────────────────────────────────────────────────────

class SpreadAnalytics {
  constructor(windowSize = 120) {
    this.windowSize = windowSize;
    this.spreads = [];
    this.prices = [];
    this.hurst = null;
    this.autocorrelation = null;
    this.meanReversionHalfLife = null;
    this.regime = 'unknown';
    this.obi = null;
    this.microprice = null;
    this._lastComputeAt = 0;
    this._computeIntervalMs = 60000;
  }

  addTick(spread, price, ob1, ob2) {
    this.spreads.push(spread);
    this.prices.push(price);
    if (this.spreads.length > this.windowSize * 2) {
      this.spreads = this.spreads.slice(-this.windowSize);
      this.prices = this.prices.slice(-this.windowSize);
    }
    if (ob1 && ob2) {
      this._computeOBI(ob1, ob2);
      this._computeMicroprice(ob1, ob2);
    }
    const now = Date.now();
    if (now - this._lastComputeAt >= this._computeIntervalMs && this.spreads.length >= 30) {
      this._computeAll();
      this._lastComputeAt = now;
    }
  }

  _computeOBI(ob1, ob2) {
    const bids = ob1?.bids || [];
    const asks = ob1?.asks || [];
    let bidVol = 0, askVol = 0;
    const depth = Math.min(3, bids.length, asks.length);
    for (let i = 0; i < depth; i++) {
      bidVol += parseFloat(bids[i]?.amount || bids[i]?.size || 0);
      askVol += parseFloat(asks[i]?.amount || asks[i]?.size || 0);
    }
    const total = bidVol + askVol;
    this.obi = total > 0 ? parseFloat(((bidVol - askVol) / total).toFixed(4)) : 0;
  }

  _computeMicroprice(ob1 /*, ob2 */) {
    const bestBid = parseFloat(ob1?.bids?.[0]?.price || 0);
    const bestAsk = parseFloat(ob1?.asks?.[0]?.price || 0);
    const bidVol = parseFloat(ob1?.bids?.[0]?.amount || ob1?.bids?.[0]?.size || 0);
    const askVol = parseFloat(ob1?.asks?.[0]?.amount || ob1?.asks?.[0]?.size || 0);
    if (bestBid > 0 && bestAsk > 0 && (bidVol + askVol) > 0) {
      this.microprice = parseFloat(
        ((bestBid * askVol + bestAsk * bidVol) / (bidVol + askVol)).toFixed(4)
      );
    }
  }

  _computeAll() {
    const spreads = this.spreads.slice(-this.windowSize);
    if (spreads.length < 30) return;
    this.hurst = this._computeHurst(spreads);
    this.autocorrelation = this._computeAutocorrelation(spreads);
    this.meanReversionHalfLife = this._computeHalfLife(spreads);
    this.regime = this._classifyRegime();
  }

  _computeHurst(series) {
    const n = series.length;
    if (n < 20) return null;
    const subSizes = [];
    for (let s = 10; s <= Math.floor(n / 2); s = Math.floor(s * 1.5)) subSizes.push(s);
    if (subSizes.length < 3) return null;
    const logN = [], logRS = [];
    for (const size of subSizes) {
      const nBlocks = Math.floor(n / size);
      if (nBlocks < 1) continue;
      let rsSum = 0;
      for (let b = 0; b < nBlocks; b++) {
        const block = series.slice(b * size, (b + 1) * size);
        const mean = block.reduce((a, v) => a + v, 0) / block.length;
        const cumDev = [];
        let cum = 0;
        for (const v of block) { cum += v - mean; cumDev.push(cum); }
        const R = Math.max(...cumDev) - Math.min(...cumDev);
        const S = Math.sqrt(block.reduce((a, v) => a + (v - mean) ** 2, 0) / block.length);
        if (S > 0) rsSum += R / S;
      }
      const avgRS = rsSum / nBlocks;
      if (avgRS > 0) { logN.push(Math.log(size)); logRS.push(Math.log(avgRS)); }
    }
    if (logN.length < 3) return null;
    const nPts = logN.length;
    const sumX = logN.reduce((a, v) => a + v, 0);
    const sumY = logRS.reduce((a, v) => a + v, 0);
    const sumXY = logN.reduce((a, v, i) => a + v * logRS[i], 0);
    const sumX2 = logN.reduce((a, v) => a + v * v, 0);
    const H = (nPts * sumXY - sumX * sumY) / (nPts * sumX2 - sumX * sumX);
    return parseFloat(Math.max(0, Math.min(1, H)).toFixed(4));
  }

  _computeAutocorrelation(series, lag = 1) {
    const n = series.length;
    if (n <= lag + 1) return null;
    const returns = [];
    for (let i = 1; i < n; i++) returns.push(series[i] - series[i - 1]);
    if (returns.length <= lag) return null;
    const mean = returns.reduce((a, v) => a + v, 0) / returns.length;
    let num = 0, den = 0;
    for (let i = lag; i < returns.length; i++) num += (returns[i] - mean) * (returns[i - lag] - mean);
    for (let i = 0; i < returns.length; i++) den += (returns[i] - mean) ** 2;
    return den > 0 ? parseFloat((num / den).toFixed(4)) : 0;
  }

  _computeHalfLife(series) {
    const n = series.length;
    if (n < 10) return null;
    const mean = series.reduce((a, v) => a + v, 0) / n;
    const y = [], x = [];
    for (let i = 1; i < n; i++) {
      y.push(series[i] - series[i - 1]);
      x.push(series[i - 1] - mean);
    }
    const sumXY = x.reduce((a, v, i) => a + v * y[i], 0);
    const sumX2 = x.reduce((a, v) => a + v * v, 0);
    if (sumX2 === 0) return null;
    const beta = sumXY / sumX2;
    if (beta >= 0) return Infinity;
    return parseFloat(Math.max(0, -Math.log(2) / Math.log(1 + beta)).toFixed(2));
  }

  _classifyRegime() {
    if (this.hurst == null) return 'unknown';
    const s = this.spreads.slice(-this.windowSize);
    if (s.length >= 10) {
      const mean = s.reduce((a, v) => a + v, 0) / s.length;
      const std  = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length);
      if (std < 0.02) return 'mean_reverting';
    }
    if (this.hurst < 0.4) return 'mean_reverting';
    if (this.hurst > 0.6) return 'trending';
    return 'random_walk';
  }

  getSnapshot() {
    return {
      hurst: this.hurst,
      autocorrelation: this.autocorrelation,
      meanReversionHalfLife: this.meanReversionHalfLife,
      regime: this.regime,
      obi: this.obi,
      microprice: this.microprice,
      sampleCount: this.spreads.length,
    };
  }
}

// ─── Avellaneda–Stoikov Optimal Quoting ──────────────────────────────────────
// Computes reservation spread and optimal half-spread for the inter-exchange
// spread market (Deribit futures − Hyperliquid perp).
// ──────────────────────────────────────────────────────────────────────────────

class AvellanedaStoikov {
  constructor(params = {}) {
    this.gamma_short   = params.gamma_short   ?? 0.08;
    this.gamma_long    = params.gamma_long    ?? 0.14;
    this.beta_premium  = params.beta_premium  ?? 0.75;
    this.k             = params.k             ?? 6.0;
    this.tau           = params.tau           ?? 1.5;
  }

  _gamma(inventory) {
    return inventory >= 0 ? this.gamma_short : this.gamma_long;
  }

  reservationSpread(meanSpread, inventory, sigma) {
    const g = this._gamma(inventory);
    return meanSpread - inventory * g * sigma * sigma * this.tau;
  }

  optimalHalfSpread(sigma, inventory) {
    const g = this._gamma(inventory);
    return (g * sigma * sigma * this.tau) / 2 + (1 / g) * Math.log(1 + g / this.k);
  }

  quotes(meanSpread, inventory, sigma, regimeMultiplier, skew) {
    const rp = this.reservationSpread(meanSpread, inventory, sigma);
    let hs = this.optimalHalfSpread(sigma, inventory);
    hs *= regimeMultiplier;
    const bidSpread = rp - hs * (skew?.bidWidenLambda ?? 1.0);
    const askSpread = rp + hs * (skew?.askTightenPhi  ?? 0.6);
    return { bidSpread, askSpread, reservation: rp, halfSpread: hs };
  }
}

// ─── Breakout Detector ──────────────────────────────────────────────────────
// Fires when >= 2 of 4 signals trigger simultaneously.
// ──────────────────────────────────────────────────────────────────────────────

const REGIME_MR = 'MR';
const REGIME_TR = 'TR';
const REGIME_BO = 'BO';

const SPREAD_MULT = { [REGIME_MR]: 0.90, [REGIME_TR]: 1.20, [REGIME_BO]: 2.40 };

class BreakoutDetector {
  constructor() {
    this.fills       = [];
    this._spreadHist = [];
    this._tsHist     = [];
    this._volWindow  = [];
    this._volLong    = [];
  }

  addFill(adverse) {
    this.fills.push({ adverse: !!adverse, t: Date.now() });
    if (this.fills.length > 20) this.fills = this.fills.slice(-20);
  }

  addSpreadTick(spread, ts) {
    this._spreadHist.push(spread);
    this._tsHist.push(ts || Date.now());
    if (this._spreadHist.length > 200) {
      this._spreadHist = this._spreadHist.slice(-200);
      this._tsHist     = this._tsHist.slice(-200);
    }
    this._volWindow.push(spread);
    this._volLong.push(spread);
    if (this._volWindow.length > 20) this._volWindow = this._volWindow.slice(-20);
    if (this._volLong.length > 120) this._volLong = this._volLong.slice(-120);
  }

  spreadVelocitySigma() {
    const h = this._spreadHist;
    const t = this._tsHist;
    if (h.length < 4) return 0;
    const lookback = 3;
    const recentIdx = h.length - 1;
    const startIdx  = Math.max(0, recentIdx - lookback);
    const dt = (t[recentIdx] - t[startIdx]) / 1000;
    if (dt <= 0 || dt > 2.0) return 0;
    const delta = Math.abs(h[recentIdx] - h[startIdx]);
    const returns = [];
    for (let i = 1; i < h.length; i++) returns.push(h[i] - h[i - 1]);
    if (returns.length < 5) return 0;
    const mean = returns.reduce((a, v) => a + v, 0) / returns.length;
    const std  = Math.sqrt(returns.reduce((a, v) => a + (v - mean) ** 2, 0) / returns.length);
    return std > 0 ? delta / std : 0;
  }

  volRatio() {
    if (this._volWindow.length < 5 || this._volLong.length < 30) return 1;
    const stdShort = this._std(this._volWindow);
    const stdLong  = this._std(this._volLong);
    return stdLong > 0 ? stdShort / stdLong : 1;
  }

  adverseFillCount() {
    const last10 = this.fills.slice(-10);
    return last10.filter(f => f.adverse).length;
  }

  check(zScore) {
    if (this._spreadHist.length < 30) return { isBreakout: false, triggers: 0, details: {} };
    let triggers = 0;
    if (Math.abs(zScore) > 2.2) triggers++;
    if (this.volRatio() > 1.5)  triggers++;
    if (this.spreadVelocitySigma() > 2) triggers++;
    if (this.adverseFillCount() >= 3) triggers++;
    return { isBreakout: triggers >= 2, triggers, details: {
      zScore: Math.abs(zScore).toFixed(4),
      volRatio: this.volRatio().toFixed(4),
      velocity: this.spreadVelocitySigma().toFixed(4),
      adverseFills: this.adverseFillCount(),
    }};
  }

  _std(arr) {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, v) => a + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, v) => a + (v - m) ** 2, 0) / arr.length);
  }
}

class UnilateralExecutor {
  constructor() {
    this.pairs = new Map();
    this.startedAt = Date.now();
  }

  _isLinearUsdc(state) {
    const sym = state.tradeSymbol || state.pair?.symbol1 || '';
    return sym.includes('_USDC');
  }

  _settlementCurrency(state) {
    return this._isLinearUsdc(state) ? 'USDC' : 'BTC';
  }

  _broadcastState(pairId) {
    try {
      const orderbookManager = require('./orderbookStreams');
      orderbookManager.broadcast({ type: 'trade_state', pairId, ...this.getState(pairId) });
    } catch (_) { }
  }

  async _placeLimit(state, side, qty, price) {
    const cred = state.clientA;
    const symbol = state.tradeSymbol || state.pair.symbol1;
    const result = side === 'buy'
      ? await buyorder(symbol, qty, 'limit', price, cred.apiKey, cred.secretKey)
      : await sellorder(symbol, qty, 'limit', price, cred.apiKey, cred.secretKey);
    const order = result?.result?.order;
    return {
      orderId: order?.order_id || null,
      state: order?.order_state || null,
      avgPrice: order?.average_price || order?.price || price,
    };
  }

  async _cancel(state, orderId) {
    if (!orderId) return;
    await cancelorder(orderId, state.clientA.apiKey, state.clientA.secretKey).catch(() => { });
  }

  async _orderStatus(state, orderId) {
    const resp = await deribitorderStatus(orderId, state.clientA.apiKey, state.clientA.secretKey);
    let r = resp?.result;
    if (Array.isArray(r)) r = r[0];
    if (!r) return { status: 'unknown', filledPrice: null };
    const s = (r.order_state || '').toLowerCase();
    if (s === 'filled') return { status: 'filled', filledPrice: parseFloat(r.average_price || r.price || 0) || null };
    if (s === 'cancelled' || s === 'canceled' || s === 'rejected') return { status: 'cancelled', filledPrice: null };
    return { status: 'open', filledPrice: null };
  }

  _estimateGrossPnlUsd(isLegB, qty, entryPx, exitPx, isLinear = false) {
    if (!qty || !entryPx || !exitPx || entryPx <= 0 || exitPx <= 0) return 0;
    if (isLinear) {
      const pnl = isLegB
        ? qty * (exitPx - entryPx)
        : qty * (entryPx - exitPx);
      return parseFloat(pnl.toFixed(6));
    }
    const pnlBtc = isLegB
      ? qty * (1 / entryPx - 1 / exitPx)
      : qty * (1 / exitPx - 1 / entryPx);
    return parseFloat((pnlBtc * exitPx).toFixed(6));
  }

  async _getOrderCommissionUsd(state, orderId, fallbackPrice) {
    if (!orderId) return null;
    try {
      const resp = await signedRequest(
        `/api/v2/private/get_user_trades_by_order?order_id=${orderId}`,
        state.clientA.apiKey,
        state.clientA.secretKey
      );
      const fills = Array.isArray(resp?.result) ? resp.result : [];
      if (fills.length === 0) return null;
      let totalUsd = 0;
      for (const f of fills) {
        const fee = Number(f?.fee ?? 0);
        if (!Number.isFinite(fee)) continue;
        const feeCurrency = String(f?.fee_currency || '').toUpperCase();
        const px = Number(f?.price ?? fallbackPrice ?? 0);
        // Deribit: fee < 0 = maker rebate (income), fee > 0 = taker cost.
        // Negate so positive = income (rebate), negative = cost (taker fee).
        if (feeCurrency === 'BTC' && px > 0) {
          totalUsd += -fee * px;
        } else {
          totalUsd += -fee;
        }
      }
      return Number.isFinite(totalUsd) ? parseFloat(totalUsd.toFixed(6)) : null;
    } catch (_) {
      return null;
    }
  }

  _parseLevels(pair) {
    const levels = String(pair.spreadEntryLevels || '')
      .split(',')
      .map((x) => parseFloat(x))
      .filter((x) => Number.isFinite(x) && x > 0)
      .sort((a, b) => a - b);
    return levels;
  }

  _computeLevelQty(pair, levels) {
    const totalWeight = levels.reduce((a, b) => a + b, 0) || 1;
    const sym = pair.symbol1 || '';
    if (sym.includes('_USDC')) {
      return levels.map((lvl) => {
        const raw = pair.qty1 * lvl / totalWeight;
        return Math.max(0.1, Math.round(raw * 10) / 10);
      });
    }
    return levels.map((lvl) => Math.max(10, Math.round((pair.qty1 * lvl) / totalWeight / 10) * 10));
  }

  async enableTrading(pairId) {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return { success: false, message: 'Pair not found' };
    const levels = this._parseLevels(pair);
    if (levels.length === 0) return { success: false, message: 'Invalid spreadEntryLevels — set comma-separated thresholds' };
    const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
    if (!acc) return { success: false, message: `Account not found: ${pair.tradeAccountA}` };
    const clientA = await getApiCredentials(acc);

    let state = this.pairs.get(pairId);
    if (!state) {
      state = new UniState(pairId);
      this.pairs.set(pairId, state);
    }
    state._botStartBalance = pair.botStartBalance ?? null;
    state.enabled = true;
    state.enabledAt = Date.now();
    state.pair = pair;
    state.clientA = clientA;
    state.levels = levels;
    state.levelQty = this._computeLevelQty(pair, levels);
    // TP: $ narrowing of futAsk−perpBid vs entry signal for profit exit (default 20 USD).
    let tp = pair.tpSpreadDelta != null ? parseFloat(pair.tpSpreadDelta) : 20;
    if (!Number.isFinite(tp) || tp <= 0) tp = 20;
    state.tpSpreadDelta = tp;
    let sl = pair.slSpreadDelta != null ? parseFloat(pair.slSpreadDelta) : 35;
    if (!Number.isFinite(sl) || sl <= 0) sl = 35;
    state.slSpreadDelta = this._isLinearUsdc(state) ? sl : Math.max(sl, 12);
    state.entryTimeoutMs = pair.entryPollTimeoutMs != null ? parseInt(pair.entryPollTimeoutMs) : ENTRY_TIMEOUT_MS;
    state.tradeLeg = (pair.tradeLeg || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    state.tradeSymbol = state.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
    state.prevSignalSpread = null;
    state._entryInFlight = false;
    let dll = pair.dailyLossLimitUsd != null ? parseFloat(pair.dailyLossLimitUsd) : 0;
    state.dailyLossLimitUsd = Number.isFinite(dll) && dll > 0 ? dll : 0;
    let mdd = pair.maxDrawdownUsd != null ? parseFloat(pair.maxDrawdownUsd) : 0;
    state.maxDrawdownUsd = Number.isFinite(mdd) && mdd > 0 ? mdd : 0;
    let ddPct = pair.drawdownPct != null ? parseFloat(pair.drawdownPct) : 0;
    state.drawdownPct = Number.isFinite(ddPct) && ddPct > 0 ? ddPct : 0;
    state._peakEquity = null;
    state._currentEquity = null;
    state._currentDrawdownUsd = 0;
    state._currentDrawdownPct = 0;
    state._killSwitchTriggered = false;

    // ── Zone Grid setup ──────────────────────────────────────────────────────
    state.zoneGrid = null;
    state._activeZone = null;
    if (pair.zoneGridConfig) {
      try {
        const zCfg = typeof pair.zoneGridConfig === 'string'
          ? JSON.parse(pair.zoneGridConfig)
          : pair.zoneGridConfig;
        if (zCfg && zCfg.anchorPrice != null && zCfg.range > 0 && zCfg.zoneCount > 0) {
          state.zoneGrid = new ZoneGrid(zCfg);
          state._baselineLevels = [...state.levels];
          state._baselineLevelQty = [...state.levelQty];
          state._baselineTp = state.tpSpreadDelta;
          state._baselineSl = state.slSpreadDelta;
          console.log(`[UniExecutor] pair ${pairId} Zone Grid enabled:\n${state.zoneGrid.describe()}`);
        }
      } catch (e) {
        console.warn(`[UniExecutor] pair ${pairId} failed to parse zoneGridConfig: ${e.message}`);
      }
    }

    state._analytics = new SpreadAnalytics(120);
    state._lastAnalyticsLog = 0;

    // Reload open/pending_entry positions from DB so maxPositions and per-level
    // duplicate checks survive server restarts (nodemon or otherwise).
    // Also mark any stuck pending_entry rows as failed — their poll timers are gone.
    try {
      const { Op } = require('sequelize');
      const dbPositions = await BasisPosition.findAll({
        where: { pairId, state: { [Op.in]: ['open', 'pending_entry'] } },
        order: [['id', 'ASC']],
      });
      // Expire stuck pending_entry rows immediately — no poll timer will resume them.
      const stuckPending = dbPositions.filter(p => p.state === 'pending_entry');
      for (const sp of stuckPending) {
        await BasisPosition.update({ state: 'failed' }, { where: { id: sp.id } }).catch(() => {});
        console.log(`[UniExecutor] pair ${pairId} marked stuck pending_entry #${sp.id} as failed on reload`);
      }
      // Rebuild in-memory shadow entries for genuinely open positions so the
      // maxPositions guard and per-level duplicate check work correctly.
      const openRows = dbPositions.filter(p => p.state === 'open');
      state.openPositions = openRows.map(p => ({
        id: `reload_${p.id}`,
        status: 'open',
        gridLevel: p.gridLevel,
        level: levels[p.gridLevel - 1] ?? 0,
        qty: p.legA_entryQty ?? pair.qty1,
        entryOrderId: null,
        entryTradeId: p.entryTradeId,
        basisPositionId: p.id,
        entrySignalSpread: p.entrySpread ?? 0,
        entryPriceA: p.legA_entryPrice,
        entryPriceB: p.legB_entryPrice,
        fillSpread: p.entrySpread ?? 0,
        bestSpread: p.entrySpread ?? 0,
        openedAt: p.entryTime ? new Date(p.entryTime).getTime() : Date.now(),
        entryCommissionUsd: null,
        profitTicks: 0,
        stopTicks: 0,
        timeExitTicks: 0,
        pollTimer: null,
        pollStart: Date.now(),
        exitOrderId: null,
        exitTradeId: null,
        _repriced: false,
        entryZoneId: null,
        zoneTp: null,
        zoneSl: null,
      }));
      if (state.openPositions.length > 0) {
        console.log(`[UniExecutor] pair ${pairId} reloaded ${state.openPositions.length} open position(s) from DB (${stuckPending.length} pending_entry expired)`);
      }
    } catch (e) {
      console.warn(`[UniExecutor] pair ${pairId} failed to reload open positions: ${e.message}`);
      state.openPositions = [];
    }

    this._broadcastState(pairId);
    this._refreshAccountInfo(state).catch(() => {});
    if (state._accountRefreshTimer) clearInterval(state._accountRefreshTimer);
    state._accountRefreshTimer = setInterval(() => this._refreshAccountInfo(state).catch(() => {}), 30000);

    // Record the config that was loaded so every enable/reload is auditable
    this._saveLevelHistory(pairId, {
      changedBy:    'enable',
      prevLevels:   null,
      prevTp:       null, prevSl: null, prevCap: null,
      newLevels:    state.levels,
      newTp:        state.tpSpreadDelta,
      newSl:        state.slSpreadDelta,
      newCap:       pair.maxSpreadCap ?? null,
      dollarMean:   null, dollarStd: null,
      openPositions: state.openPositions.length,
      tpSlUpdated:  true,
    });

    return { success: true, message: `Unilateral trading enabled (tradeLeg=${state.tradeLeg})`, pairId };
  }

  async disableTrading(pairId) {
    const state = this.pairs.get(pairId);
    if (!state || !state.enabled) return { success: false, message: 'Trading not enabled for this pair' };
    state.enabled = false;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }
    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      if (pos.entryOrderId) await this._cancel(state, pos.entryOrderId);
      if (pos.exitOrderId) await this._cancel(state, pos.exitOrderId);
    }
    state.openPositions = [];
    this._broadcastState(pairId);
    return { success: true, message: 'Trading disabled' };
  }

  getState(pairId) {
    const state = this.pairs.get(pairId);
    if (!state) return { pairId, enabled: false, state: 'IDLE' };
    const dailyLossHit = state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd;
    const killSwitchTriggered = !!state._killSwitchTriggered;
    return {
      pairId,
      enabled: !!state.enabled,
      enabledAt: state.enabledAt,
      state: state.openPositions.some((p) => p.status === 'open') ? 'POSITION_OPEN' : 'IDLE',
      filledQty: state.filledQty,
      unilateralMode: true,
      tpSpreadDelta: state.tpSpreadDelta,
      slSpreadDelta: state.slSpreadDelta,
      minGrossProfitUsd: minGrossProfitUsd(),
      minTpSpreadFloorUsd: minTpSpreadFloor(),
      dailyPnl: parseFloat((state.dailyPnl || 0).toFixed(4)),
      dailyLossLimitUsd: state.dailyLossLimitUsd || 0,
      dailyLossHit,
      maxDrawdownUsd: state.maxDrawdownUsd || 0,
      currentDrawdownUsd: state._currentDrawdownUsd || 0,
      peakEquity: state._peakEquity,
      currentEquity: state._currentEquity,
      drawdownPct: state.drawdownPct || 0,
      currentDrawdownPct: state._currentDrawdownPct || 0,
      killSwitchTriggered,
      maxPositions: state.pair?.maxPositions != null ? parseInt(state.pair.maxPositions) : 1,
      zEntryThreshold: state.pair?.zEntryThreshold != null ? parseFloat(state.pair.zEntryThreshold) : null,
      maxSpreadCap: state._adaptedMaxSpreadCap ?? (state.pair?.maxSpreadCap != null ? parseFloat(state.pair.maxSpreadCap) : null),
      adaptedAt: state._adaptedAt,
      adaptedLevels: state._adaptedAt ? state.levels : null,
      analytics: state._analytics ? state._analytics.getSnapshot() : null,
      zoneGridEnabled: !!state.zoneGrid,
      activeZone: state._activeZone ? {
        id: state._activeZone.id,
        side: state._activeZone.side,
        low: state._activeZone.low,
        high: state._activeZone.high,
        tp: state._activeZone.tp,
        sl: state._activeZone.sl,
        qty: state._activeZone.qty,
        maxPositions: state._activeZone.maxPositions,
      } : null,
      positions: state.openPositions.filter((p) => p.status === 'open').map((p) => ({
        gridLevel: p.gridLevel,
        fillSpread: p.fillSpread,
        bestSpread: p.bestSpread,
        profitTicks: p.profitTicks,
        stopTicks: p.stopTicks,
        holdSec: p.openedAt ? Math.round((Date.now() - p.openedAt) / 1000) : 0,
        zoneId: p.entryZoneId || null,
        zoneTp: p.zoneTp ?? null,
        zoneSl: p.zoneSl ?? null,
      })),
    };
  }

  getAccountInfo(pairId) {
    const state = this.pairs.get(pairId);
    if (!state) return null;
    return {
      balance: state._cachedBalance ?? null,
      startBalance: state._botStartBalance ?? state._startBalance ?? null,
      currency: this._settlementCurrency(state),
      positions: state._livePositions || [],
      feeLevel: state._feeLevel ?? null,
      makerRebate: state._makerRebate ?? null,
    };
  }

  getZoneStatus(pairId) {
    const state = this.pairs.get(pairId);
    if (!state || !state.zoneGrid) return null;
    const zg = state.zoneGrid;
    return {
      anchor: zg.anchor,
      range: zg.range,
      zoneCount: zg.count,
      zoneWidth: zg.zoneWidth,
      activeZoneId: state._activeZone ? state._activeZone.id : null,
      currentLevels: [...state.levels],
      currentLevelQty: [...state.levelQty],
      currentTp: state._activeZone?.tp ?? state.tpSpreadDelta,
      currentSl: state._activeZone?.sl ?? state.slSpreadDelta,
      upZones: zg.upZones.map(z => ({
        id: z.id, low: z.low, high: z.high,
        qty: z.qty, levels: z.levels, tp: z.tp, sl: z.sl,
        maxPositions: z.maxPositions,
      })),
      downZones: zg.downZones.map(z => ({
        id: z.id, low: z.low, high: z.high,
        qty: z.qty, levels: z.levels, tp: z.tp, sl: z.sl,
        maxPositions: z.maxPositions,
      })),
    };
  }

  async _refreshAccountInfo(state) {
    if (!state.clientA) return;
    try {
      const pairId = state.pairId;
      const ccy = this._settlementCurrency(state);
      const resp = await signedRequest(
        `/api/v2/private/get_account_summary?currency=${ccy}&extended=true`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const acct = resp?.result;
      if (!acct) return;
      state._cachedBalance = acct.balance;
      state._feeLevel = acct.fee_level;
      const equity = acct.equity != null ? acct.equity : acct.balance;
      state._currentEquity = equity;
      if (state._startBalance == null && acct.balance != null) {
        state._startBalance = acct.balance;
        StatArbInput.update({ sessionStartBalance: acct.balance }, { where: { id: pairId } }).catch(() => {});
        StatArbInput.update(
          { botStartBalance: acct.balance, botStartedAt: new Date() },
          { where: { id: pairId, botStartBalance: null } }
        ).catch(() => {});
        console.log(`[UniExecutor] pair ${pairId} session start balance: ${acct.balance} ${ccy}`);
      }
      if (equity != null) {
        if (state._peakEquity == null || equity > state._peakEquity) {
          state._peakEquity = equity;
        }
        if (state._peakEquity != null && state.maxDrawdownUsd > 0) {
          this._checkDrawdownKillSwitch(state, acct).catch(e =>
            console.error(`[UniExec] drawdown check error pair ${pairId}: ${e.message}`)
          );
        }
      }
      if (state.drawdownPct > 0 && acct.balance != null) {
        this._checkBalanceDrawdown(state, acct.balance).catch(e =>
          console.error(`[UniExec] balance drawdown check error pair ${pairId}: ${e.message}`)
        );
      }
      const posResp = await signedRequest(
        `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const positions = Array.isArray(posResp?.result) ? posResp.result : [];
      state._livePositions = positions.filter(p => p.size !== 0).map(p => ({
        instrument: p.instrument_name,
        direction: p.direction,
        size: p.size,
        avgPrice: p.average_price,
        unrealizedPnl: p.floating_profit_loss,
      }));
      try {
        const orderbookManager = require('./orderbookStreams');
        orderbookManager.broadcast({ type: 'account_info', pairId, ...this.getAccountInfo(pairId) });
      } catch (_) { }
    } catch (e) {
      console.warn(`[UniExecutor] _refreshAccountInfo pair ${state.pairId}: ${e.message}`);
    }
  }

  async _checkDrawdownKillSwitch(state, acct) {
    if (!state.enabled || state._killSwitchTriggered) return;
    if (state.maxDrawdownUsd <= 0 || state._peakEquity == null || state._currentEquity == null) return;

    const drawdownSettlement = state._peakEquity - state._currentEquity;
    if (drawdownSettlement <= 0) {
      state._currentDrawdownUsd = 0;
      return;
    }

    let drawdownUsd;
    if (this._isLinearUsdc(state)) {
      drawdownUsd = drawdownSettlement;
    } else {
      let btcPrice = 0;
      if (acct && acct.equity > 0 && acct.estimated_balance != null) {
        btcPrice = acct.estimated_balance / acct.equity;
      }
      if (!btcPrice || btcPrice <= 0) {
        const ob1 = state.lastOrderbooks?.leg1;
        const bid = parseFloat(ob1?.bids?.[0]?.price || 0);
        const ask = parseFloat(ob1?.asks?.[0]?.price || 0);
        btcPrice = bid && ask ? (bid + ask) / 2 : 0;
      }
      if (!btcPrice || btcPrice <= 0) return;
      drawdownUsd = drawdownSettlement * btcPrice;
    }

    state._currentDrawdownUsd = parseFloat(drawdownUsd.toFixed(2));

    if (drawdownUsd >= state.maxDrawdownUsd) {
      state._killSwitchTriggered = true;
      const ccy = this._settlementCurrency(state);
      console.error(
        `[UniExec] *** DRAWDOWN KILL SWITCH *** pair ${state.pairId} | ` +
        `drawdown=$${drawdownUsd.toFixed(2)} >= limit=$${state.maxDrawdownUsd} | ` +
        `peak=${state._peakEquity} ${ccy} → current=${state._currentEquity} ${ccy}`
      );
      await this._emergencyCloseAll(state, 'drawdown_kill_switch');
    }
  }

  async _checkBalanceDrawdown(state, currentBalance) {
    if (!state.enabled || state._killSwitchTriggered) return;
    if (state.drawdownPct <= 0) return;
    const startBalance = state._botStartBalance ?? state._startBalance;
    if (startBalance == null || startBalance <= 0 || currentBalance == null) return;

    const dropPct = ((startBalance - currentBalance) / startBalance) * 100;
    state._currentDrawdownPct = parseFloat(Math.max(0, dropPct).toFixed(4));

    if (dropPct >= state.drawdownPct) {
      state._killSwitchTriggered = true;
      const ccy = this._settlementCurrency(state);
      const threshold = parseFloat((startBalance * (1 - state.drawdownPct / 100)).toFixed(8));
      console.error(
        `[UniExec] *** BALANCE DRAWDOWN KILL SWITCH *** pair ${state.pairId} | ` +
        `balance=${currentBalance} ${ccy} dropped ${dropPct.toFixed(2)}% from start=${startBalance} ${ccy} | ` +
        `threshold=${threshold} ${ccy} (${state.drawdownPct}% drawdown limit)`
      );
      await this._emergencyCloseAll(state, 'balance_drawdown_kill_switch');
    }
  }

  async _emergencyCloseAll(state, reason) {
    const pairId = state.pairId;
    console.log(`[UniExec] Emergency close all — pair ${pairId} reason=${reason}`);

    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      if (pos.entryOrderId) await this._cancel(state, pos.entryOrderId).catch(() => {});
      if (pos.exitOrderId) await this._cancel(state, pos.exitOrderId).catch(() => {});
    }

    const openPositions = state.openPositions.filter(p => p.status === 'open' && p.entryPriceA);
    for (const pos of openPositions) {
      try {
        await this._startExit(state, pos, reason);
      } catch (e) {
        console.error(`[UniExec] Emergency exit failed pos ${pos.id}: ${e.message}`);
      }
    }

    state.enabled = false;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }

    await StatArbInput.update(
      { tradingEnabled: false, lastStopReason: reason, lastDisabledAt: new Date() },
      { where: { id: pairId } }
    ).catch(() => {});

    this._broadcastState(pairId);
    console.log(`[UniExec] pair ${pairId} DISABLED by ${reason} — all positions sent to close`);
  }

  async _startEntry(state, levelIdx, signalSpread) {
    const pair = state.pair;
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const futAsk = parseFloat(ob1?.asks?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
    if (!futAsk || !perpBid) return;

    const qty = state.levelQty[levelIdx] || pair.qty1;
    const level = state.levels[levelIdx];
    const isLegB = state.tradeLeg === 'B';

    // LegA (default): SELL futures at ask | LegB: BUY perp at bid
    const entrySide = isLegB ? 'buy' : 'sell';
    const entryPrice = isLegB ? perpBid : futAsk;
    const entryRes = await this._placeLimit(state, entrySide, qty, entryPrice);
    if (!entryRes.orderId) return;

    const tradedExchange = isLegB ? pair.exchange2 : pair.exchange1;
    const tradedSymbol = isLegB ? pair.symbol2 : pair.symbol1;
    const signalExchange = isLegB ? pair.exchange1 : pair.exchange2;
    const signalSymbol = isLegB ? pair.symbol1 : pair.symbol2;

    const trade = await Trade.create({
      pairId: state.pairId,
      side: 'entry',
      legA_exchange: tradedExchange,
      legA_symbol: tradedSymbol,
      legA_side: entrySide,
      legA_price: entryPrice,
      legA_qty: qty,
      legA_orderId: entryRes.orderId,
      legA_fillType: 'maker',
      legB_exchange: signalExchange,
      legB_symbol: signalSymbol,
      legB_side: isLegB ? 'sell' : 'buy',
      legB_price: isLegB ? futAsk : perpBid,
      legB_qty: 0,
      legB_fillType: 'signal',
      spreadAtEntry: signalSpread,
      status: 'open',
    });
    const bp = await BasisPosition.create({
      pairId: state.pairId,
      entryTradeId: trade.id,
      direction: 'long',
      gridLevel: levelIdx + 1,
      state: 'pending_entry',
      entrySpread: signalSpread,
      legA_entryPrice: entryPrice,
      legA_entryQty: qty,
      legB_entryPrice: isLegB ? futAsk : perpBid,
      legB_entryQty: 0,
      legA_entryOrderId: entryRes.orderId,
      entryTime: new Date(),
    });

    const pos = {
      id: `${Date.now()}_${Math.random()}`,
      status: 'pending_entry',
      gridLevel: levelIdx + 1,
      level,
      qty,
      entryOrderId: entryRes.orderId,
      entryTradeId: trade.id,
      basisPositionId: bp.id,
      entrySignalSpread: signalSpread,
      entryPriceA: null,
      entryPriceB: null,
      fillSpread: null,
      bestSpread: null,
      openedAt: null,
      entryCommissionUsd: null,
      profitTicks: 0,
      stopTicks: 0,
      timeExitTicks: 0,
      pollTimer: null,
      pollStart: Date.now(),
      exitOrderId: null,
      exitTradeId: null,
      entryZoneId: state._activeZone?.id || null,
      zoneTp: state._activeZone?.tp ?? null,
      zoneSl: state._activeZone?.sl ?? null,
      zoneTrailPct: state._activeZone?.trailPct ?? null,
      _peakNarrowing: null,
      _trailingActive: false,
    };
    state.openPositions.push(pos);
    state.lastEntryAt = Date.now();
    this._pollEntry(state, pos);
  }

  _pollEntry(state, pos) {
    if (pos.pollTimer) clearInterval(pos.pollTimer);
    const isLegB = state.tradeLeg === 'B';
    const REPRICE_AFTER_MS = 20000;
    pos._repriced = false;
    pos.pollTimer = setInterval(async () => {
      if (!state.enabled) {
        clearInterval(pos.pollTimer);
        return;
      }
      if (Date.now() - pos.pollStart > (state.entryTimeoutMs || ENTRY_TIMEOUT_MS)) {
        clearInterval(pos.pollTimer);
        await this._cancel(state, pos.entryOrderId);
        await Trade.update({
          status: 'cancelled',
          cancelReason: 'entry_timeout_unfilled',
        }, { where: { id: pos.entryTradeId } }).catch(() => { });
        await BasisPosition.update({ state: 'failed' }, { where: { id: pos.basisPositionId } }).catch(() => { });
        pos.status = 'closed';
        state.openPositions = state.openPositions.filter((p) => p !== pos);
        return;
      }
      const st = await this._orderStatus(state, pos.entryOrderId);
      if (st.status !== 'filled') {
        if (!pos._repriced && (Date.now() - pos.pollStart > REPRICE_AFTER_MS)) {
          pos._repriced = true;
          const ob1 = state.lastOrderbooks?.leg1;
          const ob2 = state.lastOrderbooks?.leg2;
          const newPrice = isLegB
            ? parseFloat(ob2?.bids?.[0]?.price || 0)
            : parseFloat(ob1?.asks?.[0]?.price || 0);
          if (newPrice) {
            await this._cancel(state, pos.entryOrderId).catch(() => {});
            const re = await this._placeLimit(state, isLegB ? 'buy' : 'sell', pos.qty, newPrice);
            if (re.orderId) {
              pos.entryOrderId = re.orderId;
              await Trade.update({ legA_orderId: re.orderId, legA_price: newPrice }, { where: { id: pos.entryTradeId } }).catch(() => {});
              await BasisPosition.update({ legA_entryOrderId: re.orderId }, { where: { id: pos.basisPositionId } }).catch(() => {});
            }
          }
        }
        return;
      }
      clearInterval(pos.pollTimer);

      // Reference price from the non-traded leg
      const ob1 = state.lastOrderbooks?.leg1;
      const ob2 = state.lastOrderbooks?.leg2;
      const refPrice = isLegB
        ? parseFloat(ob1?.asks?.[0]?.price || 0)   // futures ask as reference
        : parseFloat(ob2?.bids?.[0]?.price || 0);   // perp bid as reference
      if (!refPrice) return;

      pos.entryPriceA = st.filledPrice;
      pos.entryPriceB = refPrice;
      // fillSpread is always futures - perp regardless of which leg is traded
      pos.fillSpread = isLegB
        ? parseFloat((refPrice - st.filledPrice).toFixed(4))
        : parseFloat((st.filledPrice - refPrice).toFixed(4));
      pos.bestSpread = pos.fillSpread;

      const entryCommission = await this._getOrderCommissionUsd(state, pos.entryOrderId, pos.entryPriceA);
      pos.entryCommissionUsd = entryCommission;
      await Trade.update({
        status: 'filled',
        legA_price: pos.entryPriceA,
        legA_filledAt: new Date(),
        legB_price: pos.entryPriceB,
        legB_filledAt: new Date(),
        commission: entryCommission,
      }, { where: { id: pos.entryTradeId } }).catch(() => { });
      await BasisPosition.update({
        state: 'open',
        legA_entryPrice: pos.entryPriceA,
        legB_entryPrice: pos.entryPriceB,
        legA_entryOrderId: pos.entryOrderId,
      }, { where: { id: pos.basisPositionId } }).catch(() => { });
      pos.status = 'open';
      pos.openedAt = Date.now();
      state.filledQty += pos.qty;
      this._broadcastState(state.pairId);
    }, POLL_MS);
  }

  async _startExit(state, pos, reason) {
    if (pos.status !== 'open') return;

    const pair = state.pair;
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const futBid = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || pos.entryPriceB || 0);
    const isLegB = state.tradeLeg === 'B';

    if (reason === 'profit' && pos.entryPriceA) {
      const exitPrice = isLegB ? perpAsk : futBid;
      const wouldBePositive = isLegB
        ? (exitPrice > pos.entryPriceA)
        : (exitPrice < pos.entryPriceA);
      if (!wouldBePositive) {
        pos.profitTicks = 0;
        return;
      }
    }

    pos.status = 'pending_exit';

    // LegA (default): BUY futures at bid | LegB: SELL perp at ask
    const exitSide = isLegB ? 'sell' : 'buy';
    const exitPrice = isLegB ? perpAsk : futBid;
    if (!exitPrice || !futBid || !perpBid) { pos.status = 'open'; return; }

    const res = await this._placeLimit(state, exitSide, pos.qty, exitPrice);
    if (!res.orderId) { pos.status = 'open'; return; }

    const tradedExchange = isLegB ? pair.exchange2 : pair.exchange1;
    const tradedSymbol = isLegB ? pair.symbol2 : pair.symbol1;
    const signalExchange = isLegB ? pair.exchange1 : pair.exchange2;
    const signalSymbol = isLegB ? pair.symbol1 : pair.symbol2;
    const signalPrice = isLegB ? futBid : perpBid;
    const exitSpreadNow = parseFloat((futBid - perpBid).toFixed(4));

    const exitTrade = await Trade.create({
      pairId: state.pairId,
      side: 'exit',
      legA_exchange: tradedExchange,
      legA_symbol: tradedSymbol,
      legA_side: exitSide,
      legA_price: exitPrice,
      legA_qty: pos.qty,
      legA_orderId: res.orderId,
      legA_fillType: 'maker',
      legB_exchange: signalExchange,
      legB_symbol: signalSymbol,
      legB_side: isLegB ? 'buy' : 'sell',
      legB_price: signalPrice,
      legB_qty: 0,
      legB_fillType: 'signal',
      spreadAtEntry: pos.entrySignalSpread,
      spreadAtExit: exitSpreadNow,
      status: 'open',
    });
    pos.status = 'pending_exit';
    pos.exitReason = reason;
    pos.exitOrderId = res.orderId;
    pos.exitTradeId = exitTrade.id;
    pos.pollStart = Date.now();
    this._pollExit(state, pos);
  }

  _pollExit(state, pos) {
    if (pos.pollTimer) clearInterval(pos.pollTimer);
    const isLegB = state.tradeLeg === 'B';
    pos.pollTimer = setInterval(async () => {
      if (!state.enabled) {
        clearInterval(pos.pollTimer);
        return;
      }
      const st = await this._orderStatus(state, pos.exitOrderId);
      if (st.status === 'filled') { /* fall through to fill handling below */ }
      else if (Date.now() - pos.pollStart > EXIT_TIMEOUT_MS) {
        const ob1 = state.lastOrderbooks?.leg1;
        const ob2 = state.lastOrderbooks?.leg2;
        const newPrice = isLegB
          ? parseFloat(ob2?.asks?.[0]?.price || 0)
          : parseFloat(ob1?.bids?.[0]?.price || 0);

        if (pos.exitReason === 'profit' && pos.entryPriceA && newPrice > 0) {
          const wouldBePositive = isLegB
            ? (newPrice > pos.entryPriceA)
            : (newPrice < pos.entryPriceA);
          if (!wouldBePositive) {
            await this._cancel(state, pos.exitOrderId);
            clearInterval(pos.pollTimer);
            if (pos.exitTradeId) {
              await Trade.update(
                { status: 'cancelled', cancelReason: 'gross_negative_abort' },
                { where: { id: pos.exitTradeId } }
              ).catch(() => {});
            }
            pos.status = 'open';
            pos.exitOrderId = null;
            pos.exitTradeId = null;
            pos.profitTicks = 0;
            pos.stopTicks = 0;
            pos.timeExitTicks = 0;
            return;
          }
        }

        await this._cancel(state, pos.exitOrderId);
        if (newPrice > 0) {
          const exitSide = isLegB ? 'sell' : 'buy';
          const re = await this._placeLimit(state, exitSide, pos.qty, newPrice);
          if (re.orderId) {
            pos.exitOrderId = re.orderId;
            pos.pollStart = Date.now();
            await Trade.update({ legA_orderId: re.orderId, legA_price: newPrice }, { where: { id: pos.exitTradeId } }).catch(() => { });
          }
        }
        return;
      } else {
        return;
      }
      clearInterval(pos.pollTimer);

      const ob1 = state.lastOrderbooks?.leg1;
      const ob2 = state.lastOrderbooks?.leg2;
      const refPrice = isLegB
        ? parseFloat(ob1?.bids?.[0]?.price || pos.entryPriceB || 0)
        : parseFloat(ob2?.bids?.[0]?.price || pos.entryPriceB || 0);
      const exitPriceA = st.filledPrice;

      // exitSpread is always futures - perp
      const exitSpread = isLegB
        ? parseFloat((refPrice - exitPriceA).toFixed(4))
        : parseFloat((exitPriceA - refPrice).toFixed(4));

      let grossPnl;
      if (this._isLinearUsdc(state)) {
        grossPnl = isLegB
          ? parseFloat((pos.qty * (exitPriceA - pos.entryPriceA)).toFixed(6))
          : parseFloat((pos.qty * (pos.entryPriceA - exitPriceA)).toFixed(6));
      } else {
        const pnlBtc = isLegB
          ? parseFloat((pos.qty * (1 / pos.entryPriceA - 1 / exitPriceA)).toFixed(8))
          : parseFloat((pos.qty * (1 / exitPriceA - 1 / pos.entryPriceA)).toFixed(8));
        grossPnl = parseFloat((pnlBtc * exitPriceA).toFixed(6));
      }
      const exitCommission = await this._getOrderCommissionUsd(state, pos.exitOrderId, exitPriceA);
      const totalCommission = parseFloat((((pos.entryCommissionUsd || 0) + (exitCommission || 0))).toFixed(6));
      const netPnl = parseFloat((grossPnl + totalCommission).toFixed(6));

      await Trade.update({
        status: 'filled',
        legA_price: exitPriceA,
        legA_filledAt: new Date(),
        legB_price: refPrice,
        legB_filledAt: new Date(),
        spreadAtExit: exitSpread,
        legA_pnl: grossPnl,
        legB_pnl: 0,
        pnl: netPnl,
        commission: exitCommission,
      }, { where: { id: pos.exitTradeId } }).catch(() => { });

      await BasisPosition.update({
        state: 'closed',
        exitTradeId: pos.exitTradeId,
        exitSpread,
        exitReason: pos.exitReason || null,
        legA_exitPrice: exitPriceA,
        legB_exitPrice: refPrice,
        legA_exitOrderId: pos.exitOrderId,
        exitTime: new Date(),
        holdMs: pos.openedAt ? Date.now() - pos.openedAt : 0,
        spreadChange: parseFloat((exitSpread - pos.entrySignalSpread).toFixed(4)),
        legA_pnl: grossPnl,
        legB_pnl: 0,
        grossPnl,
        commission: totalCommission,
        takerFeeUsd: 0,
        netPnl,
      }, { where: { id: pos.basisPositionId } }).catch(() => { });

      // Track daily PnL for loss limit enforcement
      state.dailyPnl = parseFloat(((state.dailyPnl || 0) + netPnl).toFixed(6));
      if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd) {
        console.log(`[UniExec] DAILY LOSS LIMIT HIT pair ${state.pairId} | dailyPnl=$${state.dailyPnl.toFixed(2)} | limit=$${state.dailyLossLimitUsd}`);
      }

      pos.status = 'closed';
      state.openPositions = state.openPositions.filter((p) => p !== pos);
      this._broadcastState(state.pairId);
    }, POLL_MS);
  }

  async onSpreadUpdate(pairId, sellStats, _buyStats, ctx = {}) {
    const state = this.pairs.get(pairId);
    if (!state || !state.enabled) return;
    if (state._spreadUpdateInFlight) return;
    state._spreadUpdateInFlight = true;
    try {
    state.lastOrderbooks = { leg1: ctx.leg1, leg2: ctx.leg2 };
    const ob1 = ctx.leg1;
    const ob2 = ctx.leg2;
    const futAsk = parseFloat(ob1?.asks?.[0]?.price || 0);
    const futBid = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
    if (!futAsk || !futBid || !perpBid) return;

    const signalSpread = parseFloat((futAsk - perpBid).toFixed(4));

    // ── Zone Grid: detect active zone from reference price ───────────────────
    if (state.zoneGrid) {
      const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
      const refPrice = perpBid && perpAsk ? (perpBid + perpAsk) / 2 : perpBid;
      const zone = state.zoneGrid.getZone(refPrice);
      const prevZoneId = state._activeZone?.id || null;

      if (zone) {
        if (prevZoneId !== zone.id) {
          state._activeZone = zone;
          if (zone.levels.length > 0) {
            state.levels = [...zone.levels];
            state.levelQty = zone.levelQty
              ? [...zone.levelQty]
              : zone.qty != null
                ? zone.levels.map(() => zone.qty)
                : this._computeLevelQty(state.pair, zone.levels);
          }
          state.prevSignalSpread = null;
          console.log(
            `[ZoneGrid] pair ${state.pairId} zone → ${zone.id} ` +
            `($${zone.low.toFixed(2)}-$${zone.high.toFixed(2)}) ` +
            `ref=$${refPrice.toFixed(2)} levels=[${state.levels}] ` +
            `qty=[${state.levelQty}] tp=${zone.tp} sl=${zone.sl}`
          );
        }
      } else if (state._activeZone) {
        state.levels = [...state._baselineLevels];
        state.levelQty = [...state._baselineLevelQty];
        state._activeZone = null;
        state.prevSignalSpread = null;
        console.log(
          `[ZoneGrid] pair ${state.pairId} price ` +
          `$${refPrice.toFixed(2)} outside zone range → baseline`
        );
      }
    }

    // ── Analytics: feed tick and log periodically ────────────────────────────
    if (state._analytics) {
      state._analytics.addTick(signalSpread, (futBid + futAsk) / 2, ob1, ob2);
      const snap = state._analytics.getSnapshot();
      if (snap.hurst != null && Date.now() - state._lastAnalyticsLog > 60000) {
        state._lastAnalyticsLog = Date.now();
        console.log(
          `[Analytics] pair ${state.pairId} | hurst=${snap.hurst} ` +
          `autocorr=${snap.autocorrelation} halfLife=${snap.meanReversionHalfLife}min ` +
          `regime=${snap.regime} obi=${snap.obi} microprice=${snap.microprice}`
        );
      }
    }

    const SL_CONFIRM_TICKS = 7;
    const TP_CONFIRM_TICKS = 3;
    const MIN_HOLD_BEFORE_SL_MS = 15000;
    const STAGGER_STOP_MS = 3000;
    const minGrossUsd = minGrossProfitUsd();

    // Reset daily PnL counter at UTC midnight
    const todayStr = new Date().toISOString().slice(0, 10);
    if (state.dailyPnlResetDate !== todayStr) {
      state.dailyPnl = 0;
      state.dailyPnlResetDate = todayStr;
    }

    for (const pos of state.openPositions) {
      if (pos.status !== 'open') continue;
      const currentSpread = signalSpread;
      const now = Date.now();
      const holdMs = pos.openedAt ? (now - pos.openedAt) : 0;

      if (pos.bestSpread == null) pos.bestSpread = pos.fillSpread;
      if (currentSpread < pos.bestSpread) pos.bestSpread = currentSpread;

      const isLegB = state.tradeLeg === 'B';
      const isLinear = this._isLinearUsdc(state);
      const currentPrice = isLegB
        ? parseFloat(ob2?.asks?.[0]?.price || 0)
        : parseFloat(ob1?.bids?.[0]?.price || 0);
      const grossPositive = isLegB
        ? (currentPrice > pos.entryPriceA)
        : (currentPrice < pos.entryPriceA);

      // TP: trailing take-profit — activate when spread narrows by >= TP,
      //     then trail to keep trailPct of peak unrealized narrowing.
      const posTp = pos.zoneTp ?? state.tpSpreadDelta;
      const spreadNarrowing = pos.entrySignalSpread - currentSpread;
      if (pos._peakNarrowing == null || spreadNarrowing > pos._peakNarrowing) {
        pos._peakNarrowing = spreadNarrowing;
      }
      const trailPct = pos.zoneTrailPct ?? 0.5;
      if (!pos._trailingActive && spreadNarrowing >= posTp) {
        pos._trailingActive = true;
      }
      const estGross = grossPositive && pos.entryPriceA && currentPrice
        ? this._estimateGrossPnlUsd(isLegB, pos.qty, pos.entryPriceA, currentPrice, isLinear)
        : 0;
      const grossMeetsMin = minGrossUsd <= 0 || estGross >= minGrossUsd;
      let tpHit;
      if (pos._trailingActive && pos._peakNarrowing > 0) {
        const trailLevel = pos._peakNarrowing * trailPct;
        tpHit = spreadNarrowing <= trailLevel && grossPositive && grossMeetsMin;
      } else {
        tpHit = spreadNarrowing >= posTp && grossPositive && grossMeetsMin;
      }

      // SL: spread widened past threshold + held long enough + stagger delay between stops
      const posSl = pos.zoneSl ?? state.slSpreadDelta;
      const slHit =
        holdMs >= MIN_HOLD_BEFORE_SL_MS &&
        (currentSpread - pos.fillSpread) >= posSl &&
        (now - state.lastStopExitAt) >= STAGGER_STOP_MS;

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

      if (pos.profitTicks >= TP_CONFIRM_TICKS) {
        await this._startExit(state, pos, 'profit');
      } else if (pos.stopTicks >= SL_CONFIRM_TICKS) {
        state.lastStopExitAt = now;
        await this._startExit(state, pos, 'stop');
      }
    }

    // Entry checks
    const now = Date.now();

    if (state._killSwitchTriggered) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    if (state.zoneGrid && !state._activeZone) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    // Daily loss limit: stop opening new positions when breached
    if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    // Analytics-based entry gates (Hurst, OBI, regime)
    if (state._analytics) {
      const snap = state._analytics.getSnapshot();
      if (snap.hurst != null && snap.hurst > 0.55) {
        state.prevSignalSpread = signalSpread;
        return;
      }
      if (snap.regime === 'trending') {
        state.prevSignalSpread = signalSpread;
        return;
      }
      const isLegBForObi = state.tradeLeg === 'B';
      if (snap.obi != null) {
        if (!isLegBForObi && snap.obi > 0.4) { state.prevSignalSpread = signalSpread; return; }
        if (isLegBForObi && snap.obi < -0.4) { state.prevSignalSpread = signalSpread; return; }
      }
    }

    const z = sellStats?.zScore ?? 0;
    const zMin = state.pair.zEntryThreshold != null ? parseFloat(state.pair.zEntryThreshold) : 0;
    const globalMaxPos = state.pair.maxPositions != null ? parseInt(state.pair.maxPositions) : 1;
    const maxPos = state._activeZone?.maxPositions ?? globalMaxPos;
    if (state.prevSignalSpread == null) {
      state.prevSignalSpread = signalSpread;
      return;
    }
    if (now - state.lastEntryAt < COOLDOWN_MS) {
      state.prevSignalSpread = signalSpread;
      return;
    }
    if (z < zMin) {
      state.prevSignalSpread = signalSpread;
      return;
    }
    const zMax = state.pair.zEntryMax != null ? parseFloat(state.pair.zEntryMax) : null;
    if (zMax != null && Number.isFinite(zMax) && z > zMax) {
      state.prevSignalSpread = signalSpread;
      return;
    }
    const openCount = state._activeZone
      ? state.openPositions.filter((p) => p.status !== 'closed' && p.entryZoneId === state._activeZone.id).length
      : state.openPositions.filter((p) => p.status !== 'closed').length;
    if (openCount >= maxPos) {
      state.prevSignalSpread = signalSpread;
      return;
    }
    const cap = state._adaptedMaxSpreadCap ?? (state.pair.maxSpreadCap != null ? parseFloat(state.pair.maxSpreadCap) : Infinity);
    if (signalSpread > cap) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    if (state._entryInFlight) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    for (let i = state.levels.length - 1; i >= 0; i--) {
      const level = state.levels[i];
      const already = state.openPositions.some((p) =>
        p.status !== 'closed' && p.gridLevel === i + 1 &&
        (!state._activeZone || p.entryZoneId === state._activeZone.id)
      );
      if (already) continue;
      if (state.prevSignalSpread < level && signalSpread >= level) {
        state._entryInFlight = true;
        try {
          await this._startEntry(state, i, signalSpread);
        } finally {
          state._entryInFlight = false;
        }
        break;
      }
    }
    state.prevSignalSpread = signalSpread;
    } finally {
      state._spreadUpdateInFlight = false;
    }
  }

  // ─── Level History ──────────────────────────────────────────────────────────

  /**
   * Persist a level-change record to spread_level_history.
   * Fire-and-forget — errors are swallowed so they never interrupt trading.
   */
  _saveLevelHistory(pairId, { changedBy, prevLevels, prevTp, prevSl, prevCap,
                               newLevels, newTp, newSl, newCap,
                               dollarMean, dollarStd, openPositions, tpSlUpdated }) {
    SpreadLevelHistory.create({
      pairId,
      changedBy,
      levels:            newLevels,
      tpSpreadDelta:     newTp,
      slSpreadDelta:     newSl,
      maxSpreadCap:      newCap  ?? null,
      prevLevels:        prevLevels ?? null,
      prevTpSpreadDelta: prevTp  ?? null,
      prevSlSpreadDelta: prevSl  ?? null,
      prevMaxSpreadCap:  prevCap ?? null,
      dollarMean:        dollarMean ?? null,
      dollarStd:         dollarStd  ?? null,
      openPositions:     openPositions ?? 0,
      tpSlUpdated:       !!tpSlUpdated,
    }).catch((err) => {
      console.warn(`[LevelHistory] pair ${pairId} failed to save: ${err.message}`);
    });
  }

  // ─── Adaptive Levels ────────────────────────────────────────────────────────

  /**
   * Recompute entry levels, TP delta, SL delta, and maxSpreadCap for one pair
   * using the current rolling dollar mean and std from the spread tracker.
   *
   * Entry levels are always updated (only affects future entries, safe).
   * TP / SL are only updated when there are no open positions to avoid
   * shifting exit conditions mid-trade.
   */
  _doAdaptLevels(state, dollarMean, dollarStd) {
    const pair = state.pair;
    if (!pair) return;

    if (!Number.isFinite(dollarMean) || !Number.isFinite(dollarStd)) return;
    if (dollarStd < 0.1) return;   // too quiet — not enough signal
    if (dollarMean <= 0) return;   // spread must be positive for this strategy

    const sigmaMin = pair.adaptSigmaMin != null ? parseFloat(pair.adaptSigmaMin) : 0.5;
    const sigmaMax = pair.adaptSigmaMax != null ? parseFloat(pair.adaptSigmaMax) : 2.0;
    const tpSigma  = pair.adaptTpSigma  != null ? parseFloat(pair.adaptTpSigma)  : 0.8;
    const slSigma  = pair.adaptSlSigma  != null ? parseFloat(pair.adaptSlSigma)  : 1.5;

    // Match the level count from the user's original config, capped at 5
    const nLevels = Math.max(1, Math.min(state.levels.length || 3, 5));

    const newLevels = [];
    for (let i = 0; i < nLevels; i++) {
      const sigma = nLevels === 1
        ? sigmaMin
        : sigmaMin + (sigmaMax - sigmaMin) * (i / (nLevels - 1));
      const level = parseFloat((dollarMean + sigma * dollarStd).toFixed(4));
      if (level > 0) newLevels.push(level);
    }
    if (newLevels.length === 0) return;

    // Snapshot previous values before overwriting
    const prevLevels = [...state.levels];
    const prevTp     = state.tpSpreadDelta;
    const prevSl     = state.slSpreadDelta;
    const prevCap    = state._adaptedMaxSpreadCap ?? (pair.maxSpreadCap ?? null);

    // ── Always update entry levels (safe — only gates new entries) ────────────
    state.levels    = newLevels;
    state.levelQty  = this._computeLevelQty(pair, newLevels);

    // Adaptive spread cap = mean + (sigmaMax + 0.5) * std as an in-memory override
    state._adaptedMaxSpreadCap = parseFloat((dollarMean + (sigmaMax + 0.5) * dollarStd).toFixed(4));

    // ── Only update TP / SL when no positions are open ───────────────────────
    const openCount = state.openPositions.filter((p) => p.status !== 'closed').length;
    let tpUpdated = false;
    let slUpdated = false;
    if (openCount === 0) {
      const newTp = parseFloat((tpSigma * dollarStd).toFixed(4));
      const newSl = parseFloat((slSigma * dollarStd).toFixed(4));
      if (newTp > 0) {
        state.tpSpreadDelta = newTp;
        tpUpdated = true;
      }
      if (newSl > 0) {
        state.slSpreadDelta = this._isLinearUsdc(state) ? newSl : Math.max(newSl, 12);
        slUpdated = true;
      }
    }

    state._adaptedAt = Date.now();

    const tpStr = tpUpdated ? `tp=$${state.tpSpreadDelta.toFixed(2)}` : 'tp=unchanged(pos open)';
    const slStr = slUpdated ? `sl=$${state.slSpreadDelta.toFixed(2)}` : 'sl=unchanged(pos open)';
    console.log(
      `[AdaptLevels] pair ${state.pairId} | ` +
      `mean=$${dollarMean.toFixed(2)} std=$${dollarStd.toFixed(2)} | ` +
      `levels=[${newLevels.map((l) => l.toFixed(2)).join(', ')}] | ` +
      `${tpStr} | ${slStr} | cap=$${state._adaptedMaxSpreadCap.toFixed(2)}`
    );

    // Persist history record asynchronously (fire-and-forget)
    this._saveLevelHistory(state.pairId, {
      changedBy:    'adapt',
      prevLevels,   prevTp, prevSl, prevCap,
      newLevels,
      newTp:        state.tpSpreadDelta,
      newSl:        state.slSpreadDelta,
      newCap:       state._adaptedMaxSpreadCap,
      dollarMean,   dollarStd,
      openPositions: openCount,
      tpSlUpdated:  tpUpdated && slUpdated,
    });
  }

  /**
   * Called by the hourly scheduler — iterates all enabled pairs whose
   * adaptLevels flag is true and recomputes their levels from live spread stats.
   */
  async runAdaptCycle() {
    const orderbookManager = require('./orderbookStreams');
    let adapted = 0;
    for (const [pairId, state] of this.pairs) {
      if (!state.enabled) continue;
      if (!state.pair?.adaptLevels) continue;

      const snapshot = orderbookManager.getSpreadSnapshot(pairId);
      if (!snapshot) {
        console.log(`[AdaptLevels] pair ${pairId} skipped — no spread snapshot yet`);
        continue;
      }
      if (snapshot.n < 30) {
        console.log(`[AdaptLevels] pair ${pairId} skipped — only ${snapshot.n} ticks (need 30)`);
        continue;
      }

      this._doAdaptLevels(state, snapshot.dollarMean, snapshot.dollarStd);
      this._broadcastState(pairId);
      adapted++;
    }
    if (adapted > 0) {
      console.log(`[AdaptLevels] Cycle complete — adapted ${adapted} pair(s)`);
    }
  }

  startAdaptScheduler(intervalMs = 3_600_000) {
    this.runAdaptCycle();
    this._adaptTimer = setInterval(() => this.runAdaptCycle(), intervalMs);
    console.log(`[AdaptLevels] Scheduler started — runs every ${intervalMs / 60_000} min`);
  }

  stopAdaptScheduler() {
    if (this._adaptTimer) { clearInterval(this._adaptTimer); this._adaptTimer = null; }
  }

  // ─── Paper Trading Engine ─────────────────────────────────────────────────
  //
  // Self-contained paper trading mode that uses the Avellaneda–Stoikov model,
  // breakout detection, regime multipliers, premium skew, zone grid, and
  // trailing TP/SL.  Designed to be driven by live WebSocket spread data.
  // ────────────────────────────────────────────────────────────────────────────

  initPaperTrading(pairId, cfg = {}) {
    const pt = {
      pairId,
      enabled:        true,
      as:             new AvellanedaStoikov(cfg.as || {}),
      bo:             new BreakoutDetector(),
      analytics:      new SpreadAnalytics(cfg.analyticsWindow || 120),
      zoneGrid:       null,
      skew:           { bidWidenLambda: cfg.bidWidenLambda ?? 1.0, askTightenPhi: cfg.askTightenPhi ?? 0.6 },
      regime:         REGIME_MR,
      inventory:      0,
      positions:      [],
      closedTrades:   [],
      dailyPnl:       0,
      dailyDate:      '',
      lastEntryAt:    0,
      cooldownMs:     cfg.cooldownMs ?? 5000,
      capital:        cfg.capital ?? 3000,
      equity:         cfg.capital ?? 3000,
      peakEquity:     cfg.capital ?? 3000,
      maxDdUsd:       0,
      dailyLossLimit: cfg.dailyLossLimit ?? 320,
      entryLevels:    cfg.entryLevels || [0.06, 0.08, 0.12, 0.18],
      prevSpread:     null,
      _activeZone:    null,
      _logLines:      [],
      _logFile:       cfg.logFile || null,
      _csvFile:       cfg.csvFile || null,
      zones:          cfg.zones || [],
      tpConfirmTicks: cfg.tpConfirmTicks ?? 3,
      slConfirmTicks: cfg.slConfirmTicks ?? 7,
      minHoldMs:      cfg.minHoldMs ?? 15000,
      hurstGate:      cfg.hurstGate ?? 0.55,
      // false (default): SL when |deribitMid − entryPrice| ≥ sl (USD). true: legacy spread SL.
      stopLossOnSpread: cfg.stopLossOnSpread === true,
    };

    if (cfg.zoneGrid) {
      pt.zoneGrid = new ZoneGrid(cfg.zoneGrid);
    }

    this._paper = pt;
    this._paperLog(`Paper trading initialised | pair=${pairId} capital=$${pt.capital}`);
    return pt;
  }

  _paperLog(msg) {
    const pt = this._paper;
    if (!pt) return;
    const line = `[${new Date().toISOString()}] ${msg}`;
    pt._logLines.push(line);
    console.log(`[PaperTrade] ${msg}`);
    if (pt._logFile) {
      const fs = require('fs');
      fs.appendFileSync(pt._logFile, line + '\n');
    }
  }

  _paperCsv(row) {
    const pt = this._paper;
    if (!pt?._csvFile) return;
    const fs = require('fs');
    fs.appendFileSync(pt._csvFile, row + '\n');
  }

  onPaperSpreadUpdate(spreadData) {
    const pt = this._paper;
    if (!pt || !pt.enabled) return;

    const {
      signalSpread, midSpread, deribitMid, hyperMid,
      zScore = 0, mean = 0, std = 0, velocity = 0,
      ob1, ob2, timestamp,
    } = spreadData;

    const now = timestamp || Date.now();
    const price = deribitMid || 0;

    // Daily reset
    const dayStr = new Date(now).toISOString().slice(0, 10);
    if (dayStr !== pt.dailyDate) { pt.dailyPnl = 0; pt.dailyDate = dayStr; }

    // Feed analytics
    pt.analytics.addTick(signalSpread, price, ob1, ob2);
    pt.bo.addSpreadTick(signalSpread, now);

    // ── Zone detection ───────────────────────────────────────────────────
    let zoneCfg = null;
    if (pt.zoneGrid && price > 0) {
      const zone = pt.zoneGrid.getZone(price);
      if (zone) {
        if (!pt._activeZone || pt._activeZone.id !== zone.id) {
          pt._activeZone = zone;
          this._paperLog(`Zone → ${zone.id} ($${zone.low.toFixed(2)}-$${zone.high.toFixed(2)}) price=$${price.toFixed(2)}`);
        }
        zoneCfg = pt.zones[zone.index] || null;
      } else if (pt._activeZone) {
        pt._activeZone = null;
        this._paperLog(`Price $${price.toFixed(2)} outside zone range`);
      }
    }

    // ── Regime & breakout detection ──────────────────────────────────────
    const boResult = pt.bo.check(zScore);
    let hurst      = pt.analytics.hurst;
    const lowVol   = std < 0.02;
    if (lowVol && hurst != null && hurst > 0.55) hurst = null;
    if (hurst != null && hurst > 0.95) hurst = null;
    let prevRegime = pt.regime;

    if (hurst == null) {
      pt.regime = REGIME_MR;
    } else if (boResult.isBreakout && !lowVol) {
      pt.regime = REGIME_BO;
    } else if (lowVol || hurst < 0.45) {
      pt.regime = REGIME_MR;
    } else if (hurst > 0.55) {
      pt.regime = REGIME_TR;
    } else {
      pt.regime = pt.regime === REGIME_BO ? REGIME_TR : pt.regime;
    }

    if (pt.regime !== prevRegime) {
      this._paperLog(`Regime ${prevRegime} → ${pt.regime} | hurst=${hurst?.toFixed(4)} bo=${boResult.triggers} triggers`);
    }

    const regimeMult = SPREAD_MULT[pt.regime];

    // ── Avellaneda–Stoikov quotes ────────────────────────────────────────
    const sigma = std > 0 ? std : 0.05;
    const quotes = pt.as.quotes(mean, pt.inventory, sigma, regimeMult, pt.skew);

    // ── Exit checks ─────────────────────────────────────────────────────
    for (const pos of pt.positions) {
      if (pos.status !== 'open') continue;
      const holdMs = now - pos.openedAt;
      const narrowing = pos.entrySpread - signalSpread;
      if (pos.peakNarrowing == null || narrowing > pos.peakNarrowing) pos.peakNarrowing = narrowing;
      if (!pos.trailingActive && narrowing >= pos.tp) pos.trailingActive = true;

      let tpHit = false;
      if (pos.trailingActive && pos.peakNarrowing > 0) {
        tpHit = narrowing <= pos.peakNarrowing * pos.trailPct;
      }

      const slHit = holdMs >= pt.minHoldMs && (
        pt.stopLossOnSpread
          ? (signalSpread - pos.fillSpread) >= pos.sl
          : (Math.abs(price - pos.entryPrice) >= pos.sl)
      );

      // A-S bid exit: spread < our bid quote → buy back
      const asBidExit = signalSpread <= quotes.bidSpread && narrowing > 0;

      if (tpHit) pos._tpTicks = (pos._tpTicks || 0) + 1; else pos._tpTicks = 0;
      if (slHit) pos._slTicks = (pos._slTicks || 0) + 1; else pos._slTicks = 0;

      let exitReason = null;
      if (pos._tpTicks >= pt.tpConfirmTicks) exitReason = 'trailing_tp';
      else if (pos._slTicks >= pt.slConfirmTicks) exitReason = 'stop_loss';
      else if (asBidExit && narrowing >= pos.tp * 0.5) exitReason = 'as_bid_exit';

      if (pt.regime === REGIME_BO && pos.entrySpread) {
        if (narrowing < 0) exitReason = 'bo_inventory_reduce';
      }

      if (exitReason) {
        const pnlPerSol = pos.entrySpread - signalSpread;
        const pnlUsd = pos.qty * pnlPerSol;
        pos.status      = 'closed';
        pos.exitAt      = now;
        pos.exitSpread  = signalSpread;
        pos.exitPrice   = price;
        pos.pnlPerSol   = pnlPerSol;
        pos.pnlUsd      = pnlUsd;
        pos.exitReason  = exitReason;
        pos.holdMs      = holdMs;
        pt.inventory   -= pos.qty;
        pt.dailyPnl    += pnlUsd;
        pt.equity      += pnlUsd;
        pt.closedTrades.push(pos);
        pt.bo.addFill(pnlUsd < 0);

        const exitZone = pt.zoneGrid ? _findZoneById(pt.zoneGrid, pos.zoneId) : null;
        if (exitZone && pos.lifeId != null) {
          if (exitReason === 'stop_loss') {
            killLife(exitZone, pos.lifeId);
            this._paperLog(`LIFE KILLED | zone=${pos.zoneId} life=${pos.lifeId} (SL) gone=${isZoneGone(exitZone)}`);
          } else {
            releaseLife(exitZone, pos.lifeId);
            this._paperLog(`LIFE RELEASED | zone=${pos.zoneId} life=${pos.lifeId} (${exitReason})`);
          }
        }

        this._paperLog(
          `EXIT ${exitReason} | zone=${pos.zoneId} life=${pos.lifeId} lvl=${pos.gridLevel} ` +
          `qty=${pos.qty} entry=$${pos.entrySpread.toFixed(4)} exit=$${signalSpread.toFixed(4)} ` +
          `peak=$${(pos.peakNarrowing || 0).toFixed(4)} pnl=$${pnlUsd.toFixed(4)} ` +
          `hold=${(holdMs / 1000).toFixed(1)}s equity=$${pt.equity.toFixed(2)}`
        );
        this._paperCsv(
          `${new Date(now).toISOString()},EXIT,${pos.zoneId},${pos.gridLevel},` +
          `${pos.qty},${signalSpread.toFixed(6)},${price.toFixed(4)},` +
          `${(pos.asAsk || 0).toFixed(6)},,${pt.regime},${zScore.toFixed(4)},` +
          `${pt.inventory},${pnlUsd.toFixed(4)},${pt.equity.toFixed(2)},` +
          `${(holdMs / 1000).toFixed(1)},${(pos.peakNarrowing || 0).toFixed(6)},${exitReason}`
        );
      }
    }
    pt.positions = pt.positions.filter(p => p.status === 'open');

    // Track drawdown
    if (pt.equity > pt.peakEquity) pt.peakEquity = pt.equity;
    const dd = pt.peakEquity - pt.equity;
    if (dd > pt.maxDdUsd) pt.maxDdUsd = dd;

    // ── Entry checks ────────────────────────────────────────────────────
    if (!pt._activeZone || !zoneCfg) { pt.prevSpread = signalSpread; return; }
    if (pt.regime === REGIME_BO) { pt.prevSpread = signalSpread; return; }
    if (pt.dailyPnl <= -pt.dailyLossLimit) { pt.prevSpread = signalSpread; return; }
    if (now - pt.lastEntryAt < pt.cooldownMs) { pt.prevSpread = signalSpread; return; }

    if (hurst != null && hurst > pt.hurstGate) { pt.prevSpread = signalSpread; return; }
    const reg = pt.analytics.regime;
    if (reg === 'trending') { pt.prevSpread = signalSpread; return; }

    // A-S ask entry: only enter when spread > our ask quote
    if (signalSpread < quotes.askSpread) { pt.prevSpread = signalSpread; return; }

    if (pt.prevSpread == null) { pt.prevSpread = signalSpread; return; }

    if (isZoneGone(pt._activeZone))             { pt.prevSpread = signalSpread; return; }
    if (freeLives(pt._activeZone).length === 0) { pt.prevSpread = signalSpread; return; }

    const levels = pt.entryLevels;
    for (let i = levels.length - 1; i >= 0; i--) {
      const lvl = levels[i];
      const already = pt.positions.some(p => p.gridLevel === i + 1 && p.zoneId === pt._activeZone.id);
      if (already) continue;

      if (pt.prevSpread < lvl && signalSpread >= lvl) {
        const posId = pt.closedTrades.length + pt.positions.length + 1;
        const life = reserveLife(pt._activeZone, posId);
        if (!life) {
          this._paperLog(`ENTRY skip [no free life] zone=${pt._activeZone.id} lvl=${i+1}`);
          continue;
        }

        const pos = {
          id:             posId,
          status:         'open',
          zoneId:         pt._activeZone.id,
          zoneIdx:        pt._activeZone.index,
          lifeId:         life.id,
          gridLevel:      i + 1,
          qty:            zoneCfg.qty || 10,
          tp:             zoneCfg.tp  || 0.05,
          sl:             zoneCfg.sl  || 1.0,
          trailPct:       zoneCfg.trailPct || 0.50,
          openedAt:       now,
          entrySpread:    signalSpread,
          entryPrice:     price,
          fillSpread:     signalSpread,
          peakNarrowing:  0,
          trailingActive: false,
          _tpTicks:       0,
          _slTicks:       0,
          asAsk:          quotes.askSpread,
          regime:         pt.regime,
        };
        pt.positions.push(pos);
        pt.inventory += pos.qty;
        pt.lastEntryAt = now;
        pt.bo.addFill(false);

        this._paperLog(
          `ENTRY | zone=${pos.zoneId} life=${life.id} lvl=${pos.gridLevel} qty=${pos.qty} ` +
          `spread=$${signalSpread.toFixed(4)} price=$${price.toFixed(2)} ` +
          `asAsk=$${quotes.askSpread.toFixed(4)} regime=${pt.regime} ` +
          `inv=${pt.inventory} zScore=${zScore.toFixed(2)}`
        );
        this._paperCsv(
          `${new Date(now).toISOString()},ENTRY,${pos.zoneId},${pos.gridLevel},` +
          `${pos.qty},${signalSpread.toFixed(6)},${price.toFixed(4)},` +
          `${quotes.askSpread.toFixed(6)},,${pt.regime},${zScore.toFixed(4)},` +
          `${pt.inventory},,${pt.equity.toFixed(2)},,,`
        );
        break;
      }
    }
    pt.prevSpread = signalSpread;
  }

  getPaperState() {
    const pt = this._paper;
    if (!pt) return null;
    const openPos = pt.positions.filter(p => p.status === 'open');
    return {
      enabled:       pt.enabled,
      regime:        pt.regime,
      inventory:     pt.inventory,
      equity:        parseFloat(pt.equity.toFixed(2)),
      dailyPnl:      parseFloat(pt.dailyPnl.toFixed(4)),
      maxDrawdown:   parseFloat(pt.maxDdUsd.toFixed(2)),
      totalTrades:   pt.closedTrades.length,
      openPositions: openPos.length,
      winners:       pt.closedTrades.filter(t => t.pnlUsd > 0).length,
      losers:        pt.closedTrades.filter(t => t.pnlUsd <= 0).length,
      activeZone:    pt._activeZone?.id || null,
      positions:     openPos.map(p => ({
        zoneId: p.zoneId, level: p.gridLevel, qty: p.qty, lifeId: p.lifeId,
        entrySpread: p.entrySpread, holdSec: ((Date.now() - p.openedAt) / 1000).toFixed(0),
        peakNarrowing: (p.peakNarrowing || 0).toFixed(4),
        trailing: p.trailingActive, asAsk: p.asAsk,
      })),
      zoneLives: pt.zoneGrid ? [...pt.zoneGrid.upZones, ...pt.zoneGrid.downZones].map(z => ({
        id: z.id,
        alive: z.lives ? z.lives.filter(l => l.status === 'alive').length : 0,
        dead:  z.lives ? z.lives.filter(l => l.status === 'dead').length  : 0,
        free:  freeLives(z).length,
        gone:  isZoneGone(z),
      })) : [],
      closedTrades:      pt.closedTrades,
      totalPositions:    pt.positions.length,
      allOpenPositions:  openPos,
    };
  }

  stopPaperTrading() {
    const pt = this._paper;
    if (!pt) return null;
    pt.enabled = false;

    const totalPnl = pt.closedTrades.reduce((a, t) => a + t.pnlUsd, 0);
    const winners  = pt.closedTrades.filter(t => t.pnlUsd > 0);
    const losers   = pt.closedTrades.filter(t => t.pnlUsd <= 0);

    const summary = [
      '═'.repeat(70),
      '  PAPER TRADING SESSION SUMMARY',
      '═'.repeat(70),
      `  Duration:         ${((Date.now() - pt.closedTrades[0]?.openedAt || Date.now()) / 3600000).toFixed(1)}h`,
      `  Total trades:     ${pt.closedTrades.length}`,
      `  Winners:          ${winners.length}`,
      `  Losers:           ${losers.length}`,
      `  Win rate:         ${pt.closedTrades.length > 0 ? (winners.length / pt.closedTrades.length * 100).toFixed(1) : 0}%`,
      `  Total PnL:        $${totalPnl.toFixed(4)}`,
      `  Final equity:     $${pt.equity.toFixed(2)}`,
      `  Max drawdown:     $${pt.maxDdUsd.toFixed(2)}`,
      `  Open positions:   ${pt.positions.filter(p => p.status === 'open').length}`,
      '─'.repeat(70),
    ].join('\n');

    this._paperLog(summary);
    return { summary, trades: pt.closedTrades, logLines: pt._logLines };
  }
}

module.exports = new UnilateralExecutor();
