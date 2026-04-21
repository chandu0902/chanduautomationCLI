#!/usr/bin/env node
/**
 * ETH options report — live from Deribit for pair 22.
 * Pulls option positions, marks, greeks, PnL and writes a text report.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

function dec(k, e, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getToken(k, s) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: k, client_secret: s, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}
async function rpc(t, scope, m, p = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${m}`,
      { jsonrpc: '2.0', id: 1, method: `${scope}/${m}`, params: p },
      { headers: t ? { Authorization: `Bearer ${t}` } : {}, timeout: 20000, validateStatus: () => true });
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(2500 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${m} HTTP ${r.status}`);
    if (e) throw new Error(`${m}: ${e.message}`);
    return r.data.result;
  }
  throw new Error(`${m}: too many retries`);
}

function fmtUsd(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toFixed(d);
}
function fmt(n, d = 6) { return n == null || !Number.isFinite(n) ? '-' : Number(n).toFixed(d); }
function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

(async () => {
  const pair = await StatArbInput.findByPk(22);
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));

  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', { params: { index_name: 'eth_usd' } });
  const idx = Number(ix.data?.result?.index_price) || 0;

  const configured = JSON.parse(pair.optionInstruments || '[]');

  const positions = await rpc(tok, 'private', 'get_positions', { currency: 'ETH', kind: 'option' });
  const openOpt = (positions || []).filter((p) => Math.abs(p.size || 0) > 0);

  const tickers = {};
  for (const p of openOpt) {
    tickers[p.instrument_name] = await rpc(null, 'public', 'ticker', { instrument_name: p.instrument_name });
    await sleep(200);
  }
  for (const c of configured) {
    if (!tickers[c.name]) {
      tickers[c.name] = await rpc(null, 'public', 'ticker', { instrument_name: c.name });
      await sleep(200);
    }
  }

  const summary = await rpc(tok, 'private', 'get_account_summary', { currency: 'ETH', extended: true });

  const lines = [];
  const L = (s) => lines.push(s);

  const now = new Date();
  L('');
  L('╔══════════════════════════════════════════════════════════════════════════════╗');
  L('║   ETH OPTIONS REPORT — live from Deribit                                    ║');
  L(`║   Agent:    ${pair.agentName}`);
  L(`║   Account:  ${pair.tradeAccountA}   pairId=22`);
  L(`║   Fetched:  ${now.toISOString()}`);
  L(`║   ETH idx:  ${fmtUsd(idx, 2)}`);
  L('╚══════════════════════════════════════════════════════════════════════════════╝');
  L('');

  L('════════════════════════════════════════════════════════════════════════════════');
  L('1. CONFIGURED OPTION LEGS  (from pair_22.optionInstruments)');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  for (const c of configured) {
    const t = tickers[c.name] || {};
    const g = t.greeks || {};
    L(`   ${c.name}`);
    L(`     configured size    : ${c.size}`);
    L(`     mark (ETH)         : ${fmt(t.mark_price, 6)}`);
    L(`     mark (USD)         : ${fmtUsd((t.mark_price || 0) * idx, 2)}`);
    L(`     bid/ask (ETH)      : ${fmt(t.best_bid_price, 6)} / ${fmt(t.best_ask_price, 6)}`);
    L(`     IV (mark)          : ${fmt(t.mark_iv, 2)}%`);
    L(`     delta              : ${fmt(g.delta, 4)}`);
    L(`     gamma              : ${fmt(g.gamma, 6)}`);
    L(`     vega               : ${fmt(g.vega, 4)}`);
    L(`     theta              : ${fmt(g.theta, 4)}`);
    L(`     underlying         : ${fmt(t.underlying_price, 2)}  (index ${fmt(t.index_price, 2)})`);
    L('');
  }

  L('════════════════════════════════════════════════════════════════════════════════');
  L(`2. LIVE OPEN OPTION POSITIONS  (${openOpt.length} legs)`);
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  L('   +---------------------------+----------+---------+---------+----------+-----------+-----------+-----------+-----------+');
  L('   | instrument                | size     | avg $   | mark $  | delta    | gamma     | vega      | theta     | UPL (USD) |');
  L('   +---------------------------+----------+---------+---------+----------+-----------+-----------+-----------+-----------+');

  let portDelta = 0, portGamma = 0, portVega = 0, portTheta = 0;
  let portUplEth = 0, portUplUsd = 0, portRplEth = 0;
  let notionalEth = 0;
  for (const p of openOpt) {
    const t = tickers[p.instrument_name] || {};
    const g = t.greeks || {};
    const size = Number(p.size) || 0;
    const mk = Number(t.mark_price) || 0;
    const av = Number(p.average_price) || 0;
    const fp = Number(p.floating_profit_loss) || 0;
    const rp = Number(p.realized_profit_loss) || 0;
    const contracts = size;
    const legDelta = (Number(g.delta) || 0) * contracts;
    const legGamma = (Number(g.gamma) || 0) * contracts;
    const legVega  = (Number(g.vega)  || 0) * contracts;
    const legTheta = (Number(g.theta) || 0) * contracts;
    portDelta += legDelta; portGamma += legGamma; portVega += legVega; portTheta += legTheta;
    portUplEth += fp; portUplUsd += fp * idx; portRplEth += rp;
    notionalEth += Math.abs(contracts * mk);
    L('   | ' + pad(p.instrument_name, 25) + ' | ' +
      padL(contracts, 8) + ' | ' +
      padL(fmt(av, 5), 7) + ' | ' +
      padL(fmt(mk, 5), 7) + ' | ' +
      padL(fmt(legDelta, 2), 8) + ' | ' +
      padL(fmt(legGamma, 5), 9) + ' | ' +
      padL(fmt(legVega, 2), 9) + ' | ' +
      padL(fmt(legTheta, 2), 9) + ' | ' +
      padL(fmtUsd(fp * idx, 2), 9) + ' |');
  }
  L('   +---------------------------+----------+---------+---------+----------+-----------+-----------+-----------+-----------+');
  L('');
  L(`   PORTFOLIO GREEKS (options-only):`);
  L(`     Δ delta   : ${fmt(portDelta, 3)}   (≈ ${fmt(portDelta, 3)} ETH equivalent)`);
  L(`     Γ gamma   : ${fmt(portGamma, 5)}`);
  L(`     V vega    : ${fmt(portVega, 3)}     (per 1 vol pt move)`);
  L(`     Θ theta   : ${fmt(portTheta, 3)}    (per day)`);
  L(`     Σ mark notional (ETH) : ${fmt(notionalEth, 6)}  (${fmtUsd(notionalEth * idx, 2)})`);
  L('');
  L(`   PORTFOLIO PnL (options-only):`);
  L(`     UPL unrealized :  ${fmt(portUplEth, 6)} ETH  (${fmtUsd(portUplUsd, 2)})`);
  L(`     RPL realized   :  ${fmt(portRplEth, 6)} ETH  (${fmtUsd(portRplEth * idx, 2)})`);
  L('');

  L('════════════════════════════════════════════════════════════════════════════════');
  L('3. HEDGE STRUCTURE — intent');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  L('   The hedge is a CALL SPREAD financed by a short near-dated call:');
  L('     SHORT 100  ETH-24APR26-2300-C   — short-dated call, collects premium');
  L('     LONG  150  ETH-29MAY26-2400-C   — longer-dated call, buys upside above 2400');
  L('');
  L('   Intended protection');
  L('     • below 2300 : both calls expire worthless, keep premium on the short');
  L('                    (minus residual premium on the long).');
  L('     • 2300-2400  : short call pays intrinsic, long call OTM → loss zone.');
  L('     • above 2400 : long call kicks in and covers the short; size 150 vs 100');
  L('                    means +50 net long calls above 2400 ⇒ convex upside.');
  L('');
  L(`   Current spot: ${fmtUsd(idx, 2)}`);
  if (idx < 2300) L('   ⇒ in the below-2300 zone (premium-capture mode).');
  else if (idx < 2400) L('   ⇒ in the 2300-2400 pain zone (short call ITM, long call OTM).');
  else L('   ⇒ above 2400 (convex-upside zone, long call covers + adds).');
  L('');

  L('════════════════════════════════════════════════════════════════════════════════');
  L('4. OPTION PROFIT TARGET / KILL');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  L(`   optionProfitTargetUsd  : ${fmtUsd(pair.optionProfitTargetUsd, 2)}`);
  L(`   current options UPL    : ${fmtUsd(portUplUsd, 2)}`);
  L(`   distance to TP         : ${fmtUsd((pair.optionProfitTargetUsd || 0) - portUplUsd, 2)}`);
  L('');

  L('════════════════════════════════════════════════════════════════════════════════');
  L('5. ACCOUNT CONTEXT');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  L(`   wallet (ETH)        : ${fmt(summary.balance, 8)}  (${fmtUsd((summary.balance || 0) * idx, 2)})`);
  L(`   equity (ETH)        : ${fmt(summary.equity, 8)}  (${fmtUsd((summary.equity || 0) * idx, 2)})`);
  L(`   total UPL (ETH)     : ${fmt(summary.total_pl, 8)}  (${fmtUsd((summary.total_pl || 0) * idx, 2)})`);
  L(`   options UPL (ETH)   : ${fmt(summary.options_pl, 8)}  (${fmtUsd((summary.options_pl || 0) * idx, 2)})`);
  L(`   futures UPL (ETH)   : ${fmt(summary.futures_pl, 8)}  (${fmtUsd((summary.futures_pl || 0) * idx, 2)})`);
  L(`   options value       : ${fmt(summary.options_value, 8)}`);
  L(`   options delta       : ${fmt(summary.options_delta, 4)}`);
  L(`   options gamma       : ${fmt(summary.options_gamma, 6)}`);
  L(`   options vega        : ${fmt(summary.options_vega, 4)}`);
  L(`   options theta       : ${fmt(summary.options_theta, 4)}`);
  L(`   margin balance      : ${fmt(summary.margin_balance, 8)}`);
  L(`   available funds     : ${fmt(summary.available_funds, 8)}`);
  L('');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('END OF OPTIONS REPORT');
  L('════════════════════════════════════════════════════════════════════════════════');

  const body = lines.join('\n');
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(__dirname, '..', 'reports', `eth_options_report_${ts}.txt`);
  fs.writeFileSync(outPath, body);
  console.log(body);
  console.error('\nWritten →', outPath);

  await sequelize.close();
})().catch(async (e) => { console.error('ERR', e.message, e.stack); try { await sequelize.close(); } catch (_) {} process.exit(1); });
