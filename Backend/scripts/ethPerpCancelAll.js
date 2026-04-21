#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');
function dec(k, e, iv) { const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64')); return d.update(e, 'base64', 'utf8') + d.final('utf8'); }
async function getToken(k, s) { const r = await axios.post('https://www.deribit.com/api/v2/public/auth', { jsonrpc: '2.0', id: 1, method: 'public/auth', params: { grant_type: 'client_credentials', client_id: k, client_secret: s, scope: 'trade:read_write' } }); return r.data.result.access_token; }
async function rpc(t, scope, m, p = {}) { const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${m}`, { jsonrpc: '2.0', id: 1, method: `${scope}/${m}`, params: p }, { headers: t ? { Authorization: `Bearer ${t}` } : {}, timeout: 20000 }); if (r.data.error) throw new Error(r.data.error.message); return r.data.result; }
(async () => {
  const pair = await StatArbInput.findByPk(22);
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3); const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));
  const open = await rpc(tok, 'private', 'get_open_orders_by_instrument', { instrument_name: 'ETH-PERPETUAL' });
  for (const o of open || []) { console.log('cancel', o.order_id, o.direction, o.amount, '@', o.price); await rpc(tok, 'private', 'cancel', { order_id: o.order_id }); }
  const after = await rpc(tok, 'private', 'get_open_orders_by_instrument', { instrument_name: 'ETH-PERPETUAL' });
  console.log('open now:', (after || []).length);
  const pos = await rpc(tok, 'private', 'get_positions', { currency: 'ETH', kind: 'future' });
  const perp = (pos || []).find((p) => p.instrument_name === 'ETH-PERPETUAL');
  console.log('position still:', perp?.size || 0, 'USD  avg:', perp?.average_price, 'floatingPnL:', perp?.floating_profit_loss, 'ETH');
  await sequelize.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
