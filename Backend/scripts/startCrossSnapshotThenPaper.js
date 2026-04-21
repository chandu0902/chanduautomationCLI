#!/usr/bin/env node
'use strict';

/**
 * Start cross-paper spread snapshots on the running API server, wait until they finish,
 * then start multi-pair paper trading (same Node process as PM2 — state persists).
 *
 *   API_URL=http://127.0.0.1:3001 SNAPSHOT_MS=3600000 node scripts/startCrossSnapshotThenPaper.js
 *
 * Optional: PAPER_BODY='{"bootstrapPath":"/path/to/crossPaperBootstrap.generated.json"}'
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.env.API_URL || 'http://127.0.0.1:3001';

function httpRequest(opts, jsonBody) {
  const lib = opts.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (jsonBody) req.write(jsonBody);
    req.end();
  });
}
const SNAPSHOT_MS = parseInt(process.env.SNAPSHOT_MS || String(60 * 60 * 1000), 10);
const POLL_MS = parseInt(process.env.POLL_MS || '3000', 10);
const EXTRA_WAIT_MS = parseInt(process.env.EXTRA_WAIT_MS || '5000', 10);

function request(method, pathname, jsonBody) {
  const u = new URL(pathname, BASE);
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + u.search,
    method,
    headers: jsonBody
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(jsonBody) }
      : {},
  };
  return httpRequest(opts, jsonBody);
}

async function main() {
  console.log(`[startCrossSnapshotThenPaper] API ${BASE} snapshot ${(SNAPSHOT_MS / 60000).toFixed(1)} min`);
  const startBody = JSON.stringify({
    durationMs: SNAPSHOT_MS,
    throttleMs: parseInt(process.env.THROTTLE_MS || '500', 10),
  });
  const snap = await request('POST', '/api/cross-paper/snapshots/start', startBody);
  console.log('snapshots/start', snap.status, snap.body);
  if (!snap.body?.ok) process.exit(1);

  const deadline = Date.now() + SNAPSHOT_MS + EXTRA_WAIT_MS + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const st = await request('GET', '/api/cross-paper/status');
    const running = st.body?.snapshotRunning;
    if (!running) {
      console.log('[startCrossSnapshotThenPaper] snapshots finished');
      break;
    }
  }

  let paperPayload = {};
  if (process.env.PAPER_BODY) {
    try {
      paperPayload = JSON.parse(process.env.PAPER_BODY);
    } catch (e) {
      console.error('PAPER_BODY must be valid JSON');
      process.exit(1);
    }
  }
  const paper = await request('POST', '/api/cross-paper/paper/start', JSON.stringify(paperPayload));
  console.log('paper/start', paper.status, paper.body);
  if (!paper.body?.ok) process.exit(2);
  console.log('[startCrossSnapshotThenPaper] done');
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
