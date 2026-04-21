const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SpreadLog = sequelize.define('SpreadLog', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  pairId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  spread: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  mean: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  std: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  zScore: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  upperBand: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
  lowerBand: {
    type: DataTypes.DOUBLE,
    allowNull: false,
  },
}, {
  tableName: 'spread_logs',
  timestamps: true,
  indexes: [
    { fields: ['pairId'] },
    { fields: ['createdAt'] },
  ],
});

module.exports = SpreadLog;
