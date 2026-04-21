#!/usr/bin/env node
/**
 * BTC-Native PnL Reconciliation
 * ─────────────────────────────
 * Everything stays in BTC. No USD conversion. No BTC/USD rate distortion.
 *
 * For each closed position we compute THREE independent BTC PnL figures
 * and compare them:
 *
 *   [A] DB-formula BTC   = (1/entryPrice - 1/exitPrice) * qty
 *                          Computed fresh from prices stored in DB.
 *                          This is what the bot *should* show.
 *
 *   [B] Exchange gross   = sum(fill.profit_loss)  — raw from Deribit fills.
 *                          Uses Deribit's blended avg. Captures full directional move.
 *
 *   [C] Exchange net     = [B] - sum(fill.fee)    — after maker/taker rebates.
 *
 * Account balance ground truth:
 *   Balance(now) - Balance(start) = sum of all [C] values + funding + other.
 *   Any residual = funding or transfers.
 *
 * Usage:
 *   node reconcile_btc_pnl.js           # defaults to pair 9
 *   node reconcile_btc_pnl.js --pair 9
 *   node reconcile_btc_pnl.js --pair 8
 */
const crypto = require('crypto');
require('dotenv').config();
const { sequelize, StatArbInput, AccountDetails } = require('./src/models');
const BasisPosition = require('./src/models/BasisPosition');
const { signedRequest } = require('./src/controllers/apicontroller');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

function dec(k, e, i) {
  const key = Buffer.from(k, 'base64');
  const iv  = Buffer.from(i, 'base64');
  const d   = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}

async function getCredentials(pair) {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: pair.tradeAccountA }, raw: true });
  if (!acc) throw new Error(`No account for Trade_Account="${pair.tradeAccountA}"`);
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const apiKey    = dec(ak2, ak1, ak0);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  const secretKey = dec(sk2, sk1, sk0);
  return { apiKey, secretKey };
}

async function fetchAllFillsByInstrument(sym, startMs, endMs, apiKey, secretKey) {
  const fills = [];
  let startT = startMs;
  for (let i = 0; i < 100; i++) {
    const resp = await signedRequest(
      `/api/v2/private/get_user_trades_by_instrument_and_time` +
      `?instrument_name=${encodeURIComponent(sym)}&start_timestamp=${startT}&end_timestamp=${endMs}&count=500&sorting=asc`,
      apiKey, secretKey
    );
    const trades = resp?.result?.trades || [];
    if (trades.length === 0) break;
    fills.push(...trades);
    startT = trades[trades.length - 1].timestamp + 1;
    if (trades.length < 500) break;
  }
  return fills;
}

async function getAccountSummary(apiKey, secretKey) {
  const resp = await signedRequest('/api/v2/private/get_account_summary?currency=BTC&extended=true', apiKey, secretKey);
  return resp?.result || {};
}

async function fetchTxLogs(startMs, endMs, apiKey, secretKey) {
  let all = [], cont = 0;
  for (let i = 0; i < 100; i++) {
    let url = `/api/v2/private/get_transaction_log?currency=BTC&start_timestamp=${startMs}&end_timestamp=${endMs}&count=500`;
    if (cont) url += `&continuation=${cont}`;
    const resp = await signedRequest(url, apiKey, secretKey);
    const logs = resp?.result?.logs || [];
    all = all.concat(logs);
    cont = resp?.result?.continuation;
    if (!cont || logs.length === 0) break;
  }
  return all;
}

/** Inverse contract formula: PnL in BTC = (1/entry - 1/exit) * qty */
function inversePnlBtc(entryPx, exitPx, qty) {
  if (!entryPx || !exitPx || !qty) return null;
  return (1 / entryPx - 1 / exitPx) * qty;
}

function btc8(n) { return (n >= 0 ? '+' : '') + n.toFixed(8); }
function btc6(n) { return (n >= 0 ? '+' : '') + n.toFixed(6); }
function pad(s, w) { return String(s).padStart(w); }

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const pairIdx = args.indexOf('--pair');
  const PAIR_ID = pairIdx >= 0 ? parseInt(args[pairIdx + 1]) : 9;

  await sequelize.authenticate();

  const pair = await StatArbInput.findByPk(PAIR_ID, { raw: true });
  if (!pair) throw new Error(`Pair ${PAIR_ID} not found`);

  const TRADED_SYMBOL = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const SIGNAL_SYMBOL = pair.tradeLeg === 'B' ? pair.symbol1 : pair.symbol2;

  console.log(`Pair ${PAIR_ID}: ${pair.agentName}`);
  console.log(`tradeLeg=${pair.tradeLeg}  executed=${TRADED_SYMBOL}  signal=${SIGNAL_SYMBOL}`);

  const { apiKey, secretKey } = await getCredentials(pair);
  const startMs = new Date(pair.createdAt).getTime();
  const endMs   = Date.now();

  // ── fetch exchange data ───────────────────────────────────────────────────
  process.stdout.write('Account summary... ');
  const acct = await getAccountSummary(apiKey, secretKey);
  console.log('done');

  process.stdout.write(`Exchange fills for ${TRADED_SYMBOL}... `);
  const allFills = await fetchAllFillsByInstrument(TRADED_SYMBOL, startMs, endMs, apiKey, secretKey);
  console.log(`${allFills.length} fills`);

  process.stdout.write('Transaction log... ');
  const txLogs = await fetchTxLogs(startMs, endMs, apiKey, secretKey);
  console.log(`${txLogs.length} entries`);

  // Index fills by order_id
  const fillsByOrder = {};
  for (const f of allFills) {
    if (!fillsByOrder[f.order_id]) fillsByOrder[f.order_id] = [];
    fillsByOrder[f.order_id].push(f);
  }

  // ── fetch DB positions ────────────────────────────────────────────────────
  const closedPos = await BasisPosition.findAll({
    where: { pairId: PAIR_ID, state: 'closed' },
    order: [['exitTime', 'ASC']],
    raw: true,
  });
  const openPos = await BasisPosition.findAll({
    where: { pairId: PAIR_ID, state: { [Op.in]: ['pending_entry', 'open', 'pending_exit'] } },
    raw: true,
  });

  console.log(`DB closed=${closedPos.length}  open=${openPos.length}`);

  // ── tx log: balance at start vs end ──────────────────────────────────────
  // Sort tx logs by timestamp; extract equity/balance trace
  const txSorted = txLogs.slice().sort((a, b) => a.timestamp - b.timestamp);
  const eqPoints = txSorted.filter(l => l.equity != null).map(l => ({ ts: l.timestamp, eq: l.equity, bal: l.balance }));
  const balStart  = eqPoints.length > 0 ? eqPoints[0].bal  ?? eqPoints[0].eq  : null;
  const balEnd    = eqPoints.length > 0 ? eqPoints[eqPoints.length - 1].bal ?? eqPoints[eqPoints.length - 1].eq : null;
  const balChange = balStart != null && balEnd != null ? balEnd - balStart : null;

  // Sum all funding entries from tx log
  const fundingEntries = txSorted.filter(l => l.type === 'funding' || l.info === 'funding');
  const totalFundingBtc = fundingEntries.reduce((a, l) => a + (l.change ?? 0), 0);

  // ── per-position reconciliation ───────────────────────────────────────────
  let totalDbFormulaBtc  = 0;  // [A] our formula from stored prices
  let totalExGrossBtc    = 0;  // [B] exchange profit_loss (blended-avg based)
  let totalExFeeBtc      = 0;  // fees
  let totalExNetBtc      = 0;  // [C] = [B] - fees
  let totalDbStoredPnlUsd = 0; // what bot stored in netPnl column (USD)

  let matched = 0, unmatched = 0;
  let tpCount = 0, slCount = 0, toCount = 0, otherCount = 0;
  let tpBtc = 0, slBtc = 0;
  let makerFills = 0, takerFills = 0;

  // largest discrepancy tracking
  const perTrade = [];

  for (const pos of closedPos) {
    const entryOrderId = pos.legA_entryOrderId;
    const exitOrderId  = pos.legA_exitOrderId;
    const entryFills   = fillsByOrder[entryOrderId] || [];
    const exitFills    = fillsByOrder[exitOrderId]  || [];

    // Exchange values (BTC)
    let exGross = 0, exFee = 0;
    for (const f of [...entryFills, ...exitFills]) {
      exGross += f.profit_loss || 0;
      exFee   += f.fee         || 0;
      if (f.liquidity === 'M') makerFills++; else takerFills++;
    }
    const exNet = exGross - exFee;

    // DB formula re-computed in BTC from stored prices
    const entryPx = pos.legA_entryPrice || pos.legB_entryPrice;
    const exitPx  = pos.legA_exitPrice  || pos.legB_exitPrice;
    const qty     = pos.legA_entryQty   || pos.legB_entryQty || pair.qty1;
    const dbFormulaNet = inversePnlBtc(entryPx, exitPx, qty);  // gross
    // commission from DB (stored in USD); subtract as BTC using exit price
    const dbCommUsd    = pos.commission || 0;
    const dbCommBtc    = exitPx ? dbCommUsd / exitPx : 0;
    const dbFormulaNetAfterFee = dbFormulaNet != null ? dbFormulaNet - dbCommBtc : null;

    const hasMatch = entryFills.length > 0 && exitFills.length > 0;
    if (hasMatch) matched++; else unmatched++;

    if (hasMatch) {
      totalExGrossBtc += exGross;
      totalExFeeBtc   += exFee;
      totalExNetBtc   += exNet;
    }
    if (dbFormulaNetAfterFee != null) totalDbFormulaBtc += dbFormulaNetAfterFee;
    totalDbStoredPnlUsd += pos.netPnl || 0;

    // exit reason buckets (BTC)
    switch (pos.exitReason) {
      case 'profit': tpCount++; if (hasMatch) tpBtc += exNet; break;
      case 'stop':   slCount++; if (hasMatch) slBtc += exNet; break;
      case 'timeout': toCount++; break;
      default: otherCount++;
    }

    // per-trade row for table
    const entryAvgPx = entryFills.length > 0
      ? entryFills.reduce((a, f) => a + f.price * f.amount, 0) / entryFills.reduce((a, f) => a + f.amount, 0)
      : entryPx;
    const exitAvgPx = exitFills.length > 0
      ? exitFills.reduce((a, f) => a + f.price * f.amount, 0) / exitFills.reduce((a, f) => a + f.amount, 0)
      : exitPx;

    perTrade.push({
      id: pos.id,
      exitReason: pos.exitReason,
      gridLevel: pos.gridLevel,
      direction: pos.direction,
      entryPx, exitPx,
      entryAvgPx, exitAvgPx,
      qty,
      dbFormulaGross: dbFormulaNet,
      dbFormulaBtc:   dbFormulaNetAfterFee,
      exGross,
      exFee,
      exNet,
      dbStoredPnlUsd: pos.netPnl || 0,
      hasMatch,
      holdMs: pos.holdMs,
      entryTime: pos.entryTime,
      exitTime:  pos.exitTime,
      entryFillCount: entryFills.length,
      exitFillCount:  exitFills.length,
    });
  }

  // ── open positions: unrealised BTC from exchange ───────────────────────────
  // Use exchange `total_pl` (unrealised PnL in BTC) from account summary
  const unrealisedBtc = acct.total_pl ?? 0;

  // ── discrepancy analysis ──────────────────────────────────────────────────
  // For matched trades: diff between exchange net and our formula
  const matched_ = perTrade.filter(t => t.hasMatch && t.dbFormulaBtc != null);
  const diffPerTrade = matched_.map(t => t.exNet - t.dbFormulaBtc);
  const totalDiff     = diffPerTrade.reduce((a, b) => a + b, 0);
  const avgDiff       = diffPerTrade.length > 0 ? totalDiff / diffPerTrade.length : 0;
  const maxDiff       = diffPerTrade.length > 0 ? Math.max(...diffPerTrade) : 0;
  const minDiff       = diffPerTrade.length > 0 ? Math.min(...diffPerTrade) : 0;

  // sort by abs diff desc for table
  const sortedByDiff = [...matched_].sort((a, b) => Math.abs(b.exNet - b.dbFormulaBtc) - Math.abs(a.exNet - a.dbFormulaBtc));

  // account balance reconciliation
  const acctBalanceBtc = acct.balance || 0;
  const botStartBtc    = pair.botStartBalance;  // captured on first enable

  // ── build report ──────────────────────────────────────────────────────────
  const HL = '═'.repeat(72);
  const lines = [];

  lines.push(HL);
  lines.push(`  PAIR ${PAIR_ID} — BTC-NATIVE PnL RECONCILIATION`);
  lines.push(`  ${pair.agentName}`);
  lines.push(`  Executed leg: ${TRADED_SYMBOL}  |  Signal leg: ${SIGNAL_SYMBOL}`);
  lines.push(`  Account: ${pair.tradeAccountA}`);
  lines.push(`  Config: qty=${pair.qty1}  TP_Δ=${pair.tpSpreadDelta}  SL_Δ=${pair.slSpreadDelta}  levels=${pair.spreadEntryLevels}  maxPos=${pair.maxPositions}`);
  lines.push(`  Window: ${new Date(pair.createdAt).toISOString()} → ${new Date(endMs).toISOString()}`);
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(HL);
  lines.push('');

  // ── S1: Account snapshot (BTC) ──────────────────────────────────────────
  lines.push('━━━ 1. ACCOUNT SNAPSHOT (BTC) ━━━');
  lines.push(`  Balance now:       ${acctBalanceBtc.toFixed(8)} BTC`);
  lines.push(`  Equity now:        ${(acct.equity || 0).toFixed(8)} BTC`);
  lines.push(`  Unrealised PnL:    ${btc8(unrealisedBtc)} BTC  (open positions)`);
  if (botStartBtc != null) {
    const lifetimeBtc = acctBalanceBtc - botStartBtc;
    lines.push(`  Bot start balance: ${botStartBtc.toFixed(8)} BTC`);
    lines.push(`  Lifetime balance Δ:${btc8(lifetimeBtc)} BTC  (realised balance change since first enable)`);
  } else {
    lines.push(`  Bot start balance: (not yet captured — first reconcile cycle pending)`);
  }
  if (balChange != null) {
    lines.push(`  TX log Δ balance:  ${btc8(balChange)} BTC  (from tx log: first→last balance entry)`);
  }
  if (Math.abs(totalFundingBtc) > 1e-8) {
    lines.push(`  Funding (tx log):  ${btc8(totalFundingBtc)} BTC`);
  }
  lines.push('');

  // ── S2: Three-way PnL comparison ────────────────────────────────────────
  lines.push('━━━ 2. THREE-WAY PnL COMPARISON (BTC) ━━━');
  lines.push('');
  lines.push('  Three independent PnL measures for the same set of trades:');
  lines.push('');
  lines.push(`  [A] DB-formula BTC  = (1/entry - 1/exit) × qty - fee`);
  lines.push(`      re-computed fresh from prices stored in DB`);
  lines.push(`      = ${totalDbFormulaBtc.toFixed(8)} BTC`);
  lines.push('');
  lines.push(`  [B] Exchange gross  = Σ fill.profit_loss  (Deribit blended-avg method)`);
  lines.push(`      = ${totalExGrossBtc.toFixed(8)} BTC`);
  lines.push('');
  lines.push(`  [C] Exchange net    = [B] − Σ fill.fee`);
  lines.push(`      fees = ${(-totalExFeeBtc).toFixed(8)} BTC  (negative = cost)`);
  lines.push(`      = ${totalExNetBtc.toFixed(8)} BTC`);
  lines.push('');
  lines.push(`  Gap [C] − [A]       = ${btc8(totalExNetBtc - totalDbFormulaBtc)} BTC`);
  lines.push(`    → This gap is caused by Deribit using a blended average entry`);
  lines.push(`      price across all simultaneous positions, not per-trade entry price.`);
  lines.push(`      When BTC price moves while multiple positions are open, [B] captures`);
  lines.push(`      the full directional move; [A] only captures the spread delta.`);
  lines.push('');
  lines.push(`  Account balance Δ vs Exchange net:`);
  if (botStartBtc != null) {
    const lifetimeBtc = acctBalanceBtc - botStartBtc;
    const residual    = lifetimeBtc - totalExNetBtc - unrealisedBtc;
    lines.push(`    Account Δ:       ${btc8(lifetimeBtc)} BTC`);
    lines.push(`    Exchange net:    ${btc8(totalExNetBtc)} BTC  (closed trades only)`);
    lines.push(`    Unrealised:      ${btc8(unrealisedBtc)} BTC`);
    lines.push(`    Residual:        ${btc8(residual)} BTC  (funding + deposits/withdrawals)`);
  } else {
    lines.push(`    (botStartBalance not captured yet — enable bot to record it)`);
  }
  lines.push('');

  // ── S3: Exit reason breakdown (BTC) ─────────────────────────────────────
  lines.push('━━━ 3. EXIT REASON BREAKDOWN (BTC) ━━━');
  lines.push(`  Total closed:    ${closedPos.length}`);
  lines.push(`  TP (profit):     ${tpCount.toString().padStart(4)}  exchange net = ${btc8(tpBtc)} BTC`);
  lines.push(`  SL (stop):       ${slCount.toString().padStart(4)}  exchange net = ${btc8(slBtc)} BTC`);
  lines.push(`  Timeout:         ${toCount.toString().padStart(4)}`);
  lines.push(`  Other/manual:    ${otherCount.toString().padStart(4)}`);
  lines.push('');
  lines.push(`  Net TP + SL:     ${btc8(tpBtc + slBtc)} BTC`);
  if (slCount > 0) {
    const avgSlBtc = slBtc / slCount;
    lines.push(`  Avg SL cost/trade:  ${avgSlBtc.toFixed(8)} BTC`);
    lines.push(`  Avg TP gain/trade:  ${tpCount > 0 ? (tpBtc / tpCount).toFixed(8) : 'n/a'} BTC`);
  }
  // SL trades that were actually profitable on exchange
  const slTrades = perTrade.filter(t => t.exitReason === 'stop' && t.hasMatch);
  const slProfitable = slTrades.filter(t => t.exNet > 0);
  if (slTrades.length > 0) {
    lines.push(`  SL trades exchange-positive: ${slProfitable.length} / ${slTrades.length}`);
  }
  lines.push('');

  // ── S4: Fee summary ──────────────────────────────────────────────────────
  lines.push('━━━ 4. FEE SUMMARY (BTC) ━━━');
  lines.push(`  Total fees paid:   ${(-totalExFeeBtc).toFixed(8)} BTC  (negative = cost to account)`);
  if (closedPos.length > 0) lines.push(`  Avg fee/roundtrip: ${(totalExFeeBtc / matched).toFixed(8)} BTC`);
  const totalFills = makerFills + takerFills;
  lines.push(`  Maker fills:       ${makerFills}  (${totalFills > 0 ? (makerFills / totalFills * 100).toFixed(1) : 0}%)`);
  lines.push(`  Taker fills:       ${takerFills}`);
  lines.push('');

  // ── S5: Discrepancy analysis ──────────────────────────────────────────────
  lines.push('━━━ 5. FORMULA DISCREPANCY ANALYSIS (BTC) ━━━');
  lines.push(`  Matched trades (both entry+exit fills found): ${matched} / ${closedPos.length}`);
  lines.push(`  Unmatched: ${unmatched}`);
  lines.push('');
  lines.push(`  Per-trade gap = exchange net [C] − formula net [A]`);
  lines.push(`  Total gap:    ${btc8(totalDiff)} BTC`);
  lines.push(`  Avg gap/trade:${btc8(avgDiff)} BTC`);
  lines.push(`  Max gap:      ${btc8(maxDiff)} BTC`);
  lines.push(`  Min gap:      ${btc8(minDiff)} BTC`);
  lines.push('');
  lines.push('  Why gaps exist per-trade:');
  lines.push('    • Deribit blends ALL simultaneous short positions into one avg price.');
  lines.push('    • Our formula uses the individual order fill price (correct for spread bot).');
  lines.push('    • If BTC price moved while positions were open, blended-avg gains/losses');
  lines.push('      differ from individual entry-price gains/losses.');
  lines.push('    • The BALANCE CHANGE [account Δ BTC] is the only unambiguous truth.');
  lines.push('');

  // ── S6: Top discrepancy trades ────────────────────────────────────────────
  lines.push('━━━ 6. TOP 15 DISCREPANCY TRADES ━━━');
  lines.push('  ID       Reason  Lvl  Dir    [A] fml BTC       [C] ex net BTC    Gap BTC');
  for (const t of sortedByDiff.slice(0, 15)) {
    const diff = t.exNet - t.dbFormulaBtc;
    lines.push(
      `  #${String(t.id).padEnd(6)} ` +
      `${(t.exitReason || '?').padEnd(8)}` +
      `L${String(t.gridLevel).padEnd(3)} ` +
      `${(t.direction || '?').padEnd(5)} ` +
      `${btc8(t.dbFormulaBtc).padStart(16)}  ` +
      `${btc8(t.exNet).padStart(16)}  ` +
      `${btc8(diff).padStart(12)}`
    );
  }
  lines.push('');

  // ── S7: Last 30 trades table ──────────────────────────────────────────────
  lines.push('━━━ 7. LAST 30 CLOSED TRADES (BTC) ━━━');
  lines.push('  ExitTime(UTC)  Rsn      Lvl  Dir    entry→exit      qty    [A]fml BTC    [C]exNet BTC   gap BTC');
  for (const t of perTrade.slice(-30)) {
    const ts   = t.exitTime ? new Date(t.exitTime).toISOString().slice(11, 19) : '?';
    const rsn  = (t.exitReason || '?').padEnd(8);
    const lvl  = ('L' + t.gridLevel).padEnd(4);
    const dir  = (t.direction || '?').padEnd(5);
    const px   = `${Math.round(t.entryPx || 0)}→${Math.round(t.exitPx || 0)}`;
    const qty  = String(Math.round(t.qty || 0));
    const fml  = t.dbFormulaBtc != null ? btc8(t.dbFormulaBtc) : '       n/a';
    const exn  = t.hasMatch ? btc8(t.exNet) : '       n/a';
    const gap  = (t.hasMatch && t.dbFormulaBtc != null) ? btc8(t.exNet - t.dbFormulaBtc) : '        —';
    const flag = (t.exitReason === 'stop' && t.hasMatch && t.exNet > 0) ? ' ← ex+' : '';
    lines.push(`  ${ts}  ${rsn} ${lvl} ${dir} ${px.padEnd(15)} ${qty.padEnd(5)}  ${fml.padStart(12)}    ${exn.padStart(12)}   ${gap.padStart(10)}${flag}`);
  }
  lines.push('');

  // ── S8: Per-level breakdown (BTC) ─────────────────────────────────────────
  const byLevel = {};
  for (const t of perTrade.filter(t => t.hasMatch)) {
    const k = 'L' + t.gridLevel;
    if (!byLevel[k]) byLevel[k] = { n: 0, tpN: 0, slN: 0, fmlBtc: 0, exNetBtc: 0, feeBtc: 0 };
    const v = byLevel[k];
    v.n++;
    if (t.exitReason === 'profit') v.tpN++;
    if (t.exitReason === 'stop')   v.slN++;
    if (t.dbFormulaBtc != null)    v.fmlBtc  += t.dbFormulaBtc;
    v.exNetBtc += t.exNet;
    v.feeBtc   += t.exFee;
  }
  lines.push('━━━ 8. PER-LEVEL BREAKDOWN (BTC) ━━━');
  lines.push('  Level   n   TP   SL   TP%    [A] fml BTC       [C] exNet BTC     fees BTC');
  for (const [k, v] of Object.entries(byLevel).sort()) {
    const wr = v.n > 0 ? (v.tpN / v.n * 100).toFixed(0) : '0';
    lines.push(
      `  ${k.padEnd(6)} ${String(v.n).padStart(3)} ${String(v.tpN).padStart(4)} ${String(v.slN).padStart(4)}  ` +
      `${(wr + '%').padStart(4)}  ` +
      `${btc8(v.fmlBtc).padStart(16)}  ${btc8(v.exNetBtc).padStart(16)}  ${v.feeBtc.toFixed(8)}`
    );
  }
  lines.push('');

  // ── S9: Cumulative BTC curve ──────────────────────────────────────────────
  lines.push('━━━ 9. CUMULATIVE BTC CURVE (exchange net, closed only) ━━━');
  let cum = 0, peak = 0, maxDD = 0;
  const hourly = {};
  for (const t of perTrade.filter(t => t.hasMatch)) {
    cum += t.exNet;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    const hr = t.exitTime ? new Date(t.exitTime).toISOString().slice(0, 13) : 'unknown';
    if (!hourly[hr]) hourly[hr] = 0;
    hourly[hr] += t.exNet;
  }
  lines.push(`  Peak cumulative:   ${btc8(peak)} BTC`);
  lines.push(`  Final cumulative:  ${btc8(cum)} BTC`);
  lines.push(`  Max drawdown:      ${(-maxDD).toFixed(8)} BTC`);
  lines.push('');
  lines.push('  Hourly breakdown (UTC):');
  let cumHr = 0;
  for (const [hr, pnl] of Object.entries(hourly).sort()) {
    cumHr += pnl;
    lines.push(`    ${hr}:  ${btc8(pnl).padStart(12)} BTC   cumul: ${btc8(cumHr).padStart(12)} BTC`);
  }
  lines.push('');

  // ── S10: Open positions summary ───────────────────────────────────────────
  lines.push('━━━ 10. OPEN POSITIONS ━━━');
  if (openPos.length === 0) {
    lines.push('  None.');
  } else {
    lines.push(`  Count: ${openPos.length}   Unrealised: ${btc8(unrealisedBtc)} BTC`);
    lines.push('  ID       Lvl  Dir    Entry price   Entry time (UTC)');
    for (const p of openPos) {
      const px = p.legA_entryPrice || p.legB_entryPrice || '?';
      const ts = p.entryTime ? new Date(p.entryTime).toISOString().slice(0, 19) : '?';
      lines.push(`  #${String(p.id).padEnd(6)} L${String(p.gridLevel).padEnd(3)} ${(p.direction || '?').padEnd(6)} $${px.toString().padEnd(13)} ${ts}`);
    }
  }
  lines.push('');

  lines.push(HL);

  // ── output ─────────────────────────────────────────────────────────────────
  const report = lines.join('\n');
  console.log('\n' + report);

  const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(__dirname, 'reports', `pair${PAIR_ID}_btc_reconcile_${stamp}.txt`);
  fs.mkdirSync(path.join(__dirname, 'reports'), { recursive: true });
  fs.writeFileSync(outPath, report);
  console.log(`\nSaved to: ${outPath}`);

  await sequelize.close();
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
