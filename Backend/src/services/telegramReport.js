'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { signedRequest } = require('../controllers/apicontroller');
const { StatArbInput, AccountDetails, BasisPosition } = require('../models');

// Exit-reason buckets — authoritative classification comes from
// basis_positions.exitReason (written by unilateralExecutor). Stop-loss
// exits are NOT counted as round-trips (RTPs); only profit-order exits are.
const SL_EXIT_REASONS = new Set(['stop', 'stop_loss', 'hold_cap']);
const RTP_EXIT_REASONS = new Set(['profit', 'profit_fill_gross_nonpos']);

const API_PORT = process.env.PORT || 4001;

function fetchExecutorState(pairId) {
  return new Promise((resolve) => {
    http.get(`http://localhost:${API_PORT}/api/pairs/${pairId}/trade/state`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return d.update(encryptedText, 'base64', 'utf8') + d.final('utf8');
}

function getCredentials(account) {
  const [ak0, ak1, ak2] = account.Api_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const [sk0, sk1, sk2] = account.Secret_Key.split(',', 3);
  const secretKey = decryptText(sk2, sk1, sk0);
  return { apiKey, secretKey };
}

function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[TelegramReport] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return Promise.resolve();
  }
  const payload = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) console.warn(`[TelegramReport] API ${res.statusCode}: ${body.slice(0, 200)}`);
          resolve();
        });
      }
    );
    req.on('error', (e) => { console.warn(`[TelegramReport] send error: ${e.message}`); resolve(); });
    req.write(payload);
    req.end();
  });
}


/**
 * Fetch everything from the exchange for each active pair and send
 * a consolidated Telegram alert. All numbers come from exchange data.
 */
async function _buildPairReportLines(pair) {
  const lines = [];
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) {
    lines.push(`\n<b>${pair.agentName || `Pair ${pair.id}`}</b>: account not found`);
    return lines;
  }

  const cred = getCredentials(acc);
  const sym = (pair.symbol1 || '').toUpperCase();
  const ccy = sym.includes('_USDC') ? 'USDC' : (sym.startsWith('ETH') ? 'ETH' : 'BTC');
  const isUsdc = ccy === 'USDC';
  const tradedSymbol = (pair.tradeLeg || 'A').toUpperCase() === 'B' ? pair.symbol2 : pair.symbol1;

  const botStartedAt = pair.botStartedAt ? new Date(pair.botStartedAt) : null;
  const botStartBalance = pair.botStartBalance ?? null;

  // ── Account summary (1 API call) ─────────────────────────────────────
  let equity = null, balance = null, sessionRpl = null, sessionUpl = null, availableFunds = null;
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_account_summary?currency=${ccy}&extended=true`,
      cred.apiKey, cred.secretKey
    );
    const a = resp?.result;
    if (a) {
      equity = a.equity;
      balance = a.balance;
      sessionRpl = a.session_rpl ?? null;
      sessionUpl = a.session_upl ?? null;
      availableFunds = a.available_funds ?? null;
    }
  } catch (e) {
    console.warn(`[TelegramReport] pair ${pair.id} balance: ${e.message}`);
  }

  // ── Open futures positions (1 API call) ──────────────────────────────
  let positionsText = 'none';
  let unrealisedPnl = 0;
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
      cred.apiKey, cred.secretKey
    );
    const positions = (Array.isArray(resp?.result) ? resp.result : []).filter(p => p.size !== 0);
    if (positions.length > 0) {
      positionsText = positions.map(p => {
        unrealisedPnl += p.floating_profit_loss ?? 0;
        return `  ${p.instrument_name} ${p.direction} ${p.size} @ ${p.average_price} uPnl=${(p.floating_profit_loss ?? 0).toFixed(4)}`;
      }).join('\n');
    }
  } catch (e) {
    positionsText = `error: ${e.message}`;
  }

  const pairLabel = pair.agentName || `Pair ${pair.id}`;
  const fmtUnit = isUsdc ? 'USD' : ccy;
  const fmt = (v, dp = 4) => isUsdc ? `$${v.toFixed(dp)}` : `${v.toFixed(6)} ${fmtUnit}`;
  const fmtBal = (v) => v != null ? fmt(v, isUsdc ? 2 : 6) : 'n/a';

  const uptimeMs = botStartedAt ? Date.now() - botStartedAt.getTime() : 0;
  const uptimeH = Math.floor(uptimeMs / 3600_000);
  const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
  const uptimeStr = botStartedAt ? `${uptimeH}h ${uptimeM}m` : 'n/a';
  const startStr = botStartedAt ? botStartedAt.toUTCString() : 'n/a';

  const balanceChange = (balance != null && botStartBalance != null)
    ? balance - botStartBalance
    : null;

  const tradingStatus = pair.tradingEnabled ? '🟢 TRADING' : '🔴 STOPPED';

  lines.push(
    `\n━━━ <b>${pairLabel}</b>  ${tradingStatus} ━━━`,
    `  ${tradedSymbol}  |  Started: ${startStr}  |  Uptime: ${uptimeStr}`,
    ``,
    `<b>💰 Balance</b>`,
    `  Start:     ${fmtBal(botStartBalance)}`,
    `  Current:   ${fmtBal(balance)}`,
    `  Equity:    ${fmtBal(equity)}`,
    `  Available: ${fmtBal(availableFunds)}`,
    `  Change:    ${balanceChange != null ? (balanceChange >= 0 ? '+' : '') + fmt(balanceChange) : 'n/a'}`,
    ``,
    `<b>📊 Session PnL</b>`,
    `  Realised:   ${sessionRpl != null ? fmt(sessionRpl) : 'n/a'}`,
    `  Unrealised: ${fmt(unrealisedPnl)}`,
    ``,
    `<b>📈 Open Positions</b>`,
    positionsText,
  );
  return lines;
}

async function generateReport() {
  try {
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (activePairs.length === 0) {
      await sendTelegram('📊 <b>Unilateral Report</b>\n\nNo active pairs.');
      return;
    }

    const lines = [`📊 <b>Unilateral Report</b>  —  ${new Date().toUTCString()}\n`];
    for (const pair of activePairs) {
      const pairLines = await _buildPairReportLines(pair);
      lines.push(...pairLines);
    }

    const message = lines.join('\n');
    await sendTelegram(message);
    console.log(`[TelegramReport] Alert sent (${message.length} chars)`);
  } catch (e) {
    console.error(`[TelegramReport] generateReport error: ${e.message}`);
    await sendTelegram(`⚠️ <b>Report Error</b>\n${e.message}`).catch(() => {});
  }
}

async function generateReportForPair(pair) {
  try {
    const pairLabel = pair.agentName || `Pair ${pair.id}`;
    const lines = [`📊 <b>Report — ${pairLabel}</b>  —  ${new Date().toUTCString()}\n`];
    const pairLines = await _buildPairReportLines(pair);
    lines.push(...pairLines);
    const message = lines.join('\n');
    await sendTelegram(message);
    console.log(`[TelegramReport] Single-pair alert sent for pair ${pair.id} (${message.length} chars)`);
  } catch (e) {
    console.error(`[TelegramReport] generateReportForPair error: ${e.message}`);
    await sendTelegram(`⚠️ <b>Report Error</b> (${pair.agentName || pair.id})\n${e.message}`).catch(() => {});
  }
}

/* ── /daily — 24h volume, PnL, rebates, US-session timing ──────────── */

// US equity session in UTC: pre-market open (13:30) → regular close (21:00)
const US_SESSION_START_H = 13, US_SESSION_START_M = 30;
const US_SESSION_END_H   = 21, US_SESSION_END_M   = 0;

function isUsSession(ts) {
  const d = new Date(ts);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const minOfDay = h * 60 + m;
  return minOfDay >= US_SESSION_START_H * 60 + US_SESSION_START_M &&
         minOfDay <  US_SESSION_END_H   * 60 + US_SESSION_END_M;
}

async function buildDailyReportLines(pair) {
  const lines = [];
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) {
    lines.push(`\n<b>${pair.agentName || `Pair ${pair.id}`}</b>: account not found`);
    return lines;
  }

  const cred    = getCredentials(acc);
  const sym     = (pair.symbol1 || '').toUpperCase();
  const ccy     = sym.includes('_USDC') ? 'USDC' : (sym.startsWith('ETH') ? 'ETH' : 'BTC');
  const isUsdc  = ccy === 'USDC';
  const tradedSym = (pair.tradeLeg || 'A').toUpperCase() === 'B' ? pair.symbol2 : pair.symbol1;

  const nowMs   = Date.now();
  const since24 = nowMs - 24 * 3600_000;

  // ── Account snapshot ───────────────────────────────────────────────
  let balance = null, equity = null, availFunds = null, indexPrice = 0;
  try {
    const a = (await signedRequest(
      `/api/v2/private/get_account_summary?currency=${ccy}&extended=true`,
      cred.apiKey, cred.secretKey
    ))?.result;
    if (a) { balance = a.balance; equity = a.equity; availFunds = a.available_funds ?? null; }
  } catch (e) { console.warn(`[TelegramReport] daily balance pair ${pair.id}: ${e.message}`); }

  // ── Current unrealised PnL (perps + options) ───────────────────────
  let perpUpl = 0, optUpl = 0;
  try {
    const pos = ((await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
      cred.apiKey, cred.secretKey
    ))?.result || []).filter(p => p.size !== 0);
    for (const p of pos) {
      perpUpl += p.floating_profit_loss || 0;
      if (p.index_price > 0) indexPrice = p.index_price;
    }
  } catch (_) {}
  try {
    const opts = ((await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
      cred.apiKey, cred.secretKey
    ))?.result || []).filter(p => p.size !== 0);
    for (const p of opts) {
      optUpl += p.floating_profit_loss || 0;
      if (p.index_price > 0) indexPrice = p.index_price;
    }
  } catch (_) {}
  if (!isUsdc && indexPrice <= 0) {
    try {
      const r = (await signedRequest(
        `/api/v2/public/get_index_price?index_name=${ccy === 'ETH' ? 'eth_usd' : 'btc_usd'}`,
        cred.apiKey, cred.secretKey
      ))?.result;
      indexPrice = r?.index_price || 0;
    } catch (_) {}
  }

  // ── 24h fills via get_user_trades_by_currency_and_time ────────────
  let fills = [];
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_user_trades_by_currency_and_time` +
      `?currency=${ccy}&start_timestamp=${since24}&end_timestamp=${nowMs}&count=500&sorting=asc`,
      cred.apiKey, cred.secretKey
    );
    fills = (resp?.result?.trades || []).filter(t =>
      !tradedSym || t.instrument_name === tradedSym
    );
  } catch (e) { console.warn(`[TelegramReport] daily fills pair ${pair.id}: ${e.message}`); }

  // ── Aggregate totals + US-session split ──────────────────────────
  const agg = (subset) => {
    let vol = 0, rpl = 0, fees = 0, rebates = 0, buys = 0, sells = 0, wins = 0;
    for (const f of subset) {
      const amt  = Math.abs(parseFloat(f.amount || 0));
      const fee  = parseFloat(f.fee || 0);
      const pnl  = parseFloat(f.profit_loss || 0);
      const px   = parseFloat(f.price || 0);
      // inverse perps: contract value in USD = amount; linear: amount * px
      vol   += isUsdc ? amt * px : amt;
      rpl   += pnl;
      fees  += fee;
      if (fee < 0) rebates += Math.abs(fee);
      if ((f.direction || '').toLowerCase() === 'buy') buys++; else sells++;
      if (pnl > 0) wins++;
    }
    return { vol, rpl, fees, rebates, buys, sells, wins, count: subset.length };
  };

  const usFills  = fills.filter(f => isUsSession(f.timestamp));
  const offFills = fills.filter(f => !isUsSession(f.timestamp));
  const total    = agg(fills);
  const us       = agg(usFills);
  const off      = agg(offFills);

  // ── Format helpers ────────────────────────────────────────────────
  const toUsd   = (v) => isUsdc ? v : v * indexPrice;
  const fmtCcy  = (v) => isUsdc ? `$${v.toFixed(2)}` : `${v.toFixed(6)} ${ccy}`;
  const fmtBoth = (v) => isUsdc
    ? `$${v.toFixed(2)}`
    : `${v.toFixed(6)} ${ccy}  (~$${(v * indexPrice).toFixed(2)})`;
  const fmtBal  = (v) => v != null ? fmtBoth(v) : 'n/a';
  const pct     = (a, b) => b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '0%';
  const sign    = (v) => v >= 0 ? '+' : '';

  const totalUpl   = perpUpl + optUpl;
  const netPnl     = total.rpl + totalUpl;
  const winRate    = total.count > 0 ? `${((total.wins / total.count) * 100).toFixed(1)}%` : 'n/a';

  const label      = pair.agentName || `Pair ${pair.id}`;
  const status     = pair.tradingEnabled ? '🟢 TRADING' : '🔴 STOPPED';
  const fromStr    = new Date(since24).toUTCString().replace(' GMT', ' UTC');
  const toStr      = new Date(nowMs).toUTCString().replace(' GMT', ' UTC');

  lines.push(
    ``,
    `━━━ <b>${label}</b>  ${status} ━━━`,
    `${tradedSym}  |  <b>24h window</b>`,
    `From: ${fromStr}`,
    `To:   ${toStr}`,
    ``,
    `<b>💰 Account Snapshot</b>`,
    `  Balance:    ${fmtBal(balance)}`,
    `  Equity:     ${fmtBal(equity)}`,
    `  Available:  ${fmtBal(availFunds)}`,
    ``,
    `<b>📊 24h PnL  (${total.count} fills)</b>`,
    `  Realized:   ${sign(total.rpl)}${fmtBoth(total.rpl)}`,
    `  Perp uPnL:  ${sign(perpUpl)}${fmtBoth(perpUpl)}`,
    `  Opt  uPnL:  ${sign(optUpl)}${fmtBoth(optUpl)}`,
    `  ─────────────────────────────`,
    `  Net PnL:    <b>${sign(netPnl)}${fmtBoth(netPnl)}</b>`,
    `  Win rate:   ${winRate}  (${total.wins} profit fills)`,
    ``,
    `<b>📦 24h Volume</b>`,
    `  Total:  $${total.vol.toFixed(0)} USD`,
    `  Buys:   $${us.vol > 0 ? '' : ''}${(fills.filter(f => f.direction === 'buy').reduce((s, f) => s + Math.abs(parseFloat(f.amount || 0)), 0)).toFixed(0)} USD  (${total.buys} fills)`,
    `  Sells:  ${(fills.filter(f => f.direction !== 'buy').reduce((s, f) => s + Math.abs(parseFloat(f.amount || 0)), 0)).toFixed(0)} USD  (${total.sells} fills)`,
    ``,
    `<b>💸 24h Fees & Rebates</b>`,
    `  Fees paid:     ${fmtCcy(Math.max(0, total.fees))}`,
    `  Maker rebates: ${fmtCcy(total.rebates)}`,
    `  Net cost:      ${fmtCcy(total.fees - (-total.rebates))}`,
    ``,
    `<b>⏰ US Session  (13:30–21:00 UTC)  —  ${us.count} fills</b>`,
    `  Volume:    $${us.vol.toFixed(0)}  (${pct(us.vol, total.vol)} of total)`,
    `  Realized:  ${sign(us.rpl)}${fmtCcy(us.rpl)}`,
    `  Fees:      ${fmtCcy(Math.max(0, us.fees))}  |  Rebates: ${fmtCcy(us.rebates)}`,
    `  Win rate:  ${us.count > 0 ? `${((us.wins / us.count) * 100).toFixed(1)}%` : 'n/a'}`,
    ``,
    `<b>🌙 Off-Hours  —  ${off.count} fills</b>`,
    `  Volume:    $${off.vol.toFixed(0)}  (${pct(off.vol, total.vol)} of total)`,
    `  Realized:  ${sign(off.rpl)}${fmtCcy(off.rpl)}`,
    `  Fees:      ${fmtCcy(Math.max(0, off.fees))}  |  Rebates: ${fmtCcy(off.rebates)}`,
    `  Win rate:  ${off.count > 0 ? `${((off.wins / off.count) * 100).toFixed(1)}%` : 'n/a'}`,
  );
  return lines;
}

async function generateDailyReport() {
  try {
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (activePairs.length === 0) {
      await sendTelegram('📅 <b>24h Report</b>\n\nNo active pairs.');
      return;
    }
    const header = [`📅 <b>24h Report</b>  —  ${new Date().toUTCString()}\n`];
    const sections = [];
    for (const pair of activePairs) sections.push(...(await buildDailyReportLines(pair)));
    const message = [...header, ...sections].join('\n');
    // Telegram 4096-char limit: split if needed
    if (message.length <= 4096) {
      await sendTelegram(message);
    } else {
      await sendTelegram(header[0]);
      for (const pair of activePairs) {
        const sec = await buildDailyReportLines(pair);
        await sendTelegram(sec.join('\n').slice(0, 4096));
      }
    }
    console.log(`[TelegramReport] 24h report sent`);
  } catch (e) {
    console.error(`[TelegramReport] generateDailyReport error: ${e.message}`);
    await sendTelegram(`⚠️ <b>24h Report Error</b>\n${e.message}`).catch(() => {});
  }
}

async function generateDailyReportForPair(pair) {
  try {
    const label = pair.agentName || `Pair ${pair.id}`;
    const header = `📅 <b>24h Report — ${label}</b>  —  ${new Date().toUTCString()}\n`;
    const lines  = await buildDailyReportLines(pair);
    const message = header + lines.join('\n');
    await sendTelegram(message.slice(0, 4096));
    console.log(`[TelegramReport] 24h report sent for pair ${pair.id}`);
  } catch (e) {
    console.error(`[TelegramReport] generateDailyReportForPair error: ${e.message}`);
    await sendTelegram(`⚠️ <b>24h Report Error</b> (${pair.agentName || pair.id})\n${e.message}`).catch(() => {});
  }
}

/* ── Noon-to-noon window helper (12:00 IST = 06:30 UTC) ─────────────── */
// IST = UTC+5:30. 12:00 IST = 06:30 UTC.
// Returns the most recently completed 06:30 UTC → 06:30 UTC window.
// If now >= today 06:30 UTC  → windowStart = yesterday 06:30, windowEnd = today 06:30
// If now <  today 06:30 UTC  → windowStart = day-before 06:30, windowEnd = yesterday 06:30
const IST_NOON_UTC_HOURS   = 6;   // 12:00 IST = 06:30 UTC
const IST_NOON_UTC_MINUTES = 30;

function noonWindow() {
  const now = Date.now();
  const d = new Date(now);
  const todayNoon = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    IST_NOON_UTC_HOURS, IST_NOON_UTC_MINUTES, 0, 0
  );
  if (now >= todayNoon) {
    return { start: todayNoon - 86_400_000, end: todayNoon };
  } else {
    return { start: todayNoon - 172_800_000, end: todayNoon - 86_400_000 };
  }
}

/* ── /trades — CSV of exchange fills (noon-to-noon) ─────────────────── */

async function buildTradesCsvForPair(pair) {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) throw new Error(`account not found: ${pair.tradeAccountA}`);

  const cred = getCredentials(acc);
  const sym  = (pair.symbol1 || '').toUpperCase();
  const ccy  = sym.includes('_USDC') ? 'USDC' : (sym.startsWith('ETH') ? 'ETH' : 'BTC');
  const { start, end } = noonWindow();

  const resp = await signedRequest(
    `/api/v2/private/get_user_trades_by_currency_and_time` +
    `?currency=${ccy}&start_timestamp=${start}&end_timestamp=${end}&count=1000&sorting=asc`,
    cred.apiKey, cred.secretKey
  );
  const trades = resp?.result?.trades || [];

  const header = 'timestamp_utc,instrument,direction,price,amount,fee,profit_loss,order_type,trade_id\n';
  const rows = trades.map(t => {
    const ts = new Date(t.timestamp).toISOString();
    const fee = parseFloat(t.fee || 0).toFixed(8);
    const pnl = parseFloat(t.profit_loss || 0).toFixed(8);
    return `${ts},${t.instrument_name},${t.direction},${t.price},${t.amount},${fee},${pnl},${t.order_type || ''},${t.trade_id || ''}`;
  }).join('\n');

  return { csv: header + rows, count: trades.length, ccy, start, end };
}

async function generateTradesCsvForPair(pair) {
  const label = pair.agentName || `Pair ${pair.id}`;
  const { csv, count, ccy, start, end } = await buildTradesCsvForPair(pair);
  const fromStr = new Date(start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const toStr   = new Date(end).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return { csv, label, count, ccy, fromStr, toStr };
}

/* ── /rtps — PnL, SL-loss, volume, rebates (noon-to-noon) ──────────── */

async function buildRtpsReportLines(pair) {
  const lines = [];
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) {
    lines.push(`<b>${pair.agentName || `Pair ${pair.id}`}</b>: account not found`);
    return lines;
  }

  const cred = getCredentials(acc);
  const sym  = (pair.symbol1 || '').toUpperCase();
  const ccy  = sym.includes('_USDC') ? 'USDC' : (sym.startsWith('ETH') ? 'ETH' : 'BTC');
  const isUsdc = ccy === 'USDC';
  const { start, end } = noonWindow();

  // ── Fills in the noon-to-noon window ────────────────────────────────
  let fills = [];
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_user_trades_by_currency_and_time` +
      `?currency=${ccy}&start_timestamp=${start}&end_timestamp=${end}&count=1000&sorting=asc`,
      cred.apiKey, cred.secretKey
    );
    fills = resp?.result?.trades || [];
  } catch (e) {
    console.warn(`[TelegramReport] rtps fills pair ${pair.id}: ${e.message}`);
  }

  // ── Account snapshot for index price ────────────────────────────────
  let indexPrice = 0;
  try {
    const posRes = await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
      cred.apiKey, cred.secretKey
    );
    for (const p of (posRes?.result || [])) {
      if (p.index_price > 0) { indexPrice = p.index_price; break; }
    }
  } catch (_) {}
  if (!indexPrice) {
    try {
      const r = (await signedRequest(
        `/api/v2/public/get_index_price?index_name=${ccy === 'ETH' ? 'eth_usd' : 'btc_usd'}`,
        cred.apiKey, cred.secretKey
      ))?.result;
      indexPrice = r?.index_price || 0;
    } catch (_) {}
  }

  // ── Dollar aggregates from exchange fills (authoritative for $) ─────
  let totalVol = 0, totalRpl = 0, totalFees = 0, totalRebates = 0;
  for (const t of fills) {
    const amt  = Math.abs(parseFloat(t.amount || 0));
    const px   = parseFloat(t.price || 0);
    const fee  = parseFloat(t.fee || 0);
    const pnl  = parseFloat(t.profit_loss || 0);
    totalVol  += isUsdc ? amt * px : amt;
    totalRpl  += pnl;
    totalFees += fee;
    if (fee < 0) totalRebates += Math.abs(fee);
  }

  // ── Round-trip classification from basis_positions (authoritative) ──
  // RTP = profit-order exit (profit | profit_fill_gross_nonpos).
  // SL exits (stop | stop_loss | hold_cap) are deliberately excluded
  // from the RTP count — they are tracked separately.
  let rtpCount = 0, rtpWinCount = 0, slCount = 0, otherCount = 0;
  const worstSlLosses = [];
  try {
    const closedPositions = await BasisPosition.findAll({
      where: {
        pairId: pair.id,
        state: 'closed',
        exitTime: { [Op.gte]: new Date(start), [Op.lt]: new Date(end) },
      },
      attributes: ['exitReason', 'grossPnl', 'netPnl'],
      raw: true,
    });
    for (const p of closedPositions) {
      const reason = p.exitReason || '';
      if (RTP_EXIT_REASONS.has(reason)) {
        rtpCount++;
        const gp = parseFloat(p.grossPnl || 0);
        if (gp > 0) rtpWinCount++;
      } else if (SL_EXIT_REASONS.has(reason)) {
        slCount++;
        const np = parseFloat(p.netPnl || 0);
        if (np < 0) worstSlLosses.push({ pnlUsd: np, reason });
      } else {
        otherCount++;
      }
    }
  } catch (e) {
    console.warn(`[TelegramReport] rtps basis_positions pair ${pair.id}: ${e.message}`);
  }

  worstSlLosses.sort((a, b) => a.pnlUsd - b.pnlUsd);
  const top3SlLosses = worstSlLosses.slice(0, 3);

  const fmtBoth = (v) => isUsdc
    ? `$${v.toFixed(2)}`
    : `${v.toFixed(6)} ${ccy}  (~$${(v * indexPrice).toFixed(2)})`;
  const sign = (v) => v >= 0 ? '+' : '';
  const label  = pair.agentName || `Pair ${pair.id}`;
  const status = pair.tradingEnabled ? '🟢 TRADING' : '🔴 STOPPED';
  const fromStr = new Date(start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const toStr   = new Date(end).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const winRate = rtpCount > 0 ? `${((rtpWinCount / rtpCount) * 100).toFixed(1)}%` : 'n/a';

  lines.push(
    ``,
    `━━━ <b>${label}</b>  ${status} ━━━`,
    `<b>📅 Noon-to-Noon RTPS</b>`,
    `From: ${fromStr}`,
    `To:   ${toStr}`,
    `RTPs (profit exits): ${rtpCount}  |  Win rate: ${winRate}`,
    `SL exits (excluded from RTPs): ${slCount}${otherCount ? `  |  Other exits: ${otherCount}` : ''}`,
    ``,
    `<b>💵 PnL</b>`,
    `  Realized:  ${sign(totalRpl)}${fmtBoth(totalRpl)}`,
    `  RTP wins: ${rtpWinCount}  |  RTP non-wins: ${rtpCount - rtpWinCount}`,
    ``,
    `<b>🛑 SL Losses  (${slCount} round-trips)</b>`,
    ...top3SlLosses.map((l, i) => `  ${i + 1}. ${l.reason}  <b>${l.pnlUsd.toFixed(2)} USD</b>`),
    ...(top3SlLosses.length === 0 ? [`  none`] : []),
    ``,
    `<b>📦 Volume</b>`,
    `  Total: $${totalVol.toFixed(0)} USD  (${fills.length} fills)`,
    ``,
    `<b>💸 Fees & Rebates</b>`,
    `  Fees paid:     ${fmtBoth(Math.max(0, totalFees))}`,
    `  Maker rebates: ${fmtBoth(totalRebates)}`,
    `  Net:           ${sign(totalRebates - Math.max(0, totalFees))}${fmtBoth(totalRebates - Math.max(0, totalFees))}`,
  );
  return lines;
}

async function generateRtpsReport() {
  try {
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (activePairs.length === 0) {
      await sendTelegram('📅 <b>RTPS Report</b>\n\nNo active pairs.');
      return;
    }
    const { start, end } = noonWindow();
    const fromStr = new Date(start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const toStr   = new Date(end).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const header = [`📊 <b>RTPS Report</b>  ${fromStr} → ${toStr}\n`];
    const sections = [];
    for (const pair of activePairs) sections.push(...(await buildRtpsReportLines(pair)));
    const message = [...header, ...sections].join('\n');
    if (message.length <= 4096) {
      await sendTelegram(message);
    } else {
      await sendTelegram(header[0]);
      for (const pair of activePairs) {
        const sec = await buildRtpsReportLines(pair);
        await sendTelegram(sec.join('\n').slice(0, 4096));
      }
    }
  } catch (e) {
    console.error(`[TelegramReport] generateRtpsReport error: ${e.message}`);
    await sendTelegram(`⚠️ <b>RTPS Report Error</b>\n${e.message}`).catch(() => {});
  }
}

async function generateRtpsReportForPair(pair) {
  try {
    const label = pair.agentName || `Pair ${pair.id}`;
    const { start, end } = noonWindow();
    const fromStr = new Date(start).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const toStr   = new Date(end).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const header = `📊 <b>RTPS — ${label}</b>  ${fromStr} → ${toStr}\n`;
    const lines  = await buildRtpsReportLines(pair);
    await sendTelegram((header + lines.join('\n')).slice(0, 4096));
  } catch (e) {
    console.error(`[TelegramReport] generateRtpsReportForPair error: ${e.message}`);
    await sendTelegram(`⚠️ <b>RTPS Error</b> (${pair.agentName || pair.id})\n${e.message}`).catch(() => {});
  }
}

let _timer = null;
let _bootTimer = null;

function startScheduler(intervalMs = 60 * 60_000) {
  _bootTimer = setTimeout(() => {
    generateReport().catch(e => console.error('[TelegramReport] error:', e.message));
  }, 60_000);
  _timer = setInterval(() => {
    generateReport().catch(e => console.error('[TelegramReport] error:', e.message));
  }, intervalMs);
  console.log(`[TelegramReport] Scheduler started — every ${intervalMs / 60_000} min (first run in 1 min)`);
}

function stopScheduler() {
  if (_bootTimer) { clearTimeout(_bootTimer); _bootTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  generateReport, generateReportForPair,
  generateDailyReport, generateDailyReportForPair,
  generateRtpsReport, generateRtpsReportForPair,
  generateTradesCsvForPair,
  sendTelegram, startScheduler, stopScheduler,
};
