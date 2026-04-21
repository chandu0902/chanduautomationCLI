#!/usr/bin/env node
/**
 * ethLiveSessionReport.js
 * Quick live status for pair 26's CURRENT session:
 *   - Deribit transaction_log since sessionStartedAt
 *   - Account balance + perp positions now
 *   - DB basis_positions opened since sessionStartedAt
 *   - Comparison to pre-deploy run-rate
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const { StatArbInput, AccountDetails, BasisPosition, sequelize } = require('../src/models');

const PAIR_ID = 26;
const PERP    = 'ETH-PERPETUAL';
const CCY     = 'ETH';

function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return d.update(enc,'base64','utf8') + d.final('utf8');
}
function creds(acc) {
  const [a0,a1,a2] = acc.Api_Key.split(',',3);
  const [s0,s1,s2] = acc.Secret_Key.split(',',3);
  return { apiKey: decrypt(a2,a1,a0), secretKey: decrypt(s2,s1,s0) };
}
async function auth(k,s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth',{
    jsonrpc:'2.0',id:1,method:'public/auth',
    params:{grant_type:'client_credentials',client_id:k,client_secret:s,scope:'trade:read_write'}});
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function fetchTxLog(token, startMs, endMs) {
  const all = []; let cont;
  for (let i=0;i<50;i++) {
    await sleep(200);
    const params = { currency: CCY, start_timestamp: startMs, end_timestamp: endMs, count: 1000 };
    if (cont) params.continuation = cont;
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{
      headers:{Authorization:`Bearer ${token}`}, params, timeout:30000
    });
    const logs = r?.data?.result?.logs || [];
    all.push(...logs);
    cont = r?.data?.result?.continuation;
    if (!cont || !logs.length) break;
  }
  return all;
}
async function fetchAccount(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_account_summary',{
    headers:{Authorization:`Bearer ${token}`},
    params:{currency:CCY, extended:true}, timeout:15000
  });
  return r?.data?.result || {};
}
async function fetchPositions(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_positions',{
    headers:{Authorization:`Bearer ${token}`},
    params:{currency:CCY, kind:'future'}, timeout:15000
  });
  return (r?.data?.result || []).filter(p => p.size !== 0);
}
async function fetchIndex() {
  const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
  return r?.data?.result?.index_price || 0;
}

(async () => {
  const pair = await StatArbInput.findByPk(PAIR_ID, { raw: true });
  if (!pair) throw new Error(`pair ${PAIR_ID} not found`);
  if (!pair.sessionStartedAt) throw new Error('no sessionStartedAt — bot never had a live session');

  const startMs = new Date(pair.sessionStartedAt).getTime();
  const endMs   = Date.now();
  const elapsedMs = endMs - startMs;
  const elapsedMin = Math.floor(elapsedMs / 60000);

  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  const [ethPx, acct, positions, logs] = await Promise.all([
    fetchIndex(),
    fetchAccount(token),
    fetchPositions(token),
    fetchTxLog(token, startMs, endMs),
  ]);

  // Filter txlog: only ETH-PERPETUAL trades (no options, no transfers)
  const trades = logs.filter(l => l.type === 'trade' && l.instrument_name === PERP);

  // Aggregate
  let volUsd = 0, volBuy = 0, volSell = 0;
  let rebatesEth = 0, feesEth = 0;
  let cashEth = 0, fundEth = 0;
  let nMaker = 0, nTaker = 0, nOpen = 0, nClose = 0;
  let nOpenBuy = 0, nOpenSell = 0, nCloseBuy = 0, nCloseSell = 0;
  const byHourIst = {};

  for (const t of trades) {
    const notional = Math.abs(t.amount || 0);
    volUsd += notional;
    // txlog `side` is "open buy" | "open sell" | "close buy" | "close sell"
    const sideRaw = (t.side || '').toLowerCase();
    const side = sideRaw.includes('buy') ? 'buy' : 'sell';
    const isOpen = sideRaw.includes('open');
    if (side === 'buy') volBuy += notional; else volSell += notional;
    if (isOpen) nOpen++; else nClose++;
    const role = (t.fee_role || t.user_role || '').toLowerCase();
    const isMaker = role === 'maker';
    if (isMaker) nMaker++; else nTaker++;
    const comm = t.commission || 0;
    if (comm < 0) rebatesEth += comm; else feesEth += comm;
    cashEth += (t.cashflow || 0);
    fundEth += (t.interest_pl || 0);
    if (isOpen) { if (side==='buy') nOpenBuy++; else nOpenSell++; }
    else { if (side==='buy') nCloseBuy++; else nCloseSell++; }
    const istH = new Date(new Date(t.timestamp).getTime() + (5*60+30)*60000).getUTCHours();
    byHourIst[istH] ??= { n:0, vol:0, cash:0, comm:0 };
    byHourIst[istH].n++;
    byHourIst[istH].vol += notional;
    byHourIst[istH].cash += (t.cashflow || 0);
    byHourIst[istH].comm += comm;
  }

  const rebatesUsd = Math.abs(rebatesEth) * ethPx;
  const feesUsd    = feesEth * ethPx;
  const cashUsd    = cashEth * ethPx;
  const fundUsd    = fundEth * ethPx;
  const netCommUsd = rebatesUsd - feesUsd;
  const netExchUsd = cashUsd + (-rebatesEth) * ethPx - feesEth * ethPx + fundUsd;
  // simpler: net = cashflow + commission_net + funding, all in USD
  const netUsdSimple = cashUsd - (rebatesEth + feesEth) * ethPx + fundUsd;

  // DB round-trips opened during this session
  const [dbStats] = await sequelize.query(`
    SELECT
      exitReason,
      COUNT(*) AS n,
      ROUND(SUM(grossPnl),3) AS totGross,
      ROUND(AVG(grossPnl),3) AS avgGross,
      ROUND(SUM(netPnl),3) AS totNet,
      SUM(CASE WHEN grossPnl > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN grossPnl <= 0 THEN 1 ELSE 0 END) AS losses,
      ROUND(MIN(grossPnl),3) AS worst,
      ROUND(MAX(grossPnl),3) AS best
    FROM basis_positions
    WHERE pairId = :pid AND state='closed'
      AND entryTime >= :start
    GROUP BY exitReason
    ORDER BY n DESC
  `, { replacements: { pid: PAIR_ID, start: new Date(startMs) } });

  const [[tot]] = await sequelize.query(`
    SELECT COUNT(*) AS n,
           ROUND(SUM(grossPnl),3) AS totGross,
           ROUND(SUM(netPnl),3) AS totNet,
           SUM(CASE WHEN grossPnl>0 THEN 1 ELSE 0 END) AS wins,
           ROUND(AVG(holdMs),0) AS avgHoldMs
    FROM basis_positions
    WHERE pairId = :pid AND state='closed' AND entryTime >= :start
  `, { replacements: { pid: PAIR_ID, start: new Date(startMs) } });

  // Balance delta from sessionStartBalance
  const balanceNow = acct.balance ?? null;
  const equityNow  = acct.equity ?? null;
  const startBal   = pair.sessionStartBalance;
  const balDelta   = (balanceNow != null && startBal != null) ? (balanceNow - startBal) : null;
  const balDeltaUsd = balDelta != null ? balDelta * ethPx : null;

  // Projections
  const dayFactor = (24*60*60*1000) / elapsedMs;
  const projVolDay     = volUsd     * dayFactor;
  const projRebatesDay = rebatesUsd * dayFactor;
  const projCashDay    = cashUsd    * dayFactor;
  const projNetDay     = netUsdSimple * dayFactor;

  // ─── REPORT ──────────────────────────────────────────────────────────────
  const L = [];
  const line = s => L.push(s);
  line('═══════════════════════════════════════════════════════════════════════════════════');
  line('  ETH PAIR 26 — LIVE SESSION REPORT (post-OptA deploy)');
  line(`  Account     : ${pair.tradeAccountA}    Instrument: ${PERP}`);
  line(`  Session     : ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`);
  line(`  Duration    : ${elapsedMin}m  (${(elapsedMin/60).toFixed(2)} h)`);
  line(`  ETH index   : $${ethPx.toFixed(2)}`);
  line('═══════════════════════════════════════════════════════════════════════════════════');
  line('');
  line('  §1  EXCHANGE (per-fill from transaction_log)');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`  Fills total              : ${trades.length}`);
  line(`    maker                  : ${nMaker}  (${trades.length?((nMaker/trades.length)*100).toFixed(1):0}%)`);
  line(`    taker                  : ${nTaker}  (${trades.length?((nTaker/trades.length)*100).toFixed(1):0}%)`);
  line(`    open-sell (new short)  : ${nOpenSell}     open-buy (new long)   : ${nOpenBuy}`);
  line(`    close-buy (cover short): ${nCloseBuy}     close-sell (exit long): ${nCloseSell}`);
  line(`    total buy-side         : ${volBuy ? '$'+volBuy.toLocaleString(undefined,{maximumFractionDigits:0}) : '$0'}`);
  line(`    total sell-side        : ${volSell ? '$'+volSell.toLocaleString(undefined,{maximumFractionDigits:0}) : '$0'}`);
  line(`  Volume USD (notional)    : $${volUsd.toLocaleString(undefined,{maximumFractionDigits:0})}`);
  line('');
  line(`  Cashflow (realised PnL)  : ${cashEth.toFixed(6)} ETH   ($${cashUsd.toFixed(2)})`);
  line(`  Rebates earned (comm<0)  : ${rebatesEth.toFixed(6)} ETH   ($${rebatesUsd.toFixed(2)})`);
  line(`  Fees paid     (comm>0)   : +${feesEth.toFixed(6)} ETH   ($${feesUsd.toFixed(2)})`);
  line(`  Funding / interest_pl    : ${fundEth.toFixed(6)} ETH   ($${fundUsd.toFixed(2)})`);
  line(`  NET exchange             : $${netUsdSimple.toFixed(2)}`);
  line('');
  line('  §2  ACCOUNT STATE');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`  sessionStartBalance      : ${startBal != null ? startBal.toFixed(6) + ' ETH' : 'n/a'}`);
  line(`  balance now              : ${balanceNow != null ? balanceNow.toFixed(6) + ' ETH' : 'n/a'}`);
  line(`  delta                    : ${balDelta != null ? balDelta.toFixed(6) + ' ETH' : 'n/a'}   ($${balDeltaUsd!=null?balDeltaUsd.toFixed(2):'n/a'})`);
  line(`  equity now               : ${equityNow != null ? equityNow.toFixed(6) + ' ETH' : 'n/a'}`);
  line(`  open perp positions      : ${positions.length}`);
  for (const p of positions) {
    line(`    ${p.instrument_name}  size=${p.size}  avg=${p.average_price}  uPnL=${(p.floating_profit_loss||0).toFixed(6)} ETH`);
  }
  line('');
  line('  §3  DB ROUND-TRIPS (basis_positions) SINCE SESSION START');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`  Total round-trips        : ${tot.n}    wins=${tot.wins}  winRate=${tot.n>0?((tot.wins/tot.n)*100).toFixed(1):0}%`);
  line(`  Total gross              : $${tot.totGross ?? 0}`);
  line(`  Total net                : $${tot.totNet ?? 0}`);
  line(`  Avg hold                 : ${tot.avgHoldMs != null ? (tot.avgHoldMs/1000).toFixed(1)+'s' : 'n/a'}`);
  line('');
  line(`  Exit-reason breakdown:`);
  line(`  reason                        n      gross$     avg$      wins   losses   worst    best`);
  for (const r of dbStats) {
    line(`  ${(r.exitReason||'?').padEnd(28)} ${String(r.n).padStart(4)}   ${String('$'+r.totGross).padStart(10)}  ${String('$'+r.avgGross).padStart(7)}    ${String(r.wins).padStart(3)}    ${String(r.losses).padStart(3)}   ${String('$'+(r.worst ?? '?')).padStart(8)}  ${String('$'+(r.best ?? '?')).padStart(6)}`);
  }
  line('');
  line('  §4  DAILY RUN-RATE PROJECTION (extrapolated from this session)');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`  Projected volume / day   : $${projVolDay.toLocaleString(undefined,{maximumFractionDigits:0})}`);
  line(`  Projected rebates / day  : $${projRebatesDay.toFixed(2)}`);
  line(`  Projected cashflow / day : $${projCashDay.toFixed(2)}`);
  line(`  Projected NET / day      : $${projNetDay.toFixed(2)}`);
  line('');
  line('  §5  COMPARE vs PRE-DEPLOY BASELINE (2026-04-16 → 2026-04-20 average)');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`                              pre-OptA          now (this session)       delta`);
  line(`  volume/day              : $8,923,233      $${projVolDay.toFixed(0).padStart(12)}     ${(((projVolDay/8923233)-1)*100).toFixed(1)}%`);
  line(`  rebates/day             :      $857      $${projRebatesDay.toFixed(0).padStart(12)}     ${(((projRebatesDay/857)-1)*100).toFixed(1)}%`);
  line(`  trading cash/day        :   -$1,926      $${projCashDay.toFixed(0).padStart(12)}`);
  line(`  NET/day                 :   -$1,069      $${projNetDay.toFixed(0).padStart(12)}`);
  line('');
  // Average stop loss comparison — the key KPI
  const stopsRow = dbStats.find(r => r.exitReason === 'stop');
  line('  §6  STOP-LOSS CAP VERIFICATION');
  line('  ─────────────────────────────────────────────────────────────────────────────────');
  line(`  Pre-OptA average stop   : -$23.11 (on 419 stops, $8 configured cap → 2.89× slip)`);
  if (stopsRow) {
    line(`  This session avg stop   : $${stopsRow.avgGross} (on ${stopsRow.n} stops, $3 configured cap)`);
    const slip = Math.abs(stopsRow.avgGross) / 3;
    line(`  Effective slip factor   : ${slip.toFixed(2)}× (target ≈ 1.39× at 1s reprice)`);
  } else {
    line(`  This session            : NO STOPS YET — insufficient data to measure slip`);
  }
  line('');
  line('═══════════════════════════════════════════════════════════════════════════════════');

  const out = L.join('\n');
  console.log(out);

  const fs   = require('fs');
  const path = require('path');
  const ts   = new Date().toISOString().replace(/[:.]/g,'-');
  const file = path.join(__dirname,'..','reports',`eth_pair26_live_session_${ts}.txt`);
  fs.writeFileSync(file, out);
  console.log(`\nwrote: ${file}`);
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
