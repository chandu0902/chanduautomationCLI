'use strict';
/**
 * Fire-and-forget hook that runs the full BTC inception analysis whenever a
 * BTC pair is enabled or disabled. The goal is to always have a fresh
 * `reports/btc_full_inception_analysis_<ts>.txt` committed to disk right
 * BEFORE a session restart (so we can eyeball config before the new bot
 * starts placing orders) and right AFTER a manual/stop event (so we capture
 * the closing state of the session).
 *
 * This module is safe to import from anywhere — it never throws; failures
 * only get printed to stderr. It spawns the analysis script as a child
 * process so the caller (enableTrading / disableTrading) never blocks.
 */

const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'btcFullInceptionAnalysis.js');

// Simple throttle so we don't fork 3 analyses when 3 BTC pairs toggle
// at the same instant (e.g. during process shutdown).
let _lastRunAt = 0;
const THROTTLE_MS = 15_000;

// In-flight tracker — we only keep one live analysis at a time.
let _inFlight = false;

function isBtcPair(pair) {
  if (!pair) return false;
  const s1 = (pair.symbol1 || '').toUpperCase();
  const s2 = (pair.symbol2 || '').toUpperCase();
  return s1.startsWith('BTC') || s2.startsWith('BTC');
}

function run(reason, pairId) {
  const now = Date.now();
  if (_inFlight) {
    console.log(`[btcAnalysisHook] skipped (${reason} pair=${pairId}) — analysis already running`);
    return;
  }
  if (now - _lastRunAt < THROTTLE_MS) {
    console.log(`[btcAnalysisHook] throttled (${reason} pair=${pairId}) — last run ${Math.round((now - _lastRunAt) / 1000)}s ago`);
    return;
  }
  _lastRunAt = now;
  _inFlight = true;
  console.log(`[btcAnalysisHook] launching inception analysis (${reason}, pair=${pairId})`);

  const child = spawn(process.execPath, [SCRIPT_PATH], {
    cwd: path.join(__dirname, '..', '..'),
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tail = '';
  child.stdout.on('data', (buf) => {
    const s = buf.toString();
    tail += s;
    if (tail.length > 4096) tail = tail.slice(-4096);
  });
  child.stderr.on('data', (buf) => {
    process.stderr.write(`[btcAnalysisHook] stderr: ${buf.toString()}`);
  });
  child.on('exit', (code) => {
    _inFlight = false;
    const writeMatch = tail.match(/Wrote\s+([^\s]+\.txt)/);
    if (code === 0 && writeMatch) {
      console.log(`[btcAnalysisHook] done (${reason}) → ${writeMatch[1]}`);
    } else if (code === 0) {
      console.log(`[btcAnalysisHook] done (${reason}) — exit 0 but report path not captured`);
    } else {
      console.error(`[btcAnalysisHook] FAILED (${reason}) — exit ${code}`);
    }
  });

  // Fully detach so it survives if the parent PM2 worker is restarted mid-run.
  child.unref();
}

function onEnable(pair) {
  try {
    if (!isBtcPair(pair)) return;
    run('onEnable', pair.id);
  } catch (e) {
    console.error('[btcAnalysisHook] onEnable threw:', e.message);
  }
}

function onDisable(pair) {
  try {
    if (!isBtcPair(pair)) return;
    run('onDisable', pair.id);
  } catch (e) {
    console.error('[btcAnalysisHook] onDisable threw:', e.message);
  }
}

module.exports = { onEnable, onDisable };
