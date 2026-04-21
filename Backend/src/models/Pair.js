const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StatArbInput = sequelize.define('StatArbInput', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  exchange1: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type1: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  symbol1: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  exchange2: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type2: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  symbol2: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  agentName: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  tradeAccountA: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  qty1: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  tradeAccountB: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  qty2: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  maxQty1: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  beta: {
    type: DataTypes.DOUBLE,
    defaultValue: null,
    allowNull: true,
  },
  dailyLossLimitPct: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  dailyLossLimitUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  dailyProfitLimitPct: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  zEntryThreshold: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  zEntryMax: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  maxPositions: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 1,
  },
  maxLegAQty: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  maxLegBQty: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  maxNetQtyImbalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  profitTarget: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  profitFeeMultiplier: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 10,
  },
  unilateralMode: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'If true: trade only one leg; other leg is spread signal only',
  },
  tradeLeg: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'A',
    comment: 'Which leg to trade in unilateral mode: A = symbol1 (default), B = symbol2',
  },
  tpSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Unilateral: exit TP when spread narrows this many $ vs fill spread',
  },
  slSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Unilateral: exit SL when spread widens this many $ vs fill spread',
  },
  stopLoss: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  maxHoldMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  spreadEntryLevels: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  maxSpreadCap: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
  },
  adaptLevels: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Enable hourly adaptive entry levels / TP / SL based on rolling spread mean+std',
  },
  adaptSigmaMin: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: 0.5,
    comment: 'Lowest entry level = dollarMean + adaptSigmaMin * dollarStd',
  },
  adaptSigmaMax: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: 2.0,
    comment: 'Highest entry level = dollarMean + adaptSigmaMax * dollarStd',
  },
  adaptTpSigma: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: 0.8,
    comment: 'TP delta = adaptTpSigma * dollarStd (spread narrowing target)',
  },
  adaptSlSigma: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: 1.5,
    comment: 'SL delta = adaptSlSigma * dollarStd (spread widening limit)',
  },
  entryPollTimeoutMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
  },
  // ── Pair-25 (ETH) profitability rewrite — all NULL by default.
  // When NULL, unilateralExecutor.js runs existing logic unchanged.
  // BTC pair 24 keeps these NULL and is therefore unaffected.
  fixedTpUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Fixed $ favorable price move that triggers TP regardless of spread. NULL = disabled (spread-only TP).',
  },
  maxSingleTradeLossUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Hard per-round-trip gross USD loss cap; triggers immediate stop-exit when exceeded. NULL = disabled.',
  },
  grossNegativeScratchMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'When exit re-quote would be gross-negative, wait this many ms then scratch at mid instead of abort+hold. NULL = existing abort+hold behaviour.',
  },
  entryRequoteOnMovePx: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'During entry poll, re-quote if signal book mid has drifted by at least this $ amount. NULL = time-only reprice.',
  },
  adaptMinTpSlRatio: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Adapter floor: tpSpreadDelta / slSpreadDelta. When set, newTp = max(newTp, ratio * newSl). NULL = no floor.',
  },
  trendPauseJumpPct: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'If adapt-cycle maxSpreadCap jumps by this fraction vs previous (e.g. 0.20 = 20%), pause new entries. NULL = never pause.',
  },
  trendPauseDurationMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'How long to pause new entries after a trend-jump trigger (ms). NULL = never pause.',
  },
  minEdgeUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Minimum expected gross USD (given current tpSpreadDelta and traded price) required to open a new position. Skip entry if projected gross < this. NULL = no edge filter.',
  },
  trendFilterPct: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Max traded-instrument price drift (%) over trendFilterWindowMs allowed before opening a new entry. If recent range exceeds this, the regime is treated as directional and entries are skipped. NULL = disabled.',
  },
  trendFilterWindowMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Rolling window (ms) used by trendFilterPct to compute recent price drift. NULL = 60000 default when trendFilterPct is set.',
  },
  adaptIntervalUsaMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Adapt cycle interval during USA market hours (ms). NULL = global default 900000 (15 min)',
  },
  adaptIntervalOffHoursMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Adapt cycle interval outside USA market hours (ms). NULL = global default 1800000 (30 min)',
  },
  executorVersion: {
    type: DataTypes.STRING(10),
    allowNull: true,
    defaultValue: null,
    comment: "null → V1 (unilateralExecutor). 'v2' → V2 (unilateralExecutorV2: regime filter, fee gate, dynamic TP).",
  },
  // ── Stop-exit reprice + streak cooldown + IST-hour gate (ETH opt-A) ───
  // All NULL on pairs that don't opt in; executor keeps legacy behaviour.
  stopRepriceIntervalMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Interval (ms) between stop-exit reprice attempts. NULL = legacy 5000ms.',
  },
  stopUseMarketOnBreach: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: null,
    comment: 'When stop reprice fails to fill after one interval, cross the book with IOC to guarantee exit. NULL/0 = passive reprice only.',
  },
  stopStreakN: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'Number of consecutive stop exits that triggers an entry cooldown. NULL/0 = disabled.',
  },
  stopStreakCooldownN: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: null,
    comment: 'After stopStreakN consecutive stops, skip this many new entries before resuming. NULL/0 = disabled.',
  },
  disableIstHours: {
    type: DataTypes.STRING(64),
    allowNull: true,
    defaultValue: null,
    comment: 'Comma-separated IST hours (0-23) during which new entries are blocked. NULL or empty = always allow.',
  },
  priceUpperLimit: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Kill switch: stop bot + close perps + close options when BTC price >= this level',
  },
  priceLowerLimit: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Kill switch: stop bot + close perps + close options when BTC price <= this level',
  },
  optionInstruments: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
    comment: 'JSON array of option instruments to close when price limits are hit, e.g. [{"name":"BTC-24APR26-73000-C","size":-6},...]',
  },
  optionProfitTargetUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Close all options + perps + stop bot when total net option PnL (after fees) >= this USD amount',
  },
  tradingEnabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // ── Per-session fields (reset on every enable) ──────────────────────
  sessionStartedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  sessionStoppedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  sessionStartBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Deribit full account equity (acct.equity) when this session started — updated on every enable/re-enable/boot',
  },
  sessionEndBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Account balance fetched from exchange when trading was disabled',
  },
  sessionPnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'sessionEndBalance - sessionStartBalance',
  },
  // ── Lifetime fields (set once on first ever enable, never overwritten) ──
  botStartBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Account balance on the very first enable — never overwritten',
  },
  botStartedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp of the very first enable',
  },
  botEndBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Account balance at the most recent disable — updated on every stop',
  },
  botPnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'botEndBalance - botStartBalance (lifetime P&L)',
  },
  peakEquity: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Peak bot equity (balance + futures uPnL) since botStartedAt — persists across restarts for USD drawdown',
  },
  totalUptimeMs: {
    type: DataTypes.BIGINT,
    allowNull: true,
    defaultValue: 0,
    comment: 'Cumulative milliseconds the bot has been running',
  },
  maxDrawdownUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Kill switch: disable trading + close all when equity drawdown from peak exceeds this USD amount',
  },
  drawdownPct: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    defaultValue: null,
    comment: 'Kill switch: if exchange balance drops by this % from start balance, disable + close all positions',
  },
  lastStopReason: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Reason for the most recent disable: manual | daily_loss_limit | daily_profit_limit | qty_imbalance | leg_qty_limit | drawdown_kill_switch | error | crash',
  },
  lastDisabledAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    defaultValue: 'active',
  },
}, {
  tableName: 'statarb_inputs',
  timestamps: true,
});

module.exports = StatArbInput;
