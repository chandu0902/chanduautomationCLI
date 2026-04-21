'use strict';

/**
 * Live Trade Runner — SOL_USDC-PERPETUAL zone-grid market maker
 *
 * Signal feeds  : Deribit WS (SOL_USDC-PERPETUAL book) +
 *                 Hyperliquid WS (SOL L2Book)
 *                 → combined only to compute signalSpread = DeribitAsk − HLBid
 *
 * Order leg     : Deribit SOL_USDC-PERPETUAL ONLY — maker-first (post_only, no spread cross,
 *                 no market fallback). Execution filters: spread buffer, edge vs 2×fee hurdle,
 *                 L2 imbalance (no sell into ask pressure; defer buy exit on bid collapse).
 *                 PnL tracked net of estimated round-trip maker fees.
 *                 Hyperliquid is NEVER traded — signal reference only.
 *
 * Storage       : MySQL via Sequelize (sol_live_trades + sol_balance_snapshots)
 *                 No CSV writes.
 *
 * Accounts (DB):
 *   Deribit  id=3  "DERIBIT-HYPE test"   — order placement + balance fetch
 *   HL       id=1  public WS only, credentials NOT loaded
 *
 * Isolation:
 *   - Own WS connections (not shared with paperTradeRunner)
 *   - Own in-memory state; no reference to unilateraltest_hft singleton
 *   - No writes to any paper_* file path
 */

const WebSocket   = require('ws');
const path        = require('path');
const fs          = require('fs');
const crypto      = require('crypto');
const axios       = require('axios');

const { Op, QueryTypes } = require('sequelize');
const { signedRequest } = require('../controllers/apicontroller');
const { AccountDetails, SolLiveTrade, SolBalanceSnapshot, SolLiveBot } = require('../models');

// ─── Constants ───────────────────────────────────────────────────────────────

const DERIBIT_SYMBOL  = 'SOL_USDC-PERPETUAL';
const HYPER_COIN      = 'SOL';
const WINDOW_LEN      = 120;
const LOG_DIR         = path.resolve(__dirname, '../../reports');

const REGIME_MR = 'MR';
const REGIME_TR = 'TR';
const REGIME_BO = 'BO';
const SPREAD_MULT = { [REGIME_MR]: 0.90, [REGIME_TR]: 1.20, [REGIME_BO]: 2.40 };

const DERIBIT_ACCT_ID       = 3;             // "DERIBIT-HYPE test"
const BALANCE_SNAP_INTERVAL = 5 * 60 * 1000; // 5 min

/** Default boot options — keep in sync with `server.js` liveTrader.start(...) */
const DEFAULT_LIVE_START_OPTS = {
  capital:        366,
  dailyLossLimit: 39,
  as: {
    gamma_short: 0.08, gamma_long: 0.14,
    beta_premium: 0.75, k: 50.0, tau: 1.5,
  },
  bidWidenLambda: 1.0,
  askTightenPhi:  0.6,
  /** USD-ish signal spread (Deribit ask − HL bid); ladder for grid entries. */
  entryLevels: [0.06, 0.08, 0.12, 0.18],
  zoneGrid: { anchorPrice: 82.37, range: 4, zoneCount: 4 },
  /**
   * 4 SOL per zone across 4 entryLevels → 1 SOL per level (Deribit step 0.1).
   * `sl` (price) is not used for live exits — stop-loss is USD-only (see `stopLossUsd`).
   * Optional per-zone override: `stopLossUsd` (default `stopLossUsd` from root opts, else $1).
   */
  zones: [
    { qty: 4, tp: 0.05, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { qty: 4, tp: 0.10, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { qty: 4, tp: 0.20, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    { qty: 4, tp: 0.40, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
  ],
  /** Max loss per open leg (USD, spread mark vs fees) → `exitReason=stop_loss`. No mid-price SL. */
  stopLossUsd: 1,
  /** Consecutive ticks the MTM must stay beyond −stopLossUsd before firing (debounce). */
  stopLossConfirmTicks: 2,
  /** Maker-first execution + filters (override in server.js liveTrader.start) */
  exec: {
    edgeFeeMult:        1.35,   // require expected edge > this × fee hurdle (lower = more entries)
    feeTakerBps:        5,      // conservative fee rate (bps of notional) for hurdle math
    spreadEntryBuffer:  0,
    /** Reserved; entry path is ladder-only (no quote-slack gate). */
    entryQuoteSlack:    0.08,
    /**
     * If true (default), enter only when prevSpread < lvl && signalSpread >= lvl (crosses level).
     * If false, also allow signalSpread >= lvl + spreadEntryBuffer without an upward cross (“parked”).
     */
    entryRequireCrossing: true,
    imbLevels:          5,      // top N levels per side for imbalance
    entryMaxAskShare:   0.62,  // skip maker SELL if askDepth/(bid+ask) above this (sell pressure)
    exitMinBidShare:    0.45,  // defer maker BUY exit if bidShare below (bid collapsing); SL ignores
    pnlFeeBpsPerLeg:    2,      // est fee deducted from PnL: 2 legs × (bps/1e4)×qty×mid
    /** When true, allow new shorts in REGIME_BO (default: off). */
    allowBoEntries:     false,
  },
};
const TICK_SIZE             = 0.01;           // SOL_USDC-PERP minimum price increment
/** From Deribit `get_instrument` — `amount` must be a multiple of this (and ≥ min_trade_amount). */
const DERIBIT_TRADE_AMOUNT_STEP = 0.1;
/** Maker-only: post_only at join-queue prices; wait then cancel-retry (no market fallback). */
const MAKER_FILL_TIMEOUT_MS = 25000;
const MAKER_MAX_ATTEMPTS    = 10;
const FLAT_MAKER_FILL_MS    = 60000;
const FLAT_MAKER_MAX_LEGS   = 25;
/** Deribit cancel: retries (signedRequest often returns error payload instead of throwing). */
const CANCEL_MAX_ATTEMPTS   = 5;
const CANCEL_RETRY_BASE_MS  = 400;
/** After maker timeout: keep cancel+poll until order is not resting (avoids stacking new limits on failed cancels). */
const CLEAR_ORDER_MAX_MS    = 120000;
const CLEAR_ORDER_POLL_MS   = 800;

/** Exit-cover buys only: one active `_deribitLimitBuy` at a time (multi-leg grid used to fire N parallel post_only at same bid). */
let _deribitExitBuySerial = Promise.resolve();

/** Floor qty to a valid Deribit order size; returns 0 if below minimum. */
function _normalizeDeribitOrderQty(qty) {
  const step = DERIBIT_TRADE_AMOUNT_STEP;
  const q = parseFloat(qty);
  if (!Number.isFinite(q) || q < step) return 0;
  return Math.floor(q / step + 1e-9) * step;
}

/**
 * Split zone total (SOL) across grid levels so each slice is a multiple of `DERIBIT_TRADE_AMOUNT_STEP`
 * and the parts sum to the largest possible ≤ zone total on that grid.
 * E.g. 1.0 SOL / 4 levels → [0.3, 0.3, 0.2, 0.2]; 4.0 SOL / 4 levels → [1,1,1,1].
 */
function _buildEntryLevelQtys(zoneTotalQty, numLevels) {
  const step = DERIBIT_TRADE_AMOUNT_STEP;
  const n = Math.max(1, parseInt(numLevels, 10) || 1);
  const total = Math.max(0, parseFloat(zoneTotalQty) || 0);
  let units = Math.floor(total / step + 1e-9);
  if (units < 1) return Array(n).fill(0);

  if (units < n) {
    const arr = Array(n).fill(0);
    arr[0] = units * step;
    return arr;
  }
  const base = Math.floor(units / n);
  let rem = units - base * n;
  const arr = [];
  for (let i = 0; i < n; i++) {
    const extra = rem > 0 ? 1 : 0;
    if (rem > 0) rem--;
    arr.push((base + extra) * step);
  }
  return arr;
}

// ─── Maker-first execution helpers ───────────────────────────────────────────

function _depthTotals(book, n) {
  let bidSum = 0;
  let askSum = 0;
  const nl = Math.max(1, Math.min(n, 20));
  for (let i = 0; i < nl; i++) {
    bidSum += parseFloat(book?.bids?.[i]?.size || 0);
    askSum += parseFloat(book?.asks?.[i]?.size || 0);
  }
  return { bidSum, askSum };
}

/** Ask-side liquidity share 0..1 (top N levels). High = more offer pressure. */
function _askLiquidityShare(book, n) {
  const { bidSum, askSum } = _depthTotals(book, n);
  const t = bidSum + askSum;
  return t > 1e-12 ? askSum / t : 0.5;
}

/** Bid-side liquidity share 0..1. Low = thin bids / “collapsing” bid book. */
function _bidLiquidityShare(book, n) {
  const { bidSum, askSum } = _depthTotals(book, n);
  const t = bidSum + askSum;
  return t > 1e-12 ? bidSum / t : 0.5;
}

/** Minimum expected gross (spread $ × SOL) required: edgeFeeMult × taker fee on notional. */
function _feeHurdleUsd(qty, mid, exec) {
  const q = parseFloat(qty);
  const m = parseFloat(mid);
  if (!Number.isFinite(q) || !Number.isFinite(m) || q <= 0 || m <= 0) return 0;
  const mult = exec.edgeFeeMult ?? 2;
  const bps = exec.feeTakerBps ?? 5;
  return mult * (bps / 10000) * q * m;
}

/** Estimated two-leg fees (USDC) subtracted from gross spread PnL for accounting. */
function _estRoundTripFeeUsd(qty, mid, exec) {
  const q = parseFloat(qty);
  const m = parseFloat(mid);
  if (!Number.isFinite(q) || !Number.isFinite(m) || q <= 0 || m <= 0) return 0;
  const bps = exec.pnlFeeBpsPerLeg ?? 2;
  return 2 * (bps / 10000) * q * m;
}

/**
 * Mark-to-market USD for one short spread leg (Deribit short grid): gross spread move × qty
 * minus estimated round-trip fees. Used only for stop_loss vs `stopLossUsd`.
 */
function _mtmShortSpreadUsd(pos, signalSpread, deribitMid, exec) {
  const narrow = (parseFloat(pos.entrySpread) || 0) - signalSpread;
  const gross = (parseFloat(pos.qty) || 0) * narrow;
  return gross - _estRoundTripFeeUsd(pos.qty, deribitMid, exec);
}

// ─── Module-level state ───────────────────────────────────────────────────────

let _running        = false;
let _stopTimer      = null;  // unused — no time-based stop for live runner
let _deribitWs      = null;
let _hyperWs        = null;
let _deribitReconn  = null;
let _hyperReconn    = null;
let _deribitBook    = null;
let _hyperBook      = null;
let _tickCount       = 0;
let _lastStatusAt    = 0;
let _lastSnapAt      = 0;
let _lastSpread      = null;
let _lastDeribitMid  = null;
let _spreadWindow    = [];
let _deribitFirstTick = false;
let _hyperFirstTick   = false;
let _LOG_FILE       = '';
// No time-based stop — live runner runs until manual stop() or risk condition.
let _SESSION_ID     = '';

let _deribitApiKey    = null;
let _deribitSecretKey = null;

/** Deribit account PK for signed requests (overridable per bot). */
let _acctId = DERIBIT_ACCT_ID;
/** Active `sol_live_bots.id` for DB rows; null = legacy session without bot row. */
let _BOT_ID = null;

let _st = null;  // session state

// ─── Embedded signal classes (identical logic to unilateraltest_hft) ─────────

class SpreadAnalytics {
  constructor(ws = 120) {
    this.windowSize = ws; this.spreads = []; this.prices = [];
    this.hurst = null; this.regime = 'unknown';
    this._lastComputeAt = 0; this._computeIntervalMs = 60000;
  }
  addTick(spread, price) {
    this.spreads.push(spread); this.prices.push(price);
    if (this.spreads.length > this.windowSize * 2) {
      this.spreads = this.spreads.slice(-this.windowSize);
      this.prices  = this.prices.slice(-this.windowSize);
    }
    const now = Date.now();
    if (now - this._lastComputeAt >= this._computeIntervalMs && this.spreads.length >= 30) {
      this._compute(); this._lastComputeAt = now;
    }
  }
  _compute() {
    const s = this.spreads.slice(-this.windowSize);
    if (s.length < 30) return;
    this.hurst = this._hurst(s);
    const mean = s.reduce((a,v)=>a+v,0)/s.length;
    const std  = Math.sqrt(s.reduce((a,v)=>a+(v-mean)**2,0)/s.length);
    this.regime = std < 0.02 ? 'mean_reverting'
                : this.hurst == null  ? 'unknown'
                : this.hurst < 0.4   ? 'mean_reverting'
                : this.hurst > 0.6   ? 'trending' : 'random_walk';
  }
  _hurst(s) {
    const n = s.length; if (n < 20) return null;
    const subs = []; for (let sz=10; sz<=Math.floor(n/2); sz=Math.floor(sz*1.5)) subs.push(sz);
    if (subs.length < 3) return null;
    const logN = [], logRS = [];
    for (const sz of subs) {
      const nb = Math.floor(n/sz); if (!nb) continue;
      let rs = 0;
      for (let b=0; b<nb; b++) {
        const bl = s.slice(b*sz,(b+1)*sz);
        const m  = bl.reduce((a,v)=>a+v,0)/bl.length;
        let cum=0; const cd = bl.map(v=>(cum+=v-m,cum));
        const R = Math.max(...cd)-Math.min(...cd);
        const S = Math.sqrt(bl.reduce((a,v)=>a+(v-m)**2,0)/bl.length);
        if (S>0) rs += R/S;
      }
      const avg = rs/nb;
      if (avg>0) { logN.push(Math.log(sz)); logRS.push(Math.log(avg)); }
    }
    if (logN.length < 3) return null;
    const np=logN.length,sx=logN.reduce((a,v)=>a+v,0),sy=logRS.reduce((a,v)=>a+v,0);
    const sxy=logN.reduce((a,v,i)=>a+v*logRS[i],0),sx2=logN.reduce((a,v)=>a+v*v,0);
    return parseFloat(Math.max(0,Math.min(1,(np*sxy-sx*sy)/(np*sx2-sx*sx))).toFixed(4));
  }
}

class AvellanedaStoikov {
  constructor(p={}) {
    this.gamma_short  = p.gamma_short  ?? 0.08;
    this.gamma_long   = p.gamma_long   ?? 0.14;
    this.k            = p.k            ?? 50.0;
    this.tau          = p.tau          ?? 1.5;
  }
  quotes(meanSpread, inv, sigma, regMult, skew) {
    const g  = inv >= 0 ? this.gamma_short : this.gamma_long;
    const rp = meanSpread - inv*g*sigma*sigma*this.tau;
    let hs   = (g*sigma*sigma*this.tau)/2 + (1/g)*Math.log(1+g/this.k);
    hs *= regMult;
    return {
      bidSpread: rp - hs*(skew?.bidWidenLambda ?? 1.0),
      askSpread: rp + hs*(skew?.askTightenPhi  ?? 0.6),
    };
  }
}

class BreakoutDetector {
  constructor() { this.fills=[]; this._sh=[]; this._th=[]; this._vw=[]; this._vl=[]; }
  addFill(adv) { this.fills.push({adverse:!!adv,t:Date.now()}); if(this.fills.length>20) this.fills=this.fills.slice(-20); }
  addSpreadTick(sp,ts) {
    this._sh.push(sp); this._th.push(ts||Date.now()); this._vw.push(sp); this._vl.push(sp);
    if(this._sh.length>200) { this._sh=this._sh.slice(-200); this._th=this._th.slice(-200); }
    if(this._vw.length>20)  this._vw=this._vw.slice(-20);
    if(this._vl.length>120) this._vl=this._vl.slice(-120);
  }
  _std(a) { if(a.length<2) return 0; const m=a.reduce((s,v)=>s+v,0)/a.length; return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/a.length); }
  volRatio() { if(this._vw.length<5||this._vl.length<30) return 1; const sl=this._std(this._vw),ll=this._std(this._vl); return ll>0?sl/ll:1; }
  velocity() {
    const h=this._sh,t=this._th; if(h.length<4) return 0;
    const ri=h.length-1,si=Math.max(0,ri-3),dt=(t[ri]-t[si])/1000;
    if(dt<=0||dt>2) return 0;
    const delta=Math.abs(h[ri]-h[si]);
    const rets=[]; for(let i=1;i<h.length;i++) rets.push(h[i]-h[i-1]);
    if(rets.length<5) return 0;
    const m=rets.reduce((a,v)=>a+v,0)/rets.length;
    const std=Math.sqrt(rets.reduce((a,v)=>a+(v-m)**2,0)/rets.length);
    return std>0?delta/std:0;
  }
  adverseFills() { return this.fills.slice(-10).filter(f=>f.adverse).length; }
  check(z) {
    if(this._sh.length<30) return {isBreakout:false,triggers:0};
    let t=0;
    if(Math.abs(z)>2.2) t++; if(this.volRatio()>1.5) t++; if(this.velocity()>2) t++; if(this.adverseFills()>=3) t++;
    return {isBreakout:t>=2,triggers:t};
  }
}

class ZoneGrid {
  constructor(cfg) {
    this.anchor = cfg.anchorPrice; this.range = cfg.range;
    this.count  = cfg.zoneCount||4; this.zoneWidth = this.range/this.count;
    const zcs = Array.isArray(cfg.zones) ? cfg.zones : [];
    this.upZones=[]; this.downZones=[];
    for (let i=0;i<this.count;i++) {
      const c=zcs[i]||{};
      this.upZones.push({ id:`up_${i}`,side:'up',index:i,
        low:this.anchor+i*this.zoneWidth, high:this.anchor+(i+1)*this.zoneWidth,
        qty:c.qty??1, tp:c.tp??0.05, sl:c.sl??1.0, trailPct:c.trailPct??0.5, maxPositions:c.maxPositions??4 });
      this.downZones.push({ id:`down_${i}`,side:'down',index:i,
        low:this.anchor-(i+1)*this.zoneWidth, high:this.anchor-i*this.zoneWidth,
        qty:c.qty??1, tp:c.tp??0.05, sl:c.sl??1.0, trailPct:c.trailPct??0.5, maxPositions:c.maxPositions??4 });
    }
  }
  getZone(price) {
    if (price >= this.anchor) {
      for (const z of this.upZones) if (price>=z.low&&price<z.high) return z;
      if (price>=this.anchor+this.range-0.0001) return this.upZones[this.upZones.length-1];
    } else {
      for (const z of this.downZones) if (price>z.low&&price<=z.high) return z;
      if (price<=this.anchor-this.range+0.0001) return this.downZones[this.downZones.length-1];
    }
    return null;
  }
}

// ─── Credential helpers ───────────────────────────────────────────────────────

function _decrypt(k64, enc, iv64) {
  const key = Buffer.from(k64,'base64'), iv = Buffer.from(iv64,'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return d.update(enc,'base64','utf8') + d.final('utf8');
}

async function _loadCredentials() {
  const acctPk = _acctId != null ? _acctId : DERIBIT_ACCT_ID;
  const row = await AccountDetails.findByPk(acctPk);
  if (!row) throw new Error(`Account id=${acctPk} not found in DB`);
  const [ak0,ak1,ak2] = row.Api_Key.split(',',3);
  const [sk0,sk1,sk2] = row.Secret_Key.split(',',3);
  _deribitApiKey    = _decrypt(ak2,ak1,ak0);
  _deribitSecretKey = _decrypt(sk2,sk1,sk0);
  _log(`Deribit credentials loaded (${row.Trade_Account})`);
}

// ─── Balance fetch ────────────────────────────────────────────────────────────

async function _fetchDeribitBalance() {
  try {
    const res = await signedRequest(
      '/api/v2/private/get_account_summary?currency=USDC&extended=true',
      _deribitApiKey, _deribitSecretKey
    );
    return res?.result || null;
  } catch (e) {
    _log(`Balance fetch error: ${e.message}`);
    return null;
  }
}

async function _saveBalanceSnapshot(snapshotType, botIdForRow = undefined) {
  try {
    const bal = await _fetchDeribitBalance();
    const now = new Date();
    const pt  = _st;
    const bid = botIdForRow !== undefined ? botIdForRow : _BOT_ID;
    await SolBalanceSnapshot.create({
      sessionId:            _SESSION_ID,
      botId:                bid,
      snapshotType,
      deribitEquity:        bal?.equity          ?? null,
      deribitBalance:       bal?.balance         ?? null,
      deribitAvailableFunds:bal?.available_funds  ?? null,
      deribitMarginBalance: bal?.margin_balance   ?? null,
      deribitUnrealisedPnl: bal?.unrealised_session_rpl ?? null,
      runnerEquity:         pt?.equity           ?? null,
      runnerDailyPnl:       pt?.dailyPnl         ?? null,
      runnerClosedTrades:   pt?.closedTrades?.length ?? null,
      runnerOpenPositions:  pt?.positions?.filter(p=>p.status==='open').length ?? null,
      runnerInventory:      pt?.inventory         ?? null,
      runnerMaxDrawdown:    pt?.maxDdUsd          ?? null,
      deribitMid:           _lastDeribitMid       ?? null,
      signalSpread:         _lastSpread           ?? null,
      regime:               pt?.regime            ?? null,
      snappedAt:            now,
    });
    _log(`Balance snapshot [${snapshotType}] | deribitEq=${bal?.equity ?? 'n/a'} runnerEq=$${pt?.equity?.toFixed(2) ?? 'n/a'}`);
  } catch (e) {
    _log(`Balance snapshot save error: ${e.message}`);
  }
}

// ─── Order helpers (Deribit only) ─────────────────────────────────────────────

function _roundPrice(raw) {
  return Math.round(parseFloat(raw) / TICK_SIZE) * TICK_SIZE;
}

/** True if cancel succeeded or order is already gone / not cancellable (same outcome for us). */
function _deribitCancelPayloadOk(res) {
  if (res == null) return false;
  if (typeof res === 'string') return false;
  if (res.result != null && !res.error) return true;
  const err = res.error;
  if (!err) return false;
  const code = err.code;
  const msg = String(err.message || '').toLowerCase();
  if (code === 10004 || msg.includes('order_not_found')) return true;
  if (msg.includes('not_open') || msg.includes('already_cancelled')) return true;
  if (msg.includes('filled') && msg.includes('cannot')) return true;
  return false;
}

/** @returns {'open'|'partially_filled'|'filled'|'cancelled'|'rejected'|null} null = unknown / API noise */
async function _deribitOrderState(orderId) {
  if (!orderId) return null;
  try {
    const res = await signedRequest(
      `/api/v2/private/get_order_state?order_id=${encodeURIComponent(orderId)}`,
      _deribitApiKey, _deribitSecretKey
    );
    if (typeof res === 'string' || res?.error) {
      const ap = _avgPxFromDeribitFills(await _deribitUserTradesByOrder(orderId));
      return ap != null ? 'filled' : null;
    }
    const o = res?.result;
    if (!o) {
      const ap = _avgPxFromDeribitFills(await _deribitUserTradesByOrder(orderId));
      return ap != null ? 'filled' : null;
    }
    const ord = Array.isArray(o) ? o[0] : o;
    return String(ord.order_state || '').toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

/**
 * After maker timeout: repeat cancel bursts until order is gone from book or deadline.
 * Prevents placing the next post_only while an uncleared order still rests (stacked GTC limits).
 * @returns {boolean} true if safe to place another order on this instrument
 */
async function _waitUntilOrderCleared(orderId) {
  if (!orderId) return true;
  const deadline = Date.now() + CLEAR_ORDER_MAX_MS;
  while (Date.now() < deadline) {
    if (!_running) {
      await _cancelDeribitOrder(orderId);
      return true;
    }
    const clearedBurst = await _cancelDeribitOrder(orderId);
    if (clearedBurst) return true;
    const st = await _deribitOrderState(orderId);
    if (st === 'filled' || st === 'cancelled' || st === 'rejected') return true;
    if (st === 'open' || st === 'partially_filled') {
      _log(`Order still resting | orderId=${orderId} state=${st} — recancel in ${CLEAR_ORDER_POLL_MS}ms`);
    } else {
      _log(`Order state unknown after cancel | orderId=${orderId} — poll again in ${CLEAR_ORDER_POLL_MS}ms`);
    }
    await new Promise((r) => setTimeout(r, CLEAR_ORDER_POLL_MS));
  }
  _log(`CRITICAL: order not cleared after ${CLEAR_ORDER_MAX_MS}ms | orderId=${orderId} — stop stacking further maker attempts`);
  return false;
}

/** @returns {Promise<boolean>} true if cancel succeeded or order already non-actionable */
async function _cancelDeribitOrder(orderId) {
  if (!orderId) return true;
  let lastErr = null;
  for (let attempt = 1; attempt <= CANCEL_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await signedRequest(
        `/api/v2/private/cancel?order_id=${encodeURIComponent(orderId)}`,
        _deribitApiKey, _deribitSecretKey
      );
      if (_deribitCancelPayloadOk(res)) {
        _log(`Order cancelled | orderId=${orderId} attempt=${attempt}`);
        return true;
      }
      lastErr =
        typeof res === 'string'
          ? res
          : String(res?.error?.message || JSON.stringify(res)).slice(0, 240);
    } catch (e) {
      lastErr = e.message || String(e);
    }
    _log(`Cancel retry (${orderId}) ${attempt}/${CANCEL_MAX_ATTEMPTS}: ${lastErr}`);
    if (attempt < CANCEL_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CANCEL_RETRY_BASE_MS * attempt));
    }
  }
  _log(`Cancel FAILED after ${CANCEL_MAX_ATTEMPTS} attempts (${orderId}): ${lastErr}`);
  return false;
}

/** Public L2 top (used when WS book unavailable, e.g. flat-close after stop). */
async function _fetchPublicOrderBook() {
  const r = await axios.get('https://www.deribit.com/api/v2/public/get_order_book', {
    params: { instrument_name: DERIBIT_SYMBOL, depth: 20 },
    timeout: 15000,
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  const d = r.data.result;
  const norm = (row) =>
    Array.isArray(row) ? { price: parseFloat(row[0]), size: parseFloat(row[1]) } : row;
  const bids = (d.bids || []).map(norm).filter((x) => x && Number.isFinite(x.price));
  const asks = (d.asks || []).map(norm).filter((x) => x && Number.isFinite(x.price));
  if (!bids.length || !asks.length) throw new Error('empty order book');
  return { bids, asks };
}

/**
 * Post-only SELL at best ask (+ optional tick bumps) — maker join ask side.
 * @param {boolean} reduceOnly — set true when flat-closing a long (safety).
 * @param {{ avoidLimitPx?: number }} [opts] — skip that exact limit (stops duplicate re-posts on retry when book unchanged).
 */
async function _postOnlySellFromBook(q, book, reduceOnly = false, opts = {}) {
  const bestAsk = _roundPrice(book.asks[0].price);
  const bestBid = _roundPrice(book.bids[0].price);
  const ro = reduceOnly ? '&reduce_only=true' : '';
  const avoid =
    opts.avoidLimitPx != null && Number.isFinite(Number(opts.avoidLimitPx))
      ? _roundPrice(opts.avoidLimitPx)
      : null;
  /** Queue priority: try same ask, then 1–3 ticks toward mid (improve price), then fallback away from mid. */
  const queueOffsets = [0, -1, -2, -3, 1, 2, 3, 4, 5];
  for (let k = 0; k < queueOffsets.length; k++) {
    const off = queueOffsets[k];
    const limitPx = _roundPrice(bestAsk + off * TICK_SIZE);
    if (avoid != null && limitPx === avoid) continue;
    if (limitPx <= bestBid) continue;
    try {
      const res = await signedRequest(
        `/api/v2/private/sell?instrument_name=${encodeURIComponent(DERIBIT_SYMBOL)}&amount=${q}&type=limit&price=${limitPx}&time_in_force=good_til_cancelled&post_only=true${ro}`,
        _deribitApiKey, _deribitSecretKey
      );
      const oid = res?.result?.order?.order_id ?? null;
      if (oid) return { oid, limitPx };
    } catch (e) {
      const msg = (e.message || '').toLowerCase();
      if (msg.includes('post_only') || msg.includes('reject') || msg.includes('invalid')) {
        _log(`SELL post_only off=${off} @ ${limitPx}: ${(e.message || '').slice(0, 160)}`);
        continue;
      }
      throw e;
    }
  }
  return { error: 'post_only_sell_reject' };
}

/**
 * Post-only BUY at best bid (− tick bumps) — maker join bid side.
 * @param {boolean} reduceOnly — use for emergency flat-close only (strategy exits stay false per config).
 * @param {{ avoidLimitPx?: number }} [opts] — skip that exact limit (duplicate re-post guard on retries).
 */
async function _postOnlyBuyFromBook(q, book, reduceOnly = false, opts = {}) {
  const bestBid = _roundPrice(book.bids[0].price);
  const bestAsk = _roundPrice(book.asks[0].price);
  const ro = reduceOnly ? '&reduce_only=true' : '';
  const avoid =
    opts.avoidLimitPx != null && Number.isFinite(Number(opts.avoidLimitPx))
      ? _roundPrice(opts.avoidLimitPx)
      : null;
  /** Queue priority: join best bid, then improve toward mid, then fallback. */
  const queueOffsets = [0, 1, 2, 3, -1, -2, -3, -4, -5];
  for (let k = 0; k < queueOffsets.length; k++) {
    const off = queueOffsets[k];
    const limitPx = _roundPrice(bestBid + off * TICK_SIZE);
    if (avoid != null && limitPx === avoid) continue;
    if (limitPx <= 0 || limitPx >= bestAsk) continue;
    try {
      const res = await signedRequest(
        `/api/v2/private/buy?instrument_name=${encodeURIComponent(DERIBIT_SYMBOL)}&amount=${q}&type=limit&price=${limitPx}&time_in_force=good_til_cancelled&post_only=true${ro}`,
        _deribitApiKey, _deribitSecretKey
      );
      const oid = res?.result?.order?.order_id ?? null;
      if (oid) return { oid, limitPx };
    } catch (e) {
      const msg = (e.message || '').toLowerCase();
      if (msg.includes('post_only') || msg.includes('reject') || msg.includes('invalid')) {
        _log(`BUY  post_only off=${off} @ ${limitPx}: ${(e.message || '').slice(0, 160)}`);
        continue;
      }
      throw e;
    }
  }
  return { error: 'post_only_buy_reject' };
}

// Maker-only limit SELL (entry: short) — best ask, post_only, no market fallback.
async function _deribitLimitSell(qty) {
  const q = _normalizeDeribitOrderQty(qty);
  if (q < DERIBIT_TRADE_AMOUNT_STEP) {
    _log(`DERIBIT SELL skipped: qty=${qty} → invalid/min below ${DERIBIT_TRADE_AMOUNT_STEP} SOL step`);
    return null;
  }
  let activeOid = null;
  /** Last resting limit we used (cancelled or timed out); avoid re-posting same px if book unchanged. */
  let lastPlacedLimitPx = null;
  for (let attempt = 1; attempt <= MAKER_MAX_ATTEMPTS; attempt++) {
    if (!_running) {
      if (activeOid) await _waitUntilOrderCleared(activeOid);
      _log(`DERIBIT SELL aborted: runner stopped (attempt ${attempt})`);
      return null;
    }
    if (!_deribitBook?.asks?.[0]?.price || !_deribitBook?.bids?.[0]?.price) {
      _log(`SELL maker: no WS book (attempt ${attempt}) — waiting 1s`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const r = await _postOnlySellFromBook(q, _deribitBook, false, { avoidLimitPx: lastPlacedLimitPx });
    if (r.error) {
      _log(`SELL maker place failed attempt ${attempt}: ${r.error}`);
      await new Promise((x) => setTimeout(x, 800));
      continue;
    }
    activeOid = r.oid;
    lastPlacedLimitPx = r.limitPx;
    _log(`DERIBIT SELL post_only ${q} SOL @ ${r.limitPx} | orderId=${r.oid} attempt=${attempt}`);
    const fill = await _waitForOrderFill(r.oid, MAKER_FILL_TIMEOUT_MS);
    if (fill.state === 'filled') {
      activeOid = null;
      const avgPx = parseFloat(fill.avgPrice);
      _log(`DERIBIT SELL filled (maker) @ ${fill.avgPrice} | orderId=${r.oid}`);
      return { orderId: r.oid, avgPrice: Number.isFinite(avgPx) ? avgPx : r.limitPx };
    }
    if (fill.state === 'stopped') {
      _log(`DERIBIT SELL wait ended: runner stopped | orderId=${r.oid}`);
      await _waitUntilOrderCleared(r.oid);
      activeOid = null;
      return null;
    }
    const cleared = await _waitUntilOrderCleared(r.oid);
    if (!cleared) {
      activeOid = null;
      _log(`DERIBIT SELL aborted: could not clear resting order ${r.oid} (avoid stacking GTC limits)`);
      return null;
    }
    activeOid = null;
    _log(`SELL maker not filled (${fill.state}) attempt ${attempt}/${MAKER_MAX_ATTEMPTS} — retry (skip same limit=${lastPlacedLimitPx})`);
  }
  _log(`DERIBIT SELL maker-only FAILED after ${MAKER_MAX_ATTEMPTS} attempts — no market fallback`);
  return null;
}

// Maker-only limit BUY (exit: cover short) — best bid, post_only, no market fallback.
async function _deribitLimitBuyImpl(qty) {
  const q = _normalizeDeribitOrderQty(qty);
  if (q < DERIBIT_TRADE_AMOUNT_STEP) {
    _log(`DERIBIT BUY  skipped: qty=${qty} → invalid/min below ${DERIBIT_TRADE_AMOUNT_STEP} SOL step`);
    return null;
  }
  let activeOid = null;
  let lastPlacedLimitPx = null;
  for (let attempt = 1; attempt <= MAKER_MAX_ATTEMPTS; attempt++) {
    if (!_running) {
      if (activeOid) await _waitUntilOrderCleared(activeOid);
      _log(`DERIBIT BUY  aborted: runner stopped (attempt ${attempt})`);
      return null;
    }
    if (!_deribitBook?.bids?.[0]?.price || !_deribitBook?.asks?.[0]?.price) {
      _log(`BUY  maker: no WS book (attempt ${attempt}) — waiting 1s`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const r = await _postOnlyBuyFromBook(q, _deribitBook, false, { avoidLimitPx: lastPlacedLimitPx });
    if (r.error) {
      _log(`BUY  maker place failed attempt ${attempt}: ${r.error}`);
      await new Promise((x) => setTimeout(x, 800));
      continue;
    }
    activeOid = r.oid;
    lastPlacedLimitPx = r.limitPx;
    _log(`DERIBIT BUY  post_only ${q} SOL @ ${r.limitPx} | orderId=${r.oid} attempt=${attempt}`);
    const fill = await _waitForOrderFill(r.oid, MAKER_FILL_TIMEOUT_MS);
    if (fill.state === 'filled') {
      activeOid = null;
      const avgPx = parseFloat(fill.avgPrice);
      _log(`DERIBIT BUY  filled (maker) @ ${fill.avgPrice} | orderId=${r.oid}`);
      return { orderId: r.oid, avgPrice: Number.isFinite(avgPx) ? avgPx : r.limitPx };
    }
    if (fill.state === 'stopped') {
      _log(`DERIBIT BUY  wait ended: runner stopped | orderId=${r.oid}`);
      await _waitUntilOrderCleared(r.oid);
      activeOid = null;
      return null;
    }
    const cleared = await _waitUntilOrderCleared(r.oid);
    if (!cleared) {
      activeOid = null;
      _log(`DERIBIT BUY  aborted: could not clear resting order ${r.oid} (avoid stacking GTC limits)`);
      return null;
    }
    activeOid = null;
    _log(`BUY  maker not filled (${fill.state}) attempt ${attempt}/${MAKER_MAX_ATTEMPTS} — retry (skip same limit=${lastPlacedLimitPx})`);
  }
  _log(`DERIBIT BUY  maker-only FAILED after ${MAKER_MAX_ATTEMPTS} attempts — no market fallback`);
  return null;
}

/** Queued wrapper: never run two exit buys concurrently (prevents N duplicate limits at same bid). */
async function _deribitLimitBuy(qty) {
  const p = _deribitExitBuySerial.then(() => _deribitLimitBuyImpl(qty));
  _deribitExitBuySerial = p.then(
    () => undefined,
    () => undefined
  );
  return p;
}

// ─── DB write helpers ─────────────────────────────────────────────────────────

async function _saveEntry(pos, spread, deribitMid, hlMid, quotes, zScore, regime, meta = {}) {
  const rowSession = meta.sessionId !== undefined ? meta.sessionId : _SESSION_ID;
  const rowBot     = meta.botId !== undefined ? meta.botId : _BOT_ID;
  try {
    const row = await SolLiveTrade.create({
      sessionId:    rowSession,
      botId:        rowBot,
      type:         'ENTRY',
      entryRowId:   null,
      zoneId:       pos.zoneId,
      zoneIndex:    pos.zoneIdx,
      gridLevel:    pos.gridLevel,
      qty:          pos.qty,
      signalSpread: spread,
      deribitMid,
      hlMid,
      asAskSpread:  quotes.askSpread,
      zScore,
      regime,
      inventoryAfter: pos.inventoryAfter,
      equityAfter:    pos.equityAfter,
      pnlUsd:       null,
      holdSec:      null,
      peakNarrow:   null,
      exitReason:   null,
      deribitOrderId: pos.dEntryOid != null ? String(pos.dEntryOid) : null,
      legFillPrice:   pos.entryLegFill != null ? pos.entryLegFill : null,
      eventAt:      new Date(pos.openedAt),
    });
    pos.dbId = row.id;
    _log(`DB ENTRY saved id=${row.id} zone=${pos.zoneId} lvl=${pos.gridLevel}`);
  } catch (e) {
    _log(`DB ENTRY save error: ${e.message}`);
  }
}

async function _saveExit(pos, spread, deribitMid, hlMid, zScore, regime, deribitOrderId, meta = {}) {
  const rowSession = meta.sessionId !== undefined ? meta.sessionId : _SESSION_ID;
  const rowBot     = meta.botId !== undefined ? meta.botId : _BOT_ID;

  if (!pos?.dbId && pos?.dEntryOid && rowBot != null) {
    try {
      const entry = await SolLiveTrade.findOne({
        where: { type: 'ENTRY', botId: rowBot, deribitOrderId: String(pos.dEntryOid) },
        order: [['id', 'DESC']],
        attributes: ['id'],
      });
      if (entry) {
        pos.dbId = entry.id;
        _log(`DB EXIT linked entryRowId=${pos.dbId} from ENTRY.deribitOrderId=${pos.dEntryOid}`);
      }
    } catch (e) {
      _log(`DB EXIT lookup entry by order failed: ${e.message}`);
    }
  }
  if (!pos?.dbId) {
    _log('DB EXIT save skipped: missing pos.dbId (ENTRY row missing — check DB ENTRY save errors)');
    return;
  }
  try {
    const existing = await SolLiveTrade.findOne({
      where: { type: 'EXIT', entryRowId: pos.dbId },
      attributes: ['id'],
    });
    if (existing) {
      _log(`DB EXIT save skipped: duplicate (EXIT id=${existing.id} already for entryRowId=${pos.dbId})`);
      return;
    }
    const row = await SolLiveTrade.create({
      sessionId:    rowSession,
      botId:        rowBot,
      type:         'EXIT',
      entryRowId:   pos.dbId || null,
      zoneId:       pos.zoneId,
      zoneIndex:    pos.zoneIdx,
      gridLevel:    pos.gridLevel,
      qty:          pos.qty,
      signalSpread: spread,
      deribitMid,
      hlMid,
      asAskSpread:  null,
      zScore,
      regime,
      inventoryAfter: pos.inventoryAfterExit,
      equityAfter:    pos.equityAfterExit,
      pnlUsd:       pos.pnlUsd,
      holdSec:      pos.holdMs != null ? pos.holdMs/1000 : null,
      peakNarrow:   pos.peakNarrowing ?? null,
      exitReason:   pos.exitReason,
      deribitOrderId,
      legFillPrice: pos.exitLegFill != null ? pos.exitLegFill : null,
      eventAt:      new Date(pos.exitAt),
    });
    _log(`DB EXIT  saved id=${row.id} zone=${pos.zoneId} pnl=$${pos.pnlUsd?.toFixed(4)}`);
    // Save balance snapshot after every closed trade
    await _saveBalanceSnapshot('post_exit');
  } catch (e) {
    _log(`DB EXIT  save error: ${e.message}`);
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function _log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(`[LiveTrade] ${msg}`);
  if (_LOG_FILE) fs.appendFileSync(_LOG_FILE, line + '\n');
}

// ─── Rolling spread stats ─────────────────────────────────────────────────────

function _spreadStats(spread) {
  _spreadWindow.push(spread);
  if (_spreadWindow.length > WINDOW_LEN * 2) _spreadWindow.splice(0, _spreadWindow.length - WINDOW_LEN);
  const s    = _spreadWindow.slice(-WINDOW_LEN);
  const mean = s.reduce((a,v)=>a+v,0)/s.length;
  const std  = Math.sqrt(s.reduce((a,v)=>a+(v-mean)**2,0)/s.length) || 0.001;
  return { mean, std, zScore: (spread-mean)/std };
}

// ─── Core tick processor ──────────────────────────────────────────────────────

async function _onBookUpdate() {
  if (!_deribitBook || !_hyperBook) return;

  const futAsk  = parseFloat(_deribitBook.asks?.[0]?.price || 0);
  const futBid  = parseFloat(_deribitBook.bids?.[0]?.price || 0);
  const perpBid = parseFloat(_hyperBook.bids?.[0]?.price   || 0);
  const perpAsk = parseFloat(_hyperBook.asks?.[0]?.price   || 0);
  if (!futAsk || !futBid || !perpBid || !perpAsk) return;

  const signalSpread = futAsk  - perpBid;
  const midSpread    = (futBid+futAsk)/2 - (perpBid+perpAsk)/2;
  const deribitMid   = (futBid+futAsk)/2;
  const hlMid        = (perpBid+perpAsk)/2;
  const stats        = _spreadStats(midSpread);
  _tickCount++;
  _lastSpread     = signalSpread;
  _lastDeribitMid = deribitMid;

  const pt  = _st;
  if (!pt) return;
  if (!_running) {
    pt.prevSpread = signalSpread;
    return;
  }
  const now = Date.now();
  delete pt._entryGateReason;

  // daily reset
  const dayStr = new Date(now).toISOString().slice(0,10);
  if (dayStr !== pt.dailyDate) { pt.dailyPnl=0; pt.dailyDate=dayStr; }

  pt.analytics.addTick(signalSpread, deribitMid);
  pt.bo.addSpreadTick(signalSpread, now);

  // zone detection
  let zoneCfg = null;
  if (deribitMid > 0) {
    const zone = pt.zoneGrid.getZone(deribitMid);
    if (zone) {
      if (!pt.activeZone || pt.activeZone.id !== zone.id) {
        pt.activeZone = zone;
        const numLvls = pt.entryLevels.length || 1;
        pt.entryLevelQtys = _buildEntryLevelQtys(zone.qty || 1, numLvls);
        _log(`Zone → ${zone.id} ($${zone.low.toFixed(2)}-$${zone.high.toFixed(2)}) price=$${deribitMid.toFixed(2)} ` +
             `qty/level=[${pt.entryLevelQtys.join(',')}] (Deribit step=${DERIBIT_TRADE_AMOUNT_STEP} SOL)`);
      }
      zoneCfg = zone;
    } else if (pt.activeZone) {
      pt.activeZone = null;
      pt.entryLevelQtys = null;
      _log(`Price $${deribitMid.toFixed(2)} outside zone range`);
    }
  }

  // regime
  const boR = pt.bo.check(stats.zScore);
  let hurst = pt.analytics.hurst;
  const lowVol = stats.std < 0.02;
  if (lowVol && hurst != null && hurst > 0.55) hurst = null;
  if (hurst != null && hurst > 0.95) hurst = null;
  const prevReg = pt.regime;
  if      (hurst == null)                 pt.regime = REGIME_MR;
  else if (boR.isBreakout && !lowVol)     pt.regime = REGIME_BO;
  else if (lowVol || hurst < 0.45)        pt.regime = REGIME_MR;
  else if (hurst > 0.55)                  pt.regime = REGIME_TR;
  else pt.regime = pt.regime===REGIME_BO ? REGIME_TR : pt.regime;
  if (pt.regime !== prevReg) _log(`Regime ${prevReg}→${pt.regime} hurst=${hurst?.toFixed(4)} bo=${boR.triggers}`);

  const regMult = SPREAD_MULT[pt.regime];
  const sigma   = stats.std > 0 ? stats.std : 0.05;
  const quotes  = pt.as.quotes(stats.mean, pt.inventory, sigma, regMult, pt.skew);

  // ── EXIT checks ──────────────────────────────────────────────────────────
  for (const pos of pt.positions) {
    if (pos.status !== 'open' || pos._orderPending) continue;
    const holdMs    = now - pos.openedAt;
    const narrowing = pos.entrySpread - signalSpread;
    if (pos.peakNarrowing == null || narrowing > pos.peakNarrowing) pos.peakNarrowing = narrowing;
    if (!pos.trailingActive && narrowing >= pos.tp) pos.trailingActive = true;

    const tpHit = pos.trailingActive && pos.peakNarrowing > 0
               && narrowing <= pos.peakNarrowing * pos.trailPct;

    const slUsdLimit =
      pos.stopLossUsd != null && Number.isFinite(parseFloat(pos.stopLossUsd))
        ? parseFloat(pos.stopLossUsd)
        : parseFloat(pt.stopLossUsd);
    const slUsdCap = Number.isFinite(slUsdLimit) && slUsdLimit > 0 ? slUsdLimit : 1;
    const mtmUsd = _mtmShortSpreadUsd(pos, signalSpread, deribitMid, pt.exec);
    const slUsdHit = mtmUsd <= -slUsdCap;

    if (tpHit) pos._tpTicks=(pos._tpTicks||0)+1; else pos._tpTicks=0;
    if (slUsdHit) pos._slTicks=(pos._slTicks||0)+1; else pos._slTicks=0;

    const slUsdConfirmN =
      pt.stopLossConfirmTicks != null && Number.isFinite(pt.stopLossConfirmTicks)
        ? Math.max(1, parseInt(pt.stopLossConfirmTicks, 10) || 2)
        : 2;

    // Loss exits: only `stop_loss` (zone `stopLossUsd` or root `stopLossUsd` on the position at entry).
    // Profit exits: only `trailing_tp` (no as_bid_exit — A-S bid-spread heuristic removed for SOL live).
    let exitReason = null;
    if      (pos._tpTicks >= pt.tpConfirmTicks) exitReason = 'trailing_tp';
    else if (pos._slTicks >= slUsdConfirmN) exitReason = 'stop_loss';

    if (exitReason && !pos._orderPending) {
      if (exitReason !== 'stop_loss') {
        const bidShare = _bidLiquidityShare(_deribitBook, pt.exec.imbLevels);
        if (bidShare < pt.exec.exitMinBidShare) {
          _log(`EXIT defer [imbalance] bidShare=${bidShare.toFixed(3)} < ${pt.exec.exitMinBidShare} (weak bids) reason=${exitReason}`);
          continue;
        }
        const narrowUsd = pos.qty * narrowing;
        const xh = _feeHurdleUsd(pos.qty, deribitMid, pt.exec);
        if (narrowUsd <= xh) {
          _log(`EXIT defer [edge≤${pt.exec.edgeFeeMult}×fees] narrowUsd=$${narrowUsd.toFixed(4)} hurdle=$${xh.toFixed(4)} reason=${exitReason}`);
          continue;
        }
      }

      pos._orderPending = true;
      pos.status = 'exiting'; // prevents duplicate exit triggers on subsequent ticks
      const snapSpread  = signalSpread;
      const snapMid     = deribitMid;
      const snapHlMid   = hlMid;
      const snapZScore  = stats.zScore;
      const snapRegime  = pt.regime;
      const snapHoldMs  = holdMs;
      const exitRowMeta = { botId: _BOT_ID, sessionId: _SESSION_ID };

      _log(
        `EXIT ${exitReason} | zone=${pos.zoneId} lvl=${pos.gridLevel} qty=${pos.qty} ` +
          `spr entry=$${pos.entrySpread.toFixed(4)} exit=$${snapSpread.toFixed(4)}` +
          (exitReason === 'stop_loss'
            ? ` mtm≈$${_mtmShortSpreadUsd(pos, snapSpread, snapMid, pt.exec).toFixed(4)} limit=$${slUsdCap.toFixed(2)}`
            : '') +
          ' — placing BUY cover'
      );

      // BUY back limit — async so retry loop does NOT block tick processing
      _deribitLimitBuy(pos.qty).then(async (buyRes) => {
        if (pos._exitClosedApplied) {
          _log(`EXIT duplicate buy callback ignored zone=${pos.zoneId} lvl=${pos.gridLevel} dbId=${pos.dbId}`);
          return;
        }
        if (!buyRes || !buyRes.orderId) {
          pos._orderPending = false;
          pos.status = 'open';
          _log(`EXIT maker did not fill — position reverted to open zone=${pos.zoneId} lvl=${pos.gridLevel}`);
          return;
        }
        pos._exitClosedApplied = true;

        const exitLeg =
          buyRes.avgPrice != null && Number.isFinite(buyRes.avgPrice) ? buyRes.avgPrice : snapMid;
        pos.exitLegFill = exitLeg;
        const entryLeg = pos.entryLegFill;
        const grossPerp =
          entryLeg != null && Number.isFinite(entryLeg) && Number.isFinite(exitLeg)
            ? pos.qty * (entryLeg - exitLeg)
            : pos.qty * (pos.entrySpread - snapSpread);
        const estFees = _estRoundTripFeeUsd(pos.qty, snapMid, pt.exec);
        const pnlUsd = grossPerp - estFees;

        pos.status           = 'closed';
        pos.exitAt           = now;
        pos.exitSpread       = snapSpread;
        pos.exitPrice        = snapMid;
        pos.pnlUsd           = pnlUsd;
        pos.exitReason       = exitReason;
        pos.holdMs           = snapHoldMs;
        pos._orderPending    = false;

        pt.inventory        -= pos.qty;
        pt.dailyPnl         += pnlUsd;
        pt.equity           += pnlUsd;
        pos.inventoryAfterExit = pt.inventory;
        pos.equityAfterExit    = pt.equity;

        pt.closedTrades.push(pos);
        pt.bo.addFill(pnlUsd < 0);

        _log(
          `EXIT DONE | equity=$${pt.equity.toFixed(2)} dailyPnl=$${pt.dailyPnl.toFixed(4)} ` +
            `sell@${entryLeg != null ? entryLeg.toFixed(4) : 'n/a'} buy@${exitLeg.toFixed(4)} ` +
            `grossPerp≈$${grossPerp.toFixed(4)} fees≈$${estFees.toFixed(4)}`
        );
        try {
          await _saveExit(pos, snapSpread, snapMid, snapHlMid, snapZScore, snapRegime, buyRes.orderId, exitRowMeta);
        } catch (saveErr) {
          _log(`DB EXIT save error after close: ${saveErr.message}`);
        }
      }).catch(e => {
        pos._orderPending = false;
        pos.status = 'open'; // revert so it can be retried on next tick
        pos._exitClosedApplied = false;
        _log(`EXIT order error: ${e.message} — position reverted to open`);
      });
    }
  }
  // Keep 'open' and 'exiting' positions; remove 'closed' ones (exiting resolves async)
  pt.positions = pt.positions.filter(p => p.status === 'open' || p.status === 'exiting');

  // drawdown tracking
  if (pt.equity > pt.peakEquity) pt.peakEquity = pt.equity;
  const dd = pt.peakEquity - pt.equity;
  if (dd > pt.maxDdUsd) pt.maxDdUsd = dd;

  // ── ENTRY checks ─────────────────────────────────────────────────────────
  const _clearEntryGate = () => { delete pt._entryGateReason; };
  const _setEntryGate = (reason) => { pt._entryGateReason = reason; };

  if (!pt.activeZone || !zoneCfg) {
    _setEntryGate('no_active_zone');
    pt.prevSpread = signalSpread;
    return;
  }
  if (pt.regime === REGIME_BO && !pt.exec.allowBoEntries) {
    _setEntryGate('regime_bo_entries_disabled');
    pt.prevSpread = signalSpread;
    return;
  }
  if (pt.dailyPnl <= -pt.dailyLossLimit) {
    _setEntryGate('daily_loss_limit');
    pt.prevSpread = signalSpread;
    return;
  }
  if (now - pt.lastEntryAt < pt.cooldownMs) {
    _setEntryGate(`entry_cooldown_ms=${pt.cooldownMs}`);
    pt.prevSpread = signalSpread;
    return;
  }
  if (hurst != null && hurst > pt.hurstGate) {
    _setEntryGate(`hurst_above_gate(${hurst?.toFixed(3)}>${pt.hurstGate})`);
    pt.prevSpread = signalSpread;
    return;
  }
  if (pt.analytics.regime === 'trending') {
    _setEntryGate('analytics_trending');
    pt.prevSpread = signalSpread;
    return;
  }
  if (pt.prevSpread == null) {
    _setEntryGate('warming_spread_prev');
    pt.prevSpread = signalSpread;
    return;
  }

  const zoneMax = zoneCfg.maxPositions || 4;
  const zoneOpen = pt.positions.filter(
    (p) => p.zoneId === pt.activeZone.id && (p.status === 'open' || p.status === 'exiting')
  ).length;
  if (zoneOpen >= zoneMax) {
    _setEntryGate(`zone_position_cap(${zoneOpen}/${zoneMax})`);
    pt.prevSpread = signalSpread;
    return;
  }

  const allowParkedWide = pt.exec.entryRequireCrossing === false;
  const buf0 = pt.exec.spreadEntryBuffer ?? 0;

  let entryScheduled = false;
  for (let i=pt.entryLevels.length-1; i>=0; i--) {
    const lvl = pt.entryLevels[i];
    if (pt.positions.some(
      (p) => p.gridLevel === i + 1 && p.zoneId === pt.activeZone.id
        && (p.status === 'open' || p.status === 'exiting')
    )) continue;
    const crossed = pt.prevSpread < lvl && signalSpread >= lvl;
    const parkedWide = allowParkedWide && signalSpread >= lvl + buf0;
    if (!crossed && !parkedWide) continue;

    const posQty = _normalizeDeribitOrderQty(
      pt.entryLevelQtys?.[i] != null ? pt.entryLevelQtys[i] : (zoneCfg.qty || 1)
    );
    if (posQty < DERIBIT_TRADE_AMOUNT_STEP) continue;

    if (signalSpread < lvl + buf0) {
      _log(`ENTRY skip [spread] need≥lvl+buffer ${(lvl + buf0).toFixed(4)} got=${signalSpread.toFixed(4)} lvl=${lvl}`);
      break;
    }

    const zSlUsd = parseFloat(zoneCfg.stopLossUsd);
    const pos = {
      id: pt.closedTrades.length+pt.positions.length+1,
      status: 'open', _orderPending: true,
      zoneId: pt.activeZone.id, zoneIdx: pt.activeZone.index,
      gridLevel: i+1, qty: posQty,
      tp: zoneCfg.tp||0.05, sl: zoneCfg.sl||1.0, trailPct: zoneCfg.trailPct||0.5,
      stopLossUsd: Number.isFinite(zSlUsd) && zSlUsd > 0 ? zSlUsd : (pt.stopLossUsd ?? 1),
      openedAt: now, entrySpread: signalSpread, entryPrice: deribitMid,
      entryLegFill: null,
      peakNarrowing: 0, trailingActive: false, _tpTicks: 0, _slTicks: 0,
      asAsk: quotes.askSpread, regime: pt.regime, dbId: null,
    };
    pt.inventory  += pos.qty;
    pt.lastEntryAt = now;
    pos.inventoryAfter = pt.inventory;
    pos.equityAfter    = pt.equity;

    _log(`ENTRY | zone=${pos.zoneId} lvl=${pos.gridLevel} qty=${pos.qty} ` +
         `spread=$${signalSpread.toFixed(4)} price=$${deribitMid.toFixed(2)} ` +
         `asAsk=$${quotes.askSpread.toFixed(4)} regime=${pt.regime} z=${stats.zScore.toFixed(2)}`);

    pt.positions.push(pos);

    const entryRowMeta = { botId: _BOT_ID, sessionId: _SESSION_ID };
    // SELL limit on Deribit only — HL is not traded.
    // _orderPending is kept true until _saveEntry completes so that pos.dbId is
    // guaranteed to be set before the exit path can see this position (prevents
    // race where a fast exit fires while pos.dbId is still null → EXIT row skipped).
    _deribitLimitSell(pos.qty).then(async (sellRes) => {
      if (!sellRes || !sellRes.orderId) {
        pos._orderPending = false;
        pt.inventory -= pos.qty;
        pt.lastEntryAt = now;
        const idx = pt.positions.indexOf(pos);
        if (idx >= 0) pt.positions.splice(idx, 1);
        _log(`ENTRY maker did not fill — rolled back pending pos zone=${pos.zoneId} lvl=${pos.gridLevel}`);
        return;
      }
      pos.dEntryOid = sellRes.orderId;
      pos.entryLegFill = sellRes.avgPrice;
      pos.entryPrice = sellRes.avgPrice;
      // Await DB save so pos.dbId is set before _orderPending is cleared
      try {
        await _saveEntry(pos, signalSpread, deribitMid, hlMid, quotes, stats.zScore, pt.regime, entryRowMeta);
      } finally {
        pos._orderPending = false;
      }
    }).catch((e) => {
      pos._orderPending = false;
      pt.inventory -= pos.qty;
      pt.lastEntryAt = now;
      const idx = pt.positions.indexOf(pos);
      if (idx >= 0) pt.positions.splice(idx, 1);
      _log(`ENTRY order/db error: ${e.message}`);
    });

    pt.bo.addFill(false);
    entryScheduled = true;
    _clearEntryGate();
    break;
  }
  if (!entryScheduled) {
    const maxLvl = pt.entryLevels.length ? Math.max(...pt.entryLevels) : 0;
    const anyFreeLevel = pt.entryLevels.some((_, j) => {
      const gl = j + 1;
      return !pt.positions.some(
        (p) =>
          p.gridLevel === gl &&
          p.zoneId === pt.activeZone.id &&
          (p.status === 'open' || p.status === 'exiting')
      );
    });
    if (!anyFreeLevel) {
      _setEntryGate('all_grid_levels_occupied');
    } else if (!allowParkedWide && signalSpread >= maxLvl + buf0 && pt.prevSpread >= maxLvl) {
      _setEntryGate(
        `awaiting_ladder_cross(spread=${signalSpread.toFixed(4)} maxLvl=${maxLvl} crossing_only=true)`
      );
    } else {
      _setEntryGate('no_ladder_signal_this_tick');
    }
  }
  pt.prevSpread = signalSpread;

  // 30s status heartbeat
  if (now - _lastStatusAt > 30000) {
    _lastStatusAt = now;
    const line = `ticks=${_tickCount} regime=${pt.regime} inv=${pt.inventory} ` +
      `equity=$${pt.equity.toFixed(2)} dailyPnl=$${pt.dailyPnl.toFixed(4)} ` +
      `trades=${pt.closedTrades.length} open=${pt.positions.length} ` +
      `zone=${pt.activeZone?.id||'none'} dd=$${pt.maxDdUsd.toFixed(2)} ` +
      `spread=$${signalSpread.toFixed(4)} z=${stats.zScore.toFixed(2)} price=$${deribitMid.toFixed(2)}`;
    console.log(`[LiveTrade Status] ${line}`);
    _log(`STATUS | ${line}`);
  }

  // 5-min periodic balance snapshot
  if (now - _lastSnapAt > BALANCE_SNAP_INTERVAL) {
    _lastSnapAt = now;
    _saveBalanceSnapshot('periodic').catch(()=>{});
  }
}

// ─── Deribit WS ───────────────────────────────────────────────────────────────

function _connectDeribit() {
  if (!_running) return;
  console.log('[LiveWS Deribit] Connecting...');
  _deribitWs = new WebSocket('wss://www.deribit.com/ws/api/v2');

  _deribitWs.on('open', () => {
    console.log(`[LiveWS Deribit] Connected — subscribing ${DERIBIT_SYMBOL}`);
    _deribitWs.send(JSON.stringify({ jsonrpc:'2.0', id:201, method:'public/subscribe',
      params:{ channels:[`book.${DERIBIT_SYMBOL}.none.20.100ms`] } }));
  });
  _deribitWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.params?.channel?.startsWith('book.') && msg.params?.data) {
        const book = msg.params.data;
        const bids = (book.bids || []).slice(0, 10).map(b => ({ price: String(b[0]), size: String(b[1]) }));
        const asks = (book.asks || []).slice(0, 10).map(a => ({ price: String(a[0]), size: String(a[1]) }));
        if (bids.length > 0 && asks.length > 0) {
          if (!_deribitFirstTick) {
            _deribitFirstTick = true;
            console.log(`[LiveWS Deribit] First book: bid=$${bids[0].price} ask=$${asks[0].price}`);
          }
          _deribitBook = { bids, asks, exchange: 'deribit', symbol: DERIBIT_SYMBOL, timestamp: Date.now() };
          if (_running && _hyperBook) _onBookUpdate().catch(e => console.error('[LiveTrade]', e.message));
        }
      }
    } catch (_) {}
  });
  _deribitWs.on('close', () => {
    if (!_running) return;
    console.log('[LiveWS Deribit] Disconnected — reconnecting in 5s');
    _deribitReconn = setTimeout(() => { _deribitReconn=null; _connectDeribit(); }, 5000);
  });
  _deribitWs.on('error', (e) => {
    console.error(`[LiveWS Deribit] Error: ${e.message}`);
    try { _deribitWs.close(); } catch(_) {}
  });
}

// ─── Hyperliquid WS (signal only — no orders placed here) ────────────────────

function _connectHyperliquid() {
  if (!_running) return;
  console.log('[LiveWS HL] Connecting (signal feed only — no HL orders will be placed)...');
  _hyperWs = new WebSocket('wss://api.hyperliquid.xyz/ws');

  _hyperWs.on('open', () => {
    console.log(`[LiveWS HL] Connected — subscribing ${HYPER_COIN} L2Book`);
    _hyperWs.send(JSON.stringify({ method:'subscribe', subscription:{ type:'l2Book', coin:HYPER_COIN } }));
  });
  _hyperWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'l2Book' && msg.data) {
        const book = msg.data;
        const bids = (book.levels?.[0] || []).slice(0, 10).map(l => ({ price: l.px, size: l.sz }));
        const asks = (book.levels?.[1] || []).slice(0, 10).map(l => ({ price: l.px, size: l.sz }));
        if (bids.length > 0 && asks.length > 0) {
          if (!_hyperFirstTick) {
            _hyperFirstTick = true;
            console.log(`[LiveWS HL] First book: bid=$${bids[0].price} ask=$${asks[0].price}`);
          }
          _hyperBook = { bids, asks, exchange: 'hyperliquid', symbol: HYPER_COIN, timestamp: Date.now() };
          if (_running && _deribitBook) _onBookUpdate().catch(e => console.error('[LiveTrade]', e.message));
        }
      }
    } catch (_) {}
  });
  _hyperWs.on('close', () => {
    if (!_running) return;
    console.log('[LiveWS HL] Disconnected — reconnecting in 5s');
    _hyperReconn = setTimeout(() => { _hyperReconn=null; _connectHyperliquid(); }, 5000);
  });
  _hyperWs.on('error', (e) => {
    console.error(`[LiveWS HL] Error: ${e.message}`);
    try { _hyperWs.close(); } catch(_) {}
  });
}

// ─── Deribit position fetch ───────────────────────────────────────────────────

async function _fetchDeribitPosition() {
  try {
    const res = await signedRequest(
      `/api/v2/private/get_position?instrument_name=${encodeURIComponent(DERIBIT_SYMBOL)}`,
      _deribitApiKey, _deribitSecretKey
    );
    return res?.result ?? null;
  } catch (e) {
    // "Position not found" = no open position — that's normal
    if (e.message?.includes('Position not found') || e.message?.includes('not_found')) return null;
    _log(`Position fetch error: ${e.message}`);
    return null;
  }
}

/** Maker-only close: public book + post_only (reduce_only on flat legs). */
async function _flatCloseDeribitExchange() {
  await _loadCredentials();
  let totalClosed = 0;
  for (let leg = 0; leg < FLAT_MAKER_MAX_LEGS; leg++) {
    const position = await _fetchDeribitPosition();
    if (!position) {
      if (leg === 0) {
        console.log('[LiveTrade] FLAT | No position row on Deribit');
        return { closed: false, reason: 'no_position' };
      }
      return { closed: true, qty: totalClosed };
    }
    const size = parseFloat(position.size);
    if (!Number.isFinite(size) || Math.abs(size) < 1e-6) {
      console.log('[LiveTrade] FLAT | Position flat');
      return { closed: true, qty: totalClosed };
    }
    const qty = _normalizeDeribitOrderQty(Math.abs(size));
    if (qty < DERIBIT_TRADE_AMOUNT_STEP) {
      console.log('[LiveTrade] FLAT | Residual below min contract step — treating as flat');
      return { closed: true, qty: totalClosed };
    }
    const book = await _fetchPublicOrderBook();
    const wantBuy = size < 0;
    const r = wantBuy
      ? await _postOnlyBuyFromBook(qty, book, true)
      : await _postOnlySellFromBook(qty, book, true);
    if (r.error || !r.oid) {
      throw new Error(`[LiveTrade] FLAT maker place failed: ${r.error || 'no order id'}`);
    }
    console.log(`[LiveTrade] FLAT | ${wantBuy ? 'BUY' : 'SELL'} post_only reduce ${qty} @ ${r.limitPx} oid=${r.oid}`);
    const fill = await _waitForOrderFill(r.oid, FLAT_MAKER_FILL_MS);
    if (fill.state !== 'filled') {
      const cleared = await _waitUntilOrderCleared(r.oid);
      if (!cleared) {
        console.warn(`[LiveTrade] FLAT | leg ${leg + 1} could not clear order ${r.oid} — retry after backoff`);
      }
      console.warn(`[LiveTrade] FLAT | leg ${leg + 1} not filled (${fill.state}) — retry`);
      await new Promise((x) => setTimeout(x, 500));
      continue;
    }
    totalClosed += qty;
    await new Promise((x) => setTimeout(x, 400));
  }
  throw new Error('[LiveTrade] FLAT exceeded FLAT_MAKER_MAX_LEGS without full close');
}

/**
 * Exchange cleanup (deactivate / switch / fresh-reset): idempotent on a stopped runner.
 * 1) If still running, stop() — sets _running=false, closes WS, blocks new strategy ticks.
 * 2) Load credentials for opts.deribitAccountId (bot’s Deribit account).
 * 3) Deribit private/cancel_all_by_instrument — removes ALL open orders on that instrument.
 * 4) _flatCloseDeribitExchange — post_only reduce_only legs until position size is ~0 (not “new entries”).
 */
async function shutdownExchangeClean(opts = {}) {
  let accountId = opts.deribitAccountId != null
    ? parseInt(opts.deribitAccountId, 10)
    : (_acctId != null ? _acctId : DERIBIT_ACCT_ID);
  if (!Number.isFinite(accountId) || accountId <= 0) accountId = DERIBIT_ACCT_ID;
  const instrument = opts.instrumentName || DERIBIT_SYMBOL;

  if (_running) stop(opts.reason || 'exchange_clean');

  _acctId = accountId;
  await _loadCredentials();

  let cancelResult = null;
  try {
    const res = await signedRequest(
      `/api/v2/private/cancel_all_by_instrument?instrument_name=${encodeURIComponent(instrument)}&type=all&detailed=false`,
      _deribitApiKey, _deribitSecretKey
    );
    cancelResult = res?.result ?? res;
    console.log(`[LiveTrade] shutdownExchangeClean | cancelled orders on ${instrument} | result=${typeof cancelResult === 'object' ? JSON.stringify(cancelResult).slice(0, 240) : cancelResult}`);
  } catch (e) {
    console.warn(`[LiveTrade] shutdownExchangeClean | cancel_all_by_instrument: ${e.message}`);
    cancelResult = { error: e.message };
  }

  let flat;
  try {
    flat = await _flatCloseDeribitExchange();
  } catch (e) {
    console.warn(`[LiveTrade] shutdownExchangeClean | flat: ${e.message}`);
    flat = { closed: false, error: e.message };
  }

  return { accountId, instrument, cancelResult, flat };
}

function mergeLiveOpts(overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return { ...DEFAULT_LIVE_START_OPTS };
  return {
    ...DEFAULT_LIVE_START_OPTS,
    ...overrides,
    as:       { ...DEFAULT_LIVE_START_OPTS.as,       ...(overrides.as || {}) },
    zoneGrid: { ...DEFAULT_LIVE_START_OPTS.zoneGrid, ...(overrides.zoneGrid || {}) },
    exec:     { ...DEFAULT_LIVE_START_OPTS.exec,     ...(overrides.exec || {}) },
    entryLevels: overrides.entryLevels ?? DEFAULT_LIVE_START_OPTS.entryLevels,
    zones:       overrides.zones       ?? DEFAULT_LIVE_START_OPTS.zones,
  };
}

/** Dump sol_live_trades + sol_balance_snapshots to reports/ before truncate or ops. */
async function backupSolLiveSession(tag = 'backup', filter = {}) {
  const safeTag = String(tag || 'backup').replace(/[^\w.-]+/g, '_').slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const w = filter.botId != null ? { botId: filter.botId } : undefined;
  const trades = await SolLiveTrade.findAll({ raw: true, where: w });
  const snapshots = await SolBalanceSnapshot.findAll({ raw: true, where: w });
  const base = `sol_live_session_${safeTag}_${ts}.json`;
  const filePath = path.join(LOG_DIR, base);
  const payload = {
    exportedAt: new Date().toISOString(),
    trades,
    snapshots,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
  console.log(`[LiveTrade] Session backup: ${filePath} (${trades.length} trades, ${snapshots.length} snapshots)`);
  return { filePath, tradeCount: trades.length, snapshotCount: snapshots.length };
}

/**
 * Stop runner, backup DB rows, maker-flat Deribit, wipe sol_live_trades + sol_balance_snapshots, restart.
 * `startOpts` shallow-merges into DEFAULT_LIVE_START_OPTS (nested as/zoneGrid/exec merged).
 */
async function freshReset(startOpts) {
  const seed = startOpts && typeof startOpts === 'object' ? { ...startOpts } : {};
  if (seed.botId == null) {
    try {
      const active = await SolLiveBot.findOne({ where: { isActive: true }, order: [['id', 'ASC']] });
      if (active) {
        seed.botId = active.id;
        if (seed.deribitAccountId == null) seed.deribitAccountId = active.deribitAccountId;
      }
    } catch (_) {}
  }
  const merged = mergeLiveOpts(seed);
  const wasRunning = _running;
  if (wasRunning) stop('fresh_reset');

  let backupMeta;
  try {
    backupMeta = await backupSolLiveSession('pre_reset');
  } catch (e) {
    console.error('[LiveTrade] freshReset backup error:', e.message);
    throw e;
  }

  let flat;
  try {
    flat = await _flatCloseDeribitExchange();
  } catch (e) {
    console.error('[LiveTrade] freshReset flat-close error:', e.message);
    flat = { closed: false, error: e.message };
  }

  await SolLiveTrade.destroy({ where: {}, truncate: true });
  await SolBalanceSnapshot.destroy({ where: {}, truncate: true });
  console.log('[LiveTrade] freshReset | DB tables truncated (trades + snapshots)');

  _st = null;
  _SESSION_ID = '';
  _tickCount = 0;
  _lastStatusAt = 0;
  _lastSnapAt = 0;
  _spreadWindow = [];
  _deribitBook = null;
  _hyperBook = null;
  _deribitFirstTick = false;
  _hyperFirstTick = false;

  await start(merged);
  console.log(`[LiveTrade] freshReset | New session ${_SESSION_ID}`);
  return { ok: true, flat, sessionId: _SESSION_ID, backup: backupMeta };
}

// ─── Order status monitor ─────────────────────────────────────────────────────
// Polls Deribit order state until filled/cancelled/timeout.
// `signedRequest` may return an error *string* instead of `{ result }`; filled orders also
// vanish from get_order_state — use get_user_trades_by_order as source of truth (same as unilateralExecutor).

async function _deribitUserTradesByOrder(orderId) {
  if (!orderId) return [];
  try {
    const res = await signedRequest(
      `/api/v2/private/get_user_trades_by_order?order_id=${encodeURIComponent(orderId)}`,
      _deribitApiKey, _deribitSecretKey
    );
    if (typeof res === 'string' || !res || res.error) return [];
    return Array.isArray(res.result) ? res.result : [];
  } catch (_) {
    return [];
  }
}

function _avgPxFromDeribitFills(fills) {
  if (!fills?.length) return null;
  let sumPxAmt = 0;
  let sumAmt = 0;
  for (const f of fills) {
    const px = parseFloat(f.price || 0);
    const amt = Math.abs(parseFloat(f.amount || 0));
    if (px > 0 && amt > 0) {
      sumPxAmt += px * amt;
      sumAmt += amt;
    }
  }
  return sumAmt > 0 ? sumPxAmt / sumAmt : null;
}

/** If order row is gone or API errored, infer full fill from trade history. */
async function _tryFillFromTrades(orderId) {
  const fills = await _deribitUserTradesByOrder(orderId);
  const ap = _avgPxFromDeribitFills(fills);
  if (ap == null) return null;
  return { state: 'filled', avgPrice: String(ap), filledQty: null };
}

async function _waitForOrderFill(orderId, timeoutMs = 30000) {
  if (!orderId) return { state: 'unknown' };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!_running) return { state: 'stopped' };
    try {
      const res = await signedRequest(
        `/api/v2/private/get_order_state?order_id=${encodeURIComponent(orderId)}`,
        _deribitApiKey, _deribitSecretKey
      );
      // Failure path returns a string message, not { result }
      if (typeof res === 'string' || res?.error) {
        const fromTrades = await _tryFillFromTrades(orderId);
        if (fromTrades) return fromTrades;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const raw = res?.result;
      if (!raw) {
        const fromTrades = await _tryFillFromTrades(orderId);
        if (fromTrades) return fromTrades;
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      const order = Array.isArray(raw) ? raw[0] : raw;
      const state = String(order.order_state || '').toLowerCase();
      if (state === 'filled') {
        let avgPx = parseFloat(order.average_price);
        if (!Number.isFinite(avgPx) || avgPx <= 0) {
          const ap = _avgPxFromDeribitFills(await _deribitUserTradesByOrder(orderId));
          if (ap != null) avgPx = ap;
        }
        return {
          state: 'filled',
          avgPrice: Number.isFinite(avgPx) && avgPx > 0 ? String(avgPx) : order.average_price,
          filledQty: order.filled_amount,
        };
      }
      if (state === 'cancelled' || state === 'canceled' || state === 'rejected') {
        const fromTrades = await _tryFillFromTrades(orderId);
        if (fromTrades) return fromTrades;
        return { state, avgPrice: null };
      }
      // 'open' or 'partially_filled' — keep polling
    } catch (e) {
      _log(`Order status poll error (${orderId}): ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  const tail = await _tryFillFromTrades(orderId);
  if (tail) {
    _log(`Order ${orderId}: fill inferred from trades after poll window (get_order_state gap)`);
    return tail;
  }
  return { state: 'timeout' };
}

/**
 * Remove EXIT rows that cannot be tied to an ENTRY, EXITs with null entryRowId,
 * and duplicate EXITs per entryRowId (keep earliest id). Scoped to one bot.
 * Run before loading daily PnL so sums match exchange-backed reality.
 */
async function _cleanupSolLiveExitRows(botIdOverride = null) {
  const botId = botIdOverride ?? _BOT_ID;
  if (botId == null) {
    _log('RECONCILE cleanup | skipped (no botId)');
    return;
  }

  let removed = 0;

  const nNull = await SolLiveTrade.destroy({
    where: { type: 'EXIT', botId, entryRowId: null },
  });
  removed += nNull;
  if (nNull) _log(`RECONCILE cleanup | removed ${nNull} EXIT(s) with null entryRowId (bot ${botId})`);

  const badRows = await SolLiveTrade.sequelize.query(
    `SELECT x.id FROM sol_live_trades x
     LEFT JOIN sol_live_trades e ON e.id = x.entryRowId AND e.type = 'ENTRY'
     WHERE x.type = 'EXIT' AND x.botId = :botId AND x.entryRowId IS NOT NULL AND e.id IS NULL`,
    { replacements: { botId }, type: QueryTypes.SELECT }
  );
  if (badRows.length) {
    const ids = badRows.map((r) => r.id);
    const n = await SolLiveTrade.destroy({ where: { id: ids } });
    removed += n;
    _log(`RECONCILE cleanup | removed ${n} orphan EXIT(s) (no matching ENTRY row) (bot ${botId})`);
  }

  const dupGroups = await SolLiveTrade.sequelize.query(
    `SELECT entryRowId, MIN(id) AS keepId FROM sol_live_trades
     WHERE type = 'EXIT' AND botId = :botId AND entryRowId IS NOT NULL
     GROUP BY entryRowId HAVING COUNT(*) > 1`,
    { replacements: { botId }, type: QueryTypes.SELECT }
  );
  for (const d of dupGroups) {
    const victims = await SolLiveTrade.findAll({
      attributes: ['id'],
      where: {
        type: 'EXIT',
        botId,
        entryRowId: d.entryRowId,
        id: { [Op.ne]: d.keepId },
      },
      raw: true,
    });
    const ids = victims.map((v) => v.id);
    if (ids.length) {
      const n = await SolLiveTrade.destroy({ where: { id: ids } });
      removed += n;
      _log(`RECONCILE cleanup | removed ${n} duplicate EXIT(s) for entryRowId=${d.entryRowId} (kept id=${d.keepId})`);
    }
  }

  if (removed === 0) _log(`RECONCILE cleanup | EXIT table OK (bot ${botId}, no rows removed)`);
}

// ─── Reconcile open positions on restart ─────────────────────────────────────
// Compares DB orphaned ENTRYs against actual Deribit position to determine
// which positions are truly still open vs already closed externally.
// Loads surviving positions into memory so the runner can manage them.

async function _reconcileOpenPositions() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  let orphans;
  try {
    /**
     * Orphan = ENTRY with no runner-recorded EXIT yet (EXIT row with deribitOrderId set).
     * ENTRY rows always have pnlUsd=null — do NOT use that as a signal (it matched every ENTRY
     * and caused duplicate reconcile_external_close EXITs on every boot).
     */
    const exitWhere = {
      type: 'EXIT',
      entryRowId: { [Op.ne]: null },
      deribitOrderId: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
    };
    if (_BOT_ID != null) exitWhere.botId = _BOT_ID;
    const coveredRows = await SolLiveTrade.findAll({
      attributes: ['entryRowId'],
      where: exitWhere,
      raw: true,
    });
    const closedEntryIds = [...new Set(coveredRows.map((r) => r.entryRowId).filter((id) => id != null))];

    const orphanWhere = { type: 'ENTRY', eventAt: { [Op.gte]: cutoff } };
    if (_BOT_ID != null) orphanWhere.botId = _BOT_ID;
    if (closedEntryIds.length > 0) orphanWhere.id = { [Op.notIn]: closedEntryIds };

    orphans = await SolLiveTrade.findAll({
      where: orphanWhere,
      order: [['id', 'ASC']],
    });
  } catch (e) {
    console.error('[LiveTrade] Reconcile DB query failed:', e.message);
    return;
  }

  if (orphans.length === 0) {
    _log('RECONCILE | No orphaned positions in DB — clean start');
    return;
  }

  const orphanQty = orphans.reduce((s, r) => s + parseFloat(r.qty), 0);
  _log(`RECONCILE | Found ${orphans.length} unmatched ENTRY record(s) in DB (${orphanQty} SOL) — checking Deribit...`);
  console.log(`[LiveTrade] Reconciling ${orphans.length} orphaned DB positions against Deribit...`);

  // Get actual Deribit position for this symbol
  const position = await _fetchDeribitPosition();
  // Deribit: negative size = short. We short SOL to enter, so open means size < 0.
  const deribitShort = position ? Math.abs(Math.min(0, position.size ?? 0)) : 0;

  _log(`RECONCILE | Deribit actual position: ${deribitShort} SOL short | DB expects: ${orphanQty} SOL short`);

  const now = Date.now();
  const pt = _st;
  let qtyToLoad = deribitShort;

  for (const row of orphans) {
    const qty = parseFloat(row.qty);
    const zoneCfg = (pt.zoneGrid.zones || [])[row.zoneIndex] || {};

    if (qtyToLoad >= qty - 0.001) {
      // This position is still open on Deribit — load it into memory
      const zSlUsdR = parseFloat(zoneCfg.stopLossUsd);
      const pos = {
        id:             row.id,
        status:         'open',
        _orderPending:  false,
        zoneId:         row.zoneId,
        zoneIdx:        row.zoneIndex,
        gridLevel:      row.gridLevel,
        qty,
        tp:             parseFloat(zoneCfg.tp)       || 0.05,
        sl:             parseFloat(zoneCfg.sl)       || 1.0,
        trailPct:       parseFloat(zoneCfg.trailPct) || 0.5,
        stopLossUsd:
          Number.isFinite(zSlUsdR) && zSlUsdR > 0 ? zSlUsdR : (pt.stopLossUsd ?? 1),
        openedAt:       row.eventAt ? row.eventAt.getTime() : now,
        entrySpread:    parseFloat(row.signalSpread) || 0,
        entryPrice:
          row.legFillPrice != null && Number.isFinite(parseFloat(row.legFillPrice))
            ? parseFloat(row.legFillPrice)
            : parseFloat(row.deribitMid) || 0,
        entryLegFill:
          row.legFillPrice != null && Number.isFinite(parseFloat(row.legFillPrice))
            ? parseFloat(row.legFillPrice)
            : null,
        peakNarrowing:  0,
        trailingActive: false,
        _tpTicks: 0, _slTicks: 0,
        asAsk:          parseFloat(row.asAskSpread)  || 0,
        regime:         row.regime || REGIME_MR,
        dbId:           row.id,
        resumed:        true,
      };
      pt.positions.push(pos);
      pt.inventory += qty;
      qtyToLoad -= qty;
      _log(`RECONCILE | Loaded pos id=${row.id} zone=${row.zoneId} lvl=${row.gridLevel} qty=${qty} — OPEN on Deribit`);
    } else {
      // Position was closed externally (TP/SL on exchange or manual) — record EXIT
      const exitNow = new Date();
      try {
        // NOT NULL columns on sol_live_trades — use placeholders when close happened off-runner
        await SolLiveTrade.create({
          sessionId:      _SESSION_ID,
          botId:          _BOT_ID,
          type:           'EXIT',
          entryRowId:     row.id,
          zoneId:         row.zoneId,
          zoneIndex:      row.zoneIndex,
          gridLevel:      row.gridLevel,
          qty,
          signalSpread:   0,
          deribitMid:     0,
          hlMid:          0,
          asAskSpread:    null,
          zScore:         null,
          regime:         row.regime,
          inventoryAfter: null,
          equityAfter:    null,
          pnlUsd:         0,      // unknown PnL — closed externally
          holdSec:        (exitNow - row.eventAt) / 1000,
          peakNarrow:     null,
          exitReason:     'reconcile_external_close',
          deribitOrderId: null,
          legFillPrice:   null,
          eventAt:        exitNow,
        });
        _log(`RECONCILE | Recorded external close for id=${row.id} zone=${row.zoneId} lvl=${row.gridLevel}`);
      } catch (dbErr) {
        _log(`RECONCILE | DB write failed for id=${row.id}: ${dbErr.message}`);
      }
    }
  }

  if (pt.positions.length > 0) {
    _log(`RECONCILE | ${pt.positions.length} position(s) loaded into runner (inv=${pt.inventory} SOL) — runner will manage TP/SL`);
    console.log(`[LiveTrade] ${pt.positions.length} live position(s) resumed from Deribit reconciliation`);
  } else {
    _log('RECONCILE | All orphaned positions were externally closed — inventory reset to 0');
    console.log('[LiveTrade] No open positions found on Deribit — clean state');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function start(opts = {}) {
  if (_running) { console.log('[LiveTrade] Already running'); return; }

  const acctParsed = parseInt(opts.deribitAccountId, 10);
  _acctId = Number.isFinite(acctParsed) && acctParsed > 0 ? acctParsed : DERIBIT_ACCT_ID;
  const botParsed = parseInt(opts.botId, 10);
  _BOT_ID = Number.isFinite(botParsed) && botParsed > 0 ? botParsed : null;

  _SESSION_ID = new Date().toISOString().replace(/[:.]/g,'-').slice(0,23);
  // No time-based stop — ignores opts.stopAt entirely.

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  _LOG_FILE = path.join(LOG_DIR, 'live_sol_live.log');
  // If the existing log is owned by root and not writable by the current user,
  // fall back to a session-specific file so pm2 (pushpa) can write without error.
  try {
    fs.accessSync(_LOG_FILE, fs.constants.W_OK);
  } catch (_) {
    _LOG_FILE = path.join(LOG_DIR, `live_sol_live_${_SESSION_ID}.log`);
    console.log(`[LiveTrade] Log fallback (permission): ${_LOG_FILE}`);
  }

  // Load only Deribit credentials (HL is public WS, no auth needed for orderbook)
  await _loadCredentials();

  // Use actual Deribit equity as the session baseline — never use hardcoded capital
  const _initBal = await _fetchDeribitBalance();
  const _initEquity = parseFloat(_initBal?.equity ?? opts.capital ?? 366);
  console.log(`[LiveTrade] Session equity baseline: $${_initEquity.toFixed(4)} (from Deribit)`);

  await _cleanupSolLiveExitRows();

  _st = {
    capital:        _initEquity,
    equity:         _initEquity,
    peakEquity:     _initEquity,
    dailyLossLimit: opts.dailyLossLimit ?? 39,
    dailyPnl: 0, dailyDate: '',
    inventory: 0,
    positions: [], closedTrades: [],
    maxDdUsd: 0, lastEntryAt: 0,
    cooldownMs:     opts.cooldownMs     ?? 5000,
    minHoldMs:      opts.minHoldMs      ?? 15000,
    tpConfirmTicks: opts.tpConfirmTicks ?? 3,
    slConfirmTicks: opts.slConfirmTicks ?? 7,
    stopLossUsd: opts.stopLossUsd ?? DEFAULT_LIVE_START_OPTS.stopLossUsd,
    stopLossConfirmTicks:
      opts.stopLossConfirmTicks ?? DEFAULT_LIVE_START_OPTS.stopLossConfirmTicks,
    hurstGate:      opts.hurstGate      ?? 0.78,
    entryLevels:     opts.entryLevels   || [0.06, 0.08, 0.12, 0.18],
    entryLevelQtys:  null,   // computed per zone: zone.qty / numLevels
    prevSpread: null, regime: REGIME_MR, activeZone: null,
    analytics: new SpreadAnalytics(opts.analyticsWindow ?? 120),
    bo:        new BreakoutDetector(),
    as:        new AvellanedaStoikov(opts.as || {}),
    zoneGrid:  new ZoneGrid({ ...opts.zoneGrid, zones: opts.zones }),
    skew: { bidWidenLambda: opts.bidWidenLambda??1.0, askTightenPhi: opts.askTightenPhi??0.6 },
    exec: { ...DEFAULT_LIVE_START_OPTS.exec, ...(opts.exec || {}) },
  };

  _running = true;
  _tickCount=0; _lastStatusAt=0; _lastSnapAt=Date.now(); _spreadWindow=[];
  _deribitBook=null; _hyperBook=null;
  _deribitFirstTick=false; _hyperFirstTick=false;

  // No scheduled stop — runs indefinitely until manual stop() or daily loss limit.

  console.log('═'.repeat(70));
  console.log('  LIVE TRADE ENGINE  (Deribit "DERIBIT-HYPE test")');
  console.log('  HL WS connected for spread signal only — NO HL orders placed');
  console.log('═'.repeat(70));
  console.log(`  Symbol       : ${DERIBIT_SYMBOL} (Deribit, maker-first post_only)`);
  console.log(`  Entry        : ladder ${(_st.exec.entryRequireCrossing !== false) ? 'crossing only' : 'crossing or parked-wide'}  lvl+buffer+${_st.exec.spreadEntryBuffer ?? 0}`);
  console.log(`  Exit filters : edge>${_st.exec.edgeFeeMult}×fees  imb L${_st.exec.imbLevels}  deferBuyExitIfBidShare<${_st.exec.exitMinBidShare}  hurstGate<=${_st.hurstGate}`);
  console.log(`  Signal from  : HL SOL L2Book (read-only reference)`);
  console.log(`  Capital      : $${_initEquity.toFixed(4)} (live Deribit equity)  |  Daily loss: $${opts.dailyLossLimit??39}`);
  console.log(`  Anchor       : $${opts.zoneGrid?.anchorPrice??84.00} ± $${opts.zoneGrid?.range??4}`);
  const z0 = (opts.zones && opts.zones[0] && opts.zones[0].qty) || 1;
  const nLv = (_st.entryLevels || []).length || 4;
  console.log(`  Qty/zone     : ${z0} SOL total  (split across ${nLv} levels, each multiple of ${DERIBIT_TRADE_AMOUNT_STEP} SOL)`);
  console.log(
    `  Stop-loss   : $${_st.stopLossUsd} USD / leg (zone override: stopLossUsd), confirm ${_st.stopLossConfirmTicks} ticks`
  );
  console.log(`  Stop        : manual only (no time-based session stop)`);
  console.log(`  Session ID   : ${_SESSION_ID}`);
  console.log(`  Log          : ${_LOG_FILE}`);
  console.log(`  DB tables    : sol_live_trades  +  sol_balance_snapshots`);
  console.log('═'.repeat(70));

  _log(`Session started | sessionId=${_SESSION_ID}`);

  // ── Load today's closed PnL from DB so dailyPnl survives restarts ───────────
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayWhere = { type: 'EXIT', eventAt: { [Op.gte]: todayStart } };
    if (_BOT_ID != null) todayWhere.botId = _BOT_ID;
    const todayExits = await SolLiveTrade.findAll({
      where: todayWhere,
      attributes: ['pnlUsd'],
    });
    _st.dailyPnl = todayExits.reduce((s, r) => s + parseFloat(r.pnlUsd || 0), 0);
    if (todayExits.length > 0)
      console.log(`[LiveTrade] Loaded today's PnL from DB: $${_st.dailyPnl.toFixed(4)} (${todayExits.length} closed trades)`);
  } catch (e) {
    console.warn('[LiveTrade] Could not load today PnL from DB:', e.message);
  }

  // Session-start balance snapshot
  await _saveBalanceSnapshot('session_start', _BOT_ID);

  // ── Reconcile: check actual Deribit position vs DB orphaned ENTRYs ──────────
  // Loads truly-open positions back into memory; records external closes in DB.
  await _reconcileOpenPositions();

  _connectDeribit();
  _connectHyperliquid();
}

function stop(reason) {
  if (!_running) return null;
  _running = false;
  console.log(`\n[LiveTrade] Stopping: ${reason||'manual'}`);
  _log(`Stopping: ${reason||'manual'}`);

  // _stopTimer is unused (no time-based stop)
  if (_deribitReconn){ clearTimeout(_deribitReconn); _deribitReconn=null; }
  if (_hyperReconn)  { clearTimeout(_hyperReconn);   _hyperReconn=null; }
  try { _deribitWs?.close(); } catch(_) {}
  try { _hyperWs?.close();   } catch(_) {}

  const pt = _st;
  if (!pt) return null;

  const totalPnl = pt.closedTrades.reduce((a,t)=>a+t.pnlUsd,0);
  const winners  = pt.closedTrades.filter(t=>t.pnlUsd>0);
  const summary  = [
    '═'.repeat(70), '  LIVE TRADING SESSION SUMMARY', '═'.repeat(70),
    `  Session ID   : ${_SESSION_ID}`,
    `  Total trades : ${pt.closedTrades.length}`,
    `  Winners      : ${winners.length}  |  Losers: ${pt.closedTrades.length-winners.length}`,
    `  Win rate     : ${pt.closedTrades.length>0?(winners.length/pt.closedTrades.length*100).toFixed(1):0}%`,
    `  Total PnL    : $${totalPnl.toFixed(4)}`,
    `  Final equity : $${pt.equity.toFixed(2)}`,
    `  Max drawdown : $${pt.maxDdUsd.toFixed(2)}`,
    `  Open pos     : ${pt.positions.length}  (check Deribit manually if non-zero)`,
    '─'.repeat(70),
  ].join('\n');

  console.log('\n' + summary);
  _log(summary);
  const summaryFile = path.join(LOG_DIR, 'live_sol_live_summary.txt');
  fs.writeFileSync(summaryFile, summary + '\n', 'utf8');
  console.log(`[LiveTrade] Summary: ${summaryFile}`);

  const snapBotId = _BOT_ID;
  // Keep module _BOT_ID until the next start() — in-flight maker .then handlers may still persist
  // ENTRY rows after fill; clearing here caused DB save failures and duplicate same-level entries.

  // Session-stop balance snapshot (async fire-and-forget)
  _saveBalanceSnapshot('session_stop', snapBotId).catch(()=>{});

  return { summary, trades: pt.closedTrades };
}

function getState() {
  if (!_st) return null;
  return {
    running:       _running,
    sessionId:     _SESSION_ID,
    botId:         _BOT_ID,
    deribitAccountId: _acctId,
    signalSpread:  _lastSpread ?? null,
    deribitMid:    _lastDeribitMid ?? null,
    regime:        _st.regime,
    inventory:     _st.inventory,
    startEquity:   _st.capital,        // actual Deribit equity at session start
    equity:        _st.equity,         // current runner equity (fee-adjusted on each close)
    dailyPnl:      _st.dailyPnl,       // sum of EXIT pnlUsd (net of est. round-trip fees)
    maxDrawdown:   _st.maxDdUsd,
    /** Completed round-trips only; open legs are not counted here. */
    totalTrades:   _st.closedTrades.length,
    openPositions: _st.positions.filter(p=>p.status==='open'||p.status==='exiting').length,
    activeZone:    _st.activeZone?.id || null,
    /** Why a new ENTRY was not opened on the last book tick (debug / ops). */
    entryGate:     _st._entryGateReason || null,
    exec:          _st.exec,
    stopLossUsd:   _st.stopLossUsd,
    stopLossConfirmTicks: _st.stopLossConfirmTicks,
    pnlNetOfFees:  true,
  };
}

function isRunning() { return _running; }

function getActiveBotId() {
  return _running ? _BOT_ID : null;
}

async function triggerSnapshot(type = 'manual') {
  if (_running && _deribitApiKey) {
    await _saveBalanceSnapshot(type);
  }
}

/** Run EXIT cleanup for a bot (orphan / null entryRowId / duplicates). Safe to call while runner stopped. */
async function cleanupSolLiveExitsForBot(botId) {
  const id = parseInt(botId, 10);
  if (!Number.isFinite(id) || id < 1) throw new Error('cleanupSolLiveExitsForBot: botId must be a positive integer');
  await _cleanupSolLiveExitRows(id);
}

module.exports = {
  start,
  stop,
  getState,
  isRunning,
  getActiveBotId,
  triggerSnapshot,
  freshReset,
  backupSolLiveSession,
  shutdownExchangeClean,
  mergeLiveOpts,
  DEFAULT_LIVE_START_OPTS,
  cleanupSolLiveExitsForBot,
};
