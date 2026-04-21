/**
 * unilateralExecutorV2.js
 *
 * Enhanced single-leg basis executor with three additional filters on top of V1:
 *
 *  1. FEE-AWARE ENTRY GATE
 *     (entrySpread - rollingMean) must exceed FEE_EDGE_MULTIPLE × round-trip maker fee in **USD**
 *     estimated from the traded leg's order notional (inverse: qty is USD; linear: price×qty).
 *     Prevents entries when the basis premium vs mean is smaller than a few dollars of fees.
 *
 *  2. REGIME FILTER (trend + volatility)
 *     Blocks entries when:
 *       a) Trend slope  > threshold  — spread is moving directionally (trending, not mean-reverting)
 *       b) Volatility expansion > threshold — spread std is spiking vs rolling baseline
 *     Uses a ring buffer of the last TREND_WINDOW spread ticks for regression slope.
 *     State logged as state._regimeBlocked for dashboard visibility.
 *
 *  3. DYNAMIC TP (mean-reversion based)
 *     In ADDITION to the fixed tpSpreadDelta, profit exit also triggers when:
 *       a) currentSpread <= rollingMean (spread has reverted to mean — strongest signal)
 *       b) z-score crosses 0 from above (spread was above mean at entry, now at/below mean)
 *     This produces faster exits during strong mean-reversion events while the fixed delta
 *     acts as the minimum exit threshold in slow / partial reversion scenarios.
 *
 * All other logic (order management, DB writes, adaptive levels, drawdown kill-switch,
 * account refresh, enable/disable, getState) is identical to unilateralExecutor.js (V1).
 *
 * Routing: pairs whose DB row has executorVersion='v2' are booted by this executor.
 * orderbookStreams.js calls both V1 and V2; this executor is a no-op for pairs not in its map.
 */

'use strict';

const crypto = require('crypto');
const {
  buyorder,
  sellorder,
  cancelorder,
  signedRequest,
} = require('../controllers/apicontroller');
const { StatArbInput, AccountDetails } = require('../models');
const Trade              = require('../models/Trade');
const BasisPosition      = require('../models/BasisPosition');
const SpreadLevelHistory = require('../models/SpreadLevelHistory');
const btcAnalysisHook    = require('./btcAnalysisHook');

// ─── tunable constants ────────────────────────────────────────────────────────
const POLL_MS            = 1500;
const ENTRY_TIMEOUT_MS   = 45_000;
const EXIT_TIMEOUT_MS    = 30_000;
const COOLDOWN_MS        = 30_000;

/** Profit exits must show strictly positive strategy gross (entry→exit) above this USD threshold. */
const PROFIT_EXIT_MIN_GROSS_USD = 1e-6;

// Regime filter
const TREND_WINDOW             = 30;   // ticks in regression window
const TREND_STRENGTH_THRESHOLD = 0.50; // block if |normalised slope| > this (σ/tick units)
const VOL_EXPANSION_THRESHOLD  = 2.0;  // block if realtime std > 2× rolling baseline std

// Fee-aware gate
const MAKER_FEE_RATE    = 0.0001;  // Deribit BTC-PERPETUAL maker rebate rate (0.01%)
const FEE_EDGE_MULTIPLE = 2.0;     // entry spread edge must be > 2× maker round-trip fee equiv

// ─── helpers ─────────────────────────────────────────────────────────────────
function _sendTelegramAlert(text) {
  // Telegram alerts disabled
  // try {
  //   const { sendTelegram } = require('./telegramReport');
  //   sendTelegram(text).catch(e => console.warn(`[UniExecV2] Telegram alert error: ${e.message}`));
  // } catch (e) {
  //   console.warn(`[UniExecV2] Cannot send Telegram alert: ${e.message}`);
  // }
}

/** Same convention as V1: Deribit settlement currency from instrument name. */
function _coinFromSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.includes('_USDC')) return 'USDC';
  const base = s.split('-')[0];
  return base || 'BTC';
}

function _optionCurrency(state) {
  return _coinFromSymbol(state.pair?.symbol1 || '');
}

function minGrossProfitUsd() { return 0; }

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key      = Buffer.from(keyBase64, 'base64');
  const iv       = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

async function getApiCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
  return { apiKey: decryptText(ak2, ak1, ak0), secretKey: decryptText(sk2, sk1, sk0) };
}

/** Linear regression slope over an array of y-values (x = index). */
function regressionSlope(arr) {
  const n = arr.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += arr[i];
    sumXY += i * arr[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

// ─── state class ─────────────────────────────────────────────────────────────
class UniStateV2 {
  constructor(pairId) {
    this.pairId              = pairId;
    this.enabled             = false;
    this.enabledAt           = null;
    this.pair                = null;
    this.clientA             = null;
    this.lastOrderbooks      = null;
    this.openPositions       = [];
    this.levelQty            = [];
    this.levels              = [];
    this.prevSignalSpread    = null;
    this.lastEntryAt         = 0;
    this.filledQty           = 0;
    this._idleAlertSentAt    = 0;
    this.tpSpreadDelta       = null;
    this.slSpreadDelta       = null;
    this.entryTimeoutMs      = ENTRY_TIMEOUT_MS;
    this._entryInFlight      = false;
    this.tradeLeg            = 'A';
    this.tradeSymbol         = null;
    this.dailyPnl            = 0;
    this.dailyPnlResetDate   = new Date().toISOString().slice(0, 10);
    this.dailyLossLimitUsd   = 0;
    this.lastStopExitAt      = 0;
    this._cachedBalance      = null;
    this._startBalance       = null;
    this._botStartBalance    = null;
    this._livePositions      = [];
    this._feeLevel           = null;
    this._makerRebate        = null;
    this._accountRefreshTimer = null;
    this.maxDrawdownUsd      = 0;
    this.drawdownPct         = 0;
    this._peakEquity         = null;
    this._currentEquity      = null;
    this._currentDrawdownUsd = 0;
    this._currentDrawdownPct = 0;
    this._killSwitchTriggered = false;

    // Option profit take-profit
    this._optionProfitTargetUsd = 0;
    this._optionProfitTriggered = false;
    this._lastOptionPnlUsd = null;

    // Adaptive-levels state
    this._adaptedAt           = null;
    this._adaptedMaxSpreadCap = null;

    // V2-specific: market stats updated by adapt scheduler
    this._dollarMean   = null;  // rolling spread mean (from orderbookManager snapshot)
    this._dollarStd    = null;  // rolling spread std
    this._spreadHistory = [];   // ring buffer, last TREND_WINDOW signal-spread ticks

    // V2-specific: regime state (for dashboard / logging)
    this._regimeBlocked = false;
    this._lastRegimeLog = 0;
    this._lastFeeGateLog = 0;
    this._spreadUpdateInFlight = false;
  }
}

// ─── executor ────────────────────────────────────────────────────────────────
class UnilateralExecutorV2 {
  constructor() {
    this.pairs     = new Map();
    this.startedAt = Date.now();
  }

  // ── misc helpers ────────────────────────────────────────────────────────────
  _isLinearUsdc(state) {
    const sym = state.tradeSymbol || state.pair?.symbol1 || state.pair?.symbol2 || '';
    return sym.includes('_USDC');
  }

  _settlementCurrency(state) {
    const sym = state.tradeSymbol || state.pair?.symbol1 || state.pair?.symbol2 || '';
    return _coinFromSymbol(sym);
  }

  _broadcastState(pairId) {
    try {
      const m = require('./orderbookStreams');
      m.broadcast({ type: 'trade_state', pairId, executor: 'v2', ...this.getState(pairId) });
    } catch (_) {}
  }

  async _placeLimit(state, side, qty, price) {
    const sym    = state.tradeSymbol || state.pair.symbol1;
    const result = side === 'buy'
      ? await buyorder(sym, qty, 'limit', price, state.clientA.apiKey, state.clientA.secretKey)
      : await sellorder(sym, qty, 'limit', price, state.clientA.apiKey, state.clientA.secretKey);
    const order  = result?.result?.order;
    return { orderId: order?.order_id || null, state: order?.order_state || null,
             avgPrice: order?.average_price || order?.price || price };
  }

  async _cancel(state, orderId) {
    if (!orderId) return null;
    try {
      const resp = await cancelorder(orderId, state.clientA.apiKey, state.clientA.secretKey);
      if (!resp || !resp.notOpen) return resp;

      const pairId = state?.pairId ?? state?.pair?.id ?? '?';
      const pos = (state.openPositions || []).find(
        (p) => p.entryOrderId === orderId || p.exitOrderId === orderId,
      );
      const role = pos
        ? (pos.entryOrderId === orderId ? 'entry' : 'exit')
        : null;

      if (resp.orderState === 'filled' && pos && role) {
        console.warn(
          `[execV2 pair ${pairId}] cancel ${orderId} raced to FILL (${role}); routing through fill handler`,
        );
        if (pos.pollTimer) { clearInterval(pos.pollTimer); pos.pollTimer = null; }
        const st = await this._orderStatus(state, orderId);
        if (st.status !== 'filled') {
          console.warn(
            `[execV2 pair ${pairId}] cancel ${orderId} reconciled filled but _orderStatus returned ${st.status}; skipping fill handler`,
          );
          return resp;
        }
        try {
          if (role === 'entry') {
            await this._onEntryFilled(state, pos, st);
          } else {
            await this._onExitFilled(state, pos, st);
          }
          return { ...resp, raceHandled: true, role };
        } catch (e) {
          console.error(
            `[execV2 pair ${pairId}] fill handler (${role}) failed for ${orderId}: ${e.message}`,
          );
          return resp;
        }
      }

      console.log(
        `[execV2 pair ${pairId}] cancel ${orderId} — already terminal (order_state=${resp.orderState}); skipping`,
      );
      return resp;
    } catch (_) {
      return null;
    }
  }

  /**
   * Promote a position whose entry order just filled. Shared between the
   * normal poll path and the cancel-race path in `_cancel`. Caller is
   * responsible for stopping pos.pollTimer before calling.
   */
  async _onEntryFilled(state, pos, st) {
    if (!st || st.status !== 'filled' || !st.filledPrice) return false;
    if (pos.status === 'open' || pos.status === 'pending_exit' || pos.status === 'closed') {
      return false;
    }
    const isLegB = state.tradeLeg === 'B';
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const refPrice = isLegB
      ? parseFloat(ob1?.asks?.[0]?.price || 0)
      : parseFloat(ob2?.bids?.[0]?.price || 0);
    const effectiveRef = refPrice || st.filledPrice;
    if (!effectiveRef) return false;

    pos.entryPriceA = st.filledPrice;
    pos.entryPriceB = effectiveRef;
    pos.fillSpread = isLegB
      ? parseFloat((effectiveRef - st.filledPrice).toFixed(4))
      : parseFloat((st.filledPrice - effectiveRef).toFixed(4));
    pos.bestSpread = pos.fillSpread;

    const entryCommission = await this._getOrderCommissionUsd(state, pos.entryOrderId, pos.entryPriceA);
    pos.entryCommissionUsd = entryCommission;
    await Trade.update({
      status: 'filled', legA_price: pos.entryPriceA, legA_filledAt: new Date(),
      legB_price: pos.entryPriceB, legB_filledAt: new Date(), commission: entryCommission,
    }, { where: { id: pos.entryTradeId } }).catch(() => {});
    await BasisPosition.update({
      state: 'open', legA_entryPrice: pos.entryPriceA,
      legB_entryPrice: pos.entryPriceB, legA_entryOrderId: pos.entryOrderId,
    }, { where: { id: pos.basisPositionId } }).catch(() => {});
    pos.status = 'open';
    pos.openedAt = Date.now();
    state.filledQty += pos.qty;
    this._broadcastState(state.pairId);
    return true;
  }

  /**
   * Close out a position whose exit order just filled. Shared between the
   * normal poll path and the cancel-race path in `_cancel`. Caller is
   * responsible for stopping pos.pollTimer before calling.
   */
  async _onExitFilled(state, pos, st) {
    if (!st || st.status !== 'filled' || !st.filledPrice) return false;
    if (pos.status === 'closed') return false;

    const isLegB = state.tradeLeg === 'B';
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const refPrice = isLegB
      ? parseFloat(ob1?.bids?.[0]?.price || pos.entryPriceB || 0)
      : parseFloat(ob2?.bids?.[0]?.price || pos.entryPriceB || 0);
    const exitPriceA = st.filledPrice;
    const effectiveRef = refPrice || pos.entryPriceB || exitPriceA;

    const exitSpread = isLegB
      ? parseFloat((effectiveRef - exitPriceA).toFixed(4))
      : parseFloat((exitPriceA - effectiveRef).toFixed(4));

    let grossPnl;
    if (this._isLinearUsdc(state)) {
      grossPnl = parseFloat(
        (isLegB ? pos.qty * (exitPriceA - pos.entryPriceA) : pos.qty * (pos.entryPriceA - exitPriceA)).toFixed(6),
      );
    } else {
      const pnlBtc = isLegB
        ? parseFloat((pos.qty * (1 / pos.entryPriceA - 1 / exitPriceA)).toFixed(8))
        : parseFloat((pos.qty * (1 / exitPriceA - 1 / pos.entryPriceA)).toFixed(8));
      grossPnl = parseFloat((pnlBtc * exitPriceA).toFixed(6));
    }
    const exitCommission = await this._getOrderCommissionUsd(state, pos.exitOrderId, exitPriceA);
    const totalCommission = parseFloat(((pos.entryCommissionUsd || 0) + (exitCommission || 0)).toFixed(6));
    const netPnl = parseFloat((grossPnl + totalCommission).toFixed(6));

    let exitReasonForDb = pos.exitReason || null;
    if (exitReasonForDb === 'profit' && !(grossPnl > PROFIT_EXIT_MIN_GROSS_USD)) {
      exitReasonForDb = 'profit_fill_gross_nonpos';
      console.warn(
        `[UniExecV2] pair ${state.pairId} exit re-tagged: armed as profit but filled gross ` +
        `grossPnl=$${grossPnl.toFixed(4)} (entry=${pos.entryPriceA} exit=${exitPriceA}) → ${exitReasonForDb}`,
      );
    }

    await Trade.update({
      status: 'filled', legA_price: exitPriceA, legA_filledAt: new Date(),
      legB_price: effectiveRef, legB_filledAt: new Date(),
      spreadAtExit: exitSpread, legA_pnl: grossPnl, legB_pnl: 0, pnl: netPnl,
      commission: exitCommission,
    }, { where: { id: pos.exitTradeId } }).catch(() => {});
    await BasisPosition.update({
      state: 'closed', exitTradeId: pos.exitTradeId, exitSpread,
      exitReason: exitReasonForDb, legA_exitPrice: exitPriceA, legB_exitPrice: effectiveRef,
      legA_exitOrderId: pos.exitOrderId, exitTime: new Date(),
      holdMs: pos.openedAt ? Date.now() - pos.openedAt : 0,
      spreadChange: parseFloat((exitSpread - (pos.entrySignalSpread || 0)).toFixed(4)),
      legA_pnl: grossPnl, legB_pnl: 0, grossPnl, commission: totalCommission,
      takerFeeUsd: 0, netPnl,
    }, { where: { id: pos.basisPositionId } }).catch(() => {});

    state.dailyPnl = parseFloat(((state.dailyPnl || 0) + netPnl).toFixed(6));
    if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd && !state._killSwitchTriggered) {
      console.error(
        `[UniExecV2] *** DAILY LOSS KILL SWITCH *** pair ${state.pairId} | ` +
        `dailyPnl=$${state.dailyPnl.toFixed(2)} <= -$${state.dailyLossLimitUsd} | ` +
        `closing perps, stopping bot (options untouched)`,
      );
      this._emergencyCloseAll(state, 'daily_loss_limit').catch(e =>
        console.error(`[UniExecV2] daily loss emergency close error pair ${state.pairId}: ${e.message}`),
      );
    }

    pos.status = 'closed';
    state.openPositions = state.openPositions.filter((p) => p !== pos);
    this._broadcastState(state.pairId);
    return true;
  }

  /** Fresh get_order_state (bypasses deribitorderStatus cache) — avoids stale state after restart. */
  async _getOrderStateFresh(state, orderId) {
    if (!orderId) return { state: 'not_found', avgPrice: null, filledQty: 0 };
    try {
      const r = await signedRequest(
        `/api/v2/private/get_order_state?order_id=${encodeURIComponent(orderId)}`,
        state.clientA.apiKey,
        state.clientA.secretKey
      );
      const o = r?.result;
      if (!o) return { state: 'not_found', avgPrice: null, filledQty: 0 };
      const ord = Array.isArray(o) ? o[0] : o;
      const st = (ord.order_state || '').toLowerCase();
      const avg = parseFloat(ord.average_price || ord.price || 0) || null;
      const fq = parseFloat(ord.filled_amount || 0);
      return { state: st, avgPrice: avg, filledQty: fq };
    } catch (e) {
      const code = e?.deribitErrorCode ?? e?.response?.data?.error?.code;
      const msg = String(e?.message || '');
      if (code === 10004 || msg.includes('order_not_found')) return { state: 'not_found', avgPrice: null, filledQty: 0 };
      return { state: 'error', avgPrice: null, filledQty: 0 };
    }
  }

  async _fillsForOrderId(state, orderId) {
    if (!orderId) return [];
    try {
      const resp = await signedRequest(
        `/api/v2/private/get_user_trades_by_order?order_id=${encodeURIComponent(orderId)}`,
        state.clientA.apiKey,
        state.clientA.secretKey
      );
      return Array.isArray(resp?.result) ? resp.result : [];
    } catch (_) {
      return [];
    }
  }

  _avgPriceFromFills(fills) {
    if (!fills || fills.length === 0) return null;
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
    return sumAmt > 0 ? parseFloat((sumPxAmt / sumAmt).toFixed(8)) : null;
  }

  /**
   * Poll-friendly order status: retries transient errors, resolves not_found via fills
   * (filled orders often disappear from get_order_state shortly after fill).
   */
  async _orderStatus(state, orderId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this._getOrderStateFresh(state, orderId);
      if (raw.state === 'error') {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (raw.state === 'filled') {
        let px = raw.avgPrice;
        if (!px) {
          const fills = await this._fillsForOrderId(state, orderId);
          px = this._avgPriceFromFills(fills);
        }
        if (px) return { status: 'filled', filledPrice: px };
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (raw.state === 'cancelled' || raw.state === 'canceled' || raw.state === 'rejected') {
        return { status: 'cancelled', filledPrice: null };
      }
      if (raw.state === 'not_found') {
        const fills = await this._fillsForOrderId(state, orderId);
        const ap = this._avgPriceFromFills(fills);
        if (ap) return { status: 'filled', filledPrice: ap };
        return { status: 'cancelled', filledPrice: null };
      }
      return { status: 'open', filledPrice: null };
    }
    return { status: 'unknown', filledPrice: null };
  }

  /**
   * After restart: poll the exchange until an order reaches a terminal state or max wait.
   * Returns { kind: 'filled'|'open'|'dead', price? }.
   */
  async _waitOrderSettled(state, orderId, maxWaitMs = 120000, intervalMs = 400) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const raw = await this._getOrderStateFresh(state, orderId);
      if (raw.state === 'error') {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      if (raw.state === 'filled') {
        let px = raw.avgPrice;
        if (!px) {
          const fills = await this._fillsForOrderId(state, orderId);
          px = this._avgPriceFromFills(fills);
        }
        if (px) return { kind: 'filled', price: px };
      }
      if (raw.state === 'cancelled' || raw.state === 'canceled' || raw.state === 'rejected') {
        return { kind: 'dead', price: null };
      }
      if (raw.state === 'not_found') {
        const fills = await this._fillsForOrderId(state, orderId);
        const ap = this._avgPriceFromFills(fills);
        if (ap) return { kind: 'filled', price: ap };
        return { kind: 'dead', price: null };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const last = await this._getOrderStateFresh(state, orderId);
    if (last.state === 'open' || last.state === 'untriggered' || last.state === 'partially_filled') {
      return { kind: 'open', price: last.avgPrice };
    }
    return { kind: 'open', price: null };
  }

  /**
   * Polls Deribit for pending_entry / in-flight exit rows after a process restart
   * so we never mark a filled order as failed or lose an exit fill.
   * Pushes resumed entry/exit polling targets into `resume`.
   */
  async _bootstrapEntryAndExitOrders(state, pairId, pair, levels, resume) {
    const { Op } = require('sequelize');
    const candidates = await BasisPosition.findAll({
      where: {
        pairId,
        state: { [Op.in]: ['pending_entry', 'pending_exit', 'open'] },
      },
      order: [['id', 'ASC']],
    });
    const work = candidates.filter((bp) =>
      bp.state === 'pending_entry' ||
      bp.state === 'pending_exit' ||
      (bp.state === 'open' && bp.legA_exitOrderId)
    );
    const isLegB = (pair.tradeLeg || 'A').toUpperCase() === 'B';

    for (const bp of work) {
      if (bp.state === 'pending_entry') {
        if (!bp.legA_entryOrderId) {
          await BasisPosition.update(
            { state: 'failed', reconcileNote: 'bootstrap_no_entry_order_id' },
            { where: { id: bp.id } }
          ).catch(() => {});
          continue;
        }
        const settled = await this._waitOrderSettled(state, bp.legA_entryOrderId);
        if (settled.kind === 'filled' && settled.price) {
          const ob1 = state.lastOrderbooks?.leg1;
          const ob2 = state.lastOrderbooks?.leg2;
          const refPrice = isLegB
            ? parseFloat(ob1?.asks?.[0]?.price || bp.legB_entryPrice || 0)
            : parseFloat(ob2?.bids?.[0]?.price || bp.legB_entryPrice || 0);
          const ref = refPrice || parseFloat(bp.legB_entryPrice || 0);
          const fillSpread = isLegB
            ? parseFloat((ref - settled.price).toFixed(4))
            : parseFloat((settled.price - ref).toFixed(4));
          const entryCommission = await this._getOrderCommissionUsd(state, bp.legA_entryOrderId, settled.price);
          await Trade.update({
            status: 'filled',
            legA_price: settled.price,
            legA_filledAt: new Date(),
            legB_price: ref || null,
            legB_filledAt: ref ? new Date() : null,
            commission: entryCommission,
          }, { where: { id: bp.entryTradeId } }).catch(() => {});
          await BasisPosition.update({
            state: 'open',
            legA_entryPrice: settled.price,
            legB_entryPrice: ref || bp.legB_entryPrice,
            legA_entryOrderId: bp.legA_entryOrderId,
            reconciledAt: new Date(),
            reconcileNote: 'bootstrap_entry_promoted',
          }, { where: { id: bp.id } }).catch(() => {});
          console.log(`[UniExecV2] pair ${pairId} bootstrap: pending_entry #${bp.id} → open @ ${settled.price}`);
          continue;
        }
        if (settled.kind === 'dead') {
          await Trade.update(
            { status: 'cancelled', cancelReason: 'bootstrap_entry_order_dead' },
            { where: { id: bp.entryTradeId } }
          ).catch(() => {});
          await BasisPosition.update(
            { state: 'failed', reconcileNote: 'bootstrap_entry_order_dead' },
            { where: { id: bp.id } }
          ).catch(() => {});
          console.log(`[UniExecV2] pair ${pairId} bootstrap: pending_entry #${bp.id} → failed (order dead)`);
          continue;
        }
        resume.entries.push({
          id: `resume_entry_${bp.id}`,
          status: 'pending_entry',
          gridLevel: bp.gridLevel,
          level: levels[(bp.gridLevel || 1) - 1] ?? 0,
          qty: bp.legA_entryQty ?? pair.qty1,
          entryOrderId: bp.legA_entryOrderId,
          entryTradeId: bp.entryTradeId,
          basisPositionId: bp.id,
          entrySignalSpread: bp.entrySpread ?? 0,
          entryPriceA: null,
          entryPriceB: null,
          fillSpread: null,
          bestSpread: null,
          openedAt: null,
          entryCommissionUsd: null,
          entryZScore: null,
          profitTicks: 0,
          stopTicks: 0,
          timeExitTicks: 0,
          pollTimer: null,
          pollStart: Date.now(),
          exitOrderId: null,
          exitTradeId: null,
          _repriced: false,
        });
        console.log(`[UniExecV2] pair ${pairId} bootstrap: pending_entry #${bp.id} still open — resuming poll`);
        continue;
      }

      // pending_exit or open with exit order in flight
      if (!bp.legA_exitOrderId) continue;
      const settled = await this._waitOrderSettled(state, bp.legA_exitOrderId);
      if (settled.kind === 'filled' && settled.price) {
        await this._finalizeBootstrapExitFill(state, pair, bp, settled.price);
        continue;
      }
      if (settled.kind === 'dead') {
        await BasisPosition.update({
          state: 'open',
          legA_exitOrderId: null,
          exitTradeId: null,
          exitReason: null,
          reconciledAt: new Date(),
          reconcileNote: 'bootstrap_exit_order_cleared',
        }, { where: { id: bp.id } }).catch(() => {});
        console.log(`[UniExecV2] pair ${pairId} bootstrap: cleared ghost exit on #${bp.id}`);
        continue;
      }
      resume.exits.push(this._memoryPosFromDbRow(bp, pair, levels, 'pending_exit'));
      console.log(`[UniExecV2] pair ${pairId} bootstrap: exit still open on #${bp.id} — resuming poll`);
    }
  }

  _memoryPosFromDbRow(p, pair, levels, statusOverride) {
    const hasExit = !!p.legA_exitOrderId;
    const status = statusOverride || (hasExit ? 'pending_exit' : 'open');
    return {
      id: `reload_${p.id}`,
      status,
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
      entryZScore: p.entryZScore != null ? parseFloat(p.entryZScore) : null,
      profitTicks: 0,
      stopTicks: 0,
      timeExitTicks: 0,
      pollTimer: null,
      pollStart: Date.now(),
      exitOrderId: p.legA_exitOrderId || null,
      exitTradeId: p.exitTradeId || null,
      exitReason: p.exitReason || 'profit',
      _repriced: false,
    };
  }

  async _finalizeBootstrapExitFill(state, pair, bp, exitPriceA) {
    const isLegB = (pair.tradeLeg || 'A').toUpperCase() === 'B';
    const isLinear = this._isLinearUsdc(state);
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const refPrice = isLegB
      ? parseFloat(ob1?.bids?.[0]?.price || bp.legB_entryPrice || 0)
      : parseFloat(ob2?.bids?.[0]?.price || bp.legB_entryPrice || 0);
    const entryPx = parseFloat(bp.legA_entryPrice || 0);
    const qty = parseFloat(bp.legA_entryQty || 0);
    const exitSpread = isLegB
      ? parseFloat((refPrice - exitPriceA).toFixed(4))
      : parseFloat((exitPriceA - refPrice).toFixed(4));
    let grossPnl;
    if (isLinear) {
      grossPnl = isLegB
        ? parseFloat((qty * (exitPriceA - entryPx)).toFixed(6))
        : parseFloat((qty * (entryPx - exitPriceA)).toFixed(6));
    } else {
      const pnlBtc = isLegB
        ? parseFloat((qty * (1 / entryPx - 1 / exitPriceA)).toFixed(8))
        : parseFloat((qty * (1 / exitPriceA - 1 / entryPx)).toFixed(8));
      grossPnl = parseFloat((pnlBtc * exitPriceA).toFixed(6));
    }
    const entryTrade = await Trade.findByPk(bp.entryTradeId).catch(() => null);
    const entryComm = entryTrade?.commission != null ? parseFloat(entryTrade.commission) : 0;
    const exitCommission = await this._getOrderCommissionUsd(state, bp.legA_exitOrderId, exitPriceA);
    const totalCommission = parseFloat(((entryComm + (exitCommission || 0))).toFixed(6));
    const netPnl = parseFloat((grossPnl + totalCommission).toFixed(6));
    const now = new Date();

    await Trade.update({
      status: 'filled',
      legA_price: exitPriceA,
      legA_filledAt: now,
      legB_price: refPrice,
      legB_filledAt: now,
      spreadAtExit: exitSpread,
      legA_pnl: grossPnl,
      legB_pnl: 0,
      pnl: netPnl,
      commission: exitCommission,
    }, { where: { id: bp.exitTradeId } }).catch(() => {});

    await BasisPosition.update({
      state: 'closed',
      legA_exitPrice: exitPriceA,
      legB_exitPrice: refPrice,
      legA_exitOrderId: bp.legA_exitOrderId,
      exitTime: now,
      holdMs: bp.entryTime ? now.getTime() - new Date(bp.entryTime).getTime() : 0,
      exitSpread,
      spreadChange: parseFloat((exitSpread - (bp.entrySpread || 0)).toFixed(4)),
      legA_pnl: grossPnl,
      legB_pnl: 0,
      grossPnl,
      commission: totalCommission,
      takerFeeUsd: 0,
      netPnl,
      exitReason: bp.exitReason || 'bootstrap_exit_filled',
      reconciledAt: now,
      reconcileNote: 'bootstrap_exit_filled',
    }, { where: { id: bp.id } }).catch(() => {});

    state.dailyPnl = parseFloat(((state.dailyPnl || 0) + netPnl).toFixed(6));
    console.log(`[UniExecV2] pair ${state.pairId} bootstrap: closed #${bp.id} exit fill @ ${exitPriceA} netPnl=${netPnl}`);
  }


  _estimateGrossPnlUsd(isLegB, qty, entryPx, exitPx, isLinear = false) {
    if (!qty || !entryPx || !exitPx || entryPx <= 0 || exitPx <= 0) return 0;
    if (isLinear) {
      return parseFloat((isLegB ? qty * (exitPx - entryPx) : qty * (entryPx - exitPx)).toFixed(6));
    }
    const pnlBtc = isLegB
      ? qty * (1 / entryPx - 1 / exitPx)
      : qty * (1 / exitPx - 1 / entryPx);
    return parseFloat((pnlBtc * exitPx).toFixed(6));
  }

  async _getOrderCommissionUsd(state, orderId, fallbackPrice) {
    if (!orderId) return null;
    try {
      const resp  = await signedRequest(
        `/api/v2/private/get_user_trades_by_order?order_id=${orderId}`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const fills = Array.isArray(resp?.result) ? resp.result : [];
      if (fills.length === 0) return null;
      let totalUsd = 0;
      for (const f of fills) {
        const fee = Number(f?.fee ?? 0);
        if (!Number.isFinite(fee)) continue;
        const feeCurrency = String(f?.fee_currency || '').toUpperCase();
        const px = Number(f?.price ?? fallbackPrice ?? 0);
        // Deribit: fee < 0 = maker rebate (income). Negate so positive = income.
        if ((feeCurrency === 'BTC' || feeCurrency === 'ETH') && px > 0) totalUsd += -fee * px;
        else totalUsd += -fee;
      }
      return Number.isFinite(totalUsd) ? parseFloat(totalUsd.toFixed(6)) : null;
    } catch (_) {
      return null;
    }
  }

  _parseLevels(pair) {
    return String(pair.spreadEntryLevels || '')
      .split(',')
      .map(x => parseFloat(x))
      .filter(x => Number.isFinite(x) && x > 0)
      .sort((a, b) => a - b);
  }

  _computeLevelQty(pair, levels) {
    const totalWeight = levels.reduce((a, b) => a + b, 0) || 1;
    const sym = pair.symbol1 || '';
    if (sym.includes('_USDC')) {
      return levels.map(lvl => Math.max(0.1, Math.round((pair.qty1 * lvl / totalWeight) * 10) / 10));
    }
    return levels.map(lvl => Math.max(10, Math.round((pair.qty1 * lvl) / totalWeight / 10) * 10));
  }

  // ── enable / disable ────────────────────────────────────────────────────────
  async enableTrading(pairId) {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return { success: false, message: 'Pair not found' };
    const levels = this._parseLevels(pair);
    if (levels.length === 0) return { success: false, message: 'Invalid spreadEntryLevels' };
    const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
    if (!acc) return { success: false, message: `Account not found: ${pair.tradeAccountA}` };
    const clientA = await getApiCredentials(acc);

    let state = this.pairs.get(pairId);
    if (!state) { state = new UniStateV2(pairId); this.pairs.set(pairId, state); }

    state._botStartBalance  = pair.botStartBalance ?? null;
    state.enabled           = true;
    // Use botStartedAt from DB so uptime is continuous across pm2 restarts.
    state.enabledAt         = pair.botStartedAt ? new Date(pair.botStartedAt).getTime() : Date.now();
    // Track the wall-clock time this enable() call was made — used by idle alert
    // so re-enabling gives a fresh 120-min grace window (not measured from old botStartedAt).
    state._enabledThisSessionAt = Date.now();
    state.pair              = pair;
    state.clientA           = clientA;
    state.levels            = levels;
    state.levelQty          = this._computeLevelQty(pair, levels);
    let tp = pair.tpSpreadDelta != null ? parseFloat(pair.tpSpreadDelta) : 20;
    if (!Number.isFinite(tp) || tp <= 0) tp = 20;
    state.tpSpreadDelta = tp;
    let sl = pair.slSpreadDelta != null ? parseFloat(pair.slSpreadDelta) : 35;
    if (!Number.isFinite(sl) || sl <= 0) sl = 35;
    state.slSpreadDelta     = this._isLinearUsdc(state) ? sl : Math.max(sl, 12);
    state.entryTimeoutMs    = pair.entryPollTimeoutMs != null ? parseInt(pair.entryPollTimeoutMs) : ENTRY_TIMEOUT_MS;
    state.tradeLeg          = (pair.tradeLeg || 'A').toUpperCase() === 'B' ? 'B' : 'A';
    state.tradeSymbol       = state.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
    state.prevSignalSpread  = null;
    state._entryInFlight    = false;
    const dll = pair.dailyLossLimitUsd != null ? parseFloat(pair.dailyLossLimitUsd) : 0;
    state.dailyLossLimitUsd = Number.isFinite(dll) && dll > 0 ? dll : 0;
    const mdd = pair.maxDrawdownUsd != null ? parseFloat(pair.maxDrawdownUsd) : 0;
    state.maxDrawdownUsd    = Number.isFinite(mdd) && mdd > 0 ? mdd : 0;
    const ddPct = pair.drawdownPct != null ? parseFloat(pair.drawdownPct) : 0;
    state.drawdownPct       = Number.isFinite(ddPct) && ddPct > 0 ? ddPct : 0;
    state._peakEquity       = null;
    state._currentEquity    = null;
    state._currentDrawdownUsd = 0;
    state._currentDrawdownPct = 0;
    state._killSwitchTriggered = false;
    state._priceRangeTriggered = false;
    state._priceUpperLimit = pair.priceUpperLimit != null ? parseFloat(pair.priceUpperLimit) : null;
    state._priceLowerLimit = pair.priceLowerLimit != null ? parseFloat(pair.priceLowerLimit) : null;
    try {
      state._optionInstruments = pair.optionInstruments ? JSON.parse(pair.optionInstruments) : [];
    } catch { state._optionInstruments = []; }
    const optTarget = pair.optionProfitTargetUsd != null ? parseFloat(pair.optionProfitTargetUsd) : 0;
    state._optionProfitTargetUsd = Number.isFinite(optTarget) && optTarget > 0 ? optTarget : 0;
    state._optionProfitTriggered = false;
    state._lastOptionPnlUsd = null;

    // Reload positions from DB (poll exchange until orders settle — same as V1)
    try {
      const resume = { entries: [], exits: [] };
      await this._bootstrapEntryAndExitOrders(state, pairId, pair, levels, resume);

      const openRows = await BasisPosition.findAll({
        where: { pairId, state: 'open' },
        order: [['id', 'ASC']],
      });
      state.openPositions = [];
      for (const pos of resume.entries) {
        state.openPositions.push(pos);
        this._pollEntry(state, pos);
      }
      for (const p of openRows) {
        const mem = this._memoryPosFromDbRow(p, pair, levels, null);
        state.openPositions.push(mem);
        if (mem.status === 'pending_exit') this._pollExit(state, mem);
      }
      for (const pos of resume.exits) {
        state.openPositions.push(pos);
        this._pollExit(state, pos);
      }
      for (const mem of state.openPositions) {
        if (!mem.entryTradeId) continue;
        const t = await Trade.findByPk(mem.entryTradeId).catch(() => null);
        if (t && t.commission != null) mem.entryCommissionUsd = parseFloat(t.commission);
      }
      state.filledQty = state.openPositions
        .filter((mem) => mem.status === 'open' || mem.status === 'pending_exit')
        .reduce((s, mem) => s + Math.abs(parseFloat(mem.qty || 0)), 0);
      if (state.openPositions.length > 0) {
        console.log(
          `[UniExecV2] pair ${pairId} reloaded ${state.openPositions.length} position(s) ` +
          `(resume entry=${resume.entries.length} exit=${resume.exits.length}, dbRows=${openRows.length})`
        );
      }
    } catch (e) {
      console.warn(`[UniExecV2] pair ${pairId} reload positions failed: ${e.message}`);
      state.openPositions = [];
    }

    this._broadcastState(pairId);
    this._refreshAccountInfo(state).catch(() => {});
    if (state._accountRefreshTimer) clearInterval(state._accountRefreshTimer);
    state._accountRefreshTimer = setInterval(() => this._refreshAccountInfo(state).catch(() => {}), 30_000);

    this._saveLevelHistory(pairId, {
      changedBy: 'enable', prevLevels: null, prevTp: null, prevSl: null, prevCap: null,
      newLevels: state.levels, newTp: state.tpSpreadDelta, newSl: state.slSpreadDelta,
      newCap: pair.maxSpreadCap ?? null, dollarMean: null, dollarStd: null,
      openPositions: state.openPositions.length, tpSlUpdated: true,
    });

    console.log(`[UniExecV2] pair ${pairId} enabled (tradeLeg=${state.tradeLeg}, levels=[${levels.join(',')}])`);
    btcAnalysisHook.onEnable(pair);
    return { success: true, message: `V2 trading enabled (tradeLeg=${state.tradeLeg})`, pairId };
  }

  async disableTrading(pairId) {
    const state = this.pairs.get(pairId);
    if (!state || !state.enabled) return { success: false, message: 'Trading not enabled' };
    state.enabled = false;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }
    const raceFilled = [];
    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      if (pos.entryOrderId) {
        const r = await this._cancel(state, pos.entryOrderId);
        if (r && r.raceHandled && r.role === 'entry') {
          raceFilled.push({ posId: pos.id, orderId: pos.entryOrderId, role: 'entry' });
        }
      }
      if (pos.exitOrderId) await this._cancel(state, pos.exitOrderId);
    }
    state.openPositions = [];
    this._broadcastState(pairId);

    if (raceFilled.length > 0) {
      const lines = raceFilled
        .map((r) => `• pos ${r.posId} — ${r.role} order ${r.orderId}`)
        .join('\n');
      console.error(
        `[UniExecV2] pair ${pairId} DISABLE race: ${raceFilled.length} entry order(s) filled during cancel. ` +
        `Manual close on exchange required.\n${lines}`,
      );
      _sendTelegramAlert(
        `⚠️ <b>RACE FILL ON DISABLE (V2)</b>\n\n` +
        `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
        `Entry order(s) filled while we were cancelling:\n${lines}\n\n` +
        `Bot has been disabled but <b>position(s) remain OPEN on exchange</b>. ` +
        `Manual close required.`,
      );
    }
    btcAnalysisHook.onDisable(state.pair);
    return { success: true, message: 'V2 trading disabled' };
  }

  // ── state / account ─────────────────────────────────────────────────────────
  getState(pairId) {
    const state = this.pairs.get(pairId);
    if (!state) return { pairId, enabled: false, state: 'IDLE', executorVersion: 'v2' };
    return {
      pairId,
      executorVersion:    'v2',
      enabled:            !!state.enabled,
      enabledAt:          state.enabledAt,
      state:              state.openPositions.some(p => p.status === 'open') ? 'POSITION_OPEN' : 'IDLE',
      filledQty:          state.filledQty,
      tpSpreadDelta:      state.tpSpreadDelta,
      slSpreadDelta:      state.slSpreadDelta,
      dailyPnl:           parseFloat((state.dailyPnl || 0).toFixed(4)),
      dailyLossLimitUsd:  state.dailyLossLimitUsd || 0,
      dailyLossHit:       state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd,
      maxDrawdownUsd:     state.maxDrawdownUsd || 0,
      currentDrawdownUsd: state._currentDrawdownUsd || 0,
      peakEquity:         state._peakEquity,
      currentEquity:      state._currentEquity,
      drawdownPct:        state.drawdownPct || 0,
      currentDrawdownPct: state._currentDrawdownPct || 0,
      killSwitchTriggered: !!state._killSwitchTriggered,
      optionPnlUsd: state._lastOptionPnlUsd,
      optionProfitTargetUsd: state._optionProfitTargetUsd || 0,
      optionProfitTriggered: !!state._optionProfitTriggered,
      maxPositions:       state.pair?.maxPositions != null ? parseInt(state.pair.maxPositions) : 1,
      maxSpreadCap:       state._adaptedMaxSpreadCap ?? (state.pair?.maxSpreadCap ?? null),
      adaptedAt:          state._adaptedAt,
      adaptedLevels:      state._adaptedAt ? state.levels : null,
      // V2 extras
      dollarMean:         state._dollarMean,
      dollarStd:          state._dollarStd,
      regimeBlocked:      state._regimeBlocked,
      positions: state.openPositions.filter(p => p.status === 'open').map(p => ({
        gridLevel:    p.gridLevel,
        fillSpread:   p.fillSpread,
        bestSpread:   p.bestSpread,
        entryZScore:  p.entryZScore,
        profitTicks:  p.profitTicks,
        stopTicks:    p.stopTicks,
        holdSec:      p.openedAt ? Math.round((Date.now() - p.openedAt) / 1000) : 0,
      })),
    };
  }

  getAccountInfo(pairId) {
    const state = this.pairs.get(pairId);
    if (!state) return null;
    return {
      balance:      state._cachedBalance ?? null,
      startBalance: state._botStartBalance ?? state._startBalance ?? null,
      currency:     this._settlementCurrency(state),
      positions:    state._livePositions || [],
      openOrders:   state._openOrders   || [],
      feeLevel:     state._feeLevel     ?? null,
      makerRebate:  state._makerRebate  ?? null,
    };
  }

  async _refreshAccountInfo(state) {
    if (!state.clientA) return;
    try {
      const pairId = state.pairId;
      const ccy    = this._settlementCurrency(state);
      const resp   = await signedRequest(
        `/api/v2/private/get_account_summary?currency=${ccy}&extended=true`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const acct = resp?.result;
      if (!acct) return;
      state._cachedBalance = acct.balance;
      state._feeLevel      = acct.fee_level;
      const equity         = acct.equity != null ? acct.equity : acct.balance;
      state._currentEquity = equity;
      if (state._startBalance == null && (acct.equity ?? acct.balance) != null) {
        // Save equity (net asset value = wallet + unrealized PnL) not just wallet balance
        const startEquity = acct.equity ?? acct.balance;
        state._startBalance = startEquity;
        StatArbInput.update({ sessionStartBalance: startEquity }, { where: { id: pairId } }).catch(() => {});
        StatArbInput.update(
          { botStartBalance: startEquity, botStartedAt: new Date() },
          { where: { id: pairId, botStartBalance: null } }
        ).catch(() => {});
        console.log(`[UniExecV2] pair ${pairId} session start equity: ${startEquity} ${ccy}`);
      }
      if (equity != null) {
        if (state._peakEquity == null || equity > state._peakEquity) state._peakEquity = equity;
        if (state._peakEquity != null && state.maxDrawdownUsd > 0)
          this._checkDrawdownKillSwitch(state, acct).catch(() => {});
      }
      if (state.drawdownPct > 0 && acct.balance != null)
        this._checkBalanceDrawdown(state, acct.balance).catch(() => {});
      if (state._optionProfitTargetUsd > 0 && !state._optionProfitTriggered) {
        this._checkOptionProfitTakeProfit(state).catch(e =>
          console.error(`[UniExecV2] option profit TP check error pair ${pairId}: ${e.message}`)
        );
      }

      // ── Idle alert: no trade for > 120 min ──────────────────────────
      this._checkIdleAlert(state);

      const [posResp, ordersResp] = await Promise.all([
        signedRequest(`/api/v2/private/get_positions?currency=${ccy}&kind=future`,
          state.clientA.apiKey, state.clientA.secretKey),
        signedRequest(`/api/v2/private/get_open_orders_by_currency?currency=${ccy}`,
          state.clientA.apiKey, state.clientA.secretKey).catch(() => null),
      ]);
      state._livePositions = (Array.isArray(posResp?.result) ? posResp.result : [])
        .filter(p => p.size !== 0)
        .map(p => ({ instrument: p.instrument_name, direction: p.direction, size: p.size,
                     avgPrice: p.average_price, unrealizedPnl: p.floating_profit_loss }));
      state._openOrders = (Array.isArray(ordersResp?.result) ? ordersResp.result : [])
        .map(o => ({ orderId: String(o.order_id || ''), instrument: o.instrument_name || '',
                     direction: o.direction || '', amount: parseFloat(o.amount ?? 0),
                     price: parseFloat(o.price ?? 0), filledAmount: parseFloat(o.filled_amount ?? 0),
                     orderType: o.order_type || 'limit', label: o.label || '' }));
      try {
        const { sequelize } = require('../models');
        // commission is stored in USD by _getOrderCommissionUsd (fee × price for all currencies)
        const [[row]] = await sequelize.query(
          `SELECT COALESCE(SUM(commission),0) AS total
           FROM trade_logs WHERE pairId=:p AND status='filled' AND commission>0`,
          { replacements: { p: pairId } }
        );
        state._makerRebate = parseFloat(Math.abs(row.total).toFixed(4));
      } catch (_) {}
      try {
        require('./orderbookStreams').broadcast({ type: 'account_info', pairId, ...this.getAccountInfo(pairId) });
      } catch (_) {}
    } catch (e) {
      console.warn(`[UniExecV2] _refreshAccountInfo pair ${state.pairId}: ${e.message}`);
    }
  }

  // ── idle alert (no trade > 120 min) ─────────────────────────────────────────
  _checkIdleAlert(state) {
    if (!state.enabled || state._killSwitchTriggered) return;
    const IDLE_MS      = 120 * 60 * 1000;   // 120 minutes
    const REPEAT_MS    = 60  * 60 * 1000;   // re-alert every 60 min if still idle
    const now          = Date.now();
    // Use lastEntryAt if a trade happened this session.
    // Otherwise use _enabledThisSessionAt (the moment enable() was called this run)
    // so re-enabling the bot always gives a fresh 120-min grace window.
    const refTime = state.lastEntryAt > 0
      ? state.lastEntryAt
      : (state._enabledThisSessionAt || now);
    const idleMs       = now - refTime;
    if (idleMs < IDLE_MS) {
      state._idleAlertSentAt = 0;           // reset once bot is active again
      return;
    }
    if (state._idleAlertSentAt > 0 && (now - state._idleAlertSentAt) < REPEAT_MS) return;
    state._idleAlertSentAt = now;
    const idleMin = Math.round(idleMs / 60000);
    const since   = state.lastEntryAt > 0
      ? new Date(state.lastEntryAt).toUTCString()
      : 'bot start';
    console.warn(`[UniExecV2] ⚠ IDLE ALERT pair ${state.pairId} — no trade for ${idleMin}m`);
    _sendTelegramAlert(
      `⚠️ <b>BOT IDLE ALERT (V2)</b>\n\n` +
      `Pair: <b>${state.pairId}</b> (${state.pair?.agentName || ''})\n` +
      `No trade for: <b>${idleMin} minutes</b>\n` +
      `Last entry: ${since}\n` +
      `Spread mean: $${(state._dollarMean || 0).toFixed(2)}  ` +
        `std: $${(state._dollarStd || 0).toFixed(2)}\n` +
      `Entry level L1: $${(state.levels?.[0] || 0).toFixed(2)}\n` +
      `tradingEnabled: ${state.enabled}\n` +
      `Time: ${new Date().toUTCString()}`
    );
  }

  // ── drawdown kill switches ───────────────────────────────────────────────────
  async _checkDrawdownKillSwitch(state, acct) {
    if (!state.enabled || state._killSwitchTriggered) return;
    if (state.maxDrawdownUsd <= 0 || state._peakEquity == null) return;
    const drawdownSettlement = state._peakEquity - state._currentEquity;
    if (drawdownSettlement <= 0) { state._currentDrawdownUsd = 0; return; }
    let drawdownUsd;
    if (this._isLinearUsdc(state)) {
      drawdownUsd = drawdownSettlement;
    } else {
      let btcPrice = (acct?.equity > 0 && acct?.estimated_balance != null)
        ? acct.estimated_balance / acct.equity : 0;
      if (!btcPrice) {
        const ob1 = state.lastOrderbooks?.leg1;
        const bid = parseFloat(ob1?.bids?.[0]?.price || 0);
        const ask = parseFloat(ob1?.asks?.[0]?.price || 0);
        btcPrice = bid && ask ? (bid + ask) / 2 : 0;
      }
      if (!btcPrice) return;
      drawdownUsd = drawdownSettlement * btcPrice;
    }
    state._currentDrawdownUsd = parseFloat(drawdownUsd.toFixed(2));
    if (drawdownUsd >= state.maxDrawdownUsd) {
      state._killSwitchTriggered = true;
      console.error(`[UniExecV2] *** DRAWDOWN KILL SWITCH *** pair ${state.pairId} | $${drawdownUsd.toFixed(2)} >= limit=$${state.maxDrawdownUsd}`);
      await this._emergencyCloseAll(state, 'drawdown_kill_switch');
    }
  }

  async _checkBalanceDrawdown(state, currentBalance) {
    if (!state.enabled || state._killSwitchTriggered) return;
    if (state.drawdownPct <= 0) return;
    const startBalance = state._botStartBalance ?? state._startBalance;
    if (startBalance == null || startBalance <= 0) return;
    const dropPct = ((startBalance - currentBalance) / startBalance) * 100;
    state._currentDrawdownPct = parseFloat(Math.max(0, dropPct).toFixed(4));
    if (dropPct >= state.drawdownPct) {
      state._killSwitchTriggered = true;
      console.error(`[UniExecV2] *** BALANCE DRAWDOWN *** pair ${state.pairId} | ${dropPct.toFixed(2)}% >= ${state.drawdownPct}%`);
      await this._emergencyCloseAll(state, 'balance_drawdown_kill_switch');
    }
  }

  async _emergencyCloseAll(state, reason) {
    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      // If cancel races a fill, _cancel routes through _onEntryFilled /
      // _onExitFilled: race-filled entries become pos.status='open' (picked up
      // below for _startExit); race-filled exits are removed from openPositions.
      if (pos.entryOrderId) await this._cancel(state, pos.entryOrderId).catch(() => {});
      if (pos.exitOrderId)  await this._cancel(state, pos.exitOrderId).catch(() => {});
    }
    const openPositions = state.openPositions.filter(p => p.status === 'open' && p.entryPriceA);
    for (const pos of openPositions) {
      try { await this._startExit(state, pos, reason); } catch (e) {
        console.error(`[UniExecV2] Emergency exit failed pos ${pos.id}: ${e.message}`);
      }
    }
    state.enabled = false;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }
    await StatArbInput.update(
      { tradingEnabled: false, lastStopReason: reason, lastDisabledAt: new Date() },
      { where: { id: state.pairId } }
    ).catch(() => {});
    this._broadcastState(state.pairId);

    const reasonLabels = {
      drawdown_kill_switch: '📉 Drawdown Kill Switch',
      balance_drawdown_kill_switch: '📉 Balance Drawdown Kill Switch',
      option_profit_take_profit: '💰 Option Profit Take-Profit',
      daily_loss_limit: '📊 Daily Loss Limit',
      price_range_upper: '⬆️ Price Upper Limit',
      price_range_lower: '⬇️ Price Lower Limit',
    };
    const label = reasonLabels[reason] || reason;
    _sendTelegramAlert(
      `🛑 <b>BOT STOPPED (V2)</b>\n\n` +
      `Pair: <b>${state.pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Reason: <b>${label}</b>\n` +
      `Open positions closed: ${openPositions.length}\n` +
      `Time: ${new Date().toUTCString()}`
    );
  }

  async _checkPriceRangeKillSwitch(state, btcPrice) {
    if (!state.enabled || state._killSwitchTriggered || state._priceRangeTriggered) return;
    if (state._priceUpperLimit == null && state._priceLowerLimit == null) return;
    if (!btcPrice || btcPrice <= 0) return;

    const upperHit = state._priceUpperLimit != null && btcPrice >= state._priceUpperLimit;
    const lowerHit = state._priceLowerLimit != null && btcPrice <= state._priceLowerLimit;

    if (!upperHit && !lowerHit) return;

    state._priceRangeTriggered = true;
    state._killSwitchTriggered = true;
    const direction = upperHit ? 'UPPER' : 'LOWER';
    const limit = upperHit ? state._priceUpperLimit : state._priceLowerLimit;
    const arrow = upperHit ? '⬆️' : '⬇️';
    console.error(
      `[UniExecV2] *** PRICE RANGE KILL SWITCH *** pair ${state.pairId} | ` +
      `price=$${btcPrice.toFixed(2)} hit ${direction} limit=$${limit} | ` +
      `closing perps ONLY — options preserved for later PnL target`
    );

    // Pre-close alert so the user knows WHY the bot is about to stop,
    // and that options are intentionally NOT being touched.
    _sendTelegramAlert(
      `${arrow} <b>PRICE BAND HIT — BOT STOPPING</b>\n\n` +
      `Pair: <b>${state.pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Price: <b>$${btcPrice.toFixed(2)}</b>\n` +
      `Band: <b>${direction}</b> ($${limit})\n\n` +
      `Action:\n` +
      `• Cancelling orders + closing open perps\n` +
      `• Options <b>preserved</b> — will auto-close at net PnL ≥ $${state._optionProfitTargetUsd} (limit orders)\n` +
      `• Bot disabled until manually re-enabled\n\n` +
      `Time: ${new Date().toUTCString()}`
    );

    await this._emergencyCloseAll(state, `price_range_${direction.toLowerCase()}`);
    // NOTE: _closeOptionPositions is intentionally NOT called here.
    // Options stay open and are closed only by _checkOptionProfitTakeProfit
    // when net unrealized PnL hits optionProfitTargetUsd (via limit orders).
  }

  async _closeOptionPositions(state) {
    if (!state.clientA) return;
    const pairId = state.pairId;
    console.log(`[UniExecV2] Closing option positions for pair ${pairId}...`);

    try {
      const ccy = _optionCurrency(state);
      const optPositions = await signedRequest(
        `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const liveOptions = (optPositions?.result || []).filter(p => p.size !== 0);

      if (liveOptions.length === 0) {
        console.log(`[UniExecV2] No open option positions to close for pair ${pairId}`);
        return;
      }

      const tracked = new Set(state._optionInstruments.map(o => o.name));

      for (const pos of liveOptions) {
        if (tracked.size > 0 && !tracked.has(pos.instrument_name)) continue;

        const closeSize = Math.abs(pos.size);
        const closeSide = pos.size > 0 ? 'sell' : 'buy';

        // Fetch current order book to place a marketable LIMIT (user mandate:
        // no market orders on options). Sells hit the best bid, buys hit the
        // best ask — guarantees immediate fill at a known price.
        let limitPrice = null;
        try {
          const tk = await signedRequest(
            `/api/v2/public/ticker?instrument_name=${pos.instrument_name}`,
            state.clientA.apiKey, state.clientA.secretKey
          );
          const r = tk?.result || {};
          const bid = parseFloat(r.best_bid_price);
          const ask = parseFloat(r.best_ask_price);
          if (closeSide === 'sell' && bid > 0)      limitPrice = bid;
          else if (closeSide === 'buy' && ask > 0)  limitPrice = ask;
          else if (parseFloat(r.mark_price) > 0)    limitPrice = parseFloat(r.mark_price);
        } catch (e) {
          console.warn(`[UniExecV2] ticker fetch failed for ${pos.instrument_name}: ${e.message}`);
        }
        if (!limitPrice || !Number.isFinite(limitPrice) || limitPrice <= 0) {
          console.error(
            `[UniExecV2] SKIP close ${pos.instrument_name} — no valid limit price ` +
            `(bid/ask/mark all missing). Manual intervention required.`
          );
          continue;
        }

        console.log(
          `[UniExecV2] Closing option ${pos.instrument_name} | ${closeSide} ${closeSize} ` +
          `@ LIMIT ${limitPrice} | mark=${pos.mark_price} | uPnL=${pos.floating_profit_loss}`
        );

        try {
          const path = `/api/v2/private/${closeSide}?instrument_name=${pos.instrument_name}` +
            `&amount=${closeSize}&type=limit&price=${limitPrice}&reduce_only=true`;
          const result = await signedRequest(path, state.clientA.apiKey, state.clientA.secretKey);
          const order = result?.result?.order;
          if (order) {
            console.log(
              `[UniExecV2] Option close LIMIT placed: ${order.order_id} | ` +
              `${pos.instrument_name} ${closeSide} ${closeSize} @ ${limitPrice} | state=${order.order_state}`
            );
          }
        } catch (e) {
          console.error(`[UniExecV2] Failed to close option ${pos.instrument_name}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[UniExecV2] Failed to fetch option positions for pair ${pairId}: ${e.message}`);
    }
  }

  async _checkOptionProfitTakeProfit(state) {
    if (!state.enabled || state._killSwitchTriggered || state._optionProfitTriggered) return;
    if (state._optionProfitTargetUsd <= 0 || state._optionInstruments.length === 0) return;
    if (!state.clientA) return;

    try {
      const ccy = _optionCurrency(state);

      // ── Fetch perp positions (included in total) ───────────────────────
      let perpPnlCcy = 0;
      let btcIndex = 0;
      const perpLines = [];
      try {
        const perpRes = await signedRequest(
          `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
          state.clientA.apiKey, state.clientA.secretKey
        );
        for (const p of (perpRes?.result || []).filter(p => p.size !== 0)) {
          perpPnlCcy += p.floating_profit_loss || 0;
          if (p.index_price > 0) btcIndex = p.index_price;
          const dir = p.size > 0 ? 'LONG' : 'SHORT';
          perpLines.push(`  • ${p.instrument_name} ${dir} ${Math.abs(p.size)} | fpl: ${(p.floating_profit_loss || 0).toFixed(6)} ${ccy}`);
        }
      } catch (_) {}

      // ── Fetch option positions ─────────────────────────────────────────
      const optRes = await signedRequest(
        `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const liveOptions = (optRes?.result || []).filter(p => p.size !== 0);
      if (liveOptions.length === 0 && perpPnlCcy === 0) return;

      const tracked = new Set(
        state._optionInstruments
          .map(o => (typeof o === 'string' ? o : o?.name))
          .filter(Boolean)
      );
      let optionPnlCcy = 0;
      for (const p of liveOptions) {
        if (tracked.size > 0 && !tracked.has(p.instrument_name)) continue;
        optionPnlCcy += p.floating_profit_loss || 0;
        if (p.index_price > 0) btcIndex = p.index_price;
      }

      if (!btcIndex || btcIndex <= 0) {
        const ob = state.lastOrderbooks?.leg2;
        const bid = parseFloat(ob?.bids?.[0]?.price || 0);
        const ask = parseFloat(ob?.asks?.[0]?.price || 0);
        btcIndex = bid && ask ? (bid + ask) / 2 : 0;
      }
      if (!btcIndex) return;

      const perpPnlUsd   = perpPnlCcy   * btcIndex;
      const optionPnlUsd = optionPnlCcy * btcIndex;
      const netPnlUsd    = perpPnlUsd + optionPnlUsd;
      state._lastOptionPnlUsd = parseFloat(netPnlUsd.toFixed(2));

      if (netPnlUsd >= state._optionProfitTargetUsd) {
        state._optionProfitTriggered = true;
        state._killSwitchTriggered = true;
        console.error(
          `[UniExecV2] *** POSITION PnL TAKE-PROFIT *** pair ${state.pairId} | ` +
          `netPnl=$${netPnlUsd.toFixed(2)} (perp=$${perpPnlUsd.toFixed(2)} opt=$${optionPnlUsd.toFixed(2)}) >= target=$${state._optionProfitTargetUsd} | ` +
          `closing options + perps + stopping bot`
        );

        const perpSection = perpLines.length
          ? `Perp uPnL: <b>${perpPnlUsd >= 0 ? '+' : ''}$${perpPnlUsd.toFixed(2)}</b>\n${perpLines.join('\n')}\n`
          : `Perp positions: none\n`;

        _sendTelegramAlert(
          `🚨 <b>POSITION PnL TARGET HIT (V2)</b>\n\n` +
          `Pair ${state.pairId} (${state.pair?.agentName || ''})\n` +
          `<b>Net PnL (perp + options): $${netPnlUsd.toFixed(2)}</b>\n` +
          `  Perp uPnL:    ${perpPnlUsd >= 0 ? '+' : ''}$${perpPnlUsd.toFixed(2)}\n` +
          `  Option uPnL:  ${optionPnlUsd >= 0 ? '+' : ''}$${optionPnlUsd.toFixed(2)}\n` +
          `Target: <b>$${state._optionProfitTargetUsd}</b>\n` +
          `Index: $${btcIndex.toFixed(2)}\n\n` +
          perpSection +
          `⛔ Closing all options + perps and stopping bot...`
        );

        await this._closeOptionPositions(state).catch(e =>
          console.error(`[UniExecV2] option profit close error pair ${state.pairId}: ${e.message}`)
        );
        await this._emergencyCloseAll(state, 'option_profit_take_profit');
      }
    } catch (e) {
      console.error(`[UniExecV2] _checkOptionProfitTakeProfit error pair ${state.pairId}: ${e.message}`);
    }
  }

  // ── entry ───────────────────────────────────────────────────────────────────
  async _startEntry(state, levelIdx, signalSpread, entryZScore) {
    const pair      = state.pair;
    const ob1       = state.lastOrderbooks?.leg1;
    const ob2       = state.lastOrderbooks?.leg2;
    const futAsk    = parseFloat(ob1?.asks?.[0]?.price || 0);
    const perpBid   = parseFloat(ob2?.bids?.[0]?.price || 0);
    if (!futAsk || !perpBid) return;

    const qty        = state.levelQty[levelIdx] || pair.qty1;
    const level      = state.levels[levelIdx];
    const isLegB     = state.tradeLeg === 'B';
    const entrySide  = isLegB ? 'buy' : 'sell';
    const entryPrice = isLegB ? perpBid : futAsk;

    const entryRes = await this._placeLimit(state, entrySide, qty, entryPrice);
    if (!entryRes.orderId) return;

    const tradedExchange = isLegB ? pair.exchange2 : pair.exchange1;
    const tradedSymbol   = isLegB ? pair.symbol2   : pair.symbol1;
    const signalExchange = isLegB ? pair.exchange1  : pair.exchange2;
    const signalSymbol   = isLegB ? pair.symbol1   : pair.symbol2;

    const trade = await Trade.create({
      pairId: state.pairId, side: 'entry',
      legA_exchange: tradedExchange, legA_symbol: tradedSymbol,
      legA_side: entrySide, legA_price: entryPrice, legA_qty: qty,
      legA_orderId: entryRes.orderId, legA_fillType: 'maker',
      legB_exchange: signalExchange, legB_symbol: signalSymbol,
      legB_side: isLegB ? 'sell' : 'buy',
      legB_price: isLegB ? futAsk : perpBid, legB_qty: 0, legB_fillType: 'signal',
      spreadAtEntry: signalSpread, status: 'open',
    });
    const bp = await BasisPosition.create({
      pairId: state.pairId, entryTradeId: trade.id,
      direction: 'long', gridLevel: levelIdx + 1,
      state: 'pending_entry', entrySpread: signalSpread,
      legA_entryPrice: entryPrice, legA_entryQty: qty,
      legB_entryPrice: isLegB ? futAsk : perpBid, legB_entryQty: 0,
      legA_entryOrderId: entryRes.orderId, entryTime: new Date(),
    });

    const pos = {
      id:                `${Date.now()}_${Math.random()}`,
      status:            'pending_entry',
      gridLevel:         levelIdx + 1,
      level,
      qty,
      entryOrderId:      entryRes.orderId,
      entryTradeId:      trade.id,
      basisPositionId:   bp.id,
      entrySignalSpread: signalSpread,
      tpDelta:           state.tpSpreadDelta,
      slDelta:           state.slSpreadDelta,
      entryPriceA:       null,
      entryPriceB:       null,
      fillSpread:        null,
      bestSpread:        null,
      openedAt:          null,
      entryCommissionUsd: null,
      entryZScore,       // V2: store z-score at entry for dynamic TP crossover
      profitTicks:       0,
      stopTicks:         0,
      timeExitTicks:     0,
      pollTimer:         null,
      pollStart:         Date.now(),
      exitOrderId:       null,
      exitTradeId:       null,
      _repriced:         false,
    };
    state.openPositions.push(pos);
    state.lastEntryAt = Date.now();
    state._idleAlertSentAt = 0;  // reset idle alert on new entry
    this._pollEntry(state, pos);
    console.log(`[UniExecV2] pair ${state.pairId} ENTRY L${levelIdx+1} spread=$${signalSpread} z=${(entryZScore||0).toFixed(2)} mean=$${(state._dollarMean||0).toFixed(2)} edge=$${(signalSpread-(state._dollarMean||0)).toFixed(2)}`);
  }

  _pollEntry(state, pos) {
    if (pos.pollTimer) clearInterval(pos.pollTimer);
    const isLegB = state.tradeLeg === 'B';
    const REPRICE_AFTER_MS = 20_000;
    pos._repriced = false;
    pos.pollTimer = setInterval(async () => {
      if (!state.enabled) { clearInterval(pos.pollTimer); return; }
      if (Date.now() - pos.pollStart > (state.entryTimeoutMs || ENTRY_TIMEOUT_MS)) {
        clearInterval(pos.pollTimer);
        const cancelResp = await this._cancel(state, pos.entryOrderId);
        // Race: filled during cancel — _cancel already promoted via _onEntryFilled.
        if (cancelResp && cancelResp.raceHandled) return;
        await Trade.update({ status: 'cancelled', cancelReason: 'entry_timeout_unfilled' },
          { where: { id: pos.entryTradeId } }).catch(() => {});
        await BasisPosition.update({ state: 'failed' }, { where: { id: pos.basisPositionId } }).catch(() => {});
        pos.status = 'closed';
        state.openPositions = state.openPositions.filter(p => p !== pos);
        return;
      }
      const st = await this._orderStatus(state, pos.entryOrderId);
      if (st.status !== 'filled') {
        if (!pos._repriced && (Date.now() - pos.pollStart > REPRICE_AFTER_MS)) {
          pos._repriced = true;
          const ob1 = state.lastOrderbooks?.leg1;
          const ob2 = state.lastOrderbooks?.leg2;
          const newPrice = isLegB ? parseFloat(ob2?.bids?.[0]?.price || 0) : parseFloat(ob1?.asks?.[0]?.price || 0);
          if (newPrice) {
            const cancelResp = await this._cancel(state, pos.entryOrderId).catch(() => null);
            // Race: filled during cancel — pos is now 'open'. Don't place a second entry.
            if (cancelResp && cancelResp.raceHandled) return;
            const re = await this._placeLimit(state, isLegB ? 'buy' : 'sell', pos.qty, newPrice);
            if (re.orderId) {
              pos.entryOrderId = re.orderId;
              await Trade.update({ legA_orderId: re.orderId, legA_price: newPrice },
                { where: { id: pos.entryTradeId } }).catch(() => {});
              await BasisPosition.update({ legA_entryOrderId: re.orderId },
                { where: { id: pos.basisPositionId } }).catch(() => {});
            }
          }
        }
        return;
      }
      clearInterval(pos.pollTimer);
      await this._onEntryFilled(state, pos, st);
    }, POLL_MS);
  }

  // ── exit ────────────────────────────────────────────────────────────────────
  async _startExit(state, pos, reason) {
    if (pos.status !== 'open') return;
    const ob1     = state.lastOrderbooks?.leg1;
    const ob2     = state.lastOrderbooks?.leg2;
    const futBid  = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || pos.entryPriceB || 0);
    const isLegB  = state.tradeLeg === 'B';

    if (reason === 'profit' && pos.entryPriceA) {
      const exitPrice      = isLegB ? perpAsk : futBid;
      const wouldBePositive = isLegB ? (exitPrice > pos.entryPriceA) : (exitPrice < pos.entryPriceA);
      if (!wouldBePositive) { pos.profitTicks = 0; return; }
      const estGrossUsd = this._estimateGrossPnlUsd(
        isLegB,
        pos.qty,
        pos.entryPriceA,
        exitPrice,
        this._isLinearUsdc(state),
      );
      const minGrossUsd = minGrossProfitUsd();
      if (
        !(estGrossUsd > PROFIT_EXIT_MIN_GROSS_USD) ||
        (minGrossUsd > 0 && estGrossUsd < minGrossUsd)
      ) {
        pos.profitTicks = 0;
        console.log(
          `[UniExecV2] pair ${state.pairId} profit exit blocked at arm-time ` +
          `estGross=$${Number(estGrossUsd).toFixed(4)} plannedPx=${exitPrice} entry=${pos.entryPriceA} qty=${pos.qty}`,
        );
        return;
      }
    }

    pos.status = 'pending_exit';
    const exitSide  = isLegB ? 'sell' : 'buy';
    const exitPrice = isLegB ? perpAsk : futBid;
    if (!exitPrice || !futBid || !perpBid) { pos.status = 'open'; return; }

    const res = await this._placeLimit(state, exitSide, pos.qty, exitPrice);
    if (!res.orderId) { pos.status = 'open'; return; }

    const tradedExchange = isLegB ? state.pair.exchange2 : state.pair.exchange1;
    const tradedSymbol   = isLegB ? state.pair.symbol2   : state.pair.symbol1;
    const signalExchange = isLegB ? state.pair.exchange1  : state.pair.exchange2;
    const signalSymbol   = isLegB ? state.pair.symbol1   : state.pair.symbol2;
    const signalPrice    = isLegB ? futBid : perpBid;
    const exitSpreadNow  = parseFloat((futBid - perpBid).toFixed(4));

    const exitTrade = await Trade.create({
      pairId: state.pairId, side: 'exit',
      legA_exchange: tradedExchange, legA_symbol: tradedSymbol,
      legA_side: exitSide, legA_price: exitPrice, legA_qty: pos.qty,
      legA_orderId: res.orderId, legA_fillType: 'maker',
      legB_exchange: signalExchange, legB_symbol: signalSymbol,
      legB_side: isLegB ? 'buy' : 'sell', legB_price: signalPrice, legB_qty: 0,
      legB_fillType: 'signal', spreadAtEntry: pos.entrySignalSpread,
      spreadAtExit: exitSpreadNow, status: 'open',
    });
    await BasisPosition.update({
      state: 'pending_exit',
      exitTradeId: exitTrade.id,
      legA_exitOrderId: res.orderId,
      exitReason: reason,
    }, { where: { id: pos.basisPositionId } }).catch(() => {});
    pos.exitReason  = reason;
    pos.exitOrderId = res.orderId;
    pos.exitTradeId = exitTrade.id;
    pos.pollStart   = Date.now();
    this._pollExit(state, pos);
  }

  _pollExit(state, pos) {
    if (pos.pollTimer) clearInterval(pos.pollTimer);
    const isLegB = state.tradeLeg === 'B';
    pos.pollTimer = setInterval(async () => {
      if (!state.enabled) { clearInterval(pos.pollTimer); return; }
      const st = await this._orderStatus(state, pos.exitOrderId);
      if (st.status === 'filled') { /* fall through */ }
      else if (Date.now() - pos.pollStart > EXIT_TIMEOUT_MS) {
        const ob1 = state.lastOrderbooks?.leg1;
        const ob2 = state.lastOrderbooks?.leg2;
        const newPrice = isLegB ? parseFloat(ob2?.asks?.[0]?.price || 0) : parseFloat(ob1?.bids?.[0]?.price || 0);
        if (pos.exitReason === 'profit' && pos.entryPriceA && newPrice > 0) {
          const wouldBePositive = isLegB ? (newPrice > pos.entryPriceA) : (newPrice < pos.entryPriceA);
          if (!wouldBePositive) {
            const cancelResp = await this._cancel(state, pos.exitOrderId);
            clearInterval(pos.pollTimer);
            // Race: exit filled during cancel — pos is closed, skip abort rollback.
            if (cancelResp && cancelResp.raceHandled) return;
            if (pos.exitTradeId)
              await Trade.update({ status: 'cancelled', cancelReason: 'gross_negative_abort' },
                { where: { id: pos.exitTradeId } }).catch(() => {});
            pos.status = 'open'; pos.exitOrderId = null; pos.exitTradeId = null;
            pos.profitTicks = 0; pos.stopTicks = 0; pos.timeExitTicks = 0;
            return;
          }
        }
        const cancelResp2 = await this._cancel(state, pos.exitOrderId);
        // Race: exit filled during cancel — don't place a second exit.
        if (cancelResp2 && cancelResp2.raceHandled) {
          clearInterval(pos.pollTimer);
          return;
        }
        if (newPrice > 0) {
          const exitSide = isLegB ? 'sell' : 'buy';
          const re = await this._placeLimit(state, exitSide, pos.qty, newPrice);
          if (re.orderId) {
            pos.exitOrderId = re.orderId; pos.pollStart = Date.now();
            await Trade.update({ legA_orderId: re.orderId, legA_price: newPrice },
              { where: { id: pos.exitTradeId } }).catch(() => {});
            await BasisPosition.update(
              { legA_exitOrderId: re.orderId, state: 'pending_exit' },
              { where: { id: pos.basisPositionId } }
            ).catch(() => {});
          }
        }
        return;
      } else { return; }

      clearInterval(pos.pollTimer);
      await this._onExitFilled(state, pos, st);
    }, POLL_MS);
  }

  // ── main spread handler ──────────────────────────────────────────────────────
  async onSpreadUpdate(pairId, sellStats, _buyStats, ctx = {}) {
    const state = this.pairs.get(pairId);
    if (!state || !state.enabled) return;
    if (state._spreadUpdateInFlight) return;
    state._spreadUpdateInFlight = true;
    try {
      await this._handleSpreadUpdate(state, sellStats, ctx);
    } finally {
      state._spreadUpdateInFlight = false;
    }
  }

  async _handleSpreadUpdate(state, sellStats, ctx) {
    state.lastOrderbooks = { leg1: ctx.leg1, leg2: ctx.leg2 };
    const ob1     = ctx.leg1;
    const ob2     = ctx.leg2;
    const futAsk  = parseFloat(ob1?.asks?.[0]?.price || 0);
    const futBid  = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
    if (!futAsk || !futBid || !perpBid) return;

    const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
    if (perpBid > 0 && perpAsk > 0) {
      const btcMid = (perpBid + perpAsk) / 2;
      await this._checkPriceRangeKillSwitch(state, btcMid);
      if (state._priceRangeTriggered) return;
    }

    const signalSpread = parseFloat((futAsk - perpBid).toFixed(4));

    // ── Maintain rolling spread history (ring buffer) ──────────────────────
    state._spreadHistory.push(signalSpread);
    if (state._spreadHistory.length > TREND_WINDOW) state._spreadHistory.shift();

    // ── Update market stats from adapt snapshot if not already set ──────────
    // (also updated externally by _doAdaptLevels via updateMarketStats)
    if (state._dollarMean == null && sellStats?.mean != null) {
      state._dollarMean = sellStats.mean;
      state._dollarStd  = sellStats.std || 1;
    }

    const SL_CONFIRM_TICKS     = 7;
    const TP_CONFIRM_TICKS     = 3;
    const MIN_HOLD_BEFORE_SL_MS = 15_000;
    const STAGGER_STOP_MS      = 3_000;
    const minGrossUsd          = minGrossProfitUsd();
    const isLegB               = state.tradeLeg === 'B';
    const isLinear             = this._isLinearUsdc(state);

    // Daily PnL reset
    const todayStr = new Date().toISOString().slice(0, 10);
    if (state.dailyPnlResetDate !== todayStr) { state.dailyPnl = 0; state.dailyPnlResetDate = todayStr; }

    // ── Compute rolling z-score for this tick ─────────────────────────────
    const dollarMean = state._dollarMean;
    const dollarStd  = state._dollarStd || 1;
    const currentZ   = dollarMean != null ? (signalSpread - dollarMean) / dollarStd : (sellStats?.zScore ?? 0);

    // ── TP / SL loop for open positions ───────────────────────────────────
    for (const pos of state.openPositions) {
      if (pos.status !== 'open') continue;
      const now    = Date.now();
      const holdMs = pos.openedAt ? (now - pos.openedAt) : 0;
      if (pos.bestSpread == null) pos.bestSpread = pos.fillSpread;
      if (signalSpread < pos.bestSpread) pos.bestSpread = signalSpread;

      const currentPrice = isLegB
        ? parseFloat(ob2?.asks?.[0]?.price || 0)
        : parseFloat(ob1?.bids?.[0]?.price || 0);
      const grossPositive = isLegB ? (currentPrice > pos.entryPriceA) : (currentPrice < pos.entryPriceA);
      const estGross = grossPositive && pos.entryPriceA && currentPrice
        ? this._estimateGrossPnlUsd(isLegB, pos.qty, pos.entryPriceA, currentPrice, isLinear) : 0;
      const grossMeetsMin = minGrossUsd <= 0 || estGross >= minGrossUsd;

      // Per-position TP/SL (frozen at entry) with fallback to global state
      const posTp = pos.tpDelta ?? state.tpSpreadDelta;
      const posSl = pos.slDelta ?? state.slSpreadDelta;

      // ── Traditional fixed-delta TP ─────────────────────────────────────
      const spreadTp = (pos.entrySignalSpread - signalSpread) >= posTp;

      // ── V2: Mean-reversion TP — spread has returned to rolling mean ──────
      const meanReversionTp = dollarMean != null && signalSpread <= dollarMean;

      // ── V2: Z-score crossover TP — z was positive at entry, now ≤ 0 ─────
      const zCrossoverTp = pos.entryZScore != null && pos.entryZScore > 0 && currentZ <= 0;

      const tpHit = (spreadTp || meanReversionTp || zCrossoverTp) && grossPositive && grossMeetsMin;

      if (tpHit && (meanReversionTp || zCrossoverTp)) {
        const reason = meanReversionTp ? 'mean_reversion' : 'z_crossover';
        console.log(`[UniExecV2] pair ${state.pairId} DYNAMIC_TP pos L${pos.gridLevel} | spread=$${signalSpread.toFixed(2)} mean=$${(dollarMean||0).toFixed(2)} z=${currentZ.toFixed(2)} reason=${reason}`);
      }

      // ── SL ─────────────────────────────────────────────────────────────
      // Use entrySignalSpread (same convention as signalSpread = futAsk - perpBid)
      // instead of fillSpread which includes the bid-ask gap and causes premature triggers
      const slBaseline = pos.entrySignalSpread ?? pos.fillSpread;
      const slHit = holdMs >= MIN_HOLD_BEFORE_SL_MS
        && (signalSpread - slBaseline) >= posSl
        && (now - state.lastStopExitAt) >= STAGGER_STOP_MS;

      if (tpHit)      { pos.profitTicks = (pos.profitTicks || 0) + 1; pos.stopTicks = 0; }
      else if (slHit) { pos.stopTicks   = (pos.stopTicks   || 0) + 1; pos.profitTicks = 0; }
      else            { pos.profitTicks = 0; pos.stopTicks = 0; }

      if (pos.profitTicks >= TP_CONFIRM_TICKS)       await this._startExit(state, pos, 'profit');
      else if (pos.stopTicks >= SL_CONFIRM_TICKS) { state.lastStopExitAt = now; await this._startExit(state, pos, 'stop'); }
    }

    // ── Entry checks ──────────────────────────────────────────────────────
    const now = Date.now();

    if (state._killSwitchTriggered)               { state.prevSignalSpread = signalSpread; return; }
    if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd) { state.prevSignalSpread = signalSpread; return; }
    if (state.prevSignalSpread == null)           { state.prevSignalSpread = signalSpread; return; }
    if (now - state.lastEntryAt < COOLDOWN_MS)    { state.prevSignalSpread = signalSpread; return; }
    if (state._entryInFlight)                     { state.prevSignalSpread = signalSpread; return; }

    const z    = sellStats?.zScore ?? currentZ;
    const zMin = state.pair.zEntryThreshold != null ? parseFloat(state.pair.zEntryThreshold) : 0;
    const zMax = state.pair.zEntryMax != null ? parseFloat(state.pair.zEntryMax) : null;
    if (z < zMin)                                 { state.prevSignalSpread = signalSpread; return; }
    if (zMax != null && Number.isFinite(zMax) && z > zMax) { state.prevSignalSpread = signalSpread; return; }

    const maxPos   = state.pair.maxPositions != null ? parseInt(state.pair.maxPositions) : 1;
    const openCount = state.openPositions.filter(p => p.status !== 'closed').length;
    if (openCount >= maxPos)                      { state.prevSignalSpread = signalSpread; return; }

    const cap = state._adaptedMaxSpreadCap ?? (state.pair.maxSpreadCap != null ? parseFloat(state.pair.maxSpreadCap) : Infinity);
    if (signalSpread > cap)                       { state.prevSignalSpread = signalSpread; return; }

    // ── V2 GATE 1: Regime filter ──────────────────────────────────────────
    if (state._spreadHistory.length >= TREND_WINDOW) {
      const slope      = regressionSlope(state._spreadHistory);
      const sigmaPerTick = (dollarStd || 1) / Math.sqrt(TREND_WINDOW);
      const trendStrength = Math.abs(slope) / (sigmaPerTick || 1);

      // Volatility expansion: realtime std vs rolling baseline
      const realtimeStd  = sellStats?.std || dollarStd || 1;
      const baselineStd  = dollarStd || realtimeStd;
      const volExpansion = baselineStd > 0 ? realtimeStd / baselineStd : 1;

      const trendBlocked = trendStrength > TREND_STRENGTH_THRESHOLD;
      const volBlocked   = volExpansion   > VOL_EXPANSION_THRESHOLD;
      state._regimeBlocked = trendBlocked || volBlocked;

      if (state._regimeBlocked) {
        if (now - state._lastRegimeLog > 10_000) {
          console.log(
            `[UniExecV2] pair ${state.pairId} REGIME_BLOCKED | ` +
            `trendStr=${trendStrength.toFixed(2)} (lim=${TREND_STRENGTH_THRESHOLD}) ` +
            `volExp=${volExpansion.toFixed(2)} (lim=${VOL_EXPANSION_THRESHOLD}) ` +
            `slope=${slope.toFixed(4)}`
          );
          state._lastRegimeLog = now;
        }
        state.prevSignalSpread = signalSpread;
        return;
      }
    } else {
      state._regimeBlocked = false;
    }

    // ── V2 GATE 2: Fee-aware entry ────────────────────────────────────────
    // Compare basis premium vs mean (same units as signalSpread) to round-trip fee **USD**
    // on the largest grid tier (MAKER_FEE_RATE × leg notional per side). Using BTC index
    // price here (~1e5) wrongly required tens of $ of spread edge and blocked all entries.
    if (dollarMean != null && dollarMean > 0) {
      const entryPrice = isLegB ? perpBid : futAsk;
      const spreadEdge = signalSpread - dollarMean;
      const qtyArr = (state.levelQty && state.levelQty.length)
        ? state.levelQty.map((q) => parseFloat(q) || 0)
        : [parseFloat(state.pair?.qty1) || 0];
      const maxQtyUsd = Math.max(...qtyArr, 1);
      const legNotionalUsd = isLinear ? maxQtyUsd * entryPrice : maxQtyUsd;
      const feeUsdPerLeg = MAKER_FEE_RATE * legNotionalUsd;
      const minSpreadEdge = FEE_EDGE_MULTIPLE * 2 * feeUsdPerLeg;
      if (spreadEdge < minSpreadEdge) {
        if (now - (state._lastFeeGateLog || 0) > 15_000) {
          console.log(
            `[UniExecV2] pair ${state.pairId} FEE_GATE | spreadEdge=${spreadEdge.toFixed(4)} ` +
            `< min=${minSpreadEdge.toFixed(4)} (legNotional≈$${legNotionalUsd.toFixed(0)})`
          );
          state._lastFeeGateLog = now;
        }
        state.prevSignalSpread = signalSpread;
        return;
      }
    }

    // ── Level cross-up loop (highest level first) ─────────────────────────
    for (let i = state.levels.length - 1; i >= 0; i--) {
      const level   = state.levels[i];
      const already = state.openPositions.some(p => p.status !== 'closed' && p.gridLevel === i + 1);
      if (already) continue;
      if (state.prevSignalSpread < level && signalSpread >= level) {
        state._entryInFlight = true;
        try {
          await this._startEntry(state, i, signalSpread, currentZ);
        } finally {
          state._entryInFlight = false;
        }
        break;
      }
    }
    state.prevSignalSpread = signalSpread;
  }

  // ── adaptive levels (same logic as V1) ─────────────────────────────────────
  _doAdaptLevels(state, dollarMean, dollarStd) {
    const pair = state.pair;
    if (!pair) return;
    if (!Number.isFinite(dollarMean) || !Number.isFinite(dollarStd)) return;
    if (dollarMean <= 0) return;
    if (dollarStd / dollarMean < 0.01) return;

    // V2: persist mean/std in state for dynamic TP and fee gate
    state._dollarMean = dollarMean;
    state._dollarStd  = dollarStd;

    const sigmaMin = pair.adaptSigmaMin != null ? parseFloat(pair.adaptSigmaMin) : 0.5;
    const sigmaMax = pair.adaptSigmaMax != null ? parseFloat(pair.adaptSigmaMax) : 2.0;
    const tpSigma  = pair.adaptTpSigma  != null ? parseFloat(pair.adaptTpSigma)  : 0.8;
    const slSigma  = pair.adaptSlSigma  != null ? parseFloat(pair.adaptSlSigma)  : 1.5;
    const nLevels  = Math.max(1, Math.min(state.levels.length || 3, 7));
    const newLevels = [];
    for (let i = 0; i < nLevels; i++) {
      const sigma = nLevels === 1 ? sigmaMin : sigmaMin + (sigmaMax - sigmaMin) * (i / (nLevels - 1));
      const level = parseFloat((dollarMean + sigma * dollarStd).toFixed(4));
      if (level > 0) newLevels.push(level);
    }
    if (newLevels.length === 0) return;

    const prevLevels = [...state.levels];
    const prevTp     = state.tpSpreadDelta;
    const prevSl     = state.slSpreadDelta;
    const prevCap    = state._adaptedMaxSpreadCap ?? (pair.maxSpreadCap ?? null);
    state.levels     = newLevels;
    state.levelQty   = this._computeLevelQty(pair, newLevels);
    state._adaptedMaxSpreadCap = parseFloat((dollarMean + (sigmaMax + 0.5) * dollarStd).toFixed(4));

    // Always update TP/SL globally (each position snapshots its own
    // tpDelta/slDelta at entry, so open positions are not affected)
    const openCount = state.openPositions.filter(p => p.status !== 'closed').length;
    let tpUpdated = false, slUpdated = false;
    const newTp = parseFloat((tpSigma * dollarStd).toFixed(4));
    const newSl = parseFloat((slSigma * dollarStd).toFixed(4));
    if (newTp > 0) { state.tpSpreadDelta = newTp; tpUpdated = true; }
    if (newSl > 0) { state.slSpreadDelta = newSl; slUpdated = true; }
    state._adaptedAt = Date.now();
    console.log(
      `[AdaptLevelsV2] pair ${state.pairId} | mean=$${dollarMean.toFixed(2)} std=$${dollarStd.toFixed(2)} | ` +
      `levels=[${newLevels.map(l => l.toFixed(2)).join(', ')}] | ` +
      `feeGate=$${(FEE_EDGE_MULTIPLE * 2 * MAKER_FEE_RATE).toFixed(4)}×price | ` +
      `tp=${tpUpdated ? '$'+state.tpSpreadDelta.toFixed(2) : 'unchanged'} | ` +
      `sl=${slUpdated ? '$'+state.slSpreadDelta.toFixed(2) : 'unchanged'} | ` +
      `cap=$${state._adaptedMaxSpreadCap.toFixed(2)}`
    );
    this._saveLevelHistory(state.pairId, {
      changedBy: 'adapt', prevLevels, prevTp, prevSl, prevCap,
      newLevels, newTp: state.tpSpreadDelta, newSl: state.slSpreadDelta,
      newCap: state._adaptedMaxSpreadCap, dollarMean, dollarStd,
      openPositions: openCount, tpSlUpdated: tpUpdated && slUpdated,
    });
    const dbUpdate = { spreadEntryLevels: newLevels.join(','), maxSpreadCap: state._adaptedMaxSpreadCap };
    if (tpUpdated) dbUpdate.tpSpreadDelta = state.tpSpreadDelta;
    if (slUpdated) dbUpdate.slSpreadDelta = state.slSpreadDelta;
    StatArbInput.update(dbUpdate, { where: { id: state.pairId } }).catch(err =>
      console.warn(`[AdaptLevelsV2] pair ${state.pairId} DB persist failed: ${err.message}`)
    );
  }

  async runAdaptCycle() {
    const orderbookManager = require('./orderbookStreams');
    let adapted = 0;
    for (const [pairId, state] of this.pairs) {
      if (!state.enabled) continue;
      if (!state.pair?.adaptLevels) continue;
      const snapshot = orderbookManager.getSpreadSnapshot(pairId);
      if (!snapshot) { console.log(`[AdaptLevelsV2] pair ${pairId} skipped — no snapshot`); continue; }
      if (snapshot.n < 30) { console.log(`[AdaptLevelsV2] pair ${pairId} skipped — ${snapshot.n} ticks`); continue; }
      this._doAdaptLevels(state, snapshot.dollarMean, snapshot.dollarStd);
      this._broadcastState(pairId);
      adapted++;
    }
    if (adapted > 0) console.log(`[AdaptLevelsV2] Cycle complete — adapted ${adapted} pair(s)`);
    return adapted;
  }

  _isUsaMarketHours() {
    const now = new Date();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    return mins >= 13 * 60 + 30 && mins < 20 * 60;
  }

  _getAdaptIntervalMs() {
    return this._isUsaMarketHours() ? 15 * 60_000 : 30 * 60_000;
  }

  _scheduleNextAdaptV2() {
    if (this._adaptTimerStopped) return;
    const intervalMs = this._getAdaptIntervalMs();
    const label = this._isUsaMarketHours() ? 'USA-open' : 'off-hours';
    this._adaptTimer = setTimeout(() => {
      this.runAdaptCycle().catch(e => console.error('[AdaptLevelsV2] Scheduler error:', e.message));
      console.log(`[AdaptLevelsV2] Next cycle in ${intervalMs / 60_000} min (${label})`);
      this._scheduleNextAdaptV2();
    }, intervalMs);
  }

  startAdaptScheduler() {
    this._adaptTimerStopped = false;
    setTimeout(() => {
      this.runAdaptCycle().catch(e => console.error('[AdaptLevelsV2] Scheduler error:', e.message));
      this._scheduleNextAdaptV2();
    }, 5 * 60 * 1000);
    const label = this._isUsaMarketHours() ? 'USA-open 15 min' : 'off-hours 30 min';
    console.log(`[AdaptLevelsV2] Adapt scheduler started — ${label} interval (first run after 5 min warmup)`);
  }

  stopAdaptScheduler() {
    this._adaptTimerStopped = true;
    if (this._adaptTimer) { clearTimeout(this._adaptTimer); this._adaptTimer = null; }
  }

  _saveLevelHistory(pairId, data) {
    SpreadLevelHistory.create({
      pairId,
      changedBy:          data.changedBy,
      levels:             data.newLevels,
      tpSpreadDelta:      data.newTp,
      slSpreadDelta:      data.newSl,
      maxSpreadCap:       data.newCap,
      prevLevels:         data.prevLevels,
      prevTpSpreadDelta:  data.prevTp,
      prevSlSpreadDelta:  data.prevSl,
      prevMaxSpreadCap:   data.prevCap,
      dollarMean:         data.dollarMean,
      dollarStd:          data.dollarStd,
      openPositions:      data.openPositions,
      tpSlUpdated:        data.tpSlUpdated,
    }).catch(() => {});
  }
}

module.exports = new UnilateralExecutorV2();
