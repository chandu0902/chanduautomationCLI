/**
 * Paper Trading version of UnilateralExecutor.
 *
 * Mirrors the full entry/exit/TP/SL logic of unilateralExecutor.js but:
 *  - Never places real orders. Fills are simulated instantly at current bid/ask.
 *  - Taker fee is simulated (configurable, default 0.05%).
 *  - State is in-memory only; trades are logged to a JSON-lines file.
 *  - Safe to run alongside the live executor — reads the same orderbook feed.
 *
 * Usage:
 *   const exec = require('./paperTrading/paperUnilateralExecutor');
 *   await exec.enable(pairConfig);           // pairConfig = plain object (no DB)
 *   exec.onSpreadUpdate(sellStats, ctx);     // call from orderbookStreams feed
 *   const state = exec.getState();
 *   exec.disable();
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Constants (match live executor) ──────────────────────────────────────────
const COOLDOWN_MS          = 30_000;
const MIN_HOLD_BEFORE_SL_MS = 15_000;
const STAGGER_STOP_MS      = 3_000;
const TP_CONFIRM_TICKS     = 3;
const SL_CONFIRM_TICKS     = 7;

// Default simulated taker fee (as a fraction, not %). 0.0005 = 0.05 %
const DEFAULT_TAKER_FEE_RATE = 0.0005;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _coinFromSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.includes('_USDC')) return 'USDC';
  return s.split('-')[0] || 'BTC';
}

function _isLinearUsdc(sym) {
  return _coinFromSymbol(sym) === 'USDC';
}

function _parseLevels(spreadEntryLevels) {
  return String(spreadEntryLevels || '')
    .split(',')
    .map(x => parseFloat(x))
    .filter(x => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
}

function _computeLevelQty(qty1, levels, sym) {
  const totalWeight = levels.reduce((a, b) => a + b, 0) || 1;
  if ((sym || '').includes('_USDC')) {
    return levels.map(lvl => Math.max(0.1, Math.round((qty1 * lvl / totalWeight) * 10) / 10));
  }
  return levels.map(lvl => Math.max(10, Math.round((qty1 * lvl / totalWeight) / 10) * 10));
}

function _estimateGrossPnl(isLong, qty, entryPx, exitPx, isLinear) {
  if (!qty || !entryPx || !exitPx || entryPx <= 0 || exitPx <= 0) return 0;
  if (isLinear) {
    return isLong
      ? qty * (exitPx - entryPx)
      : qty * (entryPx - exitPx);
  }
  const pnlCoin = isLong
    ? qty * (1 / entryPx - 1 / exitPx)
    : qty * (1 / exitPx - 1 / entryPx);
  return pnlCoin * exitPx;
}

function _takerFeeUsd(qty, price, feeRate, isLinear) {
  if (isLinear) return qty * price * feeRate;
  // inverse: notional in coin = qty / price  → USD fee = (qty / price) * price * feeRate = qty * feeRate
  return qty * feeRate;
}

function _parseIstHourList(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const out = new Set();
  for (const tok of s.split(',')) {
    const n = parseInt(tok.trim(), 10);
    if (Number.isInteger(n) && n >= 0 && n <= 23) out.add(n);
  }
  return out.size ? out : null;
}

function _currentIstHour() {
  return new Date(Date.now() + (5 * 60 + 30) * 60 * 1000).getUTCHours();
}

// ── Log writer ────────────────────────────────────────────────────────────────

class TradeLogger {
  constructor(logDir) {
    this._dir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
    this._jsonlPath = path.join(logDir, 'paper_uni_trades.jsonl');
    this._csvPath   = path.join(logDir, 'paper_uni_trades.csv');
    this._ensureCsvHeader();
  }

  _ensureCsvHeader() {
    if (!fs.existsSync(this._csvPath)) {
      fs.writeFileSync(
        this._csvPath,
        'id,pairId,gridLevel,side,entryPrice,exitPrice,qty,entrySpread,exitSpread,' +
        'grossPnl,feesUsd,netPnl,exitReason,holdMs,openedAt,closedAt\n',
        'utf8',
      );
    }
  }

  logTrade(rec) {
    const line = JSON.stringify({ ...rec, ts: new Date().toISOString() });
    fs.appendFileSync(this._jsonlPath, line + '\n', 'utf8');

    const csv = [
      rec.id, rec.pairId, rec.gridLevel, rec.side,
      rec.entryPrice, rec.exitPrice, rec.qty,
      rec.entrySpread, rec.exitSpread,
      (rec.grossPnl || 0).toFixed(6),
      (rec.feesUsd  || 0).toFixed(6),
      (rec.netPnl   || 0).toFixed(6),
      rec.exitReason,
      rec.holdMs,
      rec.openedAt,
      rec.closedAt,
    ].join(',');
    fs.appendFileSync(this._csvPath, csv + '\n', 'utf8');
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

class PaperState {
  constructor() {
    this.enabled        = false;
    this.pairId         = null;
    this.pair           = null;          // plain config object
    this.levels         = [];
    this.levelQty       = [];
    this.tpSpreadDelta  = 20;
    this.slSpreadDelta  = 35;
    this.maxHoldMs      = null;
    this.fixedTpUsd     = null;
    this.maxSingleTradeLossUsd = null;
    this.grossNegativeScratchMs = null;
    this.minEdgeUsd     = null;
    this.trendFilterPct = null;
    this.trendFilterWindowMs = 60_000;
    this.disableIstHours = null;
    this.stopStreakN     = null;
    this.stopStreakCooldownN = null;
    this.maxPositions   = 1;
    this.zEntryThreshold = 0;
    this.zEntryMax      = null;
    this.maxSpreadCap   = Infinity;
    this.dailyLossLimitUsd = 0;
    this.takerFeeRate   = DEFAULT_TAKER_FEE_RATE;
    this.tradeLeg       = 'A';
    this.tradeSymbol    = null;
    this.isLinear       = false;

    // Runtime
    this.openPositions  = [];
    this.prevSignalSpread = null;
    this.lastEntryAt    = 0;
    this.lastStopExitAt = 0;
    this.lastOrderbooks = null;
    this.dailyPnl       = 0;
    this.dailyPnlResetDate = new Date().toISOString().slice(0, 10);
    this.totalTrades    = 0;
    this.totalPnl       = 0;
    this.totalFees      = 0;
    this._stopStreak    = 0;
    this._entryCooldownRemaining = 0;
    this._entryInFlight = false;
    this._priceHistory  = [];
    this._lastSkipReason = null;
    this._skipCounts    = { edge: 0, trend: 0, trendPause: 0, hour: 0, streakCool: 0 };
    this._trendPauseUntil = 0;
    this._spreadUpdateInFlight = false;
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

class PaperUnilateralExecutor {
  constructor(logDir) {
    this._state  = new PaperState();
    this._logger = new TradeLogger(
      logDir || path.join(__dirname, '../../../../reports/paper_uni')
    );
    this._posIdSeq = 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enable paper trading for a pair.
   * @param {object} cfg  Plain-object pair config (same fields as StatArbInput DB row).
   *                      Required: spreadEntryLevels, qty1, tpSpreadDelta, slSpreadDelta.
   *                      Optional: all other columns from StatArbInput.
   */
  enable(cfg) {
    const s = this._state;
    const levels = _parseLevels(cfg.spreadEntryLevels);
    if (levels.length === 0) throw new Error('Invalid spreadEntryLevels');

    s.pairId       = cfg.id ?? 'paper';
    s.pair         = cfg;
    s.levels       = levels;
    s.tradeLeg     = (cfg.tradeLeg || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    s.tradeSymbol  = s.tradeLeg === 'B' ? cfg.symbol2 : cfg.symbol1;
    s.isLinear     = _isLinearUsdc(s.tradeSymbol);
    s.levelQty     = _computeLevelQty(cfg.qty1, levels, s.tradeSymbol);

    const tp = parseFloat(cfg.tpSpreadDelta) || 20;
    const sl = parseFloat(cfg.slSpreadDelta) || 35;
    s.tpSpreadDelta  = tp > 0 ? tp : 20;
    s.slSpreadDelta  = sl > 0 ? sl : (s.isLinear ? 35 : Math.max(35, 12));

    s.maxHoldMs              = _pos(cfg.maxHoldMs);
    s.fixedTpUsd             = _pos(cfg.fixedTpUsd);
    s.maxSingleTradeLossUsd  = _pos(cfg.maxSingleTradeLossUsd);
    s.grossNegativeScratchMs = _pos(cfg.grossNegativeScratchMs);
    s.minEdgeUsd             = _pos(cfg.minEdgeUsd);
    s.trendFilterPct         = _pos(cfg.trendFilterPct);
    s.trendFilterWindowMs    = _pos(cfg.trendFilterWindowMs) || 60_000;
    s.disableIstHours        = _parseIstHourList(cfg.disableIstHours);
    s.stopStreakN            = _pos(cfg.stopStreakN);
    s.stopStreakCooldownN    = _pos(cfg.stopStreakCooldownN);
    s.maxPositions           = cfg.maxPositions != null ? parseInt(cfg.maxPositions) : 1;
    s.zEntryThreshold        = cfg.zEntryThreshold != null ? parseFloat(cfg.zEntryThreshold) : 0;
    s.zEntryMax              = cfg.zEntryMax != null ? parseFloat(cfg.zEntryMax) : null;
    s.maxSpreadCap           = cfg.maxSpreadCap != null ? parseFloat(cfg.maxSpreadCap) : Infinity;
    s.dailyLossLimitUsd      = _pos(cfg.dailyLossLimitUsd) || 0;
    s.takerFeeRate           = cfg.takerFeeRate != null ? parseFloat(cfg.takerFeeRate) : DEFAULT_TAKER_FEE_RATE;

    s.enabled          = true;
    s.openPositions    = [];
    s.prevSignalSpread = null;
    s.lastEntryAt      = 0;
    s.lastStopExitAt   = 0;
    s.dailyPnl         = 0;
    s.dailyPnlResetDate = new Date().toISOString().slice(0, 10);
    s._stopStreak      = 0;
    s._entryCooldownRemaining = 0;
    s._priceHistory    = [];
    s._lastSkipReason  = null;
    s._skipCounts      = { edge: 0, trend: 0, trendPause: 0, hour: 0, streakCool: 0 };
    s._trendPauseUntil = 0;

    console.log(
      `[PaperUni] enabled pairId=${s.pairId} tradeLeg=${s.tradeLeg} ` +
      `levels=[${s.levels.join(',')}] tp=${s.tpSpreadDelta} sl=${s.slSpreadDelta}`
    );
    return { success: true };
  }

  disable() {
    this._state.enabled = false;
    console.log(`[PaperUni] disabled pairId=${this._state.pairId}`);
    return { success: true };
  }

  getState() {
    const s = this._state;
    return {
      pairId:         s.pairId,
      enabled:        s.enabled,
      tradeLeg:       s.tradeLeg,
      tpSpreadDelta:  s.tpSpreadDelta,
      slSpreadDelta:  s.slSpreadDelta,
      dailyPnl:       parseFloat((s.dailyPnl || 0).toFixed(4)),
      totalTrades:    s.totalTrades,
      totalPnl:       parseFloat((s.totalPnl || 0).toFixed(4)),
      totalFees:      parseFloat((s.totalFees || 0).toFixed(6)),
      openPositions:  s.openPositions.filter(p => p.status === 'open').map(p => ({
        id:               p.id,
        gridLevel:        p.gridLevel,
        entryPrice:       p.entryPrice,
        entrySpread:      p.entrySpread,
        qty:              p.qty,
        isLong:           p.isLong,
        profitTicks:      p.profitTicks,
        stopTicks:        p.stopTicks,
        holdSec:          Math.round((Date.now() - p.openedAt) / 1000),
      })),
      lastSkipReason: s._lastSkipReason,
      skipCounts:     s._skipCounts,
    };
  }

  // ── Core spread handler (call from orderbookStreams feed) ───────────────────

  async onSpreadUpdate(sellStats, ctx = {}) {
    const s = this._state;
    if (!s.enabled) return;
    if (s._spreadUpdateInFlight) return;
    s._spreadUpdateInFlight = true;

    try {
      s.lastOrderbooks = { leg1: ctx.leg1, leg2: ctx.leg2 };
      const ob1 = ctx.leg1;
      const ob2 = ctx.leg2;
      const futAsk  = parseFloat(ob1?.asks?.[0]?.price || 0);
      const futBid  = parseFloat(ob1?.bids?.[0]?.price || 0);
      const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
      const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
      if (!futAsk || !futBid || !perpBid) return;

      const signalSpread = parseFloat((futAsk - perpBid).toFixed(4));

      // Track price history for trend filter
      if (s.trendFilterPct) {
        const tradedOb = s.tradeLeg === 'B' ? ob2 : ob1;
        const mid = (parseFloat(tradedOb?.bids?.[0]?.price || 0) + parseFloat(tradedOb?.asks?.[0]?.price || 0)) / 2;
        this._pushPriceSample(mid);
      }

      // Daily PnL reset at UTC midnight
      const todayStr = new Date().toISOString().slice(0, 10);
      if (s.dailyPnlResetDate !== todayStr) {
        s.dailyPnl = 0;
        s.dailyPnlResetDate = todayStr;
      }

      // ── Manage open positions ──────────────────────────────────────────────
      const now = Date.now();
      for (const pos of s.openPositions) {
        if (pos.status !== 'open') continue;
        const holdMs = now - pos.openedAt;

        if (pos.bestSpread == null) pos.bestSpread = pos.entrySpread;
        if (signalSpread < pos.bestSpread) pos.bestSpread = signalSpread;

        const tradedOb   = s.tradeLeg === 'B' ? ob2 : ob1;
        const currentPx  = pos.isLong
          ? parseFloat(tradedOb?.asks?.[0]?.price || 0)   // LONG maker exit rests at ASK
          : parseFloat(tradedOb?.bids?.[0]?.price || 0);  // SHORT maker exit rests at BID

        const grossPositive = pos.isLong
          ? (currentPx > pos.entryPrice)
          : (currentPx < pos.entryPrice);

        const posTp = pos.tpDelta ?? s.tpSpreadDelta;
        const posSl = pos.slDelta ?? s.slSpreadDelta;

        const spreadTp  = (pos.entrySpread - signalSpread) >= posTp;
        const estGross  = grossPositive && pos.entryPrice && currentPx
          ? _estimateGrossPnl(pos.isLong, pos.qty, pos.entryPrice, currentPx, s.isLinear)
          : 0;

        const posFixedTp = pos.fixedTpUsd ?? s.fixedTpUsd;
        const fixedTpHit = posFixedTp != null && grossPositive && estGross >= posFixedTp;
        const tpHit      = fixedTpHit || (spreadTp && grossPositive);

        const slBaseline = pos.entrySpread;
        const slHit =
          holdMs >= MIN_HOLD_BEFORE_SL_MS &&
          (signalSpread - slBaseline) >= posSl &&
          (now - s.lastStopExitAt) >= STAGGER_STOP_MS;

        // Hard per-trade loss cap
        let hardLossHit = false;
        if (s.maxSingleTradeLossUsd != null && pos.entryPrice && currentPx && !grossPositive) {
          const lossUsd = _estimateGrossPnl(pos.isLong, pos.qty, pos.entryPrice, currentPx, s.isLinear);
          if (lossUsd <= -s.maxSingleTradeLossUsd) hardLossHit = true;
        }

        if (tpHit) {
          pos.profitTicks = (pos.profitTicks || 0) + 1;
          pos.stopTicks   = 0;
        } else if (slHit) {
          pos.stopTicks   = (pos.stopTicks || 0) + 1;
          pos.profitTicks = 0;
        } else {
          pos.profitTicks = 0;
          pos.stopTicks   = 0;
        }

        // Hold-time cap
        const holdCapHit = s.maxHoldMs != null && holdMs >= s.maxHoldMs;

        if (hardLossHit) {
          s.lastStopExitAt = now;
          this._closePosition(pos, signalSpread, currentPx, ob1, ob2, 'stop');
        } else if (pos.profitTicks >= TP_CONFIRM_TICKS || fixedTpHit) {
          this._closePosition(pos, signalSpread, currentPx, ob1, ob2, 'profit');
        } else if (pos.stopTicks >= SL_CONFIRM_TICKS) {
          s.lastStopExitAt = now;
          this._closePosition(pos, signalSpread, currentPx, ob1, ob2, 'stop');
        } else if (holdCapHit) {
          this._closePosition(pos, signalSpread, currentPx, ob1, ob2, 'hold_cap');
        }
      }

      // Remove closed positions from list
      s.openPositions = s.openPositions.filter(p => p.status !== 'closed');

      // ── Entry checks ───────────────────────────────────────────────────────

      if (s.dailyLossLimitUsd > 0 && s.dailyPnl <= -s.dailyLossLimitUsd) {
        s.prevSignalSpread = signalSpread;
        return;
      }

      if (s._trendPauseUntil && now < s._trendPauseUntil) {
        s._skipCounts.trendPause++;
        s._lastSkipReason = 'trendPause';
        s.prevSignalSpread = signalSpread;
        return;
      }

      const z    = sellStats?.zScore ?? 0;
      const zMin = s.zEntryThreshold;

      if (s.prevSignalSpread == null) { s.prevSignalSpread = signalSpread; return; }
      if (now - s.lastEntryAt < COOLDOWN_MS)   { s.prevSignalSpread = signalSpread; return; }
      if (z < zMin)                            { s.prevSignalSpread = signalSpread; return; }
      if (s.zEntryMax != null && z > s.zEntryMax) { s.prevSignalSpread = signalSpread; return; }

      const openCount = s.openPositions.filter(p => p.status !== 'closed').length;
      if (openCount >= s.maxPositions)         { s.prevSignalSpread = signalSpread; return; }
      if (signalSpread > s.maxSpreadCap)       { s.prevSignalSpread = signalSpread; return; }
      if (s._entryInFlight)                    { s.prevSignalSpread = signalSpread; return; }

      for (let i = s.levels.length - 1; i >= 0; i--) {
        const level   = s.levels[i];
        const already = s.openPositions.some(p => p.status !== 'closed' && p.gridLevel === i + 1);
        if (already) continue;

        if (s.prevSignalSpread < level && signalSpread >= level) {
          // Trend filter
          if (s.trendFilterPct != null) {
            const drift = this._computePriceDriftPct();
            if (drift != null && drift > s.trendFilterPct) {
              s._skipCounts.trend++;
              s._lastSkipReason = 'trend';
              break;
            }
          }

          // Minimum-edge filter
          if (s.minEdgeUsd != null) {
            const isLegB    = s.tradeLeg === 'B';
            const tradedOb  = isLegB ? ob2 : ob1;
            const entryPx   = isLegB
              ? parseFloat(tradedOb?.bids?.[0]?.price || 0)
              : parseFloat(tradedOb?.asks?.[0]?.price || 0);
            const qty       = s.levelQty[i] || s.pair.qty1;
            const tp        = s.tpSpreadDelta;
            const exitPx    = isLegB ? entryPx + tp : entryPx - tp;
            const projGross = _estimateGrossPnl(isLegB, qty, entryPx, exitPx, s.isLinear);
            if (projGross < s.minEdgeUsd) {
              s._skipCounts.edge++;
              s._lastSkipReason = 'edge';
              break;
            }
          }

          // IST-hour gate
          if (s.disableIstHours) {
            const istHr = _currentIstHour();
            if (s.disableIstHours.has(istHr)) {
              s._skipCounts.hour++;
              s._lastSkipReason = 'hour';
              break;
            }
          }

          // Stop-streak cooldown
          if (s._entryCooldownRemaining > 0) {
            s._entryCooldownRemaining -= 1;
            s._skipCounts.streakCool++;
            s._lastSkipReason = 'streakCool';
            break;
          }

          s._lastSkipReason = null;
          s._entryInFlight  = true;
          try {
            this._openPosition(i, signalSpread, futAsk, perpBid, futBid, perpAsk, ob1, ob2);
          } finally {
            s._entryInFlight = false;
          }
          break;
        }
      }

      s.prevSignalSpread = signalSpread;
    } finally {
      s._spreadUpdateInFlight = false;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _openPosition(levelIdx, signalSpread, futAsk, perpBid, futBid, perpAsk, ob1, ob2) {
    const s       = this._state;
    const isLegB  = s.tradeLeg === 'B';
    const qty     = s.levelQty[levelIdx] || s.pair.qty1;
    const level   = s.levels[levelIdx];

    // Simulate taker fill (immediate fill at best book price)
    const entrySide  = isLegB ? 'buy' : 'sell';
    const entryPrice = isLegB ? perpBid : futAsk;  // fill at best opposing price
    const isLong     = entrySide === 'buy';

    // Simulate entry fee (taker on entry)
    const entryFeeUsd = _takerFeeUsd(qty, entryPrice, s.takerFeeRate, s.isLinear);

    const pos = {
      id:           `paper_${++this._posIdSeq}`,
      status:       'open',
      gridLevel:    levelIdx + 1,
      level,
      qty,
      isLong,
      entryPrice,
      entrySpread:  signalSpread,
      tpDelta:      s.tpSpreadDelta,
      slDelta:      s.slSpreadDelta,
      fixedTpUsd:   s.fixedTpUsd,
      openedAt:     Date.now(),
      bestSpread:   null,
      profitTicks:  0,
      stopTicks:    0,
      entryFeeUsd,
    };

    s.openPositions.push(pos);
    s.lastEntryAt = Date.now();

    console.log(
      `[PaperUni] ENTRY  id=${pos.id} L${pos.gridLevel} ${isLong ? 'LONG' : 'SHORT'} ` +
      `qty=${qty} @ ${entryPrice} spread=${signalSpread} fee=$${entryFeeUsd.toFixed(4)}`
    );
  }

  _closePosition(pos, signalSpread, currentPx, ob1, ob2, reason) {
    const s      = this._state;
    const isLegB = s.tradeLeg === 'B';

    // Simulate taker exit at best price
    const exitSide  = isLegB ? 'sell' : 'buy';
    const exitPrice = isLegB
      ? parseFloat(ob2?.asks?.[0]?.price || currentPx)
      : parseFloat(ob1?.bids?.[0]?.price || currentPx);

    const holdMs     = Date.now() - pos.openedAt;
    const grossPnl   = _estimateGrossPnl(pos.isLong, pos.qty, pos.entryPrice, exitPrice, s.isLinear);
    const exitFeeUsd = _takerFeeUsd(pos.qty, exitPrice, s.takerFeeRate, s.isLinear);
    const totalFees  = parseFloat(((pos.entryFeeUsd || 0) + exitFeeUsd).toFixed(6));
    const netPnl     = parseFloat((grossPnl - totalFees).toFixed(6));

    // Compute exit spread (futures − perp direction)
    const futBid  = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
    const exitSpread = parseFloat((futBid - perpBid).toFixed(4));

    // Update stop-streak
    if (s.stopStreakN && s.stopStreakCooldownN) {
      const isStop = reason === 'stop' || reason === 'hold_cap';
      if (isStop) {
        s._stopStreak = (s._stopStreak || 0) + 1;
        if (s._stopStreak >= s.stopStreakN) {
          s._entryCooldownRemaining = s.stopStreakCooldownN;
          s._stopStreak = 0;
          console.warn(`[PaperUni] STOP_STREAK_COOLDOWN triggered — pausing ${s.stopStreakCooldownN} entries`);
        }
      } else {
        s._stopStreak = 0;
      }
    }

    pos.status = 'closed';
    s.dailyPnl  = parseFloat(((s.dailyPnl || 0) + netPnl).toFixed(6));
    s.totalPnl  = parseFloat(((s.totalPnl || 0) + netPnl).toFixed(6));
    s.totalFees = parseFloat(((s.totalFees || 0) + totalFees).toFixed(6));
    s.totalTrades++;

    console.log(
      `[PaperUni] EXIT   id=${pos.id} L${pos.gridLevel} reason=${reason} ` +
      `qty=${pos.qty} entry=${pos.entryPrice} exit=${exitPrice} ` +
      `gross=$${grossPnl.toFixed(4)} fees=$${totalFees.toFixed(4)} net=$${netPnl.toFixed(4)} ` +
      `hold=${Math.round(holdMs / 1000)}s`
    );

    this._logger.logTrade({
      id:          pos.id,
      pairId:      s.pairId,
      gridLevel:   pos.gridLevel,
      side:        pos.isLong ? 'long' : 'short',
      entryPrice:  pos.entryPrice,
      exitPrice,
      qty:         pos.qty,
      entrySpread: pos.entrySpread,
      exitSpread,
      grossPnl:    parseFloat(grossPnl.toFixed(6)),
      feesUsd:     totalFees,
      netPnl,
      exitReason:  reason,
      holdMs,
      openedAt:    new Date(pos.openedAt).toISOString(),
      closedAt:    new Date().toISOString(),
    });
  }

  _pushPriceSample(mid) {
    const s = this._state;
    if (!Number.isFinite(mid) || mid <= 0) return;
    const now  = Date.now();
    const win  = s.trendFilterWindowMs || 60_000;
    s._priceHistory.push({ t: now, px: mid });
    const cutoff = now - 2 * win;
    while (s._priceHistory.length > 0 && s._priceHistory[0].t < cutoff) {
      s._priceHistory.shift();
    }
  }

  _computePriceDriftPct() {
    const s    = this._state;
    const hist = s._priceHistory;
    if (!hist || hist.length < 2) return null;
    const since = Date.now() - (s.trendFilterWindowMs || 60_000);
    let min = Infinity, max = -Infinity, ref = null;
    for (const h of hist) {
      if (h.t < since) continue;
      if (ref == null) ref = h.px;
      if (h.px < min) min = h.px;
      if (h.px > max) max = h.px;
    }
    if (ref == null || !Number.isFinite(min) || !Number.isFinite(max) || ref <= 0) return null;
    return ((max - min) / ref) * 100;
  }
}

// ── Convenience: positive-finite parser ──────────────────────────────────────
function _pos(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Singleton export ──────────────────────────────────────────────────────────
// Each pair gets its own instance. Callers create one per pair:
//   const { PaperUnilateralExecutor } = require('./paperTrading/paperUnilateralExecutor');
//   const exec = new PaperUnilateralExecutor(logDir);
module.exports = { PaperUnilateralExecutor };
