const { StatArbInput } = require('../models');
const orderbookManager = require('../services/orderbookStreams');
const { clearLogs } = require('../services/spreadFileLogger');

async function syncStreams() {
  const activeStatArbInputs = await StatArbInput.findAll({ where: { status: 'active' } });
  orderbookManager.syncWithActivePairs(activeStatArbInputs);
}

async function pairRoutes(fastify, options) {
  // GET /api/pairs
  fastify.get('/api/pairs', async (request, reply) => {
    const { status } = request.query;
    const where = status ? { status } : {};
    const pairs = await StatArbInput.findAll({ where, order: [['createdAt', 'DESC']] });
    return pairs;
  });

  // POST /api/pairs
  fastify.post('/api/pairs', async (request, reply) => {
    const b = request.body;
    const f = (v) => (v != null && v !== '' ? parseFloat(v) : null);
    const i = (v) => (v != null && v !== '' ? parseInt(v) : null);
    const s = (v) => (v != null && v !== '' ? v : null);
    const bl = (v) => (v != null && v !== '' ? !!v : null);
    const pair = await StatArbInput.create({
      exchange1: b.exchange1, type1: b.type1, symbol1: b.symbol1,
      exchange2: b.exchange2, type2: b.type2, symbol2: b.symbol2,
      agentName: s(b.agentName),
      tradeAccountA: s(b.tradeAccountA),
      qty1: f(b.qty1),
      tradeAccountB: s(b.tradeAccountB),
      qty2: f(b.qty2),
      maxQty1: f(b.maxQty1),
      beta: f(b.beta),
      dailyLossLimitPct: f(b.dailyLossLimitPct),
      dailyProfitLimitPct: f(b.dailyProfitLimitPct),
      profitTarget: f(b.profitTarget),
      stopLoss: f(b.stopLoss),
      maxHoldMs: i(b.maxHoldMs),
      dailyLossLimitUsd: f(b.dailyLossLimitUsd),
      maxDrawdownUsd: f(b.maxDrawdownUsd),
      drawdownPct: f(b.drawdownPct),
      zEntryThreshold: f(b.zEntryThreshold),
      zEntryMax: f(b.zEntryMax),
      maxLegAQty: f(b.maxLegAQty),
      maxLegBQty: f(b.maxLegBQty),
      maxNetQtyImbalance: f(b.maxNetQtyImbalance),
      maxPositions: i(b.maxPositions),
      spreadEntryLevels: s(b.spreadEntryLevels),
      maxSpreadCap: f(b.maxSpreadCap),
      entryPollTimeoutMs: i(b.entryPollTimeoutMs),
      profitFeeMultiplier: f(b.profitFeeMultiplier),
      unilateralMode: b.unilateralMode != null ? !!b.unilateralMode : false,
      tradeLeg: s(b.tradeLeg) || 'A',
      tpSpreadDelta: f(b.tpSpreadDelta),
      slSpreadDelta: f(b.slSpreadDelta),
      // adaptive levels
      adaptLevels: b.adaptLevels != null ? !!b.adaptLevels : false,
      adaptSigmaMin: f(b.adaptSigmaMin),
      adaptSigmaMax: f(b.adaptSigmaMax),
      adaptTpSigma: f(b.adaptTpSigma),
      adaptSlSigma: f(b.adaptSlSigma),
      adaptMinTpSlRatio: f(b.adaptMinTpSlRatio),
      trendPauseJumpPct: f(b.trendPauseJumpPct),
      trendPauseDurationMs: i(b.trendPauseDurationMs),
      adaptIntervalUsaMs: i(b.adaptIntervalUsaMs),
      adaptIntervalOffHoursMs: i(b.adaptIntervalOffHoursMs),
      // kill switches
      priceUpperLimit: f(b.priceUpperLimit),
      priceLowerLimit: f(b.priceLowerLimit),
      optionInstruments: s(b.optionInstruments),
      optionProfitTargetUsd: f(b.optionProfitTargetUsd),
      // advanced
      executorVersion: s(b.executorVersion),
      fixedTpUsd: f(b.fixedTpUsd),
      maxSingleTradeLossUsd: f(b.maxSingleTradeLossUsd),
      grossNegativeScratchMs: i(b.grossNegativeScratchMs),
      entryRequoteOnMovePx: f(b.entryRequoteOnMovePx),
      tradingEnabled: b.tradingEnabled != null ? !!b.tradingEnabled : false,
      status: 'active',
    });
    await syncStreams();
    return reply.status(201).send(pair);
  });

  // PUT /api/pairs/:id — edit pair config
  fastify.put('/api/pairs/:id', async (request, reply) => {
    const { id } = request.params;
    const pair = await StatArbInput.findByPk(id);
    if (!pair) {
      return reply.status(404).send({ error: 'StatArbInput not found' });
    }
    const floatFields = [
      'qty1', 'qty2', 'maxQty1', 'beta',
      'dailyLossLimitPct', 'dailyProfitLimitPct',
      'profitTarget', 'stopLoss',
      'dailyLossLimitUsd', 'maxDrawdownUsd', 'drawdownPct',
      'zEntryThreshold', 'zEntryMax',
      'maxLegAQty', 'maxLegBQty', 'maxNetQtyImbalance', 'maxSpreadCap',
      'profitFeeMultiplier', 'tpSpreadDelta', 'slSpreadDelta',
      'adaptSigmaMin', 'adaptSigmaMax', 'adaptTpSigma', 'adaptSlSigma',
      'adaptMinTpSlRatio', 'trendPauseJumpPct',
      'priceUpperLimit', 'priceLowerLimit',
      'optionProfitTargetUsd', 'fixedTpUsd', 'maxSingleTradeLossUsd',
      'entryRequoteOnMovePx',
    ];
    const intFields = [
      'maxHoldMs', 'maxPositions', 'entryPollTimeoutMs',
      'trendPauseDurationMs', 'adaptIntervalUsaMs', 'adaptIntervalOffHoursMs',
      'grossNegativeScratchMs',
    ];
    const strFields = [
      'spreadEntryLevels', 'tradeLeg', 'executorVersion', 'optionInstruments',
      'agentName', 'exchange1', 'type1', 'symbol1', 'exchange2', 'type2', 'symbol2',
      'tradeAccountA', 'tradeAccountB',
    ];
    const boolFields = ['unilateralMode', 'adaptLevels', 'tradingEnabled', 'stopUseMarketOnBreach'];
    const updates = {};
    for (const key of floatFields) {
      if (request.body[key] !== undefined) {
        updates[key] = request.body[key] === '' || request.body[key] === null ? null : parseFloat(request.body[key]);
      }
    }
    for (const key of intFields) {
      if (request.body[key] !== undefined) {
        updates[key] = request.body[key] === '' || request.body[key] === null ? null : parseInt(request.body[key]);
      }
    }
    for (const key of strFields) {
      if (request.body[key] !== undefined) {
        updates[key] = request.body[key] === '' || request.body[key] === null ? null : request.body[key];
      }
    }
    for (const key of boolFields) {
      if (request.body[key] !== undefined) {
        updates[key] = request.body[key] === '' || request.body[key] === null ? null : !!request.body[key];
      }
    }
    await pair.update(updates);
    await syncStreams();
    return pair;
  });

  // PUT /api/pairs/:id/status
  fastify.put('/api/pairs/:id/status', async (request, reply) => {
    const { id } = request.params;
    const { status } = request.body;
    const pair = await StatArbInput.findByPk(id);
    if (!pair) {
      return reply.status(404).send({ error: 'StatArbInput not found' });
    }
    await pair.update({ status });
    if (status === 'inactive') {
      clearLogs(id);
    }
    await syncStreams();
    return pair;
  });

  // DELETE /api/pairs/:id
  fastify.delete('/api/pairs/:id', async (request, reply) => {
    const { id } = request.params;
    const pair = await StatArbInput.findByPk(id);
    if (!pair) {
      return reply.status(404).send({ error: 'StatArbInput not found' });
    }
    orderbookManager.unsubscribe(id);
    clearLogs(id);
    await pair.destroy();
    await syncStreams();
    return { message: 'StatArbInput deleted' };
  });
}

module.exports = pairRoutes;
