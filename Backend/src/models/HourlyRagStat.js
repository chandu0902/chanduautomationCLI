const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HourlyRagStat = sequelize.define('HourlyRagStat', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  pairId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  hourUtc: {
    type: DataTypes.DATE,
    allowNull: false,
    comment: 'Start of the UTC hour bucket (e.g. 2026-04-09 12:00:00)',
  },
  totalTrades: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  entries: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  exits: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  wins: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  losses: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  pnl: {
    type: DataTypes.DOUBLE,
    defaultValue: 0,
    comment: 'Net PnL in USD from filled exits this hour',
  },
  commission: {
    type: DataTypes.DOUBLE,
    defaultValue: 0,
  },
  volumeSol: {
    type: DataTypes.DOUBLE,
    defaultValue: 0,
    comment: 'Total traded quantity (native units)',
  },
  volumeUsd: {
    type: DataTypes.DOUBLE,
    defaultValue: 0,
    comment: 'Total traded notional in USD',
  },
  rag: {
    type: DataTypes.ENUM('GREEN', 'AMBER', 'RED'),
    defaultValue: 'AMBER',
  },
  winRate: {
    type: DataTypes.DOUBLE,
    allowNull: true,
    comment: 'Win percentage 0-100',
  },
}, {
  tableName: 'hourly_rag_stats',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['pairId', 'hourUtc'] },
    { fields: ['pairId'] },
    { fields: ['rag'] },
  ],
});

module.exports = HourlyRagStat;
