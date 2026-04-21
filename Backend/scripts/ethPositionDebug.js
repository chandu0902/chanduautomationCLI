#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const { AccountDetails, sequelize } = require('../src/models');

function decrypt(k, enc, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return d.update(enc,'base64','utf8') + d.final('utf8');
}
async function auth(k,s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth',{
    jsonrpc:'2.0',id:1,method:'public/auth',
    params:{grant_type:'client_credentials',client_id:k,client_secret:s,scope:'trade:read_write'}});
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
(async () => {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: 'ETHHIDDEN_ROAD' } });
  const [a0,a1,a2] = acc.Api_Key.split(',',3);
  const [s0,s1,s2] = acc.Secret_Key.split(',',3);
  const apiKey = decrypt(a2,a1,a0);
  const secretKey = decrypt(s2,s1,s0);
  const token = await auth(apiKey, secretKey);

  // ALL positions (no kind filter)
  const allPos = await axios.get('https://www.deribit.com/api/v2/private/get_positions',{
    headers:{Authorization:`Bearer ${token}`},
    params:{currency:'ETH'}, timeout:15000
  });
  const positions = (allPos.data.result || []).filter(p => p.size !== 0);

  console.log('═══ ALL NON-ZERO ETH POSITIONS ON ETHHIDDEN_ROAD ═══');
  for (const p of positions) {
    console.log(`${p.instrument_name.padEnd(30)} kind=${(p.kind||'').padEnd(8)} size=${String(p.size).padStart(10)}  avg=${p.average_price}  direction=${p.direction}  uPnL=${(p.floating_profit_loss||0).toFixed(6)} ETH  mark=${p.mark_price}`);
  }

  // Transaction log last 30 min — look at ALL types, not just trade
  const endMs = Date.now();
  const startMs = endMs - 30 * 60 * 1000;
  const logs = [];
  let cont;
  for (let i=0;i<10;i++) {
    const params = { currency: 'ETH', start_timestamp: startMs, end_timestamp: endMs, count: 1000 };
    if (cont) params.continuation = cont;
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log',{
      headers:{Authorization:`Bearer ${token}`}, params, timeout:20000
    });
    const got = r?.data?.result?.logs || [];
    logs.push(...got);
    cont = r?.data?.result?.continuation;
    if (!cont || !got.length) break;
  }

  // Count by type and instrument
  const byType = {};
  const takers = [];
  for (const l of logs) {
    const k = `${l.type}|${l.instrument_name || '-'}`;
    byType[k] = (byType[k] || 0) + 1;
    if (l.type === 'trade' && (l.fee_role === 'taker' || l.user_role === 'taker')) takers.push(l);
  }
  console.log('\n═══ LAST 30 MIN — txlog type × instrument ═══');
  for (const [k,v] of Object.entries(byType).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }

  console.log('\n═══ TAKER FILLS (last 30 min) ═══');
  for (const t of takers) {
    console.log(`${new Date(t.timestamp).toISOString()} ${t.instrument_name} side=${t.side} amount=${t.amount} price=${t.price} comm=${t.commission} order_id=${t.order_id}`);
  }

  // Get user_trades for the last 30 min to see actual buys
  const ut = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time',{
    headers:{Authorization:`Bearer ${token}`},
    params:{currency:'ETH', start_timestamp:startMs, end_timestamp:endMs, count:1000}, timeout:15000
  });
  const utTrades = ut.data.result?.trades || [];
  console.log(`\n═══ get_user_trades last 30 min ═══`);
  console.log(`total: ${utTrades.length}`);
  const buys = utTrades.filter(t => t.direction === 'buy');
  const sells = utTrades.filter(t => t.direction === 'sell');
  console.log(`buys: ${buys.length}  sells: ${sells.length}`);
  console.log('sample buys (first 5):');
  for (const t of buys.slice(0,5)) {
    console.log(`  ${new Date(t.timestamp).toISOString()} ${t.instrument_name} ${t.direction} amount=${t.amount} price=${t.price} order_id=${t.order_id} liquidity=${t.liquidity}`);
  }

  await sequelize.close();
})().catch(e => { console.error(e); process.exit(1); });
