#!/usr/bin/env node
/**
 * ethCompleteSessionReport.js
 * Full trade-by-trade + exchange breakdown for current session of pair 26.
 * Pulls ALL txlog entries (trade + settlement + transfer + funding) since
 * sessionStartedAt so nothing is hidden.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { StatArbInput, AccountDetails, BasisPosition, sequelize } = require('../src/models');

const PAIR_ID = 26;
const CCY     = 'ETH';
const PERP    = 'ETH-PERPETUAL';

function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return d.update(enc,'base64','utf8') + d.final('utf8');
}
async function auth(k,s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth',{
    jsonrpc:'2.0',id:1,method:'public/auth',
    params:{grant_type:'client_credentials',client_id:k,client_secret:s}});
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function fetchTxLogAll(token, startMs, endMs) {
  const all = []; let cont;
  for (let i=0;i<100;i++) {
    await sleep(150);
    const params = { currency:CCY, start_timestamp:startMs, end_timestamp:endMs, count:1000 };
    if (cont) params.continuation = cont;
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{
      headers:{Authorization:`Bearer ${token}`}, params, timeout:30000
    });
    const logs = r?.data?.result?.logs || [];
    all.push(...logs);
    process.stdout.write(`\r  txlog rows: ${all.length}`);
    cont = r?.data?.result?.continuation;
    if (!cont || !logs.length) break;
  }
  process.stdout.write('\n');
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
    params:{currency:CCY}, timeout:15000
  });
  return (r?.data?.result || []).filter(p => p.size !== 0);
}
async function fetchIndex() {
  const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
  return r?.data?.result?.index_price || 0;
}

(async () => {
  const pair = await StatArbInput.findByPk(PAIR_ID, { raw:true });
  const startMs = new Date(pair.sessionStartedAt).getTime();
  const endMs   = Date.now();
  const elapsedMs  = endMs - startMs;
  const elapsedMin = Math.floor(elapsedMs / 60000);

  const acc = await AccountDetails.findOne({ where:{ Trade_Account: pair.tradeAccountA } });
  const [a0,a1,a2] = acc.Api_Key.split(',',3);
  const [s0,s1,s2] = acc.Secret_Key.split(',',3);
  const token = await auth(decrypt(a2,a1,a0), decrypt(s2,s1,s0));

  const [ethPx, acct, positions, allLogs] = await Promise.all([
    fetchIndex(), fetchAccount(token), fetchPositions(token),
    fetchTxLogAll(token, startMs, endMs),
  ]);

  // Split txlog by type
  const perpTrades   = allLogs.filter(l => l.type==='trade' && l.instrument_name===PERP);
  const optTrades    = allLogs.filter(l => l.type==='trade' && l.instrument_name!==PERP);
  const settlements  = allLogs.filter(l => l.type==='settlement');
  const deliveries   = allLogs.filter(l => l.type==='delivery');
  const funding      = allLogs.filter(l => l.type==='interest_pl' || l.type==='funding');
  const deposits     = allLogs.filter(l => l.type==='deposit');
  const withdrawals  = allLogs.filter(l => l.type==='withdrawal');
  const transfers    = allLogs.filter(l => l.type==='transfer');
  const others       = allLogs.filter(l => !['trade','settlement','delivery','interest_pl','funding','deposit','withdrawal','transfer'].includes(l.type));

  // ── PERP trade breakdown ─────────────────────────────────────────────────
  let perpVolUsd=0, perpCash=0, perpComm=0, perpRebates=0, perpFees=0;
  let nMaker=0, nTaker=0;
  let nOpenSell=0, nOpenBuy=0, nCloseSell=0, nCloseBuy=0;
  let openSellVol=0, openBuyVol=0, closeSellVol=0, closeBuyVol=0;
  const perpByHour = {};

  for (const t of perpTrades) {
    const amt = Math.abs(t.amount||0);
    perpVolUsd += amt;
    perpCash   += (t.cashflow||0);
    const c = (t.commission||0);
    perpComm   += c;
    if (c < 0) perpRebates += c; else perpFees += c;
    const role = (t.fee_role||t.user_role||'').toLowerCase();
    if (role==='maker') nMaker++; else nTaker++;
    const sideRaw = (t.side||'').toLowerCase();
    const isOpen  = sideRaw.includes('open');
    const isBuy   = sideRaw.includes('buy');
    if (isOpen && !isBuy) { nOpenSell++;  openSellVol  += amt; }
    if (isOpen &&  isBuy) { nOpenBuy++;   openBuyVol   += amt; }
    if (!isOpen && isBuy) { nCloseBuy++;  closeBuyVol  += amt; }
    if (!isOpen && !isBuy){ nCloseSell++; closeSellVol += amt; }
    const h = new Date(new Date(t.timestamp).getTime()+(5*60+30)*60000).getUTCHours();
    perpByHour[h] ??= {n:0,vol:0,cash:0,comm:0,maker:0,taker:0};
    perpByHour[h].n++;
    perpByHour[h].vol  += amt;
    perpByHour[h].cash += (t.cashflow||0);
    perpByHour[h].comm += c;
    if (role==='maker') perpByHour[h].maker++; else perpByHour[h].taker++;
  }

  // ── OPTIONS trade breakdown ──────────────────────────────────────────────
  let optVolUsd=0, optCash=0, optComm=0, optRebates=0, optFees=0;
  const optByInst = {};
  for (const t of optTrades) {
    const amt = Math.abs(t.amount||0) * (t.price||0);  // options: amount in contracts, price in ETH
    optVolUsd += amt;
    optCash   += (t.cashflow||0);
    const c = (t.commission||0);
    optComm   += c;
    if (c<0) optRebates += c; else optFees += c;
    const inst = t.instrument_name || '?';
    optByInst[inst] ??= {n:0,side:'',cash:0,comm:0,avg:0};
    optByInst[inst].n++;
    optByInst[inst].cash += (t.cashflow||0);
    optByInst[inst].comm += c;
  }

  // ── Settlements ──────────────────────────────────────────────────────────
  let settlCash = 0;
  for (const s of settlements) settlCash += (s.cashflow||0);

  // ── Funding ─────────────────────────────────────────────────────────────
  let fundCash = 0;
  for (const f of funding) fundCash += (f.cashflow||f.interest_pl||0);

  // ── Totals ───────────────────────────────────────────────────────────────
  const perpRebUsd  = Math.abs(perpRebates) * ethPx;
  const perpFeeUsd  = perpFees * ethPx;
  const perpCashUsd = perpCash * ethPx;
  const netPerp     = perpCashUsd + perpRebUsd - perpFeeUsd;
  const optCashUsd  = optCash * ethPx;
  const optRebUsd   = Math.abs(optRebates) * ethPx;
  const optFeeUsd   = optFees * ethPx;
  const settlUsd    = settlCash * ethPx;
  const fundUsd     = fundCash * ethPx;
  const grandNetEth = perpCash + perpComm + optCash + optComm + settlCash + fundCash;
  const grandNetUsd = grandNetEth * ethPx;

  // ── DB round-trips ───────────────────────────────────────────────────────
  const [dbAll] = await sequelize.query(`
    SELECT id, direction, state, exitReason,
           ROUND(grossPnl,3) grossPnl, ROUND(netPnl,3) netPnl,
           ROUND(commission,3) comm,
           ROUND(holdMs/1000,1) holdSec,
           DATE_FORMAT(entryTime,'%H:%i:%S') entryT,
           DATE_FORMAT(exitTime,'%H:%i:%S')  exitT,
           ROUND(legA_entryPrice,2) ePx, ROUND(legA_exitPrice,2) xPx,
           ROUND(entrySpread,4) eSprd, ROUND(exitSpread,4) xSprd,
           ROUND(tpDelta,4) tpD, ROUND(slDelta,4) slD
    FROM basis_positions
    WHERE pairId=:pid AND state='closed' AND entryTime >= :start
    ORDER BY entryTime ASC
  `, { replacements:{ pid:PAIR_ID, start:new Date(startMs) } });

  const [dbSummary] = await sequelize.query(`
    SELECT exitReason,
           COUNT(*) n,
           ROUND(SUM(grossPnl),3) totGross,
           ROUND(AVG(grossPnl),3) avgGross,
           SUM(CASE WHEN grossPnl>0 THEN 1 ELSE 0 END) wins,
           SUM(CASE WHEN grossPnl<=0 THEN 1 ELSE 0 END) losses,
           ROUND(MIN(grossPnl),3) worst,
           ROUND(MAX(grossPnl),3) best,
           ROUND(AVG(holdMs/1000),1) avgHoldS
    FROM basis_positions
    WHERE pairId=:pid AND state='closed' AND entryTime >= :start
    GROUP BY exitReason ORDER BY n DESC
  `, { replacements:{ pid:PAIR_ID, start:new Date(startMs) } });

  const [[totRow]] = await sequelize.query(`
    SELECT COUNT(*) n,
           ROUND(SUM(grossPnl),3) totGross,
           ROUND(SUM(netPnl),3) totNet,
           SUM(CASE WHEN grossPnl>0 THEN 1 ELSE 0 END) wins,
           ROUND(AVG(holdMs/1000),1) avgHoldS,
           ROUND(MIN(grossPnl),3) worst,
           ROUND(MAX(grossPnl),3) best
    FROM basis_positions
    WHERE pairId=:pid AND state='closed' AND entryTime >= :start
  `, { replacements:{ pid:PAIR_ID, start:new Date(startMs) } });

  const [openPos] = await sequelize.query(`
    SELECT id, direction, state,
           DATE_FORMAT(entryTime,'%H:%i:%S') entryT,
           ROUND(legA_entryPrice,2) ePx,
           ROUND(tpDelta,4) tpD, ROUND(slDelta,4) slD
    FROM basis_positions
    WHERE pairId=:pid AND state IN ('open','pending_exit','pending_entry') AND entryTime >= :start
    ORDER BY entryTime ASC
  `, { replacements:{ pid:PAIR_ID, start:new Date(startMs) } });

  // ── REPORT ───────────────────────────────────────────────────────────────
  const L = [];
  const ln = s => L.push(s??'');

  ln('═══════════════════════════════════════════════════════════════════════════════════');
  ln('  COMPLETE SESSION TRADE REPORT — ETH PAIR 26');
  ln(`  Account   : ${pair.tradeAccountA}   (Pair: ${pair.agentName})`);
  ln(`  Session   : ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`);
  ln(`  Duration  : ${elapsedMin}m (${(elapsedMin/60).toFixed(2)} h)`);
  ln(`  Bot status: tradingEnabled=${pair.tradingEnabled}`);
  ln(`  ETH index : $${ethPx.toFixed(2)}`);
  ln('═══════════════════════════════════════════════════════════════════════════════════');

  // §1 PERP EXCHANGE
  ln('');
  ln('  §1  ETH-PERPETUAL FILLS  (source: transaction_log)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Total fills              : ${perpTrades.length}`);
  ln(`    Maker                  : ${nMaker}  (${perpTrades.length?((nMaker/perpTrades.length)*100).toFixed(1):0}%)`);
  ln(`    Taker                  : ${nTaker}  (${perpTrades.length?((nTaker/perpTrades.length)*100).toFixed(1):0}%)`);
  ln(`  Side breakdown:`);
  ln(`    open-sell (new short)  : ${nOpenSell}  fills   $${openSellVol.toLocaleString(undefined,{maximumFractionDigits:0})} notional`);
  ln(`    open-buy  (new long)   : ${nOpenBuy}  fills   $${openBuyVol.toLocaleString(undefined,{maximumFractionDigits:0})} notional`);
  ln(`    close-buy (cover short): ${nCloseBuy}  fills   $${closeBuyVol.toLocaleString(undefined,{maximumFractionDigits:0})} notional`);
  ln(`    close-sell(exit long)  : ${nCloseSell}  fills   $${closeSellVol.toLocaleString(undefined,{maximumFractionDigits:0})} notional`);
  ln(`  Total volume             : $${perpVolUsd.toLocaleString(undefined,{maximumFractionDigits:0})}`);
  ln('');
  ln(`  Cashflow (realised PnL)  : ${perpCash.toFixed(6)} ETH   ($${perpCashUsd.toFixed(2)})`);
  ln(`  Rebates earned (comm<0)  : ${perpRebates.toFixed(6)} ETH  ($${perpRebUsd.toFixed(2)})`);
  ln(`  Fees paid (comm>0)       : +${perpFees.toFixed(6)} ETH  ($${perpFeeUsd.toFixed(2)})`);
  ln(`  NET perp exchange        : $${netPerp.toFixed(2)}`);

  // §2 PERP by hour
  ln('');
  ln('  §2  PERP ACTIVITY — BY IST HOUR');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  IST-hr  fills  vol($)         cash(ETH)    comm(ETH)    maker  taker`);
  for (const h of Object.keys(perpByHour).map(Number).sort((a,b)=>a-b)) {
    const d = perpByHour[h];
    const tag = (pair.disableIstHours||'').split(',').map(s=>s.trim()).includes(String(h)) ? ' [BLOCKED]' : '';
    ln(`  ${String(h).padStart(2)}h    ${String(d.n).padStart(4)}  ${d.vol.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)}  ${d.cash.toFixed(6).padStart(10)}  ${d.comm.toFixed(6).padStart(10)}   ${String(d.maker).padStart(4)}   ${String(d.taker).padStart(4)}${tag}`);
  }

  // §3 OPTIONS
  ln('');
  ln('  §3  OPTIONS FILLS  (all instruments except ETH-PERPETUAL)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  if (optTrades.length === 0) {
    ln('  None.');
  } else {
    ln(`  Total fills              : ${optTrades.length}`);
    ln(`  Cashflow                 : ${optCash.toFixed(6)} ETH   ($${optCashUsd.toFixed(2)})`);
    ln(`  Rebates                  : ${optRebates.toFixed(6)} ETH  ($${optRebUsd.toFixed(2)})`);
    ln(`  Fees paid                : +${optFees.toFixed(6)} ETH  ($${optFeeUsd.toFixed(2)})`);
    ln('');
    ln('  Per-instrument:');
    ln(`  ${'instrument'.padEnd(30)} fills  cashETH       commETH`);
    for (const [inst,d] of Object.entries(optByInst)) {
      ln(`  ${inst.padEnd(30)} ${String(d.n).padStart(4)}   ${d.cash.toFixed(6).padStart(12)}  ${d.comm.toFixed(6).padStart(12)}`);
    }
  }

  // §4 SETTLEMENTS, FUNDING, OTHER
  ln('');
  ln('  §4  OTHER CASH FLOWS');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Settlements              : ${settlements.length} events   ${settlCash.toFixed(6)} ETH  ($${settlUsd.toFixed(2)})`);
  ln(`  Funding/interest_pl      : ${funding.length} events    ${fundCash.toFixed(6)} ETH  ($${fundUsd.toFixed(2)})`);
  ln(`  Deposits                 : ${deposits.length} events`);
  ln(`  Withdrawals              : ${withdrawals.length} events`);
  ln(`  Transfers                : ${transfers.length} events`);
  if (others.length) {
    ln(`  Other types              : ${others.length} (${[...new Set(others.map(o=>o.type))].join(', ')})`);
  }

  // §5 GRAND NET
  ln('');
  ln('  §5  GRAND NET (all flows this session)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Perp cashflow            :  ${perpCash.toFixed(6)} ETH  ($${perpCashUsd.toFixed(2)})`);
  ln(`  Perp commission (net)    :  ${perpComm.toFixed(6)} ETH  ($${(perpComm*ethPx).toFixed(2)})`);
  ln(`  Options cashflow         :  ${optCash.toFixed(6)} ETH  ($${optCashUsd.toFixed(2)})`);
  ln(`  Options commission (net) :  ${optComm.toFixed(6)} ETH  ($${(optComm*ethPx).toFixed(2)})`);
  ln(`  Settlements              :  ${settlCash.toFixed(6)} ETH  ($${settlUsd.toFixed(2)})`);
  ln(`  Funding                  :  ${fundCash.toFixed(6)} ETH  ($${fundUsd.toFixed(2)})`);
  ln(`  ────────────────────────────────────────────────────`);
  ln(`  GRAND NET                :  ${grandNetEth.toFixed(6)} ETH  ($${grandNetUsd.toFixed(2)})`);

  // §6 ACCOUNT STATE
  ln('');
  ln('  §6  ACCOUNT STATE');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  const startBal = pair.sessionStartBalance;
  const balNow   = acct.balance ?? null;
  const equNow   = acct.equity  ?? null;
  const balDelta = (balNow != null && startBal != null) ? balNow - startBal : null;
  ln(`  Session start balance    : ${startBal ? startBal.toFixed(6)+' ETH' : 'n/a'}`);
  ln(`  Balance now              : ${balNow != null ? balNow.toFixed(6)+' ETH' : 'n/a'}`);
  ln(`  Balance delta            : ${balDelta != null ? balDelta.toFixed(6)+' ETH  ($'+((balDelta||0)*ethPx).toFixed(2)+')' : 'n/a'}`);
  ln(`  Equity now               : ${equNow != null ? equNow.toFixed(6)+' ETH' : 'n/a'}`);
  ln('');
  ln('  Open positions (all kinds):');
  if (positions.length === 0) ln('  None.');
  for (const p of positions) {
    const uPnlUsd = (p.floating_profit_loss||0) * ethPx;
    ln(`  ${p.instrument_name.padEnd(30)} kind=${p.kind.padEnd(7)} size=${String(p.size).padStart(8)}  dir=${p.direction.padEnd(5)}  avg=$${p.average_price}  mark=$${p.mark_price}  uPnL=${(p.floating_profit_loss||0).toFixed(6)} ETH ($${uPnlUsd.toFixed(2)})`);
  }

  // §7 DB SUMMARY
  ln('');
  ln('  §7  DB ROUND-TRIPS SUMMARY (basis_positions)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Total closed             : ${totRow.n}    wins=${totRow.wins}  losses=${totRow.n-totRow.wins}  winRate=${totRow.n>0?((totRow.wins/totRow.n)*100).toFixed(1):0}%`);
  ln(`  Total gross              : $${totRow.totGross}    total net: $${totRow.totNet}`);
  ln(`  Avg hold                 : ${totRow.avgHoldS}s`);
  ln(`  Best trade               : $${totRow.best}    worst: $${totRow.worst}`);
  ln('');
  ln('  Exit-reason breakdown:');
  ln(`  ${'reason'.padEnd(32)} n     totGross$   avgGross$   wins  losses  worst$    best$   avgHold`);
  for (const r of dbSummary) {
    ln(`  ${(r.exitReason||'?').padEnd(32)} ${String(r.n).padStart(4)}  ${String('$'+r.totGross).padStart(10)}  ${String('$'+r.avgGross).padStart(10)}   ${String(r.wins).padStart(4)}   ${String(r.losses).padStart(4)}  ${String('$'+r.worst).padStart(8)}  ${String('$'+r.best).padStart(6)}   ${r.avgHoldS}s`);
  }

  // §8 OPEN DB POSITIONS
  if (openPos.length) {
    ln('');
    ln('  §8  CURRENTLY OPEN DB POSITIONS');
    ln('  ─────────────────────────────────────────────────────────────────────────────────');
    for (const p of openPos) {
      ln(`  id=${p.id} dir=${p.direction} state=${p.state} entry=${p.entryT} ePx=${p.ePx} tpD=${p.tpD} slD=${p.slD}`);
    }
  }

  // §9 FULL TRADE LOG
  ln('');
  ln('  §9  FULL ROUND-TRIP LOG (all closed, chronological)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  ${'#'.padStart(4)} ${'entry'.padEnd(8)} ${'exit'.padEnd(8)} ${'dir'.padEnd(6)} ${'ePx'.padStart(8)} ${'xPx'.padStart(8)} ${'gross$'.padStart(8)} ${'comm$'.padStart(7)} ${'holdS'.padStart(7)} ${'reason'.padEnd(30)}`);
  for (let i=0; i<dbAll.length; i++) {
    const t = dbAll[i];
    const gross = t.grossPnl;
    const color = gross > 0 ? '+' : '';
    ln(`  ${String(i+1).padStart(4)} ${t.entryT.padEnd(8)} ${(t.exitT||'').padEnd(8)} ${(t.direction||'').padEnd(6)} ${String(t.ePx||'').padStart(8)} ${String(t.xPx||'').padStart(8)} ${(color+gross).padStart(8)} ${String(t.comm||'').padStart(7)} ${String(t.holdSec||'').padStart(7)} ${(t.exitReason||'').padEnd(30)}`);
  }

  const out = L.join('\n');
  console.log(out);
  const ts   = new Date().toISOString().replace(/[:.]/g,'-');
  const file = path.join(__dirname,'..','reports',`eth_pair26_complete_session_${ts}.txt`);
  fs.writeFileSync(file, out);
  console.log(`\nSaved: ${file}`);
  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
