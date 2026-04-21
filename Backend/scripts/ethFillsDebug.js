#!/usr/bin/env node
/** Quick debug: fetch ETH futures fills day-by-day, cross-check with txlog trade rows. */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const { AccountDetails, StatArbInput, sequelize } = require('../src/models');

const CCY = 'ETH';
const START = Date.UTC(2026, 3, 16, 0, 0, 0);
const END   = Date.now();

function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return d.update(enc,'base64','utf8')+d.final('utf8');
}
function creds(acc) {
  const [a0,a1,a2] = acc.Api_Key.split(',',3);
  const [s0,s1,s2] = acc.Secret_Key.split(',',3);
  return { apiKey: decrypt(a2,a1,a0), secretKey: decrypt(s2,s1,s0) };
}
async function auth(k,s){
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth',{jsonrpc:'2.0',id:1,method:'public/auth',params:{grant_type:'client_credentials',client_id:k,client_secret:s,scope:'trade:read_write'}});
  return r.data.result.access_token;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function fetchPage(token, startMs, endMs) {
  const all = []; let cur = startMs;
  for (let i=0;i<200;i++) {
    await sleep(250);
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time',{
      headers:{Authorization:`Bearer ${token}`},
      params:{currency:CCY,kind:'future',start_timestamp:cur,end_timestamp:endMs,count:1000,sorting:'asc',include_old:true},
      timeout:30000, validateStatus:()=>true
    });
    const t = r?.data?.result?.trades || [];
    all.push(...t);
    if (!r?.data?.result?.has_more || !t.length) break;
    cur = t[t.length-1].timestamp + 1;
    if (cur >= endMs) break;
  }
  return all;
}

async function fetchTxLog(token, startMs, endMs) {
  const all = []; let cont;
  for (let i=0;i<200;i++) {
    await sleep(250);
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

(async () => {
  const p = await StatArbInput.findByPk(26);
  const acc = await AccountDetails.findOne({ where: { Trade_Account: p.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  // ── daily buckets ──
  console.log('=== DAY-BY-DAY fills (get_user_trades_by_currency_and_time, kind=future) ===');
  const dayMs = 86400000;
  let grand = { n:0, vol:0 };
  for (let d = START; d < END; d += dayMs) {
    const e = Math.min(d + dayMs, END);
    const fills = await fetchPage(token, d, e);
    const vol = fills.reduce((s,f)=>s+parseFloat(f.amount),0);
    console.log(`  ${new Date(d).toISOString().slice(0,10)}  fills=${String(fills.length).padStart(5)}  volUsd=${vol.toLocaleString()}`);
    grand.n += fills.length; grand.vol += vol;
    // top inst breakdown
    const byInst = {};
    for (const f of fills) { (byInst[f.instrument_name]=byInst[f.instrument_name]||{n:0,v:0}); byInst[f.instrument_name].n++; byInst[f.instrument_name].v += parseFloat(f.amount); }
    for (const [k,v] of Object.entries(byInst)) console.log(`      ${k.padEnd(28)} n=${v.n}  volUsd=${v.v.toLocaleString()}`);
  }
  console.log(`  GRAND  fills=${grand.n}  volUsd=${grand.vol.toLocaleString()}`);
  console.log('');

  // ── txlog cross-check: sum trade-type rows ──
  console.log('=== TXLOG cross-check (currency=ETH, full window) ===');
  const tx = await fetchTxLog(token, START, END);
  const byType = {};
  for (const t of tx) {
    const k = t.type || 'unknown';
    (byType[k] = byType[k] || { n:0, usdNotional:0, ethChange:0 });
    byType[k].n++;
    byType[k].ethChange += parseFloat(t.change || 0);
    if (t.type === 'trade') {
      // 'amount' field on txlog trade rows (USD for inverse)
      const amt = parseFloat(t.amount || 0);
      byType[k].usdNotional += Math.abs(amt);
    }
  }
  console.log(`  txlog total rows: ${tx.length}`);
  for (const [k,v] of Object.entries(byType)) {
    console.log(`    ${k.padEnd(18)} n=${String(v.n).padStart(5)}  ethChange=${v.ethChange.toFixed(6)}  usdNotional=${v.usdNotional.toLocaleString()}`);
  }

  // ── also print total of 'amount' from trade rows with instrument breakdown ──
  const tradeRows = tx.filter(t=>t.type==='trade');
  const instVol = {};
  for (const t of tradeRows) {
    const k = t.instrument_name || '(none)';
    (instVol[k] = instVol[k]||{n:0,v:0});
    instVol[k].n++;
    instVol[k].v += Math.abs(parseFloat(t.amount||0));
  }
  console.log('\n  txlog trade rows by instrument:');
  for (const [k,v] of Object.entries(instVol).sort((a,b)=>b[1].v-a[1].v))
    console.log(`    ${k.padEnd(28)} n=${String(v.n).padStart(5)}  volUsd=${v.v.toLocaleString()}`);

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
