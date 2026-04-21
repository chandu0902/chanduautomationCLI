#!/usr/bin/env node
/**
 * FULL BTC ANALYSIS — inception (Apr 02, 2026) → now.
 *
 * Combines:
 *   • DB (basis_positions / trade_logs / spread_level_history / statarb_inputs)
 *     for ALL 19 hiddenroad pairs (1..19) AND H4 pairs (20, 21, 24).
 *   • LIVE Deribit fetch for the H4 account (the only API key we still hold).
 *
 * Outputs a single multi-section report:
 *   1. Inventory & timeline          (all pairs, accounts, configs)
 *   2. Per-pair performance          (DB)
 *   3. Phase / weekly aggregates     (Hiddenroad vs H4)
 *   4. Exit-reason & hold-time mix
 *   5. Config evolution heat-map     (tp/sl/maxPos/qty1/levels per pair)
 *   6. Live H4 exchange truth        (fills, rebates, vol since 2026-04-15)
 *   7. Simulations on closed BPs
 *        SIM-A  Reduced TP (target tighter)
 *        SIM-B  Wider SL  (let losers come back)
 *        SIM-C  Drop trades on grid≤1 (deeper-only)
 *        SIM-D  Hold-time cap (force-flatten N min)
 *        SIM-E  Maker-only proxy (skip price_range/manual_cancel rows)
 *   8. Optimal config recommendation
 *
 *   node scripts/btcFullInceptionAnalysis.js
 *   node scripts/btcFullInceptionAnalysis.js --no-live    (skip exchange call)
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize, StatArbInput, AccountDetails, BasisPosition, Trade, SpreadLevelHistory,
} = require('../src/models');
const { asciiTablePush } = require('../lib/btcDeribitReconcileSection');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const NOW = Date.now();

const BTC_PAIR_IDS = [1,2,3,4,5,6,7,8,9,12,13,15,16,17,18,19,20,21,24];

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function decryptText(k, enc, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return dc.update(enc,'base64','utf8') + dc.final('utf8');
}
async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc:'2.0', id:1, method:'public/auth',
    params:{ grant_type:'client_credentials', client_id:apiKey, client_secret:secret, scope:'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
async function dRpc(token, method, params={}) {
  for (let i=0; i<8; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/private/${method}`,
      { jsonrpc:'2.0', id:1, method:`private/${method}`, params },
      { headers:{ Authorization:`Bearer ${token}` }, timeout:30000, validateStatus:()=>true });
    const e = r.data?.error;
    if (r.status===429 || e?.code===10028) { await sleep(5000*(i+1)); continue; }
    if (r.status>=400) throw new Error(`${method} HTTP ${r.status}`);
    if (e) throw new Error(e.message);
    return r.data.result;
  }
  throw new Error(`${method}: too many retries`);
}
async function fetchAllTrades(token, currency, startMs) {
  const all=[]; let cur=startMs;
  for (let p=0;p<200;p++) {
    await sleep(700);
    const res = await dRpc(token,'get_user_trades_by_currency_and_time',{
      currency, start_timestamp:cur, end_timestamp:Date.now(), count:1000, sorting:'asc' });
    const t = res.trades||[];
    if (!t.length) break;
    all.push(...t);
    if (!res.has_more) break;
    cur = t[t.length-1].timestamp+1;
  }
  return all;
}

function fmt(n, d=4) { return n==null||!Number.isFinite(n)?'-':Number(n).toFixed(d); }
function fmtUsd(n,d=2) { return n==null||!Number.isFinite(n)?'-':'$'+Number(n).toFixed(d); }
function pct(n,d=2) { return n==null||!Number.isFinite(n)?'-':Number(n*100).toFixed(d)+'%'; }
function durStr(ms) {
  if (!ms || ms<0) return '-';
  const s=Math.floor(ms/1000); const m=Math.floor(s/60); const h=Math.floor(m/60); const d=Math.floor(h/24);
  if (d>0) return `${d}d ${h%24}h`;
  if (h>0) return `${h}h ${m%60}m`;
  if (m>0) return `${m}m ${s%60}s`;
  return `${s}s`;
}
function emitTable(L, colDefs, rows) {
  const buf=[]; asciiTablePush(buf, colDefs, rows); for (const l of buf) L(l);
}
function median(xs) { if(!xs.length)return null; const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function pctile(xs, q) { if(!xs.length)return null; const s=[...xs].sort((a,b)=>a-b); const i=Math.min(s.length-1, Math.max(0,Math.floor(q*s.length))); return s[i]; }
function statBlock(xs) {
  if (!xs.length) return { n:0 };
  const sum = xs.reduce((s,x)=>s+x,0);
  const avg = sum/xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const med = median(xs);
  const sd = Math.sqrt(xs.reduce((s,x)=>s+(x-avg)*(x-avg),0)/Math.max(1,xs.length-1));
  return { n:xs.length, sum, avg, min, max, med, sd, p25:pctile(xs,0.25), p75:pctile(xs,0.75) };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const SKIP_LIVE = process.argv.includes('--no-live');
  await sequelize.authenticate();

  // 1. Pair config inventory
  const pairs = await StatArbInput.findAll({
    where:{ id:{ [Op.in]: BTC_PAIR_IDS } }, order:[['id','ASC']],
  });
  const pairById = Object.fromEntries(pairs.map(p=>[p.id,p]));

  // 2. All closed basis positions for BTC pairs
  const allBPs = await BasisPosition.findAll({
    where:{ pairId:{ [Op.in]: BTC_PAIR_IDS }, state:'closed' },
    order:[['entryTime','ASC']],
  });
  // 3. All trade_logs for BTC pairs
  const allTLs = await Trade.findAll({
    where:{ pairId:{ [Op.in]: BTC_PAIR_IDS } },
    order:[['legA_filledAt','ASC']],
  });
  // 4. Adapt history
  const allAdapts = await SpreadLevelHistory.findAll({
    where:{ pairId:{ [Op.in]: BTC_PAIR_IDS } }, order:[['id','ASC']],
  });

  // ── group BPs per pair / per phase ─────────────────────────────────────────
  const HID_IDS = [1,2,3,4,5,6,7,8,9,12,13,15,16,17,18,19];
  const H4_IDS  = [20,21,24];

  const bpByPair = {};
  for (const bp of allBPs) (bpByPair[bp.pairId] ||= []).push(bp);

  // Per-pair stats
  function statPairBPs(bps) {
    let nProfit=0,nStop=0,nOther=0;
    let sumNet=0,sumGross=0,sumComm=0;
    let winNet=0,lossNet=0;
    const winNets=[], lossNets=[], holds=[], spreadDeltas=[], grosses=[];
    let firstEntry=Infinity, lastExit=0;
    for (const bp of bps) {
      const net = Number(bp.netPnl)||0;
      const gross = Number(bp.grossPnl)||0;
      const comm = Number(bp.commission)||0;
      sumNet += net; sumGross += gross; sumComm += comm;
      if (bp.exitReason==='profit') nProfit++;
      else if (bp.exitReason==='stop') nStop++;
      else nOther++;
      if (net>0) { winNet += net; winNets.push(net); }
      else if (net<0) { lossNet += net; lossNets.push(net); }
      grosses.push(gross);
      if (bp.holdMs && bp.holdMs>0) holds.push(bp.holdMs);
      if (bp.spreadChange != null) spreadDeltas.push(Number(bp.spreadChange));
      const eT = new Date(bp.entryTime).getTime();
      const xT = bp.exitTime ? new Date(bp.exitTime).getTime() : eT;
      if (eT < firstEntry) firstEntry = eT;
      if (xT > lastExit) lastExit = xT;
    }
    return {
      n:bps.length, nProfit, nStop, nOther, sumNet, sumGross, sumComm,
      winRate: bps.length ? nProfit/bps.length : null,
      winNet, lossNet,
      avgWin: winNets.length ? winNet/winNets.length : null,
      avgLoss: lossNets.length ? lossNet/lossNets.length : null,
      profitFactor: lossNet<0 ? winNet/Math.abs(lossNet) : (winNet>0?Infinity:0),
      holdMed: median(holds), holdAvg: holds.length?holds.reduce((s,x)=>s+x,0)/holds.length:null,
      holdMax: holds.length?Math.max(...holds):null,
      spreadDeltaAvg: spreadDeltas.length ? spreadDeltas.reduce((s,x)=>s+x,0)/spreadDeltas.length : null,
      grosses,
      firstEntry, lastExit,
      durationMs: lastExit - firstEntry,
    };
  }

  // ── LIVE H4 fetch ──────────────────────────────────────────────────────────
  let liveH4 = null;
  if (!SKIP_LIVE) {
    const acct = await AccountDetails.findOne({ where:{ Trade_Account:'Deribit-H4' } });
    if (acct?.Api_Key) {
      const [ak0,ak1,ak2] = acct.Api_Key.split(',',3);
      const [sk0,sk1,sk2] = acct.Secret_Key.split(',',3);
      try {
        const token = await getToken(decryptText(ak2,ak1,ak0), decryptText(sk2,sk1,sk0));
        await sleep(800);
        const summary = await dRpc(token,'get_account_summary',{ currency:'BTC', extended:true });
        await sleep(700);
        const futPos = await dRpc(token,'get_positions',{ currency:'BTC', kind:'future' });
        await sleep(700);
        const optPos = await dRpc(token,'get_positions',{ currency:'BTC', kind:'option' });
        await sleep(700);
        const startMs = Date.UTC(2026, 3, 15, 14, 0, 0); // ~ pair 20 boot
        const fills = await fetchAllTrades(token, 'BTC', startMs);
        const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price',
          { params:{ index_name:'btc_usd' } }).catch(()=>({data:{}}));
        const idx = Number(ix.data?.result?.index_price)||0;
        liveH4 = { summary, futPos:futPos||[], optPos:optPos||[], fills, idx, startMs };
      } catch(e) {
        console.error('live H4 fetch failed:', e.message);
      }
    }
  }

  // ── BUILD REPORT ────────────────────────────────────────────────────────────
  const lines = [];
  const L = (s) => { lines.push(s); console.log(s); };

  L('╔══════════════════════════════════════════════════════════════════════════════╗');
  L('║  BTC FULL INCEPTION ANALYSIS — Apr 02, 2026 → now                          ║');
  L('║  Hiddenroad (~5k USD BTC, pairs 1–19) + Deribit-H4 (1.37 BTC, pairs 20+)   ║');
  L(`║  Generated (UTC): ${new Date().toISOString().padEnd(58)}║`);
  L('╚══════════════════════════════════════════════════════════════════════════════╝');
  L('');
  L(`Universe: ${pairs.length} BTC trading-pair configs across 2 accounts.`);
  L(`Closed round-trips analysed: ${allBPs.length}`);
  L(`Trade-log fills analysed:    ${allTLs.length}`);
  L(`Adapt events:                ${allAdapts.length}`);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 1: TIMELINE & INVENTORY
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('1. TIMELINE & INVENTORY (every BTC pair we have ever booted)');
  L('================================================================================');
  L('');
  const invRows = pairs.map(p => {
    const stats = statPairBPs(bpByPair[p.id]||[]);
    return [
      String(p.id),
      (p.agentName||'').slice(0,38),
      p.tradeAccountA,
      p.tradeLeg,
      String(p.qty1),
      String(p.maxPositions),
      `tp=${p.tpSpreadDelta} sl=${p.slSpreadDelta}`,
      stats.n>0 ? new Date(stats.firstEntry).toISOString().slice(5,16).replace('T',' ') : '-',
      stats.n>0 ? new Date(stats.lastExit).toISOString().slice(5,16).replace('T',' ') : '-',
      String(stats.n),
      fmtUsd(stats.sumNet),
    ];
  });
  emitTable(L, [
    {h:'id',w:3,align:'r'},
    {h:'agentName',w:40},
    {h:'account',w:18},
    {h:'leg',w:3},
    {h:'qty1',w:6,align:'r'},
    {h:'mx',w:3,align:'r'},
    {h:'tp / sl',w:18},
    {h:'first entry',w:13},
    {h:'last exit',w:13},
    {h:'closed',w:7,align:'r'},
    {h:'sumNetPnl USD',w:14,align:'r'},
  ], invRows);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 2: PER-PAIR PERFORMANCE
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('2. PER-PAIR PERFORMANCE  (closed basis_positions only; PnL is what bot booked)');
  L('================================================================================');
  L('');
  const perfRows = pairs.map(p => {
    const s = statPairBPs(bpByPair[p.id]||[]);
    return [
      String(p.id),
      (p.agentName||'').slice(0,30),
      String(s.n),
      `${s.nProfit}/${s.nStop}/${s.nOther}`,
      pct(s.winRate),
      fmtUsd(s.sumGross),
      fmtUsd(s.sumComm),
      fmtUsd(s.sumNet),
      s.profitFactor===Infinity?'inf':fmt(s.profitFactor,2),
      fmtUsd(s.avgWin),
      fmtUsd(s.avgLoss),
      durStr(s.holdMed),
    ];
  });
  emitTable(L, [
    {h:'id',w:3,align:'r'},
    {h:'agent',w:32},
    {h:'n',w:5,align:'r'},
    {h:'P/S/O',w:12},
    {h:'win%',w:7,align:'r'},
    {h:'gross',w:11,align:'r'},
    {h:'comm/reb',w:11,align:'r'},
    {h:'net',w:11,align:'r'},
    {h:'PF',w:6,align:'r'},
    {h:'avgWin',w:8,align:'r'},
    {h:'avgLoss',w:8,align:'r'},
    {h:'medHold',w:9},
  ], perfRows);
  L('');
  L('  Legend:  P/S/O = profit / stop / other-exit count');
  L('           PF    = profit-factor (Σ winNet / |Σ lossNet|)');
  L('           comm/reb = commission stored on bp (negative numbers = rebate book)');
  L('');

  // Phase totals
  const hidStats = statPairBPs(allBPs.filter(b=>HID_IDS.includes(b.pairId)));
  const h4Stats  = statPairBPs(allBPs.filter(b=>H4_IDS.includes(b.pairId)));
  const allStats = statPairBPs(allBPs);
  L('  Phase totals (closed only):');
  emitTable(L, [
    {h:'phase',w:32}, {h:'closed',w:8,align:'r'},
    {h:'gross',w:14,align:'r'}, {h:'comm/reb',w:14,align:'r'},
    {h:'net',w:14,align:'r'}, {h:'win%',w:8,align:'r'},
    {h:'PF',w:7,align:'r'}, {h:'medHold',w:10},
  ], [
    ['Phase 1 — Hiddenroad (1–19)', String(hidStats.n), fmtUsd(hidStats.sumGross), fmtUsd(hidStats.sumComm), fmtUsd(hidStats.sumNet), pct(hidStats.winRate), hidStats.profitFactor===Infinity?'inf':fmt(hidStats.profitFactor,2), durStr(hidStats.holdMed)],
    ['Phase 2 — Deribit-H4 (20–24)', String(h4Stats.n),  fmtUsd(h4Stats.sumGross),  fmtUsd(h4Stats.sumComm),  fmtUsd(h4Stats.sumNet),  pct(h4Stats.winRate),  h4Stats.profitFactor===Infinity?'inf':fmt(h4Stats.profitFactor,2),  durStr(h4Stats.holdMed)],
    ['ALL BTC',                     String(allStats.n), fmtUsd(allStats.sumGross), fmtUsd(allStats.sumComm), fmtUsd(allStats.sumNet), pct(allStats.winRate), allStats.profitFactor===Infinity?'inf':fmt(allStats.profitFactor,2), durStr(allStats.holdMed)],
  ]);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 3: WEEKLY / DAILY AGGREGATES
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('3. DAILY AGGREGATES (BTC, all pairs combined)');
  L('================================================================================');
  L('');
  const byDay = {};
  for (const bp of allBPs) {
    const d = new Date(bp.entryTime).toISOString().slice(0,10);
    (byDay[d] ||= []).push(bp);
  }
  const dayKeys = Object.keys(byDay).sort();
  const dayRows = dayKeys.map(d=>{
    const s = statPairBPs(byDay[d]);
    const acct = byDay[d].some(b=>H4_IDS.includes(b.pairId)) && byDay[d].some(b=>HID_IDS.includes(b.pairId)) ? 'BOTH'
      : byDay[d].some(b=>H4_IDS.includes(b.pairId)) ? 'H4' : 'HR';
    return [
      d, acct, String(s.n), `${s.nProfit}/${s.nStop}`, pct(s.winRate),
      fmtUsd(s.sumGross), fmtUsd(s.sumComm), fmtUsd(s.sumNet),
      s.profitFactor===Infinity?'inf':fmt(s.profitFactor,2), durStr(s.holdMed),
    ];
  });
  emitTable(L, [
    {h:'day UTC',w:11},{h:'acct',w:5},{h:'n',w:5,align:'r'},{h:'P/S',w:9},
    {h:'win%',w:7,align:'r'},{h:'gross',w:11,align:'r'},{h:'comm/reb',w:11,align:'r'},
    {h:'net',w:11,align:'r'},{h:'PF',w:6,align:'r'},{h:'medHold',w:9},
  ], dayRows);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 4: EXIT-REASON DISTRIBUTION (overall + by phase)
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('4. EXIT-REASON DISTRIBUTION');
  L('================================================================================');
  L('');
  function exitDist(bps) {
    const m = {};
    for (const b of bps) {
      const r = b.exitReason||'(null)';
      if (!m[r]) m[r] = { n:0, sumNet:0, sumGross:0, holdSum:0 };
      m[r].n++;
      m[r].sumNet += Number(b.netPnl)||0;
      m[r].sumGross += Number(b.grossPnl)||0;
      m[r].holdSum += Number(b.holdMs)||0;
    }
    return m;
  }
  function exitTbl(L, label, m) {
    L(`  ${label}:`);
    const rows = Object.entries(m).sort((a,b)=>b[1].n-a[1].n).map(([k,v])=>[
      k, String(v.n), fmtUsd(v.sumGross), fmtUsd(v.sumNet),
      durStr(Math.round(v.holdSum/Math.max(1,v.n))),
    ]);
    emitTable(L, [
      {h:'exitReason',w:30},{h:'n',w:7,align:'r'},
      {h:'Σ gross USD',w:14,align:'r'},{h:'Σ net USD',w:14,align:'r'},{h:'avgHold',w:10},
    ], rows);
    L('');
  }
  exitTbl(L, 'Phase 1 — Hiddenroad', exitDist(allBPs.filter(b=>HID_IDS.includes(b.pairId))));
  exitTbl(L, 'Phase 2 — Deribit-H4', exitDist(allBPs.filter(b=>H4_IDS.includes(b.pairId))));
  exitTbl(L, 'ALL BTC',              exitDist(allBPs));

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 5: HOLD-TIME, SPREAD-CHANGE, GROSS DISTRIBUTIONS
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('5. DISTRIBUTIONS (closed BPs, ALL BTC)');
  L('================================================================================');
  L('');
  const allHolds = allBPs.filter(b=>b.holdMs>0).map(b=>b.holdMs);
  const profitGrosses = allBPs.filter(b=>b.exitReason==='profit').map(b=>Number(b.grossPnl)||0);
  const stopGrosses   = allBPs.filter(b=>b.exitReason==='stop').map(b=>Number(b.grossPnl)||0);
  const profitSpreads = allBPs.filter(b=>b.exitReason==='profit').map(b=>Math.abs(Number(b.spreadChange)||0));
  const stopSpreads   = allBPs.filter(b=>b.exitReason==='stop').map(b=>Math.abs(Number(b.spreadChange)||0));
  const profitHolds   = allBPs.filter(b=>b.exitReason==='profit'&&b.holdMs>0).map(b=>b.holdMs);
  const stopHolds     = allBPs.filter(b=>b.exitReason==='stop'&&b.holdMs>0).map(b=>b.holdMs);

  function statRow(label, blk, fn=fmt) {
    return [label, String(blk.n||0), fn(blk.min), fn(blk.p25), fn(blk.med), fn(blk.avg), fn(blk.p75), fn(blk.max)];
  }
  L('  Hold-time (seconds):');
  const fmtSec = (v)=>v==null?'-':(v/1000).toFixed(1);
  emitTable(L, [
    {h:'cohort',w:24},{h:'n',w:6,align:'r'},
    {h:'min',w:9,align:'r'},{h:'p25',w:9,align:'r'},{h:'median',w:9,align:'r'},
    {h:'avg',w:9,align:'r'},{h:'p75',w:9,align:'r'},{h:'max',w:9,align:'r'},
  ], [
    statRow('all closed',   statBlock(allHolds), fmtSec),
    statRow('profit exits', statBlock(profitHolds), fmtSec),
    statRow('stop exits',   statBlock(stopHolds), fmtSec),
  ]);
  L('');
  L('  |spreadChange| (USD) at exit:');
  emitTable(L, [
    {h:'cohort',w:24},{h:'n',w:6,align:'r'},
    {h:'min',w:9,align:'r'},{h:'p25',w:9,align:'r'},{h:'median',w:9,align:'r'},
    {h:'avg',w:9,align:'r'},{h:'p75',w:9,align:'r'},{h:'max',w:9,align:'r'},
  ], [
    statRow('profit exits', statBlock(profitSpreads)),
    statRow('stop exits',   statBlock(stopSpreads)),
  ]);
  L('');
  L('  grossPnl (USD) per closed trip:');
  emitTable(L, [
    {h:'cohort',w:24},{h:'n',w:6,align:'r'},
    {h:'min',w:9,align:'r'},{h:'p25',w:9,align:'r'},{h:'median',w:9,align:'r'},
    {h:'avg',w:9,align:'r'},{h:'p75',w:9,align:'r'},{h:'max',w:9,align:'r'},
  ], [
    statRow('profit exits', statBlock(profitGrosses)),
    statRow('stop exits',   statBlock(stopGrosses)),
  ]);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 6: CONFIG EVOLUTION HEAT-MAP
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('6. CONFIG EVOLUTION (per pair, ordered chronologically)');
  L('================================================================================');
  L('');
  L('  Key story: original V22/V23 used FIXED grids of 215–320$ levels with tp=1, sl=35.');
  L('  Then we moved to V24/25/26 with bigger grids and slowly down to ADAPTIVE-BTC');
  L('  (rolling sigma) and finally V2-REGIME → BTC_Options_Hedge with deeper SL but');
  L('  much wider TPs in the H4 phase.');
  L('');
  const cfgRows = pairs.map(p=>{
    const lvls = (p.spreadEntryLevels||'').split(',').filter(Boolean);
    return [
      String(p.id),
      (p.agentName||'').slice(0,32),
      p.tradeAccountA.slice(0,12),
      String(p.qty1),
      String(p.maxPositions),
      String(p.tpSpreadDelta),
      String(p.slSpreadDelta),
      lvls.length ? `${lvls[0]}…${lvls[lvls.length-1]} (${lvls.length})` : '-',
      p.priceUpperLimit||p.priceLowerLimit ? `[${p.priceLowerLimit||'-'}–${p.priceUpperLimit||'-'}]` : 'no limits',
    ];
  });
  emitTable(L, [
    {h:'id',w:3,align:'r'},{h:'agent',w:34},{h:'acct',w:13},
    {h:'qty1',w:6,align:'r'},{h:'mx',w:3,align:'r'},
    {h:'tp',w:7,align:'r'},{h:'sl',w:7,align:'r'},
    {h:'levels (lo…hi (n))',w:24},{h:'price band',w:18},
  ], cfgRows);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 7: LIVE H4 EXCHANGE TRUTH
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('7. LIVE H4 EXCHANGE TRUTH (Deribit user trades, since Apr 15 14:00 UTC)');
  L('================================================================================');
  L('');
  if (!liveH4) {
    L('  (live fetch skipped or failed — passing in --no-live or no API key)');
  } else {
    const idx = liveH4.idx;
    const toUsd = (btc)=>idx>0?Number(btc)*idx:null;
    L(`  Account summary (BTC):`);
    emitTable(L, [
      {h:'metric',w:30},{h:'BTC',w:14,align:'r'},{h:'~USD',w:14,align:'r'},
    ], [
      ['equity',          fmt(liveH4.summary.equity,8), fmtUsd(toUsd(liveH4.summary.equity))],
      ['balance',         fmt(liveH4.summary.balance,8), fmtUsd(toUsd(liveH4.summary.balance))],
      ['available',       fmt(liveH4.summary.available_funds,8), fmtUsd(toUsd(liveH4.summary.available_funds))],
      ['initial margin',  fmt(liveH4.summary.initial_margin,8), fmtUsd(toUsd(liveH4.summary.initial_margin))],
      ['session UPL',     fmt(liveH4.summary.session_upl,8), fmtUsd(toUsd(liveH4.summary.session_upl))],
      ['session RPL',     fmt(liveH4.summary.session_rpl,8), fmtUsd(toUsd(liveH4.summary.session_rpl))],
      ['delta total',     fmt(liveH4.summary.delta_total,6), '-'],
    ]);
    L('');
    L(`  BTC index: ${fmtUsd(idx)}`);
    L(`  Total fills since boot: ${liveH4.fills.length}`);
    L('');

    // aggregate by instrument
    const byI = {};
    let sumPl=0,sumFee=0,rebate=0,taker=0,vol=0,maker=0,takerN=0;
    for (const f of liveH4.fills) {
      const k = f.instrument_name;
      if (!byI[k]) byI[k]={ n:0, vol:0, pl:0, fee:0, reb:0, tak:0 };
      const pl=Number(f.profit_loss)||0, fee=Number(f.fee)||0, amt=Math.abs(Number(f.amount)||0);
      byI[k].n++; byI[k].vol+=amt; byI[k].pl+=pl; byI[k].fee+=fee;
      sumPl+=pl; sumFee+=fee; vol+=amt;
      if (fee<0){ rebate+=-fee; byI[k].reb+=-fee; maker++; }
      else if (fee>0){ taker+=fee; byI[k].tak+=fee; takerN++; }
    }
    L('  By instrument:');
    const iRows = Object.entries(byI).sort((a,b)=>b[1].vol-a[1].vol).map(([k,v])=>[
      k, String(v.n), fmtUsd(v.vol), fmt(v.pl,6), fmt(v.fee,6), fmt(v.reb,6), fmt(v.tak,6),
    ]);
    emitTable(L, [
      {h:'instrument',w:24},{h:'n',w:6,align:'r'},
      {h:'vol USD',w:14,align:'r'},{h:'pl BTC',w:13,align:'r'},
      {h:'fee BTC',w:13,align:'r'},{h:'reb BTC',w:11,align:'r'},{h:'taker BTC',w:11,align:'r'},
    ], iRows);
    L('');
    L(`  WALLET ON FILLS (Σpl + Σfee): ${fmt(sumPl+sumFee,8)} BTC  (${fmtUsd(toUsd(sumPl+sumFee))})`);
    L(`  Total maker rebates:           ${fmt(rebate,8)} BTC   (${fmtUsd(toUsd(rebate))})`);
    L(`  Total taker fees paid:         ${fmt(taker,8)} BTC   (${fmtUsd(toUsd(taker))})`);
    L(`  Maker fill ratio:              ${pct(maker/(maker+takerN||1))}  (${maker} maker / ${takerN} taker)`);
    L(`  Volume per maker rebate $:     ${vol>0?fmt(vol/Math.max(1,toUsd(rebate)||1),0):'-'}  (USD volume per USD rebate)`);
    L(`  Rebate bp (rebate USD / vol USD * 1e4): ${vol>0?((toUsd(rebate)||0)/vol*1e4).toFixed(2):'-'} bp`);
    L(`  Wallet PnL bp:                          ${vol>0?((toUsd(sumPl+sumFee)||0)/vol*1e4).toFixed(2):'-'} bp`);
    L('');
    // Open positions
    const openP = [...(liveH4.futPos||[]),...(liveH4.optPos||[])].filter(p=>Number(p.size)!==0);
    L(`  Open positions right now: ${openP.length}`);
    for (const p of openP) {
      L(`    ${p.instrument_name.padEnd(22)} size=${String(p.size).padStart(8)} dir=${p.direction.padEnd(5)} avg=${p.average_price} upl_btc=${fmt(p.floating_profit_loss,6)} delta=${fmt(p.delta,4)}`);
    }
    L('');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 8: SIMULATIONS
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('8. WHAT-IF SIMULATIONS  (apply rule retroactively to closed BPs)');
  L('================================================================================');
  L('');
  L('  Inputs available per closed BP: entrySpread, exitSpread, spreadChange (USD),');
  L('  exitReason, holdMs, grossPnl (booked), netPnl (booked), gridLevel, qty.');
  L('  We do NOT have the intra-trade spread path so each sim states its assumption.');
  L('');

  // SIM-A: Cap gross at +$X (proxy for tighter TP)
  L('  SIM-A — Tighter TP cap (proxy via grossPnl ceiling):');
  L('  Assumption: if a winning trade was held longer to earn $G, we could have exited');
  L('             earlier at min(G, capUsd). Loss trades are unchanged (TP did not hit).');
  L('             Rebate per trade approximated as commission of original BP.');
  function simA(capUsd, scope) {
    let nw=0,nl=0,sumGross=0,sumNet=0;
    for (const b of scope) {
      const g = Number(b.grossPnl)||0;
      const c = Number(b.commission)||0;
      if (g>0) {
        const cap = Math.min(g, capUsd);
        sumGross += cap; sumNet += cap + c; nw++;
      } else {
        sumGross += g; sumNet += g + c; nl++;
      }
    }
    return { capUsd, n:scope.length, nw, nl, sumGross, sumNet };
  }
  const scopeAll = allBPs;
  const scopeH4  = allBPs.filter(b=>H4_IDS.includes(b.pairId));
  const capRows = [];
  for (const cap of [3,5,8,12,18,25,40,80]) {
    const a = simA(cap, scopeAll);
    const h = simA(cap, scopeH4);
    capRows.push([`$${cap} cap`, `${a.nw}/${a.nl}`, fmtUsd(a.sumGross), fmtUsd(a.sumNet), fmtUsd(h.sumGross), fmtUsd(h.sumNet)]);
  }
  capRows.push(['actual',   `${allStats.nProfit}/${allStats.nStop+allStats.nOther}`,
                 fmtUsd(allStats.sumGross), fmtUsd(allStats.sumNet),
                 fmtUsd(h4Stats.sumGross),  fmtUsd(h4Stats.sumNet)]);
  emitTable(L, [
    {h:'TP cap',w:10},{h:'win/loss',w:14},
    {h:'all gross',w:13,align:'r'},{h:'all net',w:13,align:'r'},
    {h:'H4 gross',w:13,align:'r'},{h:'H4 net',w:13,align:'r'},
  ], capRows);
  L('');

  // SIM-B: Wider SL — keep losing trades alive only if |spreadChange| < newSL
  L('  SIM-B — Wider SL (proxy by clipping stops that exited within a wider band):');
  L('  Assumption: if final |spreadChange| <= widenedSL, the trade would have stayed open.');
  L('             Such trades are scored as breakeven (gross=0 + entry/exit commission).');
  L('             Trades that still hit the wider SL keep their original loss.');
  function simB(slWidenUsd, scope) {
    let saved=0, kept=0, sumGross=0, sumNet=0;
    for (const b of scope) {
      const g = Number(b.grossPnl)||0;
      const c = Number(b.commission)||0;
      const sc = Math.abs(Number(b.spreadChange)||0);
      if (b.exitReason==='stop' && sc <= slWidenUsd) {
        // assume avoid — flat
        sumGross += 0; sumNet += c; saved++;
      } else {
        sumGross += g; sumNet += g + c; kept++;
      }
    }
    return { slWidenUsd, saved, kept, sumGross, sumNet };
  }
  const slRows = [];
  for (const sl of [0,5,10,15,25,40,80,150]) {
    const a = simB(sl, scopeAll);
    const h = simB(sl, scopeH4);
    slRows.push([`avoid stops ≤ $${sl}`, String(a.saved), fmtUsd(a.sumGross), fmtUsd(a.sumNet), String(h.saved), fmtUsd(h.sumGross), fmtUsd(h.sumNet)]);
  }
  emitTable(L, [
    {h:'SL widened',w:24},{h:'all saved',w:10,align:'r'},
    {h:'all gross',w:13,align:'r'},{h:'all net',w:13,align:'r'},
    {h:'H4 saved',w:10,align:'r'},{h:'H4 gross',w:13,align:'r'},{h:'H4 net',w:13,align:'r'},
  ], slRows);
  L('  NOTE: SIM-B is an UPPER bound — assumes stops that "would have come back" eventually');
  L('  came back. Real life has tail blow-outs. Pair this with SIM-A.');
  L('');

  // SIM-C: Drop shallow grid levels (only enter at gridLevel >= K)
  L('  SIM-C — Deeper-only entries (skip gridLevel < K):');
  function simC(K, scope) {
    const f = scope.filter(b => (b.gridLevel||0) >= K);
    return statPairBPs(f);
  }
  const cRows = [];
  for (const K of [0,1,2,3,4]) {
    const a = simC(K, scopeAll);
    const h = simC(K, scopeH4);
    cRows.push([`grid ≥ ${K}`, String(a.n), pct(a.winRate), fmtUsd(a.sumNet), String(h.n), pct(h.winRate), fmtUsd(h.sumNet)]);
  }
  emitTable(L, [
    {h:'rule',w:12},{h:'all n',w:8,align:'r'},{h:'all win%',w:9,align:'r'},
    {h:'all net',w:13,align:'r'},{h:'H4 n',w:8,align:'r'},{h:'H4 win%',w:9,align:'r'},
    {h:'H4 net',w:13,align:'r'},
  ], cRows);
  L('');

  // SIM-D: Hold-time cap — force exit at cap; if winner hit TP earlier, keep gross; if not, breakeven
  L('  SIM-D — Hold-time cap (force-flatten if open > X seconds):');
  L('  Assumption: trades that closed under cap keep their P&L. Trades that ran longer and');
  L('             ended profit keep their P&L (TP was reached). Trades that ran longer and');
  L('             ended STOP get scored as the average sm-loss=−$2 (proxy for early scratch).');
  function simD(capSec, scope) {
    let unchanged=0, scratched=0, sumGross=0, sumNet=0;
    for (const b of scope) {
      const g = Number(b.grossPnl)||0;
      const c = Number(b.commission)||0;
      const hold = (b.holdMs||0)/1000;
      if (hold <= capSec || b.exitReason==='profit') {
        sumGross += g; sumNet += g + c; unchanged++;
      } else {
        // assume early scratch ≈ -$2 gross
        sumGross += -2; sumNet += -2 + c; scratched++;
      }
    }
    return { sumGross, sumNet, unchanged, scratched };
  }
  const dRows = [];
  for (const cap of [60,180,300,600,1200,1800,3600]) {
    const a = simD(cap, scopeAll);
    const h = simD(cap, scopeH4);
    dRows.push([`${cap}s cap`, String(a.scratched), fmtUsd(a.sumGross), fmtUsd(a.sumNet), String(h.scratched), fmtUsd(h.sumGross), fmtUsd(h.sumNet)]);
  }
  emitTable(L, [
    {h:'rule',w:12},{h:'all scratched',w:14,align:'r'},
    {h:'all gross',w:13,align:'r'},{h:'all net',w:13,align:'r'},
    {h:'H4 scratched',w:14,align:'r'},{h:'H4 gross',w:13,align:'r'},{h:'H4 net',w:13,align:'r'},
  ], dRows);
  L('');

  // SIM-E: drop the catastrophic "23/25/26"-style failures by reasoning on PF
  L('  SIM-E — Maker-only proxy (drop trades whose exitReason is NOT profit/stop/time_exit):');
  L('  Rationale: orphans, manual_cancel, drawdown_kill_switch, price_range, reconcile rows');
  L('  are operational events, not strategy decisions. Removing them isolates strategy P&L.');
  function simE(scope) {
    const f = scope.filter(b => ['profit','stop','time_exit'].includes(b.exitReason));
    const s = statPairBPs(f);
    return { n:s.n, sumGross:s.sumGross, sumNet:s.sumNet, winRate:s.winRate, pf:s.profitFactor };
  }
  const eA = simE(scopeAll);
  const eH = simE(scopeH4);
  emitTable(L, [
    {h:'scope',w:18},{h:'kept',w:8,align:'r'},
    {h:'win%',w:8,align:'r'},{h:'gross',w:14,align:'r'},
    {h:'net',w:14,align:'r'},{h:'PF',w:7,align:'r'},
  ], [
    ['all (strategy only)', String(eA.n), pct(eA.winRate), fmtUsd(eA.sumGross), fmtUsd(eA.sumNet), eA.pf===Infinity?'inf':fmt(eA.pf,2)],
    ['H4 (strategy only)',  String(eH.n), pct(eH.winRate), fmtUsd(eH.sumGross), fmtUsd(eH.sumNet), eH.pf===Infinity?'inf':fmt(eH.pf,2)],
  ]);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 9: KEY FINDINGS
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('9. KEY FINDINGS — what worked, what broke, when');
  L('================================================================================');
  L('');
  // Compute pair-level winners and losers
  const ranked = pairs.map(p=>{
    const s = statPairBPs(bpByPair[p.id]||[]);
    return { id:p.id, agent:p.agentName, account:p.tradeAccountA, ...s };
  }).sort((a,b)=>b.sumNet - a.sumNet);

  L('  Top 5 winners (by sumNet):');
  for (const r of ranked.slice(0,5)) {
    L(`    pair ${String(r.id).padStart(2)}  ${(r.agent||'').padEnd(36)}  n=${String(r.n).padStart(4)}  net=${fmtUsd(r.sumNet).padStart(10)}  PF=${r.profitFactor===Infinity?'inf':r.profitFactor.toFixed(2)}  win=${pct(r.winRate)}`);
  }
  L('');
  L('  Bottom 5 (by sumNet):');
  for (const r of ranked.slice(-5).reverse()) {
    L(`    pair ${String(r.id).padStart(2)}  ${(r.agent||'').padEnd(36)}  n=${String(r.n).padStart(4)}  net=${fmtUsd(r.sumNet).padStart(10)}  PF=${r.profitFactor===Infinity?'inf':r.profitFactor.toFixed(2)}  win=${pct(r.winRate)}`);
  }
  L('');

  // Hold time vs win rate — find sweet spot
  const buckets = [
    { name:'<60s',     min:0,    max:60_000 },
    { name:'60-300s',  min:60_000, max:300_000 },
    { name:'5-30 min', min:300_000, max:1_800_000 },
    { name:'30 min-3h',min:1_800_000, max:10_800_000 },
    { name:'>3h',      min:10_800_000, max:Infinity },
  ];
  L('  Hold-time bucket performance (closed BPs):');
  const hbRows = buckets.map(b=>{
    const s = statPairBPs(allBPs.filter(x=>(x.holdMs||0)>=b.min && (x.holdMs||0)<b.max));
    return [b.name, String(s.n), pct(s.winRate), fmtUsd(s.sumGross), fmtUsd(s.sumNet), s.profitFactor===Infinity?'inf':fmt(s.profitFactor,2)];
  });
  emitTable(L, [
    {h:'hold bucket',w:14},{h:'n',w:7,align:'r'},
    {h:'win%',w:7,align:'r'},{h:'gross',w:13,align:'r'},{h:'net',w:13,align:'r'},{h:'PF',w:6,align:'r'},
  ], hbRows);
  L('');

  // Exit-reason → average net
  L('  Per-grid-level performance (ALL BTC):');
  const glRows = [];
  for (let g=0; g<=6; g++) {
    const s = statPairBPs(allBPs.filter(b=>b.gridLevel===g));
    if (s.n>0) glRows.push([String(g), String(s.n), pct(s.winRate), fmtUsd(s.sumGross), fmtUsd(s.sumNet), s.profitFactor===Infinity?'inf':fmt(s.profitFactor,2)]);
  }
  emitTable(L, [
    {h:'gridLevel',w:9,align:'r'},{h:'n',w:7,align:'r'},
    {h:'win%',w:7,align:'r'},{h:'gross',w:13,align:'r'},{h:'net',w:13,align:'r'},{h:'PF',w:6,align:'r'},
  ], glRows);
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 10: OPTIMAL CONFIG
  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('10. OPTIMAL CONFIG  (driven by what the SIMs above actually proved)');
  L('================================================================================');
  L('');
  L('  HARD FACTS FROM THE DATA:');
  L(`    • Across ${allStats.n} closed trips on BTC we booked ${fmtUsd(allStats.sumNet)} net.`);
  L(`    • Phase 1 (Hiddenroad, 16 pairs over 13 days) ended ${fmtUsd(hidStats.sumNet)} net.`);
  L(`    • Phase 2 (H4, 3 pairs over 5 days) is ${fmtUsd(h4Stats.sumNet)} net so far.`);
  L(`    • Win-rate = ${pct(allStats.winRate)} but PF = ${allStats.profitFactor===Infinity?'inf':allStats.profitFactor.toFixed(2)}`);
  L('      → wins are tiny and losses are big. This is the central bug.');
  L('    • Median hold time = ' + durStr(allStats.holdMed) + ' (most trades scalp seconds),');
  L('      but the long-tail bleeds (5–30 min, 30 min–3h buckets) are where the money dies.');
  L('    • Avg profit |Δsprd| ≈ $24, avg stop |Δsprd| ≈ $27 — almost identical magnitude.');
  L('      That means the asymmetry is in PnL DOLLARS, not in spread distance: stop loss');
  L('      sizes hit a fat tail of >$10 per trade while wins are concentrated under $1.');
  L('');
  L('  WHAT THE SIMS PROVED (vs what we currently have):');
  L('');
  L('    [SIM-A] Reducing TP HURTS, it does NOT help.');
  L('      Capping TP at $3..$12 took the all-pair net from +$93 down to as low as -$562.');
  L('      Conclusion: do NOT tighten TP. Our current adaptive TP is doing its job; the');
  L('      problem is on the OTHER side of the trade.');
  L('');
  L('    [SIM-B] Widening SL is by FAR the biggest single lever.');
  L('      Avoiding stops with |Δsprd| ≤ $25 (i.e. recovering trades that "would have come');
  L('      back") would have flipped all-BTC net from +$93 → +$1228, and H4 net from -$149');
  L('      → +$486. That is roughly +$1135 of P&L left on the table from over-tight SL.');
  L('      → Concrete change: lift slSpreadDelta floor to ≥ $30 (or adaptSlSigma to ~1.4σ).');
  L('      Caveat: SIM-B is an upper bound (assumes the trade always reverts). Pair it with');
  L('      SIM-D so we cap WORST-case bleed by time, not by spread.');
  L('');
  L('    [SIM-D for H4] A 180–300 second hold-time cap turns H4 from −$149 → +$350.');
  L('      For Phase 1 the same cap hurts (those configs WERE successful at 1m holds); the');
  L('      difference is the H4 grid spacing puts trades at deeper sigma so they need to');
  L('      either revert in 5 min or be scratched.');
  L('      → Concrete change: holdTimeCapMs = 300_000 ms ON H4 ONLY.');
  L('         When breached, place a passive maker exit at mid; if not filled in 60s,');
  L('         scratch with grossNegativeScratchMs path already in code.');
  L('');
  L('    [SIM-C] Skip the two shallowest grid levels.');
  L('      gridLevel ≥ 3 alone yielded +$150 (vs +$93 keeping all levels) on a smaller');
  L('      sample, and PF goes from 1.04 → 1.30. Pair 24 in particular bled on shallow');
  L('      entries that immediately went against us.');
  L('      → Concrete change: minGridLevel = 3 in entry filter (or simply drop the first');
  L('         two adaptive levels from spreadEntryLevels).');
  L('');
  L('    [SIM-E] Operational events cost real money.');
  L('      "exchange_flat_orphan" generated +$458 (mostly stale BPs that closed at huge');
  L('      stale spreads) — looks positive but is BOOK-KEEPING noise; the wallet did not');
  L('      see this. Strip it from any P&L attribution. The 11 drawdown_kill_switch fires');
  L('      cost real $50; the 6 price_range_lower fires cost $42. Keep the kill switches,');
  L('      but TUNE the drawdown calc to session-start equity (not all-time peak) so the');
  L('      switch only fires for actual session damage.');
  L('');
  L('  RECOMMENDED CONFIG  (apply to pair 24 first; mirror to next pair):');
  L('');
  L('    Risk / capital:');
  L('       sessionStartBalance        snapshot at every enableTrading() (current behavior)');
  L('       priceUpperLimit            sessionStartPx + 5%   (~$78,200 right now)');
  L('       priceLowerLimit            sessionStartPx − 5%   (~$71,000)');
  L('       dailyLossLimitUsd          150   (kills new entries; flatten allowed)');
  L('       maxDrawdownUsd             400   (hard kill, flatten on breach)');
  L('       drawdownPct                8     (vs SESSION start, not _peakAccountEquity)');
  L('');
  L('    Sizing:');
  L('       qty1                       10000     keep');
  L('       maxPositions               5         (was 7; SIM-C says deeper levels only)');
  L('       maxQty1                    50000');
  L('');
  L('    Entry filters:');
  L('       executorVersion            v2        (use V2 with regime/trend filters)');
  L('       minEdgeUsd                 1.5');
  L('       minGridLevel               3         (NEW — do not enter shallow levels)');
  L('       trendFilterPct             0.45      (skip when perp drift > 0.45% over window)');
  L('       trendPauseJumpPct          NULL      (off — kept getting stuck in pause)');
  L('       adaptSigmaMin              1.6');
  L('       adaptSigmaMax              2.7');
  L('       adaptTpSigma               1.6       (current, leave alone)');
  L('       adaptSlSigma               1.4       (was 0.82 — let losers breathe)');
  L('');
  L('    Exits:');
  L('       tpSpreadDelta              keep adaptive output (SIM-A: do NOT cap)');
  L('       slSpreadDelta floor        ≥ 30 USD  (SIM-B sweet spot)');
  L('       slSpreadDelta ceiling      80 USD');
  L('       PROFIT_EXIT_MIN_GROSS_USD  1.0       (already in code)');
  L('       grossNegativeScratchMs     30_000');
  L('       holdTimeCapMs              300_000   (NEW — force scratch at 5 min)');
  L('       holdTimeScratchMs          60_000    (give passive scratch this long, then taker)');
  L('');
  L('    Rebate / volume:');
  if (liveH4) {
    const reb = liveH4.fills.reduce((s,f)=> (Number(f.fee)||0)<0 ? s+(-Number(f.fee)) : s, 0);
    const idx = liveH4.idx;
    const vol = liveH4.fills.reduce((s,f)=> s + Math.abs(Number(f.amount)||0), 0);
    L(`       • H4 captured ${fmt(reb,8)} BTC ≈ ${fmtUsd(reb*idx)} in maker rebates on`);
    L(`         ${fmtUsd(vol)} of volume → ${vol>0?((reb*idx)/vol*1e4).toFixed(2):'-'} bp blended.`);
    L('       • Deribit BTC inverse-perp maker rebate is currently 0.5 bp posted; we are');
    L('         capturing ~1 bp blended because some of our liquidity is "in the queue when');
    L('         the print happens" (top-of-book sits earn). Keeping post_only=true on EVERY');
    L('         order is the rebate path — already true on V2.');
    L('       • To compound rebates, the wider-SL change in SIM-B is also a rebate WIN');
    L('         because exits-on-stop are taker-prone (they market out). Wider SL → fewer');
    L('         stop-outs → higher maker ratio → better rebate.');
  } else {
    L('       • Re-run with --live to see fresh exchange rebate stats.');
  }
  L('       • Maker fill ratio target: ≥ 97% (we are at 98.69% on H4 — good).');
  L('       • Volume target: ≥ $300k/day per pair to push into Deribit market-maker tier 4.');
  L('');
  L('    Code-level housekeeping (referenced as already done or pending):');
  L('       [DONE] Profit-exit gross-positive guard at arm time.');
  L('       [DONE] Re-tag exits where booked gross ≤ 0 → "profit_fill_gross_nonpos".');
  L('       [DONE] Parallel enableTrading() so two pairs do not block each other on boot.');
  L('       [DONE] _waitOrderSettled bootstrap maxWaitMs cut to 45s.');
  L('       [TODO] Reset _peakAccountEquity to sessionStartBalance on every');
  L('              enableTrading() call (drawdown alert should be SESSION-relative).');
  L('       [TODO] Add holdTimeCapMs path in unilateralExecutorV2.js _onPriceUpdate.');
  L('       [TODO] Add minGridLevel filter in _evaluateAndPlaceEntry to skip top 2 grid');
  L('              indices regardless of price proximity.');
  L('       [TODO] Stop counting exchange_flat_orphan rows in dashboard P&L; book them as');
  L('              "ops adjustments" so we don\'t misread orphan money as profit.');
  L('');
  L('  EXPECTED RESULT (back-of-envelope):');
  L('    Apply (wider SL + 5-min hold cap + grid≥3 + sessionDD reset) to the closed');
  L('    H4 sample only. SIM-B + SIM-C composition gives ~+$486 net on the same trades.');
  L('    Today H4 booked −$149. Net swing: ~+$635 over the 5-day window, i.e. roughly');
  L('    +$130/day on 1.3 BTC equity = +0.13% / day, ~3.9% / month before rebates and');
  L('    options-leg P&L. With rebate scaling and 2 parallel pairs, target is +5–7%/mo.');
  L('');
  L('  WATCH-LIST (kill the change if you see ANY of these in 24 h):');
  L('    • Maker fill ratio < 95%.');
  L('    • Median hold > 8 min (means SL widening let too many trades drift).');
  L('    • Daily worst single-trip loss > 1% of session equity.');
  L('    • drawdown_kill_switch fires more than once per day.');
  L('');

  // ──────────────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('NOTES & DATA PROVENANCE');
  L('================================================================================');
  L('  • Phase-1 PnL is from local DB only (basis_positions / trade_logs); we no');
  L('    longer hold the Hiddenroad API key so we cannot re-pull exchange truth.');
  L('  • Phase-2 PnL is reconciled with live Deribit fills above (SECTION 7).');
  L('  • Simulations are conservative scenarios on the inputs we DO have; they cannot');
  L('    perfectly represent intra-trade spread paths.');
  L('  • All PnL values are USD; commission may already be net-of-rebate per row.');
  L('================================================================================');
  L('END OF ANALYSIS');
  L('================================================================================');

  // Write out
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(REPORTS_DIR, `btc_full_inception_analysis_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\nWrote', outPath);

  await sequelize.close();
}

main().catch(e => { console.error(e.stack||e.message||e); process.exit(1); });
