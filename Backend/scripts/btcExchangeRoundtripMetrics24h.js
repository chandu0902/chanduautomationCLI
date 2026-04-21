#!/usr/bin/env node
/**
 * Last N hours (default 24): metrics derived ONLY from Deribit
 * get_user_trades_by_currency_and_time on the pair's executed instrument.
 * No DB, no get_positions, no account_summary UPL / balance / MTM.
 *
 *   node scripts/btcExchangeRoundtripMetrics24h.js
 *   node scripts/btcExchangeRoundtripMetrics24h.js --pairId=19 --hours=24
 *
 * Writes: Backend/reports/btc_exchange_trades_metrics_<pairId>_<ts>.txt
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');
const { currencyFromSymbol } = require('../lib/btcDeribitReconcileSection');

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0',
    id: 1,
    method: 'public/auth',
    params: {
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secret,
      scope: 'trade:read_write',
    },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchInstrumentTradesWindow(token, currency, startMs, instrumentName) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(700);
    let r;
    for (let attempt = 0; attempt < 8; attempt++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          currency,
          start_timestamp: cur,
          end_timestamp: Date.now(),
          count: 1000,
          sorting: 'asc',
        },
        timeout: 25000,
        validateStatus: () => true,
      });
      const err = r.data?.error;
      if (r.status === 429 || err?.code === 10028) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (r.status >= 400) throw new Error(`get_user_trades HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    for (const t of trades) {
      if (t.instrument_name === instrumentName) all.push(t);
    }
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

function parseArgs() {
  let pairId = 19;
  let hours = 24;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairId=')) pairId = parseInt(a.split('=')[1], 10) || 19;
    if (a.startsWith('--hours=')) hours = Math.min(168, Math.max(1, parseFloat(a.split('=')[1]) || 24));
  }
  return { pairId, hours };
}

async function main() {
  const { pairId, hours } = parseArgs();
  await sequelize.authenticate();

  const endMs = Date.now();
  const startMs = endMs - hours * 3600000;
  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) {
    console.error(`pairId ${pairId} not found`);
    process.exit(1);
  }

  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  if (!acctName) {
    console.error('No tradeAccount on pair');
    process.exit(1);
  }

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    console.error('AccountDetails missing for', acctName);
    process.exit(1);
  }
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token = await getToken(apiKey, secret);
  await sleep(1200);

  const ix = await axios
    .get('https://www.deribit.com/api/v2/public/get_index_price', {
      params: { index_name: `${currency.toLowerCase()}_usd` },
    })
    .catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;
  const usd = (x) => (idx > 0 && Number.isFinite(Number(x)) ? Number(x) * idx : null);

  const fills = await fetchInstrumentTradesWindow(token, currency, startMs, execSym);

  let sumPl = 0;
  let sumFee = 0;
  let rebateBtc = 0;
  let takerPaidBtc = 0;
  const wins = [];
  const losses = [];
  let nClose = 0;
  let nOpenStyle = 0;

  for (const f of fills) {
    const pl = Number(f.profit_loss) || 0;
    const fee = Number(f.fee) || 0;
    sumPl += pl;
    sumFee += fee;
    if (fee < 0) rebateBtc += -fee;
    else if (fee > 0) takerPaidBtc += fee;

    if (pl !== 0) {
      nClose++;
      const econ = pl + fee;
      if (econ > 0) wins.push(econ);
      else if (econ < 0) losses.push(econ);
    } else {
      nOpenStyle++;
    }
  }

  const sumWinBtc = wins.reduce((s, x) => s + x, 0);
  const sumLossBtc = losses.reduce((s, x) => s + x, 0);
  const wN = wins.length;
  const lN = losses.length;
  const ratio = lN > 0 ? wN / lN : wN > 0 ? Infinity : null;
  const avgWinBtc = wN ? sumWinBtc / wN : null;
  const avgLossBtc = lN ? sumLossBtc / lN : null;
  const netBtc = sumPl + sumFee;
  const plMinusNegRebate = sumPl + rebateBtc;

  const lines = [];
  const L = (s) => {
    lines.push(s);
    console.log(s);
  };

  L('================================================================================');
  L('EXCHANGE TRADES ONLY (no position / no UPL / no DB)');
  L(`pairId=${pairId}  ${pair.agentName || ''}  account=${acctName}`);
  L(`instrument: ${execSym}  currency: ${currency}`);
  L(`window: last ${hours}h  ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`);
  L('source: get_user_trades_by_currency_and_time (rows filtered to instrument)');
  L('================================================================================');
  L('');
  L('--- Fill counts ---');
  L(`  total fills in window:     ${fills.length}`);
  L(`  fills with profit_loss≠0:  ${nClose}  (treated as realized PnL slices / “closes” on exchange)`);
  L(`  fills with profit_loss=0:  ${nOpenStyle}  (opens / rolls with no realized slice)`);
  L('');
  L('--- PnL incl. rebates & fees (wallet on fills: sum profit_loss + sum fee) ---');
  L(`  total (${currency}):                 ${netBtc.toFixed(8)}  ≈ $${usd(netBtc)?.toFixed(4) ?? 'n/a'}`);
  L(
    `  same as price PnL − rebates(+ to wallet) + taker:  ${sumPl.toFixed(8)} − ${rebateBtc.toFixed(8)} + ${takerPaidBtc.toFixed(8)} = ${netBtc.toFixed(8)}`
  );
  L(`  (API: rebate is negative fee; balance adds +|fee| so net = pl + fee = pl − rebate_magnitude + taker.)`);
  L('');
  L('--- Breakdown: mark PnL vs fees ---');
  L(
    `  mark PnL − (−rebate) = pl + rebate+ (${currency}):  ${plMinusNegRebate.toFixed(8)}  ≈ $${usd(plMinusNegRebate)?.toFixed(4) ?? 'n/a'}`
  );
  L(`  sum profit_loss (${currency}):     ${sumPl.toFixed(8)}  ≈ $${usd(sumPl)?.toFixed(4) ?? 'n/a'}  (price-only realized)`);
  L(`  sum fee (${currency}):               ${sumFee.toFixed(8)}  (= −maker_rebates + taker_paid)`);
  L(`  maker rebates to wallet (${currency}, +): ${rebateBtc.toFixed(8)}  ≈ $${usd(rebateBtc)?.toFixed(4) ?? 'n/a'}  (from fee<0)`);
  L(`  taker fees paid (${currency}):       ${takerPaidBtc.toFixed(8)}`);
  L('');
  L('--- Win / loss (exchange: each fill with profit_loss ≠ 0; slice = profit_loss + fee) ---');
  L(`  wins (pl+fee>0):           ${wN}`);
  L(`  losses (pl+fee<0):         ${lN}`);
  L(`  win / loss ratio:          ${ratio != null && Number.isFinite(ratio) ? ratio.toFixed(6) : ratio === Infinity ? 'inf' : 'n/a'}`);
  L('');
  L('--- Per-win / per-loss (exchange, among closing fills only; economic slice) ---');
  L(
    `  avg win (${currency} / slice):   ${avgWinBtc != null ? avgWinBtc.toFixed(8) : 'n/a'}  ≈ $${avgWinBtc != null ? usd(avgWinBtc)?.toFixed(4) : 'n/a'}`
  );
  L(
    `  avg loss (${currency} / slice):  ${avgLossBtc != null ? avgLossBtc.toFixed(8) : 'n/a'}  ≈ $${avgLossBtc != null ? usd(avgLossBtc)?.toFixed(4) : 'n/a'}  (signed negative)`
  );
  L(`  sum wins (${currency}):          ${sumWinBtc.toFixed(8)}`);
  L(`  sum losses (${currency}):        ${sumLossBtc.toFixed(8)}`);
  L('');
  L('Notes:');
  L('  • No get_positions, no account_summary, no DB — fills only.');
  L('  • “Win/loss” = per-fill (profit_loss + fee) on closing slices; not the same as strategy round trips.');
  L(`  • Index ${currency}/USD for USD column: $${idx ? idx.toFixed(2) : 'n/a'}`);
  L('================================================================================');

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(outDir, `btc_exchange_trades_metrics_${pairId}_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\nWrote', outPath);

  await sequelize.close();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
