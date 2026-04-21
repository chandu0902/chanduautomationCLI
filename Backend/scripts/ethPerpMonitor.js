#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

function dec(k, e, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getToken(k, s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', { jsonrpc: '2.0', id: 1, method: 'public/auth', params: { grant_type: 'client_credentials', client_id: k, client_secret: s, scope: 'trade:read_write' } });
  return r.data.result.access_token;
}
async function rpc(t, scope, m, p = {}) {
  const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${m}`, { jsonrpc: '2.0', id: 1, method: `${scope}/${m}`, params: p }, { headers: t ? { Authorization: `Bearer ${t}` } : {}, timeout: 20000 });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result;
}

(async () => {
  const pair = await StatArbInput.findByPk(22);
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));

  for (let i = 0; i < 12; i++) {
    const pos = await rpc(tok, 'private', 'get_positions', { currency: 'ETH', kind: 'future' });
    const perp = (pos || []).find((p) => p.instrument_name === 'ETH-PERPETUAL');
    const book = await rpc(null, 'public', 'get_order_book', { instrument_name: 'ETH-PERPETUAL', depth: 1 });
    const open = await rpc(tok, 'private', 'get_open_orders_by_instrument', { instrument_name: 'ETH-PERPETUAL' });
    const o = (open || [])[0];
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] pos=${perp?.size || 0} USD  bid=${book.best_bid_price} ask=${book.best_ask_price} mark=${book.mark_price}  order:${o ? `${o.price} filled=${o.filled_amount}/${o.amount} ${o.order_state}` : 'NONE'}`);
    if (!perp || Math.abs(perp.size) < 1) { console.log('CLOSED.'); break; }
    if (!o) { console.log('No open order — cancelled/filled/rejected.'); break; }
    await sleep(5000);
  }
  await sequelize.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
