/**
 * analyse_trades.js
 * Fetches DB trades + live exchange fills for both active bots,
 * cross-checks order IDs, and validates analytics calculations.
 *
 * Pairs:
 *   56 – BRENTCL (HyperLiquid xyz CL/BRENTOIL)
 *   55 – BTC basis (Deribit BTC-24APR26 vs BTC-PERPETUAL)
 */

require('dotenv').config();
const crypto  = require('crypto');
const axios   = require('axios');
const { Hyperliquid } = require('hyperliquid');
const { Sequelize, DataTypes } = require('sequelize');

// ─── DB ──────────────────────────────────────────────────────────────────────
const sequelize = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);

const Trade = sequelize.define('Trade', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  pairId: DataTypes.INTEGER,
  side: DataTypes.STRING,
  legA_exchange: DataTypes.STRING, legA_symbol: DataTypes.STRING, legA_side: DataTypes.STRING,
  legA_price: DataTypes.DOUBLE, legA_qty: DataTypes.DOUBLE, legA_orderId: DataTypes.STRING,
  legA_filledAt: DataTypes.DATE, legA_fillType: DataTypes.STRING,
  legA_pnl: DataTypes.DOUBLE, legA_buyVwap: DataTypes.DOUBLE, legA_sellVwap: DataTypes.DOUBLE,
  legB_exchange: DataTypes.STRING, legB_symbol: DataTypes.STRING, legB_side: DataTypes.STRING,
  legB_price: DataTypes.DOUBLE, legB_qty: DataTypes.DOUBLE, legB_orderId: DataTypes.STRING,
  legB_filledAt: DataTypes.DATE, legB_fillType: DataTypes.STRING,
  legB_pnl: DataTypes.DOUBLE,
  pnl: DataTypes.DOUBLE, status: DataTypes.STRING,
  commission: DataTypes.DOUBLE, exchangePnl: DataTypes.DOUBLE,
  balanceBefore: DataTypes.DOUBLE, balanceAfter: DataTypes.DOUBLE,
  zScoreAtEntry: DataTypes.DOUBLE, spreadAtEntry: DataTypes.DOUBLE,
}, { tableName: 'trade_logs', timestamps: true });

const AccountDetails = sequelize.define('AccountDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  Trade_Account: DataTypes.STRING, Exchange: DataTypes.STRING,
  Api_Key: DataTypes.TEXT, Secret_Key: DataTypes.TEXT,
  Status: DataTypes.STRING, vaultAddress: DataTypes.STRING,
  passphrase: DataTypes.STRING, seed: DataTypes.STRING,
}, { tableName: 'AccountDetails', timestamps: false });

// ─── DECRYPTION ───────────────────────────────────────────────────────────────
function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv  = Buffer.from(ivBase64,  'base64');
  const dc  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return dc.update(encryptedText, 'base64', 'utf8') + dc.final('utf8');
}

function getCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  let secret = null, vaultAddress = null;
  if (account.Secret_Key) {
    const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
    secret = decryptText(sk2, sk1, sk0);
  }
  if (account.vaultAddress) {
    const [va0, va1, va2] = account.vaultAddress.split(',', 3);
    vaultAddress = decryptText(va2, va1, va0);
  }
  return { apiKey, secret, vaultAddress };
}

// ─── DERIBIT AUTH ─────────────────────────────────────────────────────────────
async function getDeribitToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret, scope: 'trade:read_write' }
  });
  return r.data.result.access_token;
}

async function deribitGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.data.result;
}

// ─── ANALYTICS RECALCULATOR (mirrors routes/trades.js logic) ─────────────────
const DERIBIT_CONTRACT_USD = 10;
const FEE_RATES = {
  hyperliquid: { maker: 0.00015, taker: 0.00045 },
  deribit:     { maker: 0.000029, taker: 0.000086 },
};
function getFeeRate(exchange, fillType) {
  const ex = (exchange || '').toLowerCase();
  const r = FEE_RATES[ex] || { maker: 0.0002, taker: 0.0005 };
  return fillType === 'taker' ? r.taker : r.maker;
}
function notionalUsd(exchange, price, qty) {
  return (exchange || '').toLowerCase() === 'deribit'
    ? qty * DERIBIT_CONTRACT_USD
    : price * qty;
}

function recalcAnalytics(trades) {
  const filled = trades.filter(t => t.status === 'filled');
  let entryCount = 0, exitCount = 0;
  for (const t of filled) {
    if (t.side === 'entry') entryCount++;
    else if (t.side === 'exit') exitCount++;
  }

  let totalFeesLegA = 0, totalFeesLegB = 0;
  const symbols = {};
  const ensure = (sym, feeRate) => {
    if (!symbols[sym]) symbols[sym] = { buys: 0, sells: 0, buyVolume: 0, sellVolume: 0, buyVwaps: [], sellVwaps: [], pnl: 0, fees: 0, feeRate };
    return symbols[sym];
  };

  for (const t of filled) {
    const hasComm = t.commission != null;
    if (hasComm) totalFeesLegA += t.commission;
    else if (t.legA_price != null && t.legA_qty != null && t.legA_filledAt)
      totalFeesLegA += notionalUsd(t.legA_exchange, t.legA_price, t.legA_qty) * getFeeRate(t.legA_exchange, t.legA_fillType);
    if (t.legB_symbol && t.legB_price != null && t.legB_qty != null && t.legB_filledAt)
      totalFeesLegB += notionalUsd(t.legB_exchange, t.legB_price, t.legB_qty) * getFeeRate(t.legB_exchange, t.legB_fillType);

    if (t.legA_symbol && t.legA_filledAt) {
      const s = ensure(t.legA_symbol, getFeeRate(t.legA_exchange, t.legA_fillType));
      if (t.legA_side === 'buy') {
        s.buys++;
        if (t.legA_price != null && t.legA_qty != null) { s.buyVolume += notionalUsd(t.legA_exchange, t.legA_price, t.legA_qty); }
      } else if (t.legA_side === 'sell') {
        s.sells++;
        if (t.legA_price != null && t.legA_qty != null) { s.sellVolume += notionalUsd(t.legA_exchange, t.legA_price, t.legA_qty); }
      }
      if (hasComm) s.fees += t.commission;
      else if (t.legA_price != null && t.legA_qty != null) s.fees += notionalUsd(t.legA_exchange, t.legA_price, t.legA_qty) * getFeeRate(t.legA_exchange, t.legA_fillType);
      if (t.legA_side === 'buy'  && t.legA_buyVwap  != null) s.buyVwaps.push(t.legA_buyVwap);
      if (t.legA_side === 'sell' && t.legA_sellVwap != null) s.sellVwaps.push(t.legA_sellVwap);
      if (t.legA_pnl != null) s.pnl += t.legA_pnl;
    }
    if (t.legB_symbol && t.legB_filledAt) {
      const s = ensure(t.legB_symbol, getFeeRate(t.legB_exchange, t.legB_fillType));
      if (t.legB_side === 'buy') {
        s.buys++;
        if (t.legB_price != null && t.legB_qty != null) { s.buyVolume += notionalUsd(t.legB_exchange, t.legB_price, t.legB_qty); }
      } else if (t.legB_side === 'sell') {
        s.sells++;
        if (t.legB_price != null && t.legB_qty != null) { s.sellVolume += notionalUsd(t.legB_exchange, t.legB_price, t.legB_qty); }
      }
      if (t.legB_price != null && t.legB_qty != null) s.fees += notionalUsd(t.legB_exchange, t.legB_price, t.legB_qty) * getFeeRate(t.legB_exchange, t.legB_fillType);
      if (t.legB_side === 'buy'  && t.legB_buyVwap  != null) s.buyVwaps.push(t.legB_buyVwap);
      if (t.legB_side === 'sell' && t.legB_sellVwap != null) s.sellVwaps.push(t.legB_sellVwap);
      if (t.legB_pnl != null) s.pnl += t.legB_pnl;
    }
  }

  let totalVolume = 0, totalPnl = 0;
  const perSymbol = {};
  for (const [sym, d] of Object.entries(symbols)) {
    const volume = d.buyVolume + d.sellVolume;
    const avgBuyVwap  = d.buyVwaps.length  > 0 ? d.buyVwaps.reduce((a,b)=>a+b,0)/d.buyVwaps.length   : null;
    const avgSellVwap = d.sellVwaps.length > 0 ? d.sellVwaps.reduce((a,b)=>a+b,0)/d.sellVwaps.length : null;
    perSymbol[sym] = {
      buys: d.buys, sells: d.sells, roundtrips: Math.min(d.buys, d.sells),
      buyVolume: +d.buyVolume.toFixed(4), sellVolume: +d.sellVolume.toFixed(4),
      volume: +volume.toFixed(4),
      avgBuyVwap:  avgBuyVwap  != null ? +avgBuyVwap.toFixed(4)  : null,
      avgSellVwap: avgSellVwap != null ? +avgSellVwap.toFixed(4) : null,
      pnl: +d.pnl.toFixed(6), fees: +d.fees.toFixed(6),
      netPnl: +(d.pnl - d.fees).toFixed(6),
    };
    totalVolume += volume;
    totalPnl += d.pnl;
  }

  const totalBuys  = filled.filter(t=>t.side==='entry'&&t.legA_side==='buy').length  + filled.filter(t=>t.side==='exit'&&t.legA_side==='buy').length;
  const totalSells = filled.filter(t=>t.side==='entry'&&t.legA_side==='sell').length + filled.filter(t=>t.side==='exit'&&t.legA_side==='sell').length;
  const exitTrades = filled.filter(t=>t.side==='exit'&&t.exchangePnl!=null);
  const totalExchangePnl = exitTrades.length>0 ? +exitTrades.reduce((s,t)=>s+parseFloat(t.exchangePnl),0).toFixed(6) : null;

  return {
    totalTrades: trades.length,
    filledCount: filled.length,
    cancelledCount: trades.filter(t=>t.status==='cancelled').length,
    otherCount: trades.filter(t=>t.status!=='filled'&&t.status!=='cancelled').length,
    totalExecutions: filled.reduce((s,t)=>{let c=0;if(t.legA_filledAt)c++;if(t.legB_filledAt)c++;return s+c;},0),
    totalRoundtrips: Math.min(entryCount, exitCount),
    totalBuys, totalSells,
    totalVolume: +totalVolume.toFixed(4),
    totalPnl: +totalPnl.toFixed(6),
    totalFeesLegA: +totalFeesLegA.toFixed(6),
    totalFeesLegB: +totalFeesLegB.toFixed(6),
    totalFees: +(totalFeesLegA+totalFeesLegB).toFixed(6),
    netPnlAfterFees: +(totalPnl-totalFeesLegA-totalFeesLegB).toFixed(6),
    totalExchangePnl,
    perSymbol,
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ DB connected\n');

    // ── Fetch DB trades for both pairs ────────────────────────────────────────
    const [trades56, trades55] = await Promise.all([
      Trade.findAll({ where: { pairId: 56 }, order: [['createdAt', 'ASC']] }),
      Trade.findAll({ where: { pairId: 55 }, order: [['createdAt', 'ASC']] }),
    ]);

    // ── Fetch accounts ────────────────────────────────────────────────────────
    const [hlAccount, deribitAccount] = await Promise.all([
      AccountDetails.findOne({ where: { Trade_Account: 'Test Hyperliquid', Status: 'Active' } }),
      AccountDetails.findOne({ where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' } }),
    ]);

    console.log('═══════════════════════════════════════════════════');
    console.log('  PAIR 56 — BRENTCL (HyperLiquid xyz)');
    console.log('═══════════════════════════════════════════════════');

    // ── DB summary for pair 56 ────────────────────────────────────────────────
    const filled56 = trades56.filter(t => t.status === 'filled');
    const open56   = trades56.filter(t => t.status === 'open' || t.status === 'closed');
    const cancelled56 = trades56.filter(t => t.status === 'cancelled');

    console.log(`\n📊 DB Trade Counts (pair 56):`);
    console.log(`   Total: ${trades56.length}  |  Filled: ${filled56.length}  |  Cancelled: ${cancelled56.length}  |  Other: ${open56.length}`);

    // Filled breakdown
    const entries56 = filled56.filter(t => t.side === 'entry');
    const exits56   = filled56.filter(t => t.side === 'exit');
    console.log(`   Entries filled: ${entries56.length}  |  Exits filled: ${exits56.length}  |  Roundtrips: ${Math.min(entries56.length, exits56.length)}`);

    // PnL summary from DB
    const dbPnl56 = filled56.reduce((s, t) => {
      const a = t.legA_pnl ?? 0;
      const b = t.legB_pnl ?? 0;
      return s + a + b;
    }, 0);
    const dbExchangePnl56 = exits56.filter(t=>t.exchangePnl!=null).reduce((s,t)=>s+parseFloat(t.exchangePnl),0);
    console.log(`   Gross PnL (legA+legB pnl fields): $${dbPnl56.toFixed(4)}`);
    console.log(`   Exchange-reported PnL (balance changes): $${dbExchangePnl56.toFixed(4)}`);

    // Trades with missing PnL
    const missingPnl56 = filled56.filter(t => t.legA_pnl == null);
    console.log(`   Filled trades with NULL legA_pnl: ${missingPnl56.length}`);

    // Open positions in DB
    const dbOpen56 = trades56.filter(t => t.status === 'open' || t.status === 'closed');
    console.log(`   DB records with status 'open'/'closed': ${dbOpen56.length}`);
    if (dbOpen56.length > 0) {
      dbOpen56.slice(0, 5).forEach(t => console.log(`     id=${t.id} side=${t.side} legA=${t.legA_symbol} price=${t.legA_price} orderId=${t.legA_orderId}`));
    }

    // ── Recalculate analytics for pair 56 and compare to API ─────────────────
    const recalc56 = recalcAnalytics(trades56.map(t => t.dataValues));
    console.log(`\n🔢 Analytics Recalculation vs API (pair 56 BRENTCL):`);
    const apiAnalytics56 = await axios.get('http://localhost:4000/api/trades/analytics?pairId=56').then(r => r.data);
    const fields = ['totalTrades','filledCount','cancelledCount','otherCount','totalExecutions','totalRoundtrips','totalBuys','totalSells','totalVolume','totalPnl','totalFeesLegA','totalFeesLegB','totalFees','netPnlAfterFees','totalExchangePnl'];
    let mismatch56 = false;
    for (const f of fields) {
      const api = apiAnalytics56[f];
      const rec = recalc56[f];
      const match = JSON.stringify(api) === JSON.stringify(rec);
      if (!match) { mismatch56 = true; console.log(`   ❌ ${f}: API=${api}  Recalc=${rec}`); }
      else console.log(`   ✅ ${f}: ${api}`);
    }
    // perSymbol check
    for (const sym of Object.keys(apiAnalytics56.perSymbol || {})) {
      const apiSym = apiAnalytics56.perSymbol[sym];
      const recSym = recalc56.perSymbol[sym] || {};
      for (const k of ['buys','sells','roundtrips','pnl','fees','netPnl']) {
        if (JSON.stringify(apiSym[k]) !== JSON.stringify(recSym[k])) {
          mismatch56 = true;
          console.log(`   ❌ perSymbol.${sym}.${k}: API=${apiSym[k]}  Recalc=${recSym[k]}`);
        }
      }
    }
    if (!mismatch56) console.log('   ✅ All analytics fields match between API and recalculation');

    // ── HyperLiquid exchange fills for pair 56 ────────────────────────────────
    console.log(`\n📡 Fetching HyperLiquid exchange fills for "Test Hyperliquid" account...`);
    if (hlAccount) {
      try {
        const hlCreds = getCredentials(hlAccount);
        const hlClient = new Hyperliquid({
          enableWs: false,
          privateKey: hlCreds.secret,
          vaultAddress: hlCreds.vaultAddress || undefined,
          testnet: false,
          disableAssetMapRefresh: false,
        });
        await hlClient.initialize();

        const walletAddress = hlClient.exchange?.wallet?.address || hlCreds.vaultAddress;
        console.log(`   Wallet: ${walletAddress}`);

        // Fetch recent fills for CL and BRENTOIL
        const [clFills, brentFills] = await Promise.all([
          hlClient.info.getUserFillsByTime(walletAddress, Date.now() - 7*24*3600*1000, null, false).catch(() => []),
          hlClient.info.getUserFillsByTime(walletAddress, Date.now() - 7*24*3600*1000, null, false).catch(() => []),
        ]);

        // getUserFillsByTime returns all fills — filter by symbol
        const allFills = clFills; // same call
        const clExFills    = allFills.filter(f => f.coin === 'CL');
        const brentExFills = allFills.filter(f => f.coin === 'BRENTOIL');

        console.log(`   Exchange CL fills (7d): ${clExFills.length}`);
        console.log(`   Exchange BRENTOIL fills (7d): ${brentExFills.length}`);

        // DB order IDs for pair 56
        const dbOrderIds56 = new Set([
          ...filled56.map(t => t.legA_orderId).filter(Boolean),
          ...filled56.map(t => t.legB_orderId).filter(Boolean),
        ]);

        // Cross-check: find exchange fills that match DB order IDs
        const matchedCL    = clExFills.filter(f => dbOrderIds56.has(String(f.oid)));
        const matchedBrent = brentExFills.filter(f => dbOrderIds56.has(String(f.oid)));
        const unmatchedCL    = clExFills.filter(f => !dbOrderIds56.has(String(f.oid)));
        const unmatchedBrent = brentExFills.filter(f => !dbOrderIds56.has(String(f.oid)));

        console.log(`\n   📋 Cross-check DB orderIds vs Exchange fills:`);
        console.log(`   CL    — matched: ${matchedCL.length}  |  unmatched (exchange-only): ${unmatchedCL.length}`);
        console.log(`   BRENT — matched: ${matchedBrent.length}  |  unmatched (exchange-only): ${unmatchedBrent.length}`);

        // DB order IDs not found in exchange fills
        const exOrderIds = new Set([...clExFills, ...brentExFills].map(f => String(f.oid)));
        const dbMissingFromEx = [...dbOrderIds56].filter(id => !exOrderIds.has(id));
        if (dbMissingFromEx.length > 0) {
          console.log(`   ⚠️  DB orderIds NOT found in exchange fills (7d window): ${dbMissingFromEx.length}`);
          dbMissingFromEx.slice(0, 10).forEach(id => console.log(`      ${id}`));
        } else {
          console.log(`   ✅ All DB orderIds found in exchange fills (7d window)`);
        }

        // Exchange-side PnL estimate vs DB PnL
        const exBrentPnl = brentExFills.reduce((s, f) => s + (f.closedPnl || 0), 0);
        const exCLPnl    = clExFills.reduce((s, f) => s + (f.closedPnl || 0), 0);
        console.log(`\n   💰 Exchange-reported closedPnl (7d):`);
        console.log(`      BRENTOIL: $${exBrentPnl.toFixed(4)}`);
        console.log(`      CL:       $${exCLPnl.toFixed(4)}`);
        console.log(`      Combined: $${(exBrentPnl + exCLPnl).toFixed(4)}`);

        // Compare with DB computed PnL
        const dbLegAPnl = filled56.reduce((s,t)=>s+(t.legA_pnl||0),0);
        const dbLegBPnl = filled56.reduce((s,t)=>s+(t.legB_pnl||0),0);
        console.log(`\n   DB legA (BRENT) gross pnl: $${dbLegAPnl.toFixed(4)}`);
        console.log(`   DB legB (CL) gross pnl:    $${dbLegBPnl.toFixed(4)}`);
        console.log(`   DB combined gross pnl:     $${(dbLegAPnl + dbLegBPnl).toFixed(4)}`);

        // Current open positions on exchange
        try {
          const positions = await hlClient.info.perpetuals.getClearinghouseState(walletAddress);
          const assetPositions = positions?.assetPositions || [];
          const clPos    = assetPositions.filter(p => p?.position?.coin === 'CL');
          const brentPos = assetPositions.filter(p => p?.position?.coin === 'BRENTOIL');
          console.log(`\n   📌 Exchange Open Positions:`);
          if (clPos.length > 0) {
            clPos.forEach(p => {
              const pos = p.position;
              console.log(`      CL:       size=${pos.szi}  entryPx=${pos.entryPx}  unrealizedPnl=${pos.unrealizedPnl}`);
            });
          } else console.log(`      CL:       NO OPEN POSITION`);
          if (brentPos.length > 0) {
            brentPos.forEach(p => {
              const pos = p.position;
              console.log(`      BRENTOIL: size=${pos.szi}  entryPx=${pos.entryPx}  unrealizedPnl=${pos.unrealizedPnl}`);
            });
          } else console.log(`      BRENTOIL: NO OPEN POSITION`);

          // Compare with bot's in-memory open positions from API
          const stateResp = await axios.get('http://localhost:4000/api/pairs/56/trade/state').then(r => r.data);
          const memPositions = stateResp.openPositions || [];
          console.log(`\n   🤖 Bot In-Memory Open Positions: ${memPositions.length}`);
          memPositions.forEach(p => console.log(`      posId=${p.posId} dir=${p.direction} entryPx=${p.entryPrice} qty=${p.qty} state=${p.posState}`));

          // Net position from exchange
          const exNetBrent = brentPos.reduce((s,p)=>s+parseFloat(p.position.szi||0),0);
          const exNetCL    = clPos.reduce((s,p)=>s+parseFloat(p.position.szi||0),0);
          const botLongBrent = memPositions.filter(p=>p.direction==='long').length;
          const botShortBrent = memPositions.filter(p=>p.direction==='short').length;
          const netBotBrent = (botLongBrent - botShortBrent) * 1.22; // qty per position
          console.log(`\n   📐 Position Size Check (BRENTOIL):`);
          console.log(`      Exchange net size: ${exNetBrent}`);
          console.log(`      Bot net size (long-short)×qty: ${netBotBrent.toFixed(3)}`);
          if (Math.abs(exNetBrent - netBotBrent) > 0.1) {
            console.log(`      ⚠️  MISMATCH! Diff: ${(exNetBrent - netBotBrent).toFixed(3)}`);
          } else {
            console.log(`      ✅ Position sizes match`);
          }
        } catch (posErr) {
          console.log(`   ⚠️  Could not fetch open positions: ${posErr.message}`);
        }

      } catch (hlErr) {
        console.log(`   ❌ HyperLiquid fetch failed: ${hlErr.message}`);
      }
    } else {
      console.log('   ⚠️  "Test Hyperliquid" account not found in DB');
    }

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n\n═══════════════════════════════════════════════════');
    console.log('  PAIR 55 — BTC BASIS (Deribit BTC-24APR26 vs BTC-PERPETUAL)');
    console.log('═══════════════════════════════════════════════════');

    const filled55 = trades55.filter(t => t.status === 'filled');
    const open55   = trades55.filter(t => t.status === 'open');
    const cancelled55 = trades55.filter(t => t.status === 'cancelled');

    console.log(`\n📊 DB Trade Counts (pair 55):`);
    console.log(`   Total: ${trades55.length}  |  Filled: ${filled55.length}  |  Cancelled: ${cancelled55.length}  |  Other (open/closed/failed): ${trades55.length - filled55.length - cancelled55.length}`);

    const entries55 = filled55.filter(t => t.side === 'entry');
    const exits55   = filled55.filter(t => t.side === 'exit');
    console.log(`   Entries filled: ${entries55.length}  |  Exits filled: ${exits55.length}  |  Roundtrips: ${Math.min(entries55.length, exits55.length)}`);

    const dbPnl55legA = filled55.reduce((s,t)=>s+(t.legA_pnl||0),0);
    const dbPnl55legB = filled55.reduce((s,t)=>s+(t.legB_pnl||0),0);
    const dbExchangePnl55 = exits55.filter(t=>t.exchangePnl!=null).reduce((s,t)=>s+parseFloat(t.exchangePnl),0);
    console.log(`   Gross PnL legA (BTC-24APR26): $${dbPnl55legA.toFixed(4)}`);
    console.log(`   Gross PnL legB (BTC-PERPETUAL): $${dbPnl55legB.toFixed(4)}`);
    console.log(`   Combined gross PnL: $${(dbPnl55legA + dbPnl55legB).toFixed(4)}`);
    console.log(`   Exchange-reported PnL (balance changes): $${dbExchangePnl55.toFixed(4)}`);

    // Open records
    console.log(`   DB records with status 'open': ${open55.length}`);
    if (open55.length > 0) {
      open55.slice(0, 5).forEach(t => console.log(`     id=${t.id} side=${t.side} legA=${t.legA_symbol} legAOrd=${t.legA_orderId} legB=${t.legB_symbol} legBOrd=${t.legB_orderId}`));
    }

    // ── Recalculate analytics for pair 55 ────────────────────────────────────
    const recalc55 = recalcAnalytics(trades55.map(t => t.dataValues));
    const apiAnalytics55 = await axios.get('http://localhost:4000/api/trades/analytics?pairId=55').then(r => r.data);
    console.log(`\n🔢 Analytics Recalculation vs API (pair 55 BTC BASIS):`);
    let mismatch55 = false;
    for (const f of fields) {
      const api = apiAnalytics55[f];
      const rec = recalc55[f];
      const match = JSON.stringify(api) === JSON.stringify(rec);
      if (!match) { mismatch55 = true; console.log(`   ❌ ${f}: API=${api}  Recalc=${rec}`); }
      else console.log(`   ✅ ${f}: ${api}`);
    }
    for (const sym of Object.keys(apiAnalytics55.perSymbol || {})) {
      const apiSym = apiAnalytics55.perSymbol[sym];
      const recSym = recalc55.perSymbol[sym] || {};
      for (const k of ['buys','sells','roundtrips','pnl','fees','netPnl']) {
        if (JSON.stringify(apiSym[k]) !== JSON.stringify(recSym[k])) {
          mismatch55 = true;
          console.log(`   ❌ perSymbol.${sym}.${k}: API=${apiSym[k]}  Recalc=${recSym[k]}`);
        }
      }
    }
    if (!mismatch55) console.log('   ✅ All analytics fields match between API and recalculation');

    // ── Deribit exchange fills for pair 55 ────────────────────────────────────
    console.log(`\n📡 Fetching Deribit exchange fills for "deribit hiddenroad" account...`);
    if (deribitAccount) {
      try {
        const dCreds = getCredentials(deribitAccount);
        const token = await getDeribitToken(dCreds.apiKey, dCreds.secret);
        console.log(`   ✅ Deribit auth OK`);

        // Fetch recent settlement history / trade history for BTC
        const [tradeHistoryFutures, tradeHistoryPerp, openOrders, positions] = await Promise.all([
          deribitGet(`/api/v2/private/get_user_trades_by_instrument?instrument_name=BTC-24APR26&count=200&sorting=desc`, token).catch(e => ({ trades: [] })),
          deribitGet(`/api/v2/private/get_user_trades_by_instrument?instrument_name=BTC-PERPETUAL&count=200&sorting=desc`, token).catch(e => ({ trades: [] })),
          deribitGet(`/api/v2/private/get_open_orders_by_currency?currency=BTC`, token).catch(() => []),
          deribitGet(`/api/v2/private/get_positions?currency=BTC`, token).catch(() => []),
        ]);

        const exFuturesTrades = (tradeHistoryFutures.trades || tradeHistoryFutures || []);
        const exPerpTrades    = (tradeHistoryPerp.trades    || tradeHistoryPerp    || []);

        console.log(`   Exchange BTC-24APR26 fills (last 200): ${exFuturesTrades.length}`);
        console.log(`   Exchange BTC-PERPETUAL fills (last 200): ${exPerpTrades.length}`);
        console.log(`   Open orders (BTC): ${(openOrders || []).length}`);

        // DB order IDs for pair 55
        const dbOrderIds55 = new Set([
          ...filled55.map(t => t.legA_orderId).filter(Boolean),
          ...filled55.map(t => t.legB_orderId).filter(Boolean),
        ]);

        // Cross-check: exchange fills vs DB
        const matchedFutures = exFuturesTrades.filter(f => dbOrderIds55.has(String(f.order_id)));
        const matchedPerp    = exPerpTrades.filter(f => dbOrderIds55.has(String(f.order_id)));
        const unmatchedFutures = exFuturesTrades.filter(f => !dbOrderIds55.has(String(f.order_id)));
        const unmatchedPerp    = exPerpTrades.filter(f => !dbOrderIds55.has(String(f.order_id)));

        console.log(`\n   📋 Cross-check DB orderIds vs Exchange fills:`);
        console.log(`   BTC-24APR26   — matched: ${matchedFutures.length}  |  unmatched (exchange-only): ${unmatchedFutures.length}`);
        console.log(`   BTC-PERPETUAL — matched: ${matchedPerp.length}  |  unmatched (exchange-only): ${unmatchedPerp.length}`);

        const exOrderIds55 = new Set([...exFuturesTrades, ...exPerpTrades].map(f => String(f.order_id)));
        const dbMissingFromEx55 = [...dbOrderIds55].filter(id => !exOrderIds55.has(id));
        if (dbMissingFromEx55.length > 0) {
          console.log(`   ⚠️  DB orderIds NOT found in exchange fills (last 200 each): ${dbMissingFromEx55.length}`);
          dbMissingFromEx55.slice(0, 10).forEach(id => console.log(`      ${id}`));
        } else {
          console.log(`   ✅ All sampled DB orderIds found in exchange fills`);
        }

        // Exchange PnL
        const exFuturesPnl = exFuturesTrades.reduce((s,f) => s + (f.profit_loss || 0), 0);
        const exPerpPnl    = exPerpTrades.reduce((s,f) => s + (f.profit_loss || 0), 0);
        const exFuturesFee = exFuturesTrades.reduce((s,f) => s + (f.fee || 0), 0);
        const exPerpFee    = exPerpTrades.reduce((s,f) => s + (f.fee || 0), 0);
        console.log(`\n   💰 Exchange trade PnL (last 200 fills, BTC units × index):`);
        console.log(`      BTC-24APR26 profit_loss: ${exFuturesPnl.toFixed(6)} BTC`);
        console.log(`      BTC-PERPETUAL profit_loss: ${exPerpPnl.toFixed(6)} BTC`);
        console.log(`      BTC-24APR26 fees: ${exFuturesFee.toFixed(6)} BTC`);
        console.log(`      BTC-PERPETUAL fees: ${exPerpFee.toFixed(6)} BTC`);

        // Open positions on exchange
        console.log(`\n   📌 Deribit Open Positions (BTC):`);
        if (positions && positions.length > 0) {
          positions.forEach(p => {
            console.log(`      ${p.instrument_name}: size=${p.size}  direction=${p.direction}  avg_price=${p.average_price}  unrealized_pnl=${p.floating_profit_loss} BTC  delta=${p.delta}`);
          });
        } else {
          console.log(`      No open BTC positions on Deribit`);
        }

        // Open orders
        console.log(`\n   📋 Deribit Open Orders (BTC):`);
        if (openOrders && openOrders.length > 0) {
          openOrders.slice(0, 10).forEach(o => {
            console.log(`      ${o.instrument_name} ${o.direction} ${o.amount} @ ${o.price}  id=${o.order_id}  state=${o.order_state}`);
          });
        } else {
          console.log(`      No open BTC orders on Deribit`);
        }

        // Compare with bot's in-memory open positions
        const stateResp55 = await axios.get('http://localhost:4000/api/pairs/55/trade/state').then(r => r.data);
        const memPos55 = stateResp55.openPositions || [];
        console.log(`\n   🤖 Bot In-Memory Open Positions: ${memPos55.length}`);
        memPos55.forEach(p => console.log(`      posId=${p.posId} dir=${p.direction} zScore=${p.entryZScore?.toFixed(3)} state=${p.posState}`));

        // Check bot daily loss
        console.log(`\n   ⚡ Bot Risk Status (pair 55):`);
        console.log(`      dailyLoss: $${stateResp55.dailyLoss?.toFixed(4)}  |  limit: $${stateResp55.dailyLossLimit}`);
        console.log(`      filledQty: ${stateResp55.filledQty}  |  state: ${stateResp55.state}`);

      } catch (dErr) {
        console.log(`   ❌ Deribit fetch failed: ${dErr.message}`);
        if (dErr.response?.data) console.log('      ', JSON.stringify(dErr.response.data).slice(0,200));
      }
    } else {
      console.log('   ⚠️  "deribit hiddenroad" account not found in DB');
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    console.log('\n\n═══════════════════════════════════════════════════');
    console.log('  FINAL ANALYTICS SUMMARY');
    console.log('═══════════════════════════════════════════════════');

    console.log('\n📊 PAIR 56 — BRENTCL (HyperLiquid)');
    console.log(`   Trades: ${apiAnalytics56.totalTrades} total  |  ${apiAnalytics56.filledCount} filled  |  ${apiAnalytics56.cancelledCount} cancelled`);
    console.log(`   Roundtrips: ${apiAnalytics56.totalRoundtrips}  |  Executions: ${apiAnalytics56.totalExecutions}`);
    console.log(`   Volume: $${apiAnalytics56.totalVolume?.toLocaleString()}`);
    console.log(`   Gross PnL: $${apiAnalytics56.totalPnl}`);
    console.log(`   Total Fees: $${apiAnalytics56.totalFees}  (legA: $${apiAnalytics56.totalFeesLegA}  legB: $${apiAnalytics56.totalFeesLegB})`);
    console.log(`   Net PnL after fees: $${apiAnalytics56.netPnlAfterFees}`);
    console.log(`   Exchange PnL: $${apiAnalytics56.totalExchangePnl}`);
    if (apiAnalytics56.perSymbol) {
      for (const [sym, d] of Object.entries(apiAnalytics56.perSymbol)) {
        console.log(`   ${sym}: buys=${d.buys} sells=${d.sells} roundtrips=${d.roundtrips} pnl=$${d.pnl} fees=$${d.fees} netPnl=$${d.netPnl}`);
      }
    }

    console.log('\n📊 PAIR 55 — BTC BASIS (Deribit)');
    console.log(`   Trades: ${apiAnalytics55.totalTrades} total  |  ${apiAnalytics55.filledCount} filled  |  ${apiAnalytics55.cancelledCount} cancelled`);
    console.log(`   Roundtrips: ${apiAnalytics55.totalRoundtrips}  |  Executions: ${apiAnalytics55.totalExecutions}`);
    console.log(`   Volume: $${apiAnalytics55.totalVolume?.toLocaleString()}`);
    console.log(`   Gross PnL: $${apiAnalytics55.totalPnl}`);
    console.log(`   Total Fees: $${apiAnalytics55.totalFees}  (legA: $${apiAnalytics55.totalFeesLegA}  legB: $${apiAnalytics55.totalFeesLegB})`);
    console.log(`   Net PnL after fees: $${apiAnalytics55.netPnlAfterFees}`);
    console.log(`   Exchange PnL: $${apiAnalytics55.totalExchangePnl}`);
    if (apiAnalytics55.perSymbol) {
      for (const [sym, d] of Object.entries(apiAnalytics55.perSymbol)) {
        console.log(`   ${sym}: buys=${d.buys} sells=${d.sells} roundtrips=${d.roundtrips} pnl=$${d.pnl} fees=$${d.fees} netPnl=$${d.netPnl}`);
      }
    }

    console.log('\n✅ Analysis complete\n');
    process.exit(0);

  } catch (err) {
    console.error('Fatal error:', err.message, err.stack);
    process.exit(1);
  }
})();
