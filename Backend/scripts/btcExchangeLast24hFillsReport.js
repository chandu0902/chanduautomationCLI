#!/usr/bin/env node
/**
 * Last 24 hours (rolling): exchange-only report from Deribit user trades on the
 * pair's executed instrument. No get_positions, no UPL, no account_summary MTM,
 * no DB — only get_user_trades_by_currency_and_time (filtered to instrument).
 *
 *   node scripts/btcExchangeLast24hFillsReport.js
 *   node scripts/btcExchangeLast24hFillsReport.js --pairId=19 --hours=24
 *   node scripts/btcExchangeLast24hFillsReport.js --sinceUtcYesterday  (window: UTC yesterday 00:00 → now)
 *   node scripts/btcExchangeLast24hFillsReport.js --no-file   (stdout only; no reports/*.txt)
 *   node scripts/btcExchangeLast24hFillsReport.js --verbose   (full ASCII tables + notes)
 *
 * Default output is a short list (exchange fills only; no position PnL).
 * Writes: Backend/reports/btc_exchange_last24h_fills_only_<pairId>_<ts>.txt
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { sequelize, StatArbInput, AccountDetails } = require('../src/models');
const { currencyFromSymbol } = require('../lib/btcDeribitReconcileSection');

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0',
    id: 1,
    method: 'public/auth',
    params: {
      grant_type: 'client_credentials',
      client_id: apiKey,
      client_secret: secret,
      scope: 'trade:read_write',
    },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchInstrumentTradesWindow(token, currency, startMs, instrumentName) {
  const all = [];
  let cur = startMs;
  for (let page = 0; page < 150; page++) {
    await sleep(700);
    let r;
    for (let attempt = 0; attempt < 8; attempt++) {
      r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          currency,
          start_timestamp: cur,
          end_timestamp: Date.now(),
          count: 1000,
          sorting: 'asc',
        },
        timeout: 25000,
        validateStatus: () => true,
      });
      const err = r.data?.error;
      if (r.status === 429 || err?.code === 10028) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (r.status >= 400) throw new Error(`get_user_trades HTTP ${r.status}: ${JSON.stringify(r.data)}`);
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    for (const t of trades) {
      if (t.instrument_name === instrumentName) all.push(t);
    }
    if (!res.has_more) break;
    cur = trades[trades.length - 1].timestamp + 1;
  }
  return all;
}

function parseArgs() {
  let pairId = 19;
  let hours = 24;
  let sinceUtcYesterday = false;
  let noFile = false;
  let verbose = false;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--pairId=')) pairId = parseInt(a.split('=')[1], 10) || 19;
    if (a.startsWith('--hours=')) hours = Math.min(168, Math.max(1, parseFloat(a.split('=')[1]) || 24));
    if (a === '--sinceUtcYesterday' || a === '--since-utc-yesterday') sinceUtcYesterday = true;
    if (a === '--no-file' || a === '--stdout-only') noFile = true;
    if (a === '--verbose' || a === '--full') verbose = true;
  }
  return { pairId, hours, sinceUtcYesterday, noFile, verbose };
}

function emitAsciiTable(L, colDefs, rows) {
  const widths = colDefs.map((c) => c.w);
  const aligns = colDefs.map((c) => c.align || 'l');
  const pad = (s, w, align) => {
    const t = String(s ?? '');
    const show = t.length > w ? t.slice(0, Math.max(1, w - 1)) + '…' : t;
    const n = Math.max(0, w - show.length);
    return align === 'r' ? ' '.repeat(n) + show : show + ' '.repeat(n);
  };
  const sep = () => '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const line = (cells) =>
    '|' + cells.map((c, i) => ' ' + pad(c, widths[i], aligns[i]) + ' ').join('|') + '|';
  L(sep());
  L(line(colDefs.map((c) => c.h)));
  L(sep());
  for (const r of rows) L(line(r));
  L(sep());
}

async function main() {
  const { pairId, hours, sinceUtcYesterday, noFile, verbose } = parseArgs();
  await sequelize.authenticate();

  const endMs = Date.now();
  let startMs;
  let windowLabel;
  if (sinceUtcYesterday) {
    const y = new Date(endMs).getUTCFullYear();
    const mo = new Date(endMs).getUTCMonth();
    const d = new Date(endMs).getUTCDate();
    startMs = Date.UTC(y, mo, d - 1, 0, 0, 0, 0);
    windowLabel = `since UTC yesterday 00:00  ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`;
  } else {
    startMs = endMs - hours * 3600000;
    windowLabel = `last ${hours}h rolling  ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`;
  }

  const pair = await StatArbInput.findByPk(pairId);
  if (!pair) {
    console.error(`pairId ${pairId} not found`);
    process.exit(1);
  }

  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  if (!acctName) {
    console.error('No tradeAccount on pair');
    process.exit(1);
  }

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    console.error('AccountDetails missing for', acctName);
    process.exit(1);
  }
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token = await getToken(apiKey, secret);
  await sleep(1200);

  const ix = await axios
    .get('https://www.deribit.com/api/v2/public/get_index_price', {
      params: { index_name: `${currency.toLowerCase()}_usd` },
    })
    .catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;
  const usd = (x) => (idx > 0 && Number.isFinite(Number(x)) ? Number(x) * idx : null);
  const usdCell = (btc) => (usd(btc) != null ? usd(btc).toFixed(2) : 'n/a');

  const fills = await fetchInstrumentTradesWindow(token, currency, startMs, execSym);

  let sumPl = 0;
  let sumFee = 0;
  let rebateBtc = 0;
  let takerPaidBtc = 0;
  const winsEcon = [];
  const lossesEcon = [];
  const winsPl = [];
  const lossesPl = [];
  let nClose = 0;
  let nOpenStyle = 0;

  for (const f of fills) {
    const pl = Number(f.profit_loss) || 0;
    const fee = Number(f.fee) || 0;
    sumPl += pl;
    sumFee += fee;
    if (fee < 0) rebateBtc += -fee;
    else if (fee > 0) takerPaidBtc += fee;

    if (pl !== 0) {
      nClose++;
      const econ = pl + fee;
      if (econ > 0) winsEcon.push(econ);
      else if (econ < 0) lossesEcon.push(econ);
      if (pl > 0) winsPl.push(pl);
      else if (pl < 0) lossesPl.push(pl);
    } else {
      nOpenStyle++;
    }
  }

  const netBtc = sumPl + sumFee;
  const plMinusNegRebate = sumPl + rebateBtc;
  const wE = winsEcon.length;
  const lE = lossesEcon.length;
  const ratioE = lE > 0 ? wE / lE : wE > 0 ? Infinity : null;
  const avgWinE = wE ? winsEcon.reduce((s, x) => s + x, 0) / wE : null;
  const avgLossE = lE ? lossesEcon.reduce((s, x) => s + x, 0) / lE : null;

  const wP = winsPl.length;
  const lP = lossesPl.length;
  const ratioP = lP > 0 ? wP / lP : wP > 0 ? Infinity : null;
  const avgWinP = wP ? winsPl.reduce((s, x) => s + x, 0) / wP : null;
  const avgLossP = lP ? lossesPl.reduce((s, x) => s + x, 0) / lP : null;

  const lines = [];
  const L = (s) => {
    lines.push(s);
    console.log(s);
  };

  const ratioEStr =
    ratioE != null && Number.isFinite(ratioE) ? ratioE.toFixed(6) : ratioE === Infinity ? 'inf' : 'n/a';

  if (!verbose) {
    L(`pairId=${pairId}  ${execSym}  ${acctName}`);
    L(`window: ${windowLabel}`);
    L('source: get_user_trades_by_currency_and_time (instrument only; no position UPL / no DB)');
    L(`index ${currency}/USD: $${idx ? idx.toFixed(2) : 'n/a'}`);
    L('');
    L(`realized_mark_pnl_sum_profit_loss_btc: ${sumPl.toFixed(8)}`);
    L(`realized_mark_pnl_usd:                   $${usdCell(sumPl)}`);
    L(`mark_pnl_minus_neg_rebate_pl_plus_rebate_btc: ${plMinusNegRebate.toFixed(8)}`);
    L(`mark_pnl_minus_neg_rebate_usd:             $${usdCell(plMinusNegRebate)}`);
    L(`maker_rebates_to_wallet_btc:             ${rebateBtc.toFixed(8)}`);
    L(`maker_rebates_usd:                       $${usdCell(rebateBtc)}`);
    L(`taker_fees_paid_btc:                     ${takerPaidBtc.toFixed(8)}`);
    L(`wallet_on_fills_sum_pl_plus_fee_btc:     ${netBtc.toFixed(8)}`);
    L(`wallet_on_fills_usd:                     $${usdCell(netBtc)}`);
    L('');
    L(`closing_fills_profit_loss_nonzero:       ${nClose}`);
    L(`wins_pl_plus_fee_gt_0:                   ${wE}`);
    L(`losses_pl_plus_fee_lt_0:                 ${lE}`);
    L(`win_loss_ratio:                          ${ratioEStr}`);
    L('');
    L(`avg_win_per_closing_slice_btc:           ${avgWinE != null ? avgWinE.toFixed(8) : 'n/a'}`);
    L(`avg_win_per_closing_slice_usd:           ${avgWinE != null ? '$' + usdCell(avgWinE) : 'n/a'}`);
    L(`avg_loss_per_closing_slice_btc:          ${avgLossE != null ? avgLossE.toFixed(8) : 'n/a'}`);
    L(`avg_loss_per_closing_slice_usd:          ${avgLossE != null ? '$' + usdCell(avgLossE) : 'n/a'}`);
  } else {
    L('================================================================================');
    L('BTC · EXCHANGE FILLS ONLY (no open-position PnL / no UPL / no DB)');
    L(`pairId=${pairId}  ${pair.agentName || ''}  account=${acctName}`);
    L(`instrument: ${execSym}  currency: ${currency}`);
    L(`window: ${windowLabel}`);
    L('source: private/get_user_trades_by_currency_and_time (rows filtered to instrument above)');
    L('================================================================================');
    L('');
    L('“Round-trip” realized on the exchange = sum of fill profit_loss (mark PnL booked on');
    L('each fill). Resting position unrealized PnL is NOT used. Rebates are the fee field');
    L('when negative; wallet effect on fills = profit_loss + fee.');
    L('');

    emitAsciiTable(
      L,
      [
        { h: 'metric', w: 58 },
        { h: `BTC`, w: 16, align: 'r' },
        { h: '~USD', w: 16, align: 'r' },
      ],
      [
        [
          'Realized mark PnL (Σ profit_loss on fills)',
          sumPl.toFixed(8),
          usdCell(sumPl),
        ],
        ['Maker rebates credited to wallet (Σ −fee where fee<0)', rebateBtc.toFixed(8), usdCell(rebateBtc)],
        ['mark PnL − (−rebate) = pl + rebate+', plMinusNegRebate.toFixed(8), usdCell(plMinusNegRebate)],
        ['Taker fees paid (Σ fee where fee>0)', takerPaidBtc.toFixed(8), usdCell(takerPaidBtc)],
        ['Wallet on fills (Σ profit_loss + Σ fee)', netBtc.toFixed(8), usdCell(netBtc)],
      ]
    );
    L('');

    emitAsciiTable(
      L,
      [
        { h: 'stat', w: 56 },
        { h: 'value', w: 22 },
      ],
      [
        ['Total fills in window', String(fills.length)],
        ['Closing fills (profit_loss≠0)', String(nClose)],
        ['Opens / no mark slice (profit_loss=0)', String(nOpenStyle)],
        [
          'W/L ratio (closes, pl+fee >0 vs <0)',
          ratioE != null && Number.isFinite(ratioE)
            ? ratioE.toFixed(6)
            : ratioE === Infinity
              ? 'inf'
              : 'n/a',
        ],
        [
          'W/L ratio (closes, profit_loss only)',
          ratioP != null && Number.isFinite(ratioP)
            ? ratioP.toFixed(6)
            : ratioP === Infinity
              ? 'inf'
              : 'n/a',
        ],
      ]
    );
    L('');

    L('--- Per-slice amounts (exchange, closing fills only: profit_loss≠0) ---');
    emitAsciiTable(
      L,
      [
        { h: 'basis', w: 42 },
        { h: 'wins', w: 6, align: 'r' },
        { h: 'losses', w: 7, align: 'r' },
        { h: `avg win ${currency}`, w: 16, align: 'r' },
        { h: '~USD', w: 12, align: 'r' },
        { h: `avg loss ${currency}`, w: 16, align: 'r' },
        { h: '~USD', w: 12, align: 'r' },
      ],
      [
        [
          'profit_loss + fee (wallet per slice)',
          String(wE),
          String(lE),
          avgWinE != null ? avgWinE.toFixed(8) : 'n/a',
          avgWinE != null ? usdCell(avgWinE) : 'n/a',
          avgLossE != null ? avgLossE.toFixed(8) : 'n/a',
          avgLossE != null ? usdCell(avgLossE) : 'n/a',
        ],
        [
          'profit_loss only (mark per slice)',
          String(wP),
          String(lP),
          avgWinP != null ? avgWinP.toFixed(8) : 'n/a',
          avgWinP != null ? usdCell(avgWinP) : 'n/a',
          avgLossP != null ? avgLossP.toFixed(8) : 'n/a',
          avgLossP != null ? usdCell(avgLossP) : 'n/a',
        ],
      ]
    );
    L('');

    L('Notes:');
    L('  • Not strategy “round trips”; exchange reports one profit_loss per fill when');
    L('    size reduces (partial closes count as separate slices).');
    L('  • Breakeven closing slices (pl+fee=0 exactly) are excluded from win/loss counts.');
    L(`  • Index ${currency}/USD for ~USD column: $${idx ? idx.toFixed(2) : 'n/a'}`);
    L('================================================================================');
  }

  if (noFile) {
    console.log('\n(--no-file: report printed above only; no file written.)');
  } else {
    const outDir = path.join(__dirname, '..', 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = sinceUtcYesterday ? 'since_utc_yesterday' : `last${hours}h`;
    const outPath = path.join(outDir, `btc_exchange_last24h_fills_only_${pairId}_${slug}_${ts}.txt`);
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log('\nWrote', outPath);
  }

  await sequelize.close();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
