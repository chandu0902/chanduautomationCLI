/**
 * Round trips, PnL, volume, and maker rebates since last Friday (UTC) for the current bot pair.
 *
 *   node report_bot_since_friday.js
 *   node report_bot_since_friday.js --pairId=6
 *   node report_bot_since_friday.js --sinceIso=2026-04-03T00:00:00.000Z
 *
 * Writes: Backend/reports/bot_since_friday_<ts>.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const { sequelize, StatArbInput, Trade, BasisPosition, BotSessionLog, AccountDetails } = require('./src/models');

function lastFridayStartUtc(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay();
  let daysBack;
  if (dow === 5) daysBack = 0;
  else if (dow === 6) daysBack = 1;
  else daysBack = dow + 2;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.getTime();
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { pairId: null, sinceIso: null, account: 'deribit hiddenroad' };
  for (const a of argv) {
    if (a.startsWith('--pairId=')) o.pairId = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--sinceIso=')) o.sinceIso = a.slice('--sinceIso='.length);
    else if (a.startsWith('--account=')) o.account = a.split('=')[1].replace(/^"|"$/g, '');
  }
  return o;
}

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

async function fetchFillsBtc(token, startMs, instrumentNames) {
  const nameSet = new Set(instrumentNames.filter(Boolean));
  const all = [];
  const count = 1000;
  let curStart = startMs;
  for (let page = 0; page < 50; page++) {
    const r = await axios.get('https://www.deribit.com/api/v2/private/get_user_trades_by_currency_and_time', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        currency: 'BTC',
        start_timestamp: curStart,
        end_timestamp: Date.now(),
        count,
        sorting: 'asc',
      },
      timeout: 25000,
    });
    if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
    const res = r.data.result;
    const trades = res?.trades || [];
    if (!trades.length) break;
    for (const t of trades) {
      if (nameSet.size === 0 || nameSet.has(t.instrument_name)) all.push(t);
    }
    if (!res.has_more) break;
    curStart = trades[trades.length - 1].timestamp + 1;
    await new Promise((x) => setTimeout(x, 350));
  }
  return all;
}

async function main() {
  const opts = parseArgs();
  const sinceMs = opts.sinceIso ? Date.parse(opts.sinceIso) : lastFridayStartUtc();
  if (Number.isNaN(sinceMs)) {
    console.error('Invalid --sinceIso');
    process.exit(1);
  }

  await sequelize.authenticate();

  let pairs;
  if (opts.pairId != null) {
    const p = await StatArbInput.findByPk(opts.pairId);
    pairs = p ? [p] : [];
  } else {
    pairs = await StatArbInput.findAll({
      where: { status: 'active', tradingEnabled: true },
      order: [['id', 'ASC']],
    });
  }

  const lines = [];
  const log = (s) => lines.push(s);

  log('================================================================================');
  log('BOT METRICS SINCE FRIDAY (closed round trips + exchange fills)');
  log(`Generated: ${new Date().toISOString()}`);
  log(`Window UTC: ${new Date(sinceMs).toISOString()}  →  now`);
  log(`(Default "Friday" = most recent Friday 00:00 UTC unless --sinceIso set)`);
  log('================================================================================');
  log('');

  if (pairs.length === 0) {
    log('No pair found. Use --pairId=6 or enable trading on an active pair.');
    const outDir = path.join(__dirname, 'reports');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `bot_since_friday_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    process.exit(0);
  }

  const ix = await axios.get('https://www.deribit.com/api/v2/public/get_index_price', {
    params: { index_name: 'btc_usd' },
  });
  const btcUsd = Number(ix.data?.result?.index_price) || 0;

  let accRow = await AccountDetails.findOne({ where: { Trade_Account: opts.account } });
  if (!accRow) {
    const firstPair = pairs[0];
    const ta = firstPair.tradeAccountA || firstPair.tradeAccountB;
    if (ta) accRow = await AccountDetails.findOne({ where: { Trade_Account: ta } });
  }
  let token = null;
  if (accRow?.Api_Key && accRow?.Secret_Key) {
    const [ak0, ak1, ak2] = accRow.Api_Key.split(',', 3);
    const [sk0, sk1, sk2] = accRow.Secret_Key.split(',', 3);
    const apiKey = decryptText(ak2, ak1, ak0);
    const secret = decryptText(sk2, sk1, sk0);
    token = await getToken(apiKey, secret);
  }

  for (const pair of pairs) {
    const pid = pair.id;
    const execSym = pair.tradeLeg === 'B' ? pair.symbol2 : pair.symbol1;
    const instrumentsAll = [...new Set([pair.symbol1, pair.symbol2, execSym].filter(Boolean))];
    const instrumentsExec = execSym ? [execSym] : instrumentsAll;

    log('--------------------------------------------------------------------------------');
    log(`PAIR id=${pid}  agent=${pair.agentName}`);
    log(`  Executed instrument (tradeLeg ${pair.tradeLeg}): ${execSym || '-'}`);
    log(`  symbol1 / symbol2: ${pair.symbol1} / ${pair.symbol2}`);
    log('--------------------------------------------------------------------------------');

    const lastSess = await BotSessionLog.findOne({
      where: { pairId: pid },
      order: [['enabledAt', 'DESC']],
    });
    if (lastSess) {
      log('--- Bot session (latest) ---');
      log(`  enabledAt=${lastSess.enabledAt}  disabledAt=${lastSess.disabledAt || '(null — check running)'}`);
      log(`  stopReason=${lastSess.stopReason || '-'}`);
    }
    log('');

    const sinceDate = new Date(sinceMs);
    const closedAll = await BasisPosition.findAll({
      where: { pairId: pid, state: 'closed' },
      order: [['exitTime', 'ASC']],
    });
    const closedInWindow = closedAll.filter((p) => p.exitTime && new Date(p.exitTime) >= sinceDate);

    const rtTotal = closedInWindow.length;
    const rtProfitReason = closedInWindow.filter((p) => p.exitReason === 'profit').length;
    const rtStopReason = closedInWindow.filter((p) => p.exitReason === 'stop').length;
    const rtNetPositive = closedInWindow.filter((p) => Number(p.netPnl) > 0).length;
    const rtNetNonPositive = closedInWindow.filter((p) => Number(p.netPnl) <= 0).length;

    let sumNetPnl = 0;
    let sumGross = 0;
    let sumCommDb = 0;
    let sumTakerDb = 0;
    for (const p of closedInWindow) {
      sumNetPnl += Number(p.netPnl) || 0;
      sumGross += Number(p.grossPnl) || 0;
      sumCommDb += Number(p.commission) || 0;
      sumTakerDb += Number(p.takerFeeUsd) || 0;
    }

    log('=== DATABASE — closed basis_positions (exitTime in window) ===');
    log(`  Total round trips (closed in window):     ${rtTotal}`);
    log(`  Exit reason = profit:                     ${rtProfitReason}`);
    log(`  Exit reason = stop:                       ${rtStopReason}`);
    log(`  netPnl > 0 (profitable):                 ${rtNetPositive}`);
    log(`  netPnl <= 0:                              ${rtNetNonPositive}`);
    log(`  Sum netPnl (profit from round trips):     $${sumNetPnl.toFixed(4)}`);
    log(`  Sum grossPnl:                             $${sumGross.toFixed(4)}`);
    log(`  Sum commission (maker rebate, DB):        $${sumCommDb.toFixed(4)}`);
    log(`  Sum takerFeeUsd (DB):                     $${sumTakerDb.toFixed(4)}`);
    log('');

    const closedEver = await BasisPosition.count({ where: { pairId: pid, state: 'closed' } });
    log('=== DATABASE — since new bot (all closed positions, any time) ===');
    log(`  Total closed round trips (lifetime): ${closedEver}`);
    log('');

    const trades = await Trade.findAll({
      where: {
        pairId: pid,
        status: 'filled',
        side: 'exit',
        [Op.or]: [
          { legA_filledAt: { [Op.gte]: sinceDate } },
          { legB_filledAt: { [Op.gte]: sinceDate } },
        ],
      },
      order: [['id', 'ASC']],
    });
    let tLeg = 0;
    let tComm = 0;
    let tTaker = 0;
    let tVolUsd = 0;
    for (const t of trades) {
      tLeg += (Number(t.legA_pnl) || 0) + (Number(t.legB_pnl) || 0);
      tComm += Number(t.commission) || 0;
      tTaker += Number(t.takerFeeUsd) || 0;
      if (t.legA_qty != null) tVolUsd += Math.abs(Number(t.legA_qty));
    }
    log('=== DATABASE — trade_logs filled exits (leg fill time in window) ===');
    log(`  Rows: ${trades.length}`);
    log(`  Sum leg pnl + commission − taker (like report): $${(tLeg + tComm - tTaker).toFixed(4)}`);
    log(`  Sum commission: $${tComm.toFixed(4)}  takerFeeUsd: $${tTaker.toFixed(4)}`);
    log(`  Volume (sum |legA_qty| USD notional): $${tVolUsd.toFixed(2)}`);
    log('');

    let volUsdEx = null;
    let rebateUsdEx = null;
    if (token && instrumentsExec.length) {
      try {
        const fillsExec = await fetchFillsBtc(token, sinceMs, instrumentsExec);
        const fillsAll = instrumentsAll.length !== instrumentsExec.length
          ? await fetchFillsBtc(token, sinceMs, instrumentsAll)
          : fillsExec;
        let volUsd = 0;
        let feeBtc = 0;
        let rebateBtc = 0;
        let paidBtc = 0;
        let makerN = 0;
        let takerN = 0;
        for (const f of fillsExec) {
          const amt = Math.abs(Number(f.amount || 0));
          volUsd += amt;
          const fee = Number(f.fee || 0);
          feeBtc += fee;
          if (fee < 0) rebateBtc += -fee;
          else if (fee > 0) paidBtc += fee;
          const liq = String(f.liquidity || '').toUpperCase();
          if (liq === 'M') makerN++;
          else if (liq === 'T') takerN++;
        }
        volUsdEx = volUsd;
        rebateUsdEx = rebateBtc * btcUsd;
        log(`=== EXCHANGE — executed leg only: ${instrumentsExec.join(', ')} ===`);
        log(`  Fills in window: ${fillsExec.length}  (liquidity M/T: ${makerN}/${takerN})`);
        log(`  Total volume (sum |amount| USD): $${volUsd.toFixed(2)}`);
        log(`  Sum fee (BTC): ${feeBtc.toFixed(8)}  → ~$${(feeBtc * btcUsd).toFixed(4)} @ index`);
        log(`  Maker rebate (fee < 0, |fee| in BTC): ${rebateBtc.toFixed(8)}  → ~$${(rebateBtc * btcUsd).toFixed(4)}`);
        log(`  Taker / positive fees (BTC):          ${paidBtc.toFixed(8)}  → ~$${(paidBtc * btcUsd).toFixed(4)}`);
        log(`  Net fee BTC: ${feeBtc.toFixed(8)}`);
        const alsoAllSyms = instrumentsAll.join(',') !== instrumentsExec.join(',');
        if (alsoAllSyms) {
          let v2 = 0;
          for (const f of fillsAll) v2 += Math.abs(Number(f.amount || 0));
          log(`  (All listed pair symbols — ref only: vol $${v2.toFixed(2)}  fills=${fillsAll.length})`);
        }
      } catch (e) {
        log(`  EXCHANGE ERROR: ${e.message}`);
      }
    } else {
      log('=== EXCHANGE === (skipped: no credentials or instruments)');
    }

    log('');
    log('>>> SUMMARY (since window start — pair ' + pid + ') <<<');
    log(`  Profitable round trips (netPnl > 0):     ${rtNetPositive}`);
    log(`  Total round trips (closed in window):  ${rtTotal}`);
    log(`  Profit from round trips (sum netPnl):    $${sumNetPnl.toFixed(4)}`);
    log(
      `  Total volume (exchange, executed leg):  ${volUsdEx != null ? '$' + volUsdEx.toFixed(2) : 'n/a (see DB exit notionals $' + tVolUsd.toFixed(2) + ')'}`
    );
    log(
      `  Total rebate fees (exchange est USD):   ${rebateUsdEx != null ? '~$' + rebateUsdEx.toFixed(4) : 'n/a'}`
    );
    log(`  Maker rebate (DB, basis round trips):   $${sumCommDb.toFixed(4)}`);
    log('');
  }

  log('================================================================================');
  log('NOTES');
  log('  • "Profitable round trips" above = count of closed positions with netPnl > 0.');
  log('  • Strategy exitReason profit/stop may differ slightly from strict netPnl sign.');
  log('  • Exchange volume = sum of |amount| on each fill (Deribit BTC-PERP USD sizing).');
  log('  • Rebates: negative fee in BTC on Deribit = maker rebate credited.');
  log('================================================================================');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `bot_since_friday_${ts}.txt`);
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log('\nWrote', outPath);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
