/**
 * Z-score stats from spread JSONL since Friday 7:45 PM IST (2026-04-04T14:15:00Z).
 *
 *   node analyze_zscore_since_friday.js
 *   node analyze_zscore_since_friday.js --pairId=6
 *
 * Writes: Backend/reports/zscore_analysis_<ts>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ANCHOR_MS = Date.parse('2026-04-04T14:15:00.000Z');

function parsePairId() {
  const a = process.argv.find((x) => x.startsWith('--pairId='));
  if (!a) return 6;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) ? n : 6;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stdDev(arr, mean) {
  if (arr.length < 2) return 0;
  let s = 0;
  for (const x of arr) s += (x - mean) * (x - mean);
  return Math.sqrt(s / arr.length);
}

function modeRounded(arr, decimals) {
  const mult = 10 ** decimals;
  const counts = new Map();
  for (const x of arr) {
    const k = Math.round(x * mult) / mult;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestK = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      bestN = n;
      bestK = k;
    }
  }
  return { value: bestK, count: bestN };
}

/** Non-overlapping episodes: after z<=pLow, ms until first z>=pHigh */
function reversionTimesMs(times, z, pLow, pHigh, lowFirst) {
  const episodes = [];
  let i = 0;
  const n = z.length;
  while (i < n) {
    if (lowFirst) {
      while (i < n && z[i] > pLow) i++;
      if (i >= n) break;
      const t0 = times[i];
      let j = i;
      while (j < n && z[j] < pHigh) j++;
      if (j >= n) break;
      episodes.push(times[j] - t0);
      i = j + 1;
    } else {
      while (i < n && z[i] < pHigh) i++;
      if (i >= n) break;
      const t0 = times[i];
      let j = i;
      while (j < n && z[j] > pLow) j++;
      if (j >= n) break;
      episodes.push(times[j] - t0);
      i = j + 1;
    }
  }
  return episodes;
}

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'n/a';
  const sec = ms / 1000;
  if (sec < 120) return `${sec.toFixed(1)} s`;
  if (sec < 7200) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(2)} h`;
}

async function main() {
  const pairId = parsePairId();
  const filePath = path.join(__dirname, 'logs', 'spread', `pair_${pairId}_mid.jsonl`);
  if (!fs.existsSync(filePath)) {
    console.error('Missing log file:', filePath);
    process.exit(1);
  }

  const zArr = [];
  const tArr = [];

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(e.createdAt);
    if (Number.isNaN(ts) || ts < ANCHOR_MS) continue;
    const z = Number(e.zScore);
    if (!Number.isFinite(z)) continue;
    zArr.push(z);
    tArr.push(ts);
  }

  const n = zArr.length;
  const sorted = [...zArr].sort((a, b) => a - b);
  const mean = n ? zArr.reduce((s, x) => s + x, 0) / n : 0;
  const sd = stdDev(zArr, mean);
  let mad = 0;
  for (const z of zArr) mad += Math.abs(z - mean);
  mad = n ? mad / n : 0;
  const p10 = percentile(sorted, 0.1);
  const p50 = percentile(sorted, 0.5);
  const p90 = percentile(sorted, 0.9);
  const mn = sorted[0];
  const mx = sorted[n - 1];
  const mode = modeRounded(zArr, 2);

  let maxAbs = 0;
  for (const z of zArr) {
    const a = Math.abs(z);
    if (a > maxAbs) maxAbs = a;
  }
  const gt2 = zArr.filter((z) => Math.abs(z) > 2).length;
  const gt3 = zArr.filter((z) => Math.abs(z) > 3).length;

  const epUp = reversionTimesMs(tArr, zArr, p10, p90, true);
  const epDown = reversionTimesMs(tArr, zArr, p10, p90, false);

  const avgEp = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  const medEp = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const lines = [];
  const L = (s) => lines.push(s);

  L('================================================================================');
  L(`Z-SCORE ANALYSIS — pair ${pairId} (spread log side: mid)`);
  L(`Window: ${new Date(ANCHOR_MS).toISOString()} → end of log (Friday 7:45 PM IST anchor)`);
  L(`Generated: ${new Date().toISOString()}`);
  L(`Sample size (ticks): ${n.toLocaleString()}`);
  L('================================================================================');
  L('');
  L('--- DISTRIBUTION ---');
  L(`  Min (max downside z):     ${mn?.toFixed(6) ?? 'n/a'}`);
  L(`  Max (max upside z):       ${mx?.toFixed(6) ?? 'n/a'}`);
  L(`  Mean:                     ${mean.toFixed(6)}`);
  L(`  Std dev (of z):           ${sd.toFixed(6)}`);
  L(`  Mean abs deviation:       ${mad.toFixed(6)}  (mean |z − mean|)`);
  L(`  10th percentile:          ${p10?.toFixed(6) ?? 'n/a'}`);
  L(`  50th percentile (median): ${p50?.toFixed(6) ?? 'n/a'}`);
  L(`  90th percentile:          ${p90?.toFixed(6) ?? 'n/a'}`);
  L('');
  L('--- MODE (z rounded to 2 decimals) ---');
  L(`  Mode z:                   ${mode.value}`);
  L(`  Occurrences:              ${mode.count.toLocaleString()}  (${((mode.count / n) * 100).toFixed(2)}%)`);
  L('');
  L('--- EXTREME DEVIATIONS ---');
  L(`  Max |z|:                  ${maxAbs.toFixed(6)}`);
  L(`  Count |z| > 2:            ${gt2.toLocaleString()}  (${n ? ((gt2 / n) * 100).toFixed(2) : 0}%)`);
  L(`  Count |z| > 3:            ${gt3.toLocaleString()}  (${n ? ((gt3 / n) * 100).toFixed(2) : 0}%)`);
  L('');
  L('--- MEAN REVERSION TIME (empirical p10 → p90) ---');
  L(`  p10 value = ${p10?.toFixed(6)}, p90 value = ${p90?.toFixed(6)}`);
  L('  Upward path: z goes from ≤ p10 to ≥ p90 (first hit after low)');
  L(`    Episodes completed:     ${epUp.length}`);
  L(`    Mean time:              ${fmtMs(avgEp(epUp))}`);
  L(`    Median time:            ${fmtMs(medEp(epUp))}`);
  L('  Downward path: z goes from ≥ p90 to ≤ p10');
  L(`    Episodes completed:     ${epDown.length}`);
  L(`    Mean time:              ${fmtMs(avgEp(epDown))}`);
  L(`    Median time:            ${fmtMs(medEp(epDown))}`);
  L('');
  L('NOTES');
  L('  • z comes from rolling mean/std in orderbookStreams (same series used for entries).');
  L('  • Log batches ~5s; timestamps are log write time, not tick time.');
  L('  • Reversion episodes are non-overlapping sequential traversals; not independent trials.');
  L('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `zscore_analysis_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
