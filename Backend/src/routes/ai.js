/**
 * AI Agent Routes
 *
 * GET  /api/ai/status              — check if AI agent is configured and ready
 * POST /api/ai/briefing            — generate a full trading briefing for a pair
 * POST /api/ai/validate-entry      — manually ask AI to validate a hypothetical entry
 * GET  /api/ai/analyze-position    — analyze current open position for a pair
 */

const aiAgent = require('../services/aiAgent');
const unilateralExecutor = require('../services/unilateralExecutor');
const Trade = require('../models/Trade');

async function buildLiveState(pairId) {
  const state = unilateralExecutor.pairs.get(parseInt(pairId));
  const ob = state?.lastOrderbooks;

  // Recent trades for risk calc
  let recentTradesForRisk = [];
  try {
    const trades = await Trade.findAll({
      where: { pairId, status: 'filled', side: 'exit' },
      order: [['createdAt', 'DESC']],
      limit: 20,
      attributes: ['pnl', 'legA_pnl', 'legB_pnl', 'createdAt'],
    });
    recentTradesForRisk = trades.map(t => ({ pnl: t.pnl }));
  } catch (_) {}

  // Market snapshot from last orderbook tick
  const priceA = parseFloat(ob?.leg1?.asks?.[0]?.price || ob?.leg1?.bids?.[0]?.price || 0);
  const priceB = parseFloat(ob?.leg2?.asks?.[0]?.price || ob?.leg2?.bids?.[0]?.price || 0);
  const qtyA = state?.pairConfig?.qty1 || 0;
  const qtyB = state?.pairConfig?.qty2 || 0;

  // Get spread stats from orderbookManager if available
  const orderbookManager = require('../services/orderbookStreams');
  const sellStream = orderbookManager.streams?.get?.(`${pairId}_leg1`) || null;
  const spreadStats = sellStream?.tracker?.history?.slice(-1)?.[0] || null;

  const spread = spreadStats?.spread ?? null;
  const mean = spreadStats?.mean ?? null;
  const std = spreadStats?.std ?? null;
  const zScore = spreadStats?.zScore ?? null;
  const deviationDollars = (spread != null && mean != null && priceA > 0)
    ? Math.abs(spread - mean) * priceA * qtyA
    : null;
  const roundTripCostDollars = priceA > 0 && priceB > 0
    ? (priceA * qtyA * 0.000029 * 2) + (priceB * qtyB * 0.000086 * 2) + (0.03 * qtyB * 2)
    : null;

  return {
    marketSnapshot: {
      spread,
      mean,
      std,
      zScore,
      deviationDollars: deviationDollars != null ? parseFloat(deviationDollars.toFixed(6)) : null,
      roundTripCostDollars: roundTripCostDollars != null ? parseFloat(roundTripCostDollars.toFixed(6)) : null,
      legA: ob?.leg1
        ? { bestBid: ob.leg1.bids?.[0]?.price, bestAsk: ob.leg1.asks?.[0]?.price, symbol: state?.pairConfig?.symbol1 }
        : null,
      legB: ob?.leg2
        ? { bestBid: ob.leg2.bids?.[0]?.price, bestAsk: ob.leg2.asks?.[0]?.price, symbol: state?.pairConfig?.symbol2 }
        : null,
    },
    position: {
      hasPosition: state?.state === 'POSITION_OPEN',
      direction: state?.direction,
      state: state?.state,
      entrySpread: state?.entrySpread,
      entryMean: state?.entryMean,
      entryPriceA: state?.entryPriceA,
      entryPriceB: state?.entryPriceB,
      entryTime: state?.entryTime,
      estimatedPnL: null, // will be computed by AI tool if needed
    },
    risk: {
      dailyLoss: state?.dailyLoss || 0,
      lastTradeTime: state?.lastTradeTime,
    },
    recentTradesForRisk,
  };
}

async function aiRoutes(fastify, options) {
  // ── Status ──────────────────────────────────────────────────────────────────
  fastify.get('/api/ai/status', async (request, reply) => {
    const configured = aiAgent.isConfigured();
    return {
      configured,
      model: 'claude-opus-4-6',
      features: ['entry-validation', 'position-analysis', 'daily-briefing', 'background-monitor'],
      status: configured ? 'ready' : 'unconfigured — set ANTHROPIC_API_KEY in .env',
    };
  });

  // ── Daily Briefing ───────────────────────────────────────────────────────────
  fastify.post('/api/ai/briefing', async (request, reply) => {
    const { pairId } = request.body || {};
    if (!pairId) return reply.status(400).send({ error: 'pairId required' });

    if (!aiAgent.isConfigured()) {
      return reply.status(503).send({ error: 'AI agent not configured — check ANTHROPIC_API_KEY' });
    }

    try {
      const liveState = await buildLiveState(pairId);
      const briefing = await aiAgent.getDailyBriefing(parseInt(pairId), liveState);
      return { pairId, generatedAt: new Date().toISOString(), briefing };
    } catch (err) {
      reply.status(500).send({ error: err.message });
    }
  });

  // ── Manual Entry Validation ──────────────────────────────────────────────────
  fastify.post('/api/ai/validate-entry', async (request, reply) => {
    const { pairId, direction } = request.body || {};
    if (!pairId) return reply.status(400).send({ error: 'pairId required' });

    if (!aiAgent.isConfigured()) {
      return reply.status(503).send({ error: 'AI agent not configured' });
    }

    try {
      const liveState = await buildLiveState(pairId);
      liveState.entryDirection = direction || 'unknown';
      const result = await aiAgent.validateEntry(parseInt(pairId), liveState);
      return { pairId, direction, result, queriedAt: new Date().toISOString() };
    } catch (err) {
      reply.status(500).send({ error: err.message });
    }
  });

  // ── AI Trade Insights ───────────────────────────────────────────────────────
  fastify.get('/api/ai/insights', async (request, reply) => {
    const { pairId, limit } = request.query;
    if (!pairId) return reply.status(400).send({ error: 'pairId required' });
    const insights = await aiAgent.getInsights(parseInt(pairId), parseInt(limit) || 50);
    return { pairId, count: insights.length, insights };
  });

  // ── AI Aggregated Recommendations ──────────────────────────────────────────
  fastify.get('/api/ai/recommendations', async (request, reply) => {
    const { pairId } = request.query;
    if (!pairId) return reply.status(400).send({ error: 'pairId required' });
    const recommendations = await aiAgent.getAggregatedRecommendations(parseInt(pairId));
    return { pairId, recommendations };
  });

  // ── Position Analysis ────────────────────────────────────────────────────────
  fastify.get('/api/ai/analyze-position', async (request, reply) => {
    const { pairId } = request.query;
    if (!pairId) return reply.status(400).send({ error: 'pairId required' });

    if (!aiAgent.isConfigured()) {
      return reply.status(503).send({ error: 'AI agent not configured' });
    }

    try {
      const liveState = await buildLiveState(pairId);
      if (!liveState.position.hasPosition) {
        return { pairId, hasPosition: false, message: 'No open position for this pair' };
      }
      const result = await aiAgent.analyzePosition(parseInt(pairId), liveState);
      return { pairId, result, queriedAt: new Date().toISOString() };
    } catch (err) {
      reply.status(500).send({ error: err.message });
    }
  });
}

module.exports = aiRoutes;
