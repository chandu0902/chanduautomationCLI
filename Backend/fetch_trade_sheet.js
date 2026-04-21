require('dotenv').config();
const { Sequelize, DataTypes, Op } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'statarb',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  { host: process.env.DB_HOST || 'localhost', dialect: 'mysql', logging: false }
);

const Trade = sequelize.define('Trade', {
  id:             { type: DataTypes.INTEGER, primaryKey: true },
  pairId:         DataTypes.INTEGER,
  side:           DataTypes.STRING,   // 'entry' | 'exit'
  status:         DataTypes.STRING,
  legA_symbol:    DataTypes.STRING,
  legA_side:      DataTypes.STRING,
  legA_price:     DataTypes.DOUBLE,
  legA_qty:       DataTypes.DOUBLE,
  legA_orderId:   DataTypes.STRING,
  legA_filledAt:  DataTypes.DATE,
  legB_symbol:    DataTypes.STRING,
  legB_side:      DataTypes.STRING,
  legB_price:     DataTypes.DOUBLE,
  legB_qty:       DataTypes.DOUBLE,
  legB_orderId:   DataTypes.STRING,
  legB_filledAt:  DataTypes.DATE,
  zScoreAtEntry:  DataTypes.DOUBLE,
  spreadAtEntry:  DataTypes.DOUBLE,
  pnl:            DataTypes.DOUBLE,
  legA_pnl:       DataTypes.DOUBLE,
  legB_pnl:       DataTypes.DOUBLE,
  commission:     DataTypes.DOUBLE,
  exchangePnl:    DataTypes.DOUBLE,
  balanceBefore:  DataTypes.DOUBLE,
  balanceAfter:   DataTypes.DOUBLE,
  createdAt:      DataTypes.DATE,
}, { tableName: 'trade_logs', timestamps: true });

function fmt(n, dec = 2) {
  if (n == null) return '     NULL';
  return (n >= 0 ? '+' : '') + n.toFixed(dec);
}
function fmtP(n) {
  if (n == null) return 'NULL    ';
  return '$' + parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDt(d) {
  if (!d) return 'NULL';
  return new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}
function dir(t) {
  // long = bought futures (legA buy) at entry; short = sold futures at entry
  if (t.side === 'entry') return t.legA_side === 'buy' ? 'LONG ' : 'SHORT';
  // for exits, direction is opposite
  return t.legA_side === 'sell' ? 'LONG ' : 'SHORT';
}

(async () => {
  try {
    await sequelize.authenticate();
    const since = new Date('2026-03-23T13:45:00.000Z');

    const all = await Trade.findAll({
      where: { pairId: 55, createdAt: { [Op.gte]: since } },
      order: [['id', 'ASC']],
    });

    const entries = all.filter(t => t.side === 'entry'  && t.status === 'filled');
    const exits   = all.filter(t => t.side === 'exit'   && t.status === 'filled');
    const cancels = all.filter(t => t.status === 'cancelled');
    const stale   = all.filter(t => t.status === 'open');

    console.log(`\nPair 55 — BTC Basis | 2026-03-23 13:45 UTC → now`);
    console.log(`Total records : ${all.length}  |  entries: ${entries.length}  exits: ${exits.length}  cancelled: ${cancels.length}  stale-open: ${stale.length}\n`);

    // ── ENTRIES ──────────────────────────────────────────────────────────
    const W = 140;
    console.log('═'.repeat(W));
    console.log('  FILLED ENTRIES');
    console.log('═'.repeat(W));
    const hdr = ['ID','Time (UTC)','Dir','legA_side','Futures Px','Qty','legB_side','Perp Px','Qty','Basis $','zScore','Spread'];
    console.log(
      hdr[0].padEnd(6)+hdr[1].padEnd(17)+hdr[2].padEnd(7)+hdr[3].padEnd(10)+
      hdr[4].padEnd(13)+hdr[5].padEnd(7)+hdr[6].padEnd(10)+hdr[7].padEnd(13)+
      hdr[8].padEnd(7)+hdr[9].padEnd(10)+hdr[10].padEnd(10)+hdr[11]
    );
    console.log('─'.repeat(W));
    for (const t of entries) {
      const basis = t.legA_price && t.legB_price ? t.legA_price - t.legB_price : null;
      console.log(
        String(t.id).padEnd(6) +
        fmtDt(t.legA_filledAt || t.createdAt).padEnd(17) +
        dir(t).padEnd(7) +
        (t.legA_side||'-').padEnd(10) +
        fmtP(t.legA_price).padEnd(13) +
        String(t.legA_qty||'-').padEnd(7) +
        (t.legB_side||'-').padEnd(10) +
        fmtP(t.legB_price).padEnd(13) +
        String(t.legB_qty||'-').padEnd(7) +
        (basis!=null?fmt(basis,2):'NULL').padEnd(10) +
        (t.zScoreAtEntry!=null?t.zScoreAtEntry.toFixed(3):'NULL').padEnd(10) +
        (t.spreadAtEntry!=null?t.spreadAtEntry.toFixed(4):'NULL')
      );
    }

    // ── EXITS ─────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(W));
    console.log('  FILLED EXITS');
    console.log('═'.repeat(W));
    const hdr2 = ['ID','Time (UTC)','Dir','legA_side','Futures Px','legB_side','Perp Px','Basis $','PnL USD','Commission','Net','ExchPnl'];
    console.log(
      hdr2[0].padEnd(6)+hdr2[1].padEnd(17)+hdr2[2].padEnd(7)+hdr2[3].padEnd(10)+
      hdr2[4].padEnd(13)+hdr2[5].padEnd(10)+hdr2[6].padEnd(13)+
      hdr2[7].padEnd(10)+hdr2[8].padEnd(12)+hdr2[9].padEnd(12)+hdr2[10].padEnd(12)+hdr2[11]
    );
    console.log('─'.repeat(W));

    let sumPnl=0, sumComm=0, sumExch=0, wins=0, losses=0;
    for (const t of exits) {
      const basis = t.legA_price && t.legB_price ? t.legA_price - t.legB_price : null;
      const pnl   = t.pnl ?? null;
      const comm  = t.commission ?? null;
      const net   = pnl!=null&&comm!=null ? pnl-comm : null;
      const ePnl  = t.exchangePnl ?? null;
      if (pnl  != null) sumPnl  += pnl;
      if (comm != null) sumComm += comm;
      if (ePnl != null) sumExch += ePnl;
      if (net  != null) net>=0 ? wins++ : losses++;
      console.log(
        String(t.id).padEnd(6) +
        fmtDt(t.legA_filledAt || t.createdAt).padEnd(17) +
        dir(t).padEnd(7) +
        (t.legA_side||'-').padEnd(10) +
        fmtP(t.legA_price).padEnd(13) +
        (t.legB_side||'-').padEnd(10) +
        fmtP(t.legB_price).padEnd(13) +
        (basis!=null?fmt(basis,2):'NULL').padEnd(10) +
        (pnl !=null?fmt(pnl, 4):'NULL').padEnd(12) +
        (comm!=null?fmt(comm,4):'NULL').padEnd(12) +
        (net !=null?fmt(net, 4):'NULL').padEnd(12) +
        (ePnl!=null?ePnl.toFixed(6):'NULL')
      );
    }
    const sumNet = sumPnl - sumComm;
    console.log('─'.repeat(W));
    console.log(`  TOTALS: gross=${fmt(sumPnl,4)}  fees=${fmt(sumComm,4)}  net=${fmt(sumNet,4)}  exchPnl=${fmt(sumExch,6)}`);

    // ── ROUNDTRIP PAIRS ───────────────────────────────────────────────────
    const pairs = Math.min(entries.length, exits.length);
    console.log('\n' + '═'.repeat(W));
    console.log(`  ROUNDTRIP PAIRS  (${pairs} matched)`);
    console.log('═'.repeat(W));
    console.log(
      '#'.padEnd(5)+'Dir'.padEnd(7)+
      'EntryTime'.padEnd(17)+'FutEntry'.padEnd(12)+'PerpEntry'.padEnd(12)+'BasisIn'.padEnd(10)+
      'ExitTime'.padEnd(17)+'FutExit'.padEnd(12)+'PerpExit'.padEnd(12)+'BasisOut'.padEnd(10)+
      'ΔBasis'.padEnd(10)+'PnL'.padEnd(10)+'Fee'.padEnd(10)+'Net'
    );
    console.log('─'.repeat(W));

    let rtPnl=0, rtFee=0, rtWins=0, rtLosses=0;
    for (let i=0; i<pairs; i++) {
      const en = entries[i], ex = exits[i];
      const bIn  = en.legA_price&&en.legB_price ? en.legA_price-en.legB_price : null;
      const bOut = ex.legA_price&&ex.legB_price ? ex.legA_price-ex.legB_price : null;
      const dB   = bIn!=null&&bOut!=null ? bOut-bIn : null;
      const pnl  = ex.pnl ?? null;
      const fee  = ex.commission ?? null;
      const net  = pnl!=null&&fee!=null ? pnl-fee : null;
      if (pnl!=null) rtPnl+=pnl;
      if (fee!=null) rtFee+=fee;
      if (net!=null) net>=0?rtWins++:rtLosses++;
      console.log(
        String(i+1).padEnd(5)+dir(en).padEnd(7)+
        fmtDt(en.legA_filledAt||en.createdAt).padEnd(17)+
        fmtP(en.legA_price).padEnd(12)+fmtP(en.legB_price).padEnd(12)+
        (bIn!=null?fmt(bIn,2):'NULL').padEnd(10)+
        fmtDt(ex.legA_filledAt||ex.createdAt).padEnd(17)+
        fmtP(ex.legA_price).padEnd(12)+fmtP(ex.legB_price).padEnd(12)+
        (bOut!=null?fmt(bOut,2):'NULL').padEnd(10)+
        (dB!=null?fmt(dB,2):'NULL').padEnd(10)+
        (pnl!=null?fmt(pnl,3):'NULL').padEnd(10)+
        (fee!=null?fmt(fee,3):'NULL').padEnd(10)+
        (net!=null?fmt(net,3):'NULL')
      );
    }
    const rtNet = rtPnl - rtFee;
    console.log('─'.repeat(W));
    console.log(`  ${pairs} roundtrips | wins=${rtWins} losses=${rtLosses} | win rate=${pairs>0?((rtWins/pairs)*100).toFixed(1):0}%`);
    console.log(`  Gross PnL: ${fmt(rtPnl,4)}  |  Fees: ${fmt(rtFee,4)}  |  Net: ${fmt(rtNet,4)}`);

    // ── ORPHANED ENTRIES ──────────────────────────────────────────────────
    if (entries.length > exits.length) {
      console.log('\n' + '═'.repeat(W));
      console.log('  ORPHANED ENTRIES (no matching exit in DB)');
      console.log('═'.repeat(W));
      for (let i=exits.length; i<entries.length; i++) {
        const en = entries[i];
        const basis = en.legA_price&&en.legB_price ? en.legA_price-en.legB_price : null;
        console.log(
          `  #${i+1}  id=${en.id}  ${fmtDt(en.legA_filledAt||en.createdAt)}  dir=${dir(en)}  ` +
          `fut=${fmtP(en.legA_price)}  perp=${fmtP(en.legB_price)}  basis=${basis!=null?fmt(basis,2):'NULL'}  z=${en.zScoreAtEntry!=null?en.zScoreAtEntry.toFixed(3):'NULL'}`
        );
      }
    }

    console.log('\n');
    process.exit(0);
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
