#!/usr/bin/env node
/**
 * ETH options — entry-to-now reaction report.
 * Pulls each option fill for pair 22, grabs ETH spot at fill time (index
 * history), compares to current spot + current option mark, and attributes
 * option PnL to spot move vs time decay vs IV change.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

function dec(k, e, iv) { const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64')); return d.update(e, 'base64', 'utf8') + d.final('utf8'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getToken(k, s) { const r = await axios.post('https://www.deribit.com/api/v2/public/auth', { jsonrpc: '2.0', id: 1, method: 'public/auth', params: { grant_type: 'client_credentials', client_id: k, client_secret: s, scope: 'trade:read_write' } }); return r.data.result.access_token; }
async function rpc(t, scope, m, p = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await axios.post(`https://www.deribit.com/api/v2/${scope}/${m}`,
      { jsonrpc: '2.0', id: 1, method: `${scope}/${m}`, params: p },
      { headers: t ? { Authorization: `Bearer ${t}` } : {}, timeout: 30000, validateStatus: () => true });
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(2500 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${m} HTTP ${r.status}`);
    if (e) throw new Error(`${m}: ${e.message}`);
    return r.data.result;
  }
  throw new Error(`${m}: too many retries`);
}

function fmtUsd(n, d = 2) { if (n == null || !Number.isFinite(n)) return '-'; const s = n < 0 ? '-' : ''; return s + '$' + Math.abs(n).toFixed(d); }
function fmt(n, d = 6) { return n == null || !Number.isFinite(n) ? '-' : Number(n).toFixed(d); }
function fmtPct(n, d = 2) { return n == null || !Number.isFinite(n) ? '-' : (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%'; }
function tsStr(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }

async function getIndexAt(ts) {
  try {
    const r = await axios.get('https://www.deribit.com/api/v2/public/get_tradingview_chart_data', {
      params: { instrument_name: 'ETH-PERPETUAL', start_timestamp: ts - 600_000, end_timestamp: ts + 600_000, resolution: '1' },
      timeout: 15000,
    });
    const d = r.data?.result;
    if (d?.close?.length) {
      let best = 0, bestDelta = Infinity;
      for (let i = 0; i < d.ticks.length; i++) {
        const dt = Math.abs(d.ticks[i] - ts);
        if (dt < bestDelta) { bestDelta = dt; best = i; }
      }
      return d.close[best];
    }
  } catch (_) {}
  return null;
}
async function getOptionMarkAt(instr, ts) {
  try {
    const r = await axios.get('https://www.deribit.com/api/v2/public/get_tradingview_chart_data', {
      params: { instrument_name: instr, start_timestamp: ts - 600_000, end_timestamp: ts + 600_000, resolution: '1' },
      timeout: 15000,
    });
    const d = r.data?.result;
    if (d?.close?.length) {
      let best = 0, bestDelta = Infinity;
      for (let i = 0; i < d.ticks.length; i++) {
        const dt = Math.abs(d.ticks[i] - ts);
        if (dt < bestDelta) { bestDelta = dt; best = i; }
      }
      return d.close[best];
    }
  } catch (_) {}
  return null;
}

(async () => {
  const pair = await StatArbInput.findByPk(22);
  const acct = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const tok = await getToken(dec(ak2, ak1, ak0), dec(sk2, sk1, sk0));
  const botStartMs = new Date(pair.botStartedAt).getTime();

  const ixNow = await rpc(null, 'public', 'get_index_price', { index_name: 'eth_usd' });
  const idxNow = Number(ixNow?.index_price) || 0;

  const optsConfigured = JSON.parse(pair.optionInstruments || '[]');
  const instrNames = optsConfigured.map((o) => o.name);

  const allOptFills = [];
  for (let p = 0; p < 20; p++) {
    const r = await rpc(tok, 'private', 'get_user_trades_by_currency_and_time', {
      currency: 'ETH', kind: 'option',
      start_timestamp: botStartMs - 24 * 3600_000,
      end_timestamp: Date.now(), count: 1000, sorting: 'asc',
      include_old: true,
    });
    const t = r.trades || [];
    if (!t.length) break;
    allOptFills.push(...t);
    if (!r.has_more) break;
    await sleep(500);
  }
  const fills = allOptFills.filter((t) => instrNames.includes(t.instrument_name));

  const byInstr = {};
  for (const t of fills) {
    const k = t.instrument_name;
    byInstr[k] = byInstr[k] || { name: k, fills: [] };
    byInstr[k].fills.push(t);
  }

  const tickers = {};
  for (const n of instrNames) {
    tickers[n] = await rpc(null, 'public', 'ticker', { instrument_name: n });
    await sleep(200);
  }

  const lines = [];
  const L = (s) => lines.push(s);
  const now = new Date();

  L('');
  L('╔══════════════════════════════════════════════════════════════════════════════╗');
  L('║   ETH OPTIONS — ENTRY vs NOW, SPOT MOVE & OPTION REACTION                   ║');
  L(`║   Agent:    ${pair.agentName}`);
  L(`║   Fetched:  ${now.toISOString()}`);
  L(`║   ETH spot NOW:  ${fmtUsd(idxNow, 2)}`);
  L('╚══════════════════════════════════════════════════════════════════════════════╝');
  L('');

  let portOptionPlUsd = 0;
  let portSpotDeltaPlUsd = 0;

  for (const cfg of optsConfigured) {
    const instr = cfg.name;
    const group = byInstr[instr] || { fills: [] };
    const leg = group.fills;
    const t = tickers[instr] || {};
    const g = t.greeks || {};
    const markNow = Number(t.mark_price) || 0;

    let totalQty = 0, totalPrem = 0;
    for (const f of leg) {
      const q = f.direction === 'buy' ? f.amount : -f.amount;
      totalQty += q;
      totalPrem += q * Number(f.price || 0);
    }
    const avgEntry = totalQty !== 0 ? totalPrem / totalQty : 0;

    const firstFill = leg[0];
    const firstTs = firstFill ? firstFill.timestamp : null;
    const spotAtEntry = firstTs ? (await getIndexAt(firstTs)) : null;
    const spotMoveUsd = spotAtEntry != null ? idxNow - spotAtEntry : null;
    const spotMovePct = spotAtEntry != null ? (idxNow - spotAtEntry) / spotAtEntry : null;

    const markEth_Entry = avgEntry;
    const markEth_Now = markNow;
    const markChangeEth = markEth_Now - markEth_Entry;
    const avgIdx = spotAtEntry != null ? (spotAtEntry + idxNow) / 2 : idxNow;
    const markChangeUsd_entryIdx = spotAtEntry ? markEth_Entry * spotAtEntry : 0;
    const markChangeUsd_nowIdx = markEth_Now * idxNow;

    const legPl_eth = -totalQty * (markEth_Now - markEth_Entry) * -1;
    const pnlEth = (markEth_Now - markEth_Entry) * totalQty * -1 * -1;
    const pnlEthCorrect = totalQty * (markEth_Now - markEth_Entry);
    const pnlUsd = pnlEthCorrect * idxNow;

    const delta = Number(g.delta) || 0;
    const attribDelta_eth_perContract = spotAtEntry != null ? delta * (idxNow - spotAtEntry) / idxNow : 0;
    const attribDelta_eth = attribDelta_eth_perContract * totalQty;
    const attribDelta_usd = attribDelta_eth * idxNow;
    const residualUsd = pnlUsd - attribDelta_usd;

    portOptionPlUsd += pnlUsd;
    portSpotDeltaPlUsd += attribDelta_usd;

    L('════════════════════════════════════════════════════════════════════════════════');
    L(`  ${instr}  (configured ${cfg.size}, filled ${totalQty})`);
    L('════════════════════════════════════════════════════════════════════════════════');
    L('');
    L('  FILL HISTORY');
    L('  +----+---------------------+------+---------+-----------+------------+----------+');
    L('  |  # | time (UTC)          | side | amount  | price ETH | price USD  | liq      |');
    L('  +----+---------------------+------+---------+-----------+------------+----------+');
    let i = 0;
    for (const f of leg) {
      i++;
      const px = Number(f.price || 0);
      const usd = spotAtEntry ? px * spotAtEntry : (px * idxNow);
      L('  | ' + String(i).padStart(2) + ' | ' + tsStr(f.timestamp).padEnd(19) + ' | ' +
        String(f.direction).padEnd(4) + ' | ' + String(f.amount).padStart(7) + ' | ' +
        fmt(px, 6).padStart(9) + ' | ' + fmtUsd(usd, 2).padStart(10) + ' | ' +
        String(f.liquidity || '-').padEnd(8) + ' |');
    }
    L('  +----+---------------------+------+---------+-----------+------------+----------+');
    L(`  Net filled: ${totalQty}   Avg entry: ${fmt(avgEntry, 6)} ETH`);
    L('');
    L('  ENTRY vs NOW');
    L('  ------------');
    if (firstTs) {
      const ageMs = Date.now() - firstTs;
      const ageH = ageMs / 3600000;
      L(`  First fill at     : ${tsStr(firstTs)} UTC   (age ${ageH.toFixed(2)}h)`);
    }
    L(`  Spot at entry     : ${fmtUsd(spotAtEntry, 2)}  (ETH-PERPETUAL)`);
    L(`  Spot now          : ${fmtUsd(idxNow, 2)}`);
    L(`  Spot move         : ${spotMoveUsd != null ? (spotMoveUsd >= 0 ? '+' : '') + fmtUsd(spotMoveUsd, 2) : '-'}  (${fmtPct(spotMovePct, 2)})`);
    L('');
    L(`  Option mark entry : ${fmt(markEth_Entry, 6)} ETH  (${fmtUsd(markChangeUsd_entryIdx, 2)})`);
    L(`  Option mark now   : ${fmt(markEth_Now, 6)} ETH  (${fmtUsd(markChangeUsd_nowIdx, 2)})`);
    L(`  Option mark Δ     : ${markChangeEth >= 0 ? '+' : ''}${fmt(markChangeEth, 6)} ETH   (${fmtPct(markEth_Entry ? markChangeEth / markEth_Entry : null, 2)})`);
    L('');
    L('  GREEKS NOW');
    L(`    delta            : ${fmt(delta, 4)}   (per contract)`);
    L(`    gamma            : ${fmt(g.gamma, 6)}`);
    L(`    vega             : ${fmt(g.vega, 4)}`);
    L(`    theta            : ${fmt(g.theta, 4)} (per day)`);
    L(`    mark IV          : ${fmt(t.mark_iv, 2)}%`);
    L('');
    L('  REACTION — how the option responded to the spot move');
    L('  -----------------------------------------------------');
    L(`  Actual leg PnL           : ${fmtUsd(pnlUsd, 2)}   (${fmt(pnlEthCorrect, 6)} ETH × ${fmtUsd(idxNow, 2)})`);
    L(`  Δ-implied PnL from spot  : ${fmtUsd(attribDelta_usd, 2)}   [delta=${fmt(delta, 4)} × spotMove=${fmtUsd(spotMoveUsd, 2)} × qty=${totalQty}]`);
    L(`  Residual (theta+IV+Γ)    : ${fmtUsd(residualUsd, 2)}`);
    L('');
    if (spotMoveUsd != null && Math.abs(spotMoveUsd) > 0.01) {
      const reactionPerUsd = pnlUsd / spotMoveUsd;
      const deltaOnly = delta * totalQty;
      L(`  Realised $/spot-$ move   : ${(reactionPerUsd).toFixed(3)}    (option $ change per $1 ETH move)`);
      L(`  Delta-only would be      : ${(deltaOnly).toFixed(3)}    (current delta × qty)`);
    }
    L('');
  }

  L('════════════════════════════════════════════════════════════════════════════════');
  L('PORTFOLIO ROLL-UP');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('');
  L(`  Total options PnL now         : ${fmtUsd(portOptionPlUsd, 2)}`);
  L(`    attributable to spot move (Δ): ${fmtUsd(portSpotDeltaPlUsd, 2)}`);
  L(`    residual (theta + IV + Γ)   : ${fmtUsd(portOptionPlUsd - portSpotDeltaPlUsd, 2)}`);
  L('');
  L('  Interpretation');
  L('  --------------');
  if (portSpotDeltaPlUsd > 0 && portOptionPlUsd < portSpotDeltaPlUsd) {
    L(`  Spot move was in our favour (gave +${fmtUsd(portSpotDeltaPlUsd, 2)} via delta) but we`);
    L(`  gave ${fmtUsd(portSpotDeltaPlUsd - portOptionPlUsd, 2)} of it back to theta / IV / gamma.`);
  } else if (portSpotDeltaPlUsd < 0) {
    L(`  Spot move was against us (cost ${fmtUsd(Math.abs(portSpotDeltaPlUsd), 2)} via delta).`);
  }
  L('');
  L('════════════════════════════════════════════════════════════════════════════════');
  L('END OF REPORT');
  L('════════════════════════════════════════════════════════════════════════════════');

  const body = lines.join('\n');
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const out = path.join(__dirname, '..', 'reports', `eth_options_entry_vs_now_${ts}.txt`);
  fs.writeFileSync(out, body);
  console.log(body);
  console.error('\nWritten →', out);
  await sequelize.close();
})().catch(async (e) => { console.error('ERR', e.message, e.stack); try { await sequelize.close(); } catch (_) {} process.exit(1); });
