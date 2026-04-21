#!/usr/bin/env node
'use strict';

/**
 * Every 2h (configurable): loads active rows from `sol_live_bots` (isActive=true),
 * runs `exportPaperAndLiveReports.js <id> --live-only` per bot, sends each
 * `report_bot<N>_live_sol_complete_*.txt` (live DB + zones/TP-SL + reconciliation + exchange) to TELEGRAM_CHAT_ID.
 *
 * Env (Backend/.env):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID     — optional leading "=" stripped if copy-pasted wrong
 *   SOL_REPORT_INTERVAL_MS — default 7200000 (2 hours)
 *   SOL_REPORT_BOT_IDS — optional "4,7" — only these ids among active bots
 *   SOL_REPORT_BOT_ID  — optional single id — only that bot if it is active
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sequelize, SolLiveBot } = require('../src/models');

const EXPORT_SCRIPT = path.join(__dirname, 'exportPaperAndLiveReports.js');
const REPORT_DIR = path.resolve(__dirname, '../reports');
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000;

let exportBusy = false;

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeChatId(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('=')) s = s.slice(1).trim();
  return s;
}

function parseIdList(str) {
  if (str == null || String(str).trim() === '') return null;
  const out = new Set();
  for (const part of String(str).split(/[\s,]+/)) {
    const n = parseInt(part, 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out.size ? out : null;
}

async function resolveActiveBotTargets() {
  const rows = await SolLiveBot.findAll({
    where: { isActive: true },
    attributes: ['id', 'name'],
    order: [['id', 'ASC']],
    raw: true,
  });
  let targets = rows.map((r) => ({ id: r.id, name: r.name || '' }));

  const multi = parseIdList(process.env.SOL_REPORT_BOT_IDS);
  const single = process.env.SOL_REPORT_BOT_ID?.trim();
  if (multi) {
    targets = targets.filter((t) => multi.has(t.id));
  } else if (single) {
    const n = parseInt(single, 10);
    if (Number.isFinite(n) && n > 0) targets = targets.filter((t) => t.id === n);
  }

  return targets;
}

function findLatestLiveSolReport(botId) {
  const prefix = `report_bot${botId}_live_sol_complete_`;
  let best = null;
  let bestM = 0;
  if (!fs.existsSync(REPORT_DIR)) return null;
  for (const name of fs.readdirSync(REPORT_DIR)) {
    if (!name.startsWith(prefix) || !name.endsWith('.txt')) continue;
    const full = path.join(REPORT_DIR, name);
    const st = fs.statSync(full);
    if (st.mtimeMs >= bestM) {
      bestM = st.mtimeMs;
      best = full;
    }
  }
  return best;
}

function runExport(botId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT_SCRIPT, String(botId), '--live-only'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`export bot ${botId} exited ${code}\n${err}\n${out}`));
    });
  });
}

async function sendTelegramDocument(token, chatId, filePath, caption) {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const body = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const fd = new FormData();
  fd.append('chat_id', chatId);
  if (caption && caption.length > 0) fd.append('caption', caption.slice(0, 1024));
  fd.append('document', new Blob([body], { type: 'text/plain' }), filename);

  const resp = await fetch(url, { method: 'POST', body: fd });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    const desc = data.description || JSON.stringify(data);
    throw new Error(`Telegram sendDocument failed: HTTP ${resp.status} ${desc}`);
  }
  return data;
}

async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    const desc = data.description || JSON.stringify(data);
    throw new Error(`Telegram sendMessage failed: HTTP ${resp.status} ${desc}`);
  }
  return data;
}

async function exportAndSendOne(token, chatId, botId, botName) {
  const t0 = Date.now();
  await runExport(botId);
  const reportPath = findLatestLiveSolReport(botId);
  if (!reportPath) throw new Error(`No live SOL complete report under ${REPORT_DIR} for bot ${botId}`);

  const label = botName ? `${botName} (id ${botId})` : `bot ${botId}`;
  const caption = `SOL live complete (DB+zones+recon+exchange) · ${label} · ${new Date().toISOString()}`;
  await sendTelegramDocument(token, chatId, reportPath, caption);
  const ms = Date.now() - t0;
  console.log(`[${new Date().toISOString()}] Sent ${path.basename(reportPath)} ${label} (${ms}ms)`);
}

async function scheduledTick(token, chatId) {
  const targets = await resolveActiveBotTargets();
  if (targets.length === 0) {
    const msg =
      'No matching active SOL bots (sol_live_bots.isActive=true' +
      (process.env.SOL_REPORT_BOT_IDS || process.env.SOL_REPORT_BOT_ID
        ? '; check SOL_REPORT_BOT_IDS / SOL_REPORT_BOT_ID'
        : '') +
      ') — nothing sent.';
    console.warn(`[${new Date().toISOString()}] ${msg}`);
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Scheduled run: ${targets.length} bot(s): ${targets.map((t) => t.id).join(', ')}`,
  );

  const errors = [];
  for (const t of targets) {
    try {
      await exportAndSendOne(token, chatId, t.id, t.name);
    } catch (e) {
      const m = `Bot ${t.id}: ${e.message || e}`;
      console.error(`[${new Date().toISOString()}] ${m}`);
      errors.push(m);
    }
  }

  if (errors.length) {
    await sendTelegramMessage(
      token,
      chatId,
      `SOL report scheduler partial failure:\n${errors.join('\n')}`.slice(0, 4000),
    );
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = normalizeChatId(process.env.TELEGRAM_CHAT_ID || '');
  const intervalMs = envInt('SOL_REPORT_INTERVAL_MS', DEFAULT_INTERVAL_MS);

  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  if (!chatId) {
    console.error('Missing TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  console.log(
    `solBotReportTelegramAgent: scheduler only, intervalMs=${intervalMs} chat=${chatId} reports=${REPORT_DIR}`,
  );

  const safeTick = async () => {
    if (exportBusy) {
      console.warn(`[${new Date().toISOString()}] Skip tick: previous run still in progress`);
      return;
    }
    exportBusy = true;
    try {
      await scheduledTick(token, chatId);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Tick failed:`, e.message || e);
      try {
        await sendTelegramMessage(
          token,
          chatId,
          `SOL report scheduler error: ${String(e.message || e).slice(0, 3500)}`,
        );
      } catch (e2) {
        console.error('Could not send error to Telegram:', e2.message || e2);
      }
    } finally {
      exportBusy = false;
    }
  };

  await safeTick();
  const intervalId = setInterval(safeTick, intervalMs);

  const shutdown = async () => {
    clearInterval(intervalId);
    console.log('solBotReportTelegramAgent: shutting down');
    try {
      await sequelize.close();
    } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
