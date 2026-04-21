#!/usr/bin/env node
'use strict';

/**
 * Tune sol_live_bots.startConfig (anchor + entry ladder) from the current live snapshot spread,
 * without flattening Deribit: stop runner → PATCH mergeStartConfig → POST live/resume.
 *
 * Usage:
 *   node scripts/tuneSolLiveSpreadToBot.js [botId]
 *   API_BASE=http://127.0.0.1:3001 node scripts/tuneSolLiveSpreadToBot.js 5
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const http = require('http');

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '');
const botId = Math.max(1, parseInt(process.argv[2] || '5', 10) || 5);

function reqJson(method, path, bodyObj) {
  const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
  const u = new URL(path, API_BASE);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null, raw: d });
        } catch (e) {
          reject(new Error(`Bad JSON ${path}: ${d.slice(0, 200)}`));
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function ladderFromSpread(signalSpread, deribitMid) {
  const s = Number(signalSpread);
  const mid = Number(deribitMid);
  const sClamped = Number.isFinite(s) ? Math.max(0.055, Math.min(0.28, s)) : 0.1;
  const base = Math.max(0.048, sClamped * 0.52);
  const raw = [base * 1.0, base * 1.32, base * 1.62, base * 1.95];
  const entryLevels = raw.map((x) => Math.min(0.22, Math.round(x * 10000) / 10000));
  const anchorPrice =
    Number.isFinite(mid) && mid > 1 ? Math.round(mid * 1000) / 1000 : null;
  return { entryLevels, anchorPrice, observedSpread: signalSpread, observedMid: deribitMid };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  let st;
  let signalSpread;
  let deribitMid;
  for (let attempt = 0; attempt < 8; attempt++) {
    st = await reqJson('GET', '/api/sol-runner/live/status');
    if (st.status !== 200) throw new Error(`status HTTP ${st.status}`);
    const snap = st.json?.latestSnap || st.json?.startSnap;
    signalSpread = snap?.signalSpread;
    deribitMid = snap?.deribitMid;
    if (Number.isFinite(Number(signalSpread)) && Number.isFinite(Number(deribitMid))) break;
    if (!st.json?.running) {
      throw new Error('Live runner is not running — start it, wait for a periodic snapshot, then re-run.');
    }
    await sleep(400);
  }
  if (!Number.isFinite(Number(signalSpread)) || !Number.isFinite(Number(deribitMid))) {
    throw new Error(
      'Could not read signalSpread + deribitMid from latestSnap after retries. Wait ~30s for periodic snapshot and re-run.',
    );
  }

  const tune = ladderFromSpread(signalSpread, deribitMid);
  console.log('Observed:', { signalSpread, deribitMid });
  console.log('Tune:', tune);

  const bot = await reqJson('GET', `/api/sol-runner/live/bots/${botId}`);
  if (bot.status !== 200 || !bot.json?.ok) throw new Error(`get bot: ${JSON.stringify(bot.json)}`);
  const zg = bot.json.bot?.startConfig?.zoneGrid || {};
  const zoneGrid = {
    anchorPrice: tune.anchorPrice != null ? tune.anchorPrice : zg.anchorPrice,
    range: zg.range ?? 4,
    zoneCount: zg.zoneCount ?? 4,
  };

  const stop = await reqJson('POST', '/api/sol-runner/live/stop');
  console.log('stop:', stop.json);

  const patch = await reqJson('PATCH', `/api/sol-runner/live/bots/${botId}`, {
    mergeStartConfig: true,
    startConfig: {
      zoneGrid,
      entryLevels: tune.entryLevels,
    },
  });
  if (patch.status !== 200 || !patch.json?.ok) {
    throw new Error(`PATCH failed: ${JSON.stringify(patch.json)} — try resume manually if runner was stopped`);
  }
  console.log('patched startConfig (merged)');

  const resume = await reqJson('POST', '/api/sol-runner/live/resume', { botId });
  if (!resume.json?.ok) throw new Error(`resume: ${JSON.stringify(resume.json)}`);
  console.log('resume:', resume.json);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
