/**
 * Analyze trades (DB + Deribit) for pairs that are active and trading-enabled.
 * Report is pair-wise: each pair gets its own full block (DB + exchange subset).
 * Writes a timestamped report under Backend/reports/
 *
 *   node analyze_running_bots_pnl.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const { StatArbInput, Trade, BasisPosition, AccountDetails, sequelize } = require('./src/models');

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
    { jsonrpc: '2.0', id: 1, method: `private/${method}`, params },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}

function fmt(n, d = 6) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}

function absUsd(n) {
  return Math.abs(Number(n) || 0);
}

function notionalUsd(exchange, price, qty) {
  return (exchange || '').toLowerCase() === 'deribit' ? qty : (price || 0) * (qty || 0);
}

function tradeStatsForList(tradeList) {
  const filled = tradeList.filter((t) => t.status === 'filled');
  let feesA = 0;
  let feesB = 0;
  let pnlLegs = 0;
  let exitExSum = 0;
  let exitExN = 0;
  let volUsd = 0;
  for (const t of filled) {
    if (t.commission != null) feesA += Number(t.commission);
    if (t.takerFeeUsd != null) feesB += Number(t.takerFeeUsd);
    if (t.legA_pnl != null) pnlLegs += Number(t.legA_pnl);
    if (t.legB_pnl != null) pnlLegs += Number(t.legB_pnl);
    if (t.side === 'exit' && t.exchangePnl != null) {
      exitExSum += Number(t.exchangePnl);
      exitExN++;
    }
    if (t.legA_filledAt && t.legA_price != null && t.legA_qty != null) {
      volUsd += notionalUsd(t.legA_exchange, t.legA_price, t.legA_qty);
    }
    if (t.legB_filledAt && (t.legB_qty || 0) > 0 && t.legB_price != null) {
      volUsd += notionalUsd(t.legB_exchange, t.legB_price, t.legB_qty);
    }
  }
  const byStatus = {};
  for (const t of tradeList) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  }
  return {
    totalRows: tradeList.length,
    filled,
    filledCount: filled.length,
    byStatus,
    feesA,
    feesB,
    pnlLegs,
    netDb: pnlLegs + feesA - feesB,
    exitExSum,
    exitExN,
    volUsd,
    entryN: filled.filter((t) => t.side === 'entry').length,
    exitN: filled.filter((t) => t.side === 'exit').length,
  };
}

function basisStatsForList(bpList) {
  const closed = bpList.filter((p) => p.state === 'closed');
  const openish = bpList.filter((p) => p.state !== 'closed' && p.state !== 'failed');
  const failed = bpList.filter((p) => p.state === 'failed');
  let sumGross = 0;
  let sumNet = 0;
  const byReason = {};
  for (const bp of closed) {
    sumGross += Number(bp.grossPnl || 0);
    sumNet += Number(bp.netPnl || 0);
    const r = bp.exitReason || '(null)';
    if (!byReason[r]) byReason[r] = { n: 0, net: 0 };
    byReason[r].n++;
    byReason[r].net += Number(bp.netPnl || 0);
  }
  return { closed, openish, failed, sumGross, sumNet, byReason };
}

function logPairConfig(log, p) {
  log(`  agentName:        ${p.agentName}`);
  log(`  status:           ${p.status}  tradingEnabled: ${!!p.tradingEnabled}`);
  log(`  leg A:            ${p.exchange1} / ${p.type1} / ${p.symbol1}`);
  log(`  leg B:            ${p.exchange2} / ${p.type2} / ${p.symbol2}`);
  log(`  tradeAccountA:    ${p.tradeAccountA || '-'}`);
  log(`  tradeAccountB:    ${p.tradeAccountB || '-'}`);
  log(`  qty1 / maxQty1:   ${p.qty1 ?? '-'} / ${p.maxQty1 ?? '-'}`);
  log(`  unilateralMode:   ${!!p.unilateralMode}  tradeLeg: ${p.tradeLeg || '-'}`);
  log(`  spreadEntryLevels:${p.spreadEntryLevels || '-'}`);
  log(`  maxSpreadCap:     ${p.maxSpreadCap ?? '-'}`);
  log(`  maxPositions:     ${p.maxPositions ?? '-'}`);
  log(`  tpSpreadDelta:    ${p.tpSpreadDelta ?? '-'}  slSpreadDelta: ${p.slSpreadDelta ?? '-'}`);
  log(`  zEntryThreshold:  ${p.zEntryThreshold ?? '-'}  zEntryMax: ${p.zEntryMax ?? '-'}`);
  log(`  entryPollTimeout: ${p.entryPollTimeoutMs ?? '-'} ms`);
}

function logExchangeSubset(log, pair, exchangeByAccount) {
  const syms = new Set([pair.symbol1, pair.symbol2].filter(Boolean));
  const accts = new Set([pair.tradeAccountA, pair.tradeAccountB].filter(Boolean));
  if (accts.size === 0) {
    log('  (no trade accounts on pair)');
    return;
  }
  for (const acctName of [...accts].sort()) {
    const snap = exchangeByAccount[acctName];
    if (!snap) {
      log(`  Account ${acctName}: (not fetched)`);
      continue;
    }
    if (snap.error) {
      log(`  Account ${acctName}: ERROR ${snap.error}`);
      continue;
    }
    const { refPx, pos } = snap;
    const nonZero = (pos || []).filter((pp) => pp.size !== 0);
    const relevant = nonZero.filter((pp) => syms.has(pp.instrument_name));
    log(`  Account: ${acctName}`);
    if (relevant.length === 0) {
      log('    No open position in this pair’s instruments (or flat).');
      continue;
    }
    let sumFloat = 0;
    for (const pp of relevant) {
      let fu =
        pp.floating_profit_loss_usd != null
          ? Number(pp.floating_profit_loss_usd)
          : pp.floating_profit_loss != null && refPx
            ? Number(pp.floating_profit_loss) * refPx
            : null;
      if (fu != null) sumFloat += fu;
      log(
        `    ${pp.instrument_name} size=${pp.size} dir=${pp.direction} avg=${pp.average_price} ` +
          `upl_usd=${fu != null ? fmt(fu, 4) : '-'}`
      );
    }
    log(`    Sum floating PnL USD (this pair’s symbols): $${fmt(sumFloat, 4)}`);
  }
}

async function fetchExchangeSnapshot(acctName) {
  const creds = await getCreds(acctName);
  if (!creds) return { error: 'credentials not found' };
  const token = await deribitAuth(creds.apiKey, creds.secretKey);
  const summary = await deribitPrivate('get_account_summary', { currency: 'BTC' }, token);
  const pos = await deribitPrivate('get_positions', { currency: 'BTC' }, token);
  let refPx = Number(summary.index_price || summary.mark_price || 0);
  if (!refPx || refPx < 1000) {
    try {
      const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
        params: { index_name: 'btc_usd' },
      });
      refPx = Number(ix.data?.result?.index_price) || refPx || 0;
    } catch (_) {
      /* keep */
    }
  }
  return { summary, pos, refPx };
}

async function main() {
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `running_bots_pnl_${ts}.txt`);

  await sequelize.authenticate();
  log(`Generated: ${new Date().toISOString()}`);
  log('');

  const activeTrading = await StatArbInput.findAll({
    where: { status: 'active', tradingEnabled: true },
    order: [['id', 'ASC']],
  });

  const activeOnly = await StatArbInput.findAll({
    where: { status: 'active' },
    order: [['id', 'ASC']],
  });

  if (activeTrading.length === 0) {
    log('No pairs with status=active AND tradingEnabled=true.');
    log(`Active (any trading flag) pairs: ${activeOnly.length}`);
    if (activeOnly.length === 0) {
      log('Nothing to analyze.');
      fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
      console.log(`\nWrote ${outPath}`);
      process.exit(0);
    }
    log('Using all active pairs for DB scope.');
  }

  const pairs = activeTrading.length ? activeTrading : activeOnly;
  const pairIds = pairs.map((p) => p.id);

  log('=== SCOPE ===');
  log(`  Pair IDs: ${pairIds.join(', ')}`);
  log('');

  const trades = await Trade.findAll({
    where: { pairId: { [Op.in]: pairIds } },
    order: [['createdAt', 'ASC']],
  });

  const positions = await BasisPosition.findAll({ where: { pairId: { [Op.in]: pairIds } } });

  const accounts = new Set();
  for (const p of pairs) {
    if (p.tradeAccountA) accounts.add(p.tradeAccountA);
    if (p.tradeAccountB) accounts.add(p.tradeAccountB);
  }

  const exchangeByAccount = {};
  for (const acctName of [...accounts].sort()) {
    try {
      exchangeByAccount[acctName] = await fetchExchangeSnapshot(acctName);
    } catch (e) {
      exchangeByAccount[acctName] = { error: e.message };
    }
  }

  log('================================================================================');
  log('  PAIR-WISE REPORT (each pair: config, DB trades, DB basis positions, exchange)');
  log('================================================================================');
  log('');

  for (const p of pairs) {
    const tList = trades.filter((t) => t.pairId === p.id);
    const bpList = positions.filter((bp) => bp.pairId === p.id);
    const ts_ = tradeStatsForList(tList);
    const bs = basisStatsForList(bpList);

    log('');
    log('################################################################################');
    log(`# PAIR id=${p.id}`);
    log('################################################################################');
    log('');
    log('-- Configuration --');
    logPairConfig(log, p);
    log('');

    log('-- Database: trade_logs --');
    log(`  Total rows: ${ts_.totalRows}`);
    log(`  By status: ${JSON.stringify(ts_.byStatus)}`);
    log(`  Filled: ${ts_.filledCount} (entry=${ts_.entryN}, exit=${ts_.exitN})`);
    log(`  Volume USD (sum leg notionals on filled): $${fmt(ts_.volUsd, 4)}`);
    log(`  Sum legA_pnl + legB_pnl (filled): $${fmt(ts_.pnlLegs)}`);
    log(`  Sum commission (raw): $${fmt(ts_.feesA)}`);
    log(`  Maker rebate (|commission| display): +$${fmt(absUsd(ts_.feesA))}`);
    log(`  Sum takerFeeUsd: $${fmt(ts_.feesB)}`);
    log(`  Net PnL (legs + commission - taker): $${fmt(ts_.netDb)}`);
    log(`  Exit rows w/ exchangePnl: ${ts_.exitExN} sum=$${fmt(ts_.exitExSum)}`);
    log('');

    log('-- Database: basis_positions --');
    log(`  Total rows: ${bpList.length}`);
    log(`  Closed: ${bs.closed.length} | Open/pending: ${bs.openish.length} | Failed: ${bs.failed.length}`);
    log(`  Closed sum grossPnl: $${fmt(bs.sumGross)}`);
    log(`  Closed sum netPnl:   $${fmt(bs.sumNet)}`);
    log('  By exitReason (closed):');
    for (const [r, v] of Object.entries(bs.byReason).sort((a, b) => b[1].n - a[1].n)) {
      log(`    ${r}: count=${v.n} netPnl=$${fmt(v.net)}`);
    }
    if (bs.openish.length) {
      log('  Open / pending (all):');
      for (const bp of bs.openish) {
        log(
          `    id=${bp.id} state=${bp.state} grid=${bp.gridLevel} entrySpread=${bp.entrySpread} ` +
            `dir=${bp.direction || '-'} entryTime=${bp.entryTime || '-'}`
        );
      }
    }
    log('');

    log('-- Exchange: open positions (this pair’s instruments only) --');
    logExchangeSubset(log, p, exchangeByAccount);
    log('');
  }

  log('');
  log('================================================================================');
  log('  EXCHANGE: FULL ACCOUNT SNAPSHOT (shared across pairs)');
  log('================================================================================');
  for (const acctName of [...accounts].sort()) {
    log('');
    log(`--- Account: ${acctName} ---`);
    const snap = exchangeByAccount[acctName];
    if (!snap || snap.error) {
      log(`  ${snap?.error || 'no data'}`);
      continue;
    }
    const { summary, pos, refPx } = snap;
    log(`  Equity (BTC): ${summary.equity}`);
    log(`  Available funds (BTC): ${summary.available_funds}`);
    log(`  Session UPL (BTC): ${summary.session_upl}  RPL (BTC): ${summary.session_rpl}`);
    const toUsd = (btc) => (btc != null && refPx ? Number(btc) * refPx : null);
    log(`  Reference BTC/USD: ${refPx}`);
    if (summary.session_upl != null) log(`  Session UPL ~ USD: $${fmt(toUsd(summary.session_upl))}`);
    if (summary.session_rpl != null) log(`  Session RPL ~ USD: $${fmt(toUsd(summary.session_rpl))}`);
    const nonZero = (pos || []).filter((pp) => pp.size !== 0);
    log(`  All open positions (non-zero): ${nonZero.length}`);
    let floatAll = 0;
    for (const pp of nonZero) {
      let fu =
        pp.floating_profit_loss_usd != null
          ? Number(pp.floating_profit_loss_usd)
          : pp.floating_profit_loss != null && refPx
            ? Number(pp.floating_profit_loss) * refPx
            : null;
      if (fu != null) floatAll += fu;
      log(
        `    ${pp.instrument_name} size=${pp.size} dir=${pp.direction} avg=${pp.average_price} ` +
          `upl_usd=${fu != null ? fmt(fu, 4) : '-'}`
      );
    }
    log(`  Sum floating PnL USD (all): $${fmt(floatAll, 4)}`);
  }

  log('');
  log('=== NOTES ===');
  log('  - Per-pair exchange block only lists instruments matching symbol1/symbol2.');
  log('  - Full account snapshot is shared if multiple pairs use the same account.');
  log('  - Session RPL/UPL are Deribit session windows, not DB roundtrip windows.');

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`\nWrote ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
