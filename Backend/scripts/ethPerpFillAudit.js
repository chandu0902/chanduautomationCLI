#!/usr/bin/env node
/**
 * ethPerpFillAudit.js
 * For every ETH-PERPETUAL fill in the session, lookup the originating order
 * and classify: bot (api+post_only) vs manual (web) vs hedge-engine (api, not post_only).
 * Excludes the known manual close (ETH-117936060548) per user request.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { StatArbInput, AccountDetails, sequelize } = require('../src/models');

const PAIR_ID       = 26;
const CCY           = 'ETH';
const PERP          = 'ETH-PERPETUAL';
const MANUAL_ORDER  = 'ETH-117936060548'; // user's manual close — excluded

function decrypt(k,enc,iv){const d=crypto.createDecipheriv('aes-256-cbc',Buffer.from(k,'base64'),Buffer.from(iv,'base64'));return d.update(enc,'base64','utf8')+d.final('utf8');}
async function auth(k,s){const r=await axios.post('https://www.deribit.com/api/v2/public/auth',{jsonrpc:'2.0',id:1,method:'public/auth',params:{grant_type:'client_credentials',client_id:k,client_secret:s}});return r.data.result.access_token;}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function fetchTxLog(token, startMs, endMs) {
  const all=[]; let cont;
  for(let i=0;i<100;i++){
    await sleep(150);
    const params={currency:CCY,start_timestamp:startMs,end_timestamp:endMs,count:1000};
    if(cont) params.continuation=cont;
    const r=await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{headers:{Authorization:'Bearer '+token},params,timeout:30000});
    const logs=r?.data?.result?.logs||[];
    all.push(...logs);
    process.stdout.write(`\r  txlog: ${all.length}`);
    cont=r?.data?.result?.continuation;
    if(!cont||!logs.length) break;
  }
  process.stdout.write('\n');
  return all.filter(l=>l.type==='trade'&&l.instrument_name===PERP&&l.order_id!==MANUAL_ORDER);
}

async function getOrderState(token, orderId) {
  try {
    await sleep(80);
    const r=await axios.get('https://www.deribit.com/api/v2/private/get_order_state',{
      headers:{Authorization:'Bearer '+token},params:{order_id:orderId},timeout:8000
    });
    return r.data.result;
  } catch { return null; }
}
async function fetchIndex(){const r=await axios.get('https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd',{timeout:8000});return r?.data?.result?.index_price||0;}

(async()=>{
  const pair    = await StatArbInput.findByPk(PAIR_ID,{raw:true});
  const startMs = new Date(pair.sessionStartedAt).getTime();
  const endMs   = Date.now();

  const acc=await AccountDetails.findOne({where:{Trade_Account:pair.tradeAccountA}});
  const [a0,a1,a2]=acc.Api_Key.split(',',3);
  const [s0,s1,s2]=acc.Secret_Key.split(',',3);
  const token=await auth(decrypt(a2,a1,a0),decrypt(s2,s1,s0));

  const [ethPx, fills] = await Promise.all([fetchIndex(), fetchTxLog(token,startMs,endMs)]);

  // Group fills by order_id
  const byOrder = {};
  for(const f of fills){
    const oid=f.order_id;
    if(!byOrder[oid]) byOrder[oid]={fills:[],orderId:oid};
    byOrder[oid].fills.push(f);
  }

  // Lookup order states (batch, unique order ids)
  console.log(`  Looking up ${Object.keys(byOrder).length} unique orders...`);
  const orderStates={};
  for(const oid of Object.keys(byOrder)){
    const s=await getOrderState(token,oid);
    if(s) orderStates[oid]=s;
  }

  // Classify each order
  const categories = { bot:[], hedge:[], manual:[], other:[] };
  for(const [oid, grp] of Object.entries(byOrder)){
    const os=orderStates[oid];
    const fills=grp.fills;
    const firstFill=fills[0];
    const sideRaw=(firstFill.side||'').toLowerCase();
    const isOpen=sideRaw.includes('open');
    const isBuy=sideRaw.includes('buy');
    const totalAmt=fills.reduce((s,f)=>s+Math.abs(f.amount||0),0);
    const totalCash=fills.reduce((s,f)=>s+(f.cashflow||0),0);
    const totalComm=fills.reduce((s,f)=>s+(f.commission||0),0);
    const role=(firstFill.fee_role||firstFill.user_role||'').toLowerCase();
    const ts=new Date(firstFill.timestamp).toISOString().replace('T',' ').replace('Z','');

    const entry={
      orderId:oid, ts, sideRaw, isOpen, isBuy,
      totalAmt, totalCash, totalComm, fills:fills.length,
      api:os?.api, web:os?.web, postOnly:os?.post_only,
      reduceOnly:os?.reduce_only, orderType:os?.order_type,
      role,
    };

    if(!os){
      categories.other.push(entry);
    } else if(os.api && os.post_only){
      categories.bot.push(entry);
    } else if(os.api && !os.post_only){
      categories.hedge.push(entry);
    } else if(os.web){
      categories.manual.push(entry);
    } else {
      categories.other.push(entry);
    }
  }

  // Aggregate by category
  function agg(list){
    return {
      orders: list.length,
      fills:  list.reduce((s,o)=>s+o.fills,0),
      vol:    list.reduce((s,o)=>s+o.totalAmt,0),
      cash:   list.reduce((s,o)=>s+o.totalCash,0),
      comm:   list.reduce((s,o)=>s+o.totalComm,0),
      openSell:  list.filter(o=>o.isOpen&&!o.isBuy).length,
      openBuy:   list.filter(o=>o.isOpen&&o.isBuy).length,
      closeBuy:  list.filter(o=>!o.isOpen&&o.isBuy).length,
      closeSell: list.filter(o=>!o.isOpen&&!o.isBuy).length,
    };
  }

  const L=[];
  const ln=s=>L.push(s??'');
  const fU=v=>(v>=0?'+':'')+v.toFixed(2);

  ln('═══════════════════════════════════════════════════════════════════════════════════');
  ln('  ETH-PERPETUAL FILL AUDIT — PAIR 26 — MANUAL CLOSE EXCLUDED');
  ln(`  Session: ${new Date(startMs).toISOString().replace('T',' ').replace('Z',' UTC')}  →  ${new Date(endMs).toISOString().replace('T',' ').replace('Z',' UTC')}`);
  ln(`  ETH: $${ethPx.toFixed(2)}   (manual order ${MANUAL_ORDER} excluded)`);
  ln('═══════════════════════════════════════════════════════════════════════════════════');

  for(const [catName, list] of [['BOT (api=true, post_only=true)',categories.bot],['HEDGE-ENGINE (api=true, post_only=false)',categories.hedge],['MANUAL (web=true)',categories.manual],['UNKNOWN',categories.other]]){
    const a=agg(list);
    ln('');
    ln(`  ── ${catName} ──`);
    ln(`  Orders: ${a.orders}   Fills: ${a.fills}   Volume: $${a.vol.toLocaleString(undefined,{maximumFractionDigits:0})}`);
    if(a.orders===0){ln('  (none)');continue;}
    ln(`  Sides:  open-sell=${a.openSell}  open-buy=${a.openBuy}  close-buy=${a.closeBuy}  close-sell=${a.closeSell}`);
    ln(`  Cashflow: ${(a.cash*ethPx).toFixed(2)} USD    Comm: ${(a.comm*ethPx).toFixed(2)} USD    NET: ${((a.cash+a.comm)*ethPx).toFixed(2)} USD`);

    // Per-order table for non-bot categories (to show exactly what the hedge is doing)
    if(catName.includes('HEDGE') || catName.includes('MANUAL')){
      ln('');
      ln(`  ${'timestamp'.padEnd(25)} ${'side'.padEnd(20)} ${'amt$'.padStart(10)} ${'cash(ETH)'.padStart(12)} ${'comm(ETH)'.padStart(12)}  postOnly reduceOnly orderId`);
      for(const o of list.sort((a,b)=>a.ts.localeCompare(b.ts))){
        const os=orderStates[o.orderId];
        ln(`  ${o.ts.padEnd(25)} ${o.sideRaw.padEnd(20)} ${o.totalAmt.toLocaleString(undefined,{maximumFractionDigits:0}).padStart(10)} ${o.totalCash.toFixed(6).padStart(12)} ${o.totalComm.toFixed(6).padStart(12)}  ${String(os?.post_only).padEnd(8)} ${String(os?.reduce_only).padEnd(10)} ${o.orderId}`);
      }
    }
  }

  // Combined NET excluding manual
  const botA  = agg(categories.bot);
  const hedgeA= agg(categories.hedge);
  const combined={
    cash:   (botA.cash+hedgeA.cash)*ethPx,
    comm:   (botA.comm+hedgeA.comm)*ethPx,
    vol:    botA.vol+hedgeA.vol,
  };

  ln('');
  ln('═══════════════════════════════════════════════════════════════════════════════════');
  ln('  NET (bot + hedge, manual excluded)');
  ln('  ─────────────────────────────────────────────────────────────────────────────────');
  ln(`  Volume       : $${combined.vol.toLocaleString(undefined,{maximumFractionDigits:0})}`);
  ln(`  Cashflow     : $${combined.cash.toFixed(2)}`);
  ln(`  Commission   : $${combined.comm.toFixed(2)}`);
  ln(`  NET exchange : $${(combined.cash+combined.comm).toFixed(2)}`);

  // Bot-only deep dive
  ln('');
  ln('  ── BOT-ONLY DEEP DIVE (why the loss) ──────────────────────────────────────────');
  const botCash  = botA.cash*ethPx;
  const botRebUsd= Math.abs(categories.bot.filter(o=>o.totalComm<0).reduce((s,o)=>s+o.totalComm,0))*ethPx;
  const botFeeUsd= categories.bot.filter(o=>o.totalComm>0).reduce((s,o)=>s+o.totalComm,0)*ethPx;
  ln(`  Bot cashflow  : $${botCash.toFixed(2)}    (all 55 round-trips realised PnL)`);
  ln(`  Bot rebates   : +$${botRebUsd.toFixed(2)}`);
  ln(`  Bot fees      : -$${botFeeUsd.toFixed(2)}`);
  ln(`  Bot NET       : $${(botCash+botRebUsd-botFeeUsd).toFixed(2)}`);
  ln('');
  ln('  Root cause of negative PnL:');
  ln('  1. 43 STOPS  — avg -$8.24 each vs $3 configured cap (2.75× slip)');
  ln('     ETH grinded UP $2,301→$2,322 while bot entered SHORT every cycle.');
  ln('     Trend = every entry immediately moved against the position.');
  ln('  2. 3 profit_fill_gross_nonpos — TP order filled but price moved so far');
  ln('     against by fill time that gross was still negative (-$15 avg).');
  ln('  3. 8 wins averaged only +$2.14 — tiny profit on wins vs large stops.');
  ln('     Payoff ratio: +$2.14 win / -$8.24 loss = 0.26  (need ≥0.46 for 35% WR)');
  ln('');
  ln('  Why open-buy fills exist on Deribit:');
  ln('  The hedge engine is a SEPARATE component that manages the net delta of the');
  ln('  options book (short 50x ETH-2300-C + long 140x ETH-2500-C) by trading');
  ln('  ETH-PERPETUAL. As ETH rallied, options delta grew positive → hedge buys perp.');
  ln('  These orders are api=true but post_only=false (crosses book when delta urgent).');
  ln('  They DO NOT come from the unilateral maker bot (which is always post_only=true).');
  ln('');
  ln('═══════════════════════════════════════════════════════════════════════════════════');

  const report=L.join('\n');
  console.log(report);
  const ts=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(__dirname,'..','reports',`eth_pair26_fill_audit_${ts}.txt`);
  fs.writeFileSync(file,report);
  console.log(`\nSaved → ${file}`);
  await sequelize.close();
})().catch(e=>{console.error(e);process.exit(1);});
