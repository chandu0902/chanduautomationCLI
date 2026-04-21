#!/usr/bin/env node
/**
 * ethPair26SessionSim.js
 *
 *   Focused simulator for pair 26 on the POST-OptA window (Apr 20 08:42 UTC → now).
 *
 *   - Replays DB round-trips through configurable:
 *       * maxSingleTradeLossUsd  (hard USD cap)
 *       * maxHoldMs              (force-flatten if held > X ms)
 *       * slCapUsd (spread-SL)   (recomputed from hold-slip model)
 *       * disableIstHours        (set of IST hours to skip entries)
 *   - Pulls the last-session txlog from Deribit to get:
 *       * actual volume, maker%, rebate rate per $1 of volume
 *       * proportional rebate projection for any simulated trade count
 *   - Ranks configs by projected NET (gross + rebate share - fee share).
 *
 *   Window defaults: 2026-04-20 08:42 UTC (OptA deploy) → now.
 *   Override with --start / --end.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { StatArbInput, BasisPosition, AccountDetails, sequelize } = require('../src/models');
const { Op } = require('sequelize');

const argv = (() => {
  const a = {};
  for (let i=2;i<process.argv.length;i++) {
    const m = process.argv[i].match(/^--([^=]+)=?(.*)$/);
    if (m) a[m[1]] = m[2] || true;
  }
  return a;
})();
const CCY  = 'ETH';
const PERP = 'ETH-PERPETUAL';
const PAIR_ID = 26;
const DEFAULT_START = Date.UTC(2026, 3, 20, 8, 42, 0);
const START_MS = argv.start ? Date.parse(argv.start) : DEFAULT_START;
const END_MS   = argv.end   ? Date.parse(argv.end)   : Date.now();

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
  for (let i=0;i<500;i++) {
    await sleep(250);
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

// Slip model: avg stop loss = slCap × (1.15 + 0.24 × repriceSec), floor 1.15
function slipMultiplier(repriceMs) {
  const sec = Math.max(0, repriceMs/1000);
  return Math.max(1.15, 1.15 + 0.24 * sec);
}

function runSim(trades, cfg) {
  // cfg: { slCapUsd, maxLossUsd, maxHoldMs, disableHrs: Set<number> }
  const slip = slipMultiplier(cfg.repriceMs);
  const cappedStop = -Math.abs(cfg.slCapUsd) * slip;   // modeled realized stop USD
  let gross = 0, wins=0, losses=0, n=0, stops=0, capped=0, holdTrims=0, skipped=0;
  let worst = 0, best = 0;

  for (const t of trades) {
    const entryIst = istHour(t.entryTime);
    if (cfg.disableHrs && cfg.disableHrs.has(entryIst)) { skipped++; continue; }

    let g = Number(t.grossPnl) || 0;
    const reason = (t.exitReason||'').toLowerCase();
    const holdMs = Number(t.holdMs) || 0;

    // Model hold-cap: if the sim's cap is tighter than the actual holdMs, re-estimate PnL
    // at the cap using a linear interpolation of the original PnL vs hold time.
    if (cfg.maxHoldMs && holdMs > cfg.maxHoldMs && holdMs > 0) {
      // Assume PnL accrues linearly with time (proxy). Winners usually exited at TP long
      // before the cap, so this mostly affects losers which drift.
      const frac = cfg.maxHoldMs / holdMs;
      if (g < 0) {
        // losers: tighter cap → less loss (clip at cap fraction)
        g = g * frac;
        holdTrims++;
      } else {
        // winners: if they somehow held >cap, we'd have missed the win → zero out modestly
        g = g * 0.5; // conservative: half the upside
      }
    }

    // Model tighter SL cap: replace any stop with modeled capped stop
    if (reason === 'stop' && cfg.slCapUsd != null) {
      g = Math.max(g, cappedStop);  // less-negative replacement
    }

    // Model hard-loss cap: floor ALL trades (including profit_fill_gross_nonpos) at -maxLossUsd×slip
    if (cfg.maxLossUsd != null) {
      const floor = -Math.abs(cfg.maxLossUsd) * slip;
      if (g < floor) { g = floor; capped++; }
    }

    gross += g;
    if (g > 0) wins++; else losses++;
    if (g < worst) worst = g;
    if (g > best)  best = g;
    if (reason.includes('stop')) stops++;
    n++;
  }
  const winRate = n ? wins/n : 0;
  const avgWin  = wins ? trades.filter(t=>(Number(t.grossPnl)||0)>0).reduce((s,t)=>s+Number(t.grossPnl),0)/wins : 0;
  const avgLoss = losses ? gross/Math.max(1,losses) : 0; // rough
  return { n, gross, wins, losses, winRate, stops, capped, holdTrims, skipped, worst, best };
}

(async () => {
  const pair = await StatArbInput.findByPk(PAIR_ID);
  const acc  = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  const idxR  = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
  const ethUsd = idxR?.data?.result?.index_price || 2315;

  console.log(`\nETH pair 26 SESSION SIM`);
  console.log(`  Window   : ${fmtTs(START_MS)}  →  ${fmtTs(END_MS)}`);
  console.log(`  ETH/USD  : $${ethUsd.toFixed(2)}\n`);

  // Fetch txlog for exchange-side stats
  const logs = await fetchTxLog(token);
  const txTrades = logs.filter(r => r.instrument_name === PERP && r.type === 'trade');
  const volUsd = txTrades.reduce((s,r)=>s+Math.abs(r.amount), 0);
  const commEth = txTrades.reduce((s,r)=>s+(r.commission||0), 0);
  const cashEth = txTrades.reduce((s,r)=>s+(r.cashflow||0), 0);
  const makerFills = txTrades.filter(r=>r.fee_role==='maker').length;

  const rebateUsdPerNotionalUsd = volUsd > 0 ? (-commEth * ethUsd / volUsd) : 0;
  console.log(`  Exchange: fills=${txTrades.length} maker=${(makerFills/(txTrades.length||1)*100).toFixed(1)}% vol=$${volUsd.toLocaleString('en-US',{maximumFractionDigits:0})}`);
  console.log(`  Rebate per $1 volume: $${rebateUsdPerNotionalUsd.toFixed(8)} (ratio used to pro-rate rebates for simulated trade counts)\n`);

  // Fetch DB trades for pair 26 in the window
  const rows = await BasisPosition.findAll({
    where: { pairId: PAIR_ID, state: 'closed', entryTime: { [Op.gte]: new Date(START_MS), [Op.lte]: new Date(END_MS) } },
    attributes: ['id','direction','entryTime','exitTime','holdMs','grossPnl','commission','netPnl','exitReason','legA_entryPrice','legA_exitPrice']
  });
  const trades = rows.map(r => r.toJSON());
  console.log(`  DB round-trips (pair 26): ${trades.length}`);

  // Baseline (no filters, as-is)
  const baseline = runSim(trades, { slCapUsd: null, maxLossUsd: null, maxHoldMs: null, disableHrs: null, repriceMs: 1000 });
  console.log(`\nBASELINE (as-is):`);
  console.log(`  n=${baseline.n}  wins=${baseline.wins}  losses=${baseline.losses}  WR=${(baseline.winRate*100).toFixed(1)}%`);
  console.log(`  gross=$${baseline.gross.toFixed(2)}  stops=${baseline.stops}  worst=$${baseline.worst.toFixed(2)}  best=$${baseline.best.toFixed(2)}`);

  // Parameter grid
  const SL_CAPS       = [null, 3];
  const MAX_LOSSES    = [null, 3, 4, 5, 6, 8, 10];
  const MAX_HOLDS     = [null, 30000, 45000, 60000, 90000];
  const IST_BLOCKS    = [
    null,
    new Set([18,21,0]),
    new Set([17,18,19,21,0]),
    new Set([18,21]),
    new Set([0,1,2,3,17,18,19,21,23]),  // keep only "best" hours
  ];
  const IST_LABELS = ['none','18,21,0','17,18,19,21,0','18,21','0-3,17-19,21,23'];

  const configs = [];
  for (const sl of SL_CAPS)
    for (const ml of MAX_LOSSES)
      for (const mh of MAX_HOLDS)
        for (let i=0;i<IST_BLOCKS.length;i++)
          configs.push({ slCapUsd: sl, maxLossUsd: ml, maxHoldMs: mh, disableHrs: IST_BLOCKS[i], _istLabel: IST_LABELS[i], repriceMs: 1000 });

  const results = configs.map(cfg => {
    const r = runSim(trades, cfg);
    // Proportional rebate: assume rebate scales with trade count (n/baseline.n)
    const rebateShare = baseline.n ? (r.n / baseline.n) * (-commEth * ethUsd) : 0;
    const net = r.gross + rebateShare;
    return { cfg, r, rebateShare, net };
  });
  results.sort((a,b) => b.net - a.net);

  console.log(`\nTOP 20 CONFIGS (ranked by projected NET = gross + rebate share):\n`);
  console.log('  #   slCap  maxLoss  holdMs   IST-block              n     gross$    rebate$    NET$     WR     stops  capped');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────────────');
  for (let i=0;i<Math.min(20, results.length);i++) {
    const { cfg, r, rebateShare, net } = results[i];
    console.log(
      `  ${String(i+1).padStart(2)}   ` +
      `${String(cfg.slCapUsd ?? '-').padStart(4)}   ` +
      `${String(cfg.maxLossUsd ?? '-').padStart(5)}   ` +
      `${String(cfg.maxHoldMs ?? '-').padStart(6)}   ` +
      `${cfg._istLabel.padEnd(20)}   ` +
      `${String(r.n).padStart(4)}  ` +
      `${(sgn(r.gross)+r.gross.toFixed(2)).padStart(9)}  ` +
      `${('+'+rebateShare.toFixed(2)).padStart(8)}  ` +
      `${(sgn(net)+net.toFixed(2)).padStart(8)}  ` +
      `${pct(r.wins,r.n).padStart(5)}  ` +
      `${String(r.stops).padStart(4)}   ` +
      `${String(r.capped).padStart(3)}`
    );
  }

  // Also show "most trades preserved" (highest n) among top-quartile NET
  const netSorted = [...results].sort((a,b)=>b.net-a.net);
  const top25 = netSorted.slice(0, Math.ceil(netSorted.length/4));
  top25.sort((a,b)=>b.r.n - a.r.n);
  console.log(`\nHIGHEST-VOLUME CONFIGS WITHIN TOP-25% NET (volume preservation, since volume=rebate):\n`);
  console.log('  #   slCap  maxLoss  holdMs   IST-block              n     gross$    rebate$    NET$     WR');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────');
  for (let i=0;i<Math.min(10, top25.length);i++) {
    const { cfg, r, rebateShare, net } = top25[i];
    console.log(
      `  ${String(i+1).padStart(2)}   ` +
      `${String(cfg.slCapUsd ?? '-').padStart(4)}   ` +
      `${String(cfg.maxLossUsd ?? '-').padStart(5)}   ` +
      `${String(cfg.maxHoldMs ?? '-').padStart(6)}   ` +
      `${cfg._istLabel.padEnd(20)}   ` +
      `${String(r.n).padStart(4)}  ` +
      `${(sgn(r.gross)+r.gross.toFixed(2)).padStart(9)}  ` +
      `${('+'+rebateShare.toFixed(2)).padStart(8)}  ` +
      `${(sgn(net)+net.toFixed(2)).padStart(8)}  ` +
      `${pct(r.wins,r.n).padStart(5)}`
    );
  }

  // Save report
  const out = path.join(__dirname, '..', 'reports', `eth_pair26_session_sim_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`);
  const lines = [];
  lines.push(`ETH pair 26 SESSION SIM`);
  lines.push(`Window: ${fmtTs(START_MS)} → ${fmtTs(END_MS)}`);
  lines.push(`Exchange: fills=${txTrades.length} vol=$${volUsd.toLocaleString('en-US',{maximumFractionDigits:0})} rebate=$${(-commEth*ethUsd).toFixed(2)}`);
  lines.push(`DB trades: ${trades.length}`);
  lines.push(`\nBASELINE: n=${baseline.n} gross=$${baseline.gross.toFixed(2)} WR=${(baseline.winRate*100).toFixed(1)}% stops=${baseline.stops}\n`);
  lines.push(`TOP 20 BY NET:\n  # slCap maxLoss holdMs IST               n   gross$   rebate$  NET$   WR   stops cap`);
  for (let i=0;i<Math.min(20,results.length);i++) {
    const { cfg, r, rebateShare, net } = results[i];
    lines.push(`  ${i+1} ${cfg.slCapUsd??'-'} ${cfg.maxLossUsd??'-'} ${cfg.maxHoldMs??'-'} ${cfg._istLabel.padEnd(18)} ${r.n} ${r.gross.toFixed(2)} ${rebateShare.toFixed(2)} ${net.toFixed(2)} ${pct(r.wins,r.n)} ${r.stops} ${r.capped}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n')+'\n');
  console.log(`\nReport: ${out}\n`);

  await sequelize.close();
})().catch(e => { console.error(e.stack); process.exit(1); });
