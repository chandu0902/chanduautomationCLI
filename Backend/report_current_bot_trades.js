/**
 * Complete trade report for pair(s) with status=active AND tradingEnabled=true.
 *   node report_current_bot_trades.js
 *   node report_current_bot_trades.js --pairId=6   # force one pair
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize, StatArbInput, Trade, BasisPosition, BotSessionLog } = require('./src/models');

function fmt(n, d = 6) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}
function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

function parsePairId() {
  const a = process.argv.find((x) => x.startsWith('--pairId='));
  if (!a) return null;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  await sequelize.authenticate();
  const forceId = parsePairId();

  let active;
  if (forceId != null) {
    const p = await StatArbInput.findByPk(forceId);
    active = p ? [p] : [];
  } else {
    active = await StatArbInput.findAll({
      where: { status: 'active', tradingEnabled: true },
      order: [['id', 'ASC']],
    });
  }

  const lines = [];
  const log = (s) => lines.push(s);

  log('================================================================================');
  log('COMPLETE TRADE REPORT — current running bot(s)');
  log(`Generated: ${new Date().toISOString()}`);
  if (forceId != null) log(`Scope: --pairId=${forceId} (forced)`);
  else log('Scope: status=active AND tradingEnabled=true');
  log('================================================================================');
  log('');

  if (active.length === 0) {
    log('No matching pair found.');
    const fallback = await StatArbInput.findAll({
      where: { status: 'active' },
      order: [['id', 'DESC']],
      limit: 3,
    });
    if (fallback.length) {
      log('Most recent active pairs (trading may be disabled):');
      for (const p of fallback) {
        log(`  id=${p.id} ${p.agentName} tradingEnabled=${p.tradingEnabled}`);
      }
      log('');
      log('Re-run with: node report_current_bot_trades.js --pairId=<id>');
    }
  }

  for (const pair of active) {
    const pid = pair.id;
    const trades = await Trade.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });
    const bp = await BasisPosition.findAll({ where: { pairId: pid }, order: [['id', 'ASC']] });
    const sessions = await BotSessionLog.findAll({
      where: { pairId: pid },
      order: [['enabledAt', 'DESC']],
      limit: 20,
    });

    log('--------------------------------------------------------------------------------');
    log(`PAIR id=${pid}`);
    log('--------------------------------------------------------------------------------');
    log(`  agentName:        ${pair.agentName}`);
    log(`  symbol1/symbol2:  ${pair.symbol1} / ${pair.symbol2}`);
    const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
    log(`  tradeLeg:         ${pair.tradeLeg} (executed: ${execSym})`);
    log(`  status:           ${pair.status}  tradingEnabled: ${pair.tradingEnabled}`);
    log(`  qty1 / maxQty1:   ${pair.qty1} / ${pair.maxQty1}`);
    log(`  spreadEntryLevels:${pair.spreadEntryLevels || '-'}`);
    log(`  maxPositions:     ${pair.maxPositions}`);
    log(`  tpSpreadDelta:    ${pair.tpSpreadDelta}  slSpreadDelta: ${pair.slSpreadDelta}`);
    log(`  zEntryThreshold:  ${pair.zEntryThreshold}  zEntryMax: ${pair.zEntryMax}`);
    log(`  maxSpreadCap:     ${pair.maxSpreadCap}`);
    log(`  entryPollTimeoutMs: ${pair.entryPollTimeoutMs}`);
    log('');

    const byStatus = {};
    for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    log('--- trade_logs ---');
    log(`  Total rows: ${trades.length}`);
    for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
      log(`    status ${k}: ${v}`);
    }
    const filled = trades.filter((t) => t.status === 'filled');
    const cancelled = trades.filter((t) => t.status === 'cancelled');
    log(
      `  Filled: ${filled.length} | Cancelled: ${cancelled.length} | Open/other: ${trades.length - filled.length - cancelled.length}`
    );
    const cr = {};
    for (const t of cancelled) {
      const r = t.cancelReason || '(null)';
      cr[r] = (cr[r] || 0) + 1;
    }
    log('  Cancelled by cancelReason:');
    for (const [r, n] of Object.entries(cr).sort((a, b) => b[1] - a[1])) log(`    ${r}: ${n}`);
    let sumLeg = 0;
    let sumComm = 0;
    let sumTaker = 0;
    for (const t of filled) {
      sumLeg += (Number(t.legA_pnl) || 0) + (Number(t.legB_pnl) || 0);
      if (t.commission != null) sumComm += Number(t.commission);
      if (t.takerFeeUsd != null) sumTaker += Number(t.takerFeeUsd);
    }
    log(`  Filled — sum legA_pnl+legB_pnl: $${fmt(sumLeg)}`);
    log(`  Filled — sum commission: $${fmt(sumComm)}`);
    log(`  Filled — sum takerFeeUsd: $${fmt(sumTaker)}`);
    log(`  Filled — net (legs+comm-taker): $${fmt(sumLeg + sumComm - sumTaker)}`);
    const entries = filled.filter((t) => t.side === 'entry');
    const exits = filled.filter((t) => t.side === 'exit');
    log(`  Filled entries: ${entries.length} | Filled exits: ${exits.length}`);
    log('');

    log('--- basis_positions ---');
    const closed = bp.filter((p) => p.state === 'closed');
    const openish = bp.filter((p) => ['open', 'pending_entry', 'pending_exit'].includes(p.state));
    const failed = bp.filter((p) => p.state === 'failed');
    log(`  Total rows: ${bp.length}`);
    log(`  Closed: ${closed.length} | Open/pending: ${openish.length} | Failed: ${failed.length}`);
    const byExit = {};
    for (const p of closed) {
      const r = p.exitReason || '(null)';
      byExit[r] = (byExit[r] || 0) + 1;
    }
    log('  Closed by exitReason:');
    for (const [r, n] of Object.entries(byExit).sort((a, b) => b[1] - a[1])) log(`    ${r}: ${n}`);
    let sg = 0;
    let sn = 0;
    for (const p of closed) {
      sg += Number(p.grossPnl || 0);
      sn += Number(p.netPnl || 0);
    }
    log(`  Closed sum grossPnl: $${fmt(sg)}`);
    log(`  Closed sum netPnl:   $${fmt(sn)}`);
    const holds = closed.map((p) => p.holdMs).filter((x) => x != null && x > 0);
    if (holds.length) {
      log(
        `  Hold time closed (ms): median=${fmt(median(holds), 0)} mean=${fmt(mean(holds), 0)} min=${Math.min(...holds)} max=${Math.max(...holds)}`
      );
    }
    const gridCount = {};
    for (const p of bp) {
      const g = p.gridLevel == null ? 'null' : String(p.gridLevel);
      gridCount[g] = (gridCount[g] || 0) + 1;
    }
    log('  By gridLevel (all states):');
    for (const [g, n] of Object.entries(gridCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      log(`    grid ${g}: ${n}`);
    }
    if (openish.length) {
      log('  Open / pending (detail):');
      for (const p of openish) {
        log(
          `    id=${p.id} state=${p.state} grid=${p.gridLevel} entrySpread=${p.entrySpread} dir=${p.direction || '-'} entryTime=${p.entryTime || '-'}`
        );
      }
    }
    log('');

    log('--- bot_session_logs (last 20) ---');
    if (sessions.length === 0) log('  (none)');
    for (const s of sessions) {
      log(
        `  id=${s.id} enabledAt=${s.enabledAt} disabledAt=${s.disabledAt || '(running)'} stopReason=${s.stopReason || '-'} sessionPnl=${s.sessionPnl != null ? fmt(s.sessionPnl) : '-'} uptimeMs=${s.uptimeMs || '-'}`
      );
    }
    log('');

    log('--- Last 25 trade_logs (newest first) ---');
    const recent = await Trade.findAll({
      where: { pairId: pid },
      order: [['id', 'DESC']],
      limit: 25,
    });
    for (const t of recent) {
      log(
        `  id=${t.id} ${t.side} status=${t.status} ${t.legA_symbol} ${t.legA_side} qty=${t.legA_qty} px=${t.legA_price} pnl=${t.pnl != null ? fmt(t.pnl) : '-'} cancel=${t.cancelReason || '-'}`
      );
    }
    log('');
  }

  log('================================================================================');
  log('END OF REPORT');
  log('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `current_bot_trade_report_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
