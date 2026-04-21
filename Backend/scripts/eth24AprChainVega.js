#!/usr/bin/env node
/**
 * ETH 24-APR-26 call chain — vega / delta / theta / premium for every strike.
 * Helps decide which short strike to roll into to offset long 29-MAY-2400-C vega.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(m, p = {}) {
  const r = await axios.get(`https://www.deribit.com/api/v2/public/${m}`, { params: p, timeout: 15000 });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result;
}

(async () => {
  const ix = await rpc('get_index_price', { index_name: 'eth_usd' });
  const spot = Number(ix.index_price);
  console.log(`Current ETH spot: $${spot.toFixed(2)}`);
  console.log(`Current portfolio vega (targets):`);
  console.log(`  long  150 × ETH-29MAY26-2400-C : +$475 per 1 vol pt  (150 × 3.17)`);
  console.log(`  short 100 × ETH-24APR26-2300-C : -$126 per 1 vol pt  (100 × 1.26)`);
  console.log(`  net portfolio vega             : +$349 per 1 vol pt  (long vol)`);
  console.log('');
  console.log(`To VEGA-NEUTRALISE:   the new 24-APR short leg needs  ≈ -$475 vega`);
  console.log(`To HALF-NEUTRALISE :  needs ≈ -$240 vega`);
  console.log('');

  const instrs = await rpc('get_instruments', { currency: 'ETH', kind: 'option', expired: false });
  const target = '24APR26';
  const calls = (instrs || []).filter((i) => i.instrument_name.includes(target) && i.instrument_name.endsWith('-C'));
  calls.sort((a, b) => a.strike - b.strike);

  console.log(`24-APR-26 ETH calls (${calls.length} strikes, expires ${new Date(calls[0].expiration_timestamp).toISOString()})`);
  console.log('');
  console.log('  strike  mark ETH  mark $   bid $    ask $    delta   vega   theta   IV%   100ct vega$  100ct theta$/d   100ct prem $');
  console.log('  ------  --------  -------  -------  -------  ------  -----  ------  -----  ----------  --------------  ------------');

  const rows = [];
  for (const i of calls) {
    const t = await rpc('ticker', { instrument_name: i.instrument_name });
    const g = t.greeks || {};
    const bid = t.best_bid_price || 0, ask = t.best_ask_price || 0;
    const mark = t.mark_price || 0;
    const ivMark = t.mark_iv || 0;
    const bidUsd = bid * spot, askUsd = ask * spot, markUsd = mark * spot;
    const delta = g.delta || 0, vega = g.vega || 0, theta = g.theta || 0;
    const vega100 = vega * 100;
    const theta100 = theta * 100;
    const prem100 = markUsd * 100;
    rows.push({ strike: i.strike, mark, markUsd, bid, ask, bidUsd, askUsd, delta, vega, theta, ivMark, vega100, theta100, prem100 });
    console.log(
      `  ${String(i.strike).padStart(6)}  ${mark.toFixed(5).padStart(8)}  ${('$' + markUsd.toFixed(2)).padStart(7)}  ` +
      `${('$' + bidUsd.toFixed(2)).padStart(7)}  ${('$' + askUsd.toFixed(2)).padStart(7)}  ` +
      `${delta.toFixed(3).padStart(6)}  ${vega.toFixed(3).padStart(5)}  ${theta.toFixed(2).padStart(6)}  ${ivMark.toFixed(1).padStart(5)}  ` +
      `${('$' + vega100.toFixed(0)).padStart(10)}  ${('$' + theta100.toFixed(0)).padStart(14)}  ${('$' + prem100.toFixed(0)).padStart(12)}`
    );
    await sleep(100);
  }

  console.log('');
  console.log('Vega targets (choose contracts so short vega ≈ long vega of $475/pt):');
  console.log('');
  console.log('  strike  vega/contract  contracts_needed_to_match_$475  their_theta/day_$ income  their_premium_$ income');
  console.log('  ------  -------------  ------------------------------  ------------------------  ----------------------');
  for (const r of rows) {
    if (r.vega <= 0) continue;
    const need = 475 / r.vega;
    const thetaIncome = -r.theta * need;
    const premIncome = r.markUsd * need;
    console.log(
      `  ${String(r.strike).padStart(6)}  ${r.vega.toFixed(3).padStart(13)}  ${need.toFixed(0).padStart(30)}  ` +
      `${('$' + thetaIncome.toFixed(0)).padStart(24)}  ${('$' + premIncome.toFixed(0)).padStart(22)}`
    );
  }
  console.log('');
  console.log('NOTE: weekly vega is small → you need MANY more contracts to match a 42-day vega.');
  console.log('      Peak vega on 24-APR is at-the-money (≈ current spot $' + spot.toFixed(0) + ').');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
