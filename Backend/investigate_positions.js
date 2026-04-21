/**
 * investigate_positions.js
 * Deep-dive into the long/short position imbalance on Deribit for Pair 55
 * BTC-24APR26 (SHORT -490) vs BTC-PERPETUAL (LONG +28,800)
 */

require('dotenv').config();
const crypto  = require('crypto');
const axios   = require('axios');
const { Sequelize, DataTypes, Op } = require('sequelize');

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
  legA_price: DataTypes.DOUBLE,   legA_qty: DataTypes.DOUBLE,   legA_orderId: DataTypes.STRING,
  legA_filledAt: DataTypes.DATE,
  legB_exchange: DataTypes.STRING, legB_symbol: DataTypes.STRING, legB_side: DataTypes.STRING,
  legB_price: DataTypes.DOUBLE,   legB_qty: DataTypes.DOUBLE,   legB_orderId: DataTypes.STRING,
  legB_filledAt: DataTypes.DATE,
  pnl: DataTypes.DOUBLE, status: DataTypes.STRING,
}, { tableName: 'trade_logs', timestamps: true });

const AccountDetails = sequelize.define('AccountDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  Trade_Account: DataTypes.STRING, Exchange: DataTypes.STRING,
  Api_Key: DataTypes.TEXT, Secret_Key: DataTypes.TEXT,
  Status: DataTypes.STRING, vaultAddress: DataTypes.STRING,
}, { tableName: 'AccountDetails', timestamps: false });

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv  = Buffer.from(ivBase64,  'base64');
  const dc  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return dc.update(encryptedText, 'base64', 'utf8') + dc.final('utf8');
}
function getCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
  const secret = decryptText(sk2, sk1, sk0);
  return { apiKey, secret };
}

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

const DERIBIT_CONTRACT_USD = 10; // each contract = $10 USD notional

function contractsToUSD(contracts) {
  return contracts * DERIBIT_CONTRACT_USD;
}

(async () => {
  try {
    await sequelize.authenticate();

    const deribitAccount = await AccountDetails.findOne({
      where: { Trade_Account: 'deribit hiddenroad', Status: 'Active' }
    });
    if (!deribitAccount) { console.error('Account not found'); process.exit(1); }

    const creds = getCredentials(deribitAccount);
    const token = await getDeribitToken(creds.apiKey, creds.secret);
    console.log('✅ Deribit auth OK\n');

    // ─── 1. ALL OPEN POSITIONS (BTC) ──────────────────────────────────────────
    const positions = await deribitGet('/api/v2/private/get_positions?currency=BTC', token).catch(() => []);
    const openOrders = await deribitGet('/api/v2/private/get_open_orders_by_currency?currency=BTC', token).catch(() => []);
    const accountSummary = await deribitGet('/api/v2/private/get_account_summary?currency=BTC&extended=true', token).catch(() => null);

    console.log('════════════════════════════════════════════════════════════════');
    console.log('  1. LIVE EXCHANGE STATE — Deribit BTC Account');
    console.log('════════════════════════════════════════════════════════════════');

    if (accountSummary) {
      console.log(`\n  Account Summary:`);
      console.log(`    equity          : ${accountSummary.equity?.toFixed(8)} BTC`);
      console.log(`    balance         : ${accountSummary.balance?.toFixed(8)} BTC`);
      console.log(`    margin_balance  : ${accountSummary.margin_balance?.toFixed(8)} BTC`);
      console.log(`    unrealized_pnl  : ${accountSummary.session_upl?.toFixed(8)} BTC`);
      console.log(`    realized_pnl    : ${accountSummary.session_rpl?.toFixed(8)} BTC`);
      console.log(`    delta_total     : ${accountSummary.delta_total?.toFixed(6)} BTC`);
      console.log(`    BTC index price : ~$${accountSummary.index_price?.toFixed(2)}`);
    }

    const btcIndex = accountSummary?.index_price || 70000;

    console.log(`\n  Open Positions (${positions.length} total):`);
    if (positions.length === 0) {
      console.log('    None');
    } else {
      let totalLongUSD = 0, totalShortUSD = 0;
      for (const p of positions) {
        const sizeUSD  = contractsToUSD(Math.abs(p.size));
        const sizeSign = p.size > 0 ? '+' : '';
        const dir      = p.direction.toUpperCase();
        if (p.size > 0) totalLongUSD  += sizeUSD;
        else            totalShortUSD += sizeUSD;

        console.log(`    ${p.instrument_name.padEnd(22)} size=${sizeSign}${p.size} contracts  (${sizeSign}$${(p.size > 0 ? sizeUSD : -sizeUSD).toFixed(0)} USD)  dir=${dir}  avg_px=$${p.average_price?.toFixed(2)}  unrealPnl=${p.floating_profit_loss?.toFixed(6)} BTC  delta=${p.delta?.toFixed(4)}`);
      }
      console.log(`\n  Aggregated Exposure:`);
      console.log(`    Total LONG  USD notional : +$${totalLongUSD.toFixed(0)}`);
      console.log(`    Total SHORT USD notional : -$${totalShortUSD.toFixed(0)}`);
      console.log(`    NET                      :  $${(totalLongUSD - totalShortUSD).toFixed(0)} (${totalLongUSD > totalShortUSD ? 'NET LONG' : totalShortUSD > totalLongUSD ? 'NET SHORT' : 'FLAT'})`);
      console.log(`\n  ⚠️  IMBALANCE ANALYSIS:`);
      const futuresPos  = positions.find(p => p.instrument_name === 'BTC-24APR26');
      const perpPos     = positions.find(p => p.instrument_name === 'BTC-PERPETUAL');
      const futuresSize = futuresPos?.size  ?? 0;
      const perpSize    = perpPos?.size     ?? 0;
      const futuresUSD  = contractsToUSD(Math.abs(futuresSize));
      const perpUSD     = contractsToUSD(Math.abs(perpSize));
      console.log(`    BTC-24APR26   : ${futuresSize} contracts = $${futuresUSD.toFixed(0)} USD  (${futuresSize < 0 ? 'SHORT' : 'LONG'})`);
      console.log(`    BTC-PERPETUAL : ${perpSize} contracts = $${perpUSD.toFixed(0)} USD  (${perpSize > 0 ? 'LONG' : 'SHORT'})`);
      console.log(`    Imbalance     : ${Math.abs(perpSize - Math.abs(futuresSize))} contracts = $${Math.abs(perpUSD - futuresUSD).toFixed(0)} USD unhedged`);
      console.log(`    Hedge ratio   : futures/perp = ${(Math.abs(futuresSize) / Math.abs(perpSize) * 100).toFixed(1)}%  (should be ~${900/720*100}% per config)`);
    }

    console.log(`\n  Open Orders (${openOrders.length} total):`);
    if (openOrders.length === 0) {
      console.log('    None');
    } else {
      for (const o of openOrders) {
        const notional = contractsToUSD(o.amount);
        console.log(`    ${o.instrument_name.padEnd(22)} ${o.direction.toUpperCase().padEnd(5)} ${o.amount} contracts ($${notional}) @ $${o.price}  id=${o.order_id}  state=${o.order_state}`);
      }
    }

    // ─── 2. TRADE HISTORY — RECONSTRUCT HOW POSITIONS BUILT UP ───────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  2. EXCHANGE FILL HISTORY — Reconstruct Position Build-Up');
    console.log('════════════════════════════════════════════════════════════════');

    // Fetch all recent fills (last 200 each, Deribit max per call)
    const [futuresFills, perpFills] = await Promise.all([
      deribitGet('/api/v2/private/get_user_trades_by_instrument?instrument_name=BTC-24APR26&count=200&sorting=desc', token)
        .then(r => r.trades || r || []).catch(() => []),
      deribitGet('/api/v2/private/get_user_trades_by_instrument?instrument_name=BTC-PERPETUAL&count=200&sorting=desc', token)
        .then(r => r.trades || r || []).catch(() => []),
    ]);

    // Sort ascending by timestamp
    futuresFills.sort((a,b) => a.timestamp - b.timestamp);
    perpFills.sort((a,b) => a.timestamp - b.timestamp);

    // Reconstruct net position from fills
    let runFuturesNet = 0, runPerpNet = 0;
    let futuresBuys = 0, futuresSells = 0, perpBuys = 0, perpSells = 0;
    let futuresBuyQty = 0, futuresSellQty = 0, perpBuyQty = 0, perpSellQty = 0;
    let futuresFeesBtc = 0, perpFeesBtc = 0;
    let futuresPnlBtc = 0, perpPnlBtc = 0;

    for (const f of futuresFills) {
      if (f.direction === 'buy')  { runFuturesNet += f.amount; futuresBuys++;  futuresBuyQty  += f.amount; }
      else                        { runFuturesNet -= f.amount; futuresSells++; futuresSellQty += f.amount; }
      futuresFeesBtc += (f.fee || 0);
      futuresPnlBtc  += (f.profit_loss || 0);
    }
    for (const f of perpFills) {
      if (f.direction === 'buy')  { runPerpNet += f.amount; perpBuys++;  perpBuyQty  += f.amount; }
      else                        { runPerpNet -= f.amount; perpSells++; perpSellQty += f.amount; }
      perpFeesBtc += (f.fee || 0);
      perpPnlBtc  += (f.profit_loss || 0);
    }

    console.log(`\n  BTC-24APR26 fills (last ${futuresFills.length}):`);
    console.log(`    Buys  : ${futuresBuys} fills  |  qty = ${futuresBuyQty} contracts ($${contractsToUSD(futuresBuyQty).toFixed(0)})`);
    console.log(`    Sells : ${futuresSells} fills  |  qty = ${futuresSellQty} contracts ($${contractsToUSD(futuresSellQty).toFixed(0)})`);
    console.log(`    Net from fills : ${runFuturesNet > 0 ? '+' : ''}${runFuturesNet} contracts  (${runFuturesNet > 0 ? 'NET LONG' : runFuturesNet < 0 ? 'NET SHORT' : 'FLAT'})`);
    console.log(`    Fees : ${futuresFeesBtc.toFixed(6)} BTC = $${(futuresFeesBtc * btcIndex).toFixed(2)}`);
    console.log(`    PnL  : ${futuresPnlBtc.toFixed(6)} BTC = $${(futuresPnlBtc * btcIndex).toFixed(2)}`);
    if (futuresFills.length > 0) {
      const oldest = new Date(futuresFills[0].timestamp).toISOString();
      const newest = new Date(futuresFills[futuresFills.length-1].timestamp).toISOString();
      console.log(`    Range: ${oldest} → ${newest}`);
    }

    console.log(`\n  BTC-PERPETUAL fills (last ${perpFills.length}):`);
    console.log(`    Buys  : ${perpBuys} fills  |  qty = ${perpBuyQty} contracts ($${contractsToUSD(perpBuyQty).toFixed(0)})`);
    console.log(`    Sells : ${perpSells} fills  |  qty = ${perpSellQty} contracts ($${contractsToUSD(perpSellQty).toFixed(0)})`);
    console.log(`    Net from fills : ${runPerpNet > 0 ? '+' : ''}${runPerpNet} contracts  (${runPerpNet > 0 ? 'NET LONG' : runPerpNet < 0 ? 'NET SHORT' : 'FLAT'})`);
    console.log(`    Fees : ${perpFeesBtc.toFixed(6)} BTC = $${(perpFeesBtc * btcIndex).toFixed(2)}`);
    console.log(`    PnL  : ${perpPnlBtc.toFixed(6)} BTC = $${(perpPnlBtc * btcIndex).toFixed(2)}`);
    if (perpFills.length > 0) {
      const oldest = new Date(perpFills[0].timestamp).toISOString();
      const newest = new Date(perpFills[perpFills.length-1].timestamp).toISOString();
      console.log(`    Range: ${oldest} → ${newest}`);
    }

    // Note if fills only go back 200 — position may have accumulated over longer history
    if (futuresFills.length === 200 || perpFills.length === 200) {
      console.log('\n  ⚠️  Deribit returns max 200 fills per call. Position may have been built over MORE fills than shown above.');
      console.log('     The "net from fills" above only reflects the LAST 200 fills, not all-time.');
    }

    // ─── 3. DB TRADE RECONSTRUCTION ───────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  3. DB TRADE RECONSTRUCTION — Compute Expected Position from DB');
    console.log('════════════════════════════════════════════════════════════════');

    const trades55 = await Trade.findAll({
      where: { pairId: 55, status: 'filled' },
      order: [['createdAt', 'ASC']]
    });

    let dbFuturesNet = 0, dbPerpNet = 0;
    let entriesLong = 0, entriesShort = 0, exitsLong = 0, exitsShort = 0;

    // For pair 55: legA = BTC-24APR26 (futures), legB = BTC-PERPETUAL (perp)
    // Entry long  => buy futures, sell perp
    // Entry short => sell futures, buy perp
    // Exit long   => sell futures, buy perp
    // Exit short  => buy futures, sell perp
    for (const t of trades55) {
      if (!t.legA_qty) continue;
      const qA = t.legA_qty;
      const qB = t.legB_qty || 0;
      if (t.side === 'entry') {
        if (t.legA_side === 'buy') {
          dbFuturesNet += qA; dbPerpNet -= qB; entriesLong++;
        } else {
          dbFuturesNet -= qA; dbPerpNet += qB; entriesShort++;
        }
      } else { // exit
        if (t.legA_side === 'sell') {
          dbFuturesNet -= qA; dbPerpNet += qB; exitsLong++;
        } else {
          dbFuturesNet += qA; dbPerpNet -= qB; exitsShort++;
        }
      }
    }

    console.log(`\n  DB filled records (pair 55): ${trades55.length}`);
    console.log(`    Entry longs  (buy futures / sell perp) : ${entriesLong}`);
    console.log(`    Entry shorts (sell futures / buy perp) : ${entriesShort}`);
    console.log(`    Exit longs   (sell futures / buy perp) : ${exitsLong}`);
    console.log(`    Exit shorts  (buy futures / sell perp) : ${exitsShort}`);
    console.log(`\n  Expected net position from DB fills:`);
    console.log(`    BTC-24APR26 (futures) : ${dbFuturesNet > 0 ? '+' : ''}${dbFuturesNet.toFixed(0)} contracts ($${contractsToUSD(Math.abs(dbFuturesNet)).toFixed(0)} USD)`);
    console.log(`    BTC-PERPETUAL (perp)  : ${dbPerpNet > 0 ? '+' : ''}${dbPerpNet.toFixed(0)} contracts ($${contractsToUSD(Math.abs(dbPerpNet)).toFixed(0)} USD)`);

    // Compare DB expected vs exchange actual
    const actualFutures = positions.find(p => p.instrument_name === 'BTC-24APR26')?.size ?? 0;
    const actualPerp    = positions.find(p => p.instrument_name === 'BTC-PERPETUAL')?.size ?? 0;

    console.log(`\n  Comparison — DB Expected vs Exchange Actual:`);
    const futuresDiff = actualFutures - dbFuturesNet;
    const perpDiff    = actualPerp    - dbPerpNet;
    console.log(`    BTC-24APR26   : exchange=${actualFutures}  db_expected=${dbFuturesNet.toFixed(0)}  diff=${futuresDiff > 0 ? '+' : ''}${futuresDiff.toFixed(0)}`);
    console.log(`    BTC-PERPETUAL : exchange=${actualPerp}     db_expected=${dbPerpNet.toFixed(0)}    diff=${perpDiff > 0 ? '+' : ''}${perpDiff.toFixed(0)}`);

    if (Math.abs(futuresDiff) > 5 || Math.abs(perpDiff) > 5) {
      console.log(`\n  ❌ POSITION MISMATCH CONFIRMED:`);
      if (Math.abs(futuresDiff) > 5)
        console.log(`     Futures: ${Math.abs(futuresDiff).toFixed(0)} contracts ($${contractsToUSD(Math.abs(futuresDiff)).toFixed(0)}) unaccounted for in DB`);
      if (Math.abs(perpDiff) > 5)
        console.log(`     Perp:    ${Math.abs(perpDiff).toFixed(0)} contracts ($${contractsToUSD(Math.abs(perpDiff)).toFixed(0)}) unaccounted for in DB`);
    } else {
      console.log(`\n  ✅ DB and exchange positions match within tolerance`);
    }

    // ─── 4. ORPHANED ENTRY ANALYSIS ───────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  4. ORPHANED ENTRIES — Entries with No Matching Exit');
    console.log('════════════════════════════════════════════════════════════════');

    const allTrades55 = await Trade.findAll({
      where: { pairId: 55 },
      order: [['createdAt', 'ASC']]
    });

    const entries55 = allTrades55.filter(t => t.side === 'entry' && t.status === 'filled');
    const exits55   = allTrades55.filter(t => t.side === 'exit'  && t.status === 'filled');
    const orphans   = entries55.length - exits55.length;

    console.log(`\n  Total filled entries : ${entries55.length}`);
    console.log(`  Total filled exits   : ${exits55.length}`);
    console.log(`  Orphaned entries     : ${orphans}  (entries - exits)`);
    if (orphans > 0) {
      const orphanContracts = orphans * 900;
      const hedgeContracts  = orphans * 720;
      console.log(`\n  If each orphan = 1 position (900 futures / 720 perp):`);
      console.log(`    Unexited futures exposure : ${orphanContracts} contracts = $${contractsToUSD(orphanContracts).toFixed(0)} USD`);
      console.log(`    Unexited perp exposure    : ${hedgeContracts} contracts = $${contractsToUSD(hedgeContracts).toFixed(0)} USD`);
    }

    // Show last 10 entries in chronological order to see if exits follow
    console.log(`\n  Last 10 filled entries (most recent first):`);
    const recentEntries = entries55.slice(-10).reverse();
    for (const e of recentEntries) {
      console.log(`    id=${e.id}  ${e.createdAt.toISOString().slice(0,19)}  legA_side=${e.legA_side}  legA_qty=${e.legA_qty}  legB_qty=${e.legB_qty}  pnl=${e.pnl}`);
    }

    // ─── 5. STALE OPEN RECORDS ANALYSIS ───────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  5. STALE "OPEN" DB RECORDS — Orders That Never Got Confirmed');
    console.log('════════════════════════════════════════════════════════════════');

    const staleOpen = allTrades55.filter(t => t.status === 'open');
    const staleExits   = staleOpen.filter(t => t.side === 'exit');
    const staleEntries = staleOpen.filter(t => t.side === 'entry');

    console.log(`\n  Stale 'open' records: ${staleOpen.length}  (exits=${staleExits.length}  entries=${staleEntries.length})`);

    // Check a sample of stale exit orders on Deribit to see if they filled
    console.log(`\n  Checking last 10 stale EXIT orders against Deribit...`);
    const sampleStaleExits = staleExits.slice(-10);
    let staleFilledCount = 0, staleCancelledCount = 0, staleStillOpenCount = 0, staleUnknownCount = 0;

    for (const t of sampleStaleExits) {
      const orderId = t.legA_orderId;
      if (!orderId) { console.log(`    id=${t.id} — no legA_orderId`); continue; }
      try {
        const state = await deribitGet(`/api/v2/private/get_order_state?order_id=${orderId}`, token);
        const s = state?.order_state || 'unknown';
        const filled = state?.filled_amount || 0;
        const side   = state?.direction || '?';
        const instr  = state?.instrument_name || '?';
        console.log(`    id=${t.id}  ordId=${orderId}  exchange_state=${s}  filled=${filled}  ${side} ${instr}`);
        if (s === 'filled')    staleFilledCount++;
        else if (s === 'cancelled' || s === 'rejected') staleCancelledCount++;
        else if (s === 'open') staleStillOpenCount++;
        else staleUnknownCount++;
      } catch (e) {
        console.log(`    id=${t.id}  ordId=${orderId}  ❌ error: ${e.message}`);
        staleUnknownCount++;
      }
    }
    console.log(`\n  Sample result (${sampleStaleExits.length} checked):`);
    console.log(`    filled on exchange    : ${staleFilledCount}`);
    console.log(`    cancelled/rejected    : ${staleCancelledCount}`);
    console.log(`    still open on exchange: ${staleStillOpenCount}`);
    console.log(`    unknown/error         : ${staleUnknownCount}`);

    // ─── 6. FUNDING IMPACT ────────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  6. FUNDING PAYMENTS — Perp Funding Impact on Account');
    console.log('════════════════════════════════════════════════════════════════');

    // Fetch settlement history (includes funding payments for perps)
    const settlementHistory = await deribitGet(
      '/api/v2/private/get_settlement_history_by_currency?currency=BTC&type=settlement&count=20', token
    ).then(r => r.settlements || r || []).catch(() => []);

    if (settlementHistory.length > 0) {
      let totalFunding = 0;
      console.log(`\n  Last ${settlementHistory.length} funding/settlement events:`);
      for (const s of settlementHistory.slice(0, 10)) {
        const usd = (s.session_tax || s.funding || 0) * btcIndex;
        totalFunding += (s.session_tax || s.funding || 0);
        console.log(`    ${new Date(s.timestamp).toISOString().slice(0,19)}  type=${s.type}  instrument=${s.instrument_name || 'n/a'}  funding=${(s.session_tax || s.funding || 0).toFixed(8)} BTC ($${usd.toFixed(2)})`);
      }
      console.log(`\n  Total funding (sample): ${totalFunding.toFixed(8)} BTC ($${(totalFunding * btcIndex).toFixed(2)})`);
    } else {
      console.log('\n  No settlement/funding history returned');
    }

    // ─── 7. ROOT CAUSE SUMMARY ────────────────────────────────────────────────
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  7. ROOT CAUSE ANALYSIS');
    console.log('════════════════════════════════════════════════════════════════');

    const perp    = positions.find(p => p.instrument_name === 'BTC-PERPETUAL');
    const futures = positions.find(p => p.instrument_name === 'BTC-24APR26');
    const perpSizeAbs    = Math.abs(perp?.size    || 0);
    const futuresSizeAbs = Math.abs(futures?.size || 0);
    const perpUSD2       = contractsToUSD(perpSizeAbs);
    const futuresUSD2    = contractsToUSD(futuresSizeAbs);
    const expectedRatio  = 900 / 720; // futures qty / perp qty per config

    console.log(`\n  OBSERVED:`);
    console.log(`    BTC-PERPETUAL  LONG   : +${perpSizeAbs} contracts = +$${perpUSD2.toFixed(0)} USD`);
    console.log(`    BTC-24APR26   SHORT   : -${futuresSizeAbs} contracts = -$${futuresUSD2.toFixed(0)} USD`);
    console.log(`    Actual hedge ratio    : ${(futuresSizeAbs / perpSizeAbs).toFixed(3)}  (expected ~${expectedRatio.toFixed(3)})`);
    console.log(`    Implied open positions from perp   : ${(perpSizeAbs / 720).toFixed(1)} positions`);
    console.log(`    Implied open positions from futures : ${(futuresSizeAbs / 900).toFixed(1)} positions`);
    console.log(`    Implied UNHEDGED perp              : ${perpSizeAbs - Math.round(futuresSizeAbs * 720/900)} contracts`);

    console.log(`\n  PROBABLE CAUSES:`);

    const impliedPerpPos = perpSizeAbs / 720;
    const impliedFutPos  = futuresSizeAbs / 900;
    const gap = impliedPerpPos - impliedFutPos;

    if (gap > 0.5) {
      console.log(`\n  [1] FAILED EXIT — PERP LEG CANCELLED, FUTURES LEG MISSED`);
      console.log(`      During exit, a sell on BTC-PERPETUAL succeeded but the corresponding`);
      console.log(`      buy on BTC-24APR26 was cancelled/timed-out, or vice versa. Over`);
      console.log(`      multiple such events the perp accumulated long exposure that was`);
      console.log(`      never offset by a futures short.`);
      console.log(`\n  [2] PARTIAL FILL / ASYMMETRIC QTY EXECUTION`);
      console.log(`      Entry places 900 on futures (legA) and 720 on perp (legB).`);
      console.log(`      If the futures leg was only partially filled but the perp filled`);
      console.log(`      fully, the perp position grows faster than futures can hedge.`);
      console.log(`\n  [3] SERVER RESTART LOSING POSITION STATE`);
      console.log(`      With 18 orphaned entries: bot entered ${orphans} times without recording`);
      console.log(`      exits. Those ${orphans} open positions are live on the exchange but the bot`);
      console.log(`      thinks it is flat. New entries continue to stack without awareness`);
      console.log(`      of existing exposure.`);
      console.log(`\n  [4] STALE "OPEN" RECORDS ARE ACTUALLY FILLED EXITS`);
      console.log(`      ${staleExits.length} exit records are stuck in "open" status. If those`);
      console.log(`      exits DID fill on-exchange (reducing both legs), the DB has NOT`);
      console.log(`      recorded them — so the DB expected position doesn't account for`);
      console.log(`      those exits, making the DB appear MORE exposed than it is.`);
      console.log(`      But the exchange position is real. If exits DID NOT fill, both legs`);
      console.log(`      remain open, which would show LARGE positions on both sides.`);
    }

    console.log(`\n  RECOMMENDED IMMEDIATE ACTIONS:`);
    console.log(`  [1] Check each stale exit order ID against Deribit to determine fill status.`);
    console.log(`  [2] If exits are confirmed filled on exchange: update DB status → "filled".`);
    console.log(`  [3] If exits are confirmed cancelled: re-enter them manually or`);
    console.log(`      restart the bot after manually closing exchange positions.`);
    console.log(`  [4] Manually close the unhedged perp exposure now to limit delta risk:`);
    const unhedgedPerp = perpSizeAbs - Math.round(futuresSizeAbs / expectedRatio);
    console.log(`      Sell ~${unhedgedPerp > 0 ? unhedgedPerp : 0} contracts of BTC-PERPETUAL at market`);
    console.log(`      to bring the position back to a delta-neutral hedge.`);
    console.log(`  [5] Add startup reconciliation: on bot enable, query Deribit positions`);
    console.log(`      and rebuild in-memory state rather than starting from zero.`);

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  Analysis complete');
    console.log('════════════════════════════════════════════════════════════════\n');

    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
