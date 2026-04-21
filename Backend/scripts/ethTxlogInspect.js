#!/usr/bin/env node
/** Inspect a few txlog trade rows to see field layout (commission, change, etc.). */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios  = require('axios');
const crypto = require('crypto');
const { AccountDetails, StatArbInput, sequelize } = require('../src/models');

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
(async () => {
  const p = await StatArbInput.findByPk(26);
  const acc = await AccountDetails.findOne({ where: { Trade_Account: p.tradeAccountA } });
  const { apiKey, secretKey } = creds(acc);
  const token = await auth(apiKey, secretKey);

  const r = await axios.get('https://www.deribit.com/api/v2/private/get_transaction_log', {
    headers: { Authorization: `Bearer ${token}` },
    params: { currency: 'ETH', count: 10,
      start_timestamp: Date.UTC(2026, 3, 19, 6, 0, 0),
      end_timestamp: Date.UTC(2026, 3, 19, 6, 30, 0) },
    timeout: 15000
  });
  const logs = (r.data.result.logs || []).filter(x=>x.type==='trade').slice(0, 5);
  console.log(JSON.stringify(logs, null, 2));

  await sequelize.close();
})().catch(e=>{console.error(e);process.exit(1);});
