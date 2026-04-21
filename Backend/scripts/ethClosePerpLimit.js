#!/usr/bin/env node
/**
 * Close ETH-PERPETUAL short for pair 22 via LIMIT (post_only, reduce_only).
 *
 *   node scripts/ethClosePerpLimit.js            # dry-run
 *   node scripts/ethClosePerpLimit.js --live     # actually place order
 *   node scripts/ethClosePerpLimit.js --live --pairId=22 --price=MARK
 *   node scripts/ethClosePerpLimit.js --live --price=2329.50
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

function decryptText(k, enc, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc',
    Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return dc.update(enc, 'base64', 'utf8') + dc.final('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: {
      grant_type: 'client_credentials', client_id: apiKey,
      client_secret: secret, scope: 'trade:read_write',
    },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}

async function dRpc(token, scope, method, params = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${method}`,
      { jsonrpc: '2.0', id: 1, method: `${scope}/${method}`, params },
      { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 30000, validateStatus: () => true });
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(2500 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${scope}/${method} HTTP ${r.status}`);
    if (e) throw new Error(`${scope}/${method}: ${e.message} (${e.code})`);
    return r.data.result;
  }
  throw new Error(`${scope}/${method}: too many retries`);
}

function parseArgs() {
  const out = { pairId: 22, live: false, price: 'MARK', offsetTicks: 0 };
  for (const a of process.argv.slice(2)) {
    if (a === '--live') out.live = true;
    else if (a.startsWith('--pairId=')) out.pairId = Number(a.split('=')[1]);
    else if (a.startsWith('--price=')) out.price = a.split('=')[1];
    else if (a.startsWith('--offsetTicks=')) out.offsetTicks = Number(a.split('=')[1]);
  }
  return out;
}

function roundToTick(px, tick) {
  return Math.round(px / tick) * tick;
}

async function main() {
  const args = parseArgs();
  console.log('args:', args);

  const pair = await StatArbInput.findByPk(args.pairId);
  if (!pair) throw new Error(`pair ${args.pairId} not found`);
  const execSym = pair.symbol1 || 'ETH-PERPETUAL';
  console.log('pair:', pair.id, pair.agentName, 'execSym:', execSym, 'acct:', pair.tradeAccountA);

  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acct) throw new Error(`account ${pair.tradeAccountA} not found`);
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const token = await getToken(decryptText(ak2, ak1, ak0), decryptText(sk2, sk1, sk0));

  const positions = await dRpc(token, 'private', 'get_positions', { currency: 'ETH', kind: 'future' });
  const perp = (positions || []).find((p) => p.instrument_name === execSym);
  if (!perp || Math.abs(perp.size || 0) < 1) {
    console.log('No open perp position on', execSym, '— nothing to close.');
    process.exit(0);
  }

  const sizeUsd = perp.size;
  const side = sizeUsd < 0 ? 'buy' : 'sell';
  const absSize = Math.abs(sizeUsd);
  console.log('Live position:', execSym, 'size=', sizeUsd, 'USD avg=', perp.average_price,
    'mark=', perp.mark_price, 'floatingPnL=', perp.floating_profit_loss, 'ETH');

  const book = await dRpc(null, 'public', 'get_order_book', { instrument_name: execSym, depth: 1 });
  const instr = await dRpc(null, 'public', 'get_instrument', { instrument_name: execSym });
  const tick = instr.tick_size || 0.05;
  console.log('book bid=', book.best_bid_price, 'ask=', book.best_ask_price,
    'mark=', book.mark_price, 'index=', book.index_price, 'tick=', tick);

  let limitPx;
  if (args.price === 'MARK') {
    limitPx = roundToTick(book.mark_price + args.offsetTicks * tick, tick);
  } else if (args.price === 'BID') {
    limitPx = roundToTick(book.best_bid_price + args.offsetTicks * tick, tick);
  } else if (args.price === 'ASK') {
    limitPx = roundToTick(book.best_ask_price + args.offsetTicks * tick, tick);
  } else {
    limitPx = roundToTick(Number(args.price), tick);
  }

  if (side === 'buy' && limitPx >= book.best_ask_price) {
    console.log(`WARN: buy limit ${limitPx} >= ask ${book.best_ask_price} — post_only will REJECT. Adjusting to bid ${book.best_bid_price}.`);
    limitPx = roundToTick(book.best_bid_price, tick);
  }
  if (side === 'sell' && limitPx <= book.best_bid_price) {
    console.log(`WARN: sell limit ${limitPx} <= bid ${book.best_bid_price} — post_only will REJECT. Adjusting to ask ${book.best_ask_price}.`);
    limitPx = roundToTick(book.best_ask_price, tick);
  }

  console.log('\n>>> PLAN <<<');
  console.log(`  ${side.toUpperCase()} ${absSize} USD ${execSym} @ ${limitPx}  (post_only, reduce_only)`);
  console.log(`  would close position of ${sizeUsd} USD (${perp.size_currency || ''} ETH)`);
  console.log(`  expected basis vs mark: ${(limitPx - book.mark_price).toFixed(2)}`);

  if (!args.live) {
    console.log('\n(dry-run — re-run with --live to actually submit)');
    process.exit(0);
  }

  const orderParams = {
    instrument_name: execSym,
    amount: absSize,
    type: 'limit',
    price: limitPx,
    post_only: true,
    reduce_only: true,
    label: `manual_close_pair${args.pairId}_${Date.now()}`,
  };
  console.log('\nsubmitting:', orderParams);
  const res = await dRpc(token, 'private', side, orderParams);
  console.log('\n>>> ORDER SUBMITTED <<<');
  console.log('order id :', res.order?.order_id);
  console.log('state    :', res.order?.order_state);
  console.log('price    :', res.order?.price);
  console.log('amount   :', res.order?.amount);
  console.log('filled   :', res.order?.filled_amount);
  if (res.trades && res.trades.length) {
    console.log('immediate fills:', res.trades.length);
    for (const t of res.trades) {
      console.log('  fill:', t.amount, '@', t.price, 'fee:', t.fee, t.fee_currency);
    }
  }

  await sleep(1500);
  const post = await dRpc(token, 'private', 'get_positions', { currency: 'ETH', kind: 'future' });
  const perpNow = (post || []).find((p) => p.instrument_name === execSym);
  console.log('\nposition now: size=', perpNow?.size || 0, 'USD');

  const open = await dRpc(token, 'private', 'get_open_orders_by_instrument', { instrument_name: execSym });
  console.log('open orders on', execSym, '→', (open || []).length);
  for (const o of open || []) {
    console.log('  ', o.order_id, o.direction, o.amount, '@', o.price, o.order_state, 'label=', o.label);
  }

  await sequelize.close();
}

main().catch(async (e) => {
  console.error('FAILED:', e.message, e.stack);
  try { await sequelize.close(); } catch (_) {}
  process.exit(1);
});
