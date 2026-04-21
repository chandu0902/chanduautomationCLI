require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Sequelize } = require('sequelize');
const crypto = require('crypto');
const axios = require('axios');

const s = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
  host: process.env.DB_HOST, dialect: 'mysql', logging: false
});

function decrypt(enc) {
  try {
    const key = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'defaultkey').digest();
    const [ivHex, encrypted] = enc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
  } catch { return enc; }
}

async function getToken(apiKey, secretKey) {
  const r = await axios.post('https://www.deribit.com/api/v2/public/auth', {
    jsonrpc: '2.0', id: 1, method: 'public/auth',
    params: { grant_type: 'client_credentials', client_id: apiKey, client_secret: secretKey, scope: 'trade:read_write' }
  }, { timeout: 10000 });
  return r.data?.result?.access_token;
}

async function apiGet(path, token) {
  const r = await axios.get(`https://www.deribit.com${path}`, {
    headers: { Authorization: `Bearer ${token}` }, timeout: 10000
  });
  return r.data;
}

(async () => {
  const row = await s.query("SELECT Api_Key, Secret_Key FROM AccountDetails WHERE Trade_Account='ETHHIDDEN_ROAD'",
    { type: s.QueryTypes.SELECT });
  const apiKey = decrypt(row[0].Api_Key);
  const secretKey = decrypt(row[0].Secret_Key);

  const token = await getToken(apiKey, secretKey);
  console.log('Auth OK, token acquired.');

  const start = new Date('2026-04-19T09:36:36Z').getTime();

  // Fetch all fills since session start
  let allFills = [];
  for (const offset of [0, 100, 200, 300]) {
    const r = await apiGet(
      `/api/v2/private/get_user_trades_by_instrument_and_time?instrument_name=ETH-PERPETUAL&start_timestamp=${start}&end_timestamp=${Date.now()}&count=100&offset=${offset}&sorting=asc`,
      token
    );
    const batch = r?.result?.trades || [];
    allFills = allFills.concat(batch);
    if (batch.length < 100) break;
  }

  console.log('\nTotal exchange fills:', allFills.length);

  let makerN=0, takerN=0, makerFeeEth=0, takerFeeEth=0;
  const takerFills = [];

  for (const f of allFills) {
    if (f.liquidity === 'M') {
      makerN++; makerFeeEth += f.fee;
    } else {
      takerN++; takerFeeEth += f.fee;
      takerFills.push(f);
    }
  }

  const avgPx = allFills.length ? allFills.reduce((s,f)=>s+f.price,0)/allFills.length : 0;

  console.log(`\nMaker fills : ${makerN}  | fee total: ${makerFeeEth.toFixed(8)} ETH = $${(makerFeeEth*avgPx).toFixed(4)} (negative=rebate earned)`);
  console.log(`Taker fills : ${takerN}  | fee total: ${takerFeeEth.toFixed(8)} ETH = $${(takerFeeEth*avgPx).toFixed(4)} (positive=cost paid)`);

  if (takerFills.length) {
    console.log('\n=== TAKER FILLS (these should not exist) ===');
    for (const f of takerFills) {
      console.log(` ${new Date(f.timestamp).toISOString()}  ${f.direction.padEnd(5)}  px=${f.price}  qty=${f.amount}  fee=${f.fee} ETH  order=${f.order_id}`);
    }
  } else {
    console.log('\nAll fills confirmed MAKER — no taker fees paid.');
  }

  // Fee sign check
  console.log('\n=== FILL SAMPLE (first 8) — confirm fee sign ===');
  for (const f of allFills.slice(0, 8)) {
    const feeSign = f.fee < 0 ? 'REBATE' : f.fee === 0 ? 'ZERO' : 'COST!';
    console.log(` ${new Date(f.timestamp).toISOString()}  ${f.direction.padEnd(5)}  M/T=${f.liquidity}  px=${f.price}  fee=${f.fee} ${f.fee_currency}  [${feeSign}]`);
  }

  // Compare to DB
  const dbStats = await s.query(`
    SELECT COUNT(*) as n, SUM(commission) as totalComm, AVG(commission) as avgComm
    FROM basis_positions
    WHERE pairId=26 AND state='closed' AND createdAt >= '2026-04-19 09:36:36'
  `, { type: s.QueryTypes.SELECT });
  console.log('\n=== DB vs EXCHANGE FEE RECONCILIATION ===');
  console.log(`DB  : ${dbStats[0].n} trades, total commission = $${parseFloat(dbStats[0].totalComm||0).toFixed(4)} (avg $${parseFloat(dbStats[0].avgComm||0).toFixed(4)}/trade)`);
  console.log(`Exch: ${allFills.length} fills,  maker fee = $${(makerFeeEth*avgPx).toFixed(4)} (should be negative = income)`);
  console.log(`Note: DB stores commission as +value = income (rebate). Exchange fee negative = rebate.`);

  await s.close();
})();
