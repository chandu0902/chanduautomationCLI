#!/usr/bin/env node
/**
 * ethMasterSimAndStrategy.js  (v3 — AUTHORITATIVE via transaction_log)
 *
 *   Source: /private/get_transaction_log (currency=ETH) — every fill is one row.
 *   Options are filtered out by instrument name (kept: ETH-PERPETUAL).
 *   Window: 2026-04-16 00:00 UTC → now.
 *
 *   Deliverables:
 *     §1  exchange totals (volume, rebates, fees paid, realized PnL, funding)
 *     §2  per-hour IST breakdown of exchange volume & net PnL
 *     §3  DB exit-reason classification
 *     §4  direction / hold / pair breakdown
 *     §5  simulation grid (SL cap × reprice × hours × dir × streak × tpMin)
 *     §6  recommended live config (SQL)
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { StatArbInput, AccountDetails, sequelize } = require('../src/models');

const CCY      = 'ETH';
const PERP     = 'ETH-PERPETUAL';
const PAIR_IDS = [22, 23, 25, 26];
const START_MS = Date.UTC(2026, 3, 16, 0, 0, 0);
const END_MS   = Date.now();

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
  for (let i=0;i<500;i++) {
    await sleep(250);
    const params = { currency: CCY, start_timestamp: startMs, end_timestamp: endMs, count: 1000 };
    if (cont) params.continuation = cont;
    let r;
    for (let a=0;a<5;a++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{
        headers:{Authorization:`Bearer ${token}`}, params,
        timeout:30000, validateStatus:()=>true
      });
      if (r.status === 429 || r.data?.error?.code === 10028) { await sleep(5000*(a+1)); continue; }
      break;
    }
    const logs = r?.data?.result?.logs || [];
    all.push(...logs);
    process.stdout.write(`\r  txlog: ${all.length}`);
    cont = r?.data?.result?.continuation;
    if (!cont || !logs.length) break;
  }
  process.stdout.write('\n');
  return all;
}
async function fetchIndex() {
  try { const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
        return r?.data?.result?.index_price || 0;
  } catch { return 0; }
}

const fmtTs  = ms => new Date(ms).toISOString().replace('T',' ').replace('Z',' UTC');
const fmtDur = ms => { const m=Math.floor(ms/60000); const s=Math.round((ms%60000)/1000); return `${m}m ${s}s`; };
const sgn    = n => n>=0?'+':'';
const pct    = (n,d) => d ? ((n/d)*100).toFixed(1)+'%' : '0.0%';
const istHour = d => {
  const dt = new Date(d);
  const utcMin = dt.getUTCHours()*60 + dt.getUTCMinutes();
  return Math.floor(((utcMin + 330) % 1440) / 60);
};

(async () => {
  const anyPair = await StatArbInput.findByPk(26);
  const acc     = await AccountDetails.findOne({ where: { Trade_Account: anyPair.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token   = await auth(apiKey, secretKey);

  console.log(`\nETH MASTER v3  |  account=${anyPair.tradeAccountA}  |  pairs=${PAIR_IDS.join(',')}`);
  console.log(`  Window: ${fmtTs(START_MS)}  →  ${fmtTs(END_MS)}  (${fmtDur(END_MS-START_MS)})`);
  console.log(`  Source: /private/get_transaction_log  (authoritative per-fill)\n`);

  const [txLog, idx] = await Promise.all([
    fetchTxLog(token, START_MS, END_MS),
    fetchIndex(),
  ]);
  const ethIdx = idx || 2285;
  const toUsd  = eth => eth * ethIdx;

  /* ── split txlog ────────────────────────────────────────────────────── */
  const tradeRows = txLog.filter(t => t.type === 'trade' && t.instrument_name === PERP);
  const optionRows= txLog.filter(t => t.type === 'trade' && t.instrument_name && t.instrument_name !== PERP);
  const settleRows= txLog.filter(t => t.type === 'settlement');
  const otherTx   = txLog.filter(t => t.type !== 'trade' && t.type !== 'settlement');

  /* ── exchange aggregates (ETH-PERPETUAL only) ────────────────────────── */
  let volUsd = 0, buyUsd = 0, sellUsd = 0;
  let commEth = 0, rebEth = 0, feePaidEth = 0;
  let cashEth = 0, interestEth = 0;
  let makerN = 0, takerN = 0;
  let openN = 0, closeN = 0;
  const hourly = Array.from({length:24},()=>({ n:0, vol:0, cash:0, comm:0 }));

  for (const t of tradeRows) {
    const amt = Math.abs(parseFloat(t.amount || 0));
    const comm= parseFloat(t.commission || 0);
    const cf  = parseFloat(t.cashflow || 0);
    const ip  = parseFloat(t.interest_pl || 0);
    const side= String(t.side || '');
    const h   = istHour(t.timestamp);

    volUsd  += amt;
    if (side.includes('buy'))  buyUsd  += amt;
    if (side.includes('sell')) sellUsd += amt;
    commEth += comm;
    if (comm < 0) rebEth     += -comm;
    if (comm > 0) feePaidEth +=  comm;
    cashEth    += cf;
    interestEth+= ip;
    if ((t.fee_role || t.user_role) === 'maker') makerN++;
    else if ((t.fee_role || t.user_role) === 'taker') takerN++;
    if (side.startsWith('open'))  openN++;
    if (side.startsWith('close')) closeN++;

    hourly[h].n++;
    hourly[h].vol += amt;
    hourly[h].cash += cf;
    hourly[h].comm += comm;
  }
  /* realized PnL (ETH) = sum of cashflow (close-side rows where profit_as_cashflow) */
  const realisedEth = cashEth;
  const feeNetEth   = commEth;   // negative = account earned net
  const netExchEth  = realisedEth + feeNetEth + interestEth;

  /* ── settlements (funding) & deposits for equity reconciliation ─────── */
  const settleEth = settleRows.reduce((s,t)=>s+parseFloat(t.change||0),0);
  const depositsEth = otherTx.filter(t=>t.type==='deposit').reduce((s,t)=>s+parseFloat(t.change||0),0);

  /* ── DB trades ──────────────────────────────────────────────────────── */
  const dbRows = await sequelize.query(
    `SELECT id, pairId, direction, entryTime, exitTime,
            exitReason, holdMs, grossPnl, commission, takerFeeUsd, netPnl,
            tpDelta, slDelta, legA_entryPrice, legA_exitPrice
     FROM basis_positions
     WHERE pairId IN (:ids) AND state='closed' AND entryTime IS NOT NULL
     ORDER BY entryTime ASC`,
    { replacements: { ids: PAIR_IDS }, type: sequelize.QueryTypes.SELECT }
  );

  const byReason = {};
  for (const r of dbRows) {
    const k = r.exitReason || '(null)';
    (byReason[k] = byReason[k] || { n:0, gross:0, net:0, wins:0, losses:0, worst:0, best:0 });
    byReason[k].n++;
    byReason[k].gross += parseFloat(r.grossPnl || 0);
    byReason[k].net   += parseFloat(r.netPnl   || 0);
    const g = parseFloat(r.grossPnl||0);
    if (g>0) byReason[k].wins++; else if (g<0) byReason[k].losses++;
    if (g < byReason[k].worst) byReason[k].worst = g;
    if (g > byReason[k].best)  byReason[k].best  = g;
  }
  const stopRows = dbRows.filter(r => (r.exitReason||'').toLowerCase().includes('stop'));
  const avgStopLoss = stopRows.length ? stopRows.reduce((s,r)=>s+parseFloat(r.grossPnl||0),0)/stopRows.length : 0;

  const hourDbBuckets = Array.from({length:24},()=>({ n:0, gross:0, stops:0, wins:0 }));
  for (const r of dbRows) {
    const h = istHour(r.entryTime);
    hourDbBuckets[h].n++;
    hourDbBuckets[h].gross += parseFloat(r.grossPnl||0);
    if ((r.exitReason||'').toLowerCase().includes('stop')) hourDbBuckets[h].stops++;
    if (parseFloat(r.grossPnl||0) > 0) hourDbBuckets[h].wins++;
  }
  const dirStats = { long: {n:0,gross:0,stops:0,wins:0}, short: {n:0,gross:0,stops:0,wins:0} };
  for (const r of dbRows) {
    const d = r.direction === 'long' ? 'long' : 'short';
    dirStats[d].n++;
    dirStats[d].gross += parseFloat(r.grossPnl||0);
    if ((r.exitReason||'').toLowerCase().includes('stop')) dirStats[d].stops++;
    if (parseFloat(r.grossPnl||0) > 0) dirStats[d].wins++;
  }
  const holdBuckets = [];
  for (const [lo, hi] of [[0,30000],[30000,60000],[60000,120000],[120000,240000],[240000,480000],[480000,999999999]]) {
    const rows = dbRows.filter(r => (r.holdMs||0) >= lo && (r.holdMs||0) < hi);
    holdBuckets.push({ label: `${Math.round(lo/1000)}-${Math.round(hi/1000)}s`, rows });
  }
  const pairStats = {};
  for (const r of dbRows) {
    const k = r.pairId;
    (pairStats[k] = pairStats[k] || { n:0, gross:0, stops:0, wins:0, stopSum:0 });
    pairStats[k].n++;
    pairStats[k].gross += parseFloat(r.grossPnl||0);
    const isStop = (r.exitReason||'').toLowerCase().includes('stop');
    if (isStop) { pairStats[k].stops++; pairStats[k].stopSum += parseFloat(r.grossPnl||0); }
    if (parseFloat(r.grossPnl||0) > 0) pairStats[k].wins++;
  }

  /* ── simulation harness ──────────────────────────────────────────────── */
  const slipFactor = rpSec => Math.max(1.15, 1.15 + 0.24 * rpSec);
  function runSim(cfg) {
    const { slCap, rp, disableHrs, disableDir, streakN, coolN, tpMin } = cfg;
    const maxAllowedLoss = -slCap * slipFactor(rp);
    const taken = [];
    let streak = 0, cool = 0;
    for (const r of dbRows) {
      const h = istHour(r.entryTime);
      if (cool > 0) { cool--; continue; }
      if (disableHrs && disableHrs.includes(h)) continue;
      if (disableDir && r.direction === disableDir) continue;
      let g = parseFloat(r.grossPnl || 0);
      if (g < maxAllowedLoss) g = maxAllowedLoss;
      if (tpMin && g > 0 && g < tpMin) g = 0.6 * maxAllowedLoss;
      taken.push({ ...r, simPnl: g });
      const isStop = (r.exitReason||'').toLowerCase().includes('stop');
      if (isStop || g < 0) streak++; else streak = 0;
      if (streakN && streak >= streakN) { cool = coolN; streak = 0; }
    }
    const gross = taken.reduce((s,r)=>s+r.simPnl,0);
    const wins  = taken.filter(r=>r.simPnl>0).length;
    const losses= taken.filter(r=>r.simPnl<0).length;
    const winSum= taken.filter(r=>r.simPnl>0).reduce((s,r)=>s+r.simPnl,0);
    const lossSum=taken.filter(r=>r.simPnl<0).reduce((s,r)=>s+r.simPnl,0);
    return { n:taken.length, gross, wins, losses,
             winRate: taken.length?wins/taken.length:0,
             avgWin: wins?winSum/wins:0, avgLoss: losses?lossSum/losses:0,
             expectancy: taken.length?gross/taken.length:0 };
  }
  const baseline = runSim({ slCap:100, rp:5, disableHrs:null, disableDir:null, streakN:null, coolN:0, tpMin:null });
  const worst3DbHours = hourDbBuckets
    .map((b,h)=>({h, gross:b.gross, n:b.n}))
    .sort((a,b)=>a.gross-b.gross).slice(0,3).map(x=>x.h);

  const simConfigs = [];
  for (const sl of [3,4,5,6,8,10])
   for (const rp of [1,2,3])
    for (const hs of [null, worst3DbHours])
     for (const df of [null, 'long', 'short'])
      for (const sk of [{n:null,c:0},{n:3,c:5},{n:3,c:10},{n:4,c:8}])
       for (const tm of [null, 1.0, 2.0])
        simConfigs.push({ slCap:sl, rp, disableHrs:hs, disableDir:df, streakN:sk.n, coolN:sk.c, tpMin:tm });
  console.log(`  Running ${simConfigs.length} simulations over ${dbRows.length} DB round-trips …\n`);
  const results = simConfigs.map(c=>({cfg:c, r:runSim(c)})).sort((a,b)=>b.r.gross - a.r.gross);
  const top20 = results.slice(0,20);
  const bestRealistic = results.find(x => x.r.n >= Math.floor(dbRows.length * 0.5));

  /* ─────────────────────── REPORT ─────────────────────── */
  const L = [];
  const HR='═'.repeat(84), hr='─'.repeat(84);

  L.push(HR);
  L.push(`  ETH MASTER v3 — authoritative via transaction_log`);
  L.push(`  Account : ${anyPair.tradeAccountA}    Pairs: ${PAIR_IDS.join(',')}   Instrument: ${PERP}`);
  L.push(`  Window  : ${fmtTs(START_MS)}  →  ${fmtTs(END_MS)}  (${fmtDur(END_MS-START_MS)})`);
  L.push(`  Source  : /private/get_transaction_log  (type='trade', instrument=${PERP})`);
  L.push(`  Options : excluded (${optionRows.length} option-trade rows filtered out)`);
  L.push(`  ETH idx : $${ethIdx.toFixed(2)}`);
  L.push(HR);
  L.push('');

  L.push('  §1.  EXCHANGE TOTALS  (per-fill from txlog — authoritative)');
  L.push(hr);
  L.push(`  ETH-PERPETUAL fills      : ${tradeRows.length.toLocaleString()}`);
  L.push(`    open-side fills        : ${openN.toLocaleString()}    close-side fills: ${closeN.toLocaleString()}`);
  L.push(`    maker fills            : ${makerN.toLocaleString()}  (${pct(makerN, tradeRows.length)})`);
  L.push(`    taker fills            : ${takerN.toLocaleString()}  (${pct(takerN, tradeRows.length)})`);
  L.push(`  Notional volume (USD)    : $${volUsd.toLocaleString()}`);
  L.push(`    buy-side               : $${buyUsd.toLocaleString()}`);
  L.push(`    sell-side              : $${sellUsd.toLocaleString()}`);
  L.push('');
  L.push(`  Realised PnL (cashflow)  : ${sgn(realisedEth)}${realisedEth.toFixed(6)} ETH  (~${sgn(toUsd(realisedEth))}$${Math.abs(toUsd(realisedEth)).toFixed(2)})`);
  L.push(`  Commission net           : ${sgn(commEth)}${commEth.toFixed(6)} ETH  (~${sgn(toUsd(commEth))}$${Math.abs(toUsd(commEth)).toFixed(2)})`);
  L.push(`    rebates earned         : -${rebEth.toFixed(6)} ETH  (~$${toUsd(rebEth).toFixed(2)})`);
  L.push(`    fees paid              : +${feePaidEth.toFixed(6)} ETH  (~$${toUsd(feePaidEth).toFixed(2)})`);
  L.push(`  Funding / interest_pl    : ${sgn(interestEth)}${interestEth.toFixed(6)} ETH  (~${sgn(toUsd(interestEth))}$${Math.abs(toUsd(interestEth)).toFixed(2)})`);
  L.push(`  NET exchange (realised + comm + funding) :`);
  L.push(`                              ${sgn(netExchEth)}${netExchEth.toFixed(6)} ETH  (~${sgn(toUsd(netExchEth))}$${Math.abs(toUsd(netExchEth)).toFixed(2)})`);
  L.push('');
  L.push(`  Settlement events (ETH)  : ${sgn(settleEth)}${settleEth.toFixed(6)} ETH  (~${sgn(toUsd(settleEth))}$${Math.abs(toUsd(settleEth)).toFixed(2)})`);
  L.push(`  Deposits (ETH)           : ${sgn(depositsEth)}${depositsEth.toFixed(6)} ETH`);
  L.push('');

  L.push('  §2.  PER-IST-HOUR EXCHANGE SUMMARY');
  L.push(hr);
  L.push(`  hour    fills      volUsd         cash(ETH)    comm(ETH)      netUsd`);
  for (let h=0;h<24;h++) {
    const b = hourly[h]; if (!b.n) continue;
    const net = b.cash + b.comm;
    L.push(`  ${String(h).padStart(2)}h   ${String(b.n).padStart(5)}  ${b.vol.toLocaleString().padStart(14)}   ${sgn(b.cash)}${b.cash.toFixed(4).padStart(9)}   ${sgn(b.comm)}${b.comm.toFixed(4).padStart(9)}   ${sgn(toUsd(net))}${toUsd(net).toFixed(2).padStart(9)}`);
  }
  L.push('');

  L.push('  §3.  DB CLOSED ROUND-TRIPS — exit reason');
  L.push(hr);
  L.push(`  reason                         n   gross$      avg$     wins  losses  worst    best`);
  for (const k of Object.keys(byReason).sort((a,b)=>byReason[b].n - byReason[a].n)) {
    const b = byReason[k];
    const avg = b.n ? b.gross/b.n : 0;
    L.push(`  ${(k.padEnd(28)).slice(0,28)}  ${String(b.n).padStart(4)}  ${sgn(b.gross)}${b.gross.toFixed(2).padStart(8)}  ${sgn(avg)}${avg.toFixed(2).padStart(6)}  ${String(b.wins).padStart(5)}  ${String(b.losses).padStart(6)}  ${b.worst.toFixed(2).padStart(6)}  ${b.best.toFixed(2).padStart(6)}`);
  }
  L.push(`  avgStop = $${avgStopLoss.toFixed(2)}  over ${stopRows.length} stops`);
  L.push('');

  L.push('  §4.  DIRECTION / PAIR / HOLD');
  L.push(hr);
  for (const d of ['long','short']) {
    const s = dirStats[d];
    L.push(`  DB direction=${d.padEnd(6)}  n=${String(s.n).padStart(4)}  gross=${sgn(s.gross)}$${s.gross.toFixed(2)}  stops=${s.stops}  wins=${s.wins}  winRate=${pct(s.wins,s.n)}`);
  }
  L.push('  NOTE: DB direction reflects the entry ORDER side (buy=long), not net exposure.');
  L.push('        Exchange txlog confirms the bot opens with open-sell (short) and closes with close-buy.');
  L.push(`        open-sell fills : ${tradeRows.filter(t=>t.side==='open sell').length},  close-buy fills : ${tradeRows.filter(t=>t.side==='close buy').length}`);
  L.push(`        open-buy  fills : ${tradeRows.filter(t=>t.side==='open buy').length},  close-sell fills: ${tradeRows.filter(t=>t.side==='close sell').length}`);
  L.push('');
  L.push('  Per-pair performance:');
  for (const k of Object.keys(pairStats).sort((a,b)=>+a-+b)) {
    const s = pairStats[k];
    const avgStop = s.stops ? s.stopSum/s.stops : 0;
    L.push(`    pair ${k}  n=${String(s.n).padStart(4)}  gross=${sgn(s.gross)}$${s.gross.toFixed(2)}  stops=${s.stops}  avgStop=$${avgStop.toFixed(2)}  wins=${s.wins}  winRate=${pct(s.wins,s.n)}`);
  }
  L.push('');
  L.push('  Hold-time buckets:');
  L.push(`  bucket       n     gross$   avg$    stops  wins  winRate`);
  for (const hb of holdBuckets) { if (!hb.rows.length) continue;
    const n=hb.rows.length, g=hb.rows.reduce((s,r)=>s+parseFloat(r.grossPnl||0),0);
    const st=hb.rows.filter(r=>(r.exitReason||'').toLowerCase().includes('stop')).length;
    const w=hb.rows.filter(r=>parseFloat(r.grossPnl||0)>0).length;
    L.push(`  ${hb.label.padEnd(10)}  ${String(n).padStart(4)}  ${sgn(g)}${g.toFixed(2).padStart(7)}  ${(g/n).toFixed(2).padStart(6)}   ${String(st).padStart(4)}  ${String(w).padStart(4)}  ${pct(w,n).padStart(6)}`);
  }
  L.push('');

  L.push('  §5.  BASELINE (DB as-is)');
  L.push(hr);
  L.push(`  trades=${baseline.n}  wins=${baseline.wins}  losses=${baseline.losses}  winRate=${pct(baseline.wins,baseline.n)}`);
  L.push(`  gross=${sgn(baseline.gross)}$${baseline.gross.toFixed(2)}  avgWin=$${baseline.avgWin.toFixed(2)}  avgLoss=$${baseline.avgLoss.toFixed(2)}  expectancy=$${baseline.expectancy.toFixed(3)}`);
  L.push('');

  L.push('  §6.  TOP 20 SIMULATIONS BY GROSS');
  L.push(hr);
  L.push(`   # sl$ rp    hrs      dir   streak    tpMin   n     gross$   winRate   avgW$  avgL$  exp$`);
  for (let i=0;i<top20.length;i++) { const { cfg, r } = top20[i];
    const hrs = cfg.disableHrs ? cfg.disableHrs.join('/') : '-';
    L.push(`  ${String(i+1).padStart(2)}  ${String(cfg.slCap).padStart(3)}  ${cfg.rp}s  ${hrs.padEnd(8)}  ${String(cfg.disableDir||'-').padEnd(5)}  ${cfg.streakN?`${cfg.streakN}→${cfg.coolN}`:'-'.padEnd(6)}  ${String(cfg.tpMin||'-').padStart(5)}  ${String(r.n).padStart(4)}  ${sgn(r.gross)}${r.gross.toFixed(2).padStart(7)}  ${pct(r.wins,r.n).padStart(6)}  ${r.avgWin.toFixed(2).padStart(5)}  ${r.avgLoss.toFixed(2).padStart(5)}  ${r.expectancy.toFixed(2).padStart(5)}`);
  }
  L.push('');

  L.push(`  §7.  BEST CONFIG REQUIRING ≥${Math.floor(dbRows.length*0.5)} TRADES (≥50% of history)`);
  L.push(hr);
  if (bestRealistic) { const { cfg, r } = bestRealistic;
    L.push(`  slCapUsd            : $${cfg.slCap}`);
    L.push(`  stopRepriceInterval : ${cfg.rp}s`);
    L.push(`  disable IST hours   : ${cfg.disableHrs ? cfg.disableHrs.join(',') : 'none'}`);
    L.push(`  disable DB dir      : ${cfg.disableDir || 'none'}  (reminder: DB dir reflects order side, not exposure)`);
    L.push(`  stop streak         : ${cfg.streakN ? cfg.streakN+' stops → skip '+cfg.coolN+' trades' : 'disabled'}`);
    L.push(`  tpMinProfitUsd      : ${cfg.tpMin || 'none'}`);
    L.push('');
    L.push(`  trades=${r.n}  wins=${r.wins}  losses=${r.losses}  winRate=${pct(r.wins,r.n)}`);
    L.push(`  gross=${sgn(r.gross)}$${r.gross.toFixed(2)}  avgWin=$${r.avgWin.toFixed(2)}  avgLoss=$${r.avgLoss.toFixed(2)}  expectancy=$${r.expectancy.toFixed(3)}`);
    const rebateShare = (r.n / dbRows.length) * toUsd(rebEth);
    const feePaidShare= (r.n / dbRows.length) * toUsd(feePaidEth);
    const netTrading = r.gross;
    const netWithRebates = netTrading + rebateShare - feePaidShare;
    L.push('');
    L.push(`  Pro-rata exchange ECON at this trade count:`);
    L.push(`    rebate share     : +$${rebateShare.toFixed(2)}`);
    L.push(`    fees paid share  : -$${feePaidShare.toFixed(2)}`);
    L.push(`    projected NET    : ${sgn(netWithRebates)}$${netWithRebates.toFixed(2)}`);
  }
  L.push('');
  L.push(HR);

  const outPath = path.join(__dirname, '..', 'reports', `eth_master_sim_v3_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, L.join('\n'));
  console.log(`\nReport: ${outPath}\n`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
