#!/usr/bin/env node
/**
 * ethFullReconAndSim.js
 *
 *   1-to-1 reconciliation + extended simulation
 *
 *   Phase 1: Fetch full txlog (ALL types, not just trade) from Apr 16 onwards.
 *   Phase 2: Group fills by order_id → per-order aggregates (entry vs exit).
 *   Phase 3: Join against DB basis_positions via legA_entryOrderId / legA_exitOrderId.
 *            Flag any DB row that doesn't match exchange reality.
 *   Phase 4: Compute per-stop realized slippage distribution (SL slip ~ f(qty, regime)).
 *   Phase 5: Run extended simulation grid:
 *              - zEntryThreshold:   [1.2, 1.4, 1.6, 1.8, 2.0]
 *              - minEdgeUsd:        [null, 1, 2, 3]
 *              - maxHoldMs:         [30000, 45000, 60000]
 *              - maxSingleLossUsd:  [null, 3, 5]
 *              - disableIstHours:   [none, worst-5, worst-3]
 *              - qty_scale:         [1.0, 0.5, 0.25]  (analytic, not replay)
 *              - spreadRegime filter (entrySpread < median, < Q1, etc.)
 *   Phase 6: Rank by NET per DAY (gross + rebate - commission for sim count).
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { StatArbInput, BasisPosition, AccountDetails, sequelize } = require('../src/models');
const { Op } = require('sequelize');

const CCY      = 'ETH';
const PERP     = 'ETH-PERPETUAL';
const START_MS = Date.UTC(2026, 3, 16, 0, 0, 0);
const END_MS   = Date.now();
const PAIR_IDS = [22, 23, 25, 26];

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

async function fetchTxLog(token) {
  const all = []; let cont;
  for (let i=0;i<1000;i++) {
    await sleep(200);
    const params = { currency: CCY, start_timestamp: START_MS, end_timestamp: END_MS, count: 1000 };
    if (cont) params.continuation = cont;
    let r;
    for (let a=0;a<5;a++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{
        headers:{Authorization:`Bearer ${token}`}, params, timeout:30000, validateStatus:()=>true});
      if (r.status===429 || r.data?.error?.code===10028) { await sleep(5000*(a+1)); continue; }
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

const fmtTs = ms => new Date(ms).toISOString().replace('T',' ').replace('Z',' UTC');
const sgn   = n => n>=0?'+':'';
const pct   = (n,d) => d ? ((n/d)*100).toFixed(1)+'%' : '0.0%';
const istHour = d => {
  const dt = new Date(d);
  const utcMin = dt.getUTCHours()*60 + dt.getUTCMinutes();
  return Math.floor(((utcMin + 330) % 1440) / 60);
};

(async () => {
  const anyPair = await StatArbInput.findByPk(26);
  const acc = await AccountDetails.findOne({ where: { Trade_Account: anyPair.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  const idxR = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
  const ethUsd = idxR?.data?.result?.index_price || 2315;

  console.log(`\nETH FULL RECONCILIATION + EXTENDED SIM`);
  console.log(`  Window   : ${fmtTs(START_MS)}  →  ${fmtTs(END_MS)}`);
  console.log(`  ETH/USD  : $${ethUsd.toFixed(2)}`);
  console.log(`  Pairs    : ${PAIR_IDS.join(',')}\n`);

  // ═══ PHASE 1: Full txlog ═══
  const all = await fetchTxLog(token);
  console.log(`\n  § Phase 1: TXLOG BREAKDOWN (all types)`);
  const byType = {}, byInstrument = {};
  for (const r of all) {
    byType[r.type] = (byType[r.type]||0) + 1;
    byInstrument[r.instrument_name || '_'] = (byInstrument[r.instrument_name || '_']||0) + 1;
  }
  for (const [k,v] of Object.entries(byType).sort((a,b)=>b[1]-a[1])) console.log(`    ${k.padEnd(18)}: ${v}`);

  const perpTrades = all.filter(r => r.instrument_name === PERP && r.type === 'trade');
  const perpFund   = all.filter(r => r.instrument_name === PERP && r.type === 'funding');
  const settle     = all.filter(r => r.type === 'settlement');
  const delivery   = all.filter(r => r.type === 'delivery');
  const transfer   = all.filter(r => r.type === 'transfer');
  const deposit    = all.filter(r => r.type === 'deposit');
  const optTrades  = all.filter(r => r.instrument_name !== PERP && r.type === 'trade');

  const perpVol = perpTrades.reduce((s,r)=>s+Math.abs(r.amount),0);
  const perpCash = perpTrades.reduce((s,r)=>s+(r.cashflow||0),0);
  const perpComm = perpTrades.reduce((s,r)=>s+(r.commission||0),0);
  const perpFundE = perpFund.reduce((s,r)=>s+(r.interest_pl||0),0);
  const setE = settle.reduce((s,r)=>s+(r.change||0),0);
  const delE = delivery.reduce((s,r)=>s+(r.change||0),0);
  const depE = deposit.reduce((s,r)=>s+(r.change||0),0);
  const trfE = transfer.reduce((s,r)=>s+(r.change||0),0);

  console.log(`\n  § ETH-PERPETUAL totals (5.3 days):`);
  console.log(`    perp trades     : ${perpTrades.length}    volume: $${perpVol.toLocaleString('en-US',{maximumFractionDigits:0})}`);
  console.log(`    perp cashflow   : ${perpCash.toFixed(6)} ETH ($${(perpCash*ethUsd).toFixed(2)})`);
  console.log(`    perp commission : ${perpComm.toFixed(6)} ETH ($${(perpComm*ethUsd).toFixed(2)}) ${perpComm<0?'← rebate credit':'← fee paid'}`);
  console.log(`    perp funding    : ${perpFundE.toFixed(6)} ETH ($${(perpFundE*ethUsd).toFixed(2)})`);
  console.log(`    settlement      : ${setE.toFixed(6)} ETH ($${(setE*ethUsd).toFixed(2)})  [options settlement, not trading]`);
  console.log(`    delivery        : ${delE.toFixed(6)} ETH ($${(delE*ethUsd).toFixed(2)})`);
  console.log(`    deposits        : ${depE.toFixed(6)} ETH`);
  console.log(`    transfers       : ${trfE.toFixed(6)} ETH`);
  console.log(`    options trades  : ${optTrades.length}  (EXCLUDED from analysis per rule)`);
  console.log(`    NET trading     : ${(perpCash + perpComm + perpFundE).toFixed(6)} ETH ($${((perpCash + perpComm + perpFundE)*ethUsd).toFixed(2)})`);

  // ═══ PHASE 2: Per-order fill aggregation ═══
  console.log(`\n  § Phase 2: GROUPING FILLS BY ORDER_ID`);
  const byOrderId = new Map();
  for (const r of perpTrades) {
    const oid = r.order_id;
    if (!byOrderId.has(oid)) byOrderId.set(oid, []);
    byOrderId.get(oid).push(r);
  }
  console.log(`    unique orders   : ${byOrderId.size}`);
  const fillsPerOrder = [...byOrderId.values()].map(f => f.length);
  const avgFills = fillsPerOrder.reduce((s,n)=>s+n,0) / (fillsPerOrder.length || 1);
  const maxFills = Math.max(...fillsPerOrder, 0);
  console.log(`    avg fills/order : ${avgFills.toFixed(2)}    max fills/order: ${maxFills}`);

  // Aggregate per order: weighted avg price, total qty, total cashflow, commission, first/last ts
  const orderAgg = new Map();
  for (const [oid, fills] of byOrderId) {
    const totalQty = fills.reduce((s,f)=>s+Math.abs(f.amount),0);
    const notional = fills.reduce((s,f)=>s+Math.abs(f.amount),0);
    const wap = fills.reduce((s,f)=>s + f.price * Math.abs(f.amount), 0) / notional;
    const cash = fills.reduce((s,f)=>s+(f.cashflow||0),0);
    const comm = fills.reduce((s,f)=>s+(f.commission||0),0);
    const firstTs = Math.min(...fills.map(f=>f.timestamp));
    const lastTs  = Math.max(...fills.map(f=>f.timestamp));
    const side = fills[0].side;
    const fillTimeMs = lastTs - firstTs;
    orderAgg.set(oid, { oid, qty: totalQty, notional, wap, cash, comm, firstTs, lastTs, fillTimeMs, side, nFills: fills.length });
  }

  // ═══ PHASE 3: Join DB basis_positions ═══
  console.log(`\n  § Phase 3: DB ↔ EXCHANGE RECONCILIATION`);
  const dbRows = await BasisPosition.findAll({
    where: {
      pairId: { [Op.in]: PAIR_IDS },
      state: 'closed',
      entryTime: { [Op.gte]: new Date(START_MS), [Op.lte]: new Date(END_MS) }
    },
    attributes: ['id','pairId','direction','entryTime','exitTime','holdMs','grossPnl','commission','netPnl','exitReason','legA_entryPrice','legA_exitPrice','legA_entryOrderId','legA_exitOrderId','legA_entryQty','entrySpread','exitSpread']
  });
  const db = dbRows.map(r => r.toJSON());
  console.log(`    DB round-trips  : ${db.length}`);

  let matched = 0, unmatchedEntry = 0, unmatchedExit = 0;
  const reconciled = [];
  for (const b of db) {
    const entOrd = orderAgg.get(b.legA_entryOrderId);
    const exOrd  = orderAgg.get(b.legA_exitOrderId);
    if (!entOrd) unmatchedEntry++;
    if (!exOrd)  unmatchedExit++;
    if (entOrd && exOrd) matched++;
    // compute actual slip: entry wap vs DB entry price, exit wap vs DB exit price
    const entrySlipTicks = (entOrd && b.legA_entryPrice) ? (entOrd.wap - b.legA_entryPrice) : null;
    const exitSlipTicks  = (exOrd  && b.legA_exitPrice)  ? (exOrd.wap  - b.legA_exitPrice)  : null;
    reconciled.push({ ...b, entOrd, exOrd, entrySlipTicks, exitSlipTicks });
  }
  console.log(`    matched         : ${matched} (${(matched/db.length*100).toFixed(1)}%)`);
  console.log(`    unmatched entry : ${unmatchedEntry}`);
  console.log(`    unmatched exit  : ${unmatchedExit}`);

  // ═══ PHASE 4: Realized slip per stop, by pair & qty ═══
  console.log(`\n  § Phase 4: REALIZED SLIP ANALYSIS`);
  console.log(`    (by pair, stop exits only)`);
  console.log(`    pair  qty      n     avgStop$   avgFills   avgFillMs  worstStop$`);
  console.log(`    ────────────────────────────────────────────────────────────────`);
  const pairs = await StatArbInput.findAll({ where: { id: { [Op.in]: PAIR_IDS } }, attributes: ['id','qty1'] });
  const pairQty = Object.fromEntries(pairs.map(p => [p.id, p.qty1]));
  for (const pid of PAIR_IDS) {
    const stops = reconciled.filter(r => r.pairId === pid && (r.exitReason||'').includes('stop'));
    if (!stops.length) { console.log(`    ${pid}    ${pairQty[pid]}    n=0`); continue; }
    const avgStop = stops.reduce((s,r)=>s+Number(r.grossPnl||0),0)/stops.length;
    const worstStop = Math.min(...stops.map(r=>Number(r.grossPnl||0)));
    const avgFills = stops.reduce((s,r)=>s+(r.exOrd?.nFills||0),0)/stops.length;
    const avgFillMs = stops.reduce((s,r)=>s+(r.exOrd?.fillTimeMs||0),0)/stops.length;
    console.log(`    ${String(pid).padEnd(4)}  ${String(pairQty[pid]).padEnd(7)} ${String(stops.length).padStart(3)}   ${avgStop.toFixed(2).padStart(8)}   ${avgFills.toFixed(1).padStart(6)}     ${avgFillMs.toFixed(0).padStart(7)}ms   ${worstStop.toFixed(2)}`);
  }

  // Slip model: realized avg stop vs qty — regress: avgStop = a + b*qty
  const pairStops = PAIR_IDS.map(pid => {
    const stops = reconciled.filter(r => r.pairId === pid && (r.exitReason||'').includes('stop'));
    if (!stops.length || !pairQty[pid]) return null;
    return { pid, qty: pairQty[pid], avgStop: stops.reduce((s,r)=>s+Number(r.grossPnl||0),0)/stops.length, n: stops.length };
  }).filter(Boolean);

  // Weighted linear fit: avgStop = a + b * qty
  const sumQ = pairStops.reduce((s,p)=>s+p.qty*p.n,0);
  const sumA = pairStops.reduce((s,p)=>s+p.avgStop*p.n,0);
  const sumQA = pairStops.reduce((s,p)=>s+p.qty*p.avgStop*p.n,0);
  const sumQQ = pairStops.reduce((s,p)=>s+p.qty*p.qty*p.n,0);
  const nTot = pairStops.reduce((s,p)=>s+p.n,0);
  const b = (nTot*sumQA - sumQ*sumA) / (nTot*sumQQ - sumQ*sumQ);
  const a = (sumA - b*sumQ) / nTot;
  console.log(`\n    slip model  : avgStop$ ≈ ${a.toFixed(4)} + (${b.toFixed(7)}) × qty`);
  console.log(`    at qty=47000: ${(a + b*47000).toFixed(2)}`);
  console.log(`    at qty=23500: ${(a + b*23500).toFixed(2)}`);
  console.log(`    at qty=10000: ${(a + b*10000).toFixed(2)}`);

  // ═══ PHASE 5: Extended simulation grid ═══
  console.log(`\n  § Phase 5: EXTENDED SIMULATION GRID`);

  // Filter to pair 26 ONLY (active pair)
  const p26 = db.filter(d => d.pairId === 26);
  console.log(`    pair 26 trades  : ${p26.length}`);

  // Helper: entry spread quartiles
  const entrySpreads = p26.map(d=>Number(d.entrySpread)||0).sort((x,y)=>x-y);
  const Q = (p) => entrySpreads[Math.floor(entrySpreads.length*p)];
  const q1Spread = Q(0.25), medianSpread = Q(0.5), q3Spread = Q(0.75);
  console.log(`    entrySpread Q1=${q1Spread.toFixed(3)} median=${medianSpread.toFixed(3)} Q3=${q3Spread.toFixed(3)}`);

  function simPair26(cfg) {
    // cfg: { maxHoldMs, maxLossUsd, disableHrs, spreadMin, spreadMax, qtyScale }
    let gross=0, wins=0, losses=0, n=0, stops=0, capped=0, holdTrim=0;
    for (const t of p26) {
      const es = Number(t.entrySpread) || 0;
      if (cfg.spreadMin != null && es < cfg.spreadMin) continue;
      if (cfg.spreadMax != null && es > cfg.spreadMax) continue;
      const ih = istHour(t.entryTime);
      if (cfg.disableHrs && cfg.disableHrs.has(ih)) continue;

      let g = Number(t.grossPnl) || 0;
      const reason = (t.exitReason||'').toLowerCase();
      const holdMs = Number(t.holdMs) || 0;

      // hold-cap clip (linear proxy for losers)
      if (cfg.maxHoldMs && holdMs > cfg.maxHoldMs && holdMs > 0) {
        const frac = cfg.maxHoldMs / holdMs;
        g = g < 0 ? g * frac : g * Math.max(frac, 0.7);  // winners lose less
        holdTrim++;
      }
      // qty-scaling: all PnL scales linearly with qty (conservative — ignores non-linear liquidity)
      if (cfg.qtyScale && cfg.qtyScale !== 1.0) {
        g = g * cfg.qtyScale;
      }
      // hard USD cap
      if (cfg.maxLossUsd != null) {
        const floor = -Math.abs(cfg.maxLossUsd);
        if (g < floor) { g = floor; capped++; }
      }
      gross += g;
      if (g > 0) wins++; else losses++;
      if (reason.includes('stop')) stops++;
      n++;
    }
    return { n, gross, wins, losses, stops, capped, holdTrim, winRate: n?wins/n:0 };
  }

  // Baseline for reference
  const baseline = simPair26({ maxHoldMs: null, maxLossUsd: null, disableHrs: null, spreadMin: null, spreadMax: null, qtyScale: 1.0 });
  console.log(`    baseline (pair 26 as-is): n=${baseline.n} gross=$${baseline.gross.toFixed(2)} WR=${(baseline.winRate*100).toFixed(1)}% stops=${baseline.stops}`);

  // Rebate per $1 notional from exchange totals
  const pair26VolShare = 0.46; // approximate share of total volume (from master sim); will normalize
  const rebatePer1kNotional = (-perpComm*ethUsd) / perpVol * 1000; // rebate $ per $1000 notional
  console.log(`    rebate per $1k vol: $${rebatePer1kNotional.toFixed(4)}`);

  // Grid
  const MAX_HOLDS   = [null, 30000, 45000, 60000];
  const MAX_LOSSES  = [null, 3, 5];
  const IST_CONFIGS = [
    { label: 'none',           set: null },
    { label: '18,21',          set: new Set([18,21]) },
    { label: '18,21,0',        set: new Set([18,21,0]) },
    { label: '17,18,19,21,0',  set: new Set([17,18,19,21,0]) },
  ];
  const SPREAD_FILTS = [
    { label: 'none',       min: null,       max: null },
    { label: '>Q1',        min: q1Spread,   max: null },
    { label: '>median',    min: medianSpread, max: null },
    { label: '<Q3',        min: null,       max: q3Spread },
    { label: 'Q1-Q3',      min: q1Spread,   max: q3Spread },
  ];
  const QTY_SCALES  = [1.0, 0.5, 0.25];

  // Also test wider TP via hypothetical: multiply all winner gross by 1.5 (widen TP 50%) assuming same hit rate
  const WIN_MULTS   = [1.0, 1.3, 1.5]; // 1.0=current TP; >1 models wider TP

  const results = [];
  for (const mh of MAX_HOLDS)
    for (const ml of MAX_LOSSES)
      for (const ist of IST_CONFIGS)
        for (const sp of SPREAD_FILTS)
          for (const qs of QTY_SCALES)
            for (const wm of WIN_MULTS) {
              // First run baseline-scaled sim
              const cfg = { maxHoldMs: mh, maxLossUsd: ml == null ? null : ml*qs, disableHrs: ist.set, spreadMin: sp.min, spreadMax: sp.max, qtyScale: qs };
              const r = simPair26(cfg);
              // Apply win-multiplier (scales winners only, as a proxy for wider TP)
              // Rough model: wider TP means each win is wm× bigger, but hit rate stays same
              let adjGross = 0, adjWins = 0, adjLosses = 0;
              for (const t of p26) {
                const es = Number(t.entrySpread)||0;
                if (sp.min!=null && es<sp.min) continue;
                if (sp.max!=null && es>sp.max) continue;
                const ih = istHour(t.entryTime);
                if (ist.set && ist.set.has(ih)) continue;
                let g = Number(t.grossPnl)||0;
                const holdMs = Number(t.holdMs)||0;
                if (mh && holdMs > mh && holdMs > 0) {
                  const frac = mh / holdMs;
                  g = g < 0 ? g*frac : g*Math.max(frac,0.7);
                }
                if (qs !== 1.0) g = g * qs;
                if (g > 0 && wm !== 1.0) g = g * wm;
                if (ml != null) {
                  const floor = -Math.abs(ml*qs);
                  if (g < floor) g = floor;
                }
                adjGross += g;
                if (g > 0) adjWins++; else adjLosses++;
              }
              // Volume & rebate share: n_simulated trades × qtyScale × avgNotionalPerTrade
              // For a Reality check, use avg notional per DB trade × n × qtyScale
              const avgNotionalPerTrade = perpVol / Math.max(db.length, 1); // includes all pairs but approx
              const simVol = r.n * avgNotionalPerTrade * qs;
              const rebateShare = (simVol / 1000) * rebatePer1kNotional;
              const net = adjGross + rebateShare;

              results.push({
                mh, ml, istLabel: ist.label, spLabel: sp.label, qs, wm,
                n: r.n, gross: adjGross, rebate: rebateShare, net,
                winRate: r.n ? adjWins/r.n : 0,
                stops: r.stops
              });
            }
  results.sort((a,b) => b.net - a.net);

  console.log(`\n  § TOP 25 CONFIGS (ranked by NET, pair 26 only):`);
  console.log(`    # holdMs maxL  IST             spread      qty%   TPmul   n    gross$   rebate$   NET$    WR    stops`);
  console.log(`    ─────────────────────────────────────────────────────────────────────────────────────────────────────`);
  for (let i=0;i<Math.min(25, results.length);i++) {
    const r = results[i];
    console.log(
      `    ${String(i+1).padStart(2)} ${String(r.mh||'-').padStart(5)}  ${String(r.ml||'-').padStart(3)}  ` +
      `${r.istLabel.padEnd(14)}  ${r.spLabel.padEnd(8)}  ${(r.qs*100).toFixed(0).padStart(4)}%  ${r.wm.toFixed(1)}x  ` +
      `${String(r.n).padStart(4)} ${(sgn(r.gross)+r.gross.toFixed(2)).padStart(8)}  ${('+'+r.rebate.toFixed(2)).padStart(7)}  ` +
      `${(sgn(r.net)+r.net.toFixed(2)).padStart(7)}  ${pct(Math.round(r.winRate*r.n), r.n).padStart(5)}  ${String(r.stops).padStart(4)}`
    );
  }

  // Best single-factor variations
  console.log(`\n  § BEST-AT-EACH-QTY_SCALE:`);
  for (const qs of QTY_SCALES) {
    const best = results.filter(r => r.qs === qs).sort((a,b)=>b.net-a.net)[0];
    if (best) console.log(`    qty=${(qs*100).toFixed(0)}%: NET=$${best.net.toFixed(2)} (hold=${best.mh||'-'}s TPmul=${best.wm}x spread=${best.spLabel} ist=${best.istLabel})`);
  }

  console.log(`\n  § BEST-AT-EACH-TP-WIDTH:`);
  for (const wm of WIN_MULTS) {
    const best = results.filter(r => r.wm === wm).sort((a,b)=>b.net-a.net)[0];
    if (best) console.log(`    TP=${wm}x: NET=$${best.net.toFixed(2)} (hold=${best.mh||'-'}s qty=${(best.qs*100).toFixed(0)}% spread=${best.spLabel} ist=${best.istLabel})`);
  }

  // Save report
  const out = path.join(__dirname, '..', 'reports', `eth_full_recon_sim_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`);
  const lines = [];
  lines.push(`ETH FULL RECONCILIATION + EXTENDED SIM`);
  lines.push(`Window: ${fmtTs(START_MS)} → ${fmtTs(END_MS)}`);
  lines.push(`\nExchange (perp only):`);
  lines.push(`  fills=${perpTrades.length} vol=$${perpVol.toLocaleString('en-US',{maximumFractionDigits:0})}`);
  lines.push(`  cashflow=$${(perpCash*ethUsd).toFixed(2)} rebate=$${(-perpComm*ethUsd).toFixed(2)} funding=$${(perpFundE*ethUsd).toFixed(2)}`);
  lines.push(`  NET trading=$${((perpCash+perpComm+perpFundE)*ethUsd).toFixed(2)}`);
  lines.push(`\nReconciliation:`);
  lines.push(`  DB trades=${db.length} matched=${matched} unmatchedEntry=${unmatchedEntry} unmatchedExit=${unmatchedExit}`);
  lines.push(`\nSlip model:`);
  lines.push(`  avgStop$ ≈ ${a.toFixed(4)} + (${b.toFixed(7)})×qty`);
  lines.push(`  at qty=47000: ${(a + b*47000).toFixed(2)}`);
  lines.push(`  at qty=23500: ${(a + b*23500).toFixed(2)}`);
  lines.push(`  at qty=10000: ${(a + b*10000).toFixed(2)}`);
  lines.push(`\nTop 25 pair-26 configs:`);
  lines.push(`  # hold maxL IST          spread   qty%  TPmul  n   gross$ rebate$ NET$  WR   stops`);
  for (let i=0;i<Math.min(25,results.length);i++) {
    const r = results[i];
    lines.push(`  ${i+1} ${r.mh||'-'} ${r.ml||'-'} ${r.istLabel.padEnd(14)} ${r.spLabel.padEnd(8)} ${(r.qs*100).toFixed(0)}% ${r.wm}x ${r.n} ${r.gross.toFixed(2)} ${r.rebate.toFixed(2)} ${r.net.toFixed(2)} ${pct(Math.round(r.winRate*r.n),r.n)} ${r.stops}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n')+'\n');
  console.log(`\n  Report: ${out}\n`);

  await sequelize.close();
})().catch(e => { console.error(e.stack); process.exit(1); });
