require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Sequelize } = require('sequelize');
const crypto = require('crypto');
const axios = require('axios');

const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, dialect: 'mysql', logging: false
});

function decryptText(k, e, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}

async function getToken(ak, sk) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: ak, client_secret: sk, scope: 'trade:read_write' }
  }, { timeout: 10000 });
  return r.data?.result?.access_token;
}

async function fetchFills(token, sessionStartMs) {
  let fills = [];
  let offset = 0;
  while (true) {
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_instrument_and_time', {
      params: {
        instrument_name: 'ETH-PERPETUAL',
        start_timestamp: sessionStartMs,
        end_timestamp: Date.now(),
        count: 100,
        offset,
        sorting: 'asc'
      },
      headers: { Authorization: 'Bearer ' + token },
      timeout: 15000
    });
    const batch = r.data?.result?.trades || [];
    fills = fills.concat(batch);
    if (batch.length < 100) break;
    offset += 100;
    if (offset >= 500) break; // safety cap at 500 fills
  }
  return fills;
}

function matchRoundTrips(fills) {
  // Group partial fills by order_id
  const byOrder = {};
  for (const f of fills) {
    if (!byOrder[f.order_id]) byOrder[f.order_id] = { dir: f.direction, liq: f.liquidity, fills: [], qty: 0, fee: 0 };
    byOrder[f.order_id].fills.push(f);
    byOrder[f.order_id].qty += f.amount;
    byOrder[f.order_id].fee += f.fee;
  }
  // Weighted avg price per order
  for (const o of Object.values(byOrder)) {
    o.wavgPx = o.fills.reduce((s, f) => s + f.price * f.amount, 0) / o.qty;
  }
  const orders = Object.values(byOrder).sort((a, b) => a.fills[0].timestamp - b.fills[0].timestamp);

  // Match SELL (entry) → BUY (exit) pairs for SHORT strategy
  const roundTrips = [];
  const openEntries = [];
  for (const o of orders) {
    if (o.dir === 'sell') {
      openEntries.push(o);
    } else if (o.dir === 'buy' && openEntries.length) {
      const entry = openEntries.shift();
      const entryTime = new Date(entry.fills[0].timestamp);
      const exitTime  = new Date(o.fills[0].timestamp);
      const holdMs    = exitTime - entryTime;
      // Inverse perp gross PnL in USD
      const grossEth  = entry.qty * (1 / entry.wavgPx - 1 / o.wavgPx);
      const grossUsd  = grossEth * o.wavgPx;
      const feeEth    = entry.fee + o.fee; // negative = rebate
      const rebateUsd = Math.abs(feeEth) * o.wavgPx;
      const netUsd    = grossUsd + rebateUsd;
      roundTrips.push({ entryTime, exitTime, holdMs, entryPx: entry.wavgPx, exitPx: o.wavgPx,
        qty: entry.qty, grossUsd, feeEth, rebateUsd, netUsd, win: netUsd > 0 });
    }
  }
  return { roundTrips, openEntries };
}

(async () => {
  const row = await s.query("SELECT Api_Key,Secret_Key FROM AccountDetails WHERE Trade_Account='ETHHIDDEN_ROAD'",
    { type: s.QueryTypes.SELECT });
  const [ak0, ak1, ak2] = row[0].Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = row[0].Secret_Key.split(',', 3);
  const token = await getToken(decryptText(ak2, ak1, ak0), decryptText(sk2, sk1, sk0));
  console.log('Auth OK');

  const SESSION_START_MS = new Date('2026-04-19T09:36:36Z').getTime();
  const fills = await fetchFills(token, SESSION_START_MS);
  console.log('Fills fetched:', fills.length);

  const { roundTrips, openEntries } = matchRoundTrips(fills);

  // Stats helpers
  const sum  = a => a.reduce((s, x) => s + x, 0);
  const avg  = a => a.length ? sum(a) / a.length : 0;
  const wins   = roundTrips.filter(r => r.win);
  const losses = roundTrips.filter(r => !r.win);
  const np     = roundTrips.map(r => r.netUsd);
  const gp     = roundTrips.map(r => r.grossUsd);
  const hold   = roundTrips.map(r => r.holdMs);
  const avgW   = avg(wins.map(r => r.netUsd));
  const avgL   = avg(losses.map(r => r.netUsd));
  const pf     = sum(losses.map(r => Math.abs(r.grossUsd))) > 0
    ? sum(wins.map(r => r.grossUsd)) / sum(losses.map(r => Math.abs(r.grossUsd))) : 0;

  // Exchange fee totals
  const makerFills  = fills.filter(f => f.liquidity === 'M');
  const takerFills  = fills.filter(f => f.liquidity !== 'M');
  const totalFeeEth = fills.reduce((s, f) => s + f.fee, 0);
  const avgPx       = fills.length ? fills.reduce((s, f) => s + f.price, 0) / fills.length : 0;
  const totalRebate = Math.abs(totalFeeEth) * avgPx;

  // Consecutive losses
  let maxCL = 0, curCL = 0;
  for (const r of roundTrips) { if (!r.win) { curCL++; maxCL = Math.max(maxCL, curCL); } else curCL = 0; }

  const L = '─'.repeat(66);
  const rpt = new Date().toISOString().slice(0, 16) + ' UTC';

  console.log('\n' + L);
  console.log('  ETH-PERPETUAL (pair 26)  |  EXCHANGE-BASED FULL REPORT');
  console.log('  Session start : 2026-04-19 09:36 UTC');
  console.log('  Report time   : ' + rpt);
  console.log('  Exchange fills: ' + fills.length + ' | Round-trips: ' + roundTrips.length + ' | Open positions: ' + openEntries.length);
  console.log(L);
  console.log('  PERFORMANCE');
  console.log('  Net PnL           : $' + sum(np).toFixed(2));
  console.log('  Gross PnL         : $' + sum(gp).toFixed(2));
  console.log('  Total rebate      : $' + totalRebate.toFixed(4) + ' (' + totalFeeEth.toFixed(8) + ' ETH)');
  console.log('  Wins / Losses     : ' + wins.length + ' / ' + losses.length + '   Win rate: ' + ((wins.length / (roundTrips.length || 1)) * 100).toFixed(1) + '%');
  console.log('  Avg win  (net)    : $' + avgW.toFixed(4));
  console.log('  Avg loss (net)    : $' + avgL.toFixed(4));
  console.log('  Reward:Risk       : ' + (avgL < 0 ? Math.abs(avgW / avgL).toFixed(3) : 'n/a') + '   (need > 1.0)');
  console.log('  Profit Factor     : ' + pf.toFixed(3) + '   (need > 1.0)');
  console.log('  Expectancy/trade  : $' + (sum(np) / (roundTrips.length || 1)).toFixed(4));
  console.log('  Avg hold          : ' + (avg(hold) / 1000).toFixed(1) + 's');
  console.log('  Max consec losses : ' + maxCL);
  console.log(L);
  console.log('  EXCHANGE RECONCILIATION');
  console.log('  Maker fills : ' + makerFills.length + '  (' + (makerFills.length === fills.length ? '✅ all maker' : '⚠ mixed') + ')');
  console.log('  Taker fills : ' + takerFills.length + '  ' + (takerFills.length === 0 ? '✅ ZERO' : '⚠ TAKER FEES PAID'));
  if (takerFills.length) {
    for (const f of takerFills)
      console.log('    TAKER: ' + new Date(f.timestamp).toISOString() + ' ' + f.direction + ' px=' + f.price + ' fee=' + f.fee + ' ' + f.fee_currency + ' order=' + f.order_id);
  }
  console.log('  Rebate/round-trip : $' + (totalRebate / (roundTrips.length || 1)).toFixed(4) + ' avg');
  console.log('  Avg fill price    : $' + avgPx.toFixed(2));
  console.log(L);
  console.log('  GROSS PnL DISTRIBUTION  (n=' + roundTrips.length + ')');
  const buckets = [[-99,-20],[-20,-15],[-15,-10],[-10,-5],[-5,-2],[-2,0],[0,2],[2,5],[5,10],[10,15],[15,99]];
  for (const [lo, hi] of buckets) {
    const n = gp.filter(x => x >= lo && x < hi).length;
    if (n) {
      const wn = roundTrips.filter(r => r.grossUsd >= lo && r.grossUsd < hi && r.win).length;
      console.log('  ' + ('$' + lo + ' to $' + hi).padEnd(16) + ': ' + String(n).padStart(3) + '  ' + '█'.repeat(Math.min(n, 30)) + '  (W:' + wn + ' L:' + (n-wn) + ')');
    }
  }
  console.log(L);
  console.log('  HOLD TIME BREAKDOWN  (win rate & avg net per bracket)');
  for (const [lo, hi, label] of [[0,15000,'<15s'],[15000,30000,'15-30s'],[30000,60000,'30-60s'],[60000,90000,'60-90s'],[90000,999999,'>90s']]) {
    const bucket = roundTrips.filter(r => r.holdMs >= lo && r.holdMs < hi);
    if (!bucket.length) continue;
    const bw = bucket.filter(r => r.win).length;
    const avgNet = avg(bucket.map(r => r.netUsd));
    console.log('  ' + label.padEnd(10) + ': ' + String(bucket.length).padStart(3) + ' trades | W:' + bw + ' L:' + (bucket.length-bw)
      + ' | WR:' + ((bw/bucket.length)*100).toFixed(0) + '%'
      + ' | avgNet:$' + avgNet.toFixed(2)
      + ' | avgGross:$' + avg(bucket.map(r => r.grossUsd)).toFixed(2));
  }
  console.log(L);
  console.log('  LAST 15 ROUND-TRIPS (exchange)');
  for (const r of roundTrips.slice(-15)) {
    const move = (r.exitPx - r.entryPx).toFixed(2);
    console.log('  ' + r.exitTime.toISOString().slice(0, 19)
      + '  entry=' + r.entryPx.toFixed(2) + '  exit=' + r.exitPx.toFixed(2)
      + '  Δpx=' + (move > 0 ? '+' : '') + move
      + '  gross=' + r.grossUsd.toFixed(2).padStart(7)
      + '  net=' + (r.netUsd >= 0 ? '+' : '') + r.netUsd.toFixed(2).padStart(7)
      + '  hold=' + (r.holdMs / 1000).toFixed(0).padStart(4) + 's'
      + '  ' + (r.win ? '✅ WIN' : '❌ LOSS'));
  }
  console.log(L);
  console.log('  RECOMMENDATIONS');
  console.log(L);
  // Auto-generate recommendations from data
  const avgWinGross = avg(wins.map(r => r.grossUsd));
  const avgLossGross = avg(losses.map(r => r.grossUsd));
  const stopsOver90s = roundTrips.filter(r => !r.win && r.holdMs > 90000).length;
  const bigLosses = roundTrips.filter(r => r.grossUsd < -15).length;
  const tinyWins  = wins.filter(r => r.grossUsd < 3).length;

  console.log('  1. WIN RATE ' + ((wins.length/roundTrips.length)*100).toFixed(0) + '% — need 70%+ for R:R ' + Math.abs(avgW/avgL).toFixed(2) + ':1');
  console.log('     → Raise adaptSigmaMin (2.2 → 2.5) to skip marginal entries');
  console.log('');
  console.log('  2. AVG WIN GROSS $' + avgWinGross.toFixed(2) + ' vs AVG LOSS GROSS $' + avgLossGross.toFixed(2));
  console.log('     → fixedTpUsd=' + 14 + ' is never reached (max win gross seen ~$' + Math.max(...wins.map(r=>r.grossUsd)).toFixed(2) + ')');
  console.log('     → Lower fixedTpUsd to $5 to lock in wins where they cluster ($0-5 gross)');
  console.log('');
  console.log('  3. ' + bigLosses + ' trades grossed < -$15 (exceeds maxSingleTradeLossUsd=$8)');
  console.log('     → SL 5s reprice (already fixed) should reduce tail losses');
  console.log('     → Consider maxSingleTradeLossUsd=$6 for stricter containment');
  console.log('');
  console.log('  4. ' + stopsOver90s + ' losing trades held >90s despite maxHoldMs=90s');
  console.log('     → Investigate maxHoldMs enforcement in code');
  console.log('');
  console.log('  5. ' + tinyWins + ' wins had gross <$3 — rebate is doing the work, not price move');
  console.log('     → Set minGrossProfitUsd or raise tpSpreadDelta so spread TP waits for real move');
  console.log('');
  console.log('  BREAKEVEN WIN RATE REQUIRED @ current R:R ' + Math.abs(avgW/avgL).toFixed(3) + ':1');
  const beWr = 1 / (1 + Math.abs(avgW / avgL));
  console.log('  = ' + (beWr * 100).toFixed(1) + '%  (currently ' + ((wins.length/roundTrips.length)*100).toFixed(1) + '% — need +' + ((beWr - wins.length/roundTrips.length)*100).toFixed(1) + '% more wins OR bigger wins)');
  console.log(L);

  await s.close();
})();
