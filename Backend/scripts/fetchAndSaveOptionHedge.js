#!/usr/bin/env node
/**
 * fetchAndSaveOptionHedge.js
 *
 * Fetches live option positions from the exchange for a given pair's account,
 * and saves them into StatArbInput.optionInstruments for that pair.
 *
 * Usage:
 *   node scripts/fetchAndSaveOptionHedge.js --pairId=24
 *   node scripts/fetchAndSaveOptionHedge.js --pairId=24 --dry-run
 *   node scripts/fetchAndSaveOptionHedge.js --pairId=24 --currency=BTC
 *
 * Writes:
 *   - DB: StatArbInput.optionInstruments (JSON string)
 *   - File: Backend/reports/option_hedge_pair<id>_<ts>.json  (full snapshot)
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const { sequelize, StatArbInput, AccountDetails } = require('../src/models');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function decryptText(k, enc, iv) {
  const dc = crypto.createDecipheriv('aes-256-cbc', Buffer.from(k, 'base64'), Buffer.from(iv, 'base64'));
  return dc.update(enc, 'base64', 'utf8') + dc.final('utf8');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(apiKey, secret) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secret, scope: 'trade:read_write' },
  });
  if (r.data.error) throw new Error(r.data.error.message);
  return r.data.result.access_token;
}

async function dRpc(token, method, params = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await axios.post(
      `https://www.deribit.com/api/v2/private/${method}`,
      { jsonrpc: '2.0', id: 1, method: `private/${method}`, params },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 30000, validateStatus: () => true }
    );
    const e = r.data?.error;
    if (r.status === 429 || e?.code === 10028) { await sleep(4000 * (i + 1)); continue; }
    if (r.status >= 400) throw new Error(`${method} HTTP ${r.status}`);
    if (e) throw new Error(e.message);
    return r.data.result;
  }
  throw new Error(`${method}: too many retries`);
}

function currencyFromSymbol(sym) {
  if (!sym) return 'BTC';
  const s = String(sym).toUpperCase();
  if (s.startsWith('BTC')) return 'BTC';
  if (s.startsWith('ETH')) return 'ETH';
  if (s.startsWith('SOL')) return 'SOL';
  return 'BTC';
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const o = { pairId: null, dryRun: false, currency: null };
  for (const a of argv) {
    if (a.startsWith('--pairId=')) o.pairId = parseInt(a.split('=')[1], 10);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a.startsWith('--currency=')) o.currency = a.split('=')[1].toUpperCase();
  }
  if (!o.pairId) { console.error('--pairId=<n> required'); process.exit(1); }
  return o;
}

(async () => {
  const opts = parseArgs();

  await sequelize.authenticate();

  const pair = await StatArbInput.findByPk(opts.pairId);
  if (!pair) { console.error(`pair ${opts.pairId} not found`); process.exit(1); }

  const currency = opts.currency || currencyFromSymbol(pair.symbol1 || pair.symbol2);
  const acctName = pair.tradeAccountB || pair.tradeAccountA;

  const acct = await AccountDetails.findOne({ where: { Trade_Account: acctName } });
  if (!acct) { console.error(`AccountDetails row not found for ${acctName}`); process.exit(1); }

  const [ak0, ak1, ak2] = acct.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acct.Secret_Key.split(',', 3);
  const token = await getToken(decryptText(ak2, ak1, ak0), decryptText(sk2, sk1, sk0));
  await sleep(800);

  console.log(`pair ${opts.pairId}  agent=${pair.agentName}  account=${acctName}  ccy=${currency}`);

  const optPos = await dRpc(token, 'get_positions', { currency, kind: 'option' });
  const open = (optPos || []).filter((p) => Number(p.size) !== 0);

  console.log('');
  console.log(`LIVE ${currency} OPTION POSITIONS (open, size != 0): ${open.length}`);
  console.log('────────────────────────────────────────────────────────────────');
  for (const p of open) {
    console.log(
      `  ${p.instrument_name.padEnd(28)}  size=${String(p.size).padStart(6)}  ` +
      `dir=${(p.direction || '').padEnd(4)}  avg=${p.average_price}  ` +
      `mark=${p.mark_price}  delta=${Number(p.delta).toFixed(4)}  ` +
      `upl=${Number(p.floating_profit_loss).toFixed(6)} ${currency}`
    );
  }

  const hedge = open.map((p) => ({
    name: p.instrument_name,
    size: Number(p.size),
  }));
  const hedgeJson = JSON.stringify(hedge);

  const prev = pair.optionInstruments || '[]';
  console.log('');
  console.log('PREVIOUS optionInstruments  :', prev);
  console.log('NEW      optionInstruments  :', hedgeJson);

  const snapTs = new Date().toISOString().replace(/[:.]/g, '-');
  const snapPath = path.join(REPORTS_DIR, `option_hedge_pair${opts.pairId}_${snapTs}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    snapPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        pairId: opts.pairId,
        agentName: pair.agentName,
        account: acctName,
        currency,
        previousOptionInstruments: prev,
        newOptionInstruments: hedgeJson,
        livePositionsRaw: open,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log('');
  console.log('Snapshot written:', snapPath);

  if (opts.dryRun) {
    console.log('');
    console.log('DRY RUN — DB not updated.');
    await sequelize.close();
    return;
  }

  pair.optionInstruments = hedgeJson;
  await pair.save();

  const verify = await StatArbInput.findByPk(opts.pairId);
  console.log('');
  console.log('DB updated. optionInstruments now:');
  console.log('  ' + verify.optionInstruments);

  await sequelize.close();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
