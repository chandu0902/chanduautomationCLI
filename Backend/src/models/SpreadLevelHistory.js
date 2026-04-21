const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpreadLevelHistory = sequelize.define('SpreadLevelHistory', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  pairId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'FK to StatArbInputs.id',
  },
  changedBy: {
    type: DataTypes.STRING(32),
    allowNull: false,
    comment: 'adapt | enable | api',
  },
  // ── New config (what is being applied) ──────────────────────────────────────
  levels: {
    type: DataTypes.JSON,
    allowNull: false,
    comment: 'Array of new entry level dollar thresholds',
  },
  tpSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  slSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  maxSpreadCap: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  // ── Previous config (what it was before) ────────────────────────────────────
  prevLevels: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Array of previous entry level dollar thresholds',
  },
  prevTpSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  prevSlSpreadDelta: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  prevMaxSpreadCap: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  // ── Market context at the time of change ────────────────────────────────────
  dollarMean: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Rolling dollar spread mean used for computation',
  },
  dollarStd: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Rolling dollar spread std used for computation',
  },
  openPositions: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Number of open positions at time of change',
  },
  tpSlUpdated: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'False if TP/SL were skipped because positions were open',
  },
}, {
  tableName: 'spread_level_history',
  timestamps: true,
  updatedAt: false,
  indexes: [
    { fields: ['pairId'] },
    { fields: ['changedBy'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = SpreadLevelHistory;
