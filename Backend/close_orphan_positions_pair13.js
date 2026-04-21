/**
 * close_orphan_positions_pair13.js
 *
 * Marks the 3 pair-13 orphan positions as closed in the DB.
 * Exchange filled a manual close-all at $72,752 on 2026-04-11T07:59:35Z
 * (order 150087073969). The bot was stopped before it could write exit records.
 *
 * What this script does:
 *   1. Verifies the 3 positions are still 'open' in DB
 *   2. Calculates BTC PnL per position  (inverse: qty*(1/entry - 1/exit) - fee)
 *   3. Updates basis_positions → state='closed', exitReason, prices, pnl
 *   4. Inserts an 'exit' trade_log row for each position
 *   5. Prints a summary
 *
 * Run: node close_orphan_positions_pair13.js
 * Add --dry-run to preview without writing.
 */
require('dotenv').config();
const { sequelize } = require('./src/models');

const DRY_RUN = process.argv.includes('--dry-run');

// ─── constants from exchange fills ───────────────────────────────────────────
const EXIT_PRICE  = 72752;
const EXIT_TIME   = new Date('2026-04-11T07:59:36.000Z');
const EXIT_ORDER  = '150087073969';
const EXIT_REASON = 'manual';   // closed externally, not by bot TP/SL
const MAKER_REBATE_RATE = 0.0001; // 1 bp maker rebate on BTC-PERPETUAL

// The 3 orphan positions for pair 13
const ORPHAN_IDS = [4839, 4843, 4844];

// ─── helpers ─────────────────────────────────────────────────────────────────
function btcPnl(entryPrice, exitPrice, qtyUsd) {
  // Inverse perpetual: PnL BTC = qty_usd * (1/entry - 1/exit)
  return qtyUsd * (1 / entryPrice - 1 / exitPrice);
}

function makerRebateBtc(qtyUsd, price) {
  return (qtyUsd / price) * MAKER_REBATE_RATE;
}

// ─── main ────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const [rows] = await sequelize.query(
      `SELECT id, state, entryTime, gridLevel, entrySpread,
              legA_entryPrice, legA_entryQty, legA_entryOrderId
       FROM basis_positions
       WHERE id IN (${ORPHAN_IDS.join(',')})
       ORDER BY id`
    );

    if (rows.length === 0) {
      console.log('No matching positions found — already cleaned up?');
      return;
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`  PAIR 13 — ORPHAN POSITION CLOSE${DRY_RUN ? ' [DRY RUN]' : ''}`);
    console.log(`  Exit price : $${EXIT_PRICE}  |  Exit time: ${EXIT_TIME.toISOString()}`);
    console.log(`  Order      : ${EXIT_ORDER}`);
    console.log(`${'='.repeat(72)}\n`);

    for (const row of rows) {
      if (row.state !== 'open') {
        console.log(`  pos #${row.id} state=${row.state} — SKIPPING (not open)`);
        continue;
      }

      const entryPrice = parseFloat(row.legA_entryPrice);
      const qtyUsd     = parseFloat(row.legA_entryQty);
      const entryTime  = new Date(row.entryTime);
      const holdMs     = EXIT_TIME - entryTime;

      const grossPnlBtc = btcPnl(entryPrice, EXIT_PRICE, qtyUsd);
      const rebateBtc   = makerRebateBtc(qtyUsd, EXIT_PRICE);  // exit maker rebate
      const netPnlBtc   = grossPnlBtc + rebateBtc;
      const netPnlUsd   = netPnlBtc * EXIT_PRICE;

      console.log(`  pos #${row.id}  L${row.gridLevel}  entry=$${entryPrice}  qty=$${qtyUsd}`);
      console.log(`    holdMs   : ${holdMs} ms (${(holdMs/3600000).toFixed(2)} h)`);
      console.log(`    grossPnl : ${grossPnlBtc.toFixed(8)} BTC`);
      console.log(`    rebate   : +${rebateBtc.toFixed(8)} BTC`);
      console.log(`    netPnl   : ${netPnlBtc.toFixed(8)} BTC  (~$${netPnlUsd.toFixed(4)})`);
      console.log('');

      if (!DRY_RUN) {
        // 1. Update basis_positions
        await sequelize.query(
          `UPDATE basis_positions SET
             state          = 'closed',
             exitReason     = :exitReason,
             legA_exitPrice = :exitPrice,
             legB_exitPrice = NULL,
             legA_exitOrderId = :exitOrder,
             exitTime       = :exitTime,
             holdMs         = :holdMs,
             spreadChange   = NULL,
             legA_pnl       = :grossPnlBtc,
             legB_pnl       = 0,
             grossPnl       = :grossPnlBtc,
             commission     = :rebateBtc,
             takerFeeUsd    = 0,
             netPnl         = :netPnlBtc,
             updatedAt      = NOW()
           WHERE id = :id AND state = 'open'`,
          {
            replacements: {
              exitReason: EXIT_REASON,
              exitPrice: EXIT_PRICE,
              exitOrder: EXIT_ORDER,
              exitTime: EXIT_TIME,
              holdMs,
              grossPnlBtc,
              rebateBtc,
              netPnlBtc,
              id: row.id,
            },
          }
        );

        // 2. Insert exit trade_log
        await sequelize.query(
          `INSERT INTO trade_logs
             (pairId, side, legA_exchange, legA_symbol, legA_side,
              legA_price, legA_qty, legA_orderId, legA_filledAt,
              spreadAtExit, pnl, legA_pnl, legB_pnl,
              status, legA_fillType, commission, takerFeeUsd,
              cancelReason, createdAt, updatedAt)
           VALUES
             (13, 'exit', 'deribit', 'BTC-PERPETUAL', 'sell',
              :exitPrice, :qtyUsd, :exitOrder, :exitTime,
              NULL, :netPnlBtc, :grossPnlBtc, 0,
              'filled', 'maker', :rebateBtc, 0,
              NULL, NOW(), NOW())`,
          {
            replacements: {
              exitPrice: EXIT_PRICE,
              qtyUsd,
              exitOrder: EXIT_ORDER,
              exitTime: EXIT_TIME,
              netPnlBtc,
              grossPnlBtc,
              rebateBtc,
            },
          }
        );

        console.log(`    ✓ pos #${row.id} closed in DB`);
      }
    }

    if (!DRY_RUN) {
      // Verify final state
      const [check] = await sequelize.query(
        `SELECT id, state, exitReason, exitTime, netPnl FROM basis_positions WHERE id IN (${ORPHAN_IDS.join(',')})`
      );
      console.log('\n━━━ Final DB state ━━━');
      check.forEach(r => console.log(`  #${r.id}  state=${r.state}  reason=${r.exitReason}  exitTime=${r.exitTime}  netPnl=${parseFloat(r.netPnl).toFixed(8)} BTC`));
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(DRY_RUN ? '  DRY RUN complete — no DB changes made.' : '  Done — bot can now accept new entries (openCount = 0/3).');
    console.log(`${'='.repeat(72)}\n`);

  } finally {
    await sequelize.close();
  }
})();
