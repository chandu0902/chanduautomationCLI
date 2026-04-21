/**
 * Current running bot(s): DB analytics + live Deribit (account, positions, open orders, recent fills).
 *
 *   node report_current_bot_exchange_analytics.js
 *   node report_current_bot_exchange_analytics.js --pairId=6
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { sequelize, StatArbInput, Trade, BasisPosition, AccountDetails } = require('./src/models');

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

function decryptText(keyBase64, encryptedText, ivBase64) {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = Buffer.from(ivBase64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return decipher.update(encryptedText, 'base64', 'utf8') + decipher.final('utf8');
}

async function getCreds(tradeAccount) {
  const acc = await AccountDetails.findOne({ where: { Trade_Account: tradeAccount } });
  if (!acc?.Api_Key || !acc?.Secret_Key) return null;
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  return {
    apiKey: decryptText(ak2, ak1, ak0),
    secretKey: decryptText(sk2, sk1, sk0),
  };
}

async function deribitAuth(clientId, clientSecret) {
  const r = await axios.get('https://www.deribit.com/api/v2/public/auth', {
    params: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
  });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result.access_token;
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

function parsePairId() {
  const a = process.argv.find((x) => x.startsWith('--pairId='));
  if (!a) return null;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) ? n : null;
}

function notionalUsdDeribit(price, qtyUsd) {
  return Math.abs(Number(qtyUsd) || 0);
}

function dbTradeAnalytics(trades) {
  const filled = trades.filter((t) => t.status === 'filled');
  const byStatus = {};
  for (const t of trades) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  let sumLeg = 0;
  let sumComm = 0;
  let sumTaker = 0;
  let volUsd = 0;
  for (const t of filled) {
    sumLeg += (Number(t.legA_pnl) || 0) + (Number(t.legB_pnl) || 0);
    if (t.commission != null) sumComm += Number(t.commission);
    if (t.takerFeeUsd != null) sumTaker += Number(t.takerFeeUsd);
    if (t.legA_filledAt && t.legA_qty != null) volUsd += notionalUsdDeribit(t.legA_price, t.legA_qty);
  }
  const cancelBy = {};
  for (const t of trades) {
    if (t.status === 'cancelled' && t.cancelReason) {
      cancelBy[t.cancelReason] = (cancelBy[t.cancelReason] || 0) + 1;
    }
  }
  return {
    totalRows: trades.length,
    byStatus,
    filledCount: filled.length,
    sumLeg,
    sumComm,
    sumTaker,
    netDb: sumLeg + sumComm - sumTaker,
    volUsd,
    entryN: filled.filter((t) => t.side === 'entry').length,
    exitN: filled.filter((t) => t.side === 'exit').length,
    cancelBy,
  };
}

function dbBasisAnalytics(bp) {
  const closed = bp.filter((p) => p.state === 'closed');
  const openish = bp.filter((p) => ['open', 'pending_entry', 'pending_exit'].includes(p.state));
  const failed = bp.filter((p) => p.state === 'failed');
  let sumGross = 0;
  let sumNet = 0;
  const byExit = {};
  for (const p of closed) {
    sumGross += Number(p.grossPnl || 0);
    sumNet += Number(p.netPnl || 0);
    const r = p.exitReason || '(null)';
    byExit[r] = (byExit[r] || 0) + 1;
  }
  const profitN = closed.filter((p) => p.exitReason === 'profit').length;
  const stopN = closed.filter((p) => p.exitReason === 'stop').length;
  const netProfits = closed.filter((p) => p.exitReason === 'profit').map((p) => Number(p.netPnl || 0));
  const netStops = closed.filter((p) => p.exitReason === 'stop').map((p) => Number(p.netPnl || 0));
  const holds = closed
    .map((p) => {
      if (p.holdMs != null && p.holdMs > 0) return Number(p.holdMs);
      if (p.entryTime && p.exitTime) {
        const ms = new Date(p.exitTime).getTime() - new Date(p.entryTime).getTime();
        return Number.isFinite(ms) && ms > 0 ? ms : null;
      }
      return null;
    })
    .filter((x) => x != null);
  return {
    total: bp.length,
    closed: closed.length,
    openishCount: openish.length,
    failed: failed.length,
    sumGross,
    sumNet,
    byExit,
    profitN,
    stopN,
    winRatePct: profitN + stopN > 0 ? (100 * profitN) / (profitN + stopN) : null,
    meanNetProfit: netProfits.length ? mean(netProfits) : null,
    meanNetStop: netStops.length ? mean(netStops) : null,
    holdMedianMs: holds.length ? median(holds) : null,
    holdMeanMs: holds.length ? mean(holds) : null,
    openishRows: openish,
  };
}

async function fetchPairExchange(pair, token, refPx) {
  const syms = [...new Set([pair.symbol1, pair.symbol2].filter(Boolean))];
  const out = {
    syms,
    positionsAll: [],
    positionsRelevant: [],
    openOrders: [],
    userTradesFiltered: [],
    userTradesAnalytics: null,
  };

  const pos = await deribitPrivate('get_positions', { currency: 'BTC' }, token);
  out.positionsAll = Array.isArray(pos) ? pos : [];

  const symSet = new Set(syms);
  out.positionsRelevant = out.positionsAll.filter((p) => symSet.has(p.instrument_name) && p.size !== 0);

  for (const sym of syms) {
    try {
      const oo = await deribitPrivate(
        'get_open_orders_by_instrument',
        { instrument_name: sym },
        token
      );
      const list = Array.isArray(oo) ? oo : [];
      for (const o of list) {
        out.openOrders.push({
          instrument_name: sym,
          order_id: o.order_id,
          direction: o.direction,
          amount: o.amount,
          price: o.price,
          order_state: o.order_state,
        });
      }
    } catch (e) {
      out.openOrders.push({ instrument_name: sym, error: e.message });
    }
  }

  const startMs = Date.now() - 7 * 86400000;
  try {
    const ut = await deribitPrivate(
      'get_user_trades_by_currency',
      {
        currency: 'BTC',
        kind: 'any',
        start_timestamp: startMs,
        count: 500,
        sorting: 'desc',
      },
      token
    );
    const trades = Array.isArray(ut) ? ut : ut?.trades || [];
    out.userTradesFiltered = trades.filter((t) => symSet.has(t.instrument_name));
    let feeBtc = 0;
    let volUsd = 0;
    let n = 0;
    for (const t of out.userTradesFiltered) {
      n++;
      const fee = Number(t.fee || 0);
      feeBtc += fee;
      const px = Number(t.price || 0);
      const amt = Math.abs(Number(t.amount || 0));
      if (px > 0) volUsd += amt;
    }
    const feeUsdEst = refPx > 0 ? Math.abs(feeBtc) * refPx : null;
    out.userTradesAnalytics = {
      windowDays: 7,
      countInWindow: n,
      sumFeeBtc: feeBtc,
      feeUsdEst,
      volumeUsdApprox: volUsd,
    };
  } catch (e) {
    out.userTradesAnalytics = { error: e.message };
  }

  return out;
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
  log('CURRENT BOT — EXCHANGE + DB ANALYTICS');
  log(`Generated: ${new Date().toISOString()}`);
  log('================================================================================');
  log('');

  if (active.length === 0) {
    log('No pair with status=active AND tradingEnabled=true.');
    log('Use: node report_current_bot_exchange_analytics.js --pairId=<id>');
    const outPath = path.join(__dirname, 'reports', `current_bot_exchange_analytics_${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    console.log('\nWrote', outPath);
    process.exit(0);
  }

  for (const pair of active) {
    const pid = pair.id;
    log('--------------------------------------------------------------------------------');
    log(`PAIR id=${pid}  ${pair.agentName}`);
    log('--------------------------------------------------------------------------------');
    log(`  tradeLeg: ${pair.tradeLeg}  executed: ${pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1}`);
    log(`  tradeAccountA: ${pair.tradeAccountA || '-'}`);
    log('');

    const trades = await Trade.findAll({ where: { pairId: pid } });
    const bp = await BasisPosition.findAll({ where: { pairId: pid } });
    const ta = dbTradeAnalytics(trades);
    const ba = dbBasisAnalytics(bp);

    log('=== DATABASE: trade_logs analytics ===');
    log(`  total rows: ${ta.totalRows}  byStatus: ${JSON.stringify(ta.byStatus)}`);
    log(`  filled: ${ta.filledCount}  entries: ${ta.entryN}  exits: ${ta.exitN}`);
    log(`  cancelled reasons: ${JSON.stringify(ta.cancelBy)}`);
    log(`  filled sum leg pnl: $${fmt(ta.sumLeg)}`);
    log(`  filled sum commission: $${fmt(ta.sumComm)}`);
    log(`  filled sum takerFeeUsd: $${fmt(ta.sumTaker)}`);
    log(`  filled net (legs+comm-taker): $${fmt(ta.netDb)}`);
    log(`  approx volume USD (legA qty sum, inverse-style): $${fmt(ta.volUsd, 2)}`);
    log('');

    log('=== DATABASE: basis_positions analytics ===');
    log(`  total: ${ba.total}  closed: ${ba.closed}  open/pending: ${ba.openishCount}  failed: ${ba.failed}`);
    log(`  closed exit mix: ${JSON.stringify(ba.byExit)}`);
    log(`  profit vs stop (closed): ${ba.profitN} / ${ba.stopN}  winRate~profit/(profit+stop): ${ba.winRatePct != null ? fmt(ba.winRatePct, 2) + '%' : '-'}`);
    log(`  mean net (profit exits): ${ba.meanNetProfit != null ? '$' + fmt(ba.meanNetProfit) : '-'}`);
    log(`  mean net (stop exits):   ${ba.meanNetStop != null ? '$' + fmt(ba.meanNetStop) : '-'}`);
    log(`  closed sum grossPnl: $${fmt(ba.sumGross)}  netPnl: $${fmt(ba.sumNet)}`);
    log(
      `  hold closed: median_ms=${ba.holdMedianMs != null ? fmt(ba.holdMedianMs, 0) : '-'} mean_ms=${ba.holdMeanMs != null ? fmt(ba.holdMeanMs, 0) : '-'}`
    );
    if (ba.openishRows.length) {
      log('  open/pending positions:');
      for (const p of ba.openishRows) {
        log(`    id=${p.id} state=${p.state} grid=${p.gridLevel} entrySpread=${p.entrySpread}`);
      }
    }
    log('');

    const acct = pair.tradeAccountA;
    log(`=== DERIBIT LIVE: account ${acct || '(missing)'} ===`);
    if (!acct) {
      log('  skip exchange (no tradeAccountA)');
      log('');
      continue;
    }

    try {
      const creds = await getCreds(acct);
      if (!creds) {
        log('  ERROR: credentials not found in AccountDetails');
        log('');
        continue;
      }
      const token = await deribitAuth(creds.apiKey, creds.secretKey);
      const summary = await deribitPrivate('get_account_summary', { currency: 'BTC' }, token);
      let refPx = Number(summary.index_price || summary.mark_price || 0);
      if (!refPx || refPx < 1000) {
        const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
          params: { index_name: 'btc_usd' },
        });
        refPx = Number(ix.data?.result?.index_price) || refPx;
      }

      const btc = (x) => (x != null && refPx > 0 ? Number(x) * refPx : null);

      log(`  equity (BTC): ${summary.equity}`);
      log(`  available_funds (BTC): ${summary.available_funds}`);
      log(`  session_upl / session_rpl (BTC): ${summary.session_upl} / ${summary.session_rpl}`);
      log(`  ref BTC/USD (index/mark): ${fmt(refPx, 2)}`);
      log(`  session_upl ~ USD: $${fmt(btc(summary.session_upl))}`);
      log(`  session_rpl ~ USD: $${fmt(btc(summary.session_rpl))}`);
      log(`  total_pl (BTC): ${summary.total_pl}`);

      const ex = await fetchPairExchange(pair, token, refPx);

      log('');
      log('=== DERIBIT: positions (pair symbols, non-zero) ===');
      if (ex.positionsRelevant.length === 0) {
        log('  (flat on BTC-29MAY26 / BTC-PERPETUAL or no match)');
      }
      let sumFloatUsd = 0;
      let sumAbsNotional = 0;
      for (const pp of ex.positionsRelevant) {
        let fu =
          pp.floating_profit_loss_usd != null
            ? Number(pp.floating_profit_loss_usd)
            : pp.floating_profit_loss != null && refPx
              ? Number(pp.floating_profit_loss) * refPx
              : null;
        if (fu != null) sumFloatUsd += fu;
        const nu = Math.abs(Number(pp.size || 0));
        sumAbsNotional += nu;
        log(
          `  ${pp.instrument_name} size=${pp.size} dir=${pp.direction} avg=${pp.average_price} ` +
            `upl_usd=${fu != null ? fmt(fu, 4) : '-'} initial_margin=${pp.initial_margin ?? '-'}`
        );
      }
      log(`  sum floating PnL USD (pair symbols): $${fmt(sumFloatUsd, 4)}`);
      log(`  sum |size| USD notional (API amount): $${fmt(sumAbsNotional, 2)}`);

      log('');
      log('=== DERIBIT: open orders (pair instruments) ===');
      log(`  count: ${ex.openOrders.filter((o) => !o.error).length}`);
      for (const o of ex.openOrders) {
        if (o.error) log(`  ${o.instrument_name} ERROR ${o.error}`);
        else log(`  ${o.instrument_name} ${o.direction} amt=${o.amount} px=${o.price} state=${o.order_state} id=${o.order_id}`);
      }

      log('');
      log('=== DERIBIT: user fills last 7d (pair instruments only) ===');
      if (ex.userTradesAnalytics?.error) {
        log(`  ERROR: ${ex.userTradesAnalytics.error}`);
      } else if (ex.userTradesAnalytics) {
        const u = ex.userTradesAnalytics;
        log(`  fills count: ${u.countInWindow}`);
        log(`  approx volume USD (sum |amount|): $${fmt(u.volumeUsdApprox, 2)}`);
        log(`  sum fee (BTC): ${fmt(u.sumFeeBtc, 8)}  ~fee USD: $${fmt(u.feeUsdEst)}`);
      }

      log('');
      log('=== CROSS-CHECK notes ===');
      log('  Session RPL/UPL are Deribit session windows, not DB roundtrip totals.');
      log('  DB net uses trade/basis logs; exchange fees in user_trades are raw fills.');
    } catch (e) {
      log(`  EXCHANGE ERROR: ${e.message}`);
    }
    log('');
  }

  log('================================================================================');
  log('END OF REPORT');
  log('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `current_bot_exchange_analytics_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
