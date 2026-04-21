// models/AccountDetails.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AccountDetails = sequelize.define(
  'AccountDetails',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },

    Email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      validate: {
        isEmail: true,
      },
    },

    Trade_Account: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'Trade_Account', // maps to DB column name
    },

    Api_Key: {
      type: DataTypes.TEXT, // better for long keys
      allowNull: true,
      field: 'Api_Key',
    },

    Secret_Key: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'Secret_Key',
    },

    Exchange: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },

    Status: {
      type: DataTypes.ENUM('Active', 'Inactive', 'Suspended'),
      defaultValue: 'Active',
      allowNull: false,
    },

    Account_Type: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'Account_Type',
    },

    vaultAddress: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    passphrase: {
      type: DataTypes.STRING,
      defaultValue: null
    },
    seed: {
      type: DataTypes.STRING,
      defaultValue: null
    },
  },
  {
    tableName: 'AccountDetails',
    timestamps: true,        // adds createdAt & updatedAt
    paranoid: false,         // set true if you want soft deletes
    // indexes: [
    //   { fields: ['Email'] },
    //   { fields: ['Trade_Account'], unique: true },
    //   { fields: ['Status'] },
    // ],
  }
);


module.exports = AccountDetails;