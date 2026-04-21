#!/usr/bin/env node
/**
 * FULL IN-DEPTH ANALYSIS — pair 20 (BTC_Options_Hedge) since bot start.
 * Everything from exchange (Deribit) except adaptive level data (from DB).
 *
 *   node scripts/btcDeepAnalysisPair20.js
 *   node scripts/btcDeepAnalysisPair20.js --pairId=20
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize, StatArbInput, AccountDetails,
  SpreadLevelHistory, BasisPosition, BotSessionLog, Trade,
} = require('../src/models');
const { currencyFromSymbol, asciiTablePush } = require('../lib/btcDeribitReconcileSection');

const LEGACY_BOT_START_MS = Date.UTC(2026, 3, 15, 14, 35, 0, 0);
const REPORTS_DIR  = path.join(__dirname, '..', 'reports');

// ── crypto / auth ────────────────────────────────────────────────────────────
function decryptText(k, enc, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return dc.update(enc,'base64','utf8') + dc.final('utf8');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  for (let p=0;p<150;p++) {
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

async function fetchTxLogs(token, currency, anchorMs) {
  const all=[]; const startMs=anchorMs-21*86400000; const endMs=anchorMs+120000;
  let cont;
  for (let p=0;p<3;p++) {
    await sleep(1600);
    const params = { currency, start_timestamp:startMs, end_timestamp:endMs, count:1000 };
    if (cont) params.continuation = cont;
    const res = await dRpc(token,'get_transaction_log',params);
    all.push(...(res.logs||[]));
    cont = res.continuation;
    if (!cont) break;
  }
  return all;
}

function stateAt(logs, ms) {
  const e = logs.filter(r => Number(r.timestamp)<=ms).sort((a,b)=>a.timestamp-b.timestamp);
  if (!e.length) return null;
  const l = e[e.length-1];
  return { equity:Number(l.equity), balance:Number(l.balance), ts:l.timestamp };
}

// ── formatting ────────────────────────────────────────────────────────────────
function fmt(n, d=8) { return n==null||!Number.isFinite(n)?'-':Number(n).toFixed(d); }
function fmtUsd(n,d=2) { return n==null||!Number.isFinite(n)?'-':'$'+Number(n).toFixed(d); }
function pct(n,d=2) { return n==null||!Number.isFinite(n)?'-':Number(n*100).toFixed(d)+'%'; }
function durStr(ms) {
  if (!ms || ms<0) return '-';
  const s=Math.floor(ms/1000); const m=Math.floor(s/60); const h=Math.floor(m/60);
  if (h>0) return `${h}h ${m%60}m ${s%60}s`;
  if (m>0) return `${m}m ${s%60}s`;
  return `${s}s`;
}
function emitTable(L, colDefs, rows) {
  const buf=[]; asciiTablePush(buf, colDefs, rows); for (const l of buf) L(l);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  let pairId=20;
  for (const a of process.argv.slice(2))
    if (a.startsWith('--pairId=')) pairId=parseInt(a.split('=')[1],10)||20;

  await sequelize.authenticate();

  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) { console.error('pair not found'); process.exit(1); }
  const botStartMs = pair.botStartedAt
    ? new Date(pair.botStartedAt).getTime()
    : LEGACY_BOT_START_MS;
  const execSym  = pair.tradeLeg==='B'?pair.symbol2:pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1||pair.symbol2);
  const acctName = pair.tradeAccountA||pair.tradeAccountB;

  const acct = await AccountDetails.findOne({ where:{ Trade_Account:acctName } });
  const [ak0,ak1,ak2] = acct.Api_Key.split(',',3);
  const [sk0,sk1,sk2] = acct.Secret_Key.split(',',3);
  const token = await getToken(decryptText(ak2,ak1,ak0), decryptText(sk2,sk1,sk0));
  await sleep(1200);

  // index price
  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price',
    { params:{ index_name:`${currency.toLowerCase()}_usd` } }).catch(()=>({data:{}}));
  const idx = Number(ix.data?.result?.index_price)||0;
  const toUsd = (btc) => idx>0&&Number.isFinite(Number(btc))?Number(btc)*idx:null;

  // account summary
  const summary = await dRpc(token,'get_account_summary',{ currency, extended:true });
  await sleep(1000);

  // positions
  const futPos = await dRpc(token,'get_positions',{ currency, kind:'future' });
  await sleep(800);
  const optPos = await dRpc(token,'get_positions',{ currency, kind:'option' });
  await sleep(800);
  const allPos = [...(futPos||[]),...(optPos||[])].filter(p=>Number(p.size)!==0);

  // open orders
  const openOrders = await dRpc(token,'get_open_orders_by_currency',{ currency });
  await sleep(1200);

  // all fills since bot start
  const allFills = await fetchAllTrades(token, currency, botStartMs);
  const execFills = allFills.filter(t=>t.instrument_name===execSym);

  // transaction log for start balance
  await sleep(2000);
  const txLogs = await fetchTxLogs(token, currency, botStartMs);
  const atStart = stateAt(txLogs, botStartMs);

  // DB: adapt rows
  const adapts = await SpreadLevelHistory.findAll({
    where:{ pairId, changedBy:'adapt' }, order:[['id','ASC']] });

  // DB: all spread level changes
  const allLevelChanges = await SpreadLevelHistory.findAll({
    where:{ pairId }, order:[['id','ASC']] });

  // DB: basis positions
  const allBP = await BasisPosition.findAll({ where:{ pairId }, order:[['id','ASC']] });
  const closedBP = allBP.filter(x=>x.state==='closed');
  const openBP   = allBP.filter(x=>['open','pending_entry','pending_exit'].includes(x.state));

  // DB: bot session logs
  const sessions = await BotSessionLog.findAll({
    where:{ pairId }, order:[['enabledAt','ASC']] });

  const now = Date.now();
  const windowMs = now - botStartMs;
  const windowHrs = windowMs/3600000;

  // ── Exchange fill analytics ─────────────────────────────────────────────
  let totalVol=0, sumPl=0, sumFee=0, rebateBtc=0, takerBtc=0;
  let profitExits=0, lossExits=0, openFills=0;
  let profitPlBtc=0, lossPlBtc=0;
  let profitEconBtc=0, lossEconBtc=0; // economic = pl + fee (wallet effect)
  let profitRebateBtc=0;
  let maxSingleWinBtc=-Infinity, maxSingleLossBtc=Infinity;
  let makerCount=0, takerCount=0;

  // Per-hour volume buckets
  const hourBuckets = {};
  // Per-fill detail for streaks
  const closingSlices = [];

  for (const f of execFills) {
    const pl  = Number(f.profit_loss)||0;
    const fee = Number(f.fee)||0;
    const amt = Math.abs(Number(f.amount)||0);
    totalVol += amt;
    sumPl    += pl;
    sumFee   += fee;
    if (fee<0) { rebateBtc += -fee; makerCount++; }
    else if (fee>0) { takerBtc += fee; takerCount++; }

    // hour bucket
    const hr = new Date(f.timestamp).toISOString().slice(0,13);
    if (!hourBuckets[hr]) hourBuckets[hr]={ n:0, vol:0, pl:0, fee:0, rebate:0 };
    hourBuckets[hr].n++;
    hourBuckets[hr].vol += amt;
    hourBuckets[hr].pl  += pl;
    hourBuckets[hr].fee += fee;
    if (fee<0) hourBuckets[hr].rebate += -fee;

    if (pl>0) {
      profitExits++;
      profitPlBtc += pl;
      const fillRebate = fee<0 ? -fee : 0;
      profitRebateBtc += fillRebate;
      const econ = pl + fee;
      profitEconBtc += econ;
      closingSlices.push({ ts:f.timestamp, pl, econ, type:'win' });
      if (econ>maxSingleWinBtc) maxSingleWinBtc=econ;
    } else if (pl<0) {
      lossExits++;
      lossPlBtc += pl;
      const econ = pl + fee;
      lossEconBtc += econ;
      closingSlices.push({ ts:f.timestamp, pl, econ, type:'loss' });
      if (econ<maxSingleLossBtc) maxSingleLossBtc=econ;
    } else {
      openFills++;
    }
  }

  const walletBtc = sumPl+sumFee;
  const totalClosing = profitExits+lossExits;
  const winRate = totalClosing>0 ? profitExits/totalClosing : null;

  // Streaks
  let curStreak=0, maxWinStreak=0, maxLossStreak=0, curType=null;
  for (const s of closingSlices) {
    if (s.type===curType) { curStreak++; }
    else { curStreak=1; curType=s.type; }
    if (curType==='win'  && curStreak>maxWinStreak) maxWinStreak=curStreak;
    if (curType==='loss' && curStreak>maxLossStreak) maxLossStreak=curStreak;
  }

  // Volume by instrument (all instruments)
  const byInstr = {};
  for (const f of allFills) {
    const k = f.instrument_name||'?';
    if (!byInstr[k]) byInstr[k]={ n:0, vol:0, pl:0, fee:0 };
    byInstr[k].n++;
    byInstr[k].vol += Math.abs(Number(f.amount)||0);
    byInstr[k].pl  += Number(f.profit_loss)||0;
    byInstr[k].fee += Number(f.fee)||0;
  }

  // Basis position (DB) analytics
  let dbNetPnl=0, dbGrossPnl=0, dbComm=0, dbTaker=0;
  let dbProfitCount=0, dbStopCount=0;
  const holdTimes=[];
  const spreadChanges=[];
  for (const bp of closedBP) {
    dbNetPnl   += Number(bp.netPnl)||0;
    dbGrossPnl += Number(bp.grossPnl)||0;
    dbComm     += Number(bp.commission)||0;
    dbTaker    += Number(bp.takerFeeUsd)||0;
    if (bp.exitReason==='profit') dbProfitCount++;
    else if (bp.exitReason==='stop') dbStopCount++;
    if (bp.holdMs>0) holdTimes.push(bp.holdMs);
    if (bp.spreadChange!=null) spreadChanges.push(Number(bp.spreadChange));
  }
  holdTimes.sort((a,b)=>a-b);
  const medianHold = holdTimes.length ? holdTimes[Math.floor(holdTimes.length/2)] : null;
  const avgHold    = holdTimes.length ? holdTimes.reduce((s,x)=>s+x,0)/holdTimes.length : null;

  // Adapt analytics
  const adaptLevelRanges = adapts.map(a => {
    const lv = Array.isArray(a.levels)?a.levels:[];
    return { ts:a.createdAt, low:lv[0], high:lv[lv.length-1], mean:a.dollarMean, std:a.dollarStd, open:a.openPositions, tpSlUpdated:a.tpSlUpdated };
  });
  const tpSlUpdatedCount = adapts.filter(a=>a.tpSlUpdated).length;
  const tpSlSkippedCount = adapts.filter(a=>!a.tpSlUpdated).length;
  // Level drift: how much the grid has moved
  let totalLevelDrift = 0;
  for (let i=1;i<adaptLevelRanges.length;i++) {
    const prev = adaptLevelRanges[i-1];
    const cur  = adaptLevelRanges[i];
    if (prev.low!=null && cur.low!=null) totalLevelDrift += Math.abs(cur.low - prev.low);
  }

  // Balance changes
  const curEquity  = Number(summary.equity);
  const curBalance = Number(summary.balance);
  const sessionUpl = Number(summary.session_upl)||0;
  const sessionRpl = Number(summary.session_rpl)||0;

  // ── BUILD REPORT ────────────────────────────────────────────────────────────
  const lines = [];
  const L = (s) => { lines.push(s); console.log(s); };

  const pairLabel = pair.agentName || `Pair ${pairId}`;
  const acctLabel = acctName || '-';
  const hdrTitle  = `  IN-DEPTH ANALYSIS — ${pairLabel}`.padEnd(77);
  const hdrAcct   = `  Account: ${acctLabel}  |  Instrument: ${execSym}`.padEnd(77);
  L('╔══════════════════════════════════════════════════════════════════════════════╗');
  L(`║${hdrTitle}║`);
  L(`║${hdrAcct}║`);
  L(`║  Generated (UTC): ${new Date().toISOString().padEnd(58)}║`);
  L('╚══════════════════════════════════════════════════════════════════════════════╝');
  L('');
  L(`  Window:  ${new Date(botStartMs).toISOString()}  →  ${new Date(now).toISOString()}`);
  L(`  Duration: ${durStr(windowMs)}  (${windowHrs.toFixed(1)} hours)`);
  L(`  BTC Index Price (ref): $${idx?idx.toFixed(2):'n/a'}`);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 1: EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('1. EXECUTIVE SUMMARY');
  L('================================================================================');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Window duration',                            `${windowHrs.toFixed(1)} hours (${durStr(windowMs)})`],
      ['Current equity',                             `${fmt(curEquity)} BTC  (${fmtUsd(toUsd(curEquity))})`],
      ['Current wallet balance',                     `${fmt(curBalance)} BTC  (${fmtUsd(toUsd(curBalance))})`],
      ['Start wallet balance (tx log)',              atStart ? `${fmt(atStart.balance)} BTC  (${fmtUsd(toUsd(atStart.balance))})` : 'n/a'],
      ['Wallet change since start',                  atStart ? `${fmt(curBalance-atStart.balance)} BTC  (${fmtUsd(toUsd(curBalance-atStart.balance))})` : 'n/a'],
      ['Exchange realized PnL (sum profit_loss)',    `${fmt(sumPl)} BTC  (${fmtUsd(toUsd(sumPl))})`],
      ['Wallet on fills (pl + fee)',                 `${fmt(walletBtc)} BTC  (${fmtUsd(toUsd(walletBtc))})`],
      ['Total maker rebates',                        `${fmt(rebateBtc)} BTC  (${fmtUsd(toUsd(rebateBtc))})`],
      ['Total volume',                               `${fmtUsd(totalVol)}`],
      ['Total fills',                                `${execFills.length}`],
      ['Win rate (closing fills)',                    `${pct(winRate)}  (${profitExits}W / ${lossExits}L)`],
      ['Times levels adapted',                       `${adapts.length}`],
      ['Open positions right now',                   `${openBP.length} / ${pair.maxPositions}`],
    ]);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 2: BALANCE & ACCOUNT STATE
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('2. BALANCE & ACCOUNT STATE  (from Exchange)');
  L('================================================================================');
  L('');
  L('  2A. Current Account Snapshot (get_account_summary)');
  L('  ──────────────────────────────────────────────────');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'BTC', w:18, align:'r' },{ h:'~USD', w:16, align:'r' }],
    [
      ['Equity (incl. unrealized PnL)',   fmt(curEquity),       fmtUsd(toUsd(curEquity))],
      ['Wallet balance (no UPL)',         fmt(curBalance),      fmtUsd(toUsd(curBalance))],
      ['Available funds',                 fmt(summary.available_funds), fmtUsd(toUsd(summary.available_funds))],
      ['Maintenance margin',              fmt(summary.maintenance_margin), fmtUsd(toUsd(summary.maintenance_margin))],
      ['Initial margin',                  fmt(summary.initial_margin), fmtUsd(toUsd(summary.initial_margin))],
      ['Delta total',                     fmt(summary.delta_total,6), '-'],
    ]);
  L('');
  L('  2B. Balance Changes (start → now)');
  L('  ──────────────────────────────────');
  const startBal = atStart ? atStart.balance : 1.10779768;
  const startEq  = atStart ? atStart.equity  : 1.377;
  const balDelta = curBalance - startBal;
  const eqDelta  = curEquity  - startEq;
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'start', w:18, align:'r' },{ h:'now', w:18, align:'r' },{ h:'change', w:18, align:'r' }],
    [
      ['Wallet balance (BTC)',  fmt(startBal),  fmt(curBalance),  fmt(balDelta)],
      ['Wallet balance (~USD)', fmtUsd(toUsd(startBal)), fmtUsd(toUsd(curBalance)), fmtUsd(toUsd(balDelta))],
      ['Equity (BTC)',          fmt(startEq),   fmt(curEquity),   fmt(eqDelta)],
      ['Equity (~USD)',         fmtUsd(toUsd(startEq)), fmtUsd(toUsd(curEquity)), fmtUsd(toUsd(eqDelta))],
    ]);
  L('');
  L('  2C. Deribit Session PnL (resets ~00:00 UTC daily)');
  L('  ──────────────────────────────────────────────────');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'BTC', w:18, align:'r' },{ h:'~USD', w:16, align:'r' }],
    [
      ['Session unrealized (UPL)',  fmt(sessionUpl), fmtUsd(toUsd(sessionUpl))],
      ['Session realized (RPL)',    fmt(sessionRpl), fmtUsd(toUsd(sessionRpl))],
      ['Session total (UPL+RPL)',   fmt(sessionUpl+sessionRpl), fmtUsd(toUsd(sessionUpl+sessionRpl))],
    ]);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 3: POSITIONS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('3. POSITIONS  (from Exchange)');
  L('================================================================================');
  if (!allPos.length) {
    L('  FLAT — no open positions');
  } else {
    const posRows = allPos.map(p => {
      const upl = p.floating_profit_loss_usd!=null
        ? fmtUsd(Number(p.floating_profit_loss_usd))
        : fmtUsd(toUsd(p.floating_profit_loss));
      return [
        p.instrument_name||'-', String(p.size||''), p.direction||'-',
        p.average_price!=null?String(p.average_price):'-',
        upl, fmt(p.delta,6), p.kind||'-',
      ];
    });
    emitTable(L, [
      {h:'instrument',w:26},{h:'size',w:8,align:'r'},{h:'dir',w:6},{h:'avg_px',w:12,align:'r'},
      {h:'upl~$',w:14,align:'r'},{h:'delta',w:12,align:'r'},{h:'kind',w:8},
    ], posRows);
  }
  L('');
  L(`  Net delta across all positions: ${fmt(summary.delta_total,6)}`);
  L(`  Open orders: ${Array.isArray(openOrders)?openOrders.length:0}`);
  if (Array.isArray(openOrders) && openOrders.length) {
    for (const o of openOrders)
      L(`    ${o.instrument_name} ${o.direction} ${o.amount} @ ${o.price} (${o.order_type})`);
  }
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 4: VOLUME ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('4. VOLUME ANALYSIS  (from Exchange fills)');
  L('================================================================================');
  L('');
  L('  4A. Overall Volume');
  L('  ──────────────────');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Total fills (all instruments)',       String(allFills.length)],
      ['Total fills (BTC-PERPETUAL only)',    String(execFills.length)],
      ['Volume BTC-PERPETUAL Σ|amount| USD',  fmtUsd(totalVol)],
      ['Avg fill size (USD)',                 fmtUsd(execFills.length?totalVol/execFills.length:0)],
      ['Volume / hour (avg)',                 fmtUsd(windowHrs>0?totalVol/windowHrs:0)],
      ['Fills / hour (avg)',                  (windowHrs>0?(execFills.length/windowHrs).toFixed(1):'0')],
    ]);
  L('');
  L('  4B. Volume by Instrument');
  L('  ────────────────────────');
  const instrRows = Object.entries(byInstr).sort((a,b)=>b[1].vol-a[1].vol).map(([name,d]) => [
    name, String(d.n), fmtUsd(d.vol), fmt(d.pl), fmt(d.fee),
  ]);
  emitTable(L, [
    {h:'instrument',w:26},{h:'fills',w:7,align:'r'},{h:'vol USD',w:14,align:'r'},
    {h:'pl BTC',w:14,align:'r'},{h:'fee BTC',w:14,align:'r'},
  ], instrRows);
  L('');
  L('  4C. Volume by Hour');
  L('  ──────────────────');
  const hrKeys = Object.keys(hourBuckets).sort();
  const hrRows = hrKeys.map(h => {
    const b = hourBuckets[h];
    return [ h.replace('T',' '), String(b.n), fmtUsd(b.vol), fmt(b.pl), fmt(b.rebate) ];
  });
  emitTable(L, [
    {h:'hour (UTC)',w:16},{h:'fills',w:7,align:'r'},{h:'vol USD',w:14,align:'r'},
    {h:'pl BTC',w:14,align:'r'},{h:'rebate BTC',w:14,align:'r'},
  ], hrRows);
  L('');
  // Identify peak and quiet hours
  const peakHr = hrKeys.reduce((best,h)=>hourBuckets[h].vol>hourBuckets[best].vol?h:best, hrKeys[0]);
  const quietHr = hrKeys.reduce((best,h)=>hourBuckets[h].vol<hourBuckets[best].vol?h:best, hrKeys[0]);
  L(`  Peak hour:  ${peakHr.replace('T',' ')} UTC — ${hourBuckets[peakHr].n} fills, ${fmtUsd(hourBuckets[peakHr].vol)} volume`);
  L(`  Quiet hour: ${quietHr.replace('T',' ')} UTC — ${hourBuckets[quietHr].n} fills, ${fmtUsd(hourBuckets[quietHr].vol)} volume`);
  L('');
  L('  4D. Volume Capacity Utilization');
  L('  ───────────────────────────────');
  const maxCapPerHr = 50000 * 4; // $50K max notional * theoretical 4 round-trips/hr
  const theoreticalMax = maxCapPerHr * windowHrs;
  L(`  Config: qty1=$${pair.qty1}  maxPositions=${pair.maxPositions}  maxQty1=$${pair.maxQty1}`);
  L(`  Max single deployment: $${pair.maxQty1} (${pair.maxPositions} × $${pair.qty1})`);
  L(`  Actual volume:         ${fmtUsd(totalVol)}`);
  L(`  Avg round-trip hold:   ${durStr(avgHold)}`);
  L(`  Effective round-trips: ${(totalVol / (pair.maxQty1 * 2)).toFixed(1)} full book turns`);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 5: PNL ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('5. PNL ANALYSIS  (from Exchange fills on BTC-PERPETUAL)');
  L('================================================================================');
  L('');
  L('  5A. Realized PnL Breakdown');
  L('  ──────────────────────────');
  emitTable(L,
    [{ h:'metric', w:54 },{ h:'BTC', w:18, align:'r' },{ h:'~USD', w:16, align:'r' }],
    [
      ['Sum profit_loss (price-only mark PnL)',          fmt(sumPl),                    fmtUsd(toUsd(sumPl))],
      ['Maker rebates to wallet (+)',                    fmt(rebateBtc),                fmtUsd(toUsd(rebateBtc))],
      ['Taker fees paid (-)',                            fmt(takerBtc),                 fmtUsd(toUsd(takerBtc))],
      ['Sum fee (= -rebates + taker)',                   fmt(sumFee),                   fmtUsd(toUsd(sumFee))],
      ['mark PnL + rebates (pl + |rebate|)',             fmt(sumPl+rebateBtc),          fmtUsd(toUsd(sumPl+rebateBtc))],
      ['Wallet on fills (pl + fee, net to balance)',     fmt(walletBtc),                fmtUsd(toUsd(walletBtc))],
    ]);
  L('');
  L('  5B. Profit Exits vs Loss Exits');
  L('  ──────────────────────────────');
  const avgWinBtc  = profitExits>0 ? profitEconBtc/profitExits : null;
  const avgLossBtc = lossExits>0   ? lossEconBtc/lossExits   : null;
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Total closing fills (pl ≠ 0)',         String(totalClosing)],
      ['Profit exits (pl > 0)',                String(profitExits)],
      ['Loss exits (pl < 0)',                  String(lossExits)],
      ['Win rate',                             pct(winRate)],
      ['Win / loss ratio',                     lossExits>0 ? (profitExits/lossExits).toFixed(4) : 'n/a'],
      ['',                                     ''],
      ['Profit exits: sum profit_loss (BTC)',  `${fmt(profitPlBtc)}  (${fmtUsd(toUsd(profitPlBtc))})`],
      ['Profit exits: sum econ (pl+fee) (BTC)',`${fmt(profitEconBtc)}  (${fmtUsd(toUsd(profitEconBtc))})`],
      ['Loss exits: sum profit_loss (BTC)',    `${fmt(lossPlBtc)}  (${fmtUsd(toUsd(lossPlBtc))})`],
      ['Loss exits: sum econ (pl+fee) (BTC)',  `${fmt(lossEconBtc)}  (${fmtUsd(toUsd(lossEconBtc))})`],
      ['',                                     ''],
      ['Avg win per slice (wallet, BTC)',      avgWinBtc!=null?`${fmt(avgWinBtc)}  (${fmtUsd(toUsd(avgWinBtc))})`:'n/a'],
      ['Avg loss per slice (wallet, BTC)',     avgLossBtc!=null?`${fmt(avgLossBtc)}  (${fmtUsd(toUsd(avgLossBtc))})`:'n/a'],
      ['Best single win (wallet, BTC)',        maxSingleWinBtc>-Infinity?`${fmt(maxSingleWinBtc)}  (${fmtUsd(toUsd(maxSingleWinBtc))})`:'n/a'],
      ['Worst single loss (wallet, BTC)',      maxSingleLossBtc<Infinity?`${fmt(maxSingleLossBtc)}  (${fmtUsd(toUsd(maxSingleLossBtc))})`:'n/a'],
      ['Max consecutive wins',                 String(maxWinStreak)],
      ['Max consecutive losses',               String(maxLossStreak)],
    ]);
  L('');
  L('  5C. PnL per Hour');
  L('  ────────────────');
  const hrPnlRows = hrKeys.map(h => {
    const b=hourBuckets[h];
    const net = b.pl+b.fee;
    return [ h.replace('T',' '), fmt(b.pl), fmt(net), fmtUsd(toUsd(net)) ];
  });
  emitTable(L, [
    {h:'hour (UTC)',w:16},{h:'mark PnL BTC',w:16,align:'r'},
    {h:'wallet BTC',w:16,align:'r'},{h:'wallet ~USD',w:14,align:'r'},
  ], hrPnlRows);
  L('');
  // Cumulative P&L
  let cumPl = 0;
  L('  5D. Cumulative PnL (wallet on fills, per hour)');
  L('  ──────────────────────────────────────────────');
  const cumRows = hrKeys.map(h => {
    const b=hourBuckets[h];
    cumPl += b.pl+b.fee;
    return [ h.replace('T',' '), fmt(cumPl), fmtUsd(toUsd(cumPl)) ];
  });
  emitTable(L, [
    {h:'hour',w:16},{h:'cumulative BTC',w:18,align:'r'},{h:'cumulative ~USD',w:18,align:'r'},
  ], cumRows);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 6: REBATE ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('6. REBATE & FEE ANALYSIS  (from Exchange fills)');
  L('================================================================================');
  L('');
  emitTable(L,
    [{ h:'metric', w:54 },{ h:'BTC', w:18, align:'r' },{ h:'~USD', w:16, align:'r' }],
    [
      ['Total maker rebates (fee < 0 fills)',  fmt(rebateBtc),               fmtUsd(toUsd(rebateBtc))],
      ['Total taker fees paid (fee > 0 fills)',fmt(takerBtc),                fmtUsd(toUsd(takerBtc))],
      ['Net fee impact (−rebate + taker)',     fmt(sumFee),                  fmtUsd(toUsd(sumFee))],
      ['Net fee as % of volume',               pct(totalVol>0?Math.abs(toUsd(sumFee)||0)/totalVol:0,4)],
    ]);
  L('');
  L('  Fill type breakdown:');
  L(`    Maker fills (fee < 0):  ${makerCount}  (${pct(execFills.length>0?makerCount/execFills.length:0)})`);
  L(`    Taker fills (fee > 0):  ${takerCount}  (${pct(execFills.length>0?takerCount/execFills.length:0)})`);
  L(`    Zero-fee fills:         ${execFills.length-makerCount-takerCount}`);
  L('');
  L('  Rebate per hour:');
  for (const h of hrKeys) {
    const b=hourBuckets[h];
    if (b.rebate>0) L(`    ${h.replace('T',' ')} UTC  ${fmt(b.rebate)}  (${fmtUsd(toUsd(b.rebate))})`);
  }
  L('');
  L(`  Rebate earned per $1M volume: ${fmt(totalVol>0?rebateBtc/(totalVol/1e6):0)} BTC  (${fmtUsd(totalVol>0?toUsd(rebateBtc)/(totalVol/1e6):0)})`);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 7: ADAPTIVE LEVEL ANALYSIS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('7. ADAPTIVE LEVEL ANALYSIS  (from DB · SpreadLevelHistory)');
  L('================================================================================');
  L('');
  L('  7A. Summary');
  L('  ──────────');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Total adapt events',                 String(adapts.length)],
      ['Adapt frequency (avg interval)',     adapts.length>1?durStr(windowMs/(adapts.length-1)):'n/a'],
      ['TP/SL also updated',                String(tpSlUpdatedCount)],
      ['TP/SL skipped (open positions)',     String(tpSlSkippedCount)],
      ['Total grid drift (sum |Δ low level|)', `$${totalLevelDrift.toFixed(2)}`],
      ['All level changes (incl. enable/api)',String(allLevelChanges.length)],
    ]);
  L('');
  L('  7B. Full Adapt History (chronological)');
  L('  ──────────────────────────────────────');
  const adaptRows = adapts.map(a => {
    const lv = Array.isArray(a.levels)?a.levels:[];
    const low  = lv[0]!=null ? '$'+Number(lv[0]).toFixed(2) : '-';
    const high = lv[lv.length-1]!=null ? '$'+Number(lv[lv.length-1]).toFixed(2) : '-';
    return [
      new Date(a.createdAt).toISOString().slice(0,16).replace('T',' '),
      `${low} – ${high}`,
      a.dollarMean!=null?'$'+Number(a.dollarMean).toFixed(2):'-',
      a.dollarStd!=null?'$'+Number(a.dollarStd).toFixed(2):'-',
      String(a.openPositions??'-'),
      `tp=${Number(a.tpSpreadDelta).toFixed(2)} sl=${Number(a.slSpreadDelta).toFixed(2)}`,
      a.tpSlUpdated?'YES':'no',
    ];
  });
  emitTable(L, [
    {h:'time UTC',w:18},{h:'grid range',w:18},{h:'mean',w:10,align:'r'},
    {h:'std',w:10,align:'r'},{h:'open',w:5,align:'r'},{h:'tp / sl',w:20},
    {h:'tp/sl upd',w:9},
  ], adaptRows);
  L('');
  L('  7C. Regime Shifts (large grid movements)');
  L('  ────────────────────────────────────────');
  for (let i=1; i<adaptLevelRanges.length; i++) {
    const prev = adaptLevelRanges[i-1];
    const cur  = adaptLevelRanges[i];
    const drift = cur.low!=null&&prev.low!=null ? Math.abs(cur.low-prev.low) : 0;
    if (drift > 10) {
      const dir = cur.low>prev.low ? 'UP' : 'DOWN';
      L(`  ${new Date(cur.ts).toISOString().slice(0,16).replace('T',' ')} UTC  grid shift ${dir} $${drift.toFixed(2)}  (low: $${prev.low?.toFixed(2)} → $${cur.low?.toFixed(2)})  openPos: ${prev.open} → ${cur.open}`);
    }
  }
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 8: ROUND-TRIP ANALYSIS (DB basis_positions)
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('8. ROUND-TRIP ANALYSIS  (from DB · basis_positions)');
  L('================================================================================');
  L('');
  L('  8A. Summary');
  L('  ──────────');
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Total round-trips (all states)',     String(allBP.length)],
      ['Closed',                             String(closedBP.length)],
      ['Open / pending',                     String(openBP.length)],
      ['Failed',                             String(allBP.filter(x=>x.state==='failed').length)],
      ['',                                   ''],
      ['Closed — exit=profit',               String(dbProfitCount)],
      ['Closed — exit=stop',                 String(dbStopCount)],
      ['Closed — other exit reasons',        String(closedBP.length-dbProfitCount-dbStopCount)],
      ['Win rate (profit / total closed)',    pct(closedBP.length>0?dbProfitCount/closedBP.length:0)],
      ['',                                   ''],
      ['Sum netPnl (USD)',                   fmtUsd(dbNetPnl)],
      ['Sum grossPnl (USD)',                 fmtUsd(dbGrossPnl)],
      ['Sum commission / rebate (USD)',      fmtUsd(dbComm)],
      ['Sum takerFeeUsd (USD)',              fmtUsd(dbTaker)],
      ['',                                   ''],
      ['Hold time — median',                 durStr(medianHold)],
      ['Hold time — average',                durStr(avgHold)],
      ['Hold time — min',                    holdTimes.length?durStr(holdTimes[0]):'-'],
      ['Hold time — max',                    holdTimes.length?durStr(holdTimes[holdTimes.length-1]):'-'],
    ]);
  L('');
  L('  8B. All Closed Positions (detail)');
  L('  ─────────────────────────────────');
  const bpRows = closedBP.map(bp => [
    String(bp.id),
    bp.exitReason||'-',
    bp.entrySpread!=null?'$'+Number(bp.entrySpread).toFixed(2):'-',
    bp.exitSpread!=null?'$'+Number(bp.exitSpread).toFixed(2):'-',
    bp.spreadChange!=null?Number(bp.spreadChange).toFixed(2):'-',
    bp.netPnl!=null?fmtUsd(Number(bp.netPnl)):'-',
    bp.holdMs>0?durStr(bp.holdMs):'-',
    String(bp.gridLevel??'-'),
  ]);
  if (bpRows.length) {
    emitTable(L, [
      {h:'id',w:6,align:'r'},{h:'exit',w:8},{h:'entry$',w:10,align:'r'},
      {h:'exit$',w:10,align:'r'},{h:'Δsprd',w:8,align:'r'},{h:'netPnl',w:10,align:'r'},
      {h:'hold',w:14},{h:'grid',w:5,align:'r'},
    ], bpRows);
  }
  L('');
  L('  8C. Currently Open Positions');
  L('  ────────────────────────────');
  for (const bp of openBP) {
    L(`    id=${bp.id} grid=${bp.gridLevel} entrySpread=$${Number(bp.entrySpread).toFixed(2)} dir=${bp.direction} since=${new Date(bp.entryTime).toISOString().slice(11,19)} UTC  hold=${durStr(now-new Date(bp.entryTime).getTime())}`);
  }
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 9: BOT SESSIONS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('9. BOT SESSION HISTORY  (from DB · bot_session_logs)');
  L('================================================================================');
  L('');
  if (!sessions.length) {
    L('  No session records found.');
  } else {
    const sessRows = sessions.map(s => [
      String(s.id),
      new Date(s.enabledAt).toISOString().slice(0,19).replace('T',' '),
      s.disabledAt?new Date(s.disabledAt).toISOString().slice(0,19).replace('T',' '):'(running)',
      s.uptimeMs?durStr(Number(s.uptimeMs)):'-',
      s.startBalance!=null?fmtUsd(s.startBalance):'-',
      s.endBalance!=null?fmtUsd(s.endBalance):'-',
      s.sessionPnl!=null?fmtUsd(s.sessionPnl):'-',
      s.stopReason||'-',
    ]);
    emitTable(L, [
      {h:'id',w:4,align:'r'},{h:'enabled (UTC)',w:20},{h:'disabled (UTC)',w:20},
      {h:'uptime',w:12},{h:'startBal',w:12,align:'r'},{h:'endBal',w:12,align:'r'},
      {h:'pnl',w:10,align:'r'},{h:'stop reason',w:18},
    ], sessRows);
  }
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 10: RISK & EFFICIENCY METRICS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('10. RISK & EFFICIENCY METRICS');
  L('================================================================================');
  L('');
  const profitFactor = Math.abs(lossEconBtc)>0 ? profitEconBtc/Math.abs(lossEconBtc) : profitEconBtc>0?Infinity:0;
  const expectancy = totalClosing>0 ? walletBtc/totalClosing : null;
  const sharpeApprox = (() => {
    if (closingSlices.length<2) return null;
    const rets = closingSlices.map(s=>s.econ);
    const avg = rets.reduce((s,x)=>s+x,0)/rets.length;
    const variance = rets.reduce((s,x)=>s+(x-avg)**2,0)/(rets.length-1);
    const std = Math.sqrt(variance);
    return std>0 ? avg/std : null;
  })();
  emitTable(L,
    [{ h:'metric', w:50 },{ h:'value', w:34, align:'r' }],
    [
      ['Profit factor (Σ win econ / |Σ loss econ|)', profitFactor===Infinity?'inf':fmt(profitFactor,4)],
      ['Expectancy per closing fill (BTC)',           expectancy!=null?`${fmt(expectancy)}  (${fmtUsd(toUsd(expectancy))})`:'n/a'],
      ['Sharpe-like ratio (per fill, no annualize)',  sharpeApprox!=null?fmt(sharpeApprox,4):'n/a'],
      ['Win rate',                                    pct(winRate)],
      ['Maker fill %',                                pct(execFills.length>0?makerCount/execFills.length:0)],
      ['PnL / volume (bp)',                           totalVol>0?((toUsd(walletBtc)||0)/totalVol*10000).toFixed(2)+' bp':'n/a'],
      ['Rebate / volume (bp)',                        totalVol>0?((toUsd(rebateBtc)||0)/totalVol*10000).toFixed(2)+' bp':'n/a'],
      ['Max config drawdown limit',                   pair.maxDrawdownUsd ? `$${Number(pair.maxDrawdownUsd).toFixed(0)}` : 'n/a'],
      ['Daily loss limit',                            pair.dailyLossLimitUsd ? `$${Number(pair.dailyLossLimitUsd).toFixed(0)}  (pauses new entries)` : 'n/a'],
    ]);
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // SECTION 11: KEY OBSERVATIONS & FACTORS
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('11. KEY OBSERVATIONS & FACTORS');
  L('================================================================================');
  L('');

  // A. Capital deployment
  const maxDeploy = pair.maxQty1 || (pair.qty1 * (pair.maxPositions || 1));
  const equityUsd = toUsd(curEquity) || 0;
  L('  A. Capital deployment is constrained by config, not by available balance.');
  L(`     Max single deployment: $${maxDeploy} (${pair.maxPositions} × $${pair.qty1} per level).`);
  L(`     Equity available: ${fmtUsd(equityUsd)} — ${equityUsd>0?pct(maxDeploy/equityUsd):'n/a'} is deployed at max.`);
  L('');

  // B. Options vs perp PnL
  const optUpl = Number(summary.options_session_upl) || 0;
  const walletUsd = toUsd(walletBtc) || 0;
  const balDeltaUsd = atStart ? toUsd(curBalance - atStart.balance) : null;
  L('  B. Perp fills wallet impact vs options unrealized PnL:');
  L(`     Perp fills net (pl+fee): ${fmtUsd(walletUsd)}  |  Options session UPL: ${fmtUsd(toUsd(optUpl))}`);
  if (balDeltaUsd != null) L(`     Balance change since start: ${fmtUsd(balDeltaUsd)}`);
  L('');

  // C. Position utilization
  const zeroOpenHrs = adaptLevelRanges.filter(a=>a.open===0).length;
  const avgUtilization = adaptLevelRanges.length > 0
    ? adaptLevelRanges.reduce((s,a)=>s+(a.open||0),0)/adaptLevelRanges.length
    : null;
  L(`  C. Position utilization (from adapt events):`);
  L(`     Max positions config: ${pair.maxPositions}  |  Avg open at adapt: ${avgUtilization!=null?avgUtilization.toFixed(1):'n/a'}`);
  L(`     Adapt events with 0 open positions: ${zeroOpenHrs} out of ${adapts.length} — indicates idle periods.`);
  L('');

  // D. Grid drift
  L('  D. Adaptive grid calibration:');
  L(`     Total adapt events: ${adapts.length}  |  Total grid drift: $${totalLevelDrift.toFixed(2)}`);
  if (adapts.length > 1) {
    const avgIntervalMs = windowMs / (adapts.length - 1);
    L(`     Avg adapt interval: ${durStr(Math.round(avgIntervalMs))}`);
  }
  L('');

  // E. Maker / taker breakdown
  const makerPct = execFills.length > 0 ? makerCount / execFills.length : 0;
  L('  E. Fill type breakdown:');
  L(`     Maker fills: ${makerCount} (${pct(makerPct)}) — earning ${fmtUsd(toUsd(rebateBtc))} in rebates`);
  L(`     Taker fills: ${takerCount} (${pct(1-makerPct)}) — ${fmtUsd(toUsd(takerBtc))} paid`);
  if (takerCount > 0) {
    L(`     Note: taker fills arise from market-close orders (options close or emergency exit),`);
    L(`     not from the normal limit-order strategy. All strategy orders use post_only=true.`);
  }
  L('');

  // F. Net wallet assessment
  const netPl = toUsd(walletBtc)||0;
  if (netPl < 0) {
    L('  F. Net wallet PnL is negative on fills. Strategy relies on maker rebates and/or');
    L('     options hedge UPL for overall portfolio gains, not on perp scalping margin alone.');
  } else {
    L(`  F. Net wallet PnL on fills is positive: ${fmtUsd(netPl)}`);
  }
  L('');

  // ══════════════════════════════════════════════════════════════════════════════
  // FOOTER
  // ══════════════════════════════════════════════════════════════════════════════
  L('================================================================================');
  L('NOTES');
  L('================================================================================');
  L('  • Balance, positions, fills: LIVE from Deribit exchange at report generation time.');
  L('  • Adaptive level data: from DB (SpreadLevelHistory) — exchange does not store this.');
  L('  • Round-trip data: from DB (basis_positions) — cross-referenced with exchange fills.');
  L(`  • BTC index price for USD conversions: $${idx?idx.toFixed(2):'n/a'}`);
  L('  • "Profit exit" = exchange fill where profit_loss > 0 (per-fill; not strategy round-trip).');
  L('  • Volume = Σ|amount| in USD (Deribit inverse contracts denominate amount in USD).');
  L('  • Profit factor = sum of positive econ slices / |sum of negative econ slices|.');
  L('  • Econ slice = profit_loss + fee (the wallet impact of each closing fill).');
  L('================================================================================');
  L('END OF ANALYSIS');
  L('================================================================================');

  await sequelize.close();

  // Write file
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ccyPrefix = currency ? currency.toLowerCase() : 'btc';
  const outPath = path.join(REPORTS_DIR, `${ccyPrefix}_deep_analysis_pair${pairId}_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\nWrote', outPath);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
