#!/usr/bin/env node
/**
 * Pair 26 — "Last IST night session" → now (exchange reconciliation).
 *
 * Default window: **previous calendar day in Asia/Kolkata at 23:00 IST**
 * (11 PM — typical reading of "yesterday night 11–12") through **Date.now()**.
 *
 * CLI (all optional):
 *   --ist-hour=23       wall hour in IST (default 23)
 *   --ist-minute=0
 *   --day-offset=1      1 = yesterday in Kolkata, 2 = day before, etc.
 *
 * Same exchange endpoints as eth26CurrentSessionExchangeReport.js
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { StatArbInput, AccountDetails, sequelize } = require('../src/models');

const PAIR_ID    = 26;
const INSTRUMENT = 'ETH-PERPETUAL';
const CCY        = 'ETH';

/* ── crypto / auth ──────────────────────────────────────────────────── */
function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(enc, 'base64', 'utf8') + d.final('utf8');
}
function creds(acc) {
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  return { apiKey: decrypt(ak2, ak1, ak0), secretKey: decrypt(sk2, sk1, sk0) };
}
async function auth(apiKey, secretKey) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── exchange fetchers ──────────────────────────────────────────────── */
async function fetchFills(token, startMs, endMs) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 300; page++) {
    await sleep(400);
    let r;
    for (let a = 0; a < 5; a++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_instrument_and_time', {
        headers: { Authorization: `Bearer ${token}` },
        params: { instrument_name: INSTRUMENT, start_timestamp: cur, end_timestamp: endMs, count: 1000, sorting: 'asc' },
        timeout: 30000, validateStatus: () => true,
      });
      if (r.status === 429 || r.data?.error?.code === 10028) { await sleep(6000 * (a + 1)); continue; }
      break;
    }
    const trades = r?.data?.result?.trades || [];
    all.push(...trades);
    process.stdout.write(`\r  fills: ${all.length}`);
    if (!r?.data?.result?.has_more || trades.length === 0) break;
    cur = trades[trades.length - 1].timestamp + 1;
    if (cur >= endMs) break;
  }
  process.stdout.write('\n');
  const seen = new Set();
  return all.filter(t => { if (seen.has(t.trade_id)) return false; seen.add(t.trade_id); return true; });
}

async function fetchTxLog(token, startMs, endMs) {
  const all = [];
  let cont;
  for (let page = 0; page < 100; page++) {
    await sleep(400);
    const params = { currency: CCY, start_timestamp: startMs, end_timestamp: endMs, count: 1000 };
    if (cont) params.continuation = cont;
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log', {
      headers: { Authorization: `Bearer ${token}` }, params,
      timeout: 30000, validateStatus: () => true,
    });
    const logs = r?.data?.result?.logs || [];
    all.push(...logs);
    process.stdout.write(`\r  txlog: ${all.length}`);
    cont = r?.data?.result?.continuation;
    if (!cont || logs.length === 0) break;
  }
  process.stdout.write('\n');
  return all;
}

async function fetchPositions(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_positions', {
    headers: { Authorization: `Bearer ${token}` },
    params: { currency: CCY, kind: 'future' }, timeout: 10000,
  });
  return (r.data.result || []).filter(p => p.size !== 0);
}

async function fetchOptionPositions(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_positions', {
    headers: { Authorization: `Bearer ${token}` },
    params: { currency: CCY, kind: 'option' }, timeout: 10000,
  }).catch(() => null);
  return (r?.data?.result || []).filter(p => p.size !== 0);
}

async function fetchSummary(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_account_summary', {
    headers: { Authorization: `Bearer ${token}` },
    params: { currency: CCY, extended: true }, timeout: 10000,
  });
  return r.data.result;
}

async function fetchIndex() {
  try {
    const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd', { timeout: 8000 });
    return r?.data?.result?.index_price || 0;
  } catch { return 0; }
}

/* ── round-trip matcher (net USD position) ──────────────────────────── */
function buildTrips(fills) {
  const trips = []; let net = 0; let startTs = null; let bucket = [];
  for (const f of fills) {
    const amt = parseFloat(f.amount);
    const signed = f.direction === 'buy' ? amt : -amt;
    if (net === 0) { startTs = f.timestamp; bucket = []; }
    bucket.push(f);
    const prev = Math.sign(net);
    net += signed;
    if (net === 0 || (prev !== 0 && Math.sign(net) !== prev)) {
      const pnl   = bucket.reduce((s,x)=>s+parseFloat(x.profit_loss||0),0);
      const fee   = bucket.reduce((s,x)=>s+parseFloat(x.fee||0),0);
      const vol   = bucket.reduce((s,x)=>s+parseFloat(x.amount),0);
      const dir   = bucket[0].direction === 'buy' ? 'LONG' : 'SHORT';
      const hold  = bucket[bucket.length-1].timestamp - startTs;
      trips.push({ startTs, dir, pnl, fee, vol, hold, fills: bucket.length });
      if (net !== 0 && Math.sign(net) !== prev) { startTs = f.timestamp; bucket = [f]; }
      else { bucket = []; net = 0; }
    }
  }
  return { trips, openNet: net, openBucket: bucket };
}

/* ── helpers ────────────────────────────────────────────────────────── */
const fmtTs  = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
const fmtDur = ms => { const m = Math.floor(ms/60000); const s = Math.round((ms%60000)/1000); return `${m}m ${s}s`; };
const sgn    = n => n >= 0 ? '+' : '';
const pct    = (n, d) => d ? ((n/d)*100).toFixed(1) + '%' : '0.0%';

/** Previous calendar day in Asia/Kolkata (when dayOffset=1), at hour:minute IST → epoch ms */
function istWallClockStartMs({ hour = 23, minute = 0, dayOffset = 1 } = {}) {
  const tz = 'Asia/Kolkata';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = todayStr.split('-').map(Number);
  const startToday = new Date(
    `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+05:30`
  ).getTime();
  const startTargetDay = startToday - dayOffset * 24 * 60 * 60 * 1000;
  return startTargetDay + (hour * 60 + minute) * 60 * 1000;
}

/* ── main ───────────────────────────────────────────────────────────── */
(async () => {
  const argv = process.argv.slice(2);
  let istHour = 23;
  let istMinute = 0;
  let dayOffset = 1;
  for (const a of argv) {
    if (a.startsWith('--ist-hour=')) istHour = parseInt(a.split('=')[1], 10) || 23;
    if (a.startsWith('--ist-minute=')) istMinute = parseInt(a.split('=')[1], 10) || 0;
    if (a.startsWith('--day-offset=')) dayOffset = parseInt(a.split('=')[1], 10) || 1;
  }

  const pair = await StatArbInput.findByPk(PAIR_ID);
  const acc  = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  const startMs = istWallClockStartMs({ hour: istHour, minute: istMinute, dayOffset });
  const endMs   = Date.now();

  const istFmt = (ms) =>
    new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });

  console.log(`\nPair ${PAIR_ID} — IST NIGHT WINDOW → NOW — pulling exchange data`);
  console.log(`  UTC window: ${fmtTs(startMs)}  →  ${fmtTs(endMs)}`);
  console.log(`  IST window: ${istFmt(startMs)}  →  ${istFmt(endMs)}`);
  console.log(`  Rule: Kolkata day-offset ${dayOffset} @ ${String(istHour).padStart(2, '0')}:${String(istMinute).padStart(2, '0')} IST`);
  console.log(`  Instrument: ${INSTRUMENT}\n`);

  const [fills, txLog, positions, optPositions, summary, idx] = await Promise.all([
    fetchFills(token, startMs, endMs),
    fetchTxLog(token, startMs, endMs),
    fetchPositions(token),
    fetchOptionPositions(token),
    fetchSummary(token),
    fetchIndex(),
  ]);

  const ethIdx = idx || parseFloat(fills[fills.length-1]?.price || 0) || 2360;
  const toUsd  = eth => eth * ethIdx;

  /* ── aggregate fills (ETH-PERPETUAL only) ─────────────────────────── */
  const perpFills   = fills;
  const buyFills    = perpFills.filter(f => f.direction === 'buy');
  const sellFills   = perpFills.filter(f => f.direction === 'sell');

  const volUsdTot   = perpFills.reduce((s,f)=>s+parseFloat(f.amount),0);
  const volUsdBuy   = buyFills.reduce((s,f)=>s+parseFloat(f.amount),0);
  const volUsdSell  = sellFills.reduce((s,f)=>s+parseFloat(f.amount),0);

  const realizedEth = perpFills.reduce((s,f)=>s+parseFloat(f.profit_loss||0),0);
  const feeEthSum   = perpFills.reduce((s,f)=>s+parseFloat(f.fee||0),0);
  const rebatesEth  = perpFills.filter(f=>parseFloat(f.fee||0)<0).reduce((s,f)=>s+Math.abs(parseFloat(f.fee||0)),0);
  const feesPaidEth = perpFills.filter(f=>parseFloat(f.fee||0)>0).reduce((s,f)=>s+parseFloat(f.fee||0),0);

  const makerFills  = perpFills.filter(f => f.liquidity === 'M' || parseFloat(f.fee||0) < 0);
  const takerFills  = perpFills.filter(f => f.liquidity === 'T' || parseFloat(f.fee||0) > 0);

  /* ── round-trips ──────────────────────────────────────────────────── */
  const { trips, openNet, openBucket } = buildTrips(perpFills);
  const wins   = trips.filter(t => t.pnl > 0);
  const losses = trips.filter(t => t.pnl < 0);
  const flats  = trips.filter(t => t.pnl === 0);

  const winsSum   = wins.reduce((s,t)=>s+t.pnl,0);
  const lossesSum = losses.reduce((s,t)=>s+t.pnl,0);
  const totalHold = trips.reduce((s,t)=>s+t.hold,0);
  const bestTrip  = trips.reduce((b,t)=>t.pnl>b.pnl?t:b, {pnl:-Infinity});
  const worstTrip = trips.reduce((b,t)=>t.pnl<b.pnl?t:b, {pnl: Infinity});

  // open position uPnL (inverse contract formula)
  let openInfo = null;
  if (openNet !== 0 && openBucket.length) {
    const openAvg = openBucket.reduce((s,f)=>s+parseFloat(f.price)*parseFloat(f.amount),0) /
                    openBucket.reduce((s,f)=>s+parseFloat(f.amount),0);
    const openDir = openBucket[0].direction === 'buy' ? 'LONG' : 'SHORT';
    const uPnl = openDir === 'LONG'
      ? openNet * (1/openAvg - 1/ethIdx)
      : openNet * (1/ethIdx - 1/openAvg);
    openInfo = { netUsd: openNet, avgPx: openAvg, dir: openDir, uPnl };
  }

  /* ── transaction log classification ───────────────────────────────── */
  const txByType = {};
  for (const t of txLog) {
    const k = t.type || 'unknown';
    txByType[k] = txByType[k] || { count: 0, sumEth: 0 };
    txByType[k].count++;
    txByType[k].sumEth += parseFloat(t.change || 0);
  }
  const perpTradeTx = (txByType.trade?.sumEth || 0);
  const settlementTx = (txByType.settlement?.sumEth || 0);
  const depositTx   = (txByType.deposit?.sumEth || 0);
  const withdrawTx  = (txByType.withdrawal?.sumEth || 0);

  /* ── equity reconstruction ────────────────────────────────────────── */
  const currentEquity = summary.equity;
  const currentBalance = summary.balance;
  const sessionChangeEth = realizedEth + feeEthSum;  // what fills moved on balance
  const startEquity = currentEquity - sessionChangeEth;

  /* ── build report ─────────────────────────────────────────────────── */
  const L = [];
  const HR = '═'.repeat(72);
  const hr = '─'.repeat(72);

  L.push(HR);
  L.push(`  ETH BOT  |  PAIR ${PAIR_ID}  |  IST NIGHT → NOW  |  ${pair.agentName || ''}`);
  L.push(`  Account      : ${pair.tradeAccountA}`);
  L.push(`  Instrument   : ${INSTRUMENT}`);
  L.push(`  Session (UTC): ${fmtTs(startMs)}  →  ${fmtTs(endMs)}  (${fmtDur(endMs - startMs)})`);
  L.push(`  Session (IST): ${istFmt(startMs)}  →  ${istFmt(endMs)}`);
  L.push(`  Window rule  : Asia/Kolkata day-offset ${dayOffset} @ ${String(istHour).padStart(2, '0')}:${String(istMinute).padStart(2, '0')} IST → Date.now()`);
  L.push(`  Stop reason  : ${pair.lastStopReason || 'manual'}`);
  L.push(`  ETH index    : $${ethIdx.toFixed(2)}  (for USD conversion)`);
  L.push(`  Data source  : Deribit exchange APIs ONLY`);
  L.push(`    • /get_user_trades_by_instrument_and_time (ETH-PERPETUAL)`);
  L.push(`    • /get_transaction_log (${CCY})`);
  L.push(`    • /get_account_summary (${CCY})  /get_positions (future + option)`);
  L.push(HR);

  /* 0. DB context (this window spans disable/re-enable — not a single DB session row) */
  L.push('');
  L.push('  0.  DB CONTEXT  (reference only — PnL from fills/tx in window §3–§4)');
  L.push(hr);
  L.push(`  DB sessionStartedAt (latest enable): ${pair.sessionStartedAt || '(null)'}`);
  L.push(`  DB lastDisabledAt                  : ${pair.lastDisabledAt || '(null)'}`);
  L.push(`  DB sessionStartBalance             : ${pair.sessionStartBalance != null ? parseFloat(pair.sessionStartBalance).toFixed(6) : '(null)'}  (stamps latest enable only)`);
  const liveEq0 = parseFloat(currentEquity);
  L.push(`  Live equity now                    : ${liveEq0.toFixed(6)} ETH  (~$${(liveEq0 * ethIdx).toFixed(2)})`);
  L.push(`  Note: sessionStartBalance is NOT the start of this IST window; use §1 reconstructed equity for fill-based session view.`);
  L.push('');

  /* 1. equity */
  L.push('  1.  ACCOUNT EQUITY');
  L.push(hr);
  L.push(`  Start equity (reconstructed) : ${startEquity.toFixed(6)} ETH   (~$${(startEquity*ethIdx).toFixed(2)})`);
  L.push(`  Current equity               : ${currentEquity.toFixed(6)} ETH   (~$${(currentEquity*ethIdx).toFixed(2)})`);
  L.push(`  Current wallet balance       : ${currentBalance.toFixed(6)} ETH   (~$${(currentBalance*ethIdx).toFixed(2)})`);
  L.push(`  Margin balance               : ${summary.margin_balance.toFixed(6)} ETH`);
  L.push(`  Initial margin (open pos)    : ${summary.initial_margin.toFixed(6)} ETH`);
  L.push(`  Change this session          : ${sgn(sessionChangeEth)}${sessionChangeEth.toFixed(6)} ETH   (~$${(sessionChangeEth*ethIdx).toFixed(2)})`);
  L.push('');

  /* 2. volume */
  L.push('  2.  VOLUME  (sum of every fill.amount — USD notional)');
  L.push(hr);
  L.push(`  Total fills        : ${perpFills.length}   (${buyFills.length} buys / ${sellFills.length} sells)`);
  L.push(`  Total volume       : $${Math.round(volUsdTot).toLocaleString()}`);
  L.push(`    Buy volume       : $${Math.round(volUsdBuy).toLocaleString()}  (${buyFills.length} fills)`);
  L.push(`    Sell volume      : $${Math.round(volUsdSell).toLocaleString()}  (${sellFills.length} fills)`);
  L.push(`  Maker fills        : ${makerFills.length}  (${pct(makerFills.length, perpFills.length)})`);
  L.push(`  Taker fills        : ${takerFills.length}  (${pct(takerFills.length, perpFills.length)})`);
  L.push('');

  /* 3. pnl (fills) */
  L.push('  3.  P&L  (from fill.profit_loss — exchange authoritative)');
  L.push(hr);
  L.push(`  Realized PnL       : ${sgn(realizedEth)}${realizedEth.toFixed(6)} ETH   (~$${(realizedEth*ethIdx).toFixed(2)})`);
  if (openInfo) {
  L.push(`  Unrealized PnL     : ${sgn(openInfo.uPnl)}${openInfo.uPnl.toFixed(6)} ETH   (~$${(openInfo.uPnl*ethIdx).toFixed(2)})  [open ${openInfo.dir} $${Math.abs(openInfo.netUsd)} @ $${openInfo.avgPx.toFixed(2)}]`);
  L.push(`  Total PnL          : ${sgn(realizedEth+openInfo.uPnl)}${(realizedEth+openInfo.uPnl).toFixed(6)} ETH   (~$${((realizedEth+openInfo.uPnl)*ethIdx).toFixed(2)})`);
  }
  L.push(`  Net fees (sum)     : ${feeEthSum.toFixed(6)} ETH   (~$${(feeEthSum*ethIdx).toFixed(2)})`);
  L.push(`    Rebates earned   : +${rebatesEth.toFixed(6)} ETH   (~$${(rebatesEth*ethIdx).toFixed(2)})  [${makerFills.length} maker fills]`);
  L.push(`    Fees paid        : -${feesPaidEth.toFixed(6)} ETH   (~$${(feesPaidEth*ethIdx).toFixed(2)})  [${takerFills.length} taker fills]`);
  L.push(`    Net fee cost     : ${(feesPaidEth - rebatesEth).toFixed(6)} ETH`);
  L.push('');

  /* 4. transaction log corroboration */
  L.push('  4.  TRANSACTION LOG  (cross-check against fills)');
  L.push(hr);
  for (const [k,v] of Object.entries(txByType).sort((a,b)=>Math.abs(b[1].sumEth)-Math.abs(a[1].sumEth))) {
    L.push(`  ${k.padEnd(18)} ${String(v.count).padStart(5)} entries   ${sgn(v.sumEth)}${v.sumEth.toFixed(6)} ETH   (~$${(v.sumEth*ethIdx).toFixed(2)})`);
  }
  L.push('');

  /* 5. round-trips */
  const n = trips.length;
  L.push('  5.  ROUND-TRIPS  (net USD position returning to zero)');
  L.push(hr);
  L.push(`  Total round-trips  : ${n}`);
  L.push(`  Wins               : ${wins.length}   (${pct(wins.length, n)})   sum ${sgn(winsSum)}${winsSum.toFixed(6)} ETH ($${(winsSum*ethIdx).toFixed(2)})`);
  L.push(`  Losses             : ${losses.length}   (${pct(losses.length, n)})   sum ${sgn(lossesSum)}${lossesSum.toFixed(6)} ETH ($${(lossesSum*ethIdx).toFixed(2)})`);
  if (flats.length) L.push(`  Flats              : ${flats.length}`);
  L.push(`  Win rate           : ${pct(wins.length, n)}`);
  L.push(`  Loss rate          : ${pct(losses.length, n)}`);
  L.push(`  Avg hold           : ${n ? fmtDur(totalHold / n) : 'n/a'}`);
  if (wins.length)   L.push(`  Avg win            : +${(winsSum/wins.length).toFixed(6)} ETH   (~$${((winsSum/wins.length)*ethIdx).toFixed(2)})`);
  if (losses.length) L.push(`  Avg loss           : ${(lossesSum/losses.length).toFixed(6)} ETH   (~$${((lossesSum/losses.length)*ethIdx).toFixed(2)})`);
  if (bestTrip.pnl !== -Infinity)
  L.push(`  Best trip          : ${sgn(bestTrip.pnl)}${bestTrip.pnl.toFixed(6)} ETH ($${(bestTrip.pnl*ethIdx).toFixed(2)}) at ${fmtTs(bestTrip.startTs).slice(0,16)} ${bestTrip.dir} hold ${fmtDur(bestTrip.hold)}`);
  if (worstTrip.pnl !== Infinity)
  L.push(`  Worst trip         : ${sgn(worstTrip.pnl)}${worstTrip.pnl.toFixed(6)} ETH ($${(worstTrip.pnl*ethIdx).toFixed(2)}) at ${fmtTs(worstTrip.startTs).slice(0,16)} ${worstTrip.dir} hold ${fmtDur(worstTrip.hold)}`);
  L.push(`  Profit factor      : ${losses.length ? (Math.abs(winsSum/lossesSum)).toFixed(3) : 'n/a'}   (gross wins / gross losses)`);
  L.push(`  Expectancy / trip  : ${n ? `${(realizedEth/n).toFixed(6)} ETH (~$${((realizedEth/n) * ethIdx).toFixed(2)})` : 'n/a'}`);
  L.push('');

  /* 6. hold-time distribution */
  const holds = trips.map(t => t.hold).sort((a,b)=>a-b);
  const p = q => holds[Math.min(holds.length - 1, Math.max(0, Math.floor(holds.length * q)))];
  L.push('  6.  HOLD TIME DISTRIBUTION');
  L.push(hr);
  if (!holds.length) {
    L.push('  (no completed round-trips in this window)');
  } else {
    L.push(`  min  : ${fmtDur(holds[0])}`);
    L.push(`  p25  : ${fmtDur(p(0.25))}`);
    L.push(`  p50  : ${fmtDur(p(0.5))}`);
    L.push(`  p75  : ${fmtDur(p(0.75))}`);
    L.push(`  p90  : ${fmtDur(p(0.9))}`);
    L.push(`  max  : ${fmtDur(holds[holds.length - 1])}`);
  }
  L.push('');

  /* 7. direction bias */
  const longs  = trips.filter(t => t.dir === 'LONG');
  const shorts = trips.filter(t => t.dir === 'SHORT');
  const longsPnl  = longs.reduce((s,t)=>s+t.pnl,0);
  const shortsPnl = shorts.reduce((s,t)=>s+t.pnl,0);
  L.push('  7.  DIRECTION BIAS');
  L.push(hr);
  L.push(`  LONG trips   : ${longs.length}   wins ${longs.filter(t=>t.pnl>0).length}   PnL ${sgn(longsPnl)}${longsPnl.toFixed(6)} ETH  ($${(longsPnl*ethIdx).toFixed(2)})`);
  L.push(`  SHORT trips  : ${shorts.length}   wins ${shorts.filter(t=>t.pnl>0).length}   PnL ${sgn(shortsPnl)}${shortsPnl.toFixed(6)} ETH  ($${(shortsPnl*ethIdx).toFixed(2)})`);
  L.push('');

  /* 8. current open position (from /get_positions) */
  L.push('  8.  CURRENT OPEN POSITIONS  (from /get_positions)');
  L.push(hr);
  if (positions.length === 0) L.push('  FLAT — no open futures positions');
  for (const p of positions) {
    L.push(`  ${p.instrument_name}  size=${p.size}  avg=${p.average_price}  fpl=${(p.floating_profit_loss||0).toFixed(6)} ETH  direction=${p.direction}`);
  }
  L.push('');

  L.push('  9.  OPEN OPTIONS  (get_positions kind=option — context for equity Δ)');
  L.push(hr);
  if (!optPositions.length) L.push('  No open option positions (size 0 on all legs)');
  else {
    let sumF = 0;
    for (const p of optPositions) {
      const f = parseFloat(p.floating_profit_loss || 0);
      sumF += f;
      L.push(`  ${p.instrument_name}  size=${p.size}  avg=${p.average_price}  fpl=${f.toFixed(6)} ETH`);
    }
    L.push(`  Sum floating PnL (options)  : ${sumF.toFixed(6)} ETH  (~$${(sumF * ethIdx).toFixed(2)})`);
  }
  L.push('');

  L.push(HR);
  L.push(`  Generated : ${new Date().toUTCString()}`);
  L.push(HR);

  const report = L.join('\n');
  console.log('\n' + report + '\n');

  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'reports', `eth_pair26_ist_night_till_now_exchange_${ts}.txt`);
  fs.writeFileSync(out, report, 'utf8');
  console.log(`Saved: ${out}\n`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
