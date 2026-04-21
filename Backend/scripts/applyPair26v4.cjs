/**
 * Apply Pair 26 v4 profitability config
 * - Backs up current config to JSON
 * - Applies all recommended changes from eth_pair26_profitability_recommendations_2026-04-19.txt
 * - Updates priceUpperLimit / priceLowerLimit around current ETH price
 */

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Sequelize } = require('sequelize');

const PAIR_ID   = 26;
const ETH_PRICE = 2326.11;      // ETH mark price at time of update

// Price band: ±$275 around current price (rounded to nearest 50)
const PRICE_LOWER = 2050;       // 2326 - 276  → 2050
const PRICE_UPPER = 2600;       // 2326 + 274  → 2600

const OVERRIDES = {
  // --- TP / SL ---
  tpSpreadDelta:         0.50,   // was 0.9449  → restore win rate
  slSpreadDelta:         0.25,   // was 0.378   → tighter R:R
  fixedTpUsd:            null,   // was 20      → let TP run to spread target
  maxSingleTradeLossUsd: 8,      // was 10      → tighter at half size
  maxHoldMs:             90000,  // was 300000  → scratch slow movers at 1.5 min

  // --- Adaptive grid ---
  adaptSigmaMin:         2.2,    // was 1.6     → only enter on high-spread signals
  adaptTpSigma:          2.0,    // was 3.0     → match tighter TP
  adaptSlSigma:          1.0,    // was 1.2     → SL tighter than TP

  // --- Position sizing ---
  maxPositions:          1,      // was 2       → grid 4 only; grids 1-3 lose capital
  qty1:                  47000,  // was 94000   → half size until PF > 1.0
  maxQty1:               47000,
  maxLegAQty:            47000,

  // --- Risk limits ---
  dailyLossLimitUsd:     300,    // was 500
  maxDrawdownUsd:        300,    // was 500

  // --- Price band (current ETH level) ---
  priceUpperLimit:       PRICE_UPPER,
  priceLowerLimit:       PRICE_LOWER,

  // --- Re-enable after drawdown kill ---
  tradingEnabled:        1,
  lastStopReason:        null,
  lastDisabledAt:        null,
  peakEquity:            null,   // will be reset by bot on start

  // --- New session markers ---
  agentName:             `ETH_Options_Hedge_V4-${new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14)}`,
  sessionStartedAt:      null,
  sessionStoppedAt:      null,
  sessionPnl:            null,
  sessionStartBalance:   null,
  sessionEndBalance:     null,

  updatedAt:             new Date(),
};

// ─── DB connection ────────────────────────────────────────────────────────────
const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host:    process.env.DB_HOST,
  port:    parseInt(process.env.DB_PORT) || 3306,
  dialect: 'mysql',
  logging: false,
});

async function main() {
  // 1. Fetch current config
  const [[current]] = await s.query('SELECT * FROM statarb_inputs WHERE id = ?', {
    replacements: [PAIR_ID],
  });

  if (!current) throw new Error(`Pair ${PAIR_ID} not found`);

  // 2. Backup current config
  const ts      = new Date().toISOString().replace(/[:.]/g, '-');
  const bkpPath = path.join(__dirname, `../reports/eth_pair26_config_backup_before_v4_${ts}.json`);
  fs.writeFileSync(bkpPath, JSON.stringify(current, null, 2));
  console.log(`✓ Backup written → ${bkpPath}`);

  // 3. Build SET clause
  const setClauses = [];
  const values     = [];

  for (const [col, val] of Object.entries(OVERRIDES)) {
    if (col === 'updatedAt') continue;           // handled at end
    setClauses.push(`\`${col}\` = ?`);
    values.push(val);
  }
  setClauses.push('`updatedAt` = NOW()');
  values.push(PAIR_ID);

  const sql = `UPDATE statarb_inputs SET ${setClauses.join(', ')} WHERE id = ?`;
  await s.query(sql, { replacements: values });

  // 4. Verify
  const [[updated]] = await s.query('SELECT * FROM statarb_inputs WHERE id = ?', {
    replacements: [PAIR_ID],
  });

  console.log('\n✓ Config updated — diff:');
  for (const [col, newVal] of Object.entries(OVERRIDES)) {
    const oldVal = current[col];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      console.log(`  ${col.padEnd(26)} ${String(oldVal ?? 'null').padStart(12)}  →  ${String(newVal ?? 'null')}`);
    }
  }

  console.log('\n✓ New config (key fields):');
  const KEY_FIELDS = ['id','agentName','tradingEnabled','tpSpreadDelta','slSpreadDelta',
    'adaptSigmaMin','adaptTpSigma','adaptSlSigma','fixedTpUsd','maxSingleTradeLossUsd',
    'maxHoldMs','maxPositions','qty1','dailyLossLimitUsd','maxDrawdownUsd',
    'priceUpperLimit','priceLowerLimit','zEntryThreshold','lastStopReason'];
  for (const f of KEY_FIELDS) {
    console.log(`  ${f.padEnd(28)} ${updated[f] ?? 'null'}`);
  }
}

main()
  .then(() => { console.log('\n✓ Done'); s.close(); })
  .catch(e => { console.error('ERROR:', e.message); s.close(); process.exit(1); });
