const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * BasisPosition — single source of truth for every Deribit basis leg-pair.
 *
 * Each row represents one open or closed basis position (one grid level fill).
 * The table is the reconciliation anchor: on restart the executor queries
 * state IN ('pending_entry','open','pending_exit') and restores in-memory state
 * from here rather than from naive entry-count vs exit-count arithmetic.
 *
 * Lifecycle:
 *   pending_entry  → created when legA limit order is placed
 *   open           → both entry legs confirmed filled
 *   pending_exit   → exit legA limit placed, awaiting fills
 *   closed         → both exit legs filled, P&L recorded
 *   failed         → unrecoverable state (orphaned leg, exchange error)
 */
const BasisPosition = sequelize.define('BasisPosition', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  pairId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'FK → statarb_inputs.id',
  },
  entryTradeId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'FK → trade_logs.id for the entry record',
  },
  exitTradeId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'FK → trade_logs.id for the exit record',
  },
  direction: {
    type: DataTypes.ENUM('long', 'short'),
    allowNull: false,
    comment: 'long = sell futures + buy perp (SHORT BASIS)',
  },
  gridLevel: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Grid level index (0 = lowest rate threshold)',
  },
  state: {
    type: DataTypes.ENUM('pending_entry', 'open', 'pending_exit', 'closed', 'failed'),
    defaultValue: 'pending_entry',
    allowNull: false,
  },

  // ── Entry ─────────────────────────────────────────────────────────────────
  entrySpread: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Implied carry rate % p.a. at the moment of entry',
  },
  entryZScore: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  legA_entryPrice: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Futures fill price',
  },
  legB_entryPrice: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Perp fill price',
  },
  legA_entryQty: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'USD notional filled on futures leg',
  },
  legB_entryQty: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'USD notional filled on perp leg',
  },
  legA_entryOrderId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  legB_entryOrderId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  entryTime: {
    type: DataTypes.DATE,
    allowNull: true,
  },

  // ── TP / SL deltas frozen at entry (survive restarts + adaptive recalcs) ──
  tpDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'tpSpreadDelta snapshot at entry — profit exit threshold',
  },
  slDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'slSpreadDelta snapshot at entry — stop-loss exit threshold',
  },

  // ── Exit ──────────────────────────────────────────────────────────────────
  exitSpread: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Implied carry rate % p.a. at the moment of exit',
  },
  exitReason: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'profit | stop | timeout | manual',
  },
  legA_exitPrice: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  legB_exitPrice: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  legA_exitOrderId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  legB_exitOrderId: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  exitTime: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  holdMs: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Hold duration in milliseconds (exitTime - entryTime)',
  },

  // ── Spread deviation ──────────────────────────────────────────────────────
  spreadChange: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'exitSpread - entrySpread. Negative = spread narrowed = profit for SHORT basis',
  },

  // ── P&L ───────────────────────────────────────────────────────────────────
  legA_pnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  legB_pnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  grossPnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  commission: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Total maker rebate earned across entry+exit (positive = income)',
  },
  takerFeeUsd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Total taker fee paid across entry+exit (positive = cost)',
  },
  netPnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },

  // ── Reconciliation ────────────────────────────────────────────────────────
  reconciledAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Timestamp of last reconciliation check against exchange',
  },
  reconcileNote: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Any discrepancy or mismatch detected during reconciliation',
  },
}, {
  tableName: 'basis_positions',
  timestamps: true,
  indexes: [
    { fields: ['pairId'] },
    { fields: ['state'] },
    { fields: ['entryTradeId'] },
    { fields: ['exitTradeId'] },
  ],
});

module.exports = BasisPosition;
