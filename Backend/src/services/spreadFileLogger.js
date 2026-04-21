const fs = require('fs');
const path = require('path');
const readline = require('readline');

const LOGS_DIR = path.join(__dirname, '..', '..', 'logs', 'spread');

// Ensure logs directory exists
fs.mkdirSync(LOGS_DIR, { recursive: true });

function getLogPath(pairId, side) {
  return path.join(LOGS_DIR, `pair_${pairId}_${side}.jsonl`);
}

/**
 * Append spread log entries to JSONL files (grouped by pairId + side).
 */
function writeBatch(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.pairId}_${entry.side}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }

  for (const [key, batch] of byKey) {
    const [pairId, side] = key.split('_');
    const lines = batch.map((e) => JSON.stringify({ ...e, createdAt: new Date().toISOString() })).join('\n') + '\n';
    fs.appendFile(getLogPath(pairId, side), lines, (err) => {
      if (err) console.error(`[LOG] Spread log write error for pair ${pairId} ${side}:`, err.message);
    });
  }
}

/**
 * Read spread logs for a pair + side from JSONL file.
 */
async function readLogs(pairId, side, { limit = 500, since } = {}) {
  const filePath = getLogPath(pairId, side);
  if (!fs.existsSync(filePath)) return [];

  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (since && new Date(entry.createdAt) < new Date(since)) continue;
      lines.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  return lines.slice(-limit);
}

/**
 * Compute extreme values for a pair + side from JSONL file.
 */
async function readExtremes(pairId, side) {
  const filePath = getLogPath(pairId, side);
  const empty = { highSpread: null, lowSpread: null, highMean: null, lowMean: null, highStd: null, lowStd: null, highZScore: null, lowZScore: null, totalTicks: 0 };
  if (!fs.existsSync(filePath)) return empty;

  let highSpread = -Infinity, lowSpread = Infinity;
  let highMean = -Infinity, lowMean = Infinity;
  let highStd = -Infinity, lowStd = Infinity;
  let highZScore = -Infinity, lowZScore = Infinity;
  let totalTicks = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      totalTicks++;
      if (e.spread > highSpread) highSpread = e.spread;
      if (e.spread < lowSpread) lowSpread = e.spread;
      if (e.mean > highMean) highMean = e.mean;
      if (e.mean < lowMean) lowMean = e.mean;
      if (e.std > highStd) highStd = e.std;
      if (e.std < lowStd) lowStd = e.std;
      if (e.zScore > highZScore) highZScore = e.zScore;
      if (e.zScore < lowZScore) lowZScore = e.zScore;
    } catch {
      // skip malformed lines
    }
  }

  if (totalTicks === 0) return empty;
  return { highSpread, lowSpread, highMean, lowMean, highStd, lowStd, highZScore, lowZScore, totalTicks };
}

/**
 * Delete log files for a pair (both sell and buy).
 */
function clearLogs(pairId) {
  for (const side of ['sell', 'buy', 'mid']) {
    const filePath = getLogPath(pairId, side);
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') console.error(`[LOG] Failed to clear ${side} logs for pair ${pairId}:`, err.message);
    });
  }
}

module.exports = { writeBatch, readLogs, readExtremes, clearLogs };
