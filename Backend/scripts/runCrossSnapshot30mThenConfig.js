#!/usr/bin/env node
'use strict';

/**
 * Standalone 30m (default) spread snapshot run, then writes snapshot-tuned bootstrap JSON.
 * Uses the same crossPaperService as the API (run only one instance per machine).
 *
 *   cd Backend && nohup node scripts/runCrossSnapshot30mThenConfig.js >> reports/cross_snapshot_orchestrator.log 2>&1 &
 *
 * Env: DURATION_MS (default 1800000), THROTTLE_MS, CAPITAL, POST_WAIT_MS
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);

const cross = require(path.join(BACKEND, 'src/services/crossPaperService'));

const DURATION_MS = parseInt(process.env.DURATION_MS || String(30 * 60 * 1000), 10);
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || '500', 10);
const CAPITAL = parseFloat(process.env.CAPITAL || '10000');
const POST_WAIT_MS = parseInt(process.env.POST_WAIT_MS || '15000', 10);
const STATUS_FILE = path.join(BACKEND, 'reports/cross_snapshot_run_status.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const r = cross.startSnapshots({ durationMs: DURATION_MS, throttleMs: THROTTLE_MS });
if (!r.ok) {
  log('startSnapshots failed ' + JSON.stringify(r));
  process.exit(1);
}

log(`startSnapshots ok session=${r.session} pairs=${(r.pairKeys || []).join(',')}`);
fs.writeFileSync(
  STATUS_FILE,
  JSON.stringify({
    phase: 'snapshots_running',
    startedAt: new Date().toISOString(),
    durationMs: DURATION_MS,
    session: r.session,
    files: r.files || [],
    pairKeys: r.pairKeys || [],
  }, null, 2),
  'utf8',
);

const waitMs = DURATION_MS + POST_WAIT_MS;
log(`scheduled config generation in ${(waitMs / 60000).toFixed(2)} min`);

setTimeout(() => {
  const files = r.files || [];
  const filesArg = files.length
    ? `--files=${files.map((f) => path.resolve(f)).join(',')}`
    : `--session=${r.session}`;

  log(`running generateCrossPaperConfig.js ${filesArg}`);
  const gen = spawnSync(
    process.execPath,
    [
      path.join(BACKEND, 'scripts/generateCrossPaperConfig.js'),
      filesArg,
      '--out=src/config/crossPaperBootstrap.generated.json',
      `--capital=${CAPITAL}`,
    ],
    { cwd: BACKEND, stdio: 'inherit' },
  );

  const outAbs = path.join(BACKEND, 'src/config/crossPaperBootstrap.generated.json');
  if (gen.status !== 0) {
    log(`generateCrossPaperConfig failed exit=${gen.status}`);
    fs.writeFileSync(
      STATUS_FILE,
      JSON.stringify({
        phase: 'error',
        finishedAt: new Date().toISOString(),
        session: r.session,
        generatorExit: gen.status,
      }, null, 2),
      'utf8',
    );
    process.exit(gen.status || 1);
  }

  const done = {
    phase: 'complete',
    finishedAt: new Date().toISOString(),
    session: r.session,
    generatedConfig: outAbs,
    paperStart: {
      method: 'POST',
      url: '/api/cross-paper/paper/start',
      body: { bootstrapPath: outAbs },
    },
  };
  fs.writeFileSync(STATUS_FILE, JSON.stringify(done, null, 2), 'utf8');
  log(`complete generatedConfig=${outAbs}`);
  process.exit(0);
}, waitMs);
