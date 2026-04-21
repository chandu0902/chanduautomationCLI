/**
 * Create StatArb bot agents from fixed templates (DB rows 11 / 12 style).
 *
 * Usage:
 *   node create_bot_agents.js --template A --symbol1 BTC-29MAY26 --symbol2 BTC-PERPETUAL --tag "2026-04-02_07-00-24"
 *   node create_bot_agents.js --both --symbol1 BTC-29MAY26 --symbol2 BTC-PERPETUAL --tag "2026-04-02_07-00-24"
 *   node create_bot_agents.js --both --date "2026-04-02" --time "07:00:24"   # builds tag automatically
 *   node create_bot_agents.js --perp-only ...  # template B only (trades BTC-PERPETUAL leg)
 *
 * Optional: --status inactive|active  (default inactive to match your exports)
 *          --enable-trading          set tradingEnabled=true on created rows (live bots)
 *          --perp-only               create only template B (BTC-PERP unilateral)
 *          --dry-run                 (print JSON only, no DB write)
 */
require('dotenv').config();
const path = require('path');
const { StatArbInput, sequelize } = require('./src/models');

const ACCOUNT = 'deribit hiddenroad';

/** Template A — Leg A (sell futures) — entry grid from ~P65 to P95+ of 24h spread distribution */
function templateA(symbol1, symbol2, agentName) {
  return {
    exchange1: 'deribit',
    type1: 'future',
    symbol1,
    exchange2: 'deribit',
    type2: 'perps',
    symbol2,
    agentName,
    tradeAccountA: ACCOUNT,
    tradeAccountB: ACCOUNT,
    qty1: 900,
    qty2: null,
    maxQty1: 13500,
    beta: 1,
    dailyLossLimitPct: null,
    dailyLossLimitUsd: null,
    profitTarget: 2.5,
    stopLoss: 1.2,
    maxHoldMs: 1800000,
    zEntryThreshold: 1.0,
    zEntryMax: 5,
    maxPositions: 3,
    maxLegAQty: 13500,
    maxLegBQty: 0,
    maxNetQtyImbalance: 23,
    spreadEntryLevels: '220,235,250,270,290,320',
    maxSpreadCap: 420,
    entryPollTimeoutMs: 90000,
    profitFeeMultiplier: 50,
    unilateralMode: true,
    tradeLeg: 'A',
    tpSpreadDelta: 1,
    slSpreadDelta: 35,
    tradingEnabled: false,
  };
}

/** Template B — Leg B (buy perps) — wider entry thresholds for perp side */
function templateB(symbol1, symbol2, agentName) {
  return {
    exchange1: 'deribit',
    type1: 'future',
    symbol1,
    exchange2: 'deribit',
    type2: 'perps',
    symbol2,
    agentName,
    tradeAccountA: ACCOUNT,
    tradeAccountB: ACCOUNT,
    qty1: 900,
    qty2: null,
    maxQty1: 13500,
    beta: 1,
    dailyLossLimitPct: null,
    dailyLossLimitUsd: null,
    profitTarget: 2.5,
    stopLoss: 1.2,
    maxHoldMs: 1800000,
    zEntryThreshold: 1.0,
    zEntryMax: 5,
    maxPositions: 5,
    maxLegAQty: 13500,
    maxLegBQty: 0,
    maxNetQtyImbalance: 30,
    spreadEntryLevels: '230,245,260,275,295,320',
    maxSpreadCap: 420,
    entryPollTimeoutMs: 90000,
    profitFeeMultiplier: 50,
    unilateralMode: true,
    tradeLeg: 'B',
    tpSpreadDelta: 1,
    slSpreadDelta: 35,
    tradingEnabled: false,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = {
    template: null,
    both: false,
    symbol1: 'BTC-29MAY26',
    symbol2: 'BTC-PERPETUAL',
    tag: null,
    date: null,
    time: null,
    status: 'inactive',
    enableTrading: false,
    perpOnly: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--both') o.both = true;
    else if (a === '--perp-only') { o.perpOnly = true; o.template = 'B'; }
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--enable-trading') o.enableTrading = true;
    else if (a === '--template' && argv[i + 1]) o.template = argv[++i].toUpperCase();
    else if (a === '--symbol1' && argv[i + 1]) o.symbol1 = argv[++i];
    else if (a === '--symbol2' && argv[i + 1]) o.symbol2 = argv[++i];
    else if (a === '--tag' && argv[i + 1]) o.tag = argv[++i];
    else if (a === '--date' && argv[i + 1]) o.date = argv[++i];
    else if (a === '--time' && argv[i + 1]) o.time = argv[++i];
    else if (a === '--status' && argv[i + 1]) o.status = argv[++i];
  }
  if (!o.tag && o.date && o.time) {
    const d = o.date.replace(/-/g, '');
    const t = o.time.replace(/:/g, '');
    o.tag = `${d}_${t}`;
  }
  if (!o.tag) {
    const now = new Date();
    o.tag = now.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  }
  if (o.perpOnly) {
    o.both = false;
    o.template = 'B';
  }
  return o;
}

(async () => {
  const opts = parseArgs();
  if (!opts.both && !opts.template && !opts.perpOnly) {
    console.error(
      'Specify --template A|B, --both, or --perp-only\n' +
        'Example: node create_bot_agents.js --both --symbol1 BTC-29MAY26 --symbol2 BTC-PERPETUAL --date 2026-04-02 --time 07:00:24'
    );
    process.exit(1);
  }

  const tag = opts.tag;
  const agents = [];
  if (opts.both || opts.template === 'A') {
    agents.push({
      key: 'A',
      row: templateA(
        opts.symbol1,
        opts.symbol2,
        `BTC-BASIS-29MAY26-UNI-ISO-V22-SAFE-${tag}`
      ),
    });
  }
  if (opts.both || opts.template === 'B') {
    agents.push({
      key: 'B',
      row: templateB(
        opts.symbol1,
        opts.symbol2,
        `BTC-PERP-UNI-ISO-V23-${tag}`
      ),
    });
  }

  for (const { key, row } of agents) {
    row.status = opts.status;
    if (opts.enableTrading) row.tradingEnabled = true;
  }

  try {
    await sequelize.authenticate();
    console.log('DB OK. Tag:', tag);
    for (const { key, row } of agents) {
      console.log(`\n── Template ${key} ──\n${JSON.stringify(row, null, 2)}`);
      if (opts.dryRun) continue;
      const created = await StatArbInput.create(row);
      console.log(`Created id=${created.id} agentName=${created.agentName}`);
    }
    if (opts.dryRun) console.log('\n(--dry-run: nothing written)');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
