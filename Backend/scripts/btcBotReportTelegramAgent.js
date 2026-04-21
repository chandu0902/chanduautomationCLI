#!/usr/bin/env node
'use strict';

/**
 * Scheduler (like solBotReportTelegramAgent): runs `report_btc_master_complete.js` per tick,
 * sends each `btc_master_pair_<id>_*.txt` to TELEGRAM_CHAT_ID as a document.
 *
 * Env (Backend/.env):
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID     — optional leading "=" stripped if copy-pasted wrong
 *   BTC_REPORT_INTERVAL_MS — default 7200000 (2 hours)
 *   BTC_REPORT_PAIR_IDS    — optional "19,15" — explicit pair ids
 *   BTC_REPORT_PAIR_ID     — optional single id
 *   If neither pair env is set: uses StatArbInput rows with status=active, tradingEnabled=true,
 *   and symbol1 or symbol2 containing "BTC"; if none, falls back to pair id 19.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sequelize, StatArbInput } = require('../src/models');

const REPORT_SCRIPT = path.join(__dirname, 'report_btc_master_complete.js');
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

async function resolveBtcPairTargets() {
  const multi = parseIdList(process.env.BTC_REPORT_PAIR_IDS);
  const single = process.env.BTC_REPORT_PAIR_ID?.trim();
  if (multi) {
    return [...multi].sort((a, b) => a - b).map((id) => ({ id, name: '' }));
  }
  if (single) {
    const n = parseInt(single, 10);
    if (Number.isFinite(n) && n > 0) return [{ id: n, name: '' }];
  }

  const rows = await StatArbInput.findAll({
    where: { status: 'active', tradingEnabled: true },
    attributes: ['id', 'agentName', 'symbol1', 'symbol2'],
    order: [['id', 'ASC']],
    raw: true,
  });
  const btc = rows.filter((r) => {
    const a = String(r.symbol1 || '').toUpperCase();
    const b = String(r.symbol2 || '').toUpperCase();
    return a.includes('BTC') || b.includes('BTC');
  });
  if (btc.length) {
    return btc.map((r) => ({ id: r.id, name: r.agentName || '' }));
  }
  return [{ id: 19, name: '(default)' }];
}

function findLatestBtcMasterReport(pairId) {
  const prefix = `btc_master_pair_${pairId}_`;
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

function runMasterReport(pairIds) {
  return new Promise((resolve, reject) => {
    const ids = pairIds.join(',');
    const child = spawn(process.execPath, [REPORT_SCRIPT, `--pairIds=${ids}`], {
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
      else reject(new Error(`report_btc_master_complete exited ${code}\n${err}\n${out}`));
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

async function scheduledTick(token, chatId) {
  const targets = await resolveBtcPairTargets();
  if (targets.length === 0) {
    console.warn(`[${new Date().toISOString()}] No BTC pair targets — nothing sent.`);
    return;
  }

  const ids = targets.map((t) => t.id);
  console.log(
    `[${new Date().toISOString()}] Scheduled run: ${targets.length} pair(s): ${ids.join(', ')}`,
  );

  /** One subprocess with all ids avoids N× DB reconnects; then send one file per pair. */
  const tBatch = Date.now();
  await runMasterReport(ids);
  console.log(`[${new Date().toISOString()}] Report batch done (${Date.now() - tBatch}ms)`);

  const errors = [];
  for (const t of targets) {
    try {
      const reportPath = findLatestBtcMasterReport(t.id);
      if (!reportPath) throw new Error(`No btc_master report for pair ${t.id}`);
      const label = t.name ? `${t.name} (pair ${t.id})` : `pair ${t.id}`;
      const caption = `BTC master (DB+reconcile+exchange+balances+adaptive) · ${label} · ${new Date().toISOString()}`;
      await sendTelegramDocument(token, chatId, reportPath, caption);
      console.log(`[${new Date().toISOString()}] Sent ${path.basename(reportPath)} ${label}`);
    } catch (e) {
      const m = `Pair ${t.id}: ${e.message || e}`;
      console.error(`[${new Date().toISOString()}] ${m}`);
      errors.push(m);
    }
  }

  if (errors.length) {
    await sendTelegramMessage(
      token,
      chatId,
      `BTC report scheduler partial failure:\n${errors.join('\n')}`.slice(0, 4000),
    );
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = normalizeChatId(process.env.TELEGRAM_CHAT_ID || '');
  const intervalMs = envInt('BTC_REPORT_INTERVAL_MS', DEFAULT_INTERVAL_MS);

  if (!token) {
    console.error('Missing TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  if (!chatId) {
    console.error('Missing TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  await sequelize.authenticate();

  console.log(
    `btcBotReportTelegramAgent: scheduler only, intervalMs=${intervalMs} chat=${chatId} reports=${REPORT_DIR}`,
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
          `BTC report scheduler error: ${String(e.message || e).slice(0, 3500)}`,
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
    console.log('btcBotReportTelegramAgent: shutting down');
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
