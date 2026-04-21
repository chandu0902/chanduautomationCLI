'use strict';

/**
 * Append throttled JSONL rows under reports/paper_snapshots_<PAIR>.jsonl
 * (PAIR = SOL | ETH | BTC | …) while paper engines run. Used by export scripts
 * to attach recent market + equity state to individual paper reports.
 *
 * Interval: PAPER_SNAPSHOT_INTERVAL_MS (default 15000).
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(__dirname, '../../reports');
/** Upper bound when reading entire JSONL into appendix (avoid multi‑GB loads). */
const SNAPSHOT_TAIL_HARD_CAP = Math.max(
  1000,
  parseInt(process.env.PAPER_SNAPSHOT_TAIL_HARD_CAP || '100000', 10) || 100000,
);
const INTERVAL_MS = Math.max(
  2000,
  parseInt(process.env.PAPER_SNAPSHOT_INTERVAL_MS || '15000', 10) || 15000,
);

const _lastWrite = new Map();

function _safeKey(pairKey) {
  return String(pairKey || 'SOL').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'SOL';
}

function snapshotFilePath(pairKey) {
  return path.join(LOG_DIR, `paper_snapshots_${_safeKey(pairKey)}.jsonl`);
}

/**
 * @param {string} pairKey  SOL | ETH | BTC | …
 * @param {Record<string, unknown>} row  merged into the JSON line (ts added)
 */
function appendSnapshot(pairKey, row) {
  const k = _safeKey(pairKey);
  const now = Date.now();
  const prev = _lastWrite.get(k) || 0;
  if (now - prev < INTERVAL_MS) return;
  _lastWrite.set(k, now);

  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {
    return;
  }

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pairKey: k,
    ...row,
  });
  try {
    fs.appendFileSync(snapshotFilePath(k), `${line}\n`);
  } catch (_) {
    /* disk full / perms */
  }
}

/**
 * @param {string} pairKey
 * @param {number} maxLines  tail lines to return (default 400). Use `0` for “all lines” up to SNAPSHOT_TAIL_HARD_CAP.
 * @returns {{ path: string, lines: string[], summary: string }}
 */
function readSnapshotTail(pairKey, maxLines = 400) {
  const p = snapshotFilePath(pairKey);
  if (!fs.existsSync(p)) {
    return { path: p, lines: [], summary: '(no snapshot file yet)\n' };
  }
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return { path: p, lines: [], summary: `(read error: ${e.message})\n` };
  }
  const all = raw.split('\n').filter((ln) => ln.trim());
  const wantAll = maxLines === 0 || maxLines == null || !Number.isFinite(maxLines);
  let tail;
  let truncated = false;
  if (wantAll) {
    truncated = all.length > SNAPSHOT_TAIL_HARD_CAP;
    tail = truncated ? all.slice(-SNAPSHOT_TAIL_HARD_CAP) : all;
  } else {
    const n = Math.min(Math.max(1, maxLines), SNAPSHOT_TAIL_HARD_CAP);
    tail = all.slice(-n);
  }
  const modeLabel = wantAll ? `all (cap ${SNAPSHOT_TAIL_HARD_CAP})` : String(maxLines);
  const summary =
    `Snapshot file: ${p}\n` +
    `Lines (${wantAll ? 'tail=all' : `tail=${maxLines}`}, mode max=${modeLabel}): ${tail.length}` +
    (truncated ? `  (file had ${all.length} lines; truncated to cap)\n` : '\n') +
    `  throttle interval: ${INTERVAL_MS}ms\n`;
  return { path: p, lines: tail, summary };
}

function formatSnapshotAppendix(pairKey, maxLines = 400) {
  const { path: snapPath, lines, summary } = readSnapshotTail(pairKey, maxLines);
  const hdr =
    '\n' +
    '────────────────────────────────────────────────────────────────────────\n' +
    ` Continuous paper snapshots (JSONL tail) — ${pairKey}\n` +
    '────────────────────────────────────────────────────────────────────────\n';
  if (!lines.length) {
    return `${hdr}${summary}\n`;
  }
  const body = lines.map((ln) => `  ${ln}`).join('\n');
  return `${hdr}${summary}Source: ${snapPath}\n\n${body}\n`;
}

module.exports = {
  appendSnapshot,
  readSnapshotTail,
  snapshotFilePath,
  formatSnapshotAppendix,
  INTERVAL_MS,
  SNAPSHOT_TAIL_HARD_CAP,
};
