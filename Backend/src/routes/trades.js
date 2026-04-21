const crypto = require('crypto');
const { Op } = require('sequelize');
const tradeExecutor = require('../services/tradeExecutor');
const unilateralExecutor = require('../services/unilateralExecutor');
const Trade = require('../models/Trade');
const { StatArbInput, BotSessionLog, BasisPosition, AccountDetails, SpreadLevelHistory } = require('../models');
const { signedRequest, buyorder, sellorder, cancelorder, deribitorderStatus } = require('../controllers/apicontroller');

function decryptCred(ak2, ak1, ak0) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ak2, 'base64'), Buffer.from(ak0, 'base64'));
  return decipher.update(ak1, 'base64', 'utf8') + decipher.final('utf8');
}

/** Deribit inverse / linear base coin from instrument name (same logic as unilateralExecutor). */
function settlementCoinFromDeribitSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.includes('_USDC')) return 'USDC';
  const base = s.split('-')[0];
  return base || 'BTC';
}

/**
 * trade_logs.commission: maker rebate as income (positive), always stored in USD.
 * The executor converts native fee × fill-price → USD before writing to DB for all
 * currencies (BTC and ETH inverse, USDC linear). No further conversion is needed here.
 */
function makerRebateUsdFromTradeRow(t) {
  const comm = t.commission != null ? parseFloat(t.commission) : null;
  if (comm == null || !Number.isFinite(comm) || comm <= 0) return 0;
  return comm; // already USD for all Deribit instruments
}

/**
 * Convert the USD commission back to the native settlement token for display.
 * BTC/ETH: divide USD by fill price to recover the native amount.
 * USDC-linear: 1:1 with USD.
 */
function makerRebateNativeFromTradeRow(t) {
  const comm = t.commission != null ? parseFloat(t.commission) : null;
  if (comm == null || !Number.isFinite(comm) || comm <= 0) return { amount: 0, coin: null };
  const ex = (t.legA_exchange || '').toLowerCase();
  const sym = t.legA_symbol || '';
  const px = parseFloat(t.legA_price) || 0;
  if (ex === 'deribit') {
    const coin = settlementCoinFromDeribitSymbol(sym);
    if (coin === 'ETH' && px > 0) return { amount: comm / px, coin: 'ETH' };
    if (coin === 'BTC' && px > 0) return { amount: comm / px, coin: 'BTC' };
    if (coin === 'USDC') return { amount: comm, coin: 'USDC' };
  }
  return { amount: 0, coin: null };
}

/**
 * The one “running” BTC unilateral bot: DB active + trading on + Deribit BTC-* legs.
 * ETH bots use ETH-* symbols and are excluded.
 */
async function resolveActiveBtcUnilateralPair() {
  const rows = await StatArbInput.findAll({
    where: {
      status: 'active',
      tradingEnabled: true,
      unilateralMode: true,
      [Op.or]: [
        { symbol1: { [Op.like]: 'BTC%' } },
        { symbol2: { [Op.like]: 'BTC%' } },
      ],
    },
    attributes: ['id', 'agentName', 'symbol1', 'symbol2', 'tradeLeg', 'tradingEnabled', 'unilateralMode'],
    order: [['id', 'DESC']],
  });
  if (rows.length === 0) {
    return {
      error: 'none',
      message:
        'No active BTC unilateral pair (need status=active, tradingEnabled=true, unilateralMode=true, symbol1 or symbol2 like BTC%).',
    };
  }
  if (rows.length > 1) {
    return {
      error: 'ambiguous',
      message: 'Multiple active BTC unilateral pairs — use /api/pairs/:id/... with an explicit pairId.',
      candidates: rows.map((r) => ({
        id: r.id,
        agentName: r.agentName,
        symbol1: r.symbol1,
        symbol2: r.symbol2,
      })),
    };
  }
  return { pair: rows[0] };
}

async function tradeRoutes(fastify, options) {
  const pickExecutor = () => unilateralExecutor;

  // Bot uptime — always anchored to botStartedAt so restarts don't reset the clock
  fastify.get('/api/bot/uptime', async (request, reply) => {
    const { pairId } = request.query;
    if (pairId) {
      const pid = parseInt(pairId);
      // Prefer in-memory (already set to botStartedAt after fix), then DB, then process start
      const state = unilateralExecutor.pairs?.get(pid);
      let startedAt = state?.enabledAt ?? null;
      if (!startedAt) {
        const pair = await StatArbInput.findByPk(pid, { attributes: ['botStartedAt'] }).catch(() => null);
        startedAt = pair?.botStartedAt ? new Date(pair.botStartedAt).getTime() : unilateralExecutor.startedAt;
      }
      return { startedAt, uptimeMs: Date.now() - startedAt };
    }
    return {
      startedAt: unilateralExecutor.startedAt,
      uptimeMs: Date.now() - unilateralExecutor.startedAt,
    };
  });

  // Enable all pairs for an agent (bot)
  fastify.post('/api/agents/:name/trade/enable', async (request, reply) => {
    const { name } = request.params;
    const pairs = await StatArbInput.findAll({ where: { agentName: name, status: 'active' } });
    if (pairs.length === 0) {
      return reply.status(400).send({ success: false, message: 'No active pairs for this agent' });
    }
    const results = [];
    for (const pair of pairs) {
      const result = await pickExecutor(pair).enableTrading(pair.id);
      if (result.success) await StatArbInput.update({ tradingEnabled: true, status: 'active' }, { where: { id: pair.id } });
      results.push({ pairId: pair.id, ...result });
    }
    return { success: true, results };
  });

  // Disable (cancel) all pairs for an agent (bot)
  fastify.post('/api/agents/:name/trade/disable', async (request, reply) => {
    const { name } = request.params;
    const pairs = await StatArbInput.findAll({ where: { agentName: name } });
    const results = [];
    for (const pair of pairs) {
      const ex = pickExecutor(pair);
      const state = ex.pairs.get(pair.id);
      if (state && state.enabled) {
        const result = await ex.disableTrading(pair.id);
        if (result.success) await StatArbInput.update({ tradingEnabled: false }, { where: { id: pair.id } });
        results.push({ pairId: pair.id, ...result });
      }
    }
    return { success: true, cancelled: results.length, results };
  });

  // Get agent trading status
  fastify.get('/api/agents/:name/trade/state', async (request, reply) => {
    const { name } = request.params;
    const pairs = await StatArbInput.findAll({ where: { agentName: name } });
    const states = {};
    for (const pair of pairs) {
      states[pair.id] = pickExecutor(pair).getState(pair.id);
    }
    const enabledCount = Object.values(states).filter(s => s.enabled).length;
    return { agentName: name, totalPairs: pairs.length, enabledCount, pairStates: states };
  });

  // Set profit target and stop loss for a pair
  fastify.post('/api/pairs/:id/trade/config', async (request, reply) => {
    const { id } = request.params;
    const {
      profitTarget,
      stopLoss,
      tpSpreadDelta,
      slSpreadDelta,
      maxLegAQty,
      maxLegBQty,
      maxNetQtyImbalance,
      maxSpreadCap,
      entryPollTimeoutMs,
      zEntryThreshold,
      zEntryMax,
      drawdownPct
    } = request.body || {};
    const pair = await StatArbInput.findByPk(parseInt(id));
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });

    const updates = {};
    if (profitTarget       != null) updates.profitTarget       = parseFloat(profitTarget);
    if (stopLoss           != null) updates.stopLoss           = parseFloat(stopLoss);
    if (tpSpreadDelta      != null) updates.tpSpreadDelta      = parseFloat(tpSpreadDelta);
    if (slSpreadDelta      != null) updates.slSpreadDelta      = parseFloat(slSpreadDelta);
    if (maxLegAQty         != null) updates.maxLegAQty         = parseFloat(maxLegAQty);
    if (maxLegBQty         != null) updates.maxLegBQty         = parseFloat(maxLegBQty);
    if (maxNetQtyImbalance != null) updates.maxNetQtyImbalance = parseFloat(maxNetQtyImbalance);
    if (maxSpreadCap          != null) updates.maxSpreadCap          = parseFloat(maxSpreadCap);
    if (entryPollTimeoutMs    != null) updates.entryPollTimeoutMs    = parseInt(entryPollTimeoutMs);
    if (zEntryThreshold       != null) updates.zEntryThreshold       = parseFloat(zEntryThreshold);
    if (zEntryMax             != null) updates.zEntryMax             = parseFloat(zEntryMax);
    if (drawdownPct           != null) updates.drawdownPct           = parseFloat(drawdownPct);
    if (Object.keys(updates).length === 0) return reply.status(400).send({ success: false, message: 'No valid fields provided' });

    // Snapshot previous values for history before the DB update
    const prevTp  = pair.tpSpreadDelta;
    const prevSl  = pair.slSpreadDelta;
    const prevCap = pair.maxSpreadCap;
    const prevLevelsRaw = pair.spreadEntryLevels;
    const prevLevelsArr = prevLevelsRaw
      ? prevLevelsRaw.split(',').map(Number).filter(Number.isFinite)
      : null;

    await pair.update(updates);

    // Hot-reload into running state if trading is active
    const ex = pickExecutor(pair);
    const tradeState = ex.pairs.get(parseInt(id));
    if (tradeState) {
      if (updates.profitTarget       != null) tradeState.profitTarget       = updates.profitTarget;
      if (updates.stopLoss           != null) tradeState.stopLoss           = updates.stopLoss;
      if (updates.tpSpreadDelta      != null) tradeState.tpSpreadDelta      = updates.tpSpreadDelta;
      if (updates.slSpreadDelta      != null) tradeState.slSpreadDelta      = updates.slSpreadDelta;
      if (updates.maxLegAQty         != null) { tradeState.maxLegAQty         = updates.maxLegAQty;         tradeState._qtyLimitTriggered = false; }
      if (updates.maxLegBQty         != null) { tradeState.maxLegBQty         = updates.maxLegBQty;         tradeState._qtyLimitTriggered = false; }
      if (updates.maxNetQtyImbalance != null) { tradeState.maxNetQtyImbalance = updates.maxNetQtyImbalance; tradeState._qtyLimitTriggered = false; }
      if (updates.maxSpreadCap       != null) tradeState.pair.maxSpreadCap   = updates.maxSpreadCap;
      if (updates.entryPollTimeoutMs != null) tradeState.entryPollTimeoutMs  = updates.entryPollTimeoutMs;
      if (updates.zEntryThreshold    != null) tradeState.zEntryThreshold     = updates.zEntryThreshold;
      if (updates.zEntryMax          != null) tradeState.zEntryMax           = updates.zEntryMax;
      if (updates.drawdownPct        != null) tradeState.drawdownPct         = updates.drawdownPct;
    }

    // Save history row when any level-related field changed
    const levelFieldChanged = updates.tpSpreadDelta != null || updates.slSpreadDelta != null ||
                              updates.maxSpreadCap  != null;
    if (levelFieldChanged) {
      const currentLevelsRaw = pair.spreadEntryLevels;
      const currentLevelsArr = currentLevelsRaw
        ? currentLevelsRaw.split(',').map(Number).filter(Number.isFinite)
        : prevLevelsArr;
      const openCount = tradeState
        ? tradeState.openPositions.filter((p) => p.status !== 'closed').length
        : 0;
      SpreadLevelHistory.create({
        pairId:            parseInt(id),
        changedBy:         'api',
        levels:            currentLevelsArr,
        tpSpreadDelta:     updates.tpSpreadDelta  ?? prevTp,
        slSpreadDelta:     updates.slSpreadDelta  ?? prevSl,
        maxSpreadCap:      updates.maxSpreadCap   ?? prevCap ?? null,
        prevLevels:        prevLevelsArr,
        prevTpSpreadDelta: prevTp  ?? null,
        prevSlSpreadDelta: prevSl  ?? null,
        prevMaxSpreadCap:  prevCap ?? null,
        dollarMean:        null,
        dollarStd:         null,
        openPositions:     openCount,
        tpSlUpdated:       true,
      }).catch((err) => {
        console.warn(`[LevelHistory] API save failed for pair ${id}: ${err.message}`);
      });
    }

    return { success: true, pairId: id, ...updates };
  });

  // Enable auto-trading for a pair
  fastify.post('/api/pairs/:id/trade/enable', async (request, reply) => {
    const { id } = request.params;
    const pair = await StatArbInput.findByPk(parseInt(id));
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });
    const result = await pickExecutor(pair).enableTrading(parseInt(id));
    if (!result.success) {
      return reply.status(400).send(result);
    }
    // status='active' is the master flag used by both the UI and the
    // server.js boot loop. Must be set back to 'active' on every enable
    // so the pair auto-resumes after a pm2 restart; previously the disable
    // route flipped it to 'inactive' and the enable route forgot to flip it
    // back, leaving the bot running in-memory but invisible to the UI.
    await StatArbInput.update({ tradingEnabled: true, status: 'active' }, { where: { id: parseInt(id) } });
    return result;
  });

  // Disable auto-trading for a pair
  fastify.post('/api/pairs/:id/trade/disable', async (request, reply) => {
    const { id } = request.params;
    const pair = await StatArbInput.findByPk(parseInt(id));
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });
    const result = await pickExecutor(pair).disableTrading(parseInt(id));
    if (!result.success) {
      return reply.status(400).send(result);
    }
    // Keep status='active' so the pair stays visible and subscribes to orderbooks on restart.
    // Only tradingEnabled flips — the bot stays warm, just stops placing new entries.
    await StatArbInput.update({ tradingEnabled: false }, { where: { id: parseInt(id) } });
    return result;
  });

  // Get current trade state for a pair
  fastify.get('/api/pairs/:id/trade/state', async (request, reply) => {
    const { id } = request.params;
    const pair = await StatArbInput.findByPk(parseInt(id));
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });
    return pickExecutor(pair).getState(parseInt(id));
  });

  /** Resolve the single active BTC unilateral bot (excludes ETH and inactive pairs). */
  fastify.get('/api/bots/current-btc-unilateral', async (request, reply) => {
    const r = await resolveActiveBtcUnilateralPair();
    if (r.error === 'none') return reply.status(404).send({ success: false, ...r });
    if (r.error === 'ambiguous') return reply.status(409).send({ success: false, ...r });
    const p = r.pair;
    return {
      success: true,
      pairId: p.id,
      agentName: p.agentName,
      symbol1: p.symbol1,
      symbol2: p.symbol2,
      tradeLeg: p.tradeLeg,
    };
  });

  /** Exit diagnostics for the active BTC bot only (same payload as /api/pairs/:id/exit-diagnostics). */
  fastify.get('/api/bots/current-btc-unilateral/exit-diagnostics', async (request, reply) => {
    const r = await resolveActiveBtcUnilateralPair();
    if (r.error === 'none') return reply.status(404).send({ success: false, ...r });
    if (r.error === 'ambiguous') return reply.status(409).send({ success: false, ...r });
    const ex = pickExecutor(r.pair);
    if (typeof ex.getExitDiagnostics !== 'function') {
      return reply.status(501).send({
        success: false,
        message: 'Exit diagnostics not implemented for this executor.',
      });
    }
    return ex.getExitDiagnostics(r.pair.id);
  });

  /** Maker-flatten only the active BTC bot (never ETH or other pairs). */
  fastify.post('/api/bots/current-btc-unilateral/maker-flatten', async (request, reply) => {
    const r = await resolveActiveBtcUnilateralPair();
    if (r.error === 'none') return reply.status(404).send({ success: false, ...r });
    if (r.error === 'ambiguous') return reply.status(409).send({ success: false, ...r });
    const pair = r.pair;
    const ex = pickExecutor(pair);
    if (typeof ex.makerFlattenOpenPositions !== 'function') {
      return reply.status(501).send({ success: false, message: 'maker-flatten not available.' });
    }
    const out = await ex.makerFlattenOpenPositions(pair.id);
    if (!out.success) return reply.status(400).send({ ...out, pairId: pair.id });
    return { ...out, pairId: pair.id, agentName: pair.agentName };
  });

  /** Why exits may be slow / whether the grid is full (TP·SL distance vs live signalSpread). */
  fastify.get('/api/pairs/:id/exit-diagnostics', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const pair = await StatArbInput.findByPk(id);
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });
    const ex = pickExecutor(pair);
    if (typeof ex.getExitDiagnostics !== 'function') {
      return reply.status(501).send({
        success: false,
        message: 'Exit diagnostics not implemented for this executor.',
      });
    }
    return ex.getExitDiagnostics(id);
  });

  /** Cancel resting orders and place maker limit exits for all open legs; then disable the pair. */
  fastify.post('/api/pairs/:id/maker-flatten', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const pair = await StatArbInput.findByPk(id);
    if (!pair) return reply.status(404).send({ success: false, message: 'Pair not found' });
    if (!pair.unilateralMode) {
      return reply.status(400).send({
        success: false,
        message: 'maker-flatten is only for unilateral (Deribit) pairs.',
      });
    }
    const ex = pickExecutor(pair);
    if (typeof ex.makerFlattenOpenPositions !== 'function') {
      return reply.status(501).send({ success: false, message: 'maker-flatten not available.' });
    }
    const out = await ex.makerFlattenOpenPositions(id);
    if (!out.success) return reply.status(400).send(out);
    return out;
  });

  // Live exchange positions for a pair (Deribit only)
  fastify.get('/api/pairs/:id/exchange-positions', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });

    // Load credentials for both accounts
    const accounts = await AccountDetails.findAll({
      where: { Trade_Account: [pair.tradeAccountA, pair.tradeAccountB].filter(Boolean) }
    });

    const results = {};
    for (const acc of accounts) {
      if (!acc.Api_Key || !acc.Secret_Key) continue;
      try {
        const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
        const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
        const apiKey = decryptCred(ak2, ak1, ak0);
        const secretKey = decryptCred(sk2, sk1, sk0);

        const posResp = await signedRequest(
          '/api/v2/private/get_positions?currency=BTC&kind=future',
          apiKey, secretKey
        );
        results[acc.Trade_Account] = posResp?.result ?? posResp;
      } catch (err) {
        results[acc.Trade_Account] = { error: err.message };
      }
    }

    return results;
  });

  // BTC-native PnL from exchange: realized (closed fills) + unrealized (open positions)
  fastify.get('/api/pairs/:id/exchange-pnl', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const pair = await StatArbInput.findByPk(pairId, { raw: true });
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });

    const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
    if (!acc?.Api_Key || !acc?.Secret_Key) return reply.status(400).send({ error: 'No credentials' });
    const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
    const apiKey    = decryptCred(ak2, ak1, ak0);
    const secretKey = decryptCred(sk2, sk1, sk0);

    const tradedSymbol = (pair.tradeLeg === 'B') ? pair.symbol2 : pair.symbol1;
    const sym = (tradedSymbol || '').toUpperCase();
    const currency = sym.includes('_USDC') ? 'USDC' : sym.startsWith('ETH') ? 'ETH' : 'BTC';
    // Scope fills to the current session (sessionStartedAt) so the panel shows
    // session-level data, not all-time since pair creation. Falls back to
    // pair.createdAt if no session has started yet.
    const startMs = pair.sessionStartedAt
      ? new Date(pair.sessionStartedAt).getTime()
      : new Date(pair.createdAt).getTime();
    const endMs   = Date.now();

    // Parallel: account summary + fills + closed DB positions
    const [acctResp, closedPos] = await Promise.all([
      signedRequest(`/api/v2/private/get_account_summary?currency=${currency}&extended=true`, apiKey, secretKey),
      BasisPosition.findAll({ where: { pairId, state: 'closed' }, order: [['exitTime', 'ASC']], raw: true }),
    ]);
    const acct = acctResp?.result || {};

    // Paginate fills
    const allFills = [];
    let startT = startMs;
    for (let i = 0; i < 100; i++) {
      const resp = await signedRequest(
        `/api/v2/private/get_user_trades_by_instrument_and_time?instrument_name=${encodeURIComponent(tradedSymbol)}&start_timestamp=${startT}&end_timestamp=${endMs}&count=500&sorting=asc`,
        apiKey, secretKey
      );
      const trades = resp?.result?.trades || [];
      if (trades.length === 0) break;
      allFills.push(...trades);
      startT = trades[trades.length - 1].timestamp + 1;
      if (trades.length < 500) break;
    }

    // Index fills by order_id
    const fillsByOrder = {};
    for (const f of allFills) {
      if (!fillsByOrder[f.order_id]) fillsByOrder[f.order_id] = [];
      fillsByOrder[f.order_id].push(f);
    }

    // Per-position BTC PnL
    let realizedGross = 0, realizedFees = 0, realizedNet = 0;
    let tpCount = 0, slCount = 0, toCount = 0;
    let tpBtc = 0, slBtc = 0;
    let matched = 0, makerFills = 0, takerFills = 0;

    for (const pos of closedPos) {
      const entryFills = fillsByOrder[pos.legA_entryOrderId] || [];
      const exitFills  = fillsByOrder[pos.legA_exitOrderId]  || [];
      if (entryFills.length === 0 || exitFills.length === 0) continue;
      matched++;

      let gross = 0, fee = 0;
      for (const f of [...entryFills, ...exitFills]) {
        gross += f.profit_loss || 0;
        fee   += f.fee || 0;
        if (f.liquidity === 'M') makerFills++; else takerFills++;
      }
      const net = gross - fee;
      realizedGross += gross;
      realizedFees  += fee;
      realizedNet   += net;

      if (pos.exitReason === 'profit')  { tpCount++; tpBtc += net; }
      else if (pos.exitReason === 'stop') { slCount++; slBtc += net; }
      else if (pos.exitReason === 'timeout') toCount++;
    }

    const unrealized   = acct.total_pl ?? 0;
    const balance      = acct.balance ?? null;
    const equity       = acct.equity ?? null;
    const startBalance = pair.sessionStartBalance ?? pair.botStartBalance ?? null;
    const balanceChange = (balance != null && startBalance != null) ? balance - startBalance : null;

    return {
      pairId,
      tradedSymbol,
      currency,
      balance,
      equity,
      startBalance,
      balanceChange,
      realized: {
        gross:  parseFloat(realizedGross.toFixed(8)),
        fees:   parseFloat(realizedFees.toFixed(8)),
        net:    parseFloat(realizedNet.toFixed(8)),
      },
      unrealized: parseFloat(unrealized.toFixed(8)),
      totalPnl:   parseFloat((realizedNet + unrealized).toFixed(8)),
      trades: {
        closed: closedPos.length,
        matched,
        tp: tpCount,
        sl: slCount,
        timeout: toCount,
        tpBtc: parseFloat(tpBtc.toFixed(8)),
        slBtc: parseFloat(slBtc.toFixed(8)),
      },
      fills: {
        total: allFills.length,
        maker: makerFills,
        taker: takerFills,
      },
      ts: Date.now(),
    };
  });

  // Cancel all open Deribit orders for this pair's symbols (safety cleanup)
  fastify.post('/api/pairs/:id/cancel-open-orders', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });
    if ((pair.exchange1 || '').toLowerCase() !== 'deribit' || (pair.exchange2 || '').toLowerCase() !== 'deribit') {
      return reply.status(400).send({ error: 'Only supported for Deribit/Deribit pairs' });
    }

    const accounts = await AccountDetails.findAll({
      where: { Trade_Account: [pair.tradeAccountA, pair.tradeAccountB].filter(Boolean) }
    });
    if (!accounts.length) return reply.status(404).send({ error: 'No accounts found for pair' });

    const symbols = [...new Set([pair.symbol1, pair.symbol2].filter(Boolean))];
    const out = [];
    const cancelledOrderIds = new Set();

    for (const acc of accounts) {
      const accRes = { account: acc.Trade_Account, symbols: [], cancelled: 0, openFound: 0, errors: [] };
      if (!acc.Api_Key || !acc.Secret_Key) {
        accRes.errors.push('Missing API credentials');
        out.push(accRes);
        continue;
      }

      try {
        const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
        const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
        const apiKey = decryptCred(ak2, ak1, ak0);
        const secretKey = decryptCred(sk2, sk1, sk0);

        for (const symbol of symbols) {
          const symRes = { symbol, open: 0, cancelled: 0, failed: 0 };
          try {
            const openResp = await signedRequest(
              `/api/v2/private/get_open_orders_by_instrument?instrument_name=${encodeURIComponent(symbol)}`,
              apiKey,
              secretKey
            );
            const openOrders = Array.isArray(openResp?.result) ? openResp.result : [];
            symRes.open = openOrders.length;
            accRes.openFound += openOrders.length;
            for (const o of openOrders) {
              const oid = o?.order_id;
              if (!oid) continue;
              const c = await cancelorder(oid, apiKey, secretKey);
              if (c && !c.error) {
                symRes.cancelled++;
                accRes.cancelled++;
                cancelledOrderIds.add(String(oid));
              }
              else { symRes.failed++; }
            }
          } catch (e) {
            accRes.errors.push(`${symbol}: ${e.message}`);
          }
          accRes.symbols.push(symRes);
        }
      } catch (e) {
        accRes.errors.push(e.message);
      }
      out.push(accRes);
    }

    // Reconcile local trade/basis records for orders we just cancelled on exchange.
    let reconciledTrades = 0;
    let reconciledPositions = 0;
    const cancelledIds = [...cancelledOrderIds];
    if (cancelledIds.length > 0) {
      const [count] = await Trade.update(
        { status: 'cancelled', cancelReason: 'exchange_order_cancelled_cleanup' },
        { where: { pairId, status: 'open', legA_orderId: { [Op.in]: cancelledIds } } }
      );
      reconciledTrades = count || 0;

      const cancelledEntryTrades = await Trade.findAll({
        where: {
          pairId,
          side: 'entry',
          status: 'cancelled',
          cancelReason: 'exchange_order_cancelled_cleanup',
          legA_orderId: { [Op.in]: cancelledIds },
        },
        attributes: ['id'],
      });
      const entryIds = cancelledEntryTrades.map(t => t.id);
      if (entryIds.length > 0) {
        const [bpCount] = await BasisPosition.update(
          { state: 'failed', reconcileNote: 'exchange_cleanup_cancelled_order' },
          { where: { entryTradeId: { [Op.in]: entryIds }, state: { [Op.in]: ['pending_entry', 'open'] } } }
        );
        reconciledPositions = bpCount || 0;
      }
    }

    return {
      pairId,
      symbols,
      results: out,
      reconciledTrades,
      reconciledPositions,
      cancelledOrderIds: [...cancelledOrderIds],
    };
  });

  // Reconcile local open trades against exchange order state (Deribit only)
  fastify.post('/api/pairs/:id/reconcile-open-trades', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });
    if ((pair.exchange1 || '').toLowerCase() !== 'deribit') {
      return reply.status(400).send({ error: 'Only supported for Deribit legA pairs' });
    }

    const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
    if (!acc || !acc.Api_Key || !acc.Secret_Key) {
      return reply.status(404).send({ error: 'Account credentials not found' });
    }

    const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
    const apiKey = decryptCred(ak2, ak1, ak0);
    const secretKey = decryptCred(sk2, sk1, sk0);

    const openTrades = await Trade.findAll({
      where: { pairId, status: 'open' },
      order: [['id', 'DESC']],
      limit: 200,
    });

    const reconciled = [];
    for (const t of openTrades) {
      const oid = t.legA_orderId;
      if (!oid) continue;
      let status = 'unknown';
      let raw = null;
      try {
        const s = await deribitorderStatus(oid, apiKey, secretKey);
        raw = s?.result ?? s;
        const r = Array.isArray(raw) ? raw[0] : raw;
        const os = String(r?.order_state || '').toLowerCase();
        if (os === 'open' || os === 'untriggered') status = 'open';
        else if (os === 'cancelled' || os === 'canceled' || os === 'rejected') status = 'cancelled';
        else if (os === 'filled') status = 'filled';
        else if (!r) status = 'missing';
      } catch (_) {
        status = 'missing';
      }

      if (status === 'cancelled' || status === 'missing') {
        await Trade.update(
          { status: 'cancelled', cancelReason: status === 'missing' ? 'exchange_order_missing_reconcile' : 'exchange_order_cancelled_reconcile' },
          { where: { id: t.id } }
        ).catch(() => { });
        if (t.side === 'entry') {
          await BasisPosition.update(
            { state: 'failed', reconcileNote: 'reconcile_open_trade_cancelled_or_missing' },
            { where: { entryTradeId: t.id, state: { [Op.in]: ['pending_entry', 'open'] } } }
          ).catch(() => { });
        }
        reconciled.push({ tradeId: t.id, orderId: oid, reconciledTo: 'cancelled', sourceStatus: status });
      } else if (status === 'filled') {
        // Exchange confirms filled but DB still shows open — backfill the status.
        await Trade.update(
          { status: 'filled', legA_filledAt: t.legA_filledAt ?? new Date() },
          { where: { id: t.id } }
        ).catch(() => { });
        // Advance pending_entry basis positions to open so the executor can continue.
        if (t.side === 'entry') {
          await BasisPosition.update(
            { state: 'open', reconciledAt: new Date(), reconcileNote: 'reconcile_entry_backfilled_filled' },
            { where: { entryTradeId: t.id, state: 'pending_entry' } }
          ).catch(() => { });
        }
        reconciled.push({ tradeId: t.id, orderId: oid, reconciledTo: 'filled', sourceStatus: status });
      }
    }

    return {
      pairId,
      checked: openTrades.length,
      reconciledCount: reconciled.length,
      reconciled,
    };
  });

  // Manually trigger the 5-minute reconcile cycle for a pair immediately
  fastify.post('/api/pairs/:id/reconcile', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });

    const ex = pickExecutor(pair);
    const state = ex.pairs?.get(pairId);

    // If the executor has this pair loaded, fire the full exchange reconcile.
    if (state && typeof ex._reconcileWithExchange === 'function') {
      try {
        await ex._reconcileWithExchange(pairId);
        return { pairId, triggered: true, source: 'executor' };
      } catch (err) {
        return reply.status(500).send({ error: `Reconcile failed: ${err.message}` });
      }
    }

    // Executor not running for this pair — fall back to DB-only open-trade check
    // (same logic as reconcile-open-trades but accessible via simpler URL).
    if ((pair.exchange1 || '').toLowerCase() !== 'deribit') {
      return { pairId, triggered: false, reason: 'executor_not_running_and_not_deribit' };
    }

    const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
    if (!acc || !acc.Api_Key || !acc.Secret_Key) {
      return reply.status(404).send({ error: 'Account credentials not found' });
    }

    const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
    const apiKey = decryptCred(ak2, ak1, ak0);
    const secretKey = decryptCred(sk2, sk1, sk0);

    const openTrades = await Trade.findAll({
      where: { pairId, status: 'open' },
      order: [['id', 'DESC']],
      limit: 200,
    });

    const reconciled = [];
    for (const t of openTrades) {
      const oid = t.legA_orderId;
      if (!oid) {
        await Trade.update({ status: 'cancelled', cancelReason: 'reconcile_no_order_id' }, { where: { id: t.id } }).catch(() => { });
        reconciled.push({ tradeId: t.id, orderId: null, reconciledTo: 'cancelled', sourceStatus: 'no_order_id' });
        continue;
      }
      let exchStatus = 'unknown';
      try {
        const s = await deribitorderStatus(oid, apiKey, secretKey);
        const r = Array.isArray(s?.result) ? s.result[0] : s?.result;
        const os = String(r?.order_state || '').toLowerCase();
        if (os === 'open' || os === 'untriggered') exchStatus = 'open';
        else if (os === 'cancelled' || os === 'canceled' || os === 'rejected') exchStatus = 'cancelled';
        else if (os === 'filled') exchStatus = 'filled';
        else if (!r) exchStatus = 'missing';
      } catch (_) {
        exchStatus = 'missing';
      }

      if (exchStatus === 'cancelled' || exchStatus === 'missing') {
        await Trade.update(
          { status: 'cancelled', cancelReason: exchStatus === 'missing' ? 'exchange_order_missing_reconcile' : 'exchange_order_cancelled_reconcile' },
          { where: { id: t.id } }
        ).catch(() => { });
        if (t.side === 'entry') {
          await BasisPosition.update(
            { state: 'failed', reconcileNote: 'reconcile_open_trade_cancelled_or_missing' },
            { where: { entryTradeId: t.id, state: { [Op.in]: ['pending_entry', 'open'] } } }
          ).catch(() => { });
        }
        reconciled.push({ tradeId: t.id, orderId: oid, reconciledTo: 'cancelled', sourceStatus: exchStatus });
      } else if (exchStatus === 'filled') {
        await Trade.update(
          { status: 'filled', legA_filledAt: t.legA_filledAt ?? new Date() },
          { where: { id: t.id } }
        ).catch(() => { });
        if (t.side === 'entry') {
          await BasisPosition.update(
            { state: 'open', reconciledAt: new Date(), reconcileNote: 'reconcile_entry_backfilled_filled' },
            { where: { entryTradeId: t.id, state: 'pending_entry' } }
          ).catch(() => { });
        }
        reconciled.push({ tradeId: t.id, orderId: oid, reconciledTo: 'filled', sourceStatus: exchStatus });
      }
    }

    return {
      pairId,
      triggered: true,
      source: 'db_only_fallback',
      checked: openTrades.length,
      reconciledCount: reconciled.length,
      reconciled,
    };
  });

  // Close a specific exchange position by placing a market order in the opposite direction (Deribit only)
  fastify.post('/api/pairs/:id/close-exchange-position', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const { instrument, qty, account } = request.body || {};
    if (!instrument || !qty) return reply.status(400).send({ error: 'instrument and qty required' });

    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return reply.status(404).send({ error: 'Pair not found' });

    const accountName = account || pair.tradeAccountA;
    const accounts = await AccountDetails.findAll({ where: { Trade_Account: accountName } });
    if (!accounts.length) return reply.status(404).send({ error: `Account not found: ${accountName}` });

    const acc = accounts[0];
    const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
    const apiKey = decryptCred(ak2, ak1, ak0);
    const secretKey = decryptCred(sk2, sk1, sk0);

    // Fetch current position to determine side
    const posResp = await signedRequest(
      `/api/v2/private/get_positions?currency=BTC&kind=future`,
      apiKey, secretKey
    );
    const positions = posResp?.result ?? [];
    const pos = Array.isArray(positions) ? positions.find(p => p.instrument_name === instrument) : null;
    const currentSize = pos?.size ?? 0;

    if (currentSize === 0) return { message: 'No open position', instrument, size: 0 };

    // To close: if short (size < 0) → BUY; if long (size > 0) → SELL
    const closeQty = Math.abs(qty);
    let orderResp;
    if (currentSize < 0) {
      // Close short: BUY at market
      orderResp = await buyorder(instrument, closeQty, 'market', null, apiKey, secretKey);
    } else {
      // Close long: SELL at market
      orderResp = await sellorder(instrument, closeQty, 'market', null, apiKey, secretKey);
    }

    return { instrument, currentSize, closeQty, side: currentSize < 0 ? 'buy' : 'sell', response: orderResp };
  });

  // RAG hourly stats for a pair (or agent)
  fastify.get('/api/pairs/:id/rag-stats', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const days = Math.min(parseInt(request.query.days ?? 7), 30);
    const since = new Date(Date.now() - days * 86400000);
    const HourlyRagStat = require('../models/HourlyRagStat');
    const rows = await HourlyRagStat.findAll({
      where: { pairId, hourUtc: { [Op.gte]: since } },
      order: [['hourUtc', 'DESC']],
      limit: days * 24,
    });
    const green = rows.filter(r => r.rag === 'GREEN').length;
    const amber = rows.filter(r => r.rag === 'AMBER').length;
    const red   = rows.filter(r => r.rag === 'RED').length;
    const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalVol = rows.reduce((s, r) => s + (r.volumeUsd || 0), 0);
    return {
      pairId,
      days,
      summary: { green, amber, red, totalPnl: +totalPnl.toFixed(4), totalVolumeUsd: +totalVol.toFixed(2) },
      hours: rows,
    };
  });

  // RAG stats for all pairs of an agent
  fastify.get('/api/agents/:name/rag-stats', async (request, reply) => {
    const { name } = request.params;
    const days = Math.min(parseInt(request.query.days ?? 7), 30);
    const since = new Date(Date.now() - days * 86400000);
    const pairs = await StatArbInput.findAll({ where: { agentName: name }, attributes: ['id'] });
    const pairIds = pairs.map(p => p.id);
    if (pairIds.length === 0) return { hours: [], summary: {} };
    const HourlyRagStat = require('../models/HourlyRagStat');
    const rows = await HourlyRagStat.findAll({
      where: { pairId: { [Op.in]: pairIds }, hourUtc: { [Op.gte]: since } },
      order: [['hourUtc', 'DESC']],
    });
    const green = rows.filter(r => r.rag === 'GREEN').length;
    const amber = rows.filter(r => r.rag === 'AMBER').length;
    const red   = rows.filter(r => r.rag === 'RED').length;
    const totalPnl = rows.reduce((s, r) => s + (r.pnl || 0), 0);
    const totalVol = rows.reduce((s, r) => s + (r.volumeUsd || 0), 0);
    return {
      agentName: name,
      pairIds,
      days,
      summary: { green, amber, red, totalPnl: +totalPnl.toFixed(4), totalVolumeUsd: +totalVol.toFixed(2) },
      hours: rows,
    };
  });

  // Session history for a pair — uptime, downtime, stop reasons
  fastify.get('/api/pairs/:id/sessions', async (request, reply) => {
    const pairId = parseInt(request.params.id);
    const limit  = Math.min(parseInt(request.query.limit ?? 50), 200);
    const sessions = await BotSessionLog.findAll({
      where: { pairId },
      order: [['id', 'DESC']],
      limit,
    });
    return sessions;
  });

  // Roundtrips — BasisPosition records with entry→exit mapping
  fastify.get('/api/trades/roundtrips', async (request, reply) => {
    const { pairId, pairIds: pairIdsRaw, agentName, since } = request.query;
    const where = {};
    if (pairId) where.pairId = parseInt(pairId);
    if (pairIdsRaw && !pairId) {
      const ids = pairIdsRaw.split(',').map(Number).filter(Boolean);
      if (ids.length > 0) where.pairId = ids;
      else return [];
    }
    if (agentName) {
      const agentPairs = await StatArbInput.findAll({ where: { agentName }, attributes: ['id'] });
      const ids = agentPairs.map(p => p.id);
      if (ids.length > 0) where.pairId = ids;
      else return [];
    }
    // Show positions with a confirmed entry, including unilateral signal mode.
    where.state = { [Op.in]: ['open', 'pending_exit', 'closed'] };
    where.legA_entryPrice = { [Op.ne]: null };
    if (since) where.createdAt = { [Op.gte]: new Date(since) };

    const positions = await BasisPosition.findAll({
      where,
      order: [['id', 'DESC']],
      limit: 500,
    });

    const tradeIds = [];
    for (const p of positions) {
      if (p.entryTradeId) tradeIds.push(p.entryTradeId);
      if (p.exitTradeId) tradeIds.push(p.exitTradeId);
    }
    const uniqTradeIds = [...new Set(tradeIds)];
    const trades = uniqTradeIds.length > 0
      ? await Trade.findAll({ where: { id: { [Op.in]: uniqTradeIds } } })
      : [];
    const tradeMap = new Map(trades.map(t => [t.id, t]));

    return positions.map((p) => {
      const row = p.toJSON();
      const entryTrade = row.entryTradeId ? tradeMap.get(row.entryTradeId) : null;
      const exitTrade = row.exitTradeId ? tradeMap.get(row.exitTradeId) : null;

      const fallbackGross =
        (exitTrade?.pnl ?? null) ??
        ((
          (entryTrade?.legA_pnl ?? 0) + (entryTrade?.legB_pnl ?? 0) +
          (exitTrade?.legA_pnl ?? 0) + (exitTrade?.legB_pnl ?? 0)
        ) || null);
      const fallbackCommission =
        ((entryTrade?.commission ?? 0) + (exitTrade?.commission ?? 0)) || null;
      const fallbackTakerFee =
        ((entryTrade?.takerFeeUsd ?? 0) + (exitTrade?.takerFeeUsd ?? 0)) || null;
      const grossPnl = row.grossPnl ?? fallbackGross;
      const commission = row.commission ?? fallbackCommission;
      const takerFeeUsd = row.takerFeeUsd ?? fallbackTakerFee;
      const netPnl = row.netPnl ?? (grossPnl != null ? (grossPnl + (commission ?? 0) - (takerFeeUsd ?? 0)) : null);

      const entryTime = row.entryTime ?? entryTrade?.createdAt ?? null;
      const exitTime = row.exitTime ?? exitTrade?.createdAt ?? null;
      const holdMs = row.holdMs ?? ((entryTime && exitTime) ? (new Date(exitTime).getTime() - new Date(entryTime).getTime()) : null);

      return {
        ...row,
        entrySpread: row.entrySpread ?? entryTrade?.spreadAtEntry ?? null,
        entrySignalSpread: row.entrySpread ?? entryTrade?.spreadAtEntry ?? null,
        entryFillSpread: ((
          (row.legA_entryPrice ?? entryTrade?.legA_price) != null &&
          (row.legB_entryPrice ?? entryTrade?.legB_price) != null
        ) ? parseFloat(((row.legA_entryPrice ?? entryTrade?.legA_price) - (row.legB_entryPrice ?? entryTrade?.legB_price)).toFixed(4)) : null),
        exitSpread: row.exitSpread ?? exitTrade?.spreadAtExit ?? null,
        legA_entryPrice: row.legA_entryPrice ?? entryTrade?.legA_price ?? null,
        legB_entryPrice: row.legB_entryPrice ?? entryTrade?.legB_price ?? null,
        legA_exitPrice: row.legA_exitPrice ?? exitTrade?.legA_price ?? null,
        legB_exitPrice: row.legB_exitPrice ?? exitTrade?.legB_price ?? null,
        grossPnl,
        commission,
        takerFeeUsd,
        netPnl,
        entryTime,
        exitTime,
        holdMs,
        entrySpreadSlippage: ((
          (row.entrySpread ?? entryTrade?.spreadAtEntry) != null &&
          ((row.legA_entryPrice ?? entryTrade?.legA_price) != null && (row.legB_entryPrice ?? entryTrade?.legB_price) != null)
        ) ? parseFloat((((row.legA_entryPrice ?? entryTrade?.legA_price) - (row.legB_entryPrice ?? entryTrade?.legB_price)) - (row.entrySpread ?? entryTrade?.spreadAtEntry)).toFixed(4)) : null),
        entryTradeStatus: entryTrade?.status ?? null,
        exitTradeStatus: exitTrade?.status ?? null,
      };
    });
  });

  // Get all trade logs — filterable by agent
  fastify.get('/api/trades', async (request, reply) => {
    const { pairId, pairIds: pairIdsRaw, status, agentName, since } = request.query;
    const where = {};
    if (pairId) where.pairId = parseInt(pairId);
    if (status) where.status = status;
    if (since) where.createdAt = { [Op.gte]: new Date(since) };

    if (pairIdsRaw && !pairId) {
      const ids = pairIdsRaw.split(',').map(Number).filter(Boolean);
      if (ids.length > 0) where.pairId = ids;
      else return [];
    }

    if (agentName) {
      const agentPairs = await StatArbInput.findAll({ where: { agentName }, attributes: ['id'] });
      const ids = agentPairs.map(p => p.id);
      if (ids.length > 0) {
        where.pairId = ids;
      } else {
        return [];
      }
    }

    const trades = await Trade.findAll({ where, order: [['createdAt', 'DESC']] });
    return trades;
  });

  // Get trade analytics summary — symbol-wise, filterable by agent
  fastify.get('/api/trades/analytics', async (request, reply) => {
    const { pairId, pairIds: pairIdsRaw, agentName, since } = request.query;
    const where = {};
    if (since) where.createdAt = { [Op.gte]: new Date(since) };
    const emptyResult = {
      totalTrades: 0, filledCount: 0, cancelledCount: 0, otherCount: 0, totalExecutions: 0, totalRoundtrips: 0,
      totalBuys: 0, totalSells: 0, totalVolume: 0, totalPnl: 0, totalFeesLegA: 0, totalFeesLegB: 0, totalFees: 0, netPnlAfterFees: 0,
      makerRebateNativeByCurrency: {},
      perSymbol: {},
    };
    if (pairId) where.pairId = parseInt(pairId);

    if (pairIdsRaw && !pairId) {
      const ids = pairIdsRaw.split(',').map(Number).filter(Boolean);
      if (ids.length > 0) where.pairId = ids;
      else return emptyResult;
    }

    if (agentName) {
      const agentPairs = await StatArbInput.findAll({ where: { agentName }, attributes: ['id'] });
      const ids = agentPairs.map(p => p.id);
      if (ids.length > 0) {
        where.pairId = ids;
      } else {
        return emptyResult;
      }
    }

    const trades = await Trade.findAll({ where, order: [['createdAt', 'ASC']] });

    // Count by status
    const totalTrades = trades.length;
    let filledCount = 0, cancelledCount = 0, otherCount = 0;
    for (const t of trades) {
      if (t.status === 'filled') filledCount++;
      else if (t.status === 'cancelled') cancelledCount++;
      else otherCount++;
    }

    // Only use filled trades for analytics
    const filledTrades = trades.filter(t => t.status === 'filled');

    // Fee rates per exchange (maker / taker)
    // Deribit: maker = -0.0001015 (rebate, negative = credit), taker = 0.0002339
    const FEE_RATES = {
      hyperliquid: { maker: 0.00015,    taker: 0.00045  },
      deribit:     { maker: -0.0001015, taker: 0.0002339 },
    };
    const getFeeRate = (exchange, fillType) => {
      const ex = (exchange || '').toLowerCase();
      const rates = FEE_RATES[ex] || { maker: 0.0002, taker: 0.0005 };
      return fillType === 'taker' ? rates.taker : rates.maker;
    };

    // Correct USD notional:
    //   Deribit inverse (BTC-PERPETUAL, ETH-PERPETUAL, …): qty is already USD notional
    //   Deribit linear/USDC-margined (SOL_USDC-PERPETUAL, BTC_USDC-PERPETUAL, …): price × qty
    //   Hyperliquid linear: price × qty
    const notionalUsd = (exchange, symbol, price, qty) => {
      if ((exchange || '').toLowerCase() === 'deribit') {
        // USDC-margined perpetuals have "_USDC" in the symbol name and are linear
        if ((symbol || '').includes('_USDC')) return price * qty;
        // Inverse perpetuals: API amount field is already in USD
        return qty;
      }
      return price * qty;
    };

    // Total executions = filled legA orders; count legB only when qty > 0.
    let totalExecutions = 0;
    for (const t of filledTrades) {
      if (t.legA_filledAt) totalExecutions++;
      if (t.legB_filledAt && (t.legB_qty || 0) > 0) totalExecutions++;
    }

    // totalFeesLegA = total maker rebate in USD (USDC-equivalent for display)
    // totalFeesLegB = total taker fee paid (positive = cost, subtracts from net P&L)
    const makerRebateNativeByCurrency = {};
    let totalFeesLegA = 0, totalFeesLegB = 0;
    for (const t of filledTrades) {
      let rebateUsd = 0;
      const comm = t.commission != null ? parseFloat(t.commission) : null;
      if (comm != null && Number.isFinite(comm) && comm > 0) {
        rebateUsd = makerRebateUsdFromTradeRow(t);
        const { amount, coin } = makerRebateNativeFromTradeRow(t);
        if (coin && amount > 0) {
          makerRebateNativeByCurrency[coin] = (makerRebateNativeByCurrency[coin] || 0) + amount;
        }
      } else if (t.legA_price != null && t.legA_qty != null && t.legA_filledAt) {
        const rate = getFeeRate(t.legA_exchange, t.legA_fillType);
        rebateUsd = Math.abs(notionalUsd(t.legA_exchange, t.legA_symbol, t.legA_price, t.legA_qty) * rate);
      }
      totalFeesLegA += rebateUsd;
      // Taker fee: use actual takerFeeUsd; fall back to legacy 2-leg notional estimate
      if (t.takerFeeUsd != null) {
        totalFeesLegB += t.takerFeeUsd; // taker fee (positive = cost)
      } else if (t.legB_price != null && t.legB_qty != null && (t.legB_qty || 0) > 0 && t.legB_filledAt && t.legB_symbol) {
        totalFeesLegB += notionalUsd(t.legB_exchange, t.legB_symbol, t.legB_price, t.legB_qty) * getFeeRate(t.legB_exchange, 'taker');
      }
    }

    // Collect all fills into a per-symbol map
    const symbols = {}; // symbol -> { buys:[], sells:[], buyVwaps:[], sellVwaps:[], pnl:0 }

    const ensureSymbol = (sym, feeRate) => {
      if (!symbols[sym]) {
        symbols[sym] = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, buyVwaps: [], sellVwaps: [], pnl: 0, buyFills: [], sellFills: [], fees: 0, feeRate: feeRate || 0.00015 };
      }
      return symbols[sym];
    };

    for (const t of filledTrades) {
      // Process leg A
      if (t.legA_symbol && t.legA_filledAt) {
        const s = ensureSymbol(t.legA_symbol, getFeeRate(t.legA_exchange, t.legA_fillType));
        if (t.legA_side === 'buy') {
          s.buys++;
          if (t.legA_price != null && t.legA_qty != null) {
            const vol = notionalUsd(t.legA_exchange, t.legA_symbol, t.legA_price, t.legA_qty);
            s.buyVolume += vol;
            s.buyFills.push({ price: t.legA_price, qty: t.legA_qty });
          }
        } else if (t.legA_side === 'sell') {
          s.sells++;
          if (t.legA_price != null && t.legA_qty != null) {
            const vol = notionalUsd(t.legA_exchange, t.legA_symbol, t.legA_price, t.legA_qty);
            s.sellVolume += vol;
            s.sellFills.push({ price: t.legA_price, qty: t.legA_qty });
          }
        }
        // Maker rebate reduces net fee cost (income), always in USD for symbol rollups
        const commA = t.commission != null ? parseFloat(t.commission) : null;
        if (commA != null && Number.isFinite(commA) && commA > 0) {
          s.fees -= makerRebateUsdFromTradeRow(t);
        } else if (t.legA_price != null && t.legA_qty != null) {
          s.fees -= Math.abs(notionalUsd(t.legA_exchange, t.legA_symbol, t.legA_price, t.legA_qty) * getFeeRate(t.legA_exchange, t.legA_fillType));
        }
        if (t.legA_side === 'buy'  && t.legA_buyVwap  != null) s.buyVwaps.push(t.legA_buyVwap);
        if (t.legA_side === 'sell' && t.legA_sellVwap != null) s.sellVwaps.push(t.legA_sellVwap);
        if (t.legA_pnl != null) s.pnl += t.legA_pnl; // gross PnL
      }

      // Process leg B — only for legacy 2-leg trades (legB_symbol present)
      if (t.legB_symbol && t.legB_filledAt && (t.legB_qty || 0) > 0) {
        const s = ensureSymbol(t.legB_symbol, getFeeRate(t.legB_exchange, t.legB_fillType));
        if (t.legB_side === 'buy') {
          s.buys++;
          if (t.legB_price != null && t.legB_qty != null) {
            s.buyVolume += notionalUsd(t.legB_exchange, t.legB_symbol, t.legB_price, t.legB_qty);
            s.buyFills.push({ price: t.legB_price, qty: t.legB_qty });
          }
        } else if (t.legB_side === 'sell') {
          s.sells++;
          if (t.legB_price != null && t.legB_qty != null) {
            s.sellVolume += notionalUsd(t.legB_exchange, t.legB_symbol, t.legB_price, t.legB_qty);
            s.sellFills.push({ price: t.legB_price, qty: t.legB_qty });
          }
        }
        if (t.takerFeeUsd != null) {
          s.fees += t.takerFeeUsd; // actual taker fee for this trade's legB
        } else if (t.legB_price != null && t.legB_qty != null) {
          s.fees += notionalUsd(t.legB_exchange, t.legB_symbol, t.legB_price, t.legB_qty) * getFeeRate(t.legB_exchange, 'taker');
        }
        if (t.legB_side === 'buy'  && t.legB_buyVwap  != null) s.buyVwaps.push(t.legB_buyVwap);
        if (t.legB_side === 'sell' && t.legB_sellVwap != null) s.sellVwaps.push(t.legB_sellVwap);
        if (t.legB_pnl != null) s.pnl += t.legB_pnl;
      }
    }

    // Pair-level roundtrips: use closed BasisPosition records for exact entry→exit matching.
    const roundtripWhere = { ...where, state: 'closed' };
    const closedPositions = await BasisPosition.findAll({
      where: roundtripWhere,
      attributes: ['grossPnl', 'commission', 'takerFeeUsd', 'netPnl'],
      limit: 5000,
    });
    const totalRoundtrips = closedPositions.length;
    const totalRoundtripGrossPnl = parseFloat(closedPositions.reduce((s, p) => s + Number(p.grossPnl || 0), 0).toFixed(6));
    const totalRoundtripCommission = parseFloat(closedPositions.reduce((s, p) => s + Number(p.commission || 0), 0).toFixed(6));
    const totalRoundtripTakerFees = parseFloat(closedPositions.reduce((s, p) => s + Number(p.takerFeeUsd || 0), 0).toFixed(6));
    const totalRoundtripNetPnl = parseFloat(closedPositions.reduce((s, p) => s + Number(p.netPnl || 0), 0).toFixed(6));

    // Build per-symbol analytics
    let totalVolume = 0, totalPnl = 0;
    const perSymbol = {};

    for (const [sym, d] of Object.entries(symbols)) {
      const roundtrips = Math.min(d.buys, d.sells);
      const volume = d.buyVolume + d.sellVolume;
      const avgBuyVwap = d.buyVwaps.length > 0 ? d.buyVwaps.reduce((a, b) => a + b, 0) / d.buyVwaps.length : null;
      const avgSellVwap = d.sellVwaps.length > 0 ? d.sellVwaps.reduce((a, b) => a + b, 0) / d.sellVwaps.length : null;

      perSymbol[sym] = {
        buys: d.buys,
        sells: d.sells,
        roundtrips,
        buyVolume: parseFloat(d.buyVolume.toFixed(4)),
        sellVolume: parseFloat(d.sellVolume.toFixed(4)),
        volume: parseFloat(volume.toFixed(4)),
        avgBuyVwap: avgBuyVwap != null ? parseFloat(avgBuyVwap.toFixed(4)) : null,
        avgSellVwap: avgSellVwap != null ? parseFloat(avgSellVwap.toFixed(4)) : null,
        pnl: parseFloat(d.pnl.toFixed(6)),
        fees: parseFloat(d.fees.toFixed(6)),
        netPnl: parseFloat((d.pnl - d.fees).toFixed(6)),
      };

      totalVolume += volume;
      totalPnl += d.pnl;
    }

    // Aggregate buys/sells at trade level (not per-symbol to avoid double-counting)
    const totalBuys = filledTrades.filter(t => t.side === 'entry' && t.legA_side === 'buy').length
                    + filledTrades.filter(t => t.side === 'exit' && t.legA_side === 'buy').length;
    const totalSells = filledTrades.filter(t => t.side === 'entry' && t.legA_side === 'sell').length
                     + filledTrades.filter(t => t.side === 'exit' && t.legA_side === 'sell').length;

    // Exchange-reported PnL from actual balance changes (includes fees + funding)
    let totalExchangePnl = null;
    const exitTrades = filledTrades.filter(t => t.side === 'exit' && t.exchangePnl != null);
    if (exitTrades.length > 0) {
      totalExchangePnl = parseFloat(exitTrades.reduce((sum, t) => sum + parseFloat(t.exchangePnl), 0).toFixed(6));
    }

    // totalFees = net fee cost = taker fees - maker rebates (positive = net cost)
    const totalFees = parseFloat((totalFeesLegB - totalFeesLegA).toFixed(6));
    const makerRebateNativeRounded = {};
    for (const [k, v] of Object.entries(makerRebateNativeByCurrency)) {
      const dec = k === 'BTC' ? 8 : k === 'ETH' ? 6 : 4;
      makerRebateNativeRounded[k] = parseFloat(Number(v).toFixed(dec));
    }
    return {
      totalTrades,
      filledCount,
      cancelledCount,
      otherCount,
      totalExecutions,
      totalRoundtrips,
      totalRoundtripGrossPnl,
      totalRoundtripCommission,
      totalRoundtripTakerFees,
      totalRoundtripNetPnl,
      totalBuys,
      totalSells,
      totalVolume: parseFloat(totalVolume.toFixed(4)),
      totalPnl: parseFloat(totalPnl.toFixed(6)),
      totalFeesLegA: parseFloat(totalFeesLegA.toFixed(6)),
      totalFeesLegB: parseFloat(totalFeesLegB.toFixed(6)),
      totalFees,
      netPnlAfterFees: parseFloat((totalPnl + totalFeesLegA - totalFeesLegB).toFixed(6)),
      totalExchangePnl,
      makerRebateNativeByCurrency: makerRebateNativeRounded,
      perSymbol,
    };
  });
}

module.exports = tradeRoutes;
