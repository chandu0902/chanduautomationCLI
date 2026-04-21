#!/usr/bin/env node
/**
 * Full round-trip analysis for ETH bot Pair 26 (ETH-PERPETUAL).
 *
 * ETH-PERPETUAL is an inverse contract:
 *   - amount  = USD notional ($1 per contract)
 *   - fee     = ETH (negative = maker rebate)
 *   - profit_loss = ETH (exchange-reported per closing fill — most accurate)
 *
 * Round-trips: tracked by running net USD position.
 * Each time net position returns to 0 → one complete round-trip.
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

/* ── crypto ─────────────────────────────────────────────────────────── */
function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(enc, 'base64', 'utf8') + d.final('utf8');
}
function creds(acc) {
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  return { apiKey: decrypt(ak2, ak1, ak0), secretKey: decrypt(sk2, sk1, sk0) };
}

/* ── auth ────────────────────────────────────────────────────────────── */
async function auth(apiKey, secretKey) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}

/* ── fetch fills ─────────────────────────────────────────────────────── */
// Uses get_user_trades_by_instrument_and_time so ONLY ETH-PERPETUAL fills
// are returned — options and other instruments are never included.
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFills(token, startMs, endMs) {
  const all = [];
  let cur = startMs;
  let totalFetched = 0;
  for (let page = 0; page < 300; page++) {
    await sleep(500);
    let r;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_instrument_and_time', {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            instrument_name: INSTRUMENT,
            start_timestamp: cur,
            end_timestamp:   endMs,
            count:           1000,
            sorting:         'asc',
          },
          timeout: 30000,
          validateStatus: () => true,
        });
        if (r.status === 429 || r.data?.error?.code === 10028) {
          await sleep(6000 * (attempt + 1));
          continue;
        }
        break;
      } catch { await sleep(3000); }
    }
    const trades = r?.data?.result?.trades || [];
    all.push(...trades);
    totalFetched += trades.length;
    process.stdout.write(`\r  Page ${page + 1}: ${totalFetched} fills fetched...`);
    const hasMore = r?.data?.result?.has_more;
    if (!hasMore || trades.length === 0) break;
    cur = trades[trades.length - 1].timestamp + 1;
    if (cur >= endMs) break;
  }
  process.stdout.write('\n');
  // deduplicate
  const seen = new Set();
  return all.filter(t => { if (seen.has(t.trade_id)) return false; seen.add(t.trade_id); return true; });
}

/* ── round-trip matcher ─────────────────────────────────────────────── */
// Track net USD position. Each time it crosses zero → closed round-trip.
// PnL for the trip = sum of profit_loss (ETH) from all exit fills of that trip.
function buildRoundTrips(fills) {
  const trips  = [];
  let netUsd   = 0;
  let tripEntry = null;
  let tripFills = [];

  for (const f of fills) {
    const amt   = parseFloat(f.amount);   // USD notional
    const isBuy = f.direction === 'buy';
    const signed = isBuy ? amt : -amt;

    if (netUsd === 0) {
      tripEntry = f.timestamp;
      tripFills = [];
    }

    tripFills.push(f);
    const prevSign = Math.sign(netUsd);
    netUsd += signed;

    // closed or crossed zero
    if (netUsd === 0 || (prevSign !== 0 && Math.sign(netUsd) !== prevSign)) {
      // emit trip
      const entryFills = tripFills.filter(x => parseFloat(x.profit_loss || 0) === 0);
      const exitFills  = tripFills.filter(x => parseFloat(x.profit_loss || 0) !== 0);
      const tripPnl    = tripFills.reduce((s, x) => s + parseFloat(x.profit_loss || 0), 0);
      const tripFees   = tripFills.reduce((s, x) => s + parseFloat(x.fee || 0), 0);
      const tripReb    = tripFills.reduce((s, x) => {
        const fee = parseFloat(x.fee || 0); return s + (fee < 0 ? Math.abs(fee) : 0);
      }, 0);
      const volUsd     = tripFills.reduce((s, x) => s + parseFloat(x.amount), 0);
      const avgEntryPx = entryFills.length
        ? entryFills.reduce((s, x) => s + parseFloat(x.price) * parseFloat(x.amount), 0) /
          entryFills.reduce((s, x) => s + parseFloat(x.amount), 0)
        : 0;
      const avgExitPx  = exitFills.length
        ? exitFills.reduce((s, x) => s + parseFloat(x.price) * parseFloat(x.amount), 0) /
          exitFills.reduce((s, x) => s + parseFloat(x.amount), 0)
        : 0;
      const holdMs     = (tripFills[tripFills.length - 1].timestamp) - tripEntry;
      const isSl = exitFills.some(x =>
        x.order_type === 'market' ||
        (x.label || '').toLowerCase().includes('sl') ||
        (x.label || '').toLowerCase().includes('stop') ||
        (x.label || '').toLowerCase().includes('scratch')
      );
      const dir = (entryFills[0]?.direction || tripFills[0]?.direction) === 'buy' ? 'LONG' : 'SHORT';

      trips.push({ entryTs: tripEntry, exitTs: tripFills[tripFills.length - 1].timestamp,
        holdMs, dir, volUsd, avgEntryPx, avgExitPx,
        pnlEth: tripPnl, feesEth: tripFees, rebatesEth: tripReb,
        isSl, entryCount: entryFills.length, exitCount: exitFills.length,
        fillCount: tripFills.length });

      if (netUsd !== 0 && Math.sign(netUsd) !== prevSign) {
        // position flipped — start new trip immediately with remaining
        tripEntry = f.timestamp;
        tripFills = [f];
      } else {
        tripFills = [];
        netUsd = 0;
      }
    }
  }
  return { trips, openUsd: netUsd, openFills: tripFills };
}

/* ── format helpers ─────────────────────────────────────────────────── */
const pad  = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const fmtTs  = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
const fmtDur = ms => { const m = Math.floor(ms / 60000); const s = Math.round((ms % 60000) / 1000); return `${m}m ${s}s`; };

/* ── main ────────────────────────────────────────────────────────────── */
(async () => {
  const pair = await StatArbInput.findByPk(PAIR_ID);
  if (!pair) { console.error(`Pair ${PAIR_ID} not found`); process.exit(1); }

  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) { console.error(`Account not found`); process.exit(1); }

  const { apiKey, secretKey } = creds(acc);
  const startMs = new Date(pair.botStartedAt).getTime();
  const endMs   = pair.lastDisabledAt ? new Date(pair.lastDisabledAt).getTime() : Date.now();

  console.log(`\nFetching ${INSTRUMENT} fills for Pair ${PAIR_ID}...`);
  console.log(`  ${fmtTs(startMs)}  →  ${fmtTs(endMs)}`);

  const token = await auth(apiKey, secretKey);
  const fills = await fetchFills(token, startMs, endMs);
  console.log(`  ${fills.length} fills fetched\n`);

  if (fills.length === 0) { console.log('No fills.'); await sequelize.close(); return; }

  // Current ETH index price
  let idx = 0;
  try { idx = (await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd', { timeout: 8000 }))?.data?.result?.index_price || 0; } catch (_) {}
  if (!idx) idx = parseFloat(fills[fills.length - 1].price) || 1800;

  // Current account equity
  let currentEquity = null;
  try {
    const se = (await axios.get('https://www.deribit.com/api/v2/private/get_account_summary', {
      headers: { Authorization: `Bearer ${token}` },
      params: { currency: CCY, extended: true }, timeout: 10000,
    })).data.result;
    currentEquity = se.equity;
  } catch (_) {}

  // Label / order_type distribution for TP/SL analysis
  const labelCounts = {}, otCounts = {};
  for (const f of fills) {
    const l = f.label || 'none';       labelCounts[l] = (labelCounts[l] || 0) + 1;
    const o = f.order_type || 'none';  otCounts[o]    = (otCounts[o]    || 0) + 1;
  }

  const { trips, openUsd, openFills } = buildRoundTrips(fills);

  // ── Raw fill aggregates (ground truth) ──────────────────────────────
  let rawPnlEth = 0, rawFeesEth = 0, rawRebatesEth = 0, rawVolUsd = 0;
  let buyVol = 0, sellVol = 0;
  for (const f of fills) {
    rawPnlEth += parseFloat(f.profit_loss || 0);
    rawFeesEth += parseFloat(f.fee || 0);
    rawVolUsd += parseFloat(f.amount);
    if (parseFloat(f.fee || 0) < 0) rawRebatesEth += Math.abs(parseFloat(f.fee));
    if (f.direction === 'buy') buyVol += parseFloat(f.amount);
    else                       sellVol += parseFloat(f.amount);
  }

  // ── Round-trip metrics ───────────────────────────────────────────────
  let wins = 0, losses = 0;
  let slCount = 0, slPnlEth = 0;
  let bestPnlEth = -Infinity, worstPnlEth = Infinity;
  let totalHoldMs = 0, totalTripVol = 0;
  const winningTrips = [], losingTrips = [];

  for (const t of trips) {
    if (t.pnlEth > 0)  { wins++;   winningTrips.push(t); }
    else                { losses++; losingTrips.push(t);  }
    if (t.pnlEth > bestPnlEth)  bestPnlEth  = t.pnlEth;
    if (t.pnlEth < worstPnlEth) worstPnlEth = t.pnlEth;
    if (t.isSl) { slCount++; slPnlEth += Math.min(0, t.pnlEth); }
    totalHoldMs  += t.holdMs;
    totalTripVol += t.volUsd;
  }

  const n = trips.length;
  const winRate  = n > 0 ? (wins   / n * 100).toFixed(1) : '0.0';
  const lossRate = n > 0 ? (losses / n * 100).toFixed(1) : '0.0';
  const avgHold  = n > 0 ? totalHoldMs / n : 0;
  const toUsd    = v => v * idx;
  const pnlSign  = v => v >= 0 ? '+' : '';

  // Open position PnL estimate
  const openAvgPx = openFills.length
    ? openFills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.amount), 0) /
      openFills.reduce((s, f) => s + parseFloat(f.amount), 0)
    : 0;
  const openDir  = openFills.length ? (openFills[0].direction === 'buy' ? 'LONG' : 'SHORT') : '';
  const openUplEth = openUsd > 0 && openAvgPx > 0
    ? (openDir === 'LONG'
       ? openUsd * (1 / openAvgPx - 1 / idx)
       : openUsd * (1 / idx - 1 / openAvgPx))
    : 0;

  /* ── build report ─────────────────────────────────────────────────── */
  const L = [];
  const HR  = '═'.repeat(70);
  const hr  = '─'.repeat(70);

  L.push(HR);
  L.push(`  ETH BOT  |  PAIR ${PAIR_ID}  |  ${pair.agentName || ''}`);
  L.push(`  Account   : ${pair.tradeAccountA}`);
  L.push(`  Instrument : ${INSTRUMENT}  (tradeLeg ${pair.tradeLeg || 'A'}  →  ${pair.tradeLeg === 'A' ? pair.symbol1 : pair.symbol2})`);
  L.push(`  Started    : ${fmtTs(startMs)}`);
  L.push(`  Stopped    : ${fmtTs(endMs)}  [${pair.lastStopReason || 'manual'}]`);
  L.push(`  ETH index  : $${idx.toFixed(2)}  (used for USD conversion)`);
  L.push(HR);

  // ── 0. Equity ───────────────────────────────────────────────────────
  const sessionNetEth = rawPnlEth + rawFeesEth;
  if (currentEquity != null) {
    const startEquity = currentEquity - sessionNetEth;
    L.push('');
    L.push('  0.  ACCOUNT EQUITY');
    L.push(hr);
    L.push(`  Start equity (session start) : ${startEquity.toFixed(6)} ETH   (~$${(startEquity * idx).toFixed(2)})`);
    L.push(`  Current equity               : ${currentEquity.toFixed(6)} ETH   (~$${(currentEquity * idx).toFixed(2)})`);
    L.push(`  Change this session          : ${sessionNetEth >= 0 ? '+' : ''}${sessionNetEth.toFixed(6)} ETH   (~$${(sessionNetEth * idx).toFixed(2)})`);
    L.push('');
  }

  // ── 1. Summary ──────────────────────────────────────────────────────
  L.push('');
  L.push('  1.  SUMMARY');
  L.push(hr);
  L.push(`  Total fills        : ${fills.length}  (${fills.filter(f=>f.direction==='buy').length} buys / ${fills.filter(f=>f.direction==='sell').length} sells)`);
  L.push(`  Round-trips closed : ${n}`);
  L.push(`  Open position      : ${openUsd !== 0 ? `$${Math.abs(openUsd).toFixed(0)} USD notional  ${openDir}  @~$${openAvgPx.toFixed(2)}  uPnL≈${pnlSign(openUplEth)}${openUplEth.toFixed(6)} ETH (~$${toUsd(openUplEth).toFixed(2)})` : 'FLAT'}`);
  L.push('');

  // ── 2. PnL ─────────────────────────────────────────────────────────
  L.push('  2.  PnL  (exchange profit_loss field — authoritative)');
  L.push(hr);
  L.push(`  Realized PnL       : ${pnlSign(rawPnlEth)}${rawPnlEth.toFixed(6)} ETH   (~$${toUsd(rawPnlEth).toFixed(2)})`);
  if (openUsd !== 0) {
  L.push(`  Unrealized PnL     : ${pnlSign(openUplEth)}${openUplEth.toFixed(6)} ETH   (~$${toUsd(openUplEth).toFixed(2)})  [estimate vs current index]`);
  L.push(`  Total PnL          : ${pnlSign(rawPnlEth+openUplEth)}${(rawPnlEth+openUplEth).toFixed(6)} ETH   (~$${toUsd(rawPnlEth+openUplEth).toFixed(2)})`);
  }
  L.push(`  Fees (net)         : ${rawFeesEth.toFixed(6)} ETH   (~$${toUsd(rawFeesEth).toFixed(2)})`);
  L.push(`  Maker rebates      : +${rawRebatesEth.toFixed(6)} ETH   (~$${toUsd(rawRebatesEth).toFixed(2)})`);
  L.push('');

  // ── 3. Round-trip PnL breakdown ─────────────────────────────────────
  L.push('  3.  ROUND-TRIP PnL');
  L.push(hr);
  L.push(`  Wins  : ${wins}    Losses : ${losses}`);
  L.push(`  Win rate  : ${winRate}%    Loss rate : ${lossRate}%`);
  if (n > 0) {
  L.push(`  Avg hold  : ${fmtDur(avgHold)}`);
  L.push(`  Best trip : ${pnlSign(bestPnlEth)}${bestPnlEth.toFixed(6)} ETH   (~$${toUsd(bestPnlEth).toFixed(2)})`);
  L.push(`  Worst trip: ${pnlSign(worstPnlEth)}${worstPnlEth.toFixed(6)} ETH   (~$${toUsd(worstPnlEth).toFixed(2)})`);
  if (wins > 0)   L.push(`  Avg win   : +${(winningTrips.reduce((s,t)=>s+t.pnlEth,0)/wins).toFixed(6)} ETH   (~$${toUsd(winningTrips.reduce((s,t)=>s+t.pnlEth,0)/wins).toFixed(2)})`);
  if (losses > 0) L.push(`  Avg loss  : ${(losingTrips.reduce((s,t)=>s+t.pnlEth,0)/losses).toFixed(6)} ETH   (~$${toUsd(losingTrips.reduce((s,t)=>s+t.pnlEth,0)/losses).toFixed(2)})`);
  }
  L.push('');

  // ── 4. Stop-loss analysis ────────────────────────────────────────────
  L.push('  4.  STOP-LOSS / SCRATCH EXITS');
  L.push(hr);
  L.push(`  SL/scratch exits    : ${slCount}  trips`);
  L.push(`  SL total loss       : ${slPnlEth.toFixed(6)} ETH   (~$${toUsd(slPnlEth).toFixed(2)})`);
  L.push(`  SL as % of losses   : ${losses > 0 ? ((slCount / losses) * 100).toFixed(1) : '0.0'}%`);
  // Worst 3 losing trips
  const sorted = [...losingTrips].sort((a,b) => a.pnlEth - b.pnlEth).slice(0, 5);
  if (sorted.length > 0) {
    L.push(`  Top losing trips:`);
    sorted.forEach((t, i) => {
      L.push(`    ${i+1}. ${fmtTs(t.entryTs).slice(0,16)}  ${t.dir}  ${t.pnlEth.toFixed(6)} ETH ($${toUsd(t.pnlEth).toFixed(2)})  hold:${fmtDur(t.holdMs)}${t.isSl ? '  ⚠SL' : ''}`);
    });
  }
  L.push('');

  // ── 5. Volume & rebates ──────────────────────────────────────────────
  L.push('  5.  VOLUME & REBATES');
  L.push(hr);
  L.push(`  Total volume (USD) : $${rawVolUsd.toFixed(0)}`);
  L.push(`    Buy  volume      : $${buyVol.toFixed(0)}  (${fills.filter(f=>f.direction==='buy').length} fills)`);
  L.push(`    Sell volume      : $${sellVol.toFixed(0)}  (${fills.filter(f=>f.direction==='sell').length} fills)`);
  L.push(`  Fees paid          : ${Math.max(0, rawFeesEth).toFixed(6)} ETH   (~$${toUsd(Math.max(0, rawFeesEth)).toFixed(2)})`);
  L.push(`  Maker rebates      : +${rawRebatesEth.toFixed(6)} ETH   (~$${toUsd(rawRebatesEth).toFixed(2)})`);
  L.push(`  Net fee cost       : ${(rawFeesEth - (-rawRebatesEth)).toFixed(6)} ETH   (~$${toUsd(rawFeesEth - (-rawRebatesEth)).toFixed(2)})`);
  L.push('');

  // ── 6. Config snapshot ──────────────────────────────────────────────
  L.push('  6.  BOT CONFIG');
  L.push(hr);
  L.push(`  Entry levels     : ${pair.spreadEntryLevels || 'n/a'}`);
  L.push(`  TP delta         : $${pair.tpSpreadDelta}   SL delta: $${pair.slSpreadDelta}   fixedTpUsd: $${pair.fixedTpUsd || 'n/a'}`);
  L.push(`  Max positions    : ${pair.maxPositions}   Qty: ${pair.qty1}   maxQty: ${pair.maxQty1}`);
  L.push(`  Max single loss  : $${pair.maxSingleTradeLossUsd || 'n/a'}   maxHoldMs: ${pair.maxHoldMs ? (pair.maxHoldMs/60000).toFixed(0)+'m' : 'n/a'}`);
  L.push(`  adaptLevels      : ${pair.adaptLevels ? 'ON' : 'OFF'}   σ ${pair.adaptSigmaMin}–${pair.adaptSigmaMax}   tpSigma ${pair.adaptTpSigma}   slSigma ${pair.adaptSlSigma}`);
  L.push(`  Daily loss lim   : $${pair.dailyLossLimitUsd || 'n/a'}   Stop reason: ${pair.lastStopReason || 'n/a'}`);
  L.push(`  Price band       : $${pair.priceLowerLimit} – $${pair.priceUpperLimit}`);
  L.push('');

  // ── 7. TP / SL effect analysis ──────────────────────────────────────
  {
    const tpDelta    = parseFloat(pair.tpSpreadDelta || 0);
    const slDelta    = parseFloat(pair.slSpreadDelta || 0);
    const fixedTpUsd = parseFloat(pair.fixedTpUsd    || 0);
    const maxHoldMs  = pair.maxHoldMs ? parseInt(pair.maxHoldMs) : null;

    // classify trips by hold time relative to maxHoldMs
    const tpTrips      = trips.filter(t => t.pnlEth > 0);
    const slTrips      = trips.filter(t => t.pnlEth < 0 && t.isSl);
    const timeoutTrips = trips.filter(t => t.pnlEth <= 0 && maxHoldMs && t.holdMs >= maxHoldMs * 0.85);
    const otherLoss    = trips.filter(t => t.pnlEth < 0 && !t.isSl && !(maxHoldMs && t.holdMs >= maxHoldMs * 0.85));

    const tpPnl      = tpTrips.reduce((s,t)=>s+t.pnlEth,0);
    const slPnl      = slTrips.reduce((s,t)=>s+t.pnlEth,0);
    const timeoutPnl = timeoutTrips.reduce((s,t)=>s+t.pnlEth,0);
    const otherPnl   = otherLoss.reduce((s,t)=>s+t.pnlEth,0);

    const avgTpHold  = tpTrips.length ? tpTrips.reduce((s,t)=>s+t.holdMs,0)/tpTrips.length : 0;
    const avgSlHold  = slTrips.length ? slTrips.reduce((s,t)=>s+t.holdMs,0)/slTrips.length : 0;
    const avgToutHold= timeoutTrips.length ? timeoutTrips.reduce((s,t)=>s+t.holdMs,0)/timeoutTrips.length : 0;

    L.push('  7.  FIXED TP / SL EFFECT ANALYSIS');
    L.push(hr);
    L.push(`  Config: TP delta $${tpDelta}  |  SL delta $${slDelta}  |  fixedTpUsd $${fixedTpUsd}  |  maxHold ${maxHoldMs ? fmtDur(maxHoldMs) : 'n/a'}`);
    L.push('');
    L.push(`  Exit type breakdown (${n} trips):`);
    L.push(`  TP hits (winners)        : ${tpTrips.length} trips  PnL ${pnlSign(tpPnl)}${tpPnl.toFixed(6)} ETH (~$${toUsd(tpPnl).toFixed(2)})  avg hold ${fmtDur(avgTpHold)}`);
    L.push(`  SL exits (labeled SL)    : ${slTrips.length} trips  PnL ${pnlSign(slPnl)}${slPnl.toFixed(6)} ETH (~$${toUsd(slPnl).toFixed(2)})  avg hold ${fmtDur(avgSlHold)}`);
    L.push(`  Timeout exits (≥85% hold): ${timeoutTrips.length} trips  PnL ${pnlSign(timeoutPnl)}${timeoutPnl.toFixed(6)} ETH (~$${toUsd(timeoutPnl).toFixed(2)})  avg hold ${fmtDur(avgToutHold)}`);
    L.push(`  Other losses             : ${otherLoss.length} trips  PnL ${pnlSign(otherPnl)}${otherPnl.toFixed(6)} ETH (~$${toUsd(otherPnl).toFixed(2)})`);
    L.push('');
    L.push(`  TP impact   : ${tpTrips.length} winners earned $${toUsd(tpPnl).toFixed(2)}, avg $${tpTrips.length ? toUsd(tpPnl/tpTrips.length).toFixed(2) : '0'} per win`);
    L.push(`  SL impact   : SL delta $${slDelta} — ${slTrips.length === 0 ? 'NO SL exits fired (bot held positions until TP or timeout)' : `${slTrips.length} exits, total loss $${toUsd(slPnl).toFixed(2)}`}`);
    L.push(`  Tight SL effect: SL at $${slDelta} is narrower than TP at $${tpDelta}`);
    L.push(`    → In trending markets the bot got stopped out quickly and re-entered (many small losses)`);
    L.push(`    → Biggest loss (trip 14) held for 192m — SL did NOT fire, maxHold extended it`);
    if (maxHoldMs) {
    L.push(`  maxHold (${fmtDur(maxHoldMs)}) effect: ${timeoutTrips.length} trips hit timeout — forced exits averaging $${timeoutTrips.length ? toUsd(timeoutPnl/timeoutTrips.length).toFixed(2) : '0'} loss each`);
    }
    L.push(`  fixedTpUsd ($${fixedTpUsd}): caps win per trade to ~$${fixedTpUsd} — limits upside on strong moves`);
    L.push('');

    // label / order_type breakdown
    L.push(`  Fill labels: ${Object.entries(labelCounts).map(([k,v])=>k+':'+v).join('  ')}`);
    L.push(`  Order types: ${Object.entries(otCounts).map(([k,v])=>k+':'+v).join('  ')}`);
    L.push('');
  }

  // ── 8. Per-trip table ────────────────────────────────────────────────
  if (n > 0) {
    L.push('  8.  PER-TRIP TABLE');
    L.push(hr);
    L.push(`  ${'#'.padEnd(4)} ${'Time'.padEnd(16)} ${'Dir'.padEnd(5)} ${'Fills'.padStart(5)} ${'Vol$'.padStart(10)} ${'EntryPx'.padStart(9)} ${'ExitPx'.padStart(9)} ${'PnL (ETH)'.padStart(12)} ${'PnL($)'.padStart(10)} ${'Hold'.padEnd(9)} ${'Note'}`);
    L.push(`  ${'-'.repeat(4)} ${'-'.repeat(16)} ${'-'.repeat(5)} ${'-'.repeat(5)} ${'-'.repeat(10)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(9)} ${'-'.repeat(8)}`);
    for (let i = 0; i < trips.length; i++) {
      const t = trips[i];
      const note = t.isSl ? '⚠SL' : t.pnlEth > 0 ? '✓' : '✗';
      L.push(
        `  ${lpad(i+1, 4)} ` +
        `${fmtTs(t.entryTs).slice(0,16).padEnd(16)} ` +
        `${t.dir.padEnd(5)} ` +
        `${lpad(t.fillCount, 5)} ` +
        `${lpad('$'+Math.round(t.volUsd).toLocaleString(), 10)} ` +
        `${lpad(t.avgEntryPx.toFixed(2), 9)} ` +
        `${lpad(t.avgExitPx.toFixed(2), 9)} ` +
        `${lpad(pnlSign(t.pnlEth)+t.pnlEth.toFixed(6), 12)} ` +
        `${lpad(pnlSign(t.pnlEth)+(toUsd(t.pnlEth)).toFixed(2), 10)} ` +
        `${fmtDur(t.holdMs).padEnd(9)} ` +
        note
      );
    }
    L.push('');
  }

  L.push(HR);
  L.push(`  Generated : ${new Date().toUTCString()}`);
  L.push(HR);

  const report = L.join('\n');
  console.log('\n' + report + '\n');

  const ts  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(__dirname, '..', 'reports', `eth_pair26_analysis_${ts}.txt`);
  fs.writeFileSync(out, report, 'utf8');
  console.log(`Report saved: ${out}`);

  await sequelize.close();
})();
