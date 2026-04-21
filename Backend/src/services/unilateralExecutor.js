const crypto = require('crypto');
const {
  buyorder,
  sellorder,
  cancelorder,
  signedRequest,
} = require('../controllers/apicontroller');
const { StatArbInput, AccountDetails } = require('../models');
const Trade = require('../models/Trade');
const BasisPosition = require('../models/BasisPosition');
const SpreadLevelHistory = require('../models/SpreadLevelHistory');
const btcAnalysisHook = require('./btcAnalysisHook');

function _sendTelegramAlert(text) {
  // Telegram alerts disabled
  // try {
  //   const { sendTelegram } = require('./telegramReport');
  //   sendTelegram(text).catch(e => console.warn(`[UniExec] Telegram alert error: ${e.message}`));
  // } catch (e) {
  //   console.warn(`[UniExec] Cannot send Telegram alert: ${e.message}`);
  // }
}

// Derive Deribit settlement currency from an instrument symbol.
// ETH-PERPETUAL → ETH, BTC-29MAY26 → BTC, SOL_USDC-PERPETUAL → USDC.
function _coinFromSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.includes('_USDC')) return 'USDC';
  const base = s.split('-')[0]; // everything before first dash
  return base || 'BTC';
}

// Settlement currency for the traded leg (account balance / positions / orders).
function _settlementCoinForState(state) {
  const sym = state.tradeSymbol || state.pair?.symbol1 || state.pair?.symbol2 || '';
  return _coinFromSymbol(sym);
}

// Settlement currency for the options leg (always anchored to symbol1).
function _optionCurrency(state) {
  return _coinFromSymbol(state.pair?.symbol1 || '');
}

const POLL_MS = 1500;
const ENTRY_TIMEOUT_MS = 45000;
const EXIT_TIMEOUT_MS = 30000;
const COOLDOWN_MS = 30000;

/** Profit exits must have strictly positive strategy gross (entry→exit on traded leg) above this USD threshold. */
const PROFIT_EXIT_MIN_GROSS_USD = 1e-6;

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
    this._idleAlertSentAt = 0;
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
    /** Peak Deribit account `equity` (includes options); used for equity % drawdown + alerts */
    this._peakAccountEquity = null;
    this._accountEquityFull = null;
    /** Latch: after alerting, re-arm only when drawdown eases below hysteresis */
    this._equityDrawdownAlertLatch = false;
    // ── Smart drawdown split: options drift vs trading losses ─────────────
    /** Options unrealised PnL at session start — set once on first refresh */
    this._sessionStartOptionsUPnL = null;
    /** Balance at session start — set once on first refresh */
    this._sessionStartBalance = null;
    /** Last computed options drift (negative = options lost value) */
    this._optionsDriftUsd = 0;
    /** Last computed trading drawdown in USD (balance drop + open perp loss) */
    this._tradingDrawdownUsd = 0;
    /** Latch for options-drift alert — re-arms when drift eases */
    this._optionsDriftAlertLatch = false;
    // Adaptive-levels state (set by hourly scheduler, never persisted to DB)
    this._adaptedAt = null;
    this._adaptedMaxSpreadCap = null;
    // Per-pair adapt intervals (loaded from DB on boot; null = use global defaults)
    this._adaptIntervalUsaMs      = null;
    this._adaptIntervalOffHoursMs = null;
    // Price range kill switch (closes perps + options at boundary)
    this._priceUpperLimit = null;
    this._priceLowerLimit = null;
    this._optionInstruments = [];
    this._priceRangeTriggered = false;
    // Option profit take-profit (close options + perps + stop when net option PnL >= target)
    this._optionProfitTargetUsd = 0;
    this._optionProfitTriggered = false;
    this._lastOptionPnlUsd = null;
  }
}

class UnilateralExecutor {
  constructor() {
    this.pairs = new Map();
    this.startedAt = Date.now();
  }

  _isLinearUsdc(state) {
    return _settlementCoinForState(state) === 'USDC';
  }

  _settlementCurrency(state) {
    return _settlementCoinForState(state);
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

  // Cross-the-book taker order (pays taker fee). Used as stop-loss fallback
  // when stopUseMarketOnBreach is enabled and a passive reprice fails to fill.
  // Guarantees immediate exit at the cost of the taker fee — on ETH-PERPETUAL
  // taker fee ≈ 0.05% of notional (~$0.03 on a $60 contract).
  async _placeMarket(state, side, qty) {
    const cred = state.clientA;
    const symbol = state.tradeSymbol || state.pair.symbol1;
    const result = side === 'buy'
      ? await buyorder(symbol, qty, 'market', null, cred.apiKey, cred.secretKey)
      : await sellorder(symbol, qty, 'market', null, cred.apiKey, cred.secretKey);
    const order = result?.result?.order;
    return {
      orderId: order?.order_id || null,
      state: order?.order_state || null,
      avgPrice: order?.average_price || order?.price || null,
    };
  }

  async _cancel(state, orderId) {
    if (!orderId) return null;
    try {
      const resp = await cancelorder(orderId, state.clientA.apiKey, state.clientA.secretKey);
      // cancelorder reconciles 11044 not_open_order races for us and returns
      //   { notOpen: true, orderState, order, reconciled: true }
      if (!resp || !resp.notOpen) return resp;

      const pairId = state?.pairId ?? state?.pair?.id ?? '?';
      const pos = (state.openPositions || []).find(
        (p) => p.entryOrderId === orderId || p.exitOrderId === orderId,
      );
      const role = pos
        ? (pos.entryOrderId === orderId ? 'entry' : 'exit')
        : null;

      // Only 'filled' races need the fill pipeline; cancelled/rejected/expired
      // mean the order is simply gone — nothing further to do.
      // ── Partial-fill on cancel: record how much filled so reprice uses remainder ──
      // If the order was partially_filled when cancelled, the filled portion is gone
      // from the exchange but the bot has no record of it. Store filledQty on pos so
      // the reprice loop can subtract it and not over-buy/over-sell.
      if (resp.orderState === 'partially_filled' && pos && role === 'exit') {
        const fresh = await this._getOrderStateFresh(state, orderId).catch(() => null);
        const partialFilled = fresh?.filledQty ?? 0;
        if (partialFilled > 0) {
          pos._partialExitFilled = (pos._partialExitFilled || 0) + partialFilled;
          console.warn(
            `[UniExec] pair ${state?.pairId ?? '?'} exit cancel PARTIAL_FILL ` +
            `order=${orderId} partialFilled=${partialFilled} totalPartial=${pos._partialExitFilled} origQty=${pos.qty}`
          );
        }
        return resp; // not raceHandled — reprice will use remaining qty
      }
      if (resp.orderState === 'filled' && pos && role) {
        console.warn(
          `[exec pair ${pairId}] cancel ${orderId} raced to FILL (${role}); routing through fill handler`,
        );
        if (pos.pollTimer) { clearInterval(pos.pollTimer); pos.pollTimer = null; }
        const st = await this._orderStatus(state, orderId);
        if (st.status !== 'filled') {
          console.warn(
            `[exec pair ${pairId}] cancel ${orderId} reconciled filled but _orderStatus returned ${st.status}; skipping fill handler`,
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
            `[exec pair ${pairId}] fill handler (${role}) failed for ${orderId}: ${e.message}`,
          );
          return resp;
        }
      }

      console.log(
        `[exec pair ${pairId}] cancel ${orderId} — already terminal (order_state=${resp.orderState}); skipping`,
      );
      return resp;
    } catch (_) {
      return null;
    }
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
        const settled = await this._waitOrderSettled(state, bp.legA_entryOrderId, 45_000);
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
          console.log(`[UniExecutor] pair ${pairId} bootstrap: pending_entry #${bp.id} → open @ ${settled.price}`);
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
          console.log(`[UniExecutor] pair ${pairId} bootstrap: pending_entry #${bp.id} → failed (order dead)`);
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
          // Derive isLong from DB direction field; fall back to tradeLeg convention.
          isLong: bp.direction ? bp.direction.toLowerCase() === 'buy' : (pair.tradeLeg || 'A').toUpperCase() === 'B',
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
          _repriced: false,
        });
        console.log(`[UniExecutor] pair ${pairId} bootstrap: pending_entry #${bp.id} still open — resuming poll`);
        continue;
      }

      // pending_exit or open with exit order in flight
      if (!bp.legA_exitOrderId) continue;
      const settled = await this._waitOrderSettled(state, bp.legA_exitOrderId, 45_000);
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
        console.log(`[UniExecutor] pair ${pairId} bootstrap: cleared ghost exit on #${bp.id}`);
        continue;
      }
      resume.exits.push(this._memoryPosFromDbRow(bp, pair, levels, 'pending_exit'));
      console.log(`[UniExecutor] pair ${pairId} bootstrap: exit still open on #${bp.id} — resuming poll`);
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
      tpDelta: p.tpDelta ?? null,
      slDelta: p.slDelta ?? null,
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
    console.log(`[UniExecutor] pair ${state.pairId} bootstrap: closed #${bp.id} exit fill @ ${exitPriceA} netPnl=${netPnl}`);
  }

  // isLong = true  → bot is LONG  (bought at entry, profit when price rises, exit by selling)
  // isLong = false → bot is SHORT (sold at entry, profit when price falls, exit by buying)
  // This is token-agnostic: works for BTC, ETH, SOL, or any future token on any leg.
  _estimateGrossPnlUsd(isLong, qty, entryPx, exitPx, isLinear = false) {
    if (!qty || !entryPx || !exitPx || entryPx <= 0 || exitPx <= 0) return 0;
    if (isLinear) {
      const pnl = isLong
        ? qty * (exitPx - entryPx)   // LONG:  profit when exitPx > entryPx
        : qty * (entryPx - exitPx);  // SHORT: profit when exitPx < entryPx
      return parseFloat(pnl.toFixed(6));
    }
    const pnlBtc = isLong
      ? qty * (1 / entryPx - 1 / exitPx)   // LONG inverse
      : qty * (1 / exitPx - 1 / entryPx);  // SHORT inverse
    return parseFloat((pnlBtc * exitPx).toFixed(6));
  }

  // Append the current traded-leg mid to the rolling price history and prune
  // samples older than the configured trendFilter window. Used by the trend
  // filter to detect directional regimes before opening new entries.
  // Parse the comma-separated disableIstHours string ("0,1,2,23") into a Set
  // of integers. Invalid / out-of-range entries are silently dropped. Returns
  // null when the list is empty/NULL so callers can cheap-check with a truthy
  // test and skip the whole filter.
  _parseIstHourList(raw) {
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

  // Current hour in Asia/Kolkata (IST, UTC+5:30). No DST; simple offset math
  // is safe and avoids a tz-library dependency.
  _currentIstHour() {
    const nowUtcMs = Date.now();
    const istMs = nowUtcMs + (5 * 60 + 30) * 60 * 1000;
    return new Date(istMs).getUTCHours();
  }

  _pushPriceSample(state, tradedMid) {
    if (!state.trendFilterPct) return;
    if (!Number.isFinite(tradedMid) || tradedMid <= 0) return;
    const now = Date.now();
    const win = state.trendFilterWindowMs || 60000;
    const hist = state._priceHistory;
    hist.push({ t: now, px: tradedMid });
    // Prune outside 2x window so we always have full coverage even when ticks are sparse.
    const cutoff = now - 2 * win;
    while (hist.length > 0 && hist[0].t < cutoff) hist.shift();
  }

  // Percentage price range over trendFilterWindowMs on the traded leg.
  // Returns null if we don't yet have enough data for a meaningful estimate.
  _computePriceDriftPct(state) {
    const hist = state._priceHistory;
    if (!hist || hist.length < 2) return null;
    const win = state.trendFilterWindowMs || 60000;
    const since = Date.now() - win;
    let min = Infinity, max = -Infinity, ref = null;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i].t < since) continue;
      const p = hist[i].px;
      if (ref == null) ref = p;
      if (p < min) min = p;
      if (p > max) max = p;
    }
    if (ref == null || !Number.isFinite(min) || !Number.isFinite(max) || ref <= 0) return null;
    return ((max - min) / ref) * 100;
  }

  // Projected gross USD for one round-trip given the current tpSpreadDelta,
  // entry price on the traded instrument, and quantity. Mirrors the PnL math
  // used by _estimateGrossPnlUsd so the edge filter aligns with real exits.
  _projectedTpGrossUsd(state, isLong, qty, entryPx) {
    const tp = state.tpSpreadDelta;
    if (!tp || !entryPx || !qty) return 0;
    // A TP-profitable narrowing of (futAsk − perpBid) by `tp` corresponds, on
    // the traded leg, to a price move of ~`tp` in the favourable direction:
    // LONG  exit fills higher → exitPx ≈ entryPx + tp
    // SHORT exit fills lower  → exitPx ≈ entryPx − tp
    const exitPx = isLong ? entryPx + tp : entryPx - tp;
    return this._estimateGrossPnlUsd(isLong, qty, entryPx, exitPx, this._isLinearUsdc(state));
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
        if ((feeCurrency === 'BTC' || feeCurrency === 'ETH') && px > 0) {
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
    // Use botStartedAt from DB so uptime is continuous across pm2 restarts.
    // Fall back to now only if this is the very first time the bot is started.
    state.enabledAt = pair.botStartedAt ? new Date(pair.botStartedAt).getTime() : Date.now();
    // Fresh timestamp for idle alert — always measures from this enable() call,
    // so re-enabling gives a clean 120-min grace window regardless of botStartedAt.
    state._enabledThisSessionAt = Date.now();
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

    // ── Pair-specific profitability config — all NULL = disabled (no-op) ──
    // These columns are NULL on every pair except pair 25 (ETH) so BTC and
    // other pairs keep the original behaviour byte-for-byte.
    state.fixedTpUsd             = pair.fixedTpUsd             != null && parseFloat(pair.fixedTpUsd)             > 0 ? parseFloat(pair.fixedTpUsd)             : null;
    state.maxSingleTradeLossUsd  = pair.maxSingleTradeLossUsd  != null && parseFloat(pair.maxSingleTradeLossUsd)  > 0 ? parseFloat(pair.maxSingleTradeLossUsd)  : null;
    state.grossNegativeScratchMs = pair.grossNegativeScratchMs != null && parseInt(pair.grossNegativeScratchMs)   > 0 ? parseInt(pair.grossNegativeScratchMs)   : null;
    // Hold-time cap (column-gated, NULL on pairs that should hold-to-exit).
    // When set, any position still open past maxHoldMs is force-flattened
    // via a passive 'hold_cap' exit. Derived from SIM-D of the full BTC
    // inception analysis — a 5 min cap flips H4 from -$155 to +$346.
    state.maxHoldMs              = pair.maxHoldMs              != null && parseInt(pair.maxHoldMs)                > 0 ? parseInt(pair.maxHoldMs)                : null;
    state.entryRequoteOnMovePx   = pair.entryRequoteOnMovePx   != null && parseFloat(pair.entryRequoteOnMovePx)   > 0 ? parseFloat(pair.entryRequoteOnMovePx)   : null;
    state.adaptMinTpSlRatio      = pair.adaptMinTpSlRatio      != null && parseFloat(pair.adaptMinTpSlRatio)      > 0 ? parseFloat(pair.adaptMinTpSlRatio)      : null;
    state.trendPauseJumpPct      = pair.trendPauseJumpPct      != null && parseFloat(pair.trendPauseJumpPct)      > 0 ? parseFloat(pair.trendPauseJumpPct)      : null;
    state.trendPauseDurationMs   = pair.trendPauseDurationMs   != null && parseInt(pair.trendPauseDurationMs)     > 0 ? parseInt(pair.trendPauseDurationMs)     : null;
    state._trendPauseUntil       = 0;

    // ── Entry profitability filters (column-gated, NULL on other pairs) ──
    // minEdgeUsd: projected gross USD (given current tpSpreadDelta) must meet
    //   this threshold or the entry is skipped. Prevents opening trades whose
    //   best case gross can't cover fees + slippage.
    // trendFilterPct / trendFilterWindowMs: look-back price drift filter.
    //   When set, entries are blocked while recent traded-leg price range
    //   exceeds trendFilterPct over trendFilterWindowMs (directional regime).
    state.minEdgeUsd             = pair.minEdgeUsd             != null && parseFloat(pair.minEdgeUsd)             > 0 ? parseFloat(pair.minEdgeUsd)             : null;
    state.trendFilterPct         = pair.trendFilterPct         != null && parseFloat(pair.trendFilterPct)         > 0 ? parseFloat(pair.trendFilterPct)         : null;
    state.trendFilterWindowMs    = pair.trendFilterWindowMs    != null && parseInt(pair.trendFilterWindowMs)      > 0 ? parseInt(pair.trendFilterWindowMs)      : 60000;
    state._priceHistory          = [];
    state._lastSkipReason        = null;
    state._skipCounts            = { edge: 0, trend: 0, trendPause: 0, hour: 0, streakCool: 0 };

    // ── Stop reprice / market fallback / streak cooldown / IST-hour gate ──
    // ETH opt-A profitability config. All NULL/empty = legacy behaviour.
    //   stopRepriceIntervalMs   — how often the stop-exit cancels+repostshot
    //                             (default 5000ms preserved when NULL).
    //   stopUseMarketOnBreach   — when set, after one reprice-interval without
    //                             a fill we cross the book with IOC/market so
    //                             the stop is enforced instead of chasing.
    //   stopStreakN             — if this many stop exits fire back-to-back…
    //   stopStreakCooldownN     — …skip this many subsequent new entries.
    //   disableIstHours         — comma-separated IST hours (0-23) to block
    //                             new entries ("0,1,2" pauses 00:00-02:59 IST).
    state.stopRepriceIntervalMs  = pair.stopRepriceIntervalMs  != null && parseInt(pair.stopRepriceIntervalMs)    > 0 ? parseInt(pair.stopRepriceIntervalMs)    : null;
    state.stopUseMarketOnBreach  = pair.stopUseMarketOnBreach  != null ? !!pair.stopUseMarketOnBreach : false;
    state.stopStreakN            = pair.stopStreakN            != null && parseInt(pair.stopStreakN)             > 0 ? parseInt(pair.stopStreakN)             : null;
    state.stopStreakCooldownN    = pair.stopStreakCooldownN    != null && parseInt(pair.stopStreakCooldownN)     > 0 ? parseInt(pair.stopStreakCooldownN)     : null;
    state.disableIstHours        = this._parseIstHourList(pair.disableIstHours);
    state._stopStreak            = 0;
    state._entryCooldownRemaining = 0;

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
    // Restore persisted peak equity so drawdown tracking survives restarts.
    // Only reset to null if no value has been recorded yet.
    const savedPeak = pair.peakEquity != null ? parseFloat(pair.peakEquity) : null;
    state._peakEquity = (savedPeak != null && Number.isFinite(savedPeak) && savedPeak > 0) ? savedPeak : null;
    state._currentEquity = null;
    state._currentDrawdownUsd = 0;
    state._currentDrawdownPct = 0;
    state._killSwitchTriggered = false;
    state._peakAccountEquity = null;
    state._accountEquityFull = null;
    state._equityDrawdownAlertLatch = false;
    state._sessionStartOptionsUPnL = null;
    state._sessionStartBalance = null;
    // Fresh session anchor: next account refresh will stamp DB sessionStartBalance
    // (full Deribit equity) + sessionStartedAt — every enable/re-enable and boot enable.
    state._startBalance = null;
    state._optionsDriftUsd = 0;
    state._tradingDrawdownUsd = 0;
    state._optionsDriftAlertLatch = false;

    // Price range kill switch for option-hedged strategies
    state._priceUpperLimit = pair.priceUpperLimit != null ? parseFloat(pair.priceUpperLimit) : null;
    state._priceLowerLimit = pair.priceLowerLimit != null ? parseFloat(pair.priceLowerLimit) : null;
    state._priceRangeTriggered = false;
    try {
      state._optionInstruments = pair.optionInstruments ? JSON.parse(pair.optionInstruments) : [];
    } catch (_) { state._optionInstruments = []; }
    const optTarget = pair.optionProfitTargetUsd != null ? parseFloat(pair.optionProfitTargetUsd) : 0;
    state._optionProfitTargetUsd = Number.isFinite(optTarget) && optTarget > 0 ? optTarget : 0;
    state._optionProfitTriggered = false;
    state._lastOptionPnlUsd = null;

    // Per-pair adapt cycle intervals (loaded from DB; null = global defaults apply)
    const rawUsaMs      = pair.adaptIntervalUsaMs      != null ? parseInt(pair.adaptIntervalUsaMs,      10) : null;
    const rawOffHoursMs = pair.adaptIntervalOffHoursMs != null ? parseInt(pair.adaptIntervalOffHoursMs, 10) : null;
    state._adaptIntervalUsaMs      = rawUsaMs      > 0 ? rawUsaMs      : null;
    state._adaptIntervalOffHoursMs = rawOffHoursMs > 0 ? rawOffHoursMs : null;

    // Reload positions from DB after restart: poll Deribit until entry/exit orders
    // are resolved — never blindly fail pending_entry; resume polling if still open.
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
          `[UniExecutor] pair ${pairId} reloaded ${state.openPositions.length} position(s) ` +
          `(resume entry=${resume.entries.length} exit=${resume.exits.length}, dbRows=${openRows.length})`
        );
      }
    } catch (e) {
      console.warn(`[UniExecutor] pair ${pairId} failed to reload open positions: ${e.message}`);
      state.openPositions = [];
    }

    this._broadcastState(pairId);
    // Await first refresh so session equity + sessionStartedAt are persisted before
    // returning from enable (covers API enable, agent enable, and boot auto-enable).
    await this._refreshAccountInfo(state).catch((e) =>
      console.warn(`[UniExecutor] pair ${pairId} session equity capture on enable failed: ${e.message}`)
    );
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

    // Fire a background inception analysis so we always have a fresh
    // reports/btc_full_inception_analysis_*.txt committed right before a
    // new BTC session starts placing orders.
    btcAnalysisHook.onEnable(pair);

    return { success: true, message: `Unilateral trading enabled (tradeLeg=${state.tradeLeg})`, pairId };
  }

  async disableTrading(pairId) {
    const state = this.pairs.get(pairId);
    if (!state || !state.enabled) return { success: false, message: 'Trading not enabled for this pair' };
    state.enabled = false;
    // Prevent any in-flight account refresh from triggering a false drawdown alert
    // after the user has already manually stopped the bot.
    state._killSwitchTriggered = true;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }
    const raceFilled = []; // entries that filled during the cancel race — require manual attention
    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      if (pos.entryOrderId) {
        const r = await this._cancel(state, pos.entryOrderId);
        if (r && r.raceHandled && r.role === 'entry') {
          raceFilled.push({ posId: pos.id, orderId: pos.entryOrderId, role: 'entry' });
        }
      }
      if (pos.exitOrderId) {
        // Exit race-fills just close the pos out cleanly; no manual action needed.
        await this._cancel(state, pos.exitOrderId);
      }
    }
    const closedCount = state.openPositions.length;
    state.openPositions = [];
    this._broadcastState(pairId);

    if (raceFilled.length > 0) {
      const lines = raceFilled
        .map((r) => `• pos ${r.posId} — ${r.role} order ${r.orderId}`)
        .join('\n');
      console.error(
        `[UniExec] pair ${pairId} DISABLE race: ${raceFilled.length} entry order(s) filled during cancel. ` +
        `Manual close on exchange required.\n${lines}`,
      );
      _sendTelegramAlert(
        `⚠️ <b>RACE FILL ON DISABLE</b>\n\n` +
        `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
        `Entry order(s) filled while we were cancelling:\n${lines}\n\n` +
        `Bot has been disabled but <b>position(s) remain OPEN on exchange</b>. ` +
        `Manual close required.`,
      );
    }

    await StatArbInput.update(
      { tradingEnabled: false, lastStopReason: 'manual_close', lastDisabledAt: new Date() },
      { where: { id: pairId } }
    ).catch(() => {});

    _sendTelegramAlert(
      `⏹️ <b>BOT STOPPED — CLOSED BY USER</b>\n\n` +
      `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Perp orders cancelled/closed: <b>${closedCount}</b>\n` +
      `Options: <b>UNTOUCHED</b> — manage manually on Deribit\n` +
      `Time: ${new Date().toUTCString()}`
    );

    // Fire a background inception analysis — captures end-of-session state
    // and leaves a fresh report on disk before the next enable.
    btcAnalysisHook.onDisable(state.pair);

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
      /** Full account equity (last refresh) vs peak — for equity drawdown % */
      accountEquityFull: Number.isFinite(state._accountEquityFull) ? state._accountEquityFull : null,
      peakAccountEquity: Number.isFinite(state._peakAccountEquity) ? state._peakAccountEquity : null,
      drawdownPct: state.drawdownPct || 0,
      currentDrawdownPct: state._currentDrawdownPct || 0,
      killSwitchTriggered,
      optionPnlUsd: state._lastOptionPnlUsd,
      optionProfitTargetUsd: state._optionProfitTargetUsd || 0,
      optionProfitTriggered: !!state._optionProfitTriggered,
      maxPositions: state.pair?.maxPositions != null ? parseInt(state.pair.maxPositions) : 1,
      zEntryThreshold: state.pair?.zEntryThreshold != null ? parseFloat(state.pair.zEntryThreshold) : null,
      maxSpreadCap: state._adaptedMaxSpreadCap ?? (state.pair?.maxSpreadCap != null ? parseFloat(state.pair.maxSpreadCap) : null),
      adaptedAt: state._adaptedAt,
      adaptedLevels: state._adaptedAt ? state.levels : null,
      // Entry-profitability filters — surfaced for the UI + diagnostics.
      fixedTpUsd: state.fixedTpUsd,
      minEdgeUsd: state.minEdgeUsd,
      trendFilterPct: state.trendFilterPct,
      trendFilterWindowMs: state.trendFilterWindowMs,
      trendPauseUntil: state._trendPauseUntil || 0,
      entrySkipCounts: state._skipCounts || { edge: 0, trend: 0, trendPause: 0, hour: 0, streakCool: 0 },
      lastSkipReason: state._lastSkipReason || null,
      recentPriceDriftPct: this._computePriceDriftPct(state),
      // Stop-exit + streak cooldown + IST-hour gate diagnostics
      stopRepriceIntervalMs: state.stopRepriceIntervalMs || null,
      stopUseMarketOnBreach: !!state.stopUseMarketOnBreach,
      stopStreakN: state.stopStreakN || null,
      stopStreakCooldownN: state.stopStreakCooldownN || null,
      stopStreak: state._stopStreak || 0,
      entryCooldownRemaining: state._entryCooldownRemaining || 0,
      disableIstHours: state.disableIstHours ? [...state.disableIstHours].sort((a,b)=>a-b) : null,
      // ── Session metrics (since last enable) ──────────────────────────────
      // sessionStartedAt: persisted to DB on first account refresh after enable;
      //   also available from pair.sessionStartedAt but keeping here so the
      //   frontend doesn't need a separate DB poll for live pairs.
      // sessionPnlNative: balance change from session start + open perp unrealised
      //   (native currency — ETH for ETH-PERP, BTC for BTC-PERP).
      //   NULL until first account refresh lands (~30 s after enable).
      // sessionStartBalance: the native balance snapshot taken at enable time.
      sessionStartedAt: state.pair?.sessionStartedAt ?? null,
      sessionPnlNative: Number.isFinite(state._tradingPnlNative)
        ? parseFloat(state._tradingPnlNative.toFixed(8)) : null,
      sessionStartBalance: Number.isFinite(state._startBalance)
        ? parseFloat(state._startBalance.toFixed(8)) : null,
      positions: state.openPositions.filter((p) => p.status === 'open').map((p) => ({
        gridLevel: p.gridLevel,
        fillSpread: p.fillSpread,
        bestSpread: p.bestSpread,
        profitTicks: p.profitTicks,
        stopTicks: p.stopTicks,
        holdSec: p.openedAt ? Math.round((Date.now() - p.openedAt) / 1000) : 0,
      })),
    };
  }

  /**
   * Snapshot of why exits may be slow and whether new entries are blocked (grid full).
   * Uses the same signalSpread = futAsk − perpBid and TP/SL math as onSpreadUpdate.
   */
  getExitDiagnostics(pairId) {
    const state = this.pairs.get(pairId);
    if (!state) {
      return { pairId, enabled: false, error: 'Pair not loaded in executor (enable trading or restart backend).' };
    }
    const pair = state.pair;
    const maxPos = pair?.maxPositions != null ? parseInt(pair.maxPositions, 10) : 1;
    const openList = state.openPositions.filter((p) => p.status === 'open');
    const openCountAll = state.openPositions.filter((p) => p.status !== 'closed').length;
    const zMin = pair?.zEntryThreshold != null ? parseFloat(pair.zEntryThreshold) : 0;
    const zMax = pair?.zEntryMax != null ? parseFloat(pair.zEntryMax) : null;

    let orderbookManager;
    try {
      orderbookManager = require('./orderbookStreams');
    } catch (_) {
      orderbookManager = null;
    }
    const midTick = orderbookManager?.getLastMidSpreadPoint?.(pairId) ?? null;

    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const futAsk = parseFloat(ob1?.asks?.[0]?.price || 0);
    const futBid = parseFloat(ob1?.bids?.[0]?.price || 0);
    const perpBid = parseFloat(ob2?.bids?.[0]?.price || 0);
    const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
    const booksOk = !!(futAsk && futBid && perpBid);
    const signalSpread = booksOk ? parseFloat((futAsk - perpBid).toFixed(4)) : null;
    const perpMid =
      perpBid > 0 && perpAsk > 0 ? parseFloat(((perpBid + perpAsk) / 2).toFixed(2)) : null;

    const isLinear = this._isLinearUsdc(state);
    // tradedOb = orderbook of the instrument actually traded (leg1 for A, leg2 for B)
    const tradedObBroadcast = (state.tradeLeg || 'A').toUpperCase() === 'B' ? ob2 : ob1;

    const TP_CONFIRM_TICKS = 3;
    const SL_CONFIRM_TICKS = 7;

    const positions = openList.map((pos) => {
      const posTp = pos.tpDelta ?? state.tpSpreadDelta;
      const posSl = pos.slDelta ?? state.slSpreadDelta;
      const slBaseline = pos.entrySignalSpread ?? pos.fillSpread;
      const entrySig = pos.entrySignalSpread ?? pos.fillSpread;

      let grossPositive = false;
      let estGrossUsd = 0;
      if (booksOk && pos.entryPriceA) {
        const posIsLong = pos.isLong ?? ((state.tradeLeg || 'A').toUpperCase() === 'B');
        // MAKER exit estimation:
        // LONG  maker exit: limit SELL rests at ASK → estimate exit at current ASK
        // SHORT maker exit: limit BUY  rests at BID → estimate exit at current BID
        const posCurPrice = posIsLong
          ? parseFloat(tradedObBroadcast?.asks?.[0]?.price || 0)
          : parseFloat(tradedObBroadcast?.bids?.[0]?.price || 0);
        if (posCurPrice) {
          grossPositive = posIsLong
            ? posCurPrice > pos.entryPriceA   // LONG:  ask_now > bid_at_entry
            : posCurPrice < pos.entryPriceA;  // SHORT: bid_now < ask_at_entry
          estGrossUsd = this._estimateGrossPnlUsd(
            posIsLong, pos.qty, pos.entryPriceA, posCurPrice, isLinear
          );
        }
      }

      let spreadTpMet = false;
      let spreadNarrowing = null;
      let tpDistanceLeft = null;
      if (signalSpread != null && entrySig != null && posTp != null) {
        spreadNarrowing = parseFloat((entrySig - signalSpread).toFixed(4));
        tpDistanceLeft = parseFloat(Math.max(0, posTp - spreadNarrowing).toFixed(4));
        spreadTpMet =
          spreadNarrowing >= posTp &&
          grossPositive &&
          (minGrossProfitUsd() <= 0 || estGrossUsd >= minGrossProfitUsd());
      }

      let spreadWidening = null;
      let slDistanceLeft = null;
      if (signalSpread != null && slBaseline != null && posSl != null) {
        spreadWidening = parseFloat((signalSpread - slBaseline).toFixed(4));
        slDistanceLeft = parseFloat(Math.max(0, posSl - spreadWidening).toFixed(4));
      }

      let basisId = null;
      if (typeof pos.id === 'string' && pos.id.startsWith('reload_')) {
        basisId = parseInt(pos.id.replace('reload_', ''), 10);
      }

      return {
        basisPositionId: Number.isFinite(basisId) ? basisId : null,
        gridLevel: pos.gridLevel,
        entrySignalSpread: entrySig,
        tpDeltaUsd: posTp,
        slDeltaUsd: posSl,
        profitTicks: pos.profitTicks || 0,
        stopTicks: pos.stopTicks || 0,
        ticksNeedTp: TP_CONFIRM_TICKS,
        ticksNeedSl: SL_CONFIRM_TICKS,
        grossPositive,
        estGrossPnlUsd: parseFloat((estGrossUsd || 0).toFixed(4)),
        spreadNarrowingUsd: spreadNarrowing,
        tpDistanceLeftUsd: tpDistanceLeft,
        tpProgress: posTp > 0 && spreadNarrowing != null ? parseFloat((spreadNarrowing / posTp).toFixed(4)) : null,
        spreadWideningUsd: spreadWidening,
        slDistanceLeftUsd: slDistanceLeft,
        slProgress: posSl > 0 && spreadWidening != null ? parseFloat((spreadWidening / posSl).toFixed(4)) : null,
        spreadTpCondition: spreadTpMet,
        bestSpread: pos.bestSpread ?? null,
        holdSec: pos.openedAt ? Math.round((Date.now() - pos.openedAt) / 1000) : 0,
      };
    });

    return {
      pairId,
      enabled: !!state.enabled,
      executor: 'v1',
      atCapacity: openCountAll >= maxPos,
      capacity: {
        maxPositions: maxPos,
        openSlots: openCountAll,
        openForExitLogic: openList.length,
      },
      gates: {
        killSwitchTriggered: !!state._killSwitchTriggered,
        priceRangeTriggered: !!state._priceRangeTriggered,
        priceUpperLimit: state._priceUpperLimit ?? null,
        priceLowerLimit: state._priceLowerLimit ?? null,
        perpMid,
        dailyPnl: state.dailyPnl ?? 0,
        dailyLossLimitUsd: state.dailyLossLimitUsd ?? 0,
      },
      entrySignalGate: {
        zEntryMin: zMin,
        zEntryMax: zMax != null && Number.isFinite(zMax) ? zMax : null,
        midTrackerZ: midTick?.zScore != null ? parseFloat(midTick.zScore.toFixed(4)) : null,
        midTrackerSpread: midTick?.spread != null ? parseFloat(Number(midTick.spread).toFixed(6)) : null,
        note:
          'Executor entries use sell-side z from the orderbook feed. zScore here is from the mid spread tracker (same window as charts).',
      },
      spread: {
        signalSpreadUsd: signalSpread,
        futAsk,
        futBid,
        perpBid,
        perpAsk,
        booksOk,
        explanation: booksOk
          ? 'signalSpread = leg1 best ask − leg2 best bid (matches onSpreadUpdate).'
          : 'Order book cache empty — wait for WS ticks or check pair subscriptions.',
      },
      positions,
      generatedAt: new Date().toISOString(),
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
      openOrders: state._openOrders || [],
      feeLevel: state._feeLevel ?? null,
      makerRebate: state._makerRebate ?? null,
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

      // Fetch futures, options + orders in parallel
      const [posResp, optPosResp, ordersResp] = await Promise.all([
        signedRequest(
          `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
          state.clientA.apiKey, state.clientA.secretKey
        ),
        signedRequest(
          `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
          state.clientA.apiKey, state.clientA.secretKey
        ).catch(() => null),
        signedRequest(
          `/api/v2/private/get_open_orders_by_currency?currency=${ccy}`,
          state.clientA.apiKey, state.clientA.secretKey
        ).catch(() => null),
      ]);

      // Full account equity = Deribit acct.equity (balance + all unrealised PnL incl. options).
      const futPositions = Array.isArray(posResp?.result) ? posResp.result : [];
      const optPositions = Array.isArray(optPosResp?.result) ? optPosResp.result : [];

      // Options unrealised PnL (settlement ccy: ETH for inverse, USD for linear)
      const optionsUPnL = optPositions.reduce((sum, p) => sum + (p.floating_profit_loss || 0), 0);
      // Perp unrealised PnL
      const perpUPnL = futPositions
        .filter(p => p.size !== 0)
        .reduce((sum, p) => sum + (p.floating_profit_loss || 0), 0);

      const fullEquity = acct.equity ?? acct.balance;
      state._currentEquity = fullEquity;

      // ── Record session-start anchors on first refresh ─────────────────────
      if (state._sessionStartBalance === null) {
        state._sessionStartBalance = acct.balance;
        state._sessionStartOptionsUPnL = optionsUPnL;
      }

      // ── Compute split: trading PnL vs options drift ───────────────────────
      // Options drift = change in options unrealised PnL since session start
      // (measures market movement on the hedge, NOT bot trading)
      // Must be computed first so tradingPnl can subtract it.
      const optionsDrift = optionsUPnL - state._sessionStartOptionsUPnL;

      // Trading PnL = total equity change since session start MINUS options drift.
      // This isolates what the bot's own perp trades contributed, correctly
      // accounting for the options hedge (e.g. long calls offsetting short-perp losses
      // when ETH pumps).  Using cash acct.balance was wrong — it excluded options
      // unrealised that Deribit marks in real-time and caused false kill triggers.
      const tradingPnl = (fullEquity - (state._startBalance ?? (state._sessionStartBalance + (state._sessionStartOptionsUPnL ?? 0)))) - optionsDrift;
      state._tradingDrawdownUsd = 0;  // reset; set by _checkSmartDrawdown below
      state._optionsDriftUsd = 0;     // reset; set by _checkSmartDrawdown below

      // Store on state for UI broadcast
      state._tradingPnlNative = tradingPnl;
      state._optionsDriftNative = optionsDrift;

      if (state._startBalance == null && fullEquity != null) {
        state._startBalance = fullEquity;
        StatArbInput.update(
          {
            sessionStartBalance: fullEquity,
            sessionStartedAt: new Date(),
          },
          { where: { id: pairId } }
        ).catch(() => {});
        StatArbInput.update(
          { botStartBalance: fullEquity, botStartedAt: new Date() },
          { where: { id: pairId, botStartBalance: null } }
        ).catch(() => {});
        console.log(`[UniExecutor] pair ${pairId} session start equity: ${fullEquity} ${ccy}`);
      }
      if (fullEquity != null) {
        if (state._peakEquity == null || fullEquity > state._peakEquity) {
          state._peakEquity = fullEquity;
          StatArbInput.update({ peakEquity: fullEquity }, { where: { id: pairId } }).catch(() => {});
        }
        if (state.maxDrawdownUsd > 0) {
          this._checkSmartDrawdown(state, acct, tradingPnl, optionsDrift).catch(e =>
            console.error(`[UniExec] drawdown check error pair ${pairId}: ${e.message}`)
          );
        }
      }
      this._updateEquityDrawdownAndAlert(state, acct).catch(e =>
        console.error(`[UniExec] equity drawdown check error pair ${pairId}: ${e.message}`)
      );
      if (state._optionProfitTargetUsd > 0 && !state._optionProfitTriggered) {
        this._checkOptionProfitTakeProfit(state).catch(e =>
          console.error(`[UniExec] option profit TP check error pair ${pairId}: ${e.message}`)
        );
      }

      // ── Idle alert: no trade for > 120 min ──────────────────────────
      this._checkIdleAlert(state);
      state._livePositions = futPositions.filter(p => p.size !== 0).map(p => ({
        instrument: p.instrument_name,
        direction: p.direction,
        size: p.size,
        avgPrice: p.average_price,
        unrealizedPnl: p.floating_profit_loss,
      }));
      state._openOrders = (Array.isArray(ordersResp?.result) ? ordersResp.result : []).map(o => ({
        orderId: String(o.order_id || ''),
        instrument: o.instrument_name || '',
        direction: o.direction || '',
        amount: parseFloat(o.amount ?? 0),
        price: parseFloat(o.price ?? 0),
        filledAmount: parseFloat(o.filled_amount ?? 0),
        orderType: o.order_type || 'limit',
        label: o.label || '',
      }));
      // Cumulative maker rebate from DB
      try {
        const { sequelize } = require('../models');
        // commission is stored in USD by _getOrderCommissionUsd (fee × price for all currencies)
        const [[row]] = await sequelize.query(
          `SELECT COALESCE(SUM(commission), 0) AS total
           FROM trade_logs WHERE pairId = :pairId AND status = 'filled' AND commission > 0`,
          { replacements: { pairId } }
        );
        state._makerRebate = parseFloat(Math.abs(row.total).toFixed(4));
      } catch (_) { }
      try {
        const orderbookManager = require('./orderbookStreams');
        orderbookManager.broadcast({ type: 'account_info', pairId, ...this.getAccountInfo(pairId) });
      } catch (_) { }
    } catch (e) {
      console.warn(`[UniExecutor] _refreshAccountInfo pair ${state.pairId}: ${e.message}`);
    }
  }

  // ── idle alert (no trade > 120 min) ─────────────────────────────────────────
  _checkIdleAlert(state) {
    if (!state.enabled || state._killSwitchTriggered) return;
    // Suppress false-positive idle alerts when we are intentionally blocking
    // entries due to disableIstHours — the bot is working as designed during
    // those hours, so silence is expected and should not page.
    if (state.disableIstHours && state.disableIstHours.has(this._currentIstHour())) return;
    const IDLE_MS   = 120 * 60 * 1000;
    const REPEAT_MS = 60  * 60 * 1000;
    const now       = Date.now();
    const refTime   = state.lastEntryAt > 0
      ? state.lastEntryAt
      : (state._enabledThisSessionAt || now);
    const idleMs    = now - refTime;
    if (idleMs < IDLE_MS) { state._idleAlertSentAt = 0; return; }
    if (state._idleAlertSentAt > 0 && (now - state._idleAlertSentAt) < REPEAT_MS) return;
    state._idleAlertSentAt = now;
    const idleMin = Math.round(idleMs / 60000);
    const since   = state.lastEntryAt > 0 ? new Date(state.lastEntryAt).toUTCString() : 'bot start';
    console.warn(`[UniExec] ⚠ IDLE ALERT pair ${state.pairId} — no trade for ${idleMin}m`);
    _sendTelegramAlert(
      `⚠️ <b>BOT IDLE ALERT</b>\n\n` +
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

  /**
   * Smart drawdown: split portfolio drawdown into TRADING losses vs OPTIONS drift.
   *
   * Rule 1 — TRADING KILL:
   *   If the bot's own trades have lost >= maxDrawdownUsd from session start
   *   (measured as: balance drop + open perp unrealised loss)
   *   → stop bot, emergency-close all open orders/positions.
   *
   * Rule 2 — OPTIONS ALERT:
   *   If total equity dropped >= maxDrawdownUsd but trading losses are < 50% of limit
   *   (i.e. the drawdown is primarily options price drift, not bot trading)
   *   → send Telegram alert only, bot keeps running.
   *
   * Rule 3 — MIXED KILL:
   *   If total equity dropped >= maxDrawdownUsd AND trading losses >= 50% of limit
   *   → stop bot (trading is a significant contributor even if options also hurting).
   */
  async _checkSmartDrawdown(state, acct, tradingPnlNative, optionsDriftNative) {
    if (!state.enabled || state._killSwitchTriggered) return;
    if (state.maxDrawdownUsd <= 0) return;

    // Convert native (ETH/BTC) PnL figures to USD
    let price = 0;
    if (this._isLinearUsdc(state)) {
      price = 1;
    } else {
      if (acct && acct.equity > 0 && acct.estimated_balance != null) {
        price = acct.estimated_balance / acct.equity;
      }
      if (!price || price <= 0) {
        const ob1 = state.lastOrderbooks?.leg1;
        const bid = parseFloat(ob1?.bids?.[0]?.price || 0);
        const ask = parseFloat(ob1?.asks?.[0]?.price || 0);
        price = bid && ask ? (bid + ask) / 2 : 0;
      }
      if (!price || price <= 0) return;
    }

    // Trading drawdown = how much the bot's trades have cost (positive = loss)
    const tradingDrawdownUsd = parseFloat((-tradingPnlNative * price).toFixed(2));
    // Options drift loss = how much options moved against us (positive = loss)
    const optionsDriftLossUsd = parseFloat((-optionsDriftNative * price).toFixed(2));

    state._tradingDrawdownUsd = tradingDrawdownUsd;
    state._optionsDriftUsd = optionsDriftLossUsd;

    // Total equity drawdown from session start
    // Prefer _startBalance (equity anchor) over the legacy cash+options reconstruction.
    const sessionStartEquity = state._startBalance
      ?? (state._sessionStartBalance + (state._sessionStartOptionsUPnL ?? 0));
    const totalDrawdownUsd = parseFloat(((sessionStartEquity - (state._currentEquity ?? sessionStartEquity)) * price).toFixed(2));
    state._currentDrawdownUsd = Math.max(0, totalDrawdownUsd);

    const limit = state.maxDrawdownUsd;
    const pairId = state.pairId;
    const ccy = this._settlementCurrency(state);

    // ── Rule 1 & 3: Trading losses >= limit → KILL ───────────────────────
    if (tradingDrawdownUsd >= limit) {
      state._killSwitchTriggered = true;
      console.error(
        `[UniExec] *** TRADING DRAWDOWN KILL *** pair ${pairId} | ` +
        `tradingLoss=$${tradingDrawdownUsd.toFixed(2)} >= limit=$${limit} | ` +
        `optionsDrift=$${optionsDriftLossUsd.toFixed(2)} | ` +
        `balance=${acct.balance?.toFixed(6)} ${ccy}`
      );
      await this._cancelPendingEntriesOnly(state, 'drawdown_kill_switch');
      return;
    }

    // ── Rule 2: Total equity drop >= limit but trading is NOT the main cause → ALERT ──
    if (totalDrawdownUsd >= limit) {
      const tradingShare = tradingDrawdownUsd / limit; // fraction of limit consumed by trading

      if (tradingShare < 0.5) {
        // Options are the primary driver — alert only, keep trading
        if (!state._optionsDriftAlertLatch) {
          state._optionsDriftAlertLatch = true;
          console.warn(
            `[UniExec] *** OPTIONS DRIFT ALERT *** pair ${pairId} | ` +
            `totalDrop=$${totalDrawdownUsd.toFixed(2)} | ` +
            `optionsDrift=$${optionsDriftLossUsd.toFixed(2)} | ` +
            `tradingLoss=$${tradingDrawdownUsd.toFixed(2)} (${(tradingShare*100).toFixed(0)}% of limit) | ` +
            `bot continues trading`
          );
          _sendTelegramAlert(
            `⚠️ <b>OPTIONS DRIFT ALERT</b> — bot continues\n\n` +
            `Pair: <b>${pairId}</b>\n` +
            `Total equity drop: <b>$${totalDrawdownUsd.toFixed(2)}</b> (limit $${limit})\n` +
            `Options drift loss: <b>$${optionsDriftLossUsd.toFixed(2)}</b> ← main cause\n` +
            `Trading loss: <b>$${tradingDrawdownUsd.toFixed(2)}</b> (${(tradingShare*100).toFixed(0)}% of limit)\n` +
            `Action: <b>Alert only — options moved, not trading losses</b>\n` +
            `Time: ${new Date().toUTCString()}`
          );
        }
      } else {
        // Mixed: options + trading both contributing, trading > 50% of limit → kill
        state._killSwitchTriggered = true;
        console.error(
          `[UniExec] *** MIXED DRAWDOWN KILL *** pair ${pairId} | ` +
          `totalDrop=$${totalDrawdownUsd.toFixed(2)} >= limit=$${limit} | ` +
          `tradingLoss=$${tradingDrawdownUsd.toFixed(2)} (${(tradingShare*100).toFixed(0)}% of limit) | ` +
          `optionsDrift=$${optionsDriftLossUsd.toFixed(2)}`
        );
        await this._cancelPendingEntriesOnly(state, 'drawdown_kill_switch');
      }
    } else {
      // Equity recovered — re-arm options drift alert latch
      if (state._optionsDriftAlertLatch && totalDrawdownUsd < limit * 0.7) {
        state._optionsDriftAlertLatch = false;
      }
    }
  }

  /**
   * Drawdown from full Deribit account equity (peak `equity` → current `equity`).
   * Updates `currentDrawdownPct` for UI. When `drawdownPct` is set on the pair,
   * sends Telegram once per breach (re-arms after drawdown falls below 90% of threshold).
   * Alert only — does not stop the bot or close positions.
   */
  async _updateEquityDrawdownAndAlert(state, acct) {
    if (!state.enabled || state._killSwitchTriggered) return;
    const eqRaw = acct?.equity;
    const eq = eqRaw != null ? parseFloat(eqRaw) : NaN;
    if (!Number.isFinite(eq) || eq <= 0) return;

    state._accountEquityFull = eq;
    if (state._peakAccountEquity == null || eq > state._peakAccountEquity) {
      state._peakAccountEquity = eq;
    }
    const peak = state._peakAccountEquity;
    const ddPct = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    state._currentDrawdownPct = parseFloat(Math.max(0, ddPct).toFixed(4));

    if (state.drawdownPct <= 0) return;

    const limit = state.drawdownPct;
    const hysteresis = limit * 0.9;
    if (ddPct >= limit) {
      if (!state._equityDrawdownAlertLatch) {
        state._equityDrawdownAlertLatch = true;
        const ccy = this._settlementCurrency(state);
        const pairId = state.pairId;
        console.warn(
          `[UniExec] EQUITY DRAWDOWN ALERT pair ${pairId} | ` +
          `drawdown=${ddPct.toFixed(2)}% (peak=${peak} ${ccy} → equity=${eq} ${ccy}) | limit=${limit}%`
        );
        _sendTelegramAlert(
          `📉 <b>EQUITY DRAWDOWN ALERT</b>\n\n` +
          `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
          `Peak equity: <b>${peak}</b> ${ccy}\n` +
          `Current equity: <b>${eq}</b> ${ccy}\n` +
          `Drawdown: <b>${ddPct.toFixed(2)}%</b> (limit <b>${limit}%</b>)\n\n` +
          `Alert only — bot not stopped by this rule.\n` +
          `Time: ${new Date().toUTCString()}`
        );
      }
    } else if (ddPct < hysteresis) {
      state._equityDrawdownAlertLatch = false;
    }
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
      `[UniExec] *** PRICE RANGE KILL SWITCH *** pair ${state.pairId} | ` +
      `price=$${btcPrice.toFixed(2)} hit ${direction} limit=$${limit} | ` +
      `closing perps + open orders — options UNTOUCHED (manual close required)`
    );

    // Alert fires BEFORE close so user knows exactly what happened
    _sendTelegramAlert(
      `${arrow} <b>PRICE BAND HIT — BOT STOPPING</b>\n\n` +
      `Pair: <b>${state.pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Price: <b>$${btcPrice.toFixed(2)}</b> hit <b>${direction}</b> band ($${limit})\n\n` +
      `✅ Perp positions + open orders: <b>CLOSING (maker)</b>\n` +
      `🔒 Options: <b>UNTOUCHED</b> — close manually on Deribit\n\n` +
      `Bot disabled until manually re-enabled.\n` +
      `Time: ${new Date().toUTCString()}`
    );

    await this._emergencyCloseAll(state, `price_range_${direction.toLowerCase()}`);
    // _closeOptionPositions intentionally NOT called — options are never auto-closed.
  }

  async _closeOptionPositions(state) {
    if (!state.clientA) return;
    const pairId = state.pairId;
    console.log(`[UniExec] Closing option positions for pair ${pairId}...`);

    try {
      const ccy = _optionCurrency(state);
      const optPositions = await signedRequest(
        `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const liveOptions = (optPositions?.result || []).filter(p => p.size !== 0);

      if (liveOptions.length === 0) {
        console.log(`[UniExec] No open option positions to close for pair ${pairId}`);
        return;
      }

      const tracked = new Set(state._optionInstruments.map(o => o.name));

      for (const pos of liveOptions) {
        if (tracked.size > 0 && !tracked.has(pos.instrument_name)) continue;

        const closeSize = Math.abs(pos.size);
        const closeSide = pos.size > 0 ? 'sell' : 'buy';

        // Options must NEVER be closed with market orders.
        // Fetch best bid/ask first; use best_bid for SELL closes and
        // best_ask for BUY closes — marketable limit, guaranteed fill at
        // a known price with no slippage. Fallback to mark_price only if
        // book is completely empty. Skip entirely if no price is available.
        let limitPrice = null;
        try {
          const tk = await signedRequest(
            `/api/v2/public/ticker?instrument_name=${pos.instrument_name}`,
            state.clientA.apiKey, state.clientA.secretKey
          );
          const r = tk?.result || {};
          const bid = parseFloat(r.best_bid_price);
          const ask = parseFloat(r.best_ask_price);
          if (closeSide === 'sell' && bid > 0)       limitPrice = bid;
          else if (closeSide === 'buy'  && ask > 0)  limitPrice = ask;
          else if (parseFloat(r.mark_price) > 0)     limitPrice = parseFloat(r.mark_price);
        } catch (e) {
          console.warn(`[UniExec] ticker fetch failed for ${pos.instrument_name}: ${e.message}`);
        }

        if (!limitPrice || !Number.isFinite(limitPrice) || limitPrice <= 0) {
          console.error(
            `[UniExec] SKIP close ${pos.instrument_name} — no valid limit price ` +
            `(bid/ask/mark all unavailable). Manual intervention required.`
          );
          continue;
        }

        console.log(
          `[UniExec] Closing option ${pos.instrument_name} | ${closeSide} ${closeSize} ` +
          `@ LIMIT ${limitPrice} | mark=${pos.mark_price} | uPnL=${pos.floating_profit_loss}`
        );

        try {
          const path = `/api/v2/private/${closeSide}?instrument_name=${pos.instrument_name}` +
            `&amount=${closeSize}&type=limit&price=${limitPrice}&reduce_only=true`;
          const result = await signedRequest(path, state.clientA.apiKey, state.clientA.secretKey);
          const order = result?.result?.order;
          if (order) {
            console.log(
              `[UniExec] Option close LIMIT placed: ${order.order_id} | ` +
              `${pos.instrument_name} ${closeSide} ${closeSize} @ ${limitPrice} | state=${order.order_state}`
            );
          }
        } catch (e) {
          console.error(`[UniExec] Failed to close option ${pos.instrument_name}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`[UniExec] Failed to fetch option positions for pair ${pairId}: ${e.message}`);
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
          const upl = (p.floating_profit_loss || 0);
          perpLines.push(`  • ${p.instrument_name} ${dir} ${Math.abs(p.size)} | uPnL: ${upl >= 0 ? '+' : ''}${(upl * (btcIndex || 1)).toFixed(2)} USD`);
        }
      } catch (_) {}

      // ── Fetch option positions ─────────────────────────────────────────
      const optRes = await signedRequest(
        `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
        state.clientA.apiKey, state.clientA.secretKey
      );
      const liveOptions = (optRes?.result || []).filter(p => p.size !== 0);
      if (liveOptions.length === 0 && perpPnlCcy === 0) return;

      // Support both plain-string arrays ["ETH-24APR26-2350-C"] and
      // object arrays [{"name":"ETH-24APR26-2350-C","size":-100}]
      const tracked = new Set(
        state._optionInstruments
          .map(o => (typeof o === 'string' ? o : o?.name))
          .filter(Boolean)
      );
      // Compute net PnL explicitly as (mark_price − average_price) × size for every
      // tracked leg. This gives the true entry-cost-based PnL (matches what the
      // exchange UI shows and matches account.options_pl for both ETH and BTC).
      // We deliberately avoid floating_profit_loss because for BTC inverse-settled
      // options it includes a path-dependent delta adjustment that overstates PnL
      // when BTC price rises — causing false-positive alerts.
      let optionPnlCcy = 0;
      for (const p of liveOptions) {
        if (tracked.size > 0 && !tracked.has(p.instrument_name)) continue;
        const avgPx  = parseFloat(p.average_price) || 0;
        const markPx = parseFloat(p.mark_price)    || 0;
        const size   = parseFloat(p.size)           || 0;
        optionPnlCcy += (markPx - avgPx) * size;
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

      // Reset the flag when PnL drops back below target so the alert can fire again
      // on the next upswing (e.g. after markets move).
      if (netPnlUsd < state._optionProfitTargetUsd) {
        state._optionProfitTriggered = false;
        return;
      }

      if (!state._optionProfitTriggered) {
        state._optionProfitTriggered = true; // rate-limit: alert fires once per threshold cross
        console.warn(
          `[UniExec] *** POSITION PnL ALERT *** pair ${state.pairId} | ` +
          `netPnl=$${netPnlUsd.toFixed(2)} (perp=$${perpPnlUsd.toFixed(2)} opt=$${optionPnlUsd.toFixed(2)}) >= target=$${state._optionProfitTargetUsd} | ` +
          `ALERT ONLY — no positions closed, bot continues`
        );

        // Build per-instrument PnL breakdown for the alert
        const trackedOptions = liveOptions.filter(p => tracked.size === 0 || tracked.has(p.instrument_name));
        const optLines = trackedOptions.map(p => {
          const avgPx  = parseFloat(p.average_price) || 0;
          const markPx = parseFloat(p.mark_price)    || 0;
          const size   = parseFloat(p.size)           || 0;
          const legPnlUsd = (markPx - avgPx) * size * btcIndex;
          const dir = size > 0 ? 'LONG' : 'SHORT';
          const sign = legPnlUsd >= 0 ? '+' : '';
          return `  • ${p.instrument_name} ${dir} ${Math.abs(size)} | avg ${avgPx} → mark ${markPx} | uPnL: <b>${sign}$${legPnlUsd.toFixed(2)}</b>`;
        }).join('\n');

        const perpSection = perpLines.length
          ? `<b>📈 Perp Positions</b>\n${perpLines.join('\n')}\n  Perp uPnL total: <b>${perpPnlUsd >= 0 ? '+' : ''}$${perpPnlUsd.toFixed(2)}</b>\n\n`
          : `<b>📈 Perp Positions</b>  none\n\n`;
        const optSection = optLines
          ? `<b>📊 Option Positions</b>\n${optLines}\n  Option uPnL total: <b>${optionPnlUsd >= 0 ? '+' : ''}$${optionPnlUsd.toFixed(2)}</b>\n\n`
          : `<b>📊 Option Positions</b>  none\n\n`;

        _sendTelegramAlert(
          `💰 <b>POSITION PnL TARGET REACHED — ALERT</b>\n\n` +
          `Pair: <b>${state.pairId}</b> (${state.pair?.agentName || ''})\n` +
          `<b>Net PnL (perp + options): $${netPnlUsd.toFixed(2)}</b>\n` +
          `  Perp uPnL:    ${perpPnlUsd >= 0 ? '+' : ''}$${perpPnlUsd.toFixed(2)}\n` +
          `  Option uPnL:  ${optionPnlUsd >= 0 ? '+' : ''}$${optionPnlUsd.toFixed(2)}\n` +
          `Target threshold: <b>$${state._optionProfitTargetUsd}</b>\n` +
          `Index price: $${btcIndex.toFixed(2)}\n\n` +
          perpSection + optSection +
          `ℹ️ Bot is <b>still running</b>. No positions were closed.\n` +
          `👉 <b>Review and close positions manually on Deribit when ready.</b>\n\n` +
          `Time: ${new Date().toUTCString()}`
        );
      }
    } catch (e) {
      console.error(`[UniExec] _checkOptionProfitTakeProfit error pair ${state.pairId}: ${e.message}`);
    }
  }

  /**
   * Cancel ALL open orders (entry + exit) on the exchange and update DB.
   * Positions themselves are NOT force-closed — perp positions remain on the
   * exchange and the user closes them manually.
   * Disables the bot (no new entries).
   */
  async _cancelPendingEntriesOnly(state, reason) {
    const pairId = state.pairId;

    const pendingEntries = state.openPositions.filter(p => !p.entryPriceA && p.entryOrderId);
    const openWithExit   = state.openPositions.filter(p =>  p.entryPriceA && p.exitOrderId);
    const totalOrders    = pendingEntries.length + openWithExit.length;

    console.log(
      `[UniExec] Cancel all open orders — pair ${pairId} reason=${reason} | ` +
      `entry orders: ${pendingEntries.length} | exit orders: ${openWithExit.length}`
    );

    // 1. Cancel all entry orders (unfilled entries)
    for (const pos of pendingEntries) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      await this._cancel(state, pos.entryOrderId).catch(() => {});
    }

    // 2. Cancel all resting exit orders + reset position state to 'open' in DB
    for (const pos of openWithExit) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      await this._cancel(state, pos.exitOrderId).catch(() => {});

      // Reset in-memory state
      pos.status      = 'open';
      pos.exitOrderId = null;
      pos.exitTradeId = null;
      pos.exitReason  = null;
      pos.pollTimer   = null;

      // Reset in DB so position shows as open (no dangling exit order)
      const bpId = pos.basisPositionId != null ? Number(pos.basisPositionId)
        : (typeof pos.id === 'string' && pos.id.startsWith('reload_'))
          ? parseInt(pos.id.slice('reload_'.length), 10) : null;
      if (bpId != null && Number.isFinite(bpId)) {
        await BasisPosition.update(
          { state: 'open', legA_exitOrderId: null, legB_exitOrderId: null },
          { where: { id: bpId } }
        ).catch(() => {});
      }
    }

    // 3. Disable bot — positions remain on exchange, user closes manually
    state.enabled = false;
    if (state._accountRefreshTimer) { clearInterval(state._accountRefreshTimer); state._accountRefreshTimer = null; }

    await StatArbInput.update(
      { tradingEnabled: false, lastStopReason: reason, lastDisabledAt: new Date() },
      { where: { id: pairId } }
    ).catch(() => {});

    this._broadcastState(pairId);

    const openPositionCount = state.openPositions.filter(p => p.entryPriceA).length;
    console.log(
      `[UniExec] pair ${pairId} DISABLED by ${reason} | ` +
      `${totalOrders} order(s) cancelled | ` +
      `${openPositionCount} open perp position(s) left on exchange — close manually`
    );

    _sendTelegramAlert(
      `🛑 <b>BOT STOPPED — all orders cancelled</b>\n\n` +
      `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Reason: <b>${reason}</b>\n` +
      `Entry orders cancelled: <b>${pendingEntries.length}</b>\n` +
      `Exit orders cancelled: <b>${openWithExit.length}</b>\n` +
      `Open perp positions on exchange: <b>${openPositionCount}</b> — close manually\n` +
      `Time: ${new Date().toUTCString()}`
    );
  }

  async _emergencyCloseAll(state, reason) {
    const pairId = state.pairId;
    console.log(`[UniExec] Emergency close all — pair ${pairId} reason=${reason}`);

    const _bpIdFromPos = (pos) => {
      if (pos.basisPositionId != null && Number.isFinite(Number(pos.basisPositionId))) {
        return Number(pos.basisPositionId);
      }
      if (typeof pos.id === 'string' && pos.id.startsWith('reload_')) {
        const n = parseInt(pos.id.slice('reload_'.length), 10);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    };

    for (const pos of state.openPositions) {
      if (pos.pollTimer) clearInterval(pos.pollTimer);
      // If cancel races a fill, _cancel routes through _onEntryFilled /
      // _onExitFilled, so by the time we reach the filter below, a race-filled
      // entry will have pos.status='open' and entryPriceA set (it'll be picked
      // up for _startExit), and a race-filled exit will be removed from
      // openPositions entirely.
      if (pos.entryOrderId) await this._cancel(state, pos.entryOrderId).catch(() => {});
      if (pos.exitOrderId) await this._cancel(state, pos.exitOrderId).catch(() => {});
    }

    // Cancels lifted resting exits — sync memory/DB back to open so flatten can re-place maker exits.
    for (const pos of state.openPositions) {
      if (pos.status === 'pending_exit' && pos.entryPriceA) {
        pos.status = 'open';
        pos.exitOrderId = null;
        pos.exitTradeId = null;
        pos.exitReason = null;
        pos.pollTimer = null;
        const bpId = _bpIdFromPos(pos);
        if (bpId != null) {
          await BasisPosition.update(
            { state: 'open', legA_exitOrderId: null },
            { where: { id: bpId } },
          ).catch(() => {});
        }
      }
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

    const reasonLabels = {
      drawdown_kill_switch: '📉 Drawdown Kill Switch',
      balance_drawdown_kill_switch: '📉 Balance Drawdown Kill Switch',
      option_profit_take_profit: '💰 Option Profit Take-Profit',
      daily_loss_limit: '📊 Daily Loss Limit',
      price_range_upper: '⬆️ Price Upper Limit',
      price_range_lower: '⬇️ Price Lower Limit',
      manual_maker_flatten: '🔧 Manual maker flatten (API/script)',
    };
    const label = reasonLabels[reason] || reason;
    _sendTelegramAlert(
      `🛑 <b>BOT STOPPED</b>\n\n` +
      `Pair: <b>${pairId}</b> (${state.pair?.agentName || ''})\n` +
      `Reason: <b>${label}</b>\n` +
      `Open positions closed: ${openPositions.length}\n` +
      `Time: ${new Date().toUTCString()}`
    );
  }

  /**
   * Reload pair state from DB, cancel resting entry/exit orders, then place maker limit exits
   * for every filled leg (same path as kill-switch flatten). Disables trading for the pair.
   */
  async makerFlattenOpenPositions(pairId, reason = 'manual_maker_flatten') {
    // Ensure Deribit books exist for exit pricing (same Node process as WS manager).
    try {
      const orderbookManager = require('./orderbookStreams');
      const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
      const targetPair = await StatArbInput.findByPk(pairId);
      const merged = [...activePairs];
      if (targetPair && !merged.some((p) => p.id === pairId)) {
        merged.push(targetPair); // inactive pairs still need WS books to price maker exits
      }
      await orderbookManager.syncWithActivePairs(merged);
      await new Promise((r) => setTimeout(r, 5000));
    } catch (_) {}

    const en = await this.enableTrading(pairId);
    if (!en.success) {
      return { success: false, message: en.message || 'enableTrading failed', pairId };
    }
    const state = this.pairs.get(pairId);
    if (!state) {
      return { success: false, message: 'No executor state after enableTrading', pairId };
    }
    try {
      const orderbookManager = require('./orderbookStreams');
      const books = orderbookManager.getLastLegOrderbooks?.(pairId);
      if (books) state.lastOrderbooks = books;
    } catch (_) {}

    state._killSwitchTriggered = false;
    state._priceRangeTriggered = false;
    await this._emergencyCloseAll(state, reason);
    return {
      success: true,
      message: 'Maker flatten orders submitted; trading disabled for this pair.',
      pairId,
    };
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
    // isLong is derived from actual trade direction — NOT from token or leg identity.
    // Any new bot on any token/leg will automatically get the correct direction flag.
    const isLong = entrySide === 'buy';
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
      direction: isLong ? 'long' : 'short',
      gridLevel: levelIdx + 1,
      state: 'pending_entry',
      entrySpread: signalSpread,
      legA_entryPrice: entryPrice,
      legA_entryQty: qty,
      legB_entryPrice: isLegB ? futAsk : perpBid,
      legB_entryQty: 0,
      legA_entryOrderId: entryRes.orderId,
      entryTime: new Date(),
      tpDelta: state.tpSpreadDelta,
      slDelta: state.slSpreadDelta,
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
      tpDelta: state.tpSpreadDelta,
      slDelta: state.slSpreadDelta,
      // Snapshot per-position so mid-session DB edits don't retro-change open positions.
      fixedTpUsd: state.fixedTpUsd,
      // Stamped from actual entrySide — not from isLegB or token name.
      // Long side (bought at entry) = true. Short side (sold at entry) = false.
      isLong,
      entryQuotedPrice: entryPrice,
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
      _scratchStartedAt: null,
    };
    state.openPositions.push(pos);
    state.lastEntryAt = Date.now();
    state._idleAlertSentAt = 0;  // reset idle alert on new entry
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
        const cancelResp = await this._cancel(state, pos.entryOrderId);
        // Race: the order filled during our cancel → _cancel already routed it
        // through _onEntryFilled; pos is now 'open'. The main spread loop will
        // manage the exit. Don't mark the trade cancelled.
        if (cancelResp && cancelResp.raceHandled) return;
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
        // Drift-based reprice (column-gated, NULL on BTC → no-op).
        // Re-quote if the signal book mid has moved >= entryRequoteOnMovePx from our quote.
        const requoteOnMove = state.entryRequoteOnMovePx;
        let driftCondition = false;
        if (requoteOnMove != null && requoteOnMove > 0 && pos.entryQuotedPrice) {
          const obSig = state.lastOrderbooks?.leg1;
          const bid = parseFloat(obSig?.bids?.[0]?.price || 0);
          const ask = parseFloat(obSig?.asks?.[0]?.price || 0);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
          if (mid > 0) driftCondition = Math.abs(mid - pos.entryQuotedPrice) >= requoteOnMove;
        }
        const timeCondition = (Date.now() - pos.pollStart > REPRICE_AFTER_MS);
        if (!pos._repriced && (timeCondition || driftCondition)) {
          pos._repriced = true;
          const ob1 = state.lastOrderbooks?.leg1;
          const ob2 = state.lastOrderbooks?.leg2;
          const newPrice = isLegB
            ? parseFloat(ob2?.bids?.[0]?.price || 0)
            : parseFloat(ob1?.asks?.[0]?.price || 0);
          if (newPrice) {
            const cancelResp = await this._cancel(state, pos.entryOrderId).catch(() => null);
            // Race: original entry filled during cancel — _cancel promoted pos
            // to 'open'. Don't place a second entry.
            if (cancelResp && cancelResp.raceHandled) return;
            const re = await this._placeLimit(state, isLegB ? 'buy' : 'sell', pos.qty, newPrice);
            if (re.orderId) {
              pos.entryOrderId = re.orderId;
              pos.entryQuotedPrice = newPrice;
              if (driftCondition && !timeCondition) {
                console.log(`[UniExec] pair ${state.pairId} ENTRY_DRIFT_REQUOTE L${pos.gridLevel} newPx=${newPrice}`);
              }
              await Trade.update({ legA_orderId: re.orderId, legA_price: newPrice }, { where: { id: pos.entryTradeId } }).catch(() => {});
              await BasisPosition.update({ legA_entryOrderId: re.orderId }, { where: { id: pos.basisPositionId } }).catch(() => {});
            }
          }
        }
        return;
      }
      clearInterval(pos.pollTimer);
      await this._onEntryFilled(state, pos, st);
    }, POLL_MS);
  }

  /**
   * Promote a position whose entry order just filled: compute refs, spread,
   * commission and persist to Trade/BasisPosition. Idempotent-ish: safe to call
   * from the normal poll path AND from the cancel-race path in `_cancel`.
   * Assumes the caller has stopped `pos.pollTimer` already.
   */
  async _onEntryFilled(state, pos, st) {
    if (!st || st.status !== 'filled' || !st.filledPrice) return false;
    if (pos.status === 'open' || pos.status === 'pending_exit' || pos.status === 'closed') {
      return false; // already handled
    }
    const isLegB = state.tradeLeg === 'B';
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const refPrice = isLegB
      ? parseFloat(ob1?.asks?.[0]?.price || 0)   // futures ask as reference
      : parseFloat(ob2?.bids?.[0]?.price || 0);   // perp bid as reference
    // In the race path we may not have a fresh orderbook tick; fall back to
    // the fill price so we can still record the entry (spread = 0, degraded).
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
    return true;
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
      // Require positive *estimated* gross at the actual maker exit price (not just bid/ask vs entry).
      // Otherwise we can arm a "profit" exit that fills with flat or negative economics after microstructure moves.
      const isLong = pos.isLong ?? (String(state.tradeLeg || 'A').toUpperCase() === 'B');
      const estGrossUsd = this._estimateGrossPnlUsd(
        isLong,
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
          `[UniExec] pair ${state.pairId} profit exit blocked at arm-time ` +
          `estGross=$${Number(estGrossUsd).toFixed(4)} plannedPx=${exitPrice} entry=${pos.entryPriceA} qty=${pos.qty}`
        );
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
    await BasisPosition.update({
      state: 'pending_exit',
      exitTradeId: exitTrade.id,
      legA_exitOrderId: res.orderId,
      exitReason: reason,
    }, { where: { id: pos.basisPositionId } }).catch(() => {});
    pos.status = 'pending_exit';
    pos.exitReason = reason;
    pos.exitOrderId = res.orderId;
    pos.exitTradeId = exitTrade.id;
    pos.pollStart = Date.now();
    // Stamp the target exit price so the reprice loop never chases price to a
    // worse level and erodes the fixedTpUsd target.
    pos.fixedTpExitPrice = (reason === 'profit') ? exitPrice : null;
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
      // Stop exits reprice much faster than profit exits so the SL doesn't
      // slip far in a fast-moving market. Interval is per-pair configurable
      // via stopRepriceIntervalMs (NULL = legacy 5000ms).
      // Profit exits always use the full EXIT_TIMEOUT_MS — no urgency.
      const stopReprice = state.stopRepriceIntervalMs || 5000;
      const effectiveTimeout = (pos.exitReason === 'stop' || pos.exitReason === 'hold_cap') ? stopReprice : EXIT_TIMEOUT_MS;
      if (st.status !== 'filled') {
      if (Date.now() - pos.pollStart > effectiveTimeout) {
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
            // ── Gross-negative scratch (column-gated, NULL on BTC) ─────────
            // When enabled: first time we hit the gross-negative condition,
            // stamp the timer but keep the passive exit order alive. Once
            // scratchMs has elapsed, cancel the maker exit and cross the
            // spread at mid to flatten — converts an unbounded "abort + hold"
            // into a bounded, deterministic scratch loss.
            const scratchMs = state.grossNegativeScratchMs;
            if (scratchMs != null && scratchMs > 0) {
              if (pos._scratchStartedAt == null) {
                pos._scratchStartedAt = Date.now();
                // keep the existing exit order alive; let spread improve
                pos.pollStart = Date.now();
                return;
              }
              if (Date.now() - pos._scratchStartedAt < scratchMs) {
                pos.pollStart = Date.now();
                return;
              }
              const cancelRespScr = await this._cancel(state, pos.exitOrderId);
              if (cancelRespScr && cancelRespScr.raceHandled) {
                clearInterval(pos.pollTimer);
                return;
              }
              // ── Partial-fill remainder: don't re-place the full qty ──────────────
              // _cancel may have recorded a partial fill on pos._partialExitFilled.
              // Only exit the REMAINING qty to avoid over-buying/over-selling.
              const scratchRemaining = pos.qty - (pos._partialExitFilled || 0);
              if (scratchRemaining <= 0) {
                // The partial fills already covered the full position — treat as done.
                console.warn(`[UniExec] pair ${state.pairId} SCRATCH partial fills covered full qty=${pos.qty}; closing`);
                clearInterval(pos.pollTimer);
                pos._partialExitFilled = 0;
                await this._onExitFilled(state, pos, { status: 'filled', price: newPrice || pos.entryPriceA }).catch(() => {});
                return;
              }
              const obSig = isLegB ? state.lastOrderbooks?.leg1 : state.lastOrderbooks?.leg2;
              const bid = parseFloat(obSig?.bids?.[0]?.price || 0);
              const ask = parseFloat(obSig?.asks?.[0]?.price || 0);
              const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
              const scratchPx = mid > 0
                ? (isLegB ? ask : bid)
                : newPrice;
              if (scratchPx > 0) {
                const exitSide = isLegB ? 'sell' : 'buy';
                const reSc = await this._placeLimit(state, exitSide, scratchRemaining, scratchPx);
                if (reSc.orderId) {
                  pos.exitOrderId = reSc.orderId;
                  pos.pollStart = Date.now();
                  pos._scratchStartedAt = null;
                  console.log(`[UniExec] pair ${state.pairId} GROSS_NEGATIVE_SCRATCH exit at ${scratchPx}`);
                  await Trade.update({ legA_orderId: reSc.orderId, legA_price: scratchPx, cancelReason: 'gross_negative_scratch' }, { where: { id: pos.exitTradeId } }).catch(() => {});
                  await BasisPosition.update(
                    { legA_exitOrderId: reSc.orderId, state: 'pending_exit' },
                    { where: { id: pos.basisPositionId } }
                  ).catch(() => {});
                }
              }
              return;
            }
            // Legacy behaviour (scratchMs disabled → abort + hold open)
            const cancelResp = await this._cancel(state, pos.exitOrderId);
            clearInterval(pos.pollTimer);
            // Race: exit filled during our cancel → _cancel already routed it
            // through _onExitFilled; pos is closed. Skip the abort rollback.
            if (cancelResp && cancelResp.raceHandled) return;
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

        const cancelResp2 = await this._cancel(state, pos.exitOrderId);
        // Race: exit filled during our cancel → don't reprice / place a new exit.
        if (cancelResp2 && cancelResp2.raceHandled) {
          clearInterval(pos.pollTimer);
          return;
        }

        // ── Partial-fill remainder after cancel ──────────────────────────────
        // _cancel stores any partial fill amount in pos._partialExitFilled.
        // We must reprice only the REMAINING (unfilled) qty, otherwise the bot
        // buys back MORE than it originally sold and leaves a residual long.
        const repriceRemaining = pos.qty - (pos._partialExitFilled || 0);
        if (repriceRemaining <= 0) {
          console.warn(
            `[UniExec] pair ${state.pairId} STOP_REPRICE partial fills covered full qty=${pos.qty}; closing pos`
          );
          clearInterval(pos.pollTimer);
          pos._partialExitFilled = 0;
          await this._onExitFilled(state, pos, { status: 'filled', price: newPrice || pos.entryPriceA }).catch(() => {});
          return;
        }

        // ── Stop-exit taker fallback (column-gated on the bot's pair row) ──
        // When stopUseMarketOnBreach is true and this is a stop exit that
        // failed to fill within stopRepriceIntervalMs, cross the book with
        // an IOC/market order so the SL cap is actually enforced. Pays one
        // taker fee (~0.05% of notional, ≈ $0.03 on a $60 ETH-PERP contract)
        // in exchange for a bounded loss instead of chasing price.
        if (pos.exitReason === 'stop' && state.stopUseMarketOnBreach) {
          const takerSide = isLegB ? 'sell' : 'buy';
          const mkt = await this._placeMarket(state, takerSide, repriceRemaining);
          if (mkt.orderId) {
            pos.exitOrderId = mkt.orderId;
            pos.pollStart = Date.now();
            console.log(
              `[UniExec] pair ${state.pairId} STOP_TAKER_CROSS pos=${pos.basisPositionId} ` +
              `qty=${pos.qty} side=${takerSide} orderId=${mkt.orderId}`
            );
            await Trade.update(
              { legA_orderId: mkt.orderId, cancelReason: 'stop_taker_cross' },
              { where: { id: pos.exitTradeId } }
            ).catch(() => {});
            await BasisPosition.update(
              { legA_exitOrderId: mkt.orderId, state: 'pending_exit' },
              { where: { id: pos.basisPositionId } }
            ).catch(() => {});
            return;
          }
          console.warn(
            `[UniExec] pair ${state.pairId} STOP_TAKER_CROSS place failed — falling back to passive reprice`
          );
        }

        if (newPrice > 0) {
          const exitSide = isLegB ? 'sell' : 'buy';
          // For profit exits: never reprice to a WORSE level (higher buy / lower sell)
          // which would erode gross below the fixedTpUsd target.
          // SHORT maker BUY exit: want lowest possible price → cap at fixedTpExitPrice
          // LONG  maker SELL exit: want highest possible price → floor at fixedTpExitPrice
          let repriceTarget = newPrice;
          if (pos.exitReason === 'profit' && pos.fixedTpExitPrice != null) {
            repriceTarget = isLegB
              ? Math.max(newPrice, pos.fixedTpExitPrice)  // LONG sell: never go lower than target
              : Math.min(newPrice, pos.fixedTpExitPrice); // SHORT buy: never go higher than target
          }
          // Use repriceRemaining (= pos.qty minus any partial fills already collected
          // by _cancel) to avoid placing a larger order than the open position size.
          const re = await this._placeLimit(state, exitSide, repriceRemaining, repriceTarget);
          if (re.orderId) {
            pos.exitOrderId = re.orderId;
            pos.pollStart = Date.now();
            await Trade.update({ legA_orderId: re.orderId, legA_price: repriceTarget }, { where: { id: pos.exitTradeId } }).catch(() => { });
            await BasisPosition.update(
              { legA_exitOrderId: re.orderId, state: 'pending_exit' },
              { where: { id: pos.basisPositionId } }
            ).catch(() => {});
          }
        }
        return;
      }
      // Not filled yet, timeout not reached — keep polling
      return;
      } // end if (st.status !== 'filled')
      clearInterval(pos.pollTimer);
      await this._onExitFilled(state, pos, st);
    }, POLL_MS);
  }

  /**
   * Close out a position whose exit order just filled: compute PnL/commission,
   * persist to Trade/BasisPosition, update daily PnL, and remove the pos from
   * openPositions. Safe to call from the normal poll path AND from the
   * cancel-race path in `_cancel`. Assumes pos.pollTimer is already stopped.
   */
  async _onExitFilled(state, pos, st) {
    if (!st || st.status !== 'filled' || !st.filledPrice) return false;
    if (pos.status === 'closed') return false; // already handled
    pos._partialExitFilled = 0; // reset partial-fill counter on clean close

    const isLegB = state.tradeLeg === 'B';
    const ob1 = state.lastOrderbooks?.leg1;
    const ob2 = state.lastOrderbooks?.leg2;
    const refPrice = isLegB
      ? parseFloat(ob1?.bids?.[0]?.price || pos.entryPriceB || 0)
      : parseFloat(ob2?.bids?.[0]?.price || pos.entryPriceB || 0);
    const exitPriceA = st.filledPrice;
    // Fallback chain for race-path when orderbook isn't fresh.
    const effectiveRef = refPrice || pos.entryPriceB || exitPriceA;

    // exitSpread is always futures - perp
    const exitSpread = isLegB
      ? parseFloat((effectiveRef - exitPriceA).toFixed(4))
      : parseFloat((exitPriceA - effectiveRef).toFixed(4));

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

    let exitReasonForDb = pos.exitReason || null;
    if (exitReasonForDb === 'profit' && !(grossPnl > PROFIT_EXIT_MIN_GROSS_USD)) {
      exitReasonForDb = 'profit_fill_gross_nonpos';
      console.warn(
        `[UniExec] pair ${state.pairId} exit re-tagged: armed as profit but filled gross ` +
        `grossPnl=$${grossPnl.toFixed(4)} (entry=${pos.entryPriceA} exit=${exitPriceA}) → ${exitReasonForDb}`
      );
    }

    await Trade.update({
      status: 'filled',
      legA_price: exitPriceA,
      legA_filledAt: new Date(),
      legB_price: effectiveRef,
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
      exitReason: exitReasonForDb,
      legA_exitPrice: exitPriceA,
      legB_exitPrice: effectiveRef,
      legA_exitOrderId: pos.exitOrderId,
      exitTime: new Date(),
      holdMs: pos.openedAt ? Date.now() - pos.openedAt : 0,
      spreadChange: parseFloat((exitSpread - (pos.entrySignalSpread || 0)).toFixed(4)),
      legA_pnl: grossPnl,
      legB_pnl: 0,
      grossPnl,
      commission: totalCommission,
      takerFeeUsd: 0,
      netPnl,
    }, { where: { id: pos.basisPositionId } }).catch(() => { });

    state.dailyPnl = parseFloat(((state.dailyPnl || 0) + netPnl).toFixed(6));
    if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd && !state._killSwitchTriggered) {
      console.error(
        `[UniExec] *** DAILY LOSS KILL SWITCH *** pair ${state.pairId} | ` +
        `dailyPnl=$${state.dailyPnl.toFixed(2)} <= -$${state.dailyLossLimitUsd} | ` +
        `closing perps, stopping bot (options untouched)`
      );
      this._emergencyCloseAll(state, 'daily_loss_limit').catch(e =>
        console.error(`[UniExec] daily loss emergency close error pair ${state.pairId}: ${e.message}`)
      );
    }

    // ── Stop-streak cooldown counter (column-gated) ─────────────────────
    // Track how many stop exits have fired back-to-back. When the count
    // reaches stopStreakN, freeze new entries for the next stopStreakCooldownN
    // potential entries. Any non-stop exit (profit, scratch, time, etc.)
    // resets the streak to zero.
    if (state.stopStreakN && state.stopStreakCooldownN) {
      const isStop = (exitReasonForDb === 'stop' || exitReasonForDb === 'stop_loss' || exitReasonForDb === 'hold_cap');
      if (isStop) {
        state._stopStreak = (state._stopStreak || 0) + 1;
        if (state._stopStreak >= state.stopStreakN) {
          state._entryCooldownRemaining = state.stopStreakCooldownN;
          state._stopStreak = 0;
          console.warn(
            `[UniExec] pair ${state.pairId} STOP_STREAK_COOLDOWN triggered: ` +
            `${state.stopStreakN} consecutive stops → pause ${state.stopStreakCooldownN} entries`
          );
        }
      } else {
        state._stopStreak = 0;
      }
    }

    pos.status = 'closed';
    state.openPositions = state.openPositions.filter((p) => p !== pos);
    this._broadcastState(state.pairId);
    return true;
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
    const perpAsk = parseFloat(ob2?.asks?.[0]?.price || 0);
    if (!futAsk || !futBid || !perpBid) return;

    // Price range kill switch — use perp mid as BTC spot proxy
    if (perpBid > 0 && perpAsk > 0) {
      const btcMid = (perpBid + perpAsk) / 2;
      await this._checkPriceRangeKillSwitch(state, btcMid);
      if (state._priceRangeTriggered) return;
    }

    const signalSpread = parseFloat((futAsk - perpBid).toFixed(4));

    // Sample traded-leg mid for the trend filter. Cheap (bounded history, only
    // maintained when trendFilterPct is set) and drives _computePriceDriftPct.
    if (state.trendFilterPct) {
      const tradedOb = state.tradeLeg === 'B' ? ob2 : ob1;
      const tMid = (parseFloat(tradedOb?.bids?.[0]?.price || 0) + parseFloat(tradedOb?.asks?.[0]?.price || 0)) / 2;
      this._pushPriceSample(state, tMid);
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

      const isLinear = this._isLinearUsdc(state);

      // All orders are MAKER only (limit orders, never taker).
      // tradedOb = the orderbook of the instrument the bot actually trades:
      //   tradeLeg=A → leg1 (ob1),  tradeLeg=B → leg2 (ob2)
      //
      // LONG  maker entry: limit BUY  rests at BID → filled at BID  (entryPriceA ≈ bid_at_entry)
      // LONG  maker exit:  limit SELL rests at ASK → estimate exit at current ASK
      //
      // SHORT maker entry: limit SELL rests at ASK → filled at ASK  (entryPriceA ≈ ask_at_entry)
      // SHORT maker exit:  limit BUY  rests at BID → estimate exit at current BID
      const isLong   = pos.isLong ?? (state.tradeLeg === 'B');
      const tradedOb = (state.tradeLeg || 'A').toUpperCase() === 'B' ? ob2 : ob1;
      const currentPrice = isLong
        ? parseFloat(tradedOb?.asks?.[0]?.price || 0)  // LONG  maker exit: limit SELL sits at ASK
        : parseFloat(tradedOb?.bids?.[0]?.price || 0); // SHORT maker exit: limit BUY  sits at BID
      const grossPositive = isLong
        ? (currentPrice > pos.entryPriceA)   // LONG:  ask_now > bid_at_entry → profitable
        : (currentPrice < pos.entryPriceA);  // SHORT: bid_now < ask_at_entry → profitable

      // Per-position TP/SL (frozen at entry) with fallback to global state
      const posTp = pos.tpDelta ?? state.tpSpreadDelta;
      const posSl = pos.slDelta ?? state.slSpreadDelta;

      // TP: spread narrowed + gross positive + gross meets minimum USD threshold
      const spreadTp = (pos.entrySignalSpread - currentSpread) >= posTp;
      const estGross = grossPositive && pos.entryPriceA && currentPrice
        ? this._estimateGrossPnlUsd(isLong, pos.qty, pos.entryPriceA, currentPrice, isLinear)
        : 0;
      const grossMeetsMin = minGrossUsd <= 0 || estGross >= minGrossUsd;

      // ── Fixed-$ TP (column-gated, NULL on BTC) ────────────────────────────
      // When enabled, exit the moment estimated gross PnL reaches fixedTpUsd,
      // regardless of whether the spread has retraced. This is the primary
      // profitability lever — stops winners from eroding or turning into
      // losers while waiting for spread convergence.
      const posFixedTp  = pos.fixedTpUsd ?? state.fixedTpUsd;
      const fixedTpHit  = posFixedTp != null && grossPositive && estGross >= posFixedTp;
      const tpHit       = fixedTpHit || (spreadTp && grossPositive && grossMeetsMin);

      // SL: spread widened past threshold + held long enough + stagger delay between stops
      // Use entrySignalSpread (same convention as currentSpread = futAsk - perpBid)
      // instead of fillSpread which includes the bid-ask gap and causes premature triggers
      const slBaseline = pos.entrySignalSpread ?? pos.fillSpread;
      const slHit =
        holdMs >= MIN_HOLD_BEFORE_SL_MS &&
        (currentSpread - slBaseline) >= posSl &&
        (now - state.lastStopExitAt) >= STAGGER_STOP_MS;

      // ── Hard per-trade loss cap (column-gated, NULL on BTC) ───────────────
      // Caps catastrophic tail losses. Trips immediately (no confirm ticks,
      // no stagger) when gross loss exceeds maxSingleTradeLossUsd.
      let hardLossHit = false;
      if (state.maxSingleTradeLossUsd != null && pos.entryPriceA && currentPrice && !grossPositive) {
        const lossUsd = this._estimateGrossPnlUsd(isLong, pos.qty, pos.entryPriceA, currentPrice, isLinear);
        if (lossUsd <= -state.maxSingleTradeLossUsd) hardLossHit = true;
      }

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

      // ── Hold-time cap (column-gated, NULL = legacy "hold to TP/SL") ──────
      // Force-flatten any position that has been open past maxHoldMs. Uses
      // the passive 'hold_cap' exit — same maker behaviour as a profit exit
      // but without the gross-positive gate, so it will scratch at current
      // bid/ask. Derived from SIM-D of the full BTC inception analysis.
      const holdCapHit =
        state.maxHoldMs != null &&
        state.maxHoldMs > 0 &&
        holdMs >= state.maxHoldMs;

      if (hardLossHit) {
        state.lastStopExitAt = now;
        console.log(`[UniExec] pair ${state.pairId} HARD_LOSS_CAP hit — forcing stop exit`);
        await this._startExit(state, pos, 'stop');
      } else if (pos.profitTicks >= TP_CONFIRM_TICKS || fixedTpHit) {
        await this._startExit(state, pos, 'profit');
      } else if (pos.stopTicks >= SL_CONFIRM_TICKS) {
        state.lastStopExitAt = now;
        await this._startExit(state, pos, 'stop');
      } else if (holdCapHit) {
        console.log(
          `[UniExec] pair ${state.pairId} HOLD_CAP hit — ` +
          `holdMs=${holdMs} >= maxHoldMs=${state.maxHoldMs}, forcing passive scratch exit`
        );
        await this._startExit(state, pos, 'hold_cap');
      }
    }

    // Entry checks
    const now = Date.now();

    if (state._killSwitchTriggered) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    // ── Trend-jump entry pause (column-gated, NULL on BTC) ────────────────
    // When the adapter detected a rapid regime shift (maxSpreadCap jumped by
    // >= trendPauseJumpPct), it sets _trendPauseUntil. Skip new entries until
    // then; open positions continue to exit normally.
    if (state._trendPauseUntil && now < state._trendPauseUntil) {
      state._skipCounts.trendPause = (state._skipCounts.trendPause || 0) + 1;
      state._lastSkipReason = 'trendPause';
      state.prevSignalSpread = signalSpread;
      return;
    }

    // Daily loss limit: stop opening new positions when breached
    if (state.dailyLossLimitUsd > 0 && state.dailyPnl <= -state.dailyLossLimitUsd) {
      state.prevSignalSpread = signalSpread;
      return;
    }

    const z = sellStats?.zScore ?? 0;
    const zMin = state.pair.zEntryThreshold != null ? parseFloat(state.pair.zEntryThreshold) : 0;
    const maxPos = state.pair.maxPositions != null ? parseInt(state.pair.maxPositions) : 1;
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
    const openCount = state.openPositions.filter((p) => p.status !== 'closed').length;
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
      const already = state.openPositions.some((p) => p.status !== 'closed' && p.gridLevel === i + 1);
      if (already) continue;
      if (state.prevSignalSpread < level && signalSpread >= level) {
        // ── Trend filter (column-gated) ─────────────────────────────────
        // Skip new entries when the traded leg has drifted too far over the
        // recent window — directional regimes crush a mean-reversion setup.
        if (state.trendFilterPct != null) {
          const drift = this._computePriceDriftPct(state);
          if (drift != null && drift > state.trendFilterPct) {
            state._skipCounts.trend = (state._skipCounts.trend || 0) + 1;
            if (state._lastSkipReason !== 'trend' || (state._skipCounts.trend % 50) === 0) {
              console.log(
                `[UniExec] pair ${state.pairId} entry SKIPPED trend-filter ` +
                `drift=${drift.toFixed(3)}% > ${state.trendFilterPct}% ` +
                `(window=${state.trendFilterWindowMs}ms, skips=${state._skipCounts.trend})`
              );
            }
            state._lastSkipReason = 'trend';
            break;
          }
        }

        // ── Minimum-edge filter (column-gated) ──────────────────────────
        // Reject entries whose *projected* gross USD under current tpSpreadDelta
        // can't cover fees + slippage. Guarantees every taken trade has
        // enough headroom; the actual win still depends on market fills.
        if (state.minEdgeUsd != null) {
          const isLegB = state.tradeLeg === 'B';
          const tradedObForEdge = isLegB ? ob2 : ob1;
          const entryPx = isLegB
            ? parseFloat(tradedObForEdge?.bids?.[0]?.price || 0)   // LONG maker entry rests at BID
            : parseFloat(tradedObForEdge?.asks?.[0]?.price || 0);  // SHORT maker entry rests at ASK
          const qty = state.levelQty[i] || state.pair.qty1;
          const projGross = this._projectedTpGrossUsd(state, /* isLong */ isLegB, qty, entryPx);
          if (projGross < state.minEdgeUsd) {
            state._skipCounts.edge = (state._skipCounts.edge || 0) + 1;
            if (state._lastSkipReason !== 'edge' || (state._skipCounts.edge % 50) === 0) {
              console.log(
                `[UniExec] pair ${state.pairId} entry SKIPPED edge-filter ` +
                `projGross=$${projGross.toFixed(2)} < minEdgeUsd=$${state.minEdgeUsd} ` +
                `(tp=${state.tpSpreadDelta}, entryPx=${entryPx}, qty=${qty}, skips=${state._skipCounts.edge})`
              );
            }
            state._lastSkipReason = 'edge';
            break;
          }
        }

        // ── IST-hour gate (column-gated: disableIstHours) ───────────────
        // Block new entries during configured hostile hours (observed on
        // ETH: 04 IST and 23 IST carried the worst PnL per hour). Open
        // positions continue to exit normally.
        if (state.disableIstHours) {
          const istHr = this._currentIstHour();
          if (state.disableIstHours.has(istHr)) {
            state._skipCounts.hour = (state._skipCounts.hour || 0) + 1;
            if (state._lastSkipReason !== 'hour' || (state._skipCounts.hour % 50) === 0) {
              console.log(
                `[UniExec] pair ${state.pairId} entry SKIPPED ist-hour-filter ` +
                `ist=${istHr}h disabled=[${[...state.disableIstHours].sort((a,b)=>a-b).join(',')}] ` +
                `(skips=${state._skipCounts.hour})`
              );
            }
            state._lastSkipReason = 'hour';
            break;
          }
        }

        // ── Stop-streak cooldown gate (column-gated) ────────────────────
        // Decrement the cooldown counter and skip the entry until it hits
        // zero. Counter is set inside _onExitFilled after N consecutive
        // stop exits.
        if (state._entryCooldownRemaining > 0) {
          state._entryCooldownRemaining -= 1;
          state._skipCounts.streakCool = (state._skipCounts.streakCool || 0) + 1;
          if (state._lastSkipReason !== 'streakCool' || (state._skipCounts.streakCool % 5) === 0) {
            console.log(
              `[UniExec] pair ${state.pairId} entry SKIPPED streak-cooldown ` +
              `remaining=${state._entryCooldownRemaining} (skips=${state._skipCounts.streakCool})`
            );
          }
          state._lastSkipReason = 'streakCool';
          break;
        }

        state._lastSkipReason = null;
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
    if (dollarMean <= 0) return;   // spread must be positive for this strategy
    // Guard: std must be meaningful relative to the mean (at least 1% of mean).
    // Absolute threshold would break small-spread pairs like SOL ($0.009 std is normal).
    if (dollarStd / dollarMean < 0.01) return;

    const sigmaMin = pair.adaptSigmaMin != null ? parseFloat(pair.adaptSigmaMin) : 0.5;
    const sigmaMax = pair.adaptSigmaMax != null ? parseFloat(pair.adaptSigmaMax) : 2.0;
    const tpSigma  = pair.adaptTpSigma  != null ? parseFloat(pair.adaptTpSigma)  : 0.8;
    const slSigma  = pair.adaptSlSigma  != null ? parseFloat(pair.adaptSlSigma)  : 1.5;

    // Match the level count from the user's original config, capped at 7
    const nLevels = Math.max(1, Math.min(state.levels.length || 3, 7));

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
    const newCap = parseFloat((dollarMean + (sigmaMax + 0.5) * dollarStd).toFixed(4));

    // ── Trend-jump pause (column-gated, NULL on BTC) ──────────────────────
    // If the new cap jumped by >= trendPauseJumpPct vs the previous cap, the
    // regime is trending (not mean-reverting). Pause new entries for
    // trendPauseDurationMs. Existing positions keep exiting normally.
    if (
      state.trendPauseJumpPct != null &&
      state.trendPauseDurationMs != null &&
      prevCap != null && prevCap > 0
    ) {
      const jumpPct = Math.abs(newCap - prevCap) / prevCap;
      if (jumpPct >= state.trendPauseJumpPct) {
        state._trendPauseUntil = Date.now() + state.trendPauseDurationMs;
        console.log(
          `[AdaptLevels] pair ${state.pairId} TREND_PAUSE — cap jump ${(jumpPct * 100).toFixed(1)}% ` +
          `(prev=$${prevCap.toFixed(2)} -> new=$${newCap.toFixed(2)}); ` +
          `entries paused for ${state.trendPauseDurationMs / 1000}s`
        );
      }
    }
    state._adaptedMaxSpreadCap = newCap;

    // ── Always update TP / SL globally (each position snapshots its own
    //    tpDelta/slDelta at entry, so open positions are not affected) ────────
    const openCount = state.openPositions.filter((p) => p.status !== 'closed').length;
    let tpUpdated = false;
    let slUpdated = false;
    let newTp = parseFloat((tpSigma * dollarStd).toFixed(4));
    const newSl = parseFloat((slSigma * dollarStd).toFixed(4));

    // ── Adapter TP/SL ratio floor (column-gated, NULL on BTC) ─────────────
    // When enabled, enforce newTp >= adaptMinTpSlRatio * newSl so the adapter
    // can't compress reward below the configured multiple of risk.
    if (state.adaptMinTpSlRatio != null && newSl > 0) {
      const floorTp = parseFloat((state.adaptMinTpSlRatio * newSl).toFixed(4));
      if (newTp < floorTp) {
        console.log(
          `[AdaptLevels] pair ${state.pairId} TP_FLOOR raised ` +
          `$${newTp.toFixed(2)} -> $${floorTp.toFixed(2)} (ratio floor ${state.adaptMinTpSlRatio}x SL=$${newSl.toFixed(2)})`
        );
        newTp = floorTp;
      }
    }

    if (newTp > 0) {
      state.tpSpreadDelta = newTp;
      tpUpdated = true;
    }
    if (newSl > 0) {
      state.slSpreadDelta = newSl;
      slUpdated = true;
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

    // Persist adapted values to DB so they survive server restarts
    const dbUpdate = {
      spreadEntryLevels: newLevels.join(','),
      maxSpreadCap:      state._adaptedMaxSpreadCap,
    };
    if (tpUpdated) dbUpdate.tpSpreadDelta = state.tpSpreadDelta;
    if (slUpdated) dbUpdate.slSpreadDelta = state.slSpreadDelta;

    StatArbInput.update(dbUpdate, { where: { id: state.pairId } }).catch((err) => {
      console.warn(`[AdaptLevels] pair ${state.pairId} DB persist failed: ${err.message}`);
    });
  }

  /**
   * Called by the hourly scheduler — iterates all enabled pairs whose
   * adaptLevels flag is true and recomputes their levels from live spread stats.
   */
  async runAdaptCycle() {
    const orderbookManager = require('./orderbookStreams');
    const now = Date.now();
    let adapted = 0;
    for (const [pairId, state] of this.pairs) {
      if (!state.enabled) continue;
      if (!state.pair?.adaptLevels) continue;

      // Per-pair interval gate: only adapt this pair if its own window has elapsed.
      const pairInterval = this._pairAdaptIntervalMs(state);
      const elapsed = state._adaptedAt != null ? now - state._adaptedAt : Infinity;
      if (elapsed < pairInterval) {
        const remainSec = Math.round((pairInterval - elapsed) / 1000);
        console.log(`[AdaptLevels] pair ${pairId} deferred — ${remainSec}s until next adapt (interval=${pairInterval / 60_000}min)`);
        continue;
      }

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

  _isUsaMarketHours() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const mins = utcH * 60 + utcM;
    // NYSE/NASDAQ: 9:30 AM – 4:00 PM ET (EDT = UTC-4 during daylight saving)
    // 13:30 – 20:00 UTC  (9:30 AM – 4:00 PM EDT)
    return mins >= 13 * 60 + 30 && mins < 20 * 60;
  }

  // Global defaults — used when a pair's DB fields are null.
  static ADAPT_DEFAULT_USA_MS       =  15 * 60_000;   // 15 min
  static ADAPT_DEFAULT_OFF_HOURS_MS =  30 * 60_000;   // 30 min

  // Return the adapt interval for a specific pair state, falling back to defaults.
  _pairAdaptIntervalMs(state) {
    const usa = this._isUsaMarketHours();
    if (usa) {
      return state._adaptIntervalUsaMs      != null
        ? state._adaptIntervalUsaMs
        : UnilateralExecutor.ADAPT_DEFAULT_USA_MS;
    }
    return state._adaptIntervalOffHoursMs != null
      ? state._adaptIntervalOffHoursMs
      : UnilateralExecutor.ADAPT_DEFAULT_OFF_HOURS_MS;
  }

  // Global timer fires at the SHORTEST interval across all active adapt-enabled pairs,
  // so no pair waits longer than its configured window.
  // Within runAdaptCycle(), each pair is only adapted when its own interval has elapsed.
  _getAdaptIntervalMs() {
    let min = null;
    if (this.pairs) {
      for (const [, state] of this.pairs) {
        if (!state.enabled || !state.pair?.adaptLevels) continue;
        const interval = this._pairAdaptIntervalMs(state);
        if (min === null || interval < min) min = interval;
      }
    }
    // Fallback: no pairs active yet — use default USA/off-hours
    if (min === null) {
      return this._isUsaMarketHours()
        ? UnilateralExecutor.ADAPT_DEFAULT_USA_MS
        : UnilateralExecutor.ADAPT_DEFAULT_OFF_HOURS_MS;
    }
    return min;
  }

  _scheduleNextAdapt() {
    if (this._adaptTimerStopped) return;
    const intervalMs = this._getAdaptIntervalMs();
    const label = this._isUsaMarketHours() ? 'USA-open' : 'off-hours';
    this._adaptTimer = setTimeout(() => {
      this.runAdaptCycle();
      console.log(`[AdaptLevels] Next cycle in ${intervalMs / 60_000} min (${label})`);
      this._scheduleNextAdapt();
    }, intervalMs);
  }

  startAdaptScheduler() {
    this._adaptTimerStopped = false;
    this.runAdaptCycle();
    this._adaptBootTimer = setTimeout(() => {
      console.log('[AdaptLevels] Post-boot retry (5 min warmup)');
      this.runAdaptCycle();
    }, 5 * 60_000);
    this._scheduleNextAdapt();
    const intervalMs = this._getAdaptIntervalMs();
    const label = this._isUsaMarketHours() ? 'USA-open 15 min' : 'off-hours 30 min';
    console.log(`[AdaptLevels] Scheduler started — ${label} interval (+ 5 min warmup retry)`);
  }

  stopAdaptScheduler() {
    this._adaptTimerStopped = true;
    if (this._adaptBootTimer) { clearTimeout(this._adaptBootTimer); this._adaptBootTimer = null; }
    if (this._adaptTimer) { clearTimeout(this._adaptTimer); this._adaptTimer = null; }
  }
}

module.exports = new UnilateralExecutor();
