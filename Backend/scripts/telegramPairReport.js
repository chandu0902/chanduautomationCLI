#!/usr/bin/env node
'use strict';
/**
 * Standalone full-exchange report for one or all active pairs.
 * Runs in its own process — has its own rate limiter, no contention with live bot.
 *
 * Usage:
 *   node scripts/telegramPairReport.js --pairId=25
 *   node scripts/telegramPairReport.js --all
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');
const { signedRequest } = require('../src/controllers/apicontroller');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = (process.env.TELEGRAM_CHAT_ID || '').replace(/^=/, '').trim();
const API_PORT  = process.env.PORT || 4001;

/* ── helpers ─────────────────────────────────────────────────────────── */

function decryptText(k, e, iv) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k,'base64'), Buffer.from(iv,'base64'));
  return d.update(e,'base64','utf8') + d.final('utf8');
}

function getCredentials(acc) {
  const [ak0,ak1,ak2] = acc.Api_Key.split(',',3);
  const [sk0,sk1,sk2] = acc.Secret_Key.split(',',3);
  return { apiKey: decryptText(ak2,ak1,ak0), secretKey: decryptText(sk2,sk1,sk0) };
}

function detectCcy(pair) {
  const s = (pair.symbol1 || '').toUpperCase();
  if (s.includes('_USDC')) return 'USDC';
  if (s.startsWith('ETH')) return 'ETH';
  return 'BTC';
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return Promise.resolve();
  const payload = JSON.stringify({ chat_id: CHAT_ID, text: text.slice(0, 4096), parse_mode: 'HTML', disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { if (res.statusCode !== 200) console.warn('[TelegramPairReport] API', res.statusCode, body.slice(0,200)); resolve(); });
    });
    req.on('error', (e) => { console.warn('[TelegramPairReport] send error:', e.message); resolve(); });
    req.write(payload); req.end();
  });
}

function fetchExecutorState(pairId) {
  return new Promise((resolve) => {
    http.get(`http://localhost:${API_PORT}/api/pairs/${pairId}/trade/state`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

/* ── paginated fills ─────────────────────────────────────────────────── */

async function fetchAllFills(instrument, apiKey, secretKey, sinceMs) {
  const allFills = [];
  const PAGE = 500;
  const MAX_PAGES = 400;
  let cursorEndTs = Date.now();
  let prevCursorEndTs = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `/api/v2/private/get_user_trades_by_instrument_and_time?instrument_name=${encodeURIComponent(instrument)}&count=${PAGE}&sorting=desc&include_old=true&start_timestamp=${sinceMs}&end_timestamp=${cursorEndTs}`;
    const resp = await signedRequest(url, apiKey, secretKey);
    const data = resp?.result;
    const trades = Array.isArray(data?.trades) ? data.trades : (Array.isArray(data) ? data : []);
    if (trades.length === 0) break;
    allFills.push(...trades);
    const oldestTs = Math.min(...trades.map(t => Number(t.timestamp)).filter(Number.isFinite));
    if (!Number.isFinite(oldestTs)) break;
    if (!data?.has_more || trades.length < PAGE) break;
    // Slide window backward in time (this endpoint ignores end_seq — see Deribit docs)
    const nextEnd = oldestTs - 1;
    if (nextEnd <= sinceMs || nextEnd === prevCursorEndTs || nextEnd >= cursorEndTs) {
      console.warn(`[Report] fill time-pagination stopped (nextEnd=${nextEnd} sinceMs=${sinceMs})`);
      break;
    }
    prevCursorEndTs = cursorEndTs;
    cursorEndTs = nextEnd;
  }
  if (allFills.length >= PAGE * MAX_PAGES) {
    console.warn(`[Report] fill fetch hit page cap (${MAX_PAGES}), ${allFills.length} fills — report may be truncated`);
  }
  return allFills;
}

/* ── build full report for one pair ─────────────────────────────────── */

async function buildReport(pair) {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA }, raw: true });
  if (!acc) return `⚠️ Account not found for pair ${pair.id}`;

  const { apiKey, secretKey } = getCredentials(acc);
  const ccy      = detectCcy(pair);
  const isUsdc   = ccy === 'USDC';
  const tradedSym = (pair.tradeLeg || 'A').toUpperCase() === 'B' ? pair.symbol2 : pair.symbol1;

  const botStartedAt  = pair.botStartedAt ? new Date(pair.botStartedAt) : null;
  const botStartBalance = pair.botStartBalance ?? null;
  const sinceMs = botStartedAt ? botStartedAt.getTime() : Date.now() - 30 * 24 * 3600_000;

  // ── 1. Account summary ──────────────────────────────────────────────
  let equity = null, balance = null, sessionRpl = null, sessionUpl = null, availFunds = null;
  try {
    const a = (await signedRequest(`/api/v2/private/get_account_summary?currency=${ccy}&extended=true`, apiKey, secretKey))?.result;
    if (a) { equity = a.equity; balance = a.balance; sessionRpl = a.session_rpl ?? null; sessionUpl = a.session_upl ?? null; availFunds = a.available_funds ?? null; }
  } catch (e) { console.warn('balance err:', e.message); }

  // ── 2. Open futures positions ───────────────────────────────────────
  let positionsText = 'none';
  let unrealisedPnl = 0;
  try {
    const positions = ((await signedRequest(`/api/v2/private/get_positions?currency=${ccy}&kind=future`, apiKey, secretKey))?.result || []).filter(p => p.size !== 0);
    if (positions.length) {
      positionsText = positions.map(p => {
        unrealisedPnl += p.floating_profit_loss ?? 0;
        return `  ${p.instrument_name} ${p.direction} ${p.size} @ ${p.average_price}  uPnL: ${(p.floating_profit_loss ?? 0).toFixed(6)} ${ccy}`;
      }).join('\n');
    }
  } catch (e) { positionsText = `error: ${e.message}`; }

  // ── 3. Open options positions ───────────────────────────────────────
  let optionText = 'none';
  let optionPnl = 0;
  try {
    const opts = ((await signedRequest(`/api/v2/private/get_positions?currency=${ccy}&kind=option`, apiKey, secretKey))?.result || []).filter(p => p.size !== 0);
    if (opts.length) {
      optionText = opts.map(p => {
        optionPnl += p.floating_profit_loss ?? 0;
        const dir = p.direction === 'buy' ? '🟢 Long' : '🔴 Short';
        return `  ${p.instrument_name}  ${dir}  ${p.size}  uPnL: ${(p.floating_profit_loss ?? 0).toFixed(6)} ${ccy}`;
      }).join('\n');
    }
  } catch (e) { optionText = `error: ${e.message}`; }

  // ── 4. All fills since bot start (paginated) ────────────────────────
  let fills = [];
  try {
    console.log(`[Report] Fetching fills for ${tradedSym} since ${new Date(sinceMs).toISOString()}...`);
    fills = await fetchAllFills(tradedSym, apiKey, secretKey, sinceMs);
    console.log(`[Report] Got ${fills.length} fills`);
  } catch (e) { console.warn('fills err:', e.message); }

  let totalVolUsd = 0, totalRpl = 0, totalFees = 0, totalRebates = 0;
  let buys = 0, sells = 0, profitFills = 0, profitFillPnl = 0;
  for (const f of fills) {
    const amt = Math.abs(parseFloat(f.amount || 0));
    const fee = parseFloat(f.fee || 0);
    const pnl = parseFloat(f.profit_loss || 0);
    const dir = (f.direction || '').toLowerCase();
    totalVolUsd += amt;   // inverse perps: amount is in USD
    totalRpl    += pnl;
    totalFees   += fee;
    if (fee < 0) totalRebates += Math.abs(fee);
    if (dir === 'buy') buys++; else sells++;
    if (pnl > 0) { profitFills++; profitFillPnl += pnl; }
  }
  const roundtrips = Math.min(buys, sells);
  const winRate = roundtrips > 0 ? ((profitFills / fills.length) * 100).toFixed(1) : 'n/a';

  // ── 5. Executor state (bot internals) ──────────────────────────────
  const ex = await fetchExecutorState(pair.id);

  // ── Format ──────────────────────────────────────────────────────────
  const label  = pair.agentName || `Pair ${pair.id}`;
  const fmt    = (v, dp = 6) => isUsdc ? `$${v.toFixed(2)}` : `${v.toFixed(dp)} ${ccy}`;
  const fmtBal = (v) => v != null ? fmt(v, isUsdc ? 2 : 6) : 'n/a';
  const status = pair.tradingEnabled ? '🟢 TRADING' : '🔴 STOPPED';

  const uptimeMs = botStartedAt ? Date.now() - botStartedAt.getTime() : 0;
  const uptimeH  = Math.floor(uptimeMs / 3600_000);
  const uptimeM  = Math.floor((uptimeMs % 3600_000) / 60_000);
  const uptimeStr = botStartedAt ? `${uptimeH}h ${uptimeM}m` : 'n/a';
  const startStr  = botStartedAt ? botStartedAt.toUTCString() : 'n/a';

  const balChange = (balance != null && botStartBalance != null) ? balance - botStartBalance : null;

  const lines = [
    `📊 <b>Report — ${label}</b>  ${status}`,
    `${tradedSym}  |  ${new Date().toUTCString()}`,
    `  Started: ${startStr}  |  Uptime: ${uptimeStr}`,
    ``,
    `<b>💰 Account</b>`,
    `  Start bal:  ${fmtBal(botStartBalance)}`,
    `  Balance:    ${fmtBal(balance)}`,
    `  Equity:     ${fmtBal(equity)}`,
    `  Available:  ${fmtBal(availFunds)}`,
    `  Change:     ${balChange != null ? (balChange >= 0 ? '+' : '') + fmt(balChange) : 'n/a'}`,
    ``,
    `<b>📈 Session PnL</b>`,
    `  Realised:   ${sessionRpl != null ? fmt(sessionRpl) : 'n/a'}`,
    `  Unrealised: ${fmt(unrealisedPnl)}`,
    ``,
    `<b>📉 Perp Positions</b>`,
    positionsText,
    ``,
    `<b>📊 Option Positions</b>`,
    optionText,
    `  Option uPnL: ${fmt(optionPnl)}`,
    `  Option TP target: $${pair.optionProfitTargetUsd || 'n/a'}`,
    ``,
    `<b>🔢 Exchange Stats</b> (${fills.length} fills since bot start)`,
    `  Volume:       $${totalVolUsd.toFixed(0)} USD`,
    `  Realised PnL: ${fmt(totalRpl)}`,
    `  Total fees:   ${fmt(totalFees)}`,
    `  Maker rebates:${fmt(totalRebates)}`,
    ``,
    `<b>📋 Trades</b>`,
    `  Buys: ${buys}  |  Sells: ${sells}  |  Roundtrips: ${roundtrips}`,
    `  Win rate: ${winRate}%  |  Profit fills: ${profitFills}`,
    `  PnL from profit fills: ${fmt(profitFillPnl)}`,
  ];

  if (ex) {
    const adaptedLevels = ex.adaptedLevels ? ex.adaptedLevels.map(v => v.toFixed(4)).join(', ') : 'pending';
    const adaptedAt = ex.adaptedAt ? new Date(ex.adaptedAt).toUTCString() : 'never';
    lines.push(
      ``,
      `<b>⚙️ Bot Internals</b>`,
      `  State:          ${ex.state}`,
      `  Daily PnL:      $${(ex.dailyPnl || 0).toFixed(2)}  /  limit $${ex.dailyLossLimitUsd}`,
      `  Drawdown:       $${(ex.currentDrawdownUsd || 0).toFixed(2)}  /  limit $${ex.maxDrawdownUsd}`,
      `  Drawdown %:     ${(ex.currentDrawdownPct || 0).toFixed(2)}%  /  limit ${ex.drawdownPct}%`,
      `  Kill switch:    ${ex.killSwitchTriggered ? '🔴 TRIGGERED' : '✅ OK'}`,
      `  Open positions: ${ex.positions?.length || 0}  |  Filled qty: $${ex.filledQty || 0}`,
      `  Adapted levels: ${adaptedLevels}`,
      `  Adapted at:     ${adaptedAt}`,
      `  TP delta: $${ex.tpSpreadDelta}  |  SL delta: $${ex.slSpreadDelta}`,
      `  Option PnL (bot): $${(ex.optionPnlUsd ?? 0).toFixed(2)}  /  target $${ex.optionProfitTargetUsd}`,
    );
    if (ex.positions?.length) {
      lines.push(``, `<b>🎯 Grid Positions</b>`);
      for (const p of ex.positions) {
        lines.push(`  L${p.gridLevel}  fill=$${p.fillSpread}  best=$${p.bestSpread}  hold=${p.holdSec}s`);
      }
    }
  }

  return lines.join('\n');
}

/* ── main ────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const pairIdArg = (args.find(a => a.startsWith('--pairId=')) || '').split('=')[1];
  const pairId = pairIdArg ? parseInt(pairIdArg, 10) : null;

  if (!isAll && !pairId) {
    console.error('Usage: node telegramPairReport.js --pairId=25  OR  --all');
    process.exit(1);
  }

  await sequelize.authenticate();

  const pairs = isAll
    ? await StatArbInput.findAll({ where: { status: 'active' }, order: [['id','ASC']], raw: true })
    : await StatArbInput.findAll({ where: { id: pairId, status: 'active' }, raw: true });

  if (pairs.length === 0) {
    await sendTelegram('📊 No active pairs found.');
    await sequelize.close();
    return;
  }

  for (const pair of pairs) {
    try {
      console.log(`[Report] Building report for pair ${pair.id} (${pair.agentName})...`);
      const text = await buildReport(pair);
      await sendTelegram(text);
      console.log(`[Report] Sent for pair ${pair.id}`);
    } catch (e) {
      console.error(`[Report] Pair ${pair.id} failed:`, e.message);
      await sendTelegram(`⚠️ Report error for ${pair.agentName || `Pair ${pair.id}`}: ${e.message}`);
    }
  }

  await sequelize.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
