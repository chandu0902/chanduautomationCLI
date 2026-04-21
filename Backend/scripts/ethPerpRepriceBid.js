#!/usr/bin/env node
/**
 * Cancel existing ETH-PERPETUAL reduce_only orders and re-place a single
 * post_only BUY at current best bid to close the short.
 */
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
  if (r.data.error) throw new Error(`${m}: ${r.data.error.message}`);
  return r.data.result;
}

(async () => {
  const pair = await StatArbInput.findByPk(22);
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));
  const SYM = 'ETH-PERPETUAL';

  const pos0 = await rpc(tok, 'private', 'get_positions', { currency: 'ETH', kind: 'future' });
  const perp = (pos0 || []).find((p) => p.instrument_name === SYM);
  if (!perp || Math.abs(perp.size) < 1) { console.log('No position to close.'); process.exit(0); }
  const side = perp.size < 0 ? 'buy' : 'sell';
  const amount = Math.abs(perp.size);
  console.log('position:', perp.size, 'USD  avg:', perp.average_price, 'floatingPnL:', perp.floating_profit_loss, 'ETH');

  const open = await rpc(tok, 'private', 'get_open_orders_by_instrument', { instrument_name: SYM });
  for (const o of open || []) {
    console.log('cancel:', o.order_id, o.direction, o.amount, '@', o.price);
    await rpc(tok, 'private', 'cancel', { order_id: o.order_id });
  }

  const book = await rpc(null, 'public', 'get_order_book', { instrument_name: SYM, depth: 1 });
  const tick = 0.05;
  let px = side === 'buy' ? book.best_bid_price : book.best_ask_price;
  px = Math.round(px / tick) * tick;
  console.log(`book bid=${book.best_bid_price} ask=${book.best_ask_price} mark=${book.mark_price}`);
  console.log(`placing ${side.toUpperCase()} ${amount} @ ${px} post_only reduce_only`);

  const res = await rpc(tok, 'private', side, {
    instrument_name: SYM, amount, type: 'limit', price: px,
    post_only: true, reduce_only: true,
    label: `manual_close_pair22_${Date.now()}`,
  });
  console.log('order:', res.order?.order_id, res.order?.order_state, 'price=', res.order?.price, 'filled=', res.order?.filled_amount);
  if (res.trades?.length) {
    for (const t of res.trades) console.log('  fill:', t.amount, '@', t.price, 'fee:', t.fee, t.fee_currency);
  }

  await sequelize.close();
})().catch(async (e) => { console.error('ERR:', e.message, e.stack); try { await sequelize.close(); } catch (_) {} process.exit(1); });
