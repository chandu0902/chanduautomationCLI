#!/usr/bin/env node
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

async function fetchTxLog(token, startMs, endMs) {
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
    process.stdout.write(`\r  fetching txlog: ${all.length} rows`);
    cont = r?.data?.result?.continuation;
    if (!cont || !logs.length) break;
  }
  process.stdout.write('\n');
  return all.filter(l => l.type === 'trade' && l.instrument_name === PERP);
}
async function fetchPerpPosition(token) {
  const r = await axios.get('https://www.deribit.com/api/v2/private/get_positions',{
    headers:{Authorization:`Bearer ${token}`},
    params:{currency:CCY, kind:'future'}, timeout:15000
  });
  return (r?.data?.result || []).find(p => p.instrument_name === PERP) || null;
}
async function fetchIndex() {
  const r = await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});
  return r?.data?.result?.index_price || 0;
}

(async () => {
  const pair    = await StatArbInput.findByPk(PAIR_ID, { raw:true });
  const startMs = new Date(pair.sessionStartedAt).getTime();
  const endMs   = Date.now();
  const elapsedMs  = endMs - startMs;
  const elapsedMin = Math.floor(elapsedMs / 60000);

  const acc = await AccountDetails.findOne({ where:{ Trade_Account: pair.tradeAccountA } });
  const [a0,a1,a2] = acc.Api_Key.split(',',3);
  const [s0,s1,s2] = acc.Secret_Key.split(',',3);
  const token = await auth(decrypt(a2,a1,a0), decrypt(s2,s1,s0));

  const [ethPx, perpPos, fills] = await Promise.all([
    fetchIndex(), fetchPerpPosition(token),
    fetchTxLog(token, startMs, endMs),
  ]);

  // ── Aggregate fills ──────────────────────────────────────────────────────
  let volTotal=0, cashEth=0, rebEth=0, feeEth=0;
  let nMaker=0, nTaker=0;
  let nOpenSell=0, nOpenBuy=0, nCloseSell=0, nCloseBuy=0;
  let volOpenSell=0, volOpenBuy=0, volCloseSell=0, volCloseBuy=0;
  const byHour = {};

  for (const t of fills) {
    const amt  = Math.abs(t.amount || 0);
    const comm = t.commission || 0;
    const cf   = t.cashflow   || 0;
    volTotal += amt;
    cashEth  += cf;
    if (comm < 0) rebEth  += comm; else feeEth += comm;
    const role    = (t.fee_role || t.user_role || '').toLowerCase();
    const sideRaw = (t.side || '').toLowerCase();
    const isOpen  = sideRaw.includes('open');
    const isBuy   = sideRaw.includes('buy');
    if (role === 'maker') nMaker++; else nTaker++;
    if ( isOpen && !isBuy) { nOpenSell++;  volOpenSell  += amt; }
    if ( isOpen &&  isBuy) { nOpenBuy++;   volOpenBuy   += amt; }
    if (!isOpen &&  isBuy) { nCloseBuy++;  volCloseBuy  += amt; }
    if (!isOpen && !isBuy) { nCloseSell++; volCloseSell += amt; }
    const istH = new Date(new Date(t.timestamp).getTime() + (5*60+30)*60000).getUTCHours();
    byHour[istH] ??= { n:0, vol:0, cash:0, reb:0, fee:0, maker:0, taker:0 };
    byHour[istH].n++;
    byHour[istH].vol  += amt;
    byHour[istH].cash += cf;
    if (comm < 0) byHour[istH].reb += comm; else byHour[istH].fee += comm;
    if (role === 'maker') byHour[istH].maker++; else byHour[istH].taker++;
  }

  const rebUsd  = Math.abs(rebEth)  * ethPx;
  const feeUsd  = feeEth * ethPx;
  const cashUsd = cashEth * ethPx;
  const netUsd  = cashUsd + rebUsd - feeUsd;
  const dayFactor = (24*60*60*1000) / elapsedMs;

  // ── DB closed round-trips ────────────────────────────────────────────────
  const [byReason] = await sequelize.query(`
    SELECT exitReason,
           COUNT(*) n,
           ROUND(SUM(grossPnl),2)  totGross,
           ROUND(AVG(grossPnl),2)  avgGross,
           ROUND(MIN(grossPnl),2)  worst,
           ROUND(MAX(grossPnl),2)  best,
           SUM(CASE WHEN grossPnl>0 THEN 1 ELSE 0 END) wins,
           ROUND(AVG(holdMs/1000),1) avgHoldS
    FROM basis_positions
    WHERE pairId=:pid AND state='closed' AND entryTime>=:s
    GROUP BY exitReason ORDER BY n DESC
  `, { replacements:{ pid:PAIR_ID, s:new Date(startMs) } });

  const [[tot]] = await sequelize.query(`
    SELECT COUNT(*) n,
           ROUND(SUM(grossPnl),2) gross,
           ROUND(SUM(netPnl),2)   net,
           SUM(CASE WHEN grossPnl>0 THEN 1 ELSE 0 END) wins,
           ROUND(MIN(grossPnl),2) worst, ROUND(MAX(grossPnl),2) best,
           ROUND(AVG(holdMs/1000),1) avgHoldS
    FROM basis_positions
    WHERE pairId=:pid AND state='closed' AND entryTime>=:s
  `, { replacements:{ pid:PAIR_ID, s:new Date(startMs) } });

  // Running open positions in DB
  const [openDb] = await sequelize.query(`
    SELECT COUNT(*) n,
           GROUP_CONCAT(state ORDER BY entryTime SEPARATOR ', ') states
    FROM basis_positions
    WHERE pairId=:pid AND state IN ('open','pending_exit','pending_entry') AND entryTime>=:s
  `, { replacements:{ pid:PAIR_ID, s:new Date(startMs) } });

  // Stops only — for slip analysis
  const stopsRow = byReason.find(r => r.exitReason === 'stop');

  // ── Build report ─────────────────────────────────────────────────────────
  const L = [];
  const ln = s => L.push(s ?? '');

  const fmtUsd = v => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
  const fmtEth = v => (v >= 0 ? '+' : '') + v.toFixed(6) + ' ETH';

  ln('═══════════════════════════════════════════════════════════════════════════════════');
  ln('  ETH-PERPETUAL SESSION REPORT — PAIR 26 (unilateral maker bot)');
  ln(`  Account  : ${pair.tradeAccountA}`);
  ln(`  Session  : ${new Date(startMs).toISOString().replace('T',' ').replace('Z',' UTC')}`);
  ln(`           → ${new Date(endMs).toISOString().replace('T',' ').replace('Z',' UTC')}`);
  ln(`  Duration : ${elapsedMin}m (${(elapsedMin/60).toFixed(2)} h)   ETH: $${ethPx.toFixed(2)}`);
  ln(`  Bot      : tradingEnabled=${pair.tradingEnabled}   disableIstHours=${pair.disableIstHours||'none'}`);
  ln('═══════════════════════════════════════════════════════════════════════════════════');

  ln('');
  ln('  ┌─ §1  EXCHANGE FILLS  (Deribit transaction_log, ETH-PERPETUAL only) ─────────┐');
  ln(`  │  Total fills      : ${fills.length}                                                      │`);
  ln(`  │  Maker            : ${nMaker}  (${fills.length ? ((nMaker/fills.length)*100).toFixed(1) : 0}%)   Taker: ${nTaker}  (${fills.length ? ((nTaker/fills.length)*100).toFixed(1) : 0}%)               │`);
  ln('  └────────────────────────────────────────────────────────────────────────────┘');

  ln('');
  ln('  Fill sides:');
  ln(`    open-sell  (bot entering short)  : ${String(nOpenSell).padStart(4)} fills   $${volOpenSell.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)} notional`);
  ln(`    close-buy  (bot exiting short)   : ${String(nCloseBuy).padStart(4)} fills   $${volCloseBuy.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)} notional`);
  ln(`    open-buy   (hedge: new long)     : ${String(nOpenBuy).padStart(4)} fills   $${volOpenBuy.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)} notional`);
  ln(`    close-sell (hedge: exit long)    : ${String(nCloseSell).padStart(4)} fills   $${volCloseSell.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)} notional`);
  ln(`    Total volume                     :      $${volTotal.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)} notional`);

  ln('');
  ln('  P&L (exchange, ETH-PERPETUAL only):');
  ln(`    Cashflow (realised PnL)  : ${fmtEth(cashEth).padEnd(22)}  ${fmtUsd(cashUsd)}`);
  ln(`    Rebates earned           : ${fmtEth(Math.abs(rebEth)).padEnd(22)}  +$${rebUsd.toFixed(2)}`);
  ln(`    Fees paid (taker)        : +${feeEth.toFixed(6)} ETH           -$${feeUsd.toFixed(2)}`);
  ln(`    ─────────────────────────────────────────────────────────────────`);
  ln(`    NET (cash + rebates - fees)      :                  ${fmtUsd(netUsd)}`);

  ln('');
  ln('  Projections (extrapolated to 24 h):');
  ln(`    Volume/day               : $${(volTotal*dayFactor).toLocaleString(undefined,{maximumFractionDigits:0})}`);
  ln(`    Rebates/day              : +$${(rebUsd*dayFactor).toFixed(2)}`);
  ln(`    Cashflow/day             : $${(cashUsd*dayFactor).toFixed(2)}`);
  ln(`    NET/day                  : $${(netUsd*dayFactor).toFixed(2)}`);

  ln('');
  ln('  §2  OPEN PERP POSITION (exchange)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  if (perpPos && perpPos.size !== 0) {
    const uPnlUsd = (perpPos.floating_profit_loss || 0) * ethPx;
    ln(`  Size      : ${perpPos.size > 0 ? '+' : ''}${perpPos.size} USD (${perpPos.direction})`);
    ln(`  Avg entry : $${perpPos.average_price}`);
    ln(`  Mark      : $${perpPos.mark_price}`);
    ln(`  uPnL      : ${(perpPos.floating_profit_loss||0).toFixed(6)} ETH  ($${uPnlUsd.toFixed(2)})`);
    ln(`  Liq price : $${perpPos.estimated_liquidation_price || 'n/a'}`);
  } else {
    ln('  No open perp position (flat).');
  }

  ln('');
  ln('  §3  DB ROUND-TRIPS (basis_positions — unilateral bot only)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Closed trades    : ${tot.n}    wins: ${tot.wins}  losses: ${tot.n - tot.wins}  winRate: ${tot.n > 0 ? ((tot.wins/tot.n)*100).toFixed(1) : 0}%`);
  ln(`  Total gross      : $${tot.gross}    total net: $${tot.net}`);
  ln(`  Best             : $${tot.best}    worst: $${tot.worst}    avg hold: ${tot.avgHoldS}s`);
  ln(`  Open/pending DB  : ${openDb[0]?.n || 0}`);
  ln('');
  ln(`  ${'Exit reason'.padEnd(34)} ${'n'.padStart(4)} ${'totGross'.padStart(10)} ${'avg'.padStart(8)} ${'wins'.padStart(5)} ${'loss'.padStart(5)} ${'worst'.padStart(8)} ${'best'.padStart(6)} ${'avgHold'.padStart(8)}`);
  ln(`  ${'-'.repeat(95)}`);
  for (const r of byReason) {
    ln(`  ${(r.exitReason||'?').padEnd(34)} ${String(r.n).padStart(4)} ${('$'+r.totGross).padStart(10)} ${('$'+r.avgGross).padStart(8)} ${String(r.wins).padStart(5)} ${String(r.losses).padStart(5)} ${('$'+r.worst).padStart(8)} ${('$'+r.best).padStart(6)} ${(r.avgHoldS+'s').padStart(8)}`);
  }

  ln('');
  ln('  §4  STOP-LOSS CAP VERIFICATION');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Config cap           : $${pair.maxSingleTradeLossUsd}    reprice interval: ${pair.stopRepriceIntervalMs}ms`);
  if (stopsRow) {
    const slipFactor = Math.abs(stopsRow.avgGross) / (pair.maxSingleTradeLossUsd || 3);
    ln(`  Stops this session   : ${stopsRow.n}    avg stop: $${stopsRow.avgGross}    worst: $${stopsRow.worst}`);
    ln(`  Effective slip       : ${slipFactor.toFixed(2)}×    (target ≈ 1.39× at 1s reprice; pre-OptA was 2.89×)`);
    ln(`  Assessment           : ${slipFactor <= 1.6 ? '✓ GOOD — within model range' : slipFactor <= 2.2 ? '⚠ ELEVATED — market moving fast' : '✗ HIGH — trend/volatile regime'}`);
  } else {
    ln('  No stops yet.');
  }

  ln('');
  ln('  §5  ACTIVITY BY IST HOUR');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  ${'IST'.padStart(4)}  ${'fills'.padStart(5)}  ${'vol($)'.padStart(12)}  ${'cash(ETH)'.padStart(12)}  ${'reb(ETH)'.padStart(12)}  ${'maker'.padStart(5)}  ${'taker'.padStart(5)}  net($)`);
  for (const h of Object.keys(byHour).map(Number).sort((a,b) => a-b)) {
    const d  = byHour[h];
    const netH = (d.cash + Math.abs(d.reb) - d.fee) * ethPx;
    const tag  = (pair.disableIstHours||'').split(',').map(s=>s.trim()).includes(String(h)) ? ' ◀ BLOCKED' : '';
    ln(`  ${String(h+'h').padStart(4)}  ${String(d.n).padStart(5)}  ${d.vol.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(12)}  ${d.cash.toFixed(6).padStart(12)}  ${Math.abs(d.reb).toFixed(6).padStart(12)}  ${String(d.maker).padStart(5)}  ${String(d.taker).padStart(5)}  ${netH.toFixed(2)}${tag}`);
  }

  ln('');
  ln('  §6  vs PRE-DEPLOY BASELINE & TARGETS');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  const projNet = netUsd * dayFactor;
  const projReb = rebUsd * dayFactor;
  ln(`                            Pre-OptA        This session (proj/day)   Delta`);
  ln(`  Volume/day              : $8,923,233      $${(volTotal*dayFactor).toFixed(0).padStart(12)}         ${((volTotal*dayFactor/8923233-1)*100).toFixed(1)}%`);
  ln(`  Rebates/day             :     +$857       $${projReb.toFixed(0).padStart(12)}         ${((projReb/857-1)*100).toFixed(1)}%`);
  ln(`  Cashflow/day            :  -$1,926        $${(cashUsd*dayFactor).toFixed(0).padStart(12)}`);
  ln(`  NET/day                 :  -$1,069        $${projNet.toFixed(0).padStart(12)}`);
  ln(`  Avg stop                :   -$23.11       $${stopsRow ? stopsRow.avgGross : 'n/a'} avg ($${pair.maxSingleTradeLossUsd} cap)`);
  ln(`  Win rate                :      35%        ${tot.n > 0 ? ((tot.wins/tot.n)*100).toFixed(1) : 0}%`);

  ln('');
  ln('═══════════════════════════════════════════════════════════════════════════════════');

  const report = L.join('\n');
  console.log(report);

  const ts   = new Date().toISOString().replace(/[:.]/g,'-');
  const file = path.join(__dirname,'..','reports',`eth_pair26_perp_session_${ts}.txt`);
  fs.writeFileSync(file, report);
  console.log(`\nSaved → ${file}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
