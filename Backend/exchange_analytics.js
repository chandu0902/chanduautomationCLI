/**
 * exchange_analytics.js
 *
 * Fetches ALL data from Deribit exchange only (no DB).
 * Calculates full trade analytics: PnL, wins, losses, fees, equity, etc.
 *
 * Usage:  node exchange_analytics.js
 */

require('dotenv').config();
const crypto = require('crypto');
const axios  = require('axios');
const { Sequelize, DataTypes } = require('sequelize');

// ─── DB (only to get credentials + pair config) ───────────────────────────────
const sequelize = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);
const StatArbInput = sequelize.define('StatArbInput', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  exchange1: DataTypes.STRING, exchange2: DataTypes.STRING,
  symbol1: DataTypes.STRING, symbol2: DataTypes.STRING,
  tradeAccountA: DataTypes.STRING, tradeAccountB: DataTypes.STRING,
  status: DataTypes.STRING,
}, { tableName: 'statarb_inputs', timestamps: false });
const AccountDetails = sequelize.define('AccountDetails', {
  id: { type: DataTypes.INTEGER, primaryKey: true },
  Trade_Account: DataTypes.STRING, Api_Key: DataTypes.TEXT, Secret_Key: DataTypes.TEXT,
}, { tableName: 'AccountDetails', timestamps: false });

// ─── CRYPTO ────────────────────────────────────────────────────────────────────
function decrypt(k, d, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return dc.update(d,'base64','utf8') + dc.final('utf8');
}
function getCreds(acct) {
  const [i,d,k] = acct.Api_Key.split(',',3);
  const [si,sd,sk] = acct.Secret_Key.split(',',3);
  return { apiKey: decrypt(k,d,i), secret: decrypt(sk,sd,si) };
}

// ─── DERIBIT ────────────────────────────────────────────────────────────────────
async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc:'2.0', id:1, method:'public/auth',
    params:{ grant_type:'client_credentials', client_id:apiKey, client_secret:secret, scope:'trade:read_write' }
  }, { timeout: 10000 });
  return r.data.result.access_token;
}
async function dGet(path, token, params={}) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers:{ Authorization:`Bearer ${token}` }, params, timeout:15000
  });
  return r.data.result;
}

// Fetch ALL fills for a currency from a given start time (paginated)
async function fetchFills(currency, token, startMs) {
  const all = [];
  let curStart = startMs;
  for (let page = 0; page < 50; page++) {
    const res = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
      headers:{ Authorization:`Bearer ${token}` },
      params:{ currency, start_timestamp:curStart, end_timestamp:Date.now(), count:1000, sorting:'asc' },
      timeout:15000,
    }).then(r => r.data.result).catch(()=>null);
    const trades = res?.trades || [];
    if (!trades.length) break;
    all.push(...trades);
    if (!res?.has_more) break;
    curStart = trades[trades.length-1].timestamp + 1;
  }
  return all;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const hr = (n=60) => '─'.repeat(n);
function divider(t) { console.log(`\n${'═'.repeat(62)}\n  ${t}\n${'═'.repeat(62)}`); }
function sec(t)     { console.log(`\n${hr(3)} ${t} ${hr(Math.max(0,54-t.length))}`); }
function fmt(v, d=8){ return v != null ? v.toFixed(d) : 'null'; }
function usd(v)     { return v != null ? `$${v.toFixed(2)}` : 'null'; }
function pct(v)     { return v != null ? `${(v*100).toFixed(2)}%` : 'null'; }

// ─── SESSION START DETECTION ───────────────────────────────────────────────────
// Parse --since=<ISO> or --hours=<n> from argv
function parseCliTime() {
  for (const arg of process.argv.slice(2)) {
    const mSince = arg.match(/^--since=(.+)$/);
    if (mSince) return new Date(mSince[1]).getTime();
    const mHours = arg.match(/^--hours=(\d+(?:\.\d+)?)$/);
    if (mHours) return Date.now() - parseFloat(mHours[1]) * 3600 * 1000;
  }
  return null;
}

// Detect bot process start time from health endpoint
async function detectSessionStart() {
  try {
    const r = await axios.get('http://localhost:4001/api/health', { timeout: 3000 });
    const ms = r.data?.processStartMs;
    if (ms && ms > 1e12) return ms;
  } catch (_) { /* bot API not reachable */ }
  return null;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await sequelize.authenticate();

    // 1. Get active pair
    const pairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (!pairs.length) { console.log('No active pairs.'); process.exit(0); }
    const pair = pairs[0];
    const pairId = pair.id;

    divider(`EXCHANGE ANALYTICS — Pair ${pairId}: ${pair.symbol1} / ${pair.symbol2}`);

    // 2. Get credentials
    const acctName = pair.tradeAccountA || pair.tradeAccountB;
    const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
    if (!acct) throw new Error(`Account '${acctName}' not found`);
    const creds = getCreds(acct);
    const token = await getToken(creds.apiKey, creds.secret);
    console.log(`\n✅ Authenticated as: ${acctName}`);

    // 3. Currency
    const sym      = (pair.symbol1 || '').toUpperCase();
    const currency = sym.startsWith('ETH') ? 'ETH' : sym.includes('USDC') ? 'USDC' : 'BTC';

    // 4. Fetch account summary + index price
    const [summary, indexResult] = await Promise.all([
      dGet(`/api/v2/private/get_account_summary?currency=${currency}&extended=true`, token),
      dGet(`/api/v2/public/get_index_price?index_name=${currency.toLowerCase()}_usd`, token).catch(() => null),
    ]);
    const equity      = summary?.equity;
    const indexPrice  = indexResult?.index_price ?? summary?.index_price ?? null;
    const marginBal   = summary?.margin_balance;
    const available   = summary?.available_funds;
    const unrealPnl   = summary?.floating_profit_loss ?? summary?.total_pl ?? null;
    const feeLevel    = summary?.fee_level ?? summary?.fee_tier ?? null;

    sec('ACCOUNT BALANCE');
    console.log(`  Equity (${currency})        : ${equity}`);
    console.log(`  Equity (USD)           : ${equity != null && indexPrice ? usd(equity * indexPrice) : 'n/a'}`);
    console.log(`  Index price            : ${indexPrice}`);
    console.log(`  Margin balance (${currency})  : ${marginBal}`);
    console.log(`  Available funds (${currency}) : ${available}`);
    console.log(`  Unrealised PnL (${currency}) : ${unrealPnl}`);
    console.log(`  Fee tier               : ${feeLevel ?? 'n/a'}`);

    // 5. Determine session start time
    let startMs = parseCliTime();
    let sessionSource = 'cli arg';
    if (!startMs) {
      startMs = await detectSessionStart();
      sessionSource = 'bot process start (uptime)';
    }
    if (!startMs) {
      // Fallback: start of today UTC
      const d = new Date(); d.setUTCHours(0,0,0,0);
      startMs = d.getTime();
      sessionSource = 'today midnight UTC (fallback)';
    }
    console.log(`\n  Session window: ${new Date(startMs).toISOString()}  [source: ${sessionSource}]`);
    console.log(`  Fetching fills from ${new Date(startMs).toISOString()} ...`);
    const allFills = await fetchFills(currency, token, startMs);
    console.log(`  Total fills fetched: ${allFills.length}`);

    // 6. Fetch open positions
    const positions = await dGet(`/api/v2/private/get_positions?currency=${currency}`, token).catch(()=>[]);
    const openOrders = await dGet(`/api/v2/private/get_open_orders_by_currency?currency=${currency}`, token).catch(()=>[]);

    // 7. Split fills by instrument
    const fillsByInst = {};
    for (const f of allFills) {
      if (!fillsByInst[f.instrument_name]) fillsByInst[f.instrument_name] = [];
      fillsByInst[f.instrument_name].push(f);
    }

    sec('RAW FILLS PER INSTRUMENT');
    for (const [inst, fills] of Object.entries(fillsByInst)) {
      const buys  = fills.filter(f => f.direction === 'buy');
      const sells = fills.filter(f => f.direction === 'sell');
      const vol   = fills.reduce((s,f) => s + f.amount, 0);
      const plBtc = fills.reduce((s,f) => s + (f.profit_loss || 0), 0);
      const feeBtc= fills.reduce((s,f) => s + (f.fee || 0), 0);
      console.log(`\n  ${inst}`);
      console.log(`    Fills  : ${fills.length}  (buys: ${buys.length}  sells: ${sells.length})`);
      console.log(`    Volume : ${vol} contracts`);
      console.log(`    P&L    : ${fmt(plBtc)} ${currency}  = ${indexPrice ? usd(plBtc*indexPrice) : 'n/a'}`);
      console.log(`    Fees   : ${fmt(feeBtc)} ${currency}  = ${indexPrice ? usd(feeBtc*indexPrice) : 'n/a'}`);
      console.log(`    Net    : ${fmt(plBtc - feeBtc)} ${currency}  = ${indexPrice ? usd((plBtc-feeBtc)*indexPrice) : 'n/a'}`);
    }

    // 8. Identify closing fills (profit_loss != 0 → position was reduced/closed)
    //    For a basis pair: futures (legA=maker) + perp (legB=taker) close together
    //    Pair them by timestamp proximity (within 30 seconds)
    const instA = pair.symbol1;  // futures (maker)
    const instB = pair.symbol2;  // perp (taker)

    const closingA = (fillsByInst[instA] || []).filter(f => f.profit_loss !== 0 && f.profit_loss != null);
    const closingB = (fillsByInst[instB] || []).filter(f => f.profit_loss !== 0 && f.profit_loss != null);

    sec('ROUND-TRIP TRADE ANALYTICS (from exchange closing fills)');
    console.log(`  Closing fills — ${instA}: ${closingA.length}   ${instB}: ${closingB.length}`);

    // Pair each closing fill from legA with the nearest legB closing fill (within 60s)
    const usedB = new Set();
    const roundtrips = [];

    for (const fa of closingA) {
      let bestB = null, bestDiff = Infinity;
      for (const fb of closingB) {
        if (usedB.has(fb.trade_id)) continue;
        const diff = Math.abs(fa.timestamp - fb.timestamp);
        if (diff < bestDiff && diff < 60000) { bestDiff = diff; bestB = fb; }
      }
      if (bestB) {
        usedB.add(bestB.trade_id);
        const plA   = fa.profit_loss;
        const plB   = bestB.profit_loss;
        const feeA  = fa.fee;
        const feeB  = bestB.fee;
        const netBtc = plA + plB + feeA + feeB; // feeA is negative (rebate), feeB positive (cost)
        const netUsd = indexPrice ? netBtc * indexPrice : null;
        roundtrips.push({
          time:    new Date(fa.timestamp).toISOString(),
          instA:   fa.instrument_name, dirA: fa.direction, amtA: fa.amount, priceA: fa.price,
          instB:   bestB.instrument_name, dirB: bestB.direction, amtB: bestB.amount, priceB: bestB.price,
          plA, plB, feeA, feeB,
          netBtc, netUsd,
          win: netUsd != null ? netUsd > 0 : netBtc > 0,
        });
      }
    }

    // Unpaired closes (single-leg closes or timing mismatch)
    const unpairedA = closingA.filter(fa => !roundtrips.find(r => r.time === new Date(fa.timestamp).toISOString() && r.instA === fa.instrument_name));
    const unpairedB = closingB.filter(fb => !usedB.has(fb.trade_id));

    // 9. Per-trade table
    if (roundtrips.length > 0) {
      console.log(`\n  ${'#'.padEnd(4)} ${'Time (UTC)'.padEnd(24)} ${'PnL (BTC)'.padEnd(16)} ${'PnL (USD)'.padEnd(12)} ${'Result'}`);
      console.log(`  ${hr(68)}`);
      roundtrips.forEach((r, i) => {
        const tag = r.win ? '✅ WIN ' : '❌ LOSS';
        const plUsd = r.netUsd != null ? usd(r.netUsd) : `${fmt(r.netBtc,8)} BTC`;
        console.log(`  ${String(i+1).padEnd(4)} ${r.time.slice(0,23).padEnd(24)} ${fmt(r.netBtc,8).padEnd(16)} ${plUsd.padEnd(12)} ${tag}`);
      });
    }

    // 10. Summary analytics
    sec('ANALYTICS SUMMARY');

    const wins   = roundtrips.filter(r => r.win);
    const losses = roundtrips.filter(r => !r.win);
    const totalPnlBtc = roundtrips.reduce((s,r) => s + r.netBtc, 0);
    const totalPnlUsd = indexPrice ? totalPnlBtc * indexPrice : null;
    const winPnlBtc   = wins.reduce((s,r) => s + r.netBtc, 0);
    const lossPnlBtc  = losses.reduce((s,r) => s + r.netBtc, 0);
    const avgWinBtc   = wins.length   ? winPnlBtc  / wins.length   : 0;
    const avgLossBtc  = losses.length ? lossPnlBtc / losses.length : 0;
    const profitFactor = Math.abs(lossPnlBtc) > 0 ? winPnlBtc / Math.abs(lossPnlBtc) : null;
    const winRate      = roundtrips.length ? wins.length / roundtrips.length : 0;
    const expectancy   = roundtrips.length
      ? (winRate * avgWinBtc + (1 - winRate) * avgLossBtc)
      : 0;

    // Total fees breakdown
    const totalFeeA_Btc = allFills.filter(f=>f.instrument_name===instA).reduce((s,f)=>s+(f.fee||0),0);
    const totalFeeB_Btc = allFills.filter(f=>f.instrument_name===instB).reduce((s,f)=>s+(f.fee||0),0);
    const totalFeesBtc  = totalFeeA_Btc + totalFeeB_Btc;

    // Volume
    const volA = (fillsByInst[instA]||[]).reduce((s,f)=>s+f.amount,0);
    const volB = (fillsByInst[instB]||[]).reduce((s,f)=>s+f.amount,0);

    // Max drawdown (running peak-to-trough on cumulative PnL)
    let peak = 0, cumPnl = 0, maxDD = 0;
    for (const r of roundtrips) {
      cumPnl += r.netBtc;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    // Consecutive wins/losses
    let maxConsecWins = 0, maxConsecLosses = 0, curConsec = 0, curType = null;
    for (const r of roundtrips) {
      const type = r.win ? 'win' : 'loss';
      if (type === curType) { curConsec++; }
      else { curConsec = 1; curType = type; }
      if (type === 'win'  && curConsec > maxConsecWins)   maxConsecWins   = curConsec;
      if (type === 'loss' && curConsec > maxConsecLosses) maxConsecLosses = curConsec;
    }

    // Largest single win/loss
    const largestWin  = wins.length   ? Math.max(...wins.map(r=>r.netBtc))   : 0;
    const largestLoss = losses.length ? Math.min(...losses.map(r=>r.netBtc)) : 0;

    // Time span
    const firstFill = allFills[0];
    const lastFill  = allFills[allFills.length-1];
    const spanDays  = firstFill && lastFill
      ? ((lastFill.timestamp - firstFill.timestamp) / 86400000).toFixed(1)
      : 'n/a';

    console.log(`\n  ┌─ TRADE PERFORMANCE ${'─'.repeat(40)}`);
    console.log(`  │  Roundtrips completed  : ${roundtrips.length}`);
    console.log(`  │  Wins                  : ${wins.length}`);
    console.log(`  │  Losses                : ${losses.length}`);
    console.log(`  │  Win Rate              : ${pct(winRate)}`);
    console.log(`  │  Profit Factor         : ${profitFactor != null ? profitFactor.toFixed(4) : 'n/a'}`);
    console.log(`  │`);
    console.log(`  ├─ PnL ──────────────────────────────────────────────`);
    console.log(`  │  Total Net PnL (BTC)   : ${fmt(totalPnlBtc)}`);
    console.log(`  │  Total Net PnL (USD)   : ${totalPnlUsd != null ? usd(totalPnlUsd) : 'n/a'}`);
    console.log(`  │  Gross Win PnL (BTC)   : ${fmt(winPnlBtc)}`);
    console.log(`  │  Gross Loss PnL (BTC)  : ${fmt(lossPnlBtc)}`);
    console.log(`  │  Avg Win (BTC)         : ${fmt(avgWinBtc)}`);
    console.log(`  │  Avg Loss (BTC)        : ${fmt(avgLossBtc)}`);
    console.log(`  │  Largest Win (BTC)     : ${fmt(largestWin)}`);
    console.log(`  │  Largest Loss (BTC)    : ${fmt(largestLoss)}`);
    console.log(`  │  Expectancy (BTC/trade): ${fmt(expectancy)}`);
    console.log(`  │`);
    console.log(`  ├─ FEES ─────────────────────────────────────────────`);
    console.log(`  │  ${instA} fees (BTC)    : ${fmt(totalFeeA_Btc)}  ${indexPrice?`= ${usd(totalFeeA_Btc*indexPrice)}`:''}  ← maker rebate`);
    console.log(`  │  ${instB} fees (BTC): ${fmt(totalFeeB_Btc)}  ${indexPrice?`= ${usd(totalFeeB_Btc*indexPrice)}`:''}  ← taker cost`);
    console.log(`  │  Net fees (BTC)         : ${fmt(totalFeesBtc)}  ${indexPrice?`= ${usd(totalFeesBtc*indexPrice)}`:''}`);
    console.log(`  │`);
    console.log(`  ├─ VOLUME ───────────────────────────────────────────`);
    console.log(`  │  ${instA} volume         : ${volA} contracts`);
    console.log(`  │  ${instB} volume     : ${volB} contracts`);
    console.log(`  │  Total fills            : ${allFills.length}`);
    console.log(`  │  Session start          : ${new Date(startMs).toISOString().slice(0,19)}Z  [${sessionSource}]  (use --since=<ISO> or --hours=<n> to override)`);
    console.log(`  │  Fill span              : ${spanDays} days  (${firstFill ? new Date(firstFill.timestamp).toISOString().slice(0,19)+'Z' : 'n/a'} → ${lastFill ? new Date(lastFill.timestamp).toISOString().slice(0,19)+'Z' : 'n/a'})`);
    console.log(`  │  Total fills in session : ${allFills.length}`);
    console.log(`  │`);
    console.log(`  ├─ RISK ─────────────────────────────────────────────`);
    console.log(`  │  Max Drawdown (BTC)     : ${fmt(maxDD)}`);
    console.log(`  │  Max Drawdown (USD)     : ${indexPrice ? usd(maxDD*indexPrice) : 'n/a'}`);
    console.log(`  │  Max Consec Wins        : ${maxConsecWins}`);
    console.log(`  │  Max Consec Losses      : ${maxConsecLosses}`);
    console.log(`  │`);
    console.log(`  ├─ ACCOUNT ──────────────────────────────────────────`);
    console.log(`  │  Current Equity (${currency})  : ${equity}`);
    console.log(`  │  Current Equity (USD)   : ${equity != null && indexPrice ? usd(equity*indexPrice) : 'n/a'}`);
    console.log(`  │  Unrealised PnL (${currency})  : ${unrealPnl}`);
    console.log(`  └────────────────────────────────────────────────────`);

    // 11. Open positions
    if (positions?.length > 0) {
      sec('CURRENT OPEN POSITIONS');
      positions.forEach(p => {
        const upnlUsd = p.floating_profit_loss != null && indexPrice ? usd(p.floating_profit_loss * indexPrice) : null;
        console.log(`  ${p.instrument_name.padEnd(24)} ${p.direction.padEnd(5)} size=${String(p.size).padStart(8)}  avg=${p.average_price?.toFixed(2)?.padStart(10)}  unreal_pnl=${upnlUsd || p.floating_profit_loss + ' BTC'}`);
      });
    }

    // 12. Open orders
    if (openOrders?.length > 0) {
      sec('OPEN ORDERS');
      openOrders.forEach(o => {
        console.log(`  ⚠️  ${o.instrument_name} ${o.direction} ${o.amount} @ ${o.price}  id=${o.order_id}`);
      });
    }

    // 13. Unpaired closes (if any)
    if (unpairedA.length > 0 || unpairedB.length > 0) {
      sec('UNPAIRED CLOSING FILLS (no matching counterpart within 60s)');
      unpairedA.forEach(f => console.log(`  ${instA}: ${f.direction} ${f.amount} @ ${f.price}  pl=${fmt(f.profit_loss)}  time=${new Date(f.timestamp).toISOString()}`));
      unpairedB.forEach(f => console.log(`  ${instB}: ${f.direction} ${f.amount} @ ${f.price}  pl=${fmt(f.profit_loss)}  time=${new Date(f.timestamp).toISOString()}`));
    }

    console.log('\n');
    await sequelize.close();

  } catch(err) {
    console.error('Fatal:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
