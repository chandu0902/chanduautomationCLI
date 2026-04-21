/**
 * Shared Deribit DB vs exchange reconciliation block (used by BTC pair reports).
 */
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const { Trade, BasisPosition, AccountDetails } = require('../src/models');

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

async function fetchFillsExec(currency, token, startMs, instrumentName) {
  const all = [];
  let curStart = startMs;
  for (let page = 0; page < 80; page++) {
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        currency,
        start_timestamp: curStart,
        end_timestamp: Date.now(),
        count: 1000,
        sorting: 'asc',
      },
      timeout: 25000,
    });
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    for (const t of trades) {
      if (t.instrument_name === instrumentName) all.push(t);
    }
    if (!res.has_more) break;
    curStart = trades[trades.length - 1].timestamp + 1;
    await new Promise((x) => setTimeout(x, 300));
  }
  return all;
}

function currencyFromSymbol(sym) {
  const s = (sym || '').toUpperCase();
  if (s.startsWith('ETH')) return 'ETH';
  if (s.includes('USDC')) return 'USDC';
  return 'BTC';
}

/** Push monospace +---+ ASCII table rows onto `out` (array of strings). colDefs: { h, w, align? 'l'|'r' }. */
function asciiTablePush(out, colDefs, rows) {
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
  out.push(sep());
  out.push(line(colDefs.map((c) => c.h)));
  out.push(sep());
  for (const r of rows) out.push(line(r));
  out.push(sep());
}

async function resolveStartMs(pairId, opts) {
  if (opts.since) {
    const x = Date.parse(opts.since);
    if (!Number.isNaN(x)) return { startMs: x, label: `since ${opts.since}` };
  }
  if (opts.hours != null && Number.isFinite(opts.hours)) {
    return {
      startMs: Date.now() - opts.hours * 3600000,
      label: `last ${opts.hours} hours`,
    };
  }
  const tMin = await Trade.min('createdAt', { where: { pairId } });
  const bpMin = await BasisPosition.min('entryTime', { where: { pairId } });
  const times = [tMin, bpMin]
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((n) => !Number.isNaN(n));
  if (!times.length) {
    return {
      startMs: Date.now() - 7 * 86400000,
      label: 'default 7d (no prior trades)',
    };
  }
  const oldest = Math.min(...times);
  const cap90d = Date.now() - 90 * 86400000;
  const startMs = Math.max(oldest, cap90d);
  return {
    startMs,
    label: 'from earliest pair activity (capped at 90d) / per-pair min',
  };
}

async function appendExchangeReconcile(lines, pair, startMs, windowLabel) {
  const pid = pair.id;
  const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const sinceDate = new Date(startMs);

  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    lines.push('');
    lines.push('--- EXCHANGE RECONCILE (skipped) ---');
    lines.push(`  Account not found: ${acctName}`);
    return;
  }
  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const apiKey = decryptText(ak2, ak1, ak0);
  const secret = decryptText(sk2, sk1, sk0);
  const token = await getToken(apiKey, secret);

  const ix = await axios
    .get('https://www.deribit.com/api/v2/public/get_index_price', {
      params: { index_name: `${currency.toLowerCase()}_usd` },
    })
    .catch(() => ({ data: {} }));
  const idx = Number(ix.data?.result?.index_price) || 0;

  const closedAll = await BasisPosition.findAll({
    where: { pairId: pid, state: 'closed' },
    order: [['exitTime', 'ASC']],
  });
  const closedWin = closedAll.filter((p) => p.exitTime && new Date(p.exitTime) >= sinceDate);

  let dbNet = 0;
  let dbGross = 0;
  let dbComm = 0;
  let dbTaker = 0;
  let dbProfitN = 0;
  for (const p of closedWin) {
    dbNet += Number(p.netPnl) || 0;
    dbGross += Number(p.grossPnl) || 0;
    dbComm += Number(p.commission) || 0;
    dbTaker += Number(p.takerFeeUsd) || 0;
    if (Number(p.netPnl) > 0) dbProfitN++;
  }

  const exits = await Trade.findAll({
    where: {
      pairId: pid,
      status: 'filled',
      side: 'exit',
      [Op.or]: [{ legA_filledAt: { [Op.gte]: sinceDate } }, { legB_filledAt: { [Op.gte]: sinceDate } }],
    },
    order: [['id', 'ASC']],
  });
  let dbExitLegSum = 0;
  let dbExitComm = 0;
  let dbExitTaker = 0;
  let dbExitVolUsd = 0;
  let dbExitPnlRow = 0;
  for (const t of exits) {
    dbExitLegSum += (Number(t.legA_pnl) || 0) + (Number(t.legB_pnl) || 0);
    dbExitComm += Number(t.commission) || 0;
    dbExitTaker += Number(t.takerFeeUsd) || 0;
    dbExitVolUsd += Math.abs(Number(t.legA_qty) || 0);
    dbExitPnlRow += Number(t.pnl) || 0;
  }

  const fills = await fetchFillsExec(currency, token, startMs, execSym);
  let exVol = 0;
  let exPl = 0;
  let exFee = 0;
  let exRebate = 0;
  let exPaid = 0;
  let exCloseN = 0;
  for (const f of fills) {
    exVol += Math.abs(Number(f.amount) || 0);
    exPl += Number(f.profit_loss) || 0;
    const fee = Number(f.fee) || 0;
    exFee += fee;
    if (fee < 0) exRebate += -fee;
    else if (fee > 0) exPaid += fee;
    if (Number(f.profit_loss) !== 0) exCloseN++;
  }
  const exNetBtc = exPl + exFee;
  const exPlMinusNegRebateBtc = exPl + exRebate;
  const exNetUsd = idx ? exNetBtc * idx : null;
  const exPlUsd = idx ? exPl * idx : null;
  const exPlMinusNegRebateUsd = idx ? exPlMinusNegRebateBtc * idx : null;
  const dbNetVsExUsd = idx ? dbNet - exNetUsd : null;

  const log = (s) => lines.push(s);
  log('');
  log('================================================================================');
  log('DB vs EXCHANGE RECONCILIATION (Deribit)');
  log('================================================================================');
  asciiTablePush(lines, [
    { h: 'field', w: 28 },
    { h: 'value', w: 86 },
  ], [
    ['Window', windowLabel],
    ['UTC', `${sinceDate.toISOString()} → now`],
    ['Pair id / agent', `${pid}  ${pair.agentName || ''}`],
    ['Executed instrument (EX filter)', execSym],
    ['Index USD', idx ? idx.toFixed(2) : 'n/a'],
  ]);
  log('');
  log('DATABASE (basis_positions, exitTime in window)');
  asciiTablePush(lines, [
    { h: 'metric', w: 44 },
    { h: 'value', w: 28 },
  ], [
    ['Closed round trips', String(closedWin.length)],
    ['Profitable (netPnl > 0)', String(dbProfitN)],
    ['Sum netPnl (USD)', `$${dbNet.toFixed(4)}`],
    ['Sum grossPnl (USD)', `$${dbGross.toFixed(4)}`],
    ['Sum commission (rebate model)', `$${dbComm.toFixed(4)}`],
    ['Sum takerFeeUsd (USD)', `$${dbTaker.toFixed(4)}`],
  ]);
  log('');
  log('DATABASE (trade_logs, filled exits, leg fill time in window)');
  asciiTablePush(lines, [
    { h: 'metric', w: 44 },
    { h: 'value', w: 28 },
  ], [
    ['Exit rows', String(exits.length)],
    ['Sum legA_pnl+legB_pnl (USD)', `$${dbExitLegSum.toFixed(4)}`],
    ['Sum pnl column (USD)', `$${dbExitPnlRow.toFixed(4)}`],
    ['Sum commission on exits', `$${dbExitComm.toFixed(4)}`],
    ['Sum |legA_qty| notional (USD)', `$${dbExitVolUsd.toFixed(2)}`],
  ]);
  log('');
  log(`EXCHANGE (Deribit fills, ${execSym} only)`);
  asciiTablePush(lines, [
    { h: 'metric', w: 44 },
    { h: 'value', w: 36 },
  ], [
    ['Fill count', String(fills.length)],
    ['Closing slices (profit_loss≠0)', String(exCloseN)],
    ['Volume sum |amount| (USD)', `$${exVol.toFixed(2)}`],
    [
      'Wallet on fills (BTC)',
      `${exNetBtc.toFixed(8)}  (~$${exNetUsd != null ? exNetUsd.toFixed(4) : 'n/a'})  pl+fee`,
    ],
    [
      'pl − rebate(+wallet) + taker (BTC)',
      `${exPl.toFixed(8)} − ${exRebate.toFixed(8)} + ${exPaid.toFixed(8)} = ${exNetBtc.toFixed(8)}`,
    ],
    [
      'mark PnL − (−rebate) = pl + rebate+ (BTC)',
      `${exPlMinusNegRebateBtc.toFixed(8)}  (~$${exPlMinusNegRebateUsd != null ? exPlMinusNegRebateUsd.toFixed(4) : 'n/a'})`,
    ],
    ['Sum profit_loss (BTC, price-only)', `${exPl.toFixed(8)}  (~$${exPlUsd != null ? exPlUsd.toFixed(4) : 'n/a'})`],
    ['Sum fee (BTC)', `${exFee.toFixed(8)}  (= −rebates + taker)`],
    ['Maker rebates to wallet (BTC,+)', `${exRebate.toFixed(8)}  (~$${idx ? (exRebate * idx).toFixed(4) : 'n/a'})`],
    ['Taker paid fee (BTC)', exPaid.toFixed(8)],
  ]);
  log('');
  log('COMPARISON (same window, different definitions)');
  const cmpRows = [
    ['Round trips (DB) vs fills (EX)', `${closedWin.length} vs ${fills.length}`],
    [
      'DB sum netPnl vs EX wallet (USD)',
      `$${dbNet.toFixed(4)} vs $${exNetUsd != null ? exNetUsd.toFixed(4) : 'n/a'}`,
    ],
    ['DB exit notional vs EX volume (USD)', `$${dbExitVolUsd.toFixed(2)} vs $${exVol.toFixed(2)}`],
    [
      'DB basis commission vs EX rebate (USD)',
      `$${dbComm.toFixed(4)} vs ~$${idx ? (exRebate * idx).toFixed(4) : 'n/a'}`,
    ],
  ];
  if (dbNetVsExUsd != null) {
    cmpRows.splice(2, 0, ['Delta (DB netPnl − EX wallet USD)', `$${dbNetVsExUsd.toFixed(4)}`]);
  }
  asciiTablePush(lines, [
    { h: 'metric', w: 44 },
    { h: 'value', w: 36 },
  ], cmpRows);
  log('');
  log(
    'Notes: DB uses strategy model USD; EX wallet on fills = profit_loss+fee. mark PnL−(−rebate)=pl+rebate+ (not wallet if taker≠0). '
  );
  log('EX volume counts every fill; DB exit notional is once per closed round trip.');
}

async function deribitPrivate(method, params, token) {
  const r = await axios.post(
    `https://www.deribit.com/api/v2/private/${method}`,
    { jsonrpc: '2.0', id: 1, method: `private/${method}`, params: params || {} },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
  );
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

/**
 * Live Deribit account snapshot for the pair's trade account.
 *
 * @param {object} opts Optional: { startMs, execSymbol } — if set, sums fills on that instrument
 *   from startMs (same window as reconcile) for maker rebates / fees on the executed leg.
 */
async function appendDeribitAccountSummary(lines, pair, opts = {}) {
  const acctName = pair.tradeAccountA || pair.tradeAccountB;
  const currency = currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const log = (s) => lines.push(s);
  const startMs = opts.startMs != null && Number.isFinite(opts.startMs) ? opts.startMs : null;
  const execSymbol =
    opts.execSymbol || (pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1);

  log('');
  log('================================================================================');
  log('DERIBIT ACCOUNT SUMMARY (live)');
  log(`Pair id=${pair.id}  account=${acctName || '(none)'}`);
  log('================================================================================');

  if (!acctName) {
    log('  (skipped — no tradeAccountA/B)');
    return null;
  }

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct?.Api_Key) {
    log(`  (skipped — AccountDetails missing for ${acctName})`);
    return null;
  }

  try {
    const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
    const apiKey = decryptText(ak2, ak1, ak0);
    const secret = decryptText(sk2, sk1, sk0);
    const token = await getToken(apiKey, secret);

    const ix = await axios
      .get('https://www.deribit.com/api/v2/public/get_index_price', {
        params: { index_name: `${currency.toLowerCase()}_usd` },
      })
      .catch(() => ({ data: {} }));
    const idx = Number(ix.data?.result?.index_price) || 0;

    const summary = await deribitPrivate('get_account_summary', { currency, extended: true }, token);
    const usd = (x) => {
      const n = Number(x);
      if (!Number.isFinite(n) || idx <= 0) return null;
      return n * idx;
    };

    const equity = Number(summary.equity) || 0;
    const balanceNum = Number(summary.balance);
    const sessionUpl = Number(summary.session_upl) || 0;
    const sessionRpl = Number(summary.session_rpl) || 0;
    const sessionTotalPl = sessionUpl + sessionRpl;
    const impliedEquitySessionStart = equity - sessionUpl - sessionRpl;
    const impliedBalanceSessionStart =
      Number.isFinite(balanceNum) ? balanceNum - sessionRpl : null;
    const totalPl = Number(summary.total_pl);

    log(`  currency:               ${currency}`);
    log(`  index_price (ref USD):  ${idx ? idx.toFixed(2) : 'n/a'}`);
    log('');
    log('--- Current balances (exchange) ---');
    log(`  equity (incl. UPL, ${currency}):   ${summary.equity}`);
    log(`  balance (wallet, ${currency}):     ${summary.balance ?? '-'}`);
    log(`  available_funds (${currency}):    ${summary.available_funds ?? '-'}`);
    if (summary.margin_balance != null) log(`  margin_balance (${currency}):     ${summary.margin_balance}`);
    log(`  equity ~ USD @ index:             $${usd(summary.equity) != null ? usd(summary.equity).toFixed(4) : 'n/a'}`);
    log(`  balance ~ USD @ index:           $${usd(summary.balance) != null ? usd(summary.balance).toFixed(4) : 'n/a'}`);
    log('');
    log('--- Implied exchange values at Deribit session start ---');
    log('  (Deribit "session" resets on their clock, often ~00:00 UTC; not the same as bot_session_logs.)');
    log(
      `  implied equity at session start (${currency}): ${impliedEquitySessionStart.toFixed(8)} (= equity − session_upl − session_rpl)`
    );
    log(
      `  implied equity at session start ~ USD:        $${usd(impliedEquitySessionStart) != null ? usd(impliedEquitySessionStart).toFixed(4) : 'n/a'}`
    );
    if (impliedBalanceSessionStart != null && Number.isFinite(impliedBalanceSessionStart) && Number.isFinite(balanceNum)) {
      log(
        `  implied wallet at session start (${currency}): ${impliedBalanceSessionStart.toFixed(8)} (= balance − session_rpl, ignores transfers)`
      );
      log(
        `  implied wallet at session start ~ USD:        $${usd(impliedBalanceSessionStart) != null ? usd(impliedBalanceSessionStart).toFixed(4) : 'n/a'}`
      );
    }
    log('');
    log('--- Session PnL (this Deribit session) ---');
    log(`  unrealized (session_upl, ${currency}): ${summary.session_upl}`);
    log(`  realized (session_rpl, ${currency}):   ${summary.session_rpl}`);
    log(`  session total (upl+rpl, ${currency}):   ${sessionTotalPl.toFixed(8)}`);
    log(`  unrealized ~ USD:                      $${usd(summary.session_upl) != null ? usd(summary.session_upl).toFixed(4) : 'n/a'}`);
    log(`  realized ~ USD:                        $${usd(summary.session_rpl) != null ? usd(summary.session_rpl).toFixed(4) : 'n/a'}`);
    log(`  session total ~ USD:                   $${usd(sessionTotalPl) != null ? usd(sessionTotalPl).toFixed(4) : 'n/a'}`);
    log('');
    log('--- All-time account total_pl (Deribit) ---');
    log(`  total_pl (${currency}): ${summary.total_pl}`);
    log(`  total_pl ~ USD:         $${usd(totalPl) != null ? usd(totalPl).toFixed(4) : 'n/a'}`);
    if (summary.futures_session_upl != null || summary.futures_session_rpl != null) {
      log(
        `  futures session_upl / session_rpl (${currency}): ${summary.futures_session_upl ?? '-'} / ${summary.futures_session_rpl ?? '-'}`
      );
    }
    if (summary.options_session_upl != null || summary.options_session_rpl != null) {
      log(
        `  options session_upl / session_rpl (${currency}): ${summary.options_session_upl ?? '-'} / ${summary.options_session_rpl ?? '-'}`
      );
    }
    log('');
    log('  For bot-attributed session startBalance (DB snapshot when trading enabled), see BOT SESSION LOGS above.');

    if (startMs != null && execSymbol) {
      const fills = await fetchFillsExec(currency, token, startMs, execSymbol);
      let exPl = 0;
      let exFee = 0;
      let exRebate = 0;
      let exPaid = 0;
      let exVol = 0;
      for (const f of fills) {
        exVol += Math.abs(Number(f.amount) || 0);
        exPl += Number(f.profit_loss) || 0;
        const fee = Number(f.fee) || 0;
        exFee += fee;
        if (fee < 0) exRebate += -fee;
        else if (fee > 0) exPaid += fee;
      }
      log('');
      log('--- Executed instrument fills (same window as DB reconcile below) ---');
      log(`  instrument: ${execSymbol}`);
      log(`  window UTC: ${new Date(startMs).toISOString()} → now`);
      const exNet = exPl + exFee;
      log(`  fill count: ${fills.length}`);
      log(
        `  wallet on fills (${currency}): ${exNet.toFixed(8)}  ≈ $${usd(exNet) != null ? usd(exNet).toFixed(4) : 'n/a'}  (sum profit_loss+fee)`
      );
      log(
        `  = pl − rebate(+wallet) + taker: ${exPl.toFixed(8)} − ${exRebate.toFixed(8)} + ${exPaid.toFixed(8)} = ${exNet.toFixed(8)}`
      );
      const plMinusNegRebate = exPl + exRebate;
      log(
        `  mark PnL − (−rebate) = pl + rebate+ (${currency}): ${plMinusNegRebate.toFixed(8)}  ≈ $${usd(plMinusNegRebate) != null ? usd(plMinusNegRebate).toFixed(4) : 'n/a'}`
      );
      log(`  sum profit_loss (${currency}, price-only): ${exPl.toFixed(8)}  ≈ $${usd(exPl) != null ? usd(exPl).toFixed(4) : 'n/a'}`);
      log(`  sum fee (${currency}): ${exFee.toFixed(8)} (= −rebates + taker)`);
      log(`  maker rebates to wallet (${currency}, +): ${exRebate.toFixed(8)}  ≈ $${usd(exRebate) != null ? usd(exRebate).toFixed(4) : 'n/a'}`);
      log(`  taker fees paid (${currency}):                      ${exPaid.toFixed(8)}`);
      log(`  volume sum |amount| (USD notional on inverse):      $${exVol.toFixed(2)}`);
    }

    return { summary, indexUsd: idx, currency };
  } catch (e) {
    log(`  ERROR: ${e.message || e}`);
    return null;
  }
}

module.exports = {
  resolveStartMs,
  appendExchangeReconcile,
  appendDeribitAccountSummary,
  currencyFromSymbol,
  asciiTablePush,
};
