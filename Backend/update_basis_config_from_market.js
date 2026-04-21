/**
 * Sample Deribit BTC future vs perp: live ask–bid spread + 24h mid–mid distribution.
 * Updates statarb_inputs pairs 1 & 2 (if present) and prints suggested create_bot_agents values.
 *
 *   node update_basis_config_from_market.js
 *   FUTURE=BTC-29MAY26 node update_basis_config_from_market.js --apply
 */
require('dotenv').config();
const axios = require('axios');
const { StatArbInput, sequelize } = require('./src/models');

const PERP = 'BTC-PERPETUAL';
const FUTURE = process.env.FUTURE || 'BTC-29MAY26';
const RESOLUTION_MIN = 1;
const LOOKBACK_H = 48;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function roundNice(x) {
  if (x < 15) return Math.round(x);
  if (x < 50) return Math.round(x / 2) * 2;
  return Math.round(x / 5) * 5;
}

async function getBook(inst) {
  const t0 = Date.now();
  const r = await axios.get(
    `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encodeURIComponent(inst)}&depth=1`,
    { timeout: 15000 }
  );
  const lat = Date.now() - t0;
  const res = r.data.result;
  const bid = res.bids?.[0]?.[0];
  const ask = res.asks?.[0]?.[0];
  return { bid, ask, lat };
}

async function getCandles(inst, startMs, endMs) {
  const url =
    'https://www.deribit.com/api/v2/public/get_tradingview_chart_data' +
    `?instrument_name=${encodeURIComponent(inst)}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=${RESOLUTION_MIN}`;
  const r = await axios.get(url, { timeout: 30000 });
  return r.data.result;
}

function buildSpreadSeries(fut, perp) {
  const map = new Map();
  perp.ticks.forEach((t, i) => map.set(t, perp.close[i]));
  const out = [];
  fut.ticks.forEach((t, i) => {
    if (!map.has(t)) return;
    const a = fut.close[i];
    const b = map.get(t);
    out.push(a - b);
  });
  return out.sort((x, y) => x - y);
}

function levelsFromDistribution(sortedAsc, liveAskBid) {
  const n = sortedAsc.length;
  if (n < 30) return null;
  const p50 = percentile(sortedAsc, 50);
  const p65 = percentile(sortedAsc, 65);
  const p75 = percentile(sortedAsc, 75);
  const p85 = percentile(sortedAsc, 85);
  const p92 = percentile(sortedAsc, 92);
  const p96 = percentile(sortedAsc, 96);
  const hi = sortedAsc[n - 1];

  // Entry ladder: between ~p65 and ~p92 so crosses happen in elevated-but-not-extreme basis
  const raw = [p65, p75, p85, p92].map(roundNice).filter((v, i, a) => i === 0 || v > a[i - 1]);
  // Ensure at least one rung below live if market moved up
  const floor = Math.max(5, roundNice(Math.min(p50, liveAskBid * 0.85)));
  if (raw[0] > liveAskBid + 20) {
    raw.unshift(roundNice(Math.min(liveAskBid - 2, p75)));
  }
  const uniq = [...new Set([floor, ...raw].filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
  const levelsA = uniq.slice(0, 6).join(',');

  // Tighter ladder for “B” variant (perp leg): slightly lower rungs
  const rawB = [60, 70, 80, 88].map((p) => roundNice(percentile(sortedAsc, p)));
  const uniqB = [...new Set(rawB.filter((x) => Number.isFinite(x) && x > 0))].sort((a, b) => a - b);
  const levelsB = uniqB.slice(0, 6).join(',');

  const cap = roundNice(Math.min(hi + 15, percentile(sortedAsc, 98) + 25));
  const capB = roundNice(Math.min(cap, percentile(sortedAsc, 94) + 20));

  return { levelsA, levelsB, cap, capB, p50, hi, stats: { p50, p75, p92, hi } };
}

(async () => {
  const apply = process.argv.includes('--apply');

  const lats = [];
  for (let i = 0; i < 5; i++) {
    const b = await getBook(FUTURE);
    lats.push(b.lat);
    await new Promise((r) => setTimeout(r, 80));
  }
  const latSorted = [...lats].sort((a, b) => a - b);
  const latP95 = percentile(latSorted, 95);
  const entryPollTimeoutMs = Math.min(300000, Math.max(90000, Math.round(latP95 * 40 + 60000)));

  const [futB, perpB] = await Promise.all([getBook(FUTURE), getBook(PERP)]);
  const futAsk = futB.ask;
  const perpBid = perpB.bid;
  const liveSpread = parseFloat((futAsk - perpBid).toFixed(2));

  const endMs = Date.now();
  const startMs = endMs - LOOKBACK_H * 3600 * 1000;
  const [futC, perpC] = await Promise.all([
    getCandles(FUTURE, startMs, endMs),
    getCandles(PERP, startMs, endMs),
  ]);
  const series = buildSpreadSeries(futC, perpC);
  const dist = levelsFromDistribution(series, liveSpread);
  if (!dist) {
    console.error('Not enough overlapping candles');
    process.exit(1);
  }

  // z on % p.a. in production is ~N(0,1) after warm-up; 1.0–1.5 catches moderate widening
  const zEntryThreshold = 1.25;
  const zEntryMax = 4;

  console.log('\n── Market snapshot ──');
  console.log(`  ${FUTURE} ask  : ${futAsk}`);
  console.log(`  ${PERP} bid : ${perpBid}`);
  console.log(`  Live futAsk−perpBid (signalSpread): $${liveSpread}`);
  console.log(`  REST latency p95 (5 samples): ${latP95} ms → entryPollTimeoutMs=${entryPollTimeoutMs}`);

  console.log('\n── ~48h mid−mid distribution (closes) ──');
  console.log(`  n=${series.length}  min=${series[0].toFixed(2)}  max=${series[series.length - 1].toFixed(2)}`);
  console.log(`  p50=$${dist.p50.toFixed(2)}  p75=$${percentile(series, 75).toFixed(2)}  p92=$${percentile(series, 92).toFixed(2)}`);

  console.log('\n── Proposed config ──');
  console.log(`  Pair A: spreadEntryLevels=${dist.levelsA}  maxSpreadCap=${dist.cap}`);
  console.log(`  Pair B: spreadEntryLevels=${dist.levelsB}  maxSpreadCap=${dist.capB}`);
  console.log(`  Both:   zEntryThreshold=${zEntryThreshold}  zEntryMax=${zEntryMax}  entryPollTimeoutMs=${entryPollTimeoutMs}`);

  if (!apply) {
    console.log('\n  (Dry-run. Pass --apply to write DB ids 1 & 2.)\n');
    process.exit(0);
  }

  await sequelize.authenticate();
  const [n] = await StatArbInput.update(
    {
      spreadEntryLevels: dist.levelsA,
      maxSpreadCap: dist.cap,
      zEntryThreshold,
      zEntryMax,
      entryPollTimeoutMs,
    },
    { where: { id: 1 } }
  );
  const [n2] = await StatArbInput.update(
    {
      spreadEntryLevels: dist.levelsB,
      maxSpreadCap: dist.capB,
      zEntryThreshold,
      zEntryMax,
      entryPollTimeoutMs,
    },
    { where: { id: 2 } }
  );
  console.log(`\n  DB updated: pair1 rows=${n} pair2 rows=${n2}\n`);
  process.exit(0);
})().catch((e) => {
  console.error(e.response?.data || e.message);
  process.exit(1);
});
