#!/usr/bin/env node
/**
 * Comprehensive report for pairId=20 (BTC_Options_Hedge).
 *
 * From DB (only):
 *   - SpreadLevelHistory adapt count (how many times levels adapted)
 *
 * From Exchange (Deribit) – everything else, no spreadlevel data:
 *   - Balance (current wallet + equity)
 *   - Positions (futures + options, all kinds)
 *   - Volume (sum |amount| across all fills in window)
 *   - Total profit exits (closing fills where profit_loss > 0)
 *   - Total loss exits  (closing fills where profit_loss < 0)
 *   - Rebates           (maker rebates credited to wallet)
 *   - PNL realised on profit exits — taker fee NOT deducted for market-close fills
 *
 * Usage:
 *   node scripts/btcFullReportPair20.js
 *   node scripts/btcFullReportPair20.js --pairId=20
 *   node scripts/btcFullReportPair20.js --hours=24
 *   node scripts/btcFullReportPair20.js --sinceBot    (since bot start: 2026-04-15 14:35 UTC)
 *   node scripts/btcFullReportPair20.js --no-file     (stdout only)
 *
 * Writes: Backend/reports/btc_full_report_pair<N>_<ts>.txt  (--pairId=N)
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const axios  = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails, SpreadLevelHistory } = require('../src/models');
const { currencyFromSymbol, asciiTablePush } = require('../lib/btcDeribitReconcileSection');

// ── helpers ──────────────────────────────────────────────────────────────────

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv  = Buffer.from(ivBase64,  'base64');
  const dc  = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return dc.update(encryptedText, 'base64', 'utf8') + dc.final('utf8');
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
}

async function deribitPost(token, method, params = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await axios.post(
      `https://www.deribit.com/api/v2/private/${method}`,
      { jsonrpc: '2.0', id: 1, method: `private/${method}`, params },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true }
    );
    const err = r.data?.error;
    if (r.status === 429 || err?.code === 10028) { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status >= 400) throw new Error(`${method} HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    if (err) throw new Error(err.message || JSON.stringify(err));
    return r.data.result;
  }
  throw new Error(`${method}: too many retries`);
}

async function deribitGet(token, path_, params = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = await axios.get(`https://www.deribit.com${path_}`, {
      headers: { Authorization: `Bearer ${token}` }, params, timeout: 30000, validateStatus: () => true,
    });
    const err = r.data?.error;
    if (r.status === 429 || err?.code === 10028) { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status >= 400) throw new Error(`GET ${path_} HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    if (err) throw new Error(err.message || JSON.stringify(err));
    return r.data.result;
  }
  throw new Error(`GET ${path_}: too many retries`);
}

/** Fetch ALL user trades for currency since startMs (all instruments). */
async function fetchAllTrades(token, currency, startMs) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(700);
    const res = await deribitPost(token, 'get_user_trades_by_currency_and_time', {
      currency, start_timestamp: cur, end_timestamp: Date.now(), count: 1000, sorting: 'asc',
    });
    const trades = res.trades || [];
    if (!trades.length) break;
    all.push(...trades);
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

function emitTable(L, colDefs, rows) {
  const buf = [];
  asciiTablePush(buf, colDefs, rows);
  for (const line of buf) L(line);
}

function parseArgs() {
  let pairId = 20;
  let hours  = null;
  let sinceBot = false;
  let noFile   = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairId=')) pairId = parseInt(a.split('=')[1], 10) || 20;
    if (a.startsWith('--hours='))  hours  = parseFloat(a.split('=')[1]) || null;
    if (a === '--sinceBot')        sinceBot = true;
    if (a === '--no-file' || a === '--stdout-only') noFile = true;
  }
  return { pairId, hours, sinceBot, noFile };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { pairId, hours, sinceBot, noFile } = parseArgs();
  await sequelize.authenticate();

  // ── 1. Load pair from DB (need botStartedAt for correct exchange window) ─────
  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) {
    console.error(`pairId ${pairId} not found in DB`);
    process.exit(1);
  }

  const now = Date.now();
  const LEGACY_BOT_START_MS = Date.UTC(2026, 3, 15, 14, 35, 0, 0); // fallback if botStartedAt unset
  const botStartMs = pair.botStartedAt
    ? new Date(pair.botStartedAt).getTime()
    : LEGACY_BOT_START_MS;

  let startMs, windowLabel;
  if (sinceBot) {
    startMs = botStartMs;
    windowLabel = `since bot start  ${new Date(botStartMs).toISOString()}  →  ${new Date(now).toISOString()}`;
  } else if (hours != null) {
    startMs = now - hours * 3600000;
    windowLabel = `last ${hours}h rolling  ${new Date(startMs).toISOString()}  →  ${new Date(now).toISOString()}`;
  } else {
    startMs = botStartMs;
    windowLabel = `since bot start  ${new Date(botStartMs).toISOString()}  →  ${new Date(now).toISOString()}`;
  }
  const execSym  = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;

  // ── 2. Adapt count from DB (SpreadLevelHistory) ─────────────────────────────
  const adaptRows = await SpreadLevelHistory.findAll({
    where: { pairId, changedBy: 'adapt' },
    order: [['id', 'ASC']],
  });
  const adaptCount = adaptRows.length;

  // Last adapt detail
  const lastAdapt = adaptRows.length ? adaptRows[adaptRows.length - 1] : null;

  // ── 3. Deribit credentials ──────────────────────────────────────────────────
  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    console.error(`AccountDetails missing for ${acctName}`);
    process.exit(1);
  }
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token  = await getToken(apiKey, secret);
  await sleep(1200);

  // ── 4. BTC index price ──────────────────────────────────────────────────────
  const ix  = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
    params: { index_name: `${currency.toLowerCase()}_usd` },
  }).catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;
  const usd = (btc) => (idx > 0 && Number.isFinite(Number(btc)) ? Number(btc) * idx : null);
  const usdStr = (btc, d = 4) => {
    const v = usd(btc);
    return v != null ? `$${v.toFixed(d)}` : 'n/a';
  };

  // ── 5. Account summary ──────────────────────────────────────────────────────
  const summary = await deribitPost(token, 'get_account_summary', { currency, extended: true });
  await sleep(1200);

  // ── 6. Positions (futures + options) ───────────────────────────────────────
  const futurePositions = await deribitPost(token, 'get_positions', { currency, kind: 'future' });
  await sleep(800);
  const optionPositions = await deribitPost(token, 'get_positions', { currency, kind: 'option' });
  await sleep(800);
  const allPositions = [...(futurePositions || []), ...(optionPositions || [])];
  const openPositions = allPositions.filter((p) => Number(p.size) !== 0);

  // ── 7. Open orders ──────────────────────────────────────────────────────────
  const openOrders = await deribitPost(token, 'get_open_orders_by_currency', { currency });
  await sleep(1200);

  // ── 8. All trades in window (all instruments) ───────────────────────────────
  const allTrades = await fetchAllTrades(token, currency, startMs);
  // Filter to executed instrument only for the detailed metrics
  const execTrades = allTrades.filter((t) => t.instrument_name === execSym);

  // ── 9. Compute metrics from execTrades ─────────────────────────────────────
  let totalVolUsd   = 0;
  let sumPl         = 0;
  let sumFee        = 0;
  let rebateBtc     = 0;
  let takerPaidBtc  = 0;

  // Profit exits
  let profitExitCount     = 0;
  let profitExitPlBtc     = 0;    // sum profit_loss on profit exits
  let profitExitRebateBtc = 0;    // maker rebates on profit-exit fills
  // PNL on profit exits = profit_loss + maker_rebate (taker NOT deducted for market closes)
  let profitExitEconBtc   = 0;

  // Loss exits
  let lossExitCount    = 0;
  let lossExitPlBtc    = 0;

  // Open fills (no realized slice)
  let openFillCount = 0;

  for (const f of execTrades) {
    const pl  = Number(f.profit_loss) || 0;
    const fee = Number(f.fee) || 0;
    totalVolUsd  += Math.abs(Number(f.amount) || 0);
    sumPl        += pl;
    sumFee       += fee;
    if (fee < 0) rebateBtc    += -fee;   // maker rebate
    else if (fee > 0) takerPaidBtc += fee;

    if (pl > 0) {
      // PROFIT EXIT
      profitExitCount++;
      profitExitPlBtc += pl;
      const fillRebate = fee < 0 ? -fee : 0;
      profitExitRebateBtc += fillRebate;
      // Economic PNL: profit_loss + maker_rebate
      // If fill was a market close (liquidity=T / order_type=market), do NOT deduct taker
      const isMarketClose = (f.order_type === 'market') || (f.liquidity === 'T' && f.order_type === 'market');
      if (isMarketClose) {
        // taker fee excluded for market closes on profit exits
        profitExitEconBtc += pl + fillRebate;
      } else {
        profitExitEconBtc += pl + fee; // fee is either rebate (+) or taker (-)
      }
    } else if (pl < 0) {
      // LOSS EXIT
      lossExitCount++;
      lossExitPlBtc += pl;
    } else {
      // Open / no realized slice
      openFillCount++;
    }
  }

  const walletOnFillsBtc = sumPl + sumFee;
  const markPlMinusNegRebate = sumPl + rebateBtc;

  // ── 10. Volume across ALL instruments ──────────────────────────────────────
  let totalVolAllUsd = 0;
  for (const t of allTrades) totalVolAllUsd += Math.abs(Number(t.amount) || 0);

  // ── 11. Build report ────────────────────────────────────────────────────────
  const lines = [];
  const L = (s) => { lines.push(s); console.log(s); };

  const pairLabel = pair.agentName || `Pair ${pairId}`;
  L('================================================================================');
  L(`  ${currency} FULL REPORT — ${pairLabel}  (pairId=${pairId})`);
  L(`  Instrument: ${execSym}  |  Account: ${acctName}`);
  L(`  Generated (UTC): ${new Date().toISOString()}`);
  L('================================================================================');
  L('');

  // ── ADAPT COUNT (from DB) ───────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 1 · ADAPTIVE LEVEL CHANGES (from DB · SpreadLevelHistory)');
  L('================================================================================');
  L(`  pairId:                  ${pairId}`);
  L(`  changedBy = "adapt" rows (ALL TIME): ${adaptCount}`);
  if (lastAdapt) {
    const lv = Array.isArray(lastAdapt.levels) ? lastAdapt.levels.join(', ') : JSON.stringify(lastAdapt.levels);
    L(`  last adapt at (UTC):     ${lastAdapt.createdAt}`);
    L(`  last adapt levels:       [${lv}]`);
    L(`  last adapt tp/sl:        tp=${lastAdapt.tpSpreadDelta}  sl=${lastAdapt.slSpreadDelta}  cap=${lastAdapt.maxSpreadCap}`);
  }
  L('  NOTE: spreadlevel detail NOT included per request — adapt count only.');
  L('');

  // ── BALANCE ─────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 2 · BALANCE (from Exchange · get_account_summary)');
  L('================================================================================');
  const equity    = Number(summary.equity);
  const balance   = Number(summary.balance);
  const sessionUpl = Number(summary.session_upl) || 0;
  const sessionRpl = Number(summary.session_rpl) || 0;
  emitTable(L, [
    { h: 'metric',  w: 48 },
    { h: currency,  w: 18, align: 'r' },
    { h: '~USD',    w: 18, align: 'r' },
  ], [
    ['Equity (incl. unrealized PnL)',
      equity.toFixed(8),
      usdStr(equity)],
    ['Balance (wallet, no UPL)',
      balance.toFixed(8),
      usdStr(balance)],
    ['Available funds',
      summary.available_funds != null ? Number(summary.available_funds).toFixed(8) : 'n/a',
      usdStr(summary.available_funds)],
    ['Session UPL (unrealized, this Deribit session)',
      sessionUpl.toFixed(8),
      usdStr(sessionUpl)],
    ['Session RPL (realized, this Deribit session)',
      sessionRpl.toFixed(8),
      usdStr(sessionRpl)],
    ['Session total PnL (upl+rpl)',
      (sessionUpl + sessionRpl).toFixed(8),
      usdStr(sessionUpl + sessionRpl)],
    ['Bot start balance (DB botStartBalance)',
      pair.botStartBalance != null ? Number(pair.botStartBalance).toFixed(8) : 'n/a',
      pair.botStartBalance != null ? usdStr(pair.botStartBalance) : 'n/a'],
  ]);
  L(`  BTC index price (reference): $${idx ? idx.toFixed(2) : 'n/a'}`);
  L('');

  // ── POSITIONS ───────────────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 3 · POSITIONS (from Exchange · get_positions, futures + options)');
  L('================================================================================');
  L(`  total position rows: ${allPositions.length}  open (non-zero): ${openPositions.length}`);
  if (openPositions.length === 0) {
    L('  FLAT — no open positions');
  } else {
    const posRows = openPositions.map((p) => {
      const floatUpl = p.floating_profit_loss_usd != null
        ? `$${Number(p.floating_profit_loss_usd).toFixed(4)}`
        : usdStr(p.floating_profit_loss);
      return [
        p.instrument_name || '-',
        String(p.size ?? ''),
        p.direction || '-',
        p.average_price != null ? String(p.average_price) : '-',
        floatUpl,
        p.delta != null ? Number(p.delta).toFixed(6) : '-',
        p.kind || '-',
      ];
    });
    emitTable(L, [
      { h: 'instrument',   w: 26 },
      { h: 'size',         w: 8,  align: 'r' },
      { h: 'dir',          w: 6 },
      { h: 'avg_price',    w: 12, align: 'r' },
      { h: 'upl~$',        w: 14, align: 'r' },
      { h: 'delta',        w: 12, align: 'r' },
      { h: 'kind',         w: 8 },
    ], posRows);
  }
  L('');

  // ── OPEN ORDERS ─────────────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 4 · OPEN ORDERS (from Exchange · get_open_orders_by_currency)');
  L('================================================================================');
  const ooArr = Array.isArray(openOrders) ? openOrders : [];
  L(`  count: ${ooArr.length}`);
  if (ooArr.length) {
    const ooRows = ooArr.map((o) => [
      o.instrument_name || '-',
      o.direction || '-',
      String(o.amount ?? ''),
      String(o.price ?? ''),
      o.order_type || '-',
      o.order_state || '-',
      (o.label || '-').slice(0, 20),
    ]);
    emitTable(L, [
      { h: 'instrument',  w: 26 },
      { h: 'dir',         w: 5 },
      { h: 'amount',      w: 8,  align: 'r' },
      { h: 'price',       w: 10, align: 'r' },
      { h: 'type',        w: 10 },
      { h: 'state',       w: 10 },
      { h: 'label',       w: 20 },
    ], ooRows);
  }
  L('');

  // ── VOLUME ───────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 5 · VOLUME (from Exchange · user trades in window)');
  L(`  window: ${windowLabel}`);
  L('================================================================================');
  L(`  executed instrument: ${execSym}`);
  L(`  total fills (${execSym}): ${execTrades.length}`);
  L(`  volume ${execSym} sum |amount| USD: $${totalVolUsd.toFixed(2)}`);
  L(`  total fills (ALL instruments in window): ${allTrades.length}`);
  L(`  volume ALL instruments sum |amount| USD: $${totalVolAllUsd.toFixed(2)}`);
  L('');
  // Per-instrument breakdown
  const byInstr = {};
  for (const t of allTrades) {
    const k = t.instrument_name || '(unknown)';
    if (!byInstr[k]) byInstr[k] = { n: 0, vol: 0 };
    byInstr[k].n++;
    byInstr[k].vol += Math.abs(Number(t.amount) || 0);
  }
  const instrRows = Object.entries(byInstr).sort((a, b) => b[1].vol - a[1].vol).map(([name, d]) => [
    name, String(d.n), `$${d.vol.toFixed(2)}`,
  ]);
  if (instrRows.length) {
    emitTable(L, [
      { h: 'instrument', w: 26 },
      { h: 'fills', w: 7, align: 'r' },
      { h: 'vol USD', w: 14, align: 'r' },
    ], instrRows);
  }
  L('');

  // ── PROFIT / LOSS EXITS ──────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 6 · PROFIT & LOSS EXITS (from Exchange fills, executed instrument only)');
  L(`  instrument: ${execSym}  window: ${windowLabel}`);
  L('  "Exit fill" = fill where profit_loss ≠ 0 (exchange marks realized PnL on each reduce)');
  L('  NOTE: profit_loss>0 is exchange position accounting per fill, not the same as bot round-trip gross.');
  L('================================================================================');
  emitTable(L, [
    { h: 'metric',             w: 52 },
    { h: 'count / BTC',        w: 20, align: 'r' },
    { h: '~USD',               w: 16, align: 'r' },
  ], [
    ['Total closing fills (profit_loss ≠ 0)',   String(profitExitCount + lossExitCount),  ''],
    ['Total PROFIT exits (profit_loss > 0)',     String(profitExitCount),                  ''],
    ['Total LOSS exits (profit_loss < 0)',       String(lossExitCount),                    ''],
    ['Open fills (profit_loss = 0)',             String(openFillCount),                    ''],
  ]);
  L('');

  // ── PNL REALISED ON PROFIT EXITS ────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 7 · PNL REALISED ON PROFIT EXITS');
  L('  Rule: profit_loss + maker_rebate; taker fee NOT deducted for market-close fills.');
  L('================================================================================');
  emitTable(L, [
    { h: 'metric',                              w: 56 },
    { h: currency,                              w: 18, align: 'r' },
    { h: '~USD',                                w: 16, align: 'r' },
  ], [
    ['Sum profit_loss on profit exits (price PnL)',
      profitExitPlBtc.toFixed(8),
      usdStr(profitExitPlBtc)],
    ['Maker rebates on profit-exit fills (+)',
      profitExitRebateBtc.toFixed(8),
      usdStr(profitExitRebateBtc)],
    ['PNL on profit exits (pl + rebate, no market taker)',
      profitExitEconBtc.toFixed(8),
      usdStr(profitExitEconBtc)],
    ['Sum profit_loss on LOSS exits',
      lossExitPlBtc.toFixed(8),
      usdStr(lossExitPlBtc)],
  ]);
  L('  Note: market-close taker fees are excluded from profit-exit econ PnL per request.');
  L('');

  // ── REBATES ───────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 8 · REBATES (maker rebates credited to wallet, executed instrument)');
  L('================================================================================');
  emitTable(L, [
    { h: 'metric',                                  w: 52 },
    { h: currency,                                  w: 18, align: 'r' },
    { h: '~USD',                                    w: 16, align: 'r' },
  ], [
    ['Total maker rebates (fee < 0 fills, sum |fee|)',
      rebateBtc.toFixed(8),
      usdStr(rebateBtc)],
    ['Total taker paid (fee > 0 fills)',
      takerPaidBtc.toFixed(8),
      usdStr(takerPaidBtc)],
    ['Net fee (taker − rebate)',
      (takerPaidBtc - rebateBtc).toFixed(8),
      usdStr(takerPaidBtc - rebateBtc)],
  ]);
  L('');

  // ── OVERALL PNL SUMMARY ───────────────────────────────────────────────────────
  L('================================================================================');
  L('SECTION 9 · OVERALL PNL SUMMARY (executed instrument, all fills in window)');
  L('================================================================================');
  emitTable(L, [
    { h: 'metric',                                  w: 52 },
    { h: currency,                                  w: 18, align: 'r' },
    { h: '~USD',                                    w: 16, align: 'r' },
  ], [
    ['Sum profit_loss (price-only realized PnL)',
      sumPl.toFixed(8),
      usdStr(sumPl)],
    ['mark PnL − (−rebate) = pl + rebate+',
      markPlMinusNegRebate.toFixed(8),
      usdStr(markPlMinusNegRebate)],
    ['Wallet on fills (sum profit_loss + fee)',
      walletOnFillsBtc.toFixed(8),
      usdStr(walletOnFillsBtc)],
  ]);
  L('');

  // ── FOOTNOTES ─────────────────────────────────────────────────────────────────
  L('================================================================================');
  L('NOTES');
  L('================================================================================');
  L('  • SpreadLevelHistory adapt count: DB only — exchange does not store this.');
  L('  • Balance / positions / fills: live from Deribit exchange at report time.');
  L(`  • BTC index price used for USD conversions: $${idx ? idx.toFixed(2) : 'n/a'}`);
  L(`  • Executed instrument for fill metrics: ${execSym}`);
  L('  • "Profit exit" = fill where profit_loss > 0 (per-fill; not strategy round-trip).');
  L('  • "Taker not deducted for market close" = market-order fills on profit exits');
  L('    have taker fee excluded from economic PnL (profit_loss + maker_rebate only).');
  L('  • Volume = sum |amount| in USD (Deribit inverse contracts: amount in USD).');
  L('================================================================================');
  L('END OF REPORT');
  L('================================================================================');

  await sequelize.close();

  if (noFile) {
    console.log('\n(--no-file: printed above; no file written.)');
    return;
  }
  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const ts        = new Date().toISOString().replace(/[:.]/g, '-');
  const ccyPrefix = currency ? currency.toLowerCase() : 'btc';
  const outPath   = path.join(outDir, `${ccyPrefix}_full_report_pair${pairId}_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\nWrote', outPath);
}

main().catch((e) => {
  if (e.response) console.error('HTTP', e.response.status, JSON.stringify(e.response.data));
  console.error(e.message || e);
  process.exit(1);
});
