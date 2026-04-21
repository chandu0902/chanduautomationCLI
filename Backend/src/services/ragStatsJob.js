const { Op } = require('sequelize');
const { sequelize, StatArbInput, HourlyRagStat } = require('../models');

function classifyRag(exits, wins, losses, pnl) {
  if (exits === 0) return 'AMBER';
  if (pnl < 0) return 'RED';
  if (losses > 0 && pnl < 0.2) return 'AMBER';
  if (pnl >= 0.5) return 'GREEN';
  if (pnl > 0 && losses === 0) return 'GREEN';
  return 'AMBER';
}

async function computeRagForPair(pairId) {
  const [rows] = await sequelize.query(`
    SELECT
      DATE_FORMAT(CONVERT_TZ(createdAt, @@session.time_zone, '+00:00'), '%Y-%m-%d %H:00:00') AS hourUtc,
      -- totalTrades = number of completed round-trips (count filled entries only)
      SUM(CASE WHEN side='entry' AND status='filled' THEN 1 ELSE 0 END) AS totalTrades,
      SUM(CASE WHEN side='entry' AND status='filled' THEN 1 ELSE 0 END) AS entries,
      SUM(CASE WHEN side='exit'  AND status='filled' THEN 1 ELSE 0 END) AS exits,
      SUM(CASE WHEN side='exit'  AND status='filled' AND pnl > 0  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN side='exit'  AND status='filled' AND pnl <= 0 THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN side='exit'  AND status='filled' THEN IFNULL(pnl,0)        ELSE 0 END) AS pnl,
      SUM(CASE WHEN side='exit'  AND status='filled' THEN IFNULL(commission,0) ELSE 0 END) AS commission,
      -- volumeSol: native qty, entry fills only (no double-count)
      SUM(CASE WHEN side='entry' AND status='filled' THEN IFNULL(legA_qty,0) ELSE 0 END) AS volumeSol,
      -- volumeUsd: notional, entry fills only (no double-count, no cancelled orders)
      SUM(CASE
        WHEN side='entry' AND status='filled'
          AND LOWER(legA_exchange) = 'deribit' AND legA_symbol NOT LIKE '%\_USDC%'
          THEN IFNULL(legA_qty,0)
        WHEN side='entry' AND status='filled'
          THEN IFNULL(legA_qty,0) * IFNULL(legA_price,0)
        ELSE 0
      END) AS volumeUsd
    FROM trade_logs
    WHERE pairId = :pairId
    GROUP BY hourUtc
    ORDER BY hourUtc ASC
  `, { replacements: { pairId } });

  let upserted = 0;
  for (const r of rows) {
    const exits = Number(r.exits) || 0;
    const wins = Number(r.wins) || 0;
    const losses = Number(r.losses) || 0;
    const pnl = Number(r.pnl) || 0;
    const rag = classifyRag(exits, wins, losses, pnl);
    const winRate = exits > 0 ? (wins / exits) * 100 : null;

    await HourlyRagStat.upsert({
      pairId,
      hourUtc: r.hourUtc,
      totalTrades: Number(r.totalTrades) || 0,
      entries: Number(r.entries) || 0,
      exits,
      wins,
      losses,
      pnl,
      commission: Number(r.commission) || 0,
      volumeSol: Number(r.volumeSol) || 0,
      volumeUsd: Number(r.volumeUsd) || 0,
      rag,
      winRate,
    });
    upserted++;
  }
  return upserted;
}

async function runRagJob() {
  try {
    const [pairsWithTrades] = await sequelize.query(
      'SELECT DISTINCT pairId FROM trade_logs'
    );
    const pairIds = pairsWithTrades.map(r => r.pairId);
    if (pairIds.length === 0) return;
    let total = 0;
    for (const pid of pairIds) {
      const count = await computeRagForPair(pid);
      total += count;
    }
    console.log(`[RAG] Updated ${total} hourly rows for ${pairIds.length} pair(s)`);
  } catch (err) {
    console.error('[RAG] Job failed:', err.message);
  }
}

let _timer = null;

function startRagScheduler(intervalMs = 60_000) {
  runRagJob();
  _timer = setInterval(runRagJob, intervalMs);
  console.log(`[RAG] Scheduler started — runs every ${intervalMs / 1000}s`);
}

function stopRagScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startRagScheduler, stopRagScheduler, runRagJob, computeRagForPair };
