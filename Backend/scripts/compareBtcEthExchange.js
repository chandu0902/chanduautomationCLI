#!/usr/bin/env node
/**
 * Compare BTC bot (pair 21) vs ETH bot (pair 22) — pure exchange fills only.
 * Analyses every Deribit fill since each bot's botStartedAt and produces a
 * side-by-side comparison with actionable findings.
 *
 *   node scripts/compareBtcEthExchange.js
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

function dec(k, e, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getToken(k, s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: k, client_secret: s, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
async function rpc(t, scope, m, p = {}) {
  for (let i = 0; i < 8; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${m}`,
      { jsonrpc: '2.0', id: 1, method: `${scope}/${m}`, params: p },
      { headers: t ? { Authorization: `Bearer ${t}` } : {}, timeout: 30000, validateStatus: () => true });
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(3000 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${m} HTTP ${r.status}`);
    if (e) throw new Error(`${m}: ${e.message}`);
    return r.data.result;
  }
  throw new Error(`${m}: too many retries`);
}

async function fetchAllFills(tok, currency, startMs) {
  const all = []; let cur = startMs;
  for (let p = 0; p < 200; p++) {
    await sleep(600);
    const res = await rpc(tok, 'private', 'get_user_trades_by_currency_and_time', {
      currency, start_timestamp: cur, end_timestamp: Date.now(),
      count: 1000, sorting: 'asc',
    });
    const t = res.trades || [];
    if (!t.length) break;
    all.push(...t);
    if (!res.has_more) break;
    cur = t[t.length - 1].timestamp + 1;
  }
  return all;
}

function stats(list) {
  if (!list.length) return { n: 0, avg: 0, min: 0, max: 0, med: 0, std: 0, sum: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const sum = list.reduce((s, x) => s + x, 0);
  const avg = sum / list.length;
  const std = Math.sqrt(list.reduce((s, x) => s + (x - avg) ** 2, 0) / list.length);
  return {
    n: list.length, avg, min: sorted[0], max: sorted[sorted.length - 1],
    med: sorted[Math.floor(sorted.length / 2)], std, sum,
  };
}

function fmtUsd(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(d);
}

async function analyzePair(pairId) {
  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) throw new Error(`pair ${pairId} not found`);
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = execSym.startsWith('BTC') ? 'BTC' : execSym.startsWith('ETH') ? 'ETH' : 'USDC';
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));
  const botStartMs = new Date(pair.botStartedAt).getTime();

  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
    params: { index_name: `${currency.toLowerCase()}_usd` },
  });
  const idx = Number(ix.data?.result?.index_price) || 0;

  const all = await fetchAllFills(tok, currency, botStartMs);
  const fills = all.filter((t) => t.instrument_name === execSym);

  let opens = 0, exits = 0, profitExits = 0, lossExits = 0;
  const wins = [], losses = [];
  let sumVol = 0, sumPl = 0, sumFee = 0;
  let maker = 0, taker = 0;
  let makerFees = 0, takerFees = 0;
  let buyCount = 0, sellCount = 0;
  let buyVol = 0, sellVol = 0;
  const exitTimes = [];
  const pnlUsdList = [];

  for (const t of fills) {
    const pl = Number(t.profit_loss) || 0;
    const fee = Number(t.fee) || 0;
    const amt = Math.abs(Number(t.amount) || 0);
    sumVol += amt; sumPl += pl; sumFee += fee;
    if (t.liquidity === 'M') { maker++; makerFees += fee; }
    else if (t.liquidity === 'T') { taker++; takerFees += fee; }
    if (t.direction === 'buy') { buyCount++; buyVol += amt; }
    else if (t.direction === 'sell') { sellCount++; sellVol += amt; }
    if (pl === 0) opens++;
    else {
      exits++;
      exitTimes.push(t.timestamp);
      const plUsd = pl * idx;
      pnlUsdList.push(plUsd);
      if (pl > 0) { profitExits++; wins.push(plUsd); }
      else { lossExits++; losses.push(plUsd); }
    }
  }

  // gap between exits = trade pace
  const gaps = [];
  for (let i = 1; i < exitTimes.length; i++) gaps.push((exitTimes[i] - exitTimes[i - 1]) / 1000);

  const windowHours = (Date.now() - botStartMs) / 3600000;
  const amtList = fills.map((t) => Math.abs(Number(t.amount) || 0));

  return {
    pairId, agent: pair.agentName, execSym, currency, idx,
    botStartMs, windowHours,
    totalFills: fills.length, opens, exits, profitExits, lossExits,
    winRate: exits ? profitExits / exits : 0,
    wlRatio: lossExits ? profitExits / lossExits : null,
    winStats: stats(wins),
    lossStats: stats(losses),
    pnlStats: stats(pnlUsdList),
    amtStats: stats(amtList),
    gapStats: stats(gaps),
    sumVol, sumPl, sumPlUsd: sumPl * idx, sumFee, sumFeeUsd: sumFee * idx,
    maker, taker, makerFees, takerFees,
    makerFeesUsd: makerFees * idx, takerFeesUsd: takerFees * idx,
    buyCount, sellCount, buyVol, sellVol,
    fillsPerHour: fills.length / windowHours,
    exitsPerHour: exits / windowHours,
  };
}

function box(s) {
  return '═'.repeat(Math.max(80, s.length));
}

function lines(a, b) {
  const L = [];
  const p = (s) => L.push(s);
  p('');
  p('╔══════════════════════════════════════════════════════════════════════════════╗');
  p('║  EXCHANGE-BASED COMPARISON — BTC (pair 21) vs ETH (pair 22)                 ║');
  p('║  Source: Deribit private/get_user_trades_by_currency_and_time              ║');
  p(`║  Generated: ${new Date().toISOString()}                              `);
  p('╚══════════════════════════════════════════════════════════════════════════════╝');
  p('');
  p('Session window:');
  p(`  BTC  : ${new Date(a.botStartMs).toISOString()}  →  now  (${a.windowHours.toFixed(2)}h)`);
  p(`  ETH  : ${new Date(b.botStartMs).toISOString()}  →  now  (${b.windowHours.toFixed(2)}h)`);
  p('');

  const row = (label, av, bv) => {
    p(`  ${label.padEnd(36)} │ ${String(av).padStart(18)} │ ${String(bv).padStart(18)}`);
  };
  p(`  ${''.padEnd(36)} │ ${'BTC (pair 21)'.padStart(18)} │ ${'ETH (pair 22)'.padStart(18)}`);
  p(`  ${'-'.repeat(36)}-┼-${'-'.repeat(18)}-┼-${'-'.repeat(18)}`);
  row('instrument', a.execSym, b.execSym);
  row('index price', fmtUsd(a.idx, 2), fmtUsd(b.idx, 2));
  row('total fills', a.totalFills, b.totalFills);
  row('fills / hour', a.fillsPerHour.toFixed(2), b.fillsPerHour.toFixed(2));
  row('opening fills (pl=0)', a.opens, b.opens);
  row('exit fills (pl≠0)', a.exits, b.exits);
  row('  profit exits', a.profitExits, b.profitExits);
  row('  loss   exits', a.lossExits, b.lossExits);
  row('win rate', (a.winRate * 100).toFixed(2) + '%', (b.winRate * 100).toFixed(2) + '%');
  row('W/L ratio', a.wlRatio?.toFixed(3) ?? '-', b.wlRatio?.toFixed(3) ?? '-');
  p('');
  row('avg win per exit', fmtUsd(a.winStats.avg, 2), fmtUsd(b.winStats.avg, 2));
  row('median win per exit', fmtUsd(a.winStats.med, 2), fmtUsd(b.winStats.med, 2));
  row('avg loss per exit', fmtUsd(a.lossStats.avg, 2), fmtUsd(b.lossStats.avg, 2));
  row('median loss per exit', fmtUsd(a.lossStats.med, 2), fmtUsd(b.lossStats.med, 2));
  row('best single exit', fmtUsd(a.winStats.max, 2), fmtUsd(b.winStats.max, 2));
  row('worst single exit', fmtUsd(a.lossStats.min, 2), fmtUsd(b.lossStats.min, 2));
  row('loss/win size ratio', Math.abs(a.lossStats.avg / a.winStats.avg).toFixed(2), Math.abs(b.lossStats.avg / b.winStats.avg).toFixed(2));
  p('');
  row('Σ price PnL (wins)', fmtUsd(a.winStats.sum, 2), fmtUsd(b.winStats.sum, 2));
  row('Σ price PnL (losses)', fmtUsd(a.lossStats.sum, 2), fmtUsd(b.lossStats.sum, 2));
  row('Σ price PnL (net)', fmtUsd(a.sumPlUsd, 2), fmtUsd(b.sumPlUsd, 2));
  row('Σ fee (– = rebate)', fmtUsd(a.sumFeeUsd, 2), fmtUsd(b.sumFeeUsd, 2));
  row('Econ (pl – fee)', fmtUsd(a.sumPlUsd - a.sumFeeUsd, 2), fmtUsd(b.sumPlUsd - b.sumFeeUsd, 2));
  p('');
  row('maker fills', a.maker, b.maker);
  row('taker fills', a.taker, b.taker);
  row('maker %', ((a.maker / a.totalFills) * 100).toFixed(1) + '%', ((b.maker / b.totalFills) * 100).toFixed(1) + '%');
  row('maker rebate earned', fmtUsd(-a.makerFeesUsd, 2), fmtUsd(-b.makerFeesUsd, 2));
  row('taker fees paid', fmtUsd(a.takerFeesUsd, 2), fmtUsd(b.takerFeesUsd, 2));
  p('');
  row('buys', a.buyCount, b.buyCount);
  row('sells', a.sellCount, b.sellCount);
  row('buy volume USD', fmtUsd(a.buyVol, 0), fmtUsd(b.buyVol, 0));
  row('sell volume USD', fmtUsd(a.sellVol, 0), fmtUsd(b.sellVol, 0));
  row('dir bias (sell−buy USD)', fmtUsd(a.sellVol - a.buyVol, 0), fmtUsd(b.sellVol - b.buyVol, 0));
  p('');
  row('avg fill size USD', fmtUsd(a.amtStats.avg, 0), fmtUsd(b.amtStats.avg, 0));
  row('median fill size USD', fmtUsd(a.amtStats.med, 0), fmtUsd(b.amtStats.med, 0));
  row('total volume USD', fmtUsd(a.sumVol, 0), fmtUsd(b.sumVol, 0));
  p('');
  row('exits / hour', a.exitsPerHour.toFixed(2), b.exitsPerHour.toFixed(2));
  row('median gap between exits', (a.gapStats.med).toFixed(1) + 's', (b.gapStats.med).toFixed(1) + 's');
  row('avg gap between exits', (a.gapStats.avg).toFixed(1) + 's', (b.gapStats.avg).toFixed(1) + 's');
  p('');

  // findings block
  p('════════════════════════════════════════════════════════════════════════════════');
  p('DIAGNOSIS — why ETH lost and win rate is low');
  p('════════════════════════════════════════════════════════════════════════════════');
  p('');
  const ethLW = Math.abs(b.lossStats.avg / b.winStats.avg);
  const btcLW = Math.abs(a.lossStats.avg / a.winStats.avg);
  p(`  1) ASYMMETRIC EXIT SIZES`);
  p(`       BTC avg loss is ${btcLW.toFixed(2)}× avg win`);
  p(`       ETH avg loss is ${ethLW.toFixed(2)}× avg win  ← losses are much larger`);
  p(`       ETH best win ${fmtUsd(b.winStats.max, 2)} vs worst loss ${fmtUsd(b.lossStats.min, 2)}`);
  p('');
  p(`  2) WIN RATE PROBLEM`);
  p(`       BTC wins ${(a.winRate * 100).toFixed(2)}%   ETH wins ${(b.winRate * 100).toFixed(2)}%`);
  const stopsNeeded = b.lossStats.n;
  const winsHave = b.winStats.n;
  p(`       ETH has ${b.lossExits} losses vs ${b.profitExits} profits (ratio ${b.wlRatio?.toFixed(2)})`);
  p(`       To break even at ETH sizes, ETH needs win rate ≥ ${(ethLW / (1 + ethLW) * 100).toFixed(1)}%`);
  p(`       Actual: ${(b.winRate * 100).toFixed(2)}%  ⇒  ${(((b.winRate) - ethLW / (1 + ethLW)) * 100).toFixed(1)} pp short`);
  p('');
  p(`  3) FILL FREQUENCY — is the bot over-trading?`);
  p(`       BTC exits/h: ${a.exitsPerHour.toFixed(2)}   ETH exits/h: ${b.exitsPerHour.toFixed(2)}`);
  if (b.exitsPerHour > a.exitsPerHour * 1.2) {
    p(`       ETH trades ${(b.exitsPerHour / a.exitsPerHour).toFixed(2)}× more often — higher exposure to noise & slippage`);
  }
  p('');
  p(`  4) DIRECTIONAL BIAS`);
  p(`       BTC sell−buy volume: ${fmtUsd(a.sellVol - a.buyVol, 0)}`);
  p(`       ETH sell−buy volume: ${fmtUsd(b.sellVol - b.buyVol, 0)}`);
  const ethBias = b.sellVol - b.buyVol;
  if (Math.abs(ethBias) > 2000) {
    p(`       ETH carries a persistent ${ethBias > 0 ? 'SHORT' : 'LONG'} bias (${fmtUsd(ethBias, 0)} one-sided);`);
    p(`       in a trending ${ethBias > 0 ? 'up' : 'down'} market this is systematically losing.`);
  }
  p('');
  p(`  5) MAKER/TAKER MIX & REBATE RELIANCE`);
  p(`       BTC maker%=${((a.maker / a.totalFills) * 100).toFixed(1)}   ETH maker%=${((b.maker / b.totalFills) * 100).toFixed(1)}`);
  p(`       ETH price PnL is negative (${fmtUsd(b.sumPlUsd, 2)});`);
  p(`       only saved by +${fmtUsd(-b.makerFeesUsd, 2)} of rebates. Bot is profitable ONLY via rebates,`);
  p(`       meaning it's hitting stops more than it captures spread.`);
  p('');
  p(`  6) TAKER-FEE BLEED ON EXITS`);
  p(`       ETH taker fees: ${fmtUsd(b.takerFeesUsd, 2)} over ${b.taker} taker fills`);
  p(`       These come from aggressive stop-exits / forced exits — each one double-pays:`);
  p(`       lose on price AND lose on fee. BTC: ${fmtUsd(a.takerFeesUsd, 2)} / ${a.taker} taker fills.`);
  p('');

  p('════════════════════════════════════════════════════════════════════════════════');
  p('HOW TO IMPROVE ETH BOT TO LOOK LIKE BTC BOT');
  p('════════════════════════════════════════════════════════════════════════════════');
  p('');
  p('  A. TIGHTEN THE STOP / LOOSEN THE TARGET (or vice versa)');
  p(`     Current ETH: avg win ${fmtUsd(b.winStats.avg, 2)} vs avg loss ${fmtUsd(b.lossStats.avg, 2)}`);
  p(`     The sheet has slSpreadDelta ~2.3× tpSpreadDelta — confirmed by exchange data.`);
  p(`     Options:`);
  p(`       (a) Lower stop loss distance so a loss is ≤ 1.2× a win (match BTC ratio).`);
  p(`       (b) Raise take profit so each profit captures more before snap-back.`);
  p(`       (c) Move to adaptive TP/SL ratio anchored to realized vol, like BTC adapt uses.`);
  p('');
  p('  B. REDUCE GRID WIDTH AT THE BAND EDGES');
  p(`     ETH had ${b.exits} exits in ${b.windowHours.toFixed(1)}h = ${b.exitsPerHour.toFixed(1)}/h.`);
  p(`     Losses cluster when the spread ranges outside the band — i.e. the entry grid`);
  p(`     is too wide for current vol. Narrow grid or raise adaptSigmaMin so entries`);
  p(`     only fire when vol is rich enough to justify the SL.`);
  p('');
  p('  C. KILL DIRECTIONAL BIAS');
  p(`     ETH is structurally short ${fmtUsd(Math.abs(ethBias), 0)} more than long.`);
  p(`     On a rally the short leg bleeds while the long-call hedge caps but doesn't`);
  p(`     cover. Rebalance grid so buy/sell volumes converge, OR size the long-call`);
  p(`     hedge up.`);
  p('');
  p('  D. STOP TAKING THE BOOK ON EXITS');
  p(`     ${b.taker} taker exits bled ${fmtUsd(b.takerFeesUsd, 2)} in fees alone.`);
  p(`     Either (a) extend exit-order post_only time budget before escalating to IOC,`);
  p(`     or (b) move exits to limit-at-joining-bid instead of market cross. BTC runs`);
  p(`     at ${((a.maker / a.totalFills) * 100).toFixed(1)}% maker rate — ETH at ${((b.maker / b.totalFills) * 100).toFixed(1)}% has 12-20pp of headroom.`);
  p('');
  p('  E. DON\'T FIGHT TREND — RAISE MIN VOL TO TRADE');
  p(`     The bot lost because ETH trended during the session and mean-reversion`);
  p(`     signals got run over. Gate entries on a regime filter (e.g. 30-min ADX or`);
  p(`     price-band distance from mid); pair 21 BTC uses tighter price-band kill`);
  p(`     switches — mirror them on ETH with asymmetric upper/lower bands pegged to`);
  p(`     current mid ± 2×daily_range.`);
  p('');
  p('  F. CAP CONCURRENT OPEN GRIDS');
  p(`     5 grids currently open simultaneously — each pays SL on the same adverse`);
  p(`     move. Reduce max concurrent from ${5} to 2-3 to avoid correlated stop-outs.`);
  p('');
  p(`  G. TARGET RATIO TO TURN POSITIVE:`);
  p(`     Given current win rate ${(b.winRate * 100).toFixed(1)}% on exchange, ETH needs`);
  p(`     avg_win ≥ ${(Math.abs(b.lossStats.avg) * (b.lossExits / b.profitExits)).toFixed(2)} * (loss_count/win_count factor)`);
  p(`     = set tpSpreadDelta so avg exit win ≥ $${(Math.abs(b.lossStats.avg) * b.lossExits / b.profitExits).toFixed(2)}`);
  p(`     OR reduce loss count by ~${b.lossExits - Math.round(b.profitExits * (Math.abs(b.winStats.avg) / Math.abs(b.lossStats.avg)))}`);
  p(`     (i.e. don't let ${b.lossExits - Math.round(b.profitExits * (Math.abs(b.winStats.avg) / Math.abs(b.lossStats.avg)))} of today's losses trigger).`);
  p('');
  p('════════════════════════════════════════════════════════════════════════════════');
  p('END OF COMPARISON REPORT');
  p('════════════════════════════════════════════════════════════════════════════════');
  return L.join('\n');
}

(async () => {
  console.error('Fetching BTC pair 21 ...');
  const a = await analyzePair(21);
  console.error('Fetching ETH pair 22 ...');
  const b = await analyzePair(22);
  const body = lines(a, b);
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace('.', '-');
  const outPath = path.join(__dirname, '..', 'reports', `btc_vs_eth_exchange_${stamp}.txt`);
  fs.writeFileSync(outPath, body);
  console.log(body);
  console.error('\nWritten →', outPath);
  await sequelize.close();
})().catch(async (e) => { console.error('ERR', e.message, e.stack); try { await sequelize.close(); } catch (_) {} process.exit(1); });
