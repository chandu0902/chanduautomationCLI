'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const { signedRequest } = require('../controllers/apicontroller');
const { StatArbInput, AccountDetails } = require('../models');
const {
  generateReport, generateReportForPair,
  generateDailyReport, generateDailyReportForPair,
  generateRtpsReport, generateRtpsReportForPair,
  generateTradesCsvForPair,
} = require('./telegramReport');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REPORTS_DIR = path.resolve(__dirname, '../../reports');
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

let _offset = 0;
let _polling = false;
let _stopping = false;

/* ── crypto helpers ──────────────────────────────────────────────────── */

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

function detectCurrency(pair) {
  const s1 = (pair.symbol1 || '').toUpperCase();
  const s2 = (pair.symbol2 || '').toUpperCase();
  if (s1.includes('_USDC') || s2.includes('_USDC')) return 'USDC';
  if (s1.startsWith('ETH') || s2.startsWith('ETH')) return 'ETH';
  return 'BTC';
}

/* ── Telegram API helpers ────────────────────────────────────────────── */

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/${method}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 40_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ ok: false }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function sendMessage(chatId, text, opts = {}) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  });
}

function answerCallback(callbackQueryId) {
  return telegramRequest('answerCallbackQuery', { callback_query_id: callbackQueryId }).catch(() => {});
}

async function sendDocument(chatId, filePath, caption) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const body = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const fd = new FormData();
  fd.append('chat_id', chatId);
  if (caption) fd.append('caption', caption.slice(0, 1024));
  fd.append('document', new Blob([body], { type: 'text/plain' }), filename);
  const resp = await fetch(url, { method: 'POST', body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    throw new Error(`sendDocument failed: ${data.description || resp.status}`);
  }
  return data;
}

/* ── Polling loop (messages + callback queries) ──────────────────────── */

async function getUpdates() {
  try {
    const result = await telegramRequest('getUpdates', {
      offset: _offset,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
    });
    return result.ok ? result.result : [];
  } catch {
    return [];
  }
}

async function pollLoop() {
  while (_polling && !_stopping) {
    try {
      const updates = await getUpdates();
      for (const update of updates) {
        _offset = update.update_id + 1;

        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = String(cb.message?.chat?.id || '');
          if (CHAT_ID && chatId !== String(CHAT_ID).replace(/^=/, '').trim()) continue;
          handleCallback(cb.id, cb.data || '', chatId).catch((e) =>
            console.error(`[TelegramBot] callback error:`, e.message)
          );
          continue;
        }

        const msg = update.message;
        if (!msg || !msg.text) continue;
        const chatId = String(msg.chat.id);
        if (CHAT_ID && chatId !== String(CHAT_ID).replace(/^=/, '').trim()) continue;
        const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
        handleCommand(cmd, chatId).catch((e) =>
          console.error(`[TelegramBot] command ${cmd} error:`, e.message)
        );
      }
    } catch (e) {
      console.warn(`[TelegramBot] poll error: ${e.message}`);
      if (_polling && !_stopping) await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── Bot picker (inline keyboard) ────────────────────────────────────── */

async function sendBotPicker(chatId, action) {
  const activePairs = await StatArbInput.findAll({
    where: { status: 'active' },
    attributes: ['id', 'agentName', 'symbol1', 'tradingEnabled'],
    order: [['id', 'ASC']],
    raw: true,
  });
  if (activePairs.length === 0) {
    return sendMessage(chatId, '🤖 No active bots.');
  }

  const buttons = activePairs.map(p => {
    const label = p.agentName || `Pair ${p.id}`;
    const statusIcon = p.tradingEnabled ? '🟢' : '🔴';
    return [{ text: `${statusIcon} ${label}`, callback_data: `${action}:${p.id}` }];
  });
  buttons.push([{ text: '📋 All Bots', callback_data: `${action}:all` }]);

  const title = action === 'status'  ? '🤖 Select a bot for status:'
    : action === 'report'  ? '📊 Select a bot for report:'
    : action === 'daily'   ? '📅 Select a bot for 24h report:'
    : action === 'trades'  ? '📄 Select a bot for trade CSV (noon-to-noon):'
    : action === 'rtps'    ? '📊 Select a bot for RTPS report (noon-to-noon):'
    : '📁 Select a bot for full reports:';

  return sendMessage(chatId, title, {
    reply_markup: JSON.stringify({ inline_keyboard: buttons }),
  });
}

/* ── Command router ──────────────────────────────────────────────────── */

async function handleCommand(cmd, chatId) {
  switch (cmd) {
    case '/status':
    case '/btc':
    case '/eth':
      return sendBotPicker(chatId, 'status');
    case '/report':
      return sendBotPicker(chatId, 'report');
    case '/reports':
      return sendBotPicker(chatId, 'reports');
    case '/daily':
      return sendBotPicker(chatId, 'daily');
    case '/trades':
      return sendBotPicker(chatId, 'trades');
    case '/rtps':
      return sendBotPicker(chatId, 'rtps');
    case '/start':
    case '/help':
      return sendMessage(chatId, [
        '🤖 <b>Unilateral Bot Commands</b>\n',
        '/status — Balances + PnL (pick a bot)',
        '/report — Status report (pick a bot)',
        '/reports — Full report files (pick a bot)',
        '/daily — Rolling 24h PnL, volume, rebates, US timing',
        '/trades — Trade CSV per coin · noon-to-noon window (pick a bot)',
        '/rtps — RTPS: PnL, SL-loss, volume, rebates · noon-to-noon (pick a bot)',
        '/help — Show this menu',
      ].join('\n'));
    default:
      return;
  }
}

/* ── Callback router ─────────────────────────────────────────────────── */

async function handleCallback(callbackId, data, chatId) {
  answerCallback(callbackId);

  const [action, target] = data.split(':');
  if (!action || !target) return;

  const isAll = target === 'all';
  const pairId = isAll ? null : parseInt(target, 10);

  switch (action) {
    case 'status':
      return isAll ? handleStatusAll(chatId) : handleStatusOne(chatId, pairId);
    case 'report':
      return isAll ? handleReportAll(chatId) : handleReportOne(chatId, pairId);
    case 'reports':
      return isAll ? handleReportsAll(chatId) : handleReportsOne(chatId, pairId);
    case 'daily':
      return isAll ? handleDailyAll(chatId) : handleDailyOne(chatId, pairId);
    case 'trades':
      return isAll ? handleTradesAll(chatId) : handleTradesOne(chatId, pairId);
    case 'rtps':
      return isAll ? handleRtpsAll(chatId) : handleRtpsOne(chatId, pairId);
    default:
      return;
  }
}

/* ── /status — single bot ────────────────────────────────────────────── */

async function buildStatusForPair(pair) {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA } });
  if (!acc) return `\n<b>${pair.agentName || `Pair ${pair.id}`}</b>: account not found`;

  const cred = getCredentials(acc);
  const ccy = detectCurrency(pair);
  const isUsdc = ccy === 'USDC';

  const botStartedAt = pair.botStartedAt ? new Date(pair.botStartedAt) : null;
  const botStartBalance = pair.botStartBalance ?? null;

  let equity = null, balance = null, indexPrice = 0;
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_account_summary?currency=${ccy}&extended=true`,
      cred.apiKey, cred.secretKey
    );
    const a = resp?.result;
    if (a) { equity = a.equity; balance = a.balance; }
  } catch (e) {
    console.warn(`[TelegramBot] balance pair ${pair.id}: ${e.message}`);
  }

  /* ── Perp positions ──────────────────────────────────────────── */
  let perpPnl = 0;
  const perpLines = [];
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=future`,
      cred.apiKey, cred.secretKey
    );
    for (const p of (resp?.result || []).filter(p => p.size !== 0)) {
      const upl = p.floating_profit_loss || 0;
      perpPnl += upl;
      if (p.index_price > 0) indexPrice = p.index_price;
      const dir = p.direction === 'buy' ? '🟢 Long' : '🔴 Short';
      perpLines.push(`    ${p.instrument_name}  ${dir}  ${Math.abs(p.size)}  uPnL: ${upl.toFixed(6)} ${ccy}`);
    }
  } catch (e) {
    perpLines.push(`    error: ${e.message}`);
  }

  /* ── Option positions ────────────────────────────────────────── */
  let optionPnl = 0;
  const optionLines = [];
  try {
    const resp = await signedRequest(
      `/api/v2/private/get_positions?currency=${ccy}&kind=option`,
      cred.apiKey, cred.secretKey
    );
    for (const p of (resp?.result || []).filter(p => p.size !== 0)) {
      const upl = p.floating_profit_loss || 0;
      optionPnl += upl;
      if (p.index_price > 0) indexPrice = p.index_price;
      const dir = p.direction === 'buy' ? '🟢 Long' : '🔴 Short';
      optionLines.push(`    ${p.instrument_name}  ${dir}  ${p.size}  uPnL: ${upl.toFixed(6)} ${ccy}`);
    }
  } catch (e) {
    optionLines.push(`    error: ${e.message}`);
  }

  if (!isUsdc && indexPrice <= 0) {
    try {
      const indexName = ccy === 'ETH' ? 'eth_usd' : 'btc_usd';
      const idxResp = await signedRequest(
        `/api/v2/public/get_index_price?index_name=${indexName}`,
        cred.apiKey, cred.secretKey
      );
      indexPrice = idxResp?.result?.index_price || 0;
    } catch (_) {}
  }

  const overallPnl = perpPnl + optionPnl;
  const perpPnlUsd = perpPnl * indexPrice;
  const optionPnlUsd = optionPnl * indexPrice;
  const overallPnlUsd = overallPnl * indexPrice;

  const fmt = (v, usd) => `${v.toFixed(6)} ${ccy}  (~$${usd.toFixed(2)})`;
  const fmtBal = (v) => v != null
    ? (isUsdc ? `$${v.toFixed(2)}` : `${v.toFixed(8)} ${ccy}  (~$${(v * indexPrice).toFixed(2)})`)
    : 'n/a';

  const uptimeMs = botStartedAt ? Date.now() - botStartedAt.getTime() : 0;
  const uptimeH = Math.floor(uptimeMs / 3600_000);
  const uptimeM = Math.floor((uptimeMs % 3600_000) / 60_000);
  const uptimeStr = botStartedAt ? `${uptimeH}h ${uptimeM}m` : 'n/a';
  const startStr = botStartedAt ? botStartedAt.toUTCString() : 'n/a';

  const balChangeRaw = (balance != null && botStartBalance != null) ? balance - botStartBalance : null;
  const balChangeStr = balChangeRaw != null
    ? `${balChangeRaw >= 0 ? '+' : ''}${balChangeRaw.toFixed(8)} ${ccy}  (~$${(balChangeRaw * indexPrice).toFixed(2)})`
    : 'n/a';

  const optTarget = pair.optionProfitTargetUsd;
  const optTargetStr = optTarget ? `$${optTarget}` : 'not set';
  const tradingStatus = pair.tradingEnabled ? '🟢 TRADING' : '🔴 STOPPED';

  const lines = [
    `━━━ <b>${pair.agentName || `Pair ${pair.id}`}</b>  ${tradingStatus} ━━━`,
    `  Started: ${startStr}  |  Uptime: ${uptimeStr}`,
    ``,
    `<b>💰 Balance</b>`,
    `  Bot Start: ${fmtBal(botStartBalance)}`,
    `  Current:   ${fmtBal(balance)}`,
    `  Equity:    ${fmtBal(equity)}`,
    `  Change:    ${balChangeStr}`,
    ``,
    `<b>📈 Perp Positions</b>` + (perpLines.length ? '' : '  none'),
  ];
  if (perpLines.length) lines.push(...perpLines);
  lines.push(
    `  <b>Perp PnL: ${fmt(perpPnl, perpPnlUsd)}</b>`,
    ``,
    `<b>📊 Option Positions</b>` + (optionLines.length ? '' : '  none'),
  );
  if (optionLines.length) lines.push(...optionLines);
  lines.push(
    `  <b>Option PnL: ${fmt(optionPnl, optionPnlUsd)}</b>`,
    `  Option TP target: ${optTargetStr}`,
    ``,
    `<b>🔢 Overall PnL</b>`,
    `  <b>${fmt(overallPnl, overallPnlUsd)}</b>`,
  );
  return lines.join('\n');
}

async function handleStatusOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const header = `🤖 <b>Bot Status</b>  —  ${new Date().toUTCString()}\n`;
    const body = await buildStatusForPair(pair);
    return sendMessage(chatId, header + '\n' + body);
  } catch (e) {
    console.error(`[TelegramBot] status pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ Status error: ${e.message}`);
  }
}

async function handleStatusAll(chatId) {
  try {
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (activePairs.length === 0) return sendMessage(chatId, '🤖 No active pairs.');
    const header = `🤖 <b>Bot Status (all)</b>  —  ${new Date().toUTCString()}\n`;
    const sections = [];
    for (const pair of activePairs) {
      sections.push(await buildStatusForPair(pair));
    }
    const full = header + '\n' + sections.join('\n\n');
    if (full.length > 4096) {
      for (let i = 0; i < sections.length; i++) {
        const label = activePairs[i].agentName || `Pair ${activePairs[i].id}`;
        await sendMessage(chatId, i === 0
          ? header + '\n' + sections[i]
          : `(continued) <b>${label}</b>\n\n` + sections[i]);
      }
      return;
    }
    return sendMessage(chatId, full);
  } catch (e) {
    console.error(`[TelegramBot] status all error:`, e.message);
    return sendMessage(chatId, `⚠️ Status error: ${e.message}`);
  }
}

/* ── /daily — 24h volume, PnL, rebates, US-session timing ───────────── */

async function handleDailyOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const label = pair.agentName || `Pair ${pair.id}`;
    await sendMessage(chatId, `⏳ Fetching 24h data for <b>${label}</b>...`);
    await generateDailyReportForPair(pair);
  } catch (e) {
    console.error(`[TelegramBot] daily pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ Daily report error: ${e.message}`);
  }
}

async function handleDailyAll(chatId) {
  try {
    await sendMessage(chatId, '⏳ Fetching 24h data for all bots...');
    await generateDailyReport();
  } catch (e) {
    console.error(`[TelegramBot] daily all error:`, e.message);
    return sendMessage(chatId, `⚠️ Daily report error: ${e.message}`);
  }
}

/* ── /report — single bot or all (spawned subprocess, own rate limiter) ── */

const REPORT_SCRIPT = path.join(SCRIPTS_DIR, 'telegramPairReport.js');

function spawnReport(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORT_SCRIPT, ...args], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000, // 10 min max (large fill history + slow Deribit)
    });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; process.stdout.write(c); });
    child.stderr.on('data', c => { err += c; process.stderr.write(c); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve({ out, err });
      const why = code == null
        ? `(no exit code — often killed by timeout/signal ${signal || '?'})`
        : `code ${code}`;
      reject(new Error(`Report script exited ${why}: ${(err || out).slice(0, 400)}`));
    });
  });
}

async function handleReportOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const label = pair.agentName || `Pair ${pair.id}`;
    await sendMessage(chatId, `⏳ Fetching full exchange analysis for <b>${label}</b>... (may take ~30s)`);
    await spawnReport([`--pairId=${pairId}`]);
  } catch (e) {
    console.error(`[TelegramBot] report pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ Report error: ${e.message}`);
  }
}

async function handleReportAll(chatId) {
  try {
    await sendMessage(chatId, '⏳ Fetching full exchange analysis for all bots... (may take ~1 min)');
    await spawnReport(['--all']);
  } catch (e) {
    console.error(`[TelegramBot] report all error:`, e.message);
    return sendMessage(chatId, `⚠️ Report error: ${e.message}`);
  }
}

/* ── /reports — full report files ────────────────────────────────────── */

function runScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`Script exited ${code}: ${err.slice(0, 500)}`));
    });
  });
}

function findLatestReport(prefix) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  let best = null, bestMs = 0;
  for (const name of fs.readdirSync(REPORTS_DIR)) {
    if (!name.startsWith(prefix) || !name.endsWith('.txt')) continue;
    const full = path.join(REPORTS_DIR, name);
    const st = fs.statSync(full);
    if (st.mtimeMs >= bestMs) { bestMs = st.mtimeMs; best = full; }
  }
  return best;
}

async function generateAndSendReportsForPair(chatId, pair) {
  const label = pair.agentName || `Pair ${pair.id}`;
  const errors = [];
  let sent = 0;
  const ccy = detectCurrency(pair).toLowerCase(); // 'btc' | 'eth' | 'usdc'

  try {
    await runScript(path.join(SCRIPTS_DIR, 'report_btc_master_complete.js'), [`--pairIds=${pair.id}`]);
    const masterFile = findLatestReport(`${ccy}_master_pair_${pair.id}_`);
    if (masterFile) {
      await sendDocument(chatId, masterFile, `${label} Master Report · ${new Date().toISOString()}`);
      sent++;
    }
  } catch (e) { errors.push(`Master: ${e.message}`); }

  try {
    await runScript(path.join(SCRIPTS_DIR, 'btcDeepAnalysisPair20.js'), [`--pairId=${pair.id}`]);
    const deepFile = findLatestReport(`${ccy}_deep_analysis_pair${pair.id}_`);
    if (deepFile) {
      await sendDocument(chatId, deepFile, `${label} Deep Analysis · ${new Date().toISOString()}`);
      sent++;
    }
  } catch (e) { errors.push(`Deep analysis: ${e.message}`); }

  try {
    await runScript(path.join(SCRIPTS_DIR, 'btcFullReportPair20.js'), [`--pairId=${pair.id}`, '--sinceBot']);
    const fullFile = findLatestReport(`${ccy}_full_report_pair${pair.id}_`);
    if (fullFile) {
      await sendDocument(chatId, fullFile, `${label} Full Report · ${new Date().toISOString()}`);
      sent++;
    }
  } catch (e) { errors.push(`Full report: ${e.message}`); }

  return { sent, errors };
}

async function handleReportsOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId, { raw: true });
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const label = pair.agentName || `Pair ${pair.id}`;
    await sendMessage(chatId, `⏳ Generating reports for <b>${label}</b>...`);
    const { sent, errors } = await generateAndSendReportsForPair(chatId, pair);
    if (errors.length) {
      await sendMessage(chatId, `⚠️ ${label}: sent ${sent} file(s), issues:\n${errors.join('\n')}`);
    } else {
      await sendMessage(chatId, `✅ ${sent} report file(s) sent for <b>${label}</b>.`);
    }
  } catch (e) {
    console.error(`[TelegramBot] reports pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ Reports error: ${e.message}`);
  }
}

async function handleReportsAll(chatId) {
  try {
    const activePairs = await StatArbInput.findAll({
      where: { status: 'active' },
      order: [['id', 'ASC']],
      raw: true,
    });
    if (activePairs.length === 0) return sendMessage(chatId, '📊 No active bots.');
    await sendMessage(chatId, `⏳ Generating reports for ${activePairs.length} bot(s)...`);
    let totalSent = 0;
    const allErrors = [];
    for (const pair of activePairs) {
      const { sent, errors } = await generateAndSendReportsForPair(chatId, pair);
      totalSent += sent;
      allErrors.push(...errors.map(e => `${pair.agentName || `Pair ${pair.id}`}: ${e}`));
    }
    if (allErrors.length) {
      await sendMessage(chatId, `⚠️ Sent ${totalSent} file(s), issues:\n${allErrors.join('\n')}`);
    } else {
      await sendMessage(chatId, `✅ ${totalSent} report file(s) sent for ${activePairs.length} bot(s).`);
    }
  } catch (e) {
    console.error(`[TelegramBot] reports all error:`, e.message);
    return sendMessage(chatId, `⚠️ Reports error: ${e.message}`);
  }
}

/* ── /trades — CSV of fills, noon-to-noon, per coin ─────────────────── */

async function handleTradesOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId, { raw: true });
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const label = pair.agentName || `Pair ${pair.id}`;
    await sendMessage(chatId, `⏳ Generating trade CSV for <b>${label}</b> (noon-to-noon)...`);
    const { csv, count, ccy, fromStr, toStr } = await generateTradesCsvForPair(pair);
    if (count === 0) {
      return sendMessage(chatId, `📄 <b>${label}</b>: no fills in window\n${fromStr} → ${toStr}`);
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = path.join(REPORTS_DIR, `trades_${ccy.toLowerCase()}_pair${pairId}_${ts}.csv`);
    require('fs').writeFileSync(filename, csv, 'utf8');
    await sendDocument(chatId, filename, `${label} · ${ccy} Trades · ${fromStr} → ${toStr} · ${count} fills`);
  } catch (e) {
    console.error(`[TelegramBot] trades pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ Trades CSV error: ${e.message}`);
  }
}

async function handleTradesAll(chatId) {
  try {
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' }, raw: true });
    if (activePairs.length === 0) return sendMessage(chatId, '📄 No active bots.');
    await sendMessage(chatId, `⏳ Generating trade CSVs for ${activePairs.length} bot(s)...`);
    for (const pair of activePairs) {
      await handleTradesOne(chatId, pair.id);
    }
  } catch (e) {
    console.error(`[TelegramBot] trades all error:`, e.message);
    return sendMessage(chatId, `⚠️ Trades CSV error: ${e.message}`);
  }
}

/* ── /rtps — PnL, SL-loss, volume, rebates (noon-to-noon) ───────────── */

async function handleRtpsOne(chatId, pairId) {
  try {
    const pair = await StatArbInput.findByPk(pairId);
    if (!pair) return sendMessage(chatId, `⚠️ Pair ${pairId} not found.`);
    const label = pair.agentName || `Pair ${pair.id}`;
    await sendMessage(chatId, `⏳ Fetching RTPS data for <b>${label}</b>...`);
    await generateRtpsReportForPair(pair);
  } catch (e) {
    console.error(`[TelegramBot] rtps pair ${pairId} error:`, e.message);
    return sendMessage(chatId, `⚠️ RTPS error: ${e.message}`);
  }
}

async function handleRtpsAll(chatId) {
  try {
    await sendMessage(chatId, '⏳ Fetching RTPS data for all bots...');
    await generateRtpsReport();
  } catch (e) {
    console.error(`[TelegramBot] rtps all error:`, e.message);
    return sendMessage(chatId, `⚠️ RTPS error: ${e.message}`);
  }
}

/* ── Register menu commands with Telegram ─────────────────────────────── */

function registerCommands() {
  telegramRequest('setMyCommands', {
    commands: [
      { command: 'status',  description: 'Balances + PnL (pick a bot)' },
      { command: 'daily',   description: 'Rolling 24h PnL, volume, rebates, US timing' },
      { command: 'trades',  description: 'Trade CSV per coin · noon-to-noon window' },
      { command: 'rtps',    description: 'RTPS: PnL, SL-loss, volume, rebates · noon-to-noon' },
      { command: 'report',  description: 'Full status report (pick a bot)' },
      { command: 'reports', description: 'Full report files (pick a bot)' },
      { command: 'help',    description: 'Show command menu' },
    ],
  }).then((res) => {
    if (res.ok) console.log('[TelegramBot] Menu commands registered with Telegram');
    else console.warn('[TelegramBot] Failed to register commands:', JSON.stringify(res));
  }).catch((e) => {
    console.warn(`[TelegramBot] setMyCommands error: ${e.message}`);
  });
}

/* ── Lifecycle ───────────────────────────────────────────────────────── */

function startPolling() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[TelegramBot] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — polling disabled');
    return;
  }
  if (_polling) return;
  _polling = true;
  _stopping = false;
  registerCommands();
  console.log('[TelegramBot] Command polling started. Commands: /status /daily /report /reports /help');
  pollLoop();
}

function stopPolling() {
  _polling = false;
  _stopping = true;
}

module.exports = { startPolling, stopPolling, sendMessage };
