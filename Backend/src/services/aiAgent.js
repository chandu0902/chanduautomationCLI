/**
 * AI Agent Service — Claude Opus 4.6 (deep analysis) + Haiku 4.5 (real-time)
 *
 * Advisory layer on top of the trading engine. Provides signal validation,
 * position analysis, and risk assessment. All calls are non-blocking —
 * if the AI fails or times out, trading continues with rule-based logic.
 *
 * Architecture:
 *   tradeExecutor.js  →  aiAgent.validateEntry()    (before entering a trade)
 *   tradeExecutor.js  →  aiAgent.analyzePosition()  (while holding, periodically)
 *   routes/ai.js      →  aiAgent.getDailyBriefing() (on-demand REST endpoint)
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const Trade = require('../models/Trade');

// Lazy-initialize client so missing key doesn't crash the server
let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey === 'your_new_key_here') {
      throw new Error('ANTHROPIC_API_KEY is not set in .env');
    }
    _client = new Anthropic.default({ apiKey });
  }
  return _client;
}

// Maximum time to wait for AI response before falling back to rule-based logic
const ENTRY_VALIDATION_TIMEOUT_MS = 8000;
const POSITION_ANALYSIS_TIMEOUT_MS = 15000;
const BRIEFING_TIMEOUT_MS = 60000;

// How often to run background position analysis (ms)
const POSITION_ANALYSIS_INTERVAL_MS = 120000; // every 2 min while in position

// Rate limit: delay between consecutive Opus trade reviews to avoid overload
const REVIEW_QUEUE_DELAY_MS = 10000; // 10s between reviews
let _reviewQueue = Promise.resolve();

// ─── Tool Definitions ────────────────────────────────────────────────────────

const TRADING_TOOLS = [
  {
    name: 'get_market_snapshot',
    description:
      'Get the current spread statistics and top-of-book prices for both legs of the pair. Returns spread value, rolling mean, standard deviation, dollar deviation from mean, and best bid/ask for each leg.',
    input_schema: {
      type: 'object',
      properties: {
        pairId: { type: 'number', description: 'The pair ID to query' },
      },
      required: ['pairId'],
    },
  },
  {
    name: 'get_active_position',
    description:
      'Get the current open position for a pair, if any. Returns direction, entry prices, hold duration, and estimated current PnL.',
    input_schema: {
      type: 'object',
      properties: {
        pairId: { type: 'number', description: 'The pair ID to query' },
      },
      required: ['pairId'],
    },
  },
  {
    name: 'get_recent_trades',
    description:
      'Get the last N completed roundtrip trades for a pair with their PnL, duration, and spread captured.',
    input_schema: {
      type: 'object',
      properties: {
        pairId: { type: 'number', description: 'The pair ID to query' },
        limit: {
          type: 'number',
          description: 'Number of recent trades to return (default 10, max 50)',
        },
      },
      required: ['pairId'],
    },
  },
  {
    name: 'get_risk_metrics',
    description:
      'Get current risk metrics: daily loss, win rate, consecutive losses, max drawdown, and whether daily loss limit is approaching.',
    input_schema: {
      type: 'object',
      properties: {
        pairId: { type: 'number', description: 'The pair ID to query' },
      },
      required: ['pairId'],
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

async function executeTool(toolName, input, liveState) {
  const { pairId } = input;

  switch (toolName) {
    case 'get_market_snapshot': {
      const snap = liveState?.marketSnapshot || {};
      return {
        pairId,
        spread: snap.spread ?? null,
        mean: snap.mean ?? null,
        std: snap.std ?? null,
        zScore: snap.zScore ?? null,
        deviationDollars: snap.deviationDollars ?? null,
        roundTripCostDollars: snap.roundTripCostDollars ?? null,
        deviationVsCostRatio: snap.deviationDollars && snap.roundTripCostDollars
          ? parseFloat((snap.deviationDollars / snap.roundTripCostDollars).toFixed(3))
          : null,
        legA: snap.legA ?? null,
        legB: snap.legB ?? null,
        timestamp: new Date().toISOString(),
      };
    }

    case 'get_active_position': {
      const pos = liveState?.position || {};
      return {
        pairId,
        hasPosition: pos.hasPosition ?? false,
        direction: pos.direction ?? null,
        state: pos.state ?? 'IDLE',
        entrySpread: pos.entrySpread ?? null,
        entryMean: pos.entryMean ?? null,
        entryPriceA: pos.entryPriceA ?? null,
        entryPriceB: pos.entryPriceB ?? null,
        holdDurationSeconds: pos.entryTime
          ? Math.floor((Date.now() - pos.entryTime) / 1000)
          : null,
        estimatedPnL: pos.estimatedPnL ?? null,
      };
    }

    case 'get_recent_trades': {
      const limit = Math.min(input.limit || 10, 50);
      try {
        const trades = await Trade.findAll({
          where: { pairId, status: 'filled', side: 'exit' },
          order: [['createdAt', 'DESC']],
          limit,
          attributes: ['pnl', 'legA_pnl', 'legB_pnl', 'spreadAtEntry', 'zScoreAtEntry', 'legA_price', 'legB_price', 'createdAt'],
        });
        return {
          pairId,
          count: trades.length,
          trades: trades.map(t => ({
            pnl: t.pnl,
            legA_pnl: t.legA_pnl,
            legB_pnl: t.legB_pnl,
            spreadAtEntry: t.spreadAtEntry,
            zScoreAtEntry: t.zScoreAtEntry,
            exitedAt: t.createdAt,
          })),
          summary: {
            totalPnl: trades.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(6),
            wins: trades.filter(t => (t.pnl || 0) > 0).length,
            losses: trades.filter(t => (t.pnl || 0) < 0).length,
            avgPnl: trades.length > 0
              ? (trades.reduce((s, t) => s + (t.pnl || 0), 0) / trades.length).toFixed(6)
              : 0,
          },
        };
      } catch (err) {
        return { pairId, error: err.message, trades: [] };
      }
    }

    case 'get_risk_metrics': {
      const risk = liveState?.risk || {};
      const recentTrades = liveState?.recentTradesForRisk || [];
      const wins = recentTrades.filter(t => (t.pnl || 0) > 0).length;
      const losses = recentTrades.filter(t => (t.pnl || 0) < 0).length;
      const totalPnl = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);

      let consecutiveLosses = 0;
      for (const t of recentTrades) {
        if ((t.pnl || 0) < 0) consecutiveLosses++;
        else break;
      }

      return {
        pairId,
        dailyLoss: risk.dailyLoss ?? 0,
        dailyLossLimit: 0.05,
        dailyLossRemaining: parseFloat((0.05 - (risk.dailyLoss || 0)).toFixed(4)),
        dailyLossUtilizationPct: parseFloat(((risk.dailyLoss || 0) / 0.05 * 100).toFixed(1)),
        recentWins: wins,
        recentLosses: losses,
        recentWinRate: (wins + losses) > 0
          ? parseFloat((wins / (wins + losses) * 100).toFixed(1))
          : null,
        recentTotalPnl: parseFloat(totalPnl.toFixed(6)),
        consecutiveLosses,
        cooldownActive: risk.lastTradeTime
          ? (Date.now() - risk.lastTradeTime) < 3000
          : false,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ─── JSON Extractor ───────────────────────────────────────────────────────────
// Opus often adds preamble ("Now let me...") before the JSON even when told not to.
// Find the first { and last } to extract just the JSON object.
function extractJSON(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in response');
  return raw.slice(start, end + 1);
}

// ─── Core AI Call (with tool use loop) ───────────────────────────────────────

/**
 * Run an AI agent session with tool use.
 * @param {string} model  — 'haiku' for real-time decisions, 'opus' for deep analysis
 */
async function runAgentSession(systemPrompt, userMessage, liveState, timeoutMs, model = 'haiku') {
  const client = getClient();
  const messages = [{ role: 'user', content: userMessage }];

  // Haiku 4.5: fast (<3s), cheap ($0.003/call) — for real-time entry/position decisions
  // Opus 4.6: slow (20-60s), expensive — for post-trade review and daily briefing only
  const modelId = model === 'opus'
    ? 'claude-opus-4-6'
    : 'claude-haiku-4-5-20251001';
  const maxTokens = model === 'opus' ? 2048 : 512;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('AI agent timeout')), timeoutMs)
  );

  const agentPromise = (async () => {
    let response = await client.messages.create({
      model: modelId,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: TRADING_TOOLS,
      messages,
    });

    // Agentic tool loop
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(await executeTool(block.name, block.input, liveState)),
        }))
      );

      messages.push({ role: 'user', content: toolResults });

      response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: TRADING_TOOLS,
        messages,
      });
    }

    // Extract text from final response
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text : null;
  })();

  return Promise.race([agentPromise, timeoutPromise]);
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const ENTRY_SYSTEM_PROMPT = `You are an expert quantitative trading risk manager for a statistical arbitrage bot trading BRENTOIL vs CL perpetual futures on Hyperliquid DEX.

Strategy context:
- Log-ratio spread: ln(BRENTOIL) - 1.25 × ln(CL), rolling mean window 30 ticks
- Leg A = BRENTOIL (limit/maker, 0.003% fee), Leg B = CL (limit→market fallback, 0.003% maker)
- SHORT spread (spread above mean) = sell BRENTOIL, buy CL — SHORT-only filter active
- Entry: |spread - mean| >= 2× feeCost (in spread units), capped at 4× feeCost max
- Exit: spread reverts 3× feeCost from entry; Stop: 5× feeCost adverse; Max hold: 120s
- Daily loss limit: $0.05 circuit breaker

Your role:
1. Use the available tools to gather current market data and risk metrics
2. Assess whether entering this trade is wise given current conditions
3. Respond with ONLY valid JSON (no text before or after):
{"recommendation":"enter"|"skip","confidence":0.0-1.0,"reasoning":"1-2 sentence explanation","risk_level":"low"|"medium"|"high","key_concerns":["concern1"]}

Be conservative — when in doubt, recommend "skip". Protect capital first.`;

const POSITION_SYSTEM_PROMPT = `You are monitoring an open statistical arbitrage position (BRENTOIL vs CL on Hyperliquid DEX).

Strategy: Log-ratio spread mean-reversion. SHORT-only. Profit target 3× feeCost reversion, stop 5× feeCost adverse, max hold 120s.

Your role:
1. Use available tools to assess the current position health
2. Decide whether to hold or exit early
3. Respond with ONLY valid JSON (no text before or after):
{"recommendation":"hold"|"exit"|"emergency_exit","confidence":0.0-1.0,"reasoning":"1-2 sentence explanation","risk_level":"low"|"medium"|"high","estimated_outcome":"profit"|"breakeven"|"loss"}

Recommend "emergency_exit" only if you see signs of a regime change or runaway loss.`;

const BRIEFING_SYSTEM_PROMPT = `You are a quantitative trading analyst reviewing a statistical arbitrage bot's performance.

Strategy: BRENTOIL vs CL log-ratio spread mean-reversion on Hyperliquid DEX.
- spread = ln(BRENT) - 1.25 × ln(CL), rolling mean window = 30 ticks
- Leg A = BRENTOIL (limit/maker, 0.003% fee), Leg B = CL (limit→market fallback)
- SHORT-only direction filter active
- Entry: |spread - mean| >= 2× feeCost, max 4× feeCost
- Exit: spread reverts 3× feeCost from entry; Stop: 5× feeCost; Max hold: 120s
- Daily loss limit: $0.05

Use the available tools to gather comprehensive data, then provide a detailed briefing.
Respond with ONLY valid JSON (no text before or after):
{"overall_health":"good"|"caution"|"poor","performance_summary":"2-3 sentence analysis","risk_assessment":"current risk level and key concerns","market_conditions":"spread behavior and mean-reversion quality","recommendations":["rec1","rec2","rec3"],"suggested_config_changes":{"description":"any parameter changes worth considering","changes":{}},"confidence":0.0-1.0}`;

const TRADE_REVIEW_SYSTEM_PROMPT = `You are a quantitative trading researcher analyzing completed trades from a statistical arbitrage bot.

Strategy:
- Pair: BRENTOIL (Leg A, maker/limit) vs CL (Leg B, limit→market fallback) on Hyperliquid xyz DEX
- spread = ln(BRENT) - 1.25 × ln(CL)
- SHORT-only: entry when spread above mean >= 2× feeCost, cap at 4× feeCost
- Exit: spread reverts 3× feeCost; Stop: 5× feeCost; Max hold: 120s
- Fees: MAKER_FEE = 0.0029%, TAKER_FEE = 0.0086%

Your role: Analyze the completed trade and provide actionable insights for improving the strategy.

Respond with ONLY valid JSON (no text before or after, no markdown fences):
{"trade_assessment":"win_quality"|"acceptable_loss"|"preventable_loss"|"lucky_win","entry_quality":1-10,"exit_quality":1-10,"slippage_analysis":"description","what_went_right":["point1"],"what_went_wrong":["point1"],"pattern_detected":"any pattern","strategy_recommendations":[{"parameter":"name","current_value":"current","suggested_value":"suggested","reasoning":"why"}],"confidence":0.0-1.0}`;

// ─── Public API ───────────────────────────────────────────────────────────────

async function validateEntry(pairId, liveState) {
  try {
    const userMessage = `Pair ${pairId} has generated an entry signal. Direction: ${liveState.entryDirection?.toUpperCase() || 'UNKNOWN'}. Dollar deviation from mean: $${liveState.marketSnapshot?.deviationDollars?.toFixed(4) || 'N/A'}. Should I enter this trade? Use the tools to gather context first.`;

    const rawResponse = await runAgentSession(
      ENTRY_SYSTEM_PROMPT,
      userMessage,
      liveState,
      ENTRY_VALIDATION_TIMEOUT_MS,
      'haiku'
    );

    if (!rawResponse) return null;

    const result = JSON.parse(extractJSON(rawResponse));
    console.log(`[AI Agent] Entry validation pair ${pairId}: ${result.recommendation} (confidence=${result.confidence}) — ${result.reasoning}`);
    return result;
  } catch (err) {
    console.warn(`[AI Agent] Entry validation failed for pair ${pairId}: ${err.message} — falling back to rule-based logic`);
    return null;
  }
}

async function analyzePosition(pairId, liveState) {
  try {
    const pos = liveState.position || {};
    const userMessage = `Pair ${pairId} has an open ${pos.direction?.toUpperCase() || '?'} spread position. Hold time: ${pos.entryTime ? Math.floor((Date.now() - pos.entryTime) / 1000) : '?'}s. Estimated PnL: $${pos.estimatedPnL?.toFixed(4) ?? 'N/A'}. Should I hold or exit? Use the tools to gather full context.`;

    const rawResponse = await runAgentSession(
      POSITION_SYSTEM_PROMPT,
      userMessage,
      liveState,
      POSITION_ANALYSIS_TIMEOUT_MS,
      'haiku'
    );

    if (!rawResponse) return null;

    const result = JSON.parse(extractJSON(rawResponse));
    console.log(`[AI Agent] Position analysis pair ${pairId}: ${result.recommendation} (confidence=${result.confidence}) — ${result.reasoning}`);
    return result;
  } catch (err) {
    console.warn(`[AI Agent] Position analysis failed for pair ${pairId}: ${err.message}`);
    return null;
  }
}

async function getDailyBriefing(pairId, liveState) {
  const userMessage = `Generate a comprehensive performance and risk briefing for pair ${pairId}. Use all available tools to gather data before responding.`;

  const rawResponse = await runAgentSession(
    BRIEFING_SYSTEM_PROMPT,
    userMessage,
    liveState,
    BRIEFING_TIMEOUT_MS,
    'opus'
  );

  if (!rawResponse) throw new Error('AI agent returned no response');
  return JSON.parse(extractJSON(rawResponse));
}

// ─── Background Position Monitor (DISABLED — 2min interval vs 2min max hold = never fires) ─

function startPositionMonitor(_pairId, _getLiveState, _exitFn) {
  // No-op: position monitor disabled to save API cost.
  // Max hold time is 120s and monitor interval was 120s, so it never
  // triggered in time. All exit logic handled by rule-based spread reversion.
}

function stopPositionMonitor(_pairId) {
  // No-op
}

// ─── Background Trade Review (rate-limited queue) ─────────────────────────────

const fs = require('fs');
const path = require('path');
const AI_INSIGHTS_DIR = path.join(__dirname, '..', '..', 'logs', 'ai-insights');
fs.mkdirSync(AI_INSIGHTS_DIR, { recursive: true });

async function reviewCompletedTrade(pairId, tradeData, liveState) {
  if (!isConfigured()) return;

  // Enqueue reviews — process one at a time with delay to avoid API overload
  _reviewQueue = _reviewQueue.then(() => new Promise(resolve => {
    setImmediate(async () => {
      try {
        const userMessage = `Review this completed trade for pair ${pairId}:

Trade ID: #${tradeData.tradeId}
Direction: ${tradeData.direction?.toUpperCase()}
Entry: Leg A (BRENT) @ $${tradeData.entryPriceA}, Leg B (CL) @ $${tradeData.entryPriceB}
Exit: Leg A (BRENT) @ $${tradeData.exitPriceA}, Leg B (CL) @ $${tradeData.exitPriceB}
Hold time: ${(tradeData.holdMs / 1000).toFixed(0)}s
Leg A PnL: $${tradeData.legA_pnl?.toFixed(4)} (BRENT — limit/maker)
Leg B PnL: $${tradeData.legB_pnl?.toFixed(4)} (CL — limit→market)
Total PnL: $${tradeData.pnl?.toFixed(4)} — ${tradeData.pnl >= 0 ? 'WIN' : 'LOSS'}
Entry spread: ${tradeData.entrySpread?.toFixed(6)}
Exit spread: ${tradeData.exitSpread?.toFixed(6)}

Use the tools to get recent trade history and risk metrics for broader context. Then analyze this trade.`;

        const rawResponse = await runAgentSession(
          TRADE_REVIEW_SYSTEM_PROMPT,
          userMessage,
          liveState,
          30000,
          'haiku'
        );

        if (!rawResponse) { resolve(); return; }

        const review = JSON.parse(extractJSON(rawResponse));

        console.log(`[AI Review] Trade #${tradeData.tradeId} (${tradeData.pnl >= 0 ? 'WIN' : 'LOSS'} $${tradeData.pnl?.toFixed(4)}) | assessment=${review.trade_assessment} | entry=${review.entry_quality}/10 exit=${review.exit_quality}/10`);
        if (review.strategy_recommendations?.length > 0) {
          for (const rec of review.strategy_recommendations) {
            console.log(`[AI Review]   → ${rec.parameter}: ${rec.current_value} → ${rec.suggested_value} (${rec.reasoning})`);
          }
        }

        const logEntry = {
          timestamp: new Date().toISOString(),
          pairId,
          tradeId: tradeData.tradeId,
          pnl: tradeData.pnl,
          direction: tradeData.direction,
          holdMs: tradeData.holdMs,
          review,
        };
        const logPath = path.join(AI_INSIGHTS_DIR, `pair_${pairId}_reviews.jsonl`);
        fs.appendFile(logPath, JSON.stringify(logEntry) + '\n', (err) => {
          if (err) console.error(`[AI Review] Failed to write insight log: ${err.message}`);
        });

      } catch (err) {
        console.warn(`[AI Review] Background review failed for trade #${tradeData.tradeId}: ${err.message}`);
      }

      // Rate limit: wait before processing next review
      setTimeout(resolve, REVIEW_QUEUE_DELAY_MS);
    });
  }));
}

async function getInsights(pairId, limit = 50) {
  const logPath = path.join(AI_INSIGHTS_DIR, `pair_${pairId}_reviews.jsonl`);
  if (!fs.existsSync(logPath)) return [];

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(l => l.trim());
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

async function getAggregatedRecommendations(pairId) {
  const insights = await getInsights(pairId, 100);
  const paramCounts = {};

  for (const entry of insights) {
    const recs = entry.review?.strategy_recommendations || [];
    for (const rec of recs) {
      if (!paramCounts[rec.parameter]) paramCounts[rec.parameter] = {};
      const key = String(rec.suggested_value);
      if (!paramCounts[rec.parameter][key]) paramCounts[rec.parameter][key] = { count: 0, reasonings: [] };
      paramCounts[rec.parameter][key].count++;
      if (rec.reasoning) paramCounts[rec.parameter][key].reasonings.push(rec.reasoning);
    }
  }

  const recommendations = [];
  for (const [param, values] of Object.entries(paramCounts)) {
    const best = Object.entries(values).sort((a, b) => b[1].count - a[1].count)[0];
    recommendations.push({
      parameter: param,
      suggested_value: best[0],
      times_recommended: best[1].count,
      out_of_trades: insights.length,
      sample_reasonings: best[1].reasonings.slice(0, 3),
    });
  }

  return recommendations.sort((a, b) => b.times_recommended - a.times_recommended);
}

// ─── Health Check ─────────────────────────────────────────────────────────────

function isConfigured() {
  const key = process.env.ANTHROPIC_API_KEY;
  return !!(key && key !== 'your_new_key_here' && key.startsWith('sk-ant-'));
}

module.exports = {
  validateEntry,
  analyzePosition,
  getDailyBriefing,
  reviewCompletedTrade,
  getInsights,
  getAggregatedRecommendations,
  startPositionMonitor,
  stopPositionMonitor,
  isConfigured,
};
