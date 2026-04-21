const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * BotSessionLog — one row per enable/disable cycle.
 *
 * enabledAt  → set when tradingEnabled turns on
 * disabledAt → set when tradingEnabled turns off (null = currently running)
 * uptimeMs   → disabledAt - enabledAt in milliseconds
 * stopReason → 'manual' | 'daily_loss_limit' | 'daily_profit_limit' |
 *              'qty_imbalance' | 'leg_qty_limit' | 'error' | 'crash'
 */
const BotSessionLog = sequelize.define('BotSessionLog', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  pairId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  enabledAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  disabledAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  uptimeMs: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'disabledAt - enabledAt in milliseconds',
  },
  downtimeMs: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Gap between this session enabledAt and previous session disabledAt',
  },
  stopReason: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'manual | daily_loss_limit | daily_profit_limit | qty_imbalance | leg_qty_limit | error | crash',
  },
  startBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  endBalance: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
  sessionPnl: {
    type: DataTypes.DOUBLE,
    allowNull: true,
  },
}, {
  tableName: 'bot_session_logs',
  timestamps: true,
  indexes: [
    { fields: ['pairId'] },
    { fields: ['enabledAt'] },
  ],
});

module.exports = BotSessionLog;
