#!/usr/bin/env node
'use strict';

/**
 * Export paper + live SOL reports to Backend/reports/
 *
 * Usage:
 *   node scripts/exportPaperAndLiveReports.js [botId]     → summary reports only (.txt)
 *   node scripts/exportPaperAndLiveReports.js 4 --raw   → also full trade dumps (.json + TSV .txt)
 *
 * Default (summary only):
 *   - report_bot<N>_summary_<ts>.txt   — master index + exchange window; links to individual analysis files below
 *   - report_bot<N>_analysis_paper_sol_<ts>.txt
 *   - report_bot<N>_analysis_paper_cross_<PAIR>_<ts>.txt   (one per cross pair)
 *   - report_bot<N>_analysis_live_db_<ts>.txt
 *   - report_bot<N>_analysis_zones_<ts>.txt   — per-zone trade stats (DB); optional Deribit slice by EXIT order_id
 *   - report_bot<N>_analysis_reconciliation_<ts>.txt   — DB vs Deribit fills
 *   - report_bot<N>_live_sol_exchange_<ts>.txt — per-zone trade stats + Deribit fills + 1-SOL open-leg slice
 *   - report_index_<ts>.json|.txt     — paths (includes analysisReports map)
 *
 * With --raw (trade data dumps in addition):
 *   - paper_sol_*, paper_cross_*, live_bot*_db_*, live_bot*_deribit_* (.json + tab-separated .txt)
 *
 * Paper-only / subsets:
 *   --paper-only     Skip live DB + Deribit; write paper analysis files + snapshot appendix only.
 *   --pairs=SOL,BTC  Limit to listed keys (SOL = sol_paper_trades; others = cross_paper_trades).
 *   --snapshot-tail=N   JSONL lines appended to each paper analysis report (default 4000; max 50000).
 *   --snapshot-tail=full|all|0   Entire snapshot file up to PAPER_SNAPSHOT_TAIL_HARD_CAP (default 100k lines).
 *   --snapshot-individual[=N]   Also write report_bot<ID>_paper_snapshots_only_<PAIR>_<ts>.txt per pair
 *                               (default N=20000 when flag present without =; same full/all/0 rules as tail).
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signedRequest } = require('../src/controllers/apicontroller');
const { QueryTypes } = require('sequelize');
const {
  sequelize,
  AccountDetails,
  SolLiveBot,
  SolLiveTrade,
  SolPaperTrade,
  CrossPaperTrade,
} = require('../src/models');
const { formatSnapshotAppendix } = require('../src/services/paperSnapshotLogger');

const REPORT_DIR = path.resolve(__dirname, '../reports');
const INSTRUMENT = 'SOL_USDC-PERPETUAL';
const DERIBIT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** CLI `--snapshot-tail=` / `--snapshot-individual=` numeric cap (full file uses logger hard cap). */
const SNAPSHOT_CLI_MAX = 50_000;
const DEFAULT_SNAPSHOT_TAIL = 4000;
const DEFAULT_SNAPSHOT_INDIVIDUAL = 20_000;

function _parseSnapshotLineCount(argVal, defaultNumeric) {
  const raw = String(argVal ?? '').trim().toLowerCase();
  if (raw === 'full' || raw === 'all' || raw === '0') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultNumeric;
  if (n < 0) return 0;
  return Math.min(SNAPSHOT_CLI_MAX, Math.max(50, n));
}

function _median(sortedArr) {
  if (!sortedArr.length) return null;
  const s = [...sortedArr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function _pct(n, d) {
  if (!d) return '0.0';
  return ((100 * n) / d).toFixed(1);
}

function decryptCred(ak2, ak1, ak0) {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(ak2, 'base64'),
    Buffer.from(ak0, 'base64'),
  );
  return decipher.update(ak1, 'base64', 'utf8') + decipher.final('utf8');
}

async function loadDeribitKeys(accountId) {
  const row = await AccountDetails.findByPk(accountId);
  if (!row) throw new Error(`AccountDetails id=${accountId} not found`);
  const [ak0, ak1, ak2] = row.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = row.Secret_Key.split(',', 3);
  return {
    apiKey: decryptCred(ak2, ak1, ak0),
    secretKey: decryptCred(sk2, sk1, sk0),
    tradeAccount: row.Trade_Account,
  };
}

async function fetchDeribitUserTrades(apiKey, secretKey, instrumentName, startMs, endMs) {
  const all = [];
  let startT = startMs;
  for (let i = 0; i < 200; i++) {
    const resp = await signedRequest(
      `/api/v2/private/get_user_trades_by_instrument_and_time?instrument_name=${encodeURIComponent(
        instrumentName,
      )}&start_timestamp=${startT}&end_timestamp=${endMs}&count=500&sorting=asc`,
      apiKey,
      secretKey,
    );
    const trades = resp?.result?.trades || [];
    if (trades.length === 0) break;
    all.push(...trades);
    startT = trades[trades.length - 1].timestamp + 1;
    if (trades.length < 500) break;
  }
  return all;
}

async function roundtripsFromPaperExits(Model, extraWhere = {}) {
  const exits = await Model.findAll({
    where: { type: 'EXIT', ...extraWhere },
    order: [['id', 'DESC']],
    limit: 5000,
    raw: true,
  });
  const entryIds = [...new Set(exits.map((r) => r.entryRowId).filter(Boolean))];
  let entryById = {};
  if (entryIds.length) {
    const ents = await Model.findAll({
      where: { id: entryIds },
      attributes: ['id', 'signalSpread', 'eventAt'],
      raw: true,
    });
    entryById = Object.fromEntries(ents.map((e) => [e.id, e]));
  }
  return exits.map((r) => ({
    exitId: r.id,
    entryRowId: r.entryRowId,
    sessionId: r.sessionId,
    zoneId: r.zoneId,
    gridLevel: r.gridLevel,
    qty: r.qty,
    entrySpread: r.entryRowId ? entryById[r.entryRowId]?.signalSpread ?? null : null,
    entryAt: r.entryRowId ? entryById[r.entryRowId]?.eventAt ?? null : null,
    exitSpread: r.signalSpread,
    deribitMid: r.deribitMid,
    hlMid: r.hlMid,
    pnlUsd: r.pnlUsd,
    holdSec: r.holdSec,
    exitReason: r.exitReason,
    exitAt: r.eventAt,
  }));
}

function _tsvLine(cells) {
  return cells
    .map((c) => {
      if (c == null) return '';
      const s = c instanceof Date ? c.toISOString() : String(c);
      return /\t|\n|\r/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join('\t');
}

function writeRoundtripsTxt(filePath, title, meta, pairKey, rows) {
  const lines = [
    `# ${title}`,
    `# exportedAt=${meta.exportedAt} botId=${meta.botId} pairKey=${pairKey}`,
    '',
    _tsvLine([
      'exitId',
      'entryRowId',
      'sessionId',
      'zoneId',
      'gridLevel',
      'qty',
      'entrySpread',
      'exitSpread',
      'pnlUsd',
      'holdSec',
      'exitReason',
      'entryAt',
      'exitAt',
      'deribitMid',
      'hlMid',
    ]),
  ];
  for (const r of rows) {
    lines.push(
      _tsvLine([
        r.exitId,
        r.entryRowId,
        r.sessionId,
        r.zoneId,
        r.gridLevel,
        r.qty,
        r.entrySpread,
        r.exitSpread,
        r.pnlUsd,
        r.holdSec,
        r.exitReason,
        r.entryAt,
        r.exitAt,
        r.deribitMid,
        r.hlMid,
      ]),
    );
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function writeLiveDbTxt(filePath, meta, rows) {
  const cols = [
    'id',
    'sessionId',
    'botId',
    'type',
    'entryRowId',
    'zoneId',
    'zoneIndex',
    'gridLevel',
    'qty',
    'signalSpread',
    'deribitMid',
    'hlMid',
    'pnlUsd',
    'holdSec',
    'exitReason',
    'deribitOrderId',
    'eventAt',
  ];
  const lines = [
    `# sol_live_trades botId=${meta.botId}`,
    `# exportedAt=${meta.exportedAt}`,
    '',
    _tsvLine(cols),
  ];
  for (const r of rows) {
    lines.push(_tsvLine(cols.map((c) => r[c])));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function writeDeribitTxt(filePath, meta, tradeAccount, fills) {
  const keys = [
    'timestamp',
    'trade_seq',
    'trade_id',
    'order_id',
    'instrument_name',
    'direction',
    'amount',
    'price',
    'fee',
    'liquidity',
    'profit_loss',
    'mark_price',
    'tick_direction',
    'reduce_only',
    'risk_reducing',
  ];
  const lines = [
    `# Deribit user trades ${meta.instrumentName}`,
    `# account=${tradeAccount} deribitAccountId=${meta.deribitAccountId} exportedAt=${meta.exportedAt}`,
    '',
    _tsvLine(keys),
  ];
  for (const f of fills) {
    lines.push(_tsvLine(keys.map((k) => f[k])));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function _fmtNum(n, d = 4) {
  if (n == null || !Number.isFinite(Number(n))) return 'n/a';
  return Number(n).toFixed(d);
}

function _section(title) {
  return `\n${'─'.repeat(72)}\n ${title}\n${'─'.repeat(72)}\n`;
}

/** Standard header for standalone analysis .txt files. */
function analysisDocHeader(titleLines, meta) {
  const tl = Array.isArray(titleLines) ? titleLines : [titleLines];
  return [
    '='.repeat(72),
    ...tl.map((t) => `  ${t}`),
    '='.repeat(72),
    `Generated (UTC): ${meta.exportedAt}`,
    `Bot id: ${meta.botId}   Deribit account id: ${meta.deribitAccountId}   Instrument: ${meta.instrumentName}`,
    `Raw trade exports: ${meta.includeRaw ? 'yes (--raw)' : 'no'}`,
    '',
  ].join('\n');
}

/** Map `up_i` / `down_i` → strategy tp/sl/trail from bot `startConfig` (reference only). */
function zoneConfigByZoneId(bot) {
  if (!bot?.startConfig) return null;
  let cfg;
  try {
    cfg = JSON.parse(bot.startConfig);
  } catch {
    return null;
  }
  const zg = cfg.zoneGrid;
  const zonesArr = Array.isArray(cfg.zones) ? cfg.zones : [];
  if (!zg || !Number.isFinite(Number(zg.anchorPrice))) return null;
  const count = Math.max(1, zg.zoneCount || 4);
  const map = {};
  for (let i = 0; i < count; i++) {
    const c = zonesArr[i] || {};
    const row = {
      tp: c.tp ?? 0.05,
      sl: c.sl ?? 1.0,
      trailPct: c.trailPct ?? 0.5,
      qty: c.qty ?? 1,
      maxPositions: c.maxPositions ?? 4,
    };
    map[`up_${i}`] = row;
    map[`down_${i}`] = row;
  }
  return map;
}

function aggregateFillsForInstrument(fills, instrument) {
  const out = {
    n: 0,
    volBoth: 0,
    buy: 0,
    sell: 0,
    notional: 0,
    fee: 0,
    pl: 0,
    nM: 0,
    nT: 0,
    feeM: 0,
    feeT: 0,
    feeMNegative: 0,
    feeMPositive: 0,
    rebateLikeM: 0,
  };
  for (const f of fills) {
    if ((f.instrument_name || '') !== instrument) continue;
    out.n++;
    const a = Math.abs(parseFloat(f.amount) || 0);
    const px = parseFloat(f.price) || 0;
    const fe = parseFloat(f.fee) || 0;
    out.volBoth += a;
    out.notional += a * px;
    out.fee += fe;
    out.pl += parseFloat(f.profit_loss) || 0;
    const d = (f.direction || '').toLowerCase();
    if (d === 'buy') out.buy += a;
    else if (d === 'sell') out.sell += a;
    const liq = (f.liquidity || '').toUpperCase();
    if (liq === 'M') {
      out.nM++;
      out.feeM += fe;
      if (fe < 0) {
        out.feeMNegative += fe;
        out.rebateLikeM += -fe;
      } else out.feeMPositive += fe;
    } else if (liq === 'T') {
      out.nT++;
      out.feeT += fe;
    }
  }
  return out;
}

/**
 * DB vs Deribit: volumes, fees/rebate split, EXIT order linkage, unmatched fills sample.
 */
function analyzeReconciliationExtended(liveRows, fills, instrument, botId) {
  const fl = fills || [];
  const entries = liveRows.filter((r) => r.type === 'ENTRY');
  const exits = liveRows.filter((r) => r.type === 'EXIT');
  const entryQty = entries.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);
  const exitQty = exits.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);
  const g = fl.length ? aggregateFillsForInstrument(fl, instrument) : null;

  const exitOrderIds = new Set(
    exits.filter((r) => r.deribitOrderId).map((r) => String(r.deribitOrderId)),
  );
  let fillsMatchedToExit = 0;
  const fillOrderIds = new Set();
  for (const f of fl) {
    if ((f.instrument_name || '') !== instrument) continue;
    const oid = f.order_id != null ? String(f.order_id) : '';
    if (oid) fillOrderIds.add(oid);
    if (oid && exitOrderIds.has(oid)) fillsMatchedToExit++;
  }

  const lines = [
    _section(`Exchange ↔ DB reconciliation (bot ${botId})`),
    `DB ENTRY rows / Σ|qty|:              ${entries.length} / ${_fmtNum(entryQty, 4)} SOL`,
    `DB EXIT rows  / Σ|qty|:              ${exits.length} / ${_fmtNum(exitQty, 4)} SOL`,
    `EXIT rows with deribitOrderId:       ${exitOrderIds.size} of ${exits.length}`,
  ];
  if (g && g.n) {
    lines.push(
      '',
      'Deribit (this instrument, same window):',
      `  Fill count:                        ${g.n}`,
      `  Two-way volume Σ|amount|:          ${_fmtNum(g.volBoth, 4)} SOL-contract notion`,
      `  Buy vol / Sell vol:                ${_fmtNum(g.buy, 4)} / ${_fmtNum(g.sell, 4)}`,
      `  Notional Σ|qty×px|:                $${_fmtNum(g.notional, 2)}`,
      `  Maker fills (M) / Taker (T):       ${g.nM} / ${g.nT}`,
      `  Sum fees (all legs):               $${_fmtNum(g.fee, 6)}`,
      `    Maker-leg fees:                  $${_fmtNum(g.feeM, 6)}  (negative portion = rebate-like credit)`,
      `      … negative sum on M:          $${_fmtNum(g.feeMNegative, 6)}  → rebate-like ≈ $${_fmtNum(g.rebateLikeM, 6)}`,
      `      … positive sum on M:          $${_fmtNum(g.feeMPositive, 6)}`,
      `    Taker-leg fees:                  $${_fmtNum(g.feeT, 6)}`,
      `  Sum profit_loss (API):             $${_fmtNum(g.pl, 6)}`,
      '',
      'Cross-check (short strategy: ENTRY adds short ≈ SELL; EXIT covers ≈ BUY):',
      `  DB ENTRY Σqty vs exchange SELL vol: ${_fmtNum(entryQty, 4)} vs ${_fmtNum(g.sell, 4)}  (Δ ${_fmtNum(entryQty - g.sell, 4)})`,
      `  DB EXIT Σqty  vs exchange BUY vol:  ${_fmtNum(exitQty, 4)} vs ${_fmtNum(g.buy, 4)}  (Δ ${_fmtNum(exitQty - g.buy, 4)})`,
      `  Fills whose order_id matches an EXIT row: ${fillsMatchedToExit} (partial fills / multi-leg can split counts)`,
    );
  } else {
    lines.push('', '(No Deribit fills in window — exchange lines skipped.)', '');
  }

  lines.push(
    '',
    'Residual SELL−BUY on exchange (open short if only this instrument):',
    g && g.n ? `  ${_fmtNum(g.sell - g.buy, 4)} SOL` : '  n/a',
    '',
    'Why DB and exchange totals differ: partial fills, multiple fills per order, manual trades,',
    '`reconcile_external_close` EXIT rows without in-window fill, ENTRY without stored order id.',
    '',
  );

  if (fl.length && exitOrderIds.size) {
    const unmatched = [];
    for (const f of fl) {
      if ((f.instrument_name || '') !== instrument) continue;
      const oid = f.order_id != null ? String(f.order_id) : '';
      if (!oid || exitOrderIds.has(oid)) continue;
      unmatched.push(f);
    }
    lines.push(`Exchange fills not matching any EXIT deribitOrderId: ${unmatched.length} (often ENTRY SELL / external).`);
    const sample = unmatched.slice(0, 12);
    if (sample.length) {
      lines.push('  Sample (time, dir, amt, fee, liq, order_id):');
      for (const f of sample) {
        const ts = Number.isFinite(f.timestamp) ? new Date(f.timestamp).toISOString() : '';
        lines.push(
          `    ${ts}  ${(f.direction || '').padEnd(4)} amt=${_fmtNum(f.amount, 4)} fee=$${_fmtNum(f.fee, 6)} ${(f.liquidity || '').padEnd(1)} ${f.order_id || ''}`,
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Per-zone trade analytics from `sol_live_trades`; optional `bot` adds strategy TP/SL reference.
 * Deribit: zone tagging via EXIT `deribitOrderId`; then full-window volume/rebate + reconciliation.
 */
function analyzeZoneTradeStats(liveRows, botId, fills, bot, instrument) {
  const entries = liveRows.filter((r) => r.type === 'ENTRY');
  const exits = liveRows.filter((r) => r.type === 'EXIT');
  const exitRefs = new Set(exits.map((e) => e.entryRowId).filter(Boolean));
  const openEntries = entries.filter((e) => !exitRefs.has(e.id));
  const zoneIds = [...new Set(liveRows.map((r) => r.zoneId || '(none)'))].sort((a, b) => String(a).localeCompare(String(b)));
  const cfgMap = zoneConfigByZoneId(bot);

  const lines = ['All aggregates below are from `sol_live_trades` (ENTRY/EXIT with zoneId / gridLevel).', ''];
  if (!liveRows.length) {
    lines.push('No rows for this bot.', '');
    return lines.join('\n');
  }

  for (const zid of zoneIds) {
    const ent = entries.filter((r) => (r.zoneId || '(none)') === zid);
    const ex = exits.filter((r) => (r.zoneId || '(none)') === zid);
    const openZ = openEntries.filter((r) => (r.zoneId || '(none)') === zid);
    const exPnl = ex.reduce((s, r) => s + (parseFloat(r.pnlUsd) || 0), 0);
    const entQty = ent.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);
    const exQty = ex.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);
    const wins = ex.filter((r) => (parseFloat(r.pnlUsd) || 0) > 0).length;
    const losses = ex.filter((r) => (parseFloat(r.pnlUsd) || 0) < 0).length;
    const holds = ex.map((r) => parseFloat(r.holdSec)).filter(Number.isFinite);
    const spreads = ent.map((r) => parseFloat(r.signalSpread)).filter(Number.isFinite);

    lines.push(`-- zone ${zid} --`);
    lines.push(
      `  ENTRY: ${ent.length}  Σqty=${_fmtNum(entQty, 4)}   signalSpread @entry: min/avg/max=${spreads.length ? _fmtNum(Math.min(...spreads), 4) : 'n/a'} / ${_fmtNum(spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0, 4)} / ${spreads.length ? _fmtNum(Math.max(...spreads), 4) : 'n/a'}`,
    );
    lines.push(
      `  EXIT:  ${ex.length}  Σqty=${_fmtNum(exQty, 4)}   ΣpnlUsd=$${_fmtNum(exPnl, 4)}   W/L=${wins}/${losses}${
        holds.length
          ? `   holdSec min/med/max=${_fmtNum(Math.min(...holds), 1)} / ${_fmtNum(_median(holds) || 0, 1)} / ${_fmtNum(Math.max(...holds), 1)}`
          : ''
      }`,
    );
    lines.push(
      `  OPEN:  ${openZ.length}  Σqty=${_fmtNum(openZ.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0), 4)}  (ENTRY without matching EXIT)`,
    );

    const byReason = {};
    for (const r of ex) {
      const k = r.exitReason || '(none)';
      byReason[k] = byReason[k] || { n: 0, pnl: 0 };
      byReason[k].n++;
      byReason[k].pnl += parseFloat(r.pnlUsd) || 0;
    }
    if (ex.length) {
      lines.push('  EXIT by reason:');
      for (const [reason, o] of Object.entries(byReason).sort((a, b) => b[1].n - a[1].n)) {
        lines.push(`    ${String(reason).padEnd(22)} n=${o.n}  sum=$${_fmtNum(o.pnl, 4)}`);
      }
      const nTp = byReason.trailing_tp?.n ?? 0;
      const pTp = byReason.trailing_tp?.pnl ?? 0;
      const nSl = byReason.stop_loss?.n ?? 0;
      const pSl = byReason.stop_loss?.pnl ?? 0;
      lines.push(
        `  Realized TP vs SL (by exitReason):  trailing_tp n=${nTp} sum=$${_fmtNum(pTp, 4)}  |  stop_loss n=${nSl} sum=$${_fmtNum(pSl, 4)}`,
      );
    }
    const zc = cfgMap && cfgMap[zid];
    if (zc) {
      lines.push(
        `  Strategy TP/SL reference (startConfig): tp(spread)=${zc.tp}  sl=${zc.sl}  trailPct=${zc.trailPct}%  bandQty=${zc.qty}  maxPos=${zc.maxPositions}`,
      );
    }

    const levels = [
      ...new Set([...ent, ...ex, ...openZ].map((r) => r.gridLevel).filter((x) => x != null)),
    ].sort((a, b) => a - b);
    if (levels.length) {
      lines.push('  By gridLevel:');
      for (const lv of levels) {
        const eN = ent.filter((r) => r.gridLevel === lv).length;
        const xR = ex.filter((r) => r.gridLevel === lv);
        const xP = xR.reduce((s, r) => s + (parseFloat(r.pnlUsd) || 0), 0);
        const oN = openZ.filter((r) => r.gridLevel === lv).length;
        lines.push(
          `    level ${String(lv).padEnd(4)}  ENTRY=${eN}  EXIT=${xR.length}  ΣexitPnl=$${_fmtNum(xP, 4)}  openENTRY=${oN}`,
        );
      }
    }

    if (ex.length) {
      let best = ex[0];
      let worst = ex[0];
      for (const r of ex) {
        const p = parseFloat(r.pnlUsd) || 0;
        if (p > (parseFloat(best.pnlUsd) || 0)) best = r;
        if (p < (parseFloat(worst.pnlUsd) || 0)) worst = r;
      }
      lines.push(
        `  Best exit:  $${_fmtNum(parseFloat(best.pnlUsd) || 0, 4)}  row id=${best.id}  reason=${best.exitReason || ''}  lvl=${best.gridLevel}`,
        `  Worst exit: $${_fmtNum(parseFloat(worst.pnlUsd) || 0, 4)}  row id=${worst.id}  reason=${worst.exitReason || ''}  lvl=${worst.gridLevel}`,
      );
    }
    lines.push('');
  }

  if (fills && fills.length && instrument) {
    lines.push(_section('Deribit fills tagged by zone (EXIT order_id only)'));
    lines.push(
      'ENTRY rows usually have no `deribitOrderId`; per-zone exchange lines only count fills whose `order_id` matches an EXIT row.',
      '',
    );
    const exitRows = exits.filter((r) => r.deribitOrderId);
    const orderToZone = new Map(exitRows.map((r) => [String(r.deribitOrderId), r.zoneId || '(none)']));
    const byZ = {};
    let matched = 0;
    for (const f of fills) {
      if ((f.instrument_name || '') !== instrument) continue;
      const oid = f.order_id != null ? String(f.order_id) : '';
      if (!oid || !orderToZone.has(oid)) continue;
      matched++;
      const z = orderToZone.get(oid);
      const o = byZ[z] || {
        n: 0,
        fee: 0,
        pl: 0,
        vol: 0,
        notional: 0,
        feeM: 0,
        feeT: 0,
        nM: 0,
        nT: 0,
        buy: 0,
        sell: 0,
      };
      const a = Math.abs(parseFloat(f.amount) || 0);
      const px = parseFloat(f.price) || 0;
      const fe = parseFloat(f.fee) || 0;
      o.n++;
      o.fee += fe;
      o.pl += parseFloat(f.profit_loss) || 0;
      o.vol += a;
      o.notional += a * px;
      const liq = (f.liquidity || '').toUpperCase();
      if (liq === 'M') {
        o.nM++;
        o.feeM += fe;
      } else if (liq === 'T') {
        o.nT++;
        o.feeT += fe;
      }
      const d = (f.direction || '').toLowerCase();
      if (d === 'buy') o.buy += a;
      else if (d === 'sell') o.sell += a;
      byZ[z] = o;
    }
    lines.push(`Fills matched to an EXIT order_id: ${matched} of ${fills.length} in window (instrument-filtered).`, '');
    for (const z of Object.keys(byZ).sort((a, b) => String(a).localeCompare(String(b)))) {
      const o = byZ[z];
      lines.push(
        `  ${String(z).padEnd(12)}  fills=${o.n}  vol=${_fmtNum(o.vol, 4)}  notional≈$${_fmtNum(o.notional, 2)}  buy/sell=${_fmtNum(o.buy, 2)}/${_fmtNum(o.sell, 2)}`,
        `               sum_fee=$${_fmtNum(o.fee, 6)} (maker $${_fmtNum(o.feeM, 6)} / taker $${_fmtNum(o.feeT, 6)})  sum_pl=$${_fmtNum(o.pl, 6)}  M/T fills=${o.nM}/${o.nT}`,
      );
    }
    lines.push('');
    lines.push(analyzeReconciliationExtended(liveRows, fills, instrument, botId));
  } else if (instrument) {
    lines.push(analyzeReconciliationExtended(liveRows, fills || [], instrument, botId));
  }

  return lines.join('\n');
}

/** Short grid: adds = SELL. "Closes" = BUY or exchange-flagged risk/reduce-only fills. */
function isOneSolOpenLegFill(f) {
  const ro = f.reduce_only === true;
  const rr = f.risk_reducing === true;
  if (ro || rr) return false;
  const d = (f.direction || '').toLowerCase();
  if (d !== 'sell') return false;
  const a = Math.abs(parseFloat(f.amount) || 0);
  return Math.abs(a - 1) < 1e-8;
}

function analyzeRoundtripsComplete(title, pairKey, rows) {
  const n = rows.length;
  if (n === 0) {
    return `${_section(`${title} — full analysis (${pairKey})`)}\nNo closed round-trips in sample.\n`;
  }
  let pnl = 0;
  let qtyAbs = 0;
  const byReason = {};
  const byZone = {};
  const byLevel = {};
  const sessions = new Set();
  const wins = [];
  const losses = [];
  const holds = [];
  let tMin = Infinity;
  let tMax = -Infinity;
  let best = null;
  let worst = null;
  for (const r of rows) {
    const p = parseFloat(r.pnlUsd) || 0;
    const q = Math.abs(parseFloat(r.qty) || 0);
    pnl += p;
    qtyAbs += q;
    const reason = r.exitReason || '(none)';
    byReason[reason] = byReason[reason] || { count: 0, pnl: 0 };
    byReason[reason].count++;
    byReason[reason].pnl += p;
    const z = r.zoneId || '(none)';
    byZone[z] = byZone[z] || { n: 0, pnl: 0 };
    byZone[z].n++;
    byZone[z].pnl += p;
    const lv = r.gridLevel != null ? String(r.gridLevel) : '?';
    byLevel[lv] = byLevel[lv] || { n: 0, pnl: 0 };
    byLevel[lv].n++;
    byLevel[lv].pnl += p;
    if (r.sessionId) sessions.add(r.sessionId);
    if (p > 0) wins.push(p);
    else if (p < 0) losses.push(p);
    const h = parseFloat(r.holdSec);
    if (Number.isFinite(h)) holds.push(h);
    const ex = r.exitAt ? new Date(r.exitAt).getTime() : NaN;
    if (Number.isFinite(ex)) {
      tMin = Math.min(tMin, ex);
      tMax = Math.max(tMax, ex);
    }
    if (best == null || p > best.p) best = { p, exitId: r.exitId, zone: r.zoneId, lvl: r.gridLevel, reason };
    if (worst == null || p < worst.p) worst = { p, exitId: r.exitId, zone: r.zoneId, lvl: r.gridLevel, reason };
  }
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = losses.reduce((a, b) => a + b, 0);
  const pf = sumL < 0 ? sumW / Math.abs(sumL) : sumW > 0 ? Infinity : 0;
  const lines = [
    _section(`${title} — full analysis (${pairKey})`),
    `Round trips (closed):        ${n}`,
    `Distinct paper sessions:     ${sessions.size}`,
    `Total PnL (sum pnlUsd):      $${_fmtNum(pnl, 4)}`,
    `Contracts exited (Σ|qty|):  ${_fmtNum(qtyAbs, 4)}`,
    `PnL / contract (approx):    $${_fmtNum(qtyAbs > 0 ? pnl / qtyAbs : 0, 6)}`,
    `Win rate:                    ${_pct(wins.length, n)}%  (${wins.length}W / ${losses.length}L / ${n - wins.length - losses.length} flat)`,
    `Avg win / Avg loss:          $${_fmtNum(wins.length ? sumW / wins.length : 0, 4)} / $${_fmtNum(losses.length ? sumL / losses.length : 0, 4)}`,
    `Profit factor (gross W/|L|): ${pf === Infinity ? '∞ (no losing trades)' : _fmtNum(pf, 3)}`,
    `Hold (sec) min / med / max:  ${_fmtNum(holds.length ? Math.min(...holds) : 0, 1)} / ${_fmtNum(_median(holds) || 0, 1)} / ${_fmtNum(holds.length ? Math.max(...holds) : 0, 1)}`,
    `Best single trade:           $${_fmtNum(best.p, 4)}  (exitId=${best.exitId} zone=${best.zone} lvl=${best.lvl} ${best.reason})`,
    `Worst single trade:          $${_fmtNum(worst.p, 4)}  (exitId=${worst.exitId} zone=${worst.zone} lvl=${worst.lvl} ${worst.reason})`,
  ];
  if (Number.isFinite(tMin) && Number.isFinite(tMax) && tMax >= tMin) {
    lines.push(`Exit window (UTC):           ${new Date(tMin).toISOString()}  →  ${new Date(tMax).toISOString()}`);
  }
  lines.push('', 'By exitReason:');
  for (const [reason, o] of Object.entries(byReason).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`  ${reason.padEnd(26)} n=${String(o.count).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}  avg=$${_fmtNum(o.count ? o.pnl / o.count : 0, 4)}`);
  }
  lines.push('', 'By zoneId (PnL contribution):');
  for (const [z, o] of Object.entries(byZone).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
    lines.push(`  ${z.padEnd(14)} n=${String(o.n).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}`);
  }
  lines.push('', 'By gridLevel:');
  for (const lv of Object.keys(byLevel).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const o = byLevel[lv];
    lines.push(`  level ${lv.padEnd(4)} n=${String(o.n).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function analyzeLiveDbComplete(rows, botId) {
  const entries = rows.filter((r) => r.type === 'ENTRY');
  const exits = rows.filter((r) => r.type === 'EXIT');
  const pnlSum = exits.reduce((s, r) => s + (parseFloat(r.pnlUsd) || 0), 0);
  const exitRefs = new Set(exits.map((r) => r.entryRowId).filter(Boolean));
  const orphanEntries = entries.filter((e) => !exitRefs.has(e.id));
  const byReason = {};
  for (const r of exits) {
    const k = r.exitReason || '(none)';
    byReason[k] = byReason[k] || { n: 0, pnl: 0, qty: 0 };
    byReason[k].n++;
    byReason[k].pnl += parseFloat(r.pnlUsd) || 0;
    byReason[k].qty += Math.abs(parseFloat(r.qty) || 0);
  }
  const byZone = {};
  for (const r of rows) {
    const z = r.zoneId || '(none)';
    byZone[z] = (byZone[z] || 0) + 1;
  }
  const exitByZone = {};
  for (const r of exits) {
    const z = r.zoneId || '(none)';
    exitByZone[z] = exitByZone[z] || { n: 0, pnl: 0 };
    exitByZone[z].n++;
    exitByZone[z].pnl += parseFloat(r.pnlUsd) || 0;
  }
  const exitByLvl = {};
  for (const r of exits) {
    const lv = r.gridLevel != null ? String(r.gridLevel) : '?';
    exitByLvl[lv] = exitByLvl[lv] || { n: 0, pnl: 0 };
    exitByLvl[lv].n++;
    exitByLvl[lv].pnl += parseFloat(r.pnlUsd) || 0;
  }
  const sess = new Set(rows.map((r) => r.sessionId).filter(Boolean));
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const r of rows) {
    const t = r.eventAt ? new Date(r.eventAt).getTime() : NaN;
    if (Number.isFinite(t)) {
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
  }
  const wins = exits.filter((r) => (parseFloat(r.pnlUsd) || 0) > 0);
  const losses = exits.filter((r) => (parseFloat(r.pnlUsd) || 0) < 0);
  const entryQty = entries.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);
  const exitQty = exits.reduce((s, r) => s + Math.abs(parseFloat(r.qty) || 0), 0);

  const lines = [
    _section(`Live SOL bot ${botId} — database full analysis (sol_live_trades)`),
    `Distinct sessionId values:  ${sess.size}`,
    `ENTRY rows / EXIT rows:     ${entries.length} / ${exits.length}`,
    `ENTRY Σ|qty| / EXIT Σ|qty|: ${_fmtNum(entryQty, 4)} / ${_fmtNum(exitQty, 4)} SOL`,
    `EXIT-only PnL (sum pnlUsd): $${_fmtNum(pnlSum, 4)}`,
    `EXIT win / loss / zero:     ${wins.length} / ${losses.length} / ${exits.length - wins.length - losses.length}`,
    `ENTRY without matching EXIT (orphan id): ${orphanEntries.length}  (should be 0 after clean reconcile; open shorts not yet closed)`,
  ];
  if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
    lines.push(`DB event window (UTC):        ${new Date(t0).toISOString()}  →  ${new Date(t1).toISOString()}`);
  }
  lines.push('', 'EXIT by reason:');
  for (const [k, o] of Object.entries(byReason).sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`  ${k.padEnd(26)} n=${String(o.n).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}  qty=${_fmtNum(o.qty, 4)}`);
  }
  lines.push('', 'EXIT PnL by zoneId:');
  for (const [z, o] of Object.entries(exitByZone).sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
    lines.push(`  ${z.padEnd(14)} n=${String(o.n).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}`);
  }
  lines.push('', 'EXIT PnL by gridLevel:');
  for (const lv of Object.keys(exitByLvl).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const o = exitByLvl[lv];
    lines.push(`  level ${lv.padEnd(4)} n=${String(o.n).padStart(4)}  sum=$${_fmtNum(o.pnl, 4)}`);
  }
  lines.push('', 'Row counts by zoneId (ENTRY+EXIT):');
  for (const [z, c] of Object.entries(byZone).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${z.padEnd(16)} ${c}`);
  }
  lines.push('');
  lines.push('Note: Per-row dumps are optional; run script with --raw for JSON/TSV.');
  lines.push('');
  return lines.join('\n');
}

function analyzeDeribitComplete(fills, tradeAccount, instrument, startMs, endMs, windowNote, options = {}) {
  const sectionTitle = options.sectionTitle || 'Deribit exchange — full analysis (user fills)';
  if (!fills.length) {
    return `${_section(sectionTitle)}Trade account: ${tradeAccount || 'n/a'}\nInstrument:    ${instrument}\n${windowNote || ''}\nWindow (UTC):  ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}\nFills:         0\n`;
  }
  let fee = 0;
  let pl = 0;
  let buyAmt = 0;
  let sellAmt = 0;
  let notional = 0;
  let maker = 0;
  let taker = 0;
  const orders = new Set();
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const f of fills) {
    fee += parseFloat(f.fee) || 0;
    pl += parseFloat(f.profit_loss) || 0;
    const a = Math.abs(parseFloat(f.amount) || 0);
    const px = parseFloat(f.price) || 0;
    notional += a * px;
    const d = (f.direction || '').toLowerCase();
    if (d === 'buy') buyAmt += a;
    else if (d === 'sell') sellAmt += a;
    const liq = (f.liquidity || '').toUpperCase();
    if (liq === 'M') maker++;
    else if (liq === 'T') taker++;
    if (f.order_id) orders.add(f.order_id);
    const ts = f.timestamp;
    if (Number.isFinite(ts)) {
      tMin = Math.min(tMin, ts);
      tMax = Math.max(tMax, ts);
    }
  }
  const lines = [
    _section(sectionTitle),
    windowNote || '',
    `Trade account:              ${tradeAccount || 'n/a'}`,
    `Instrument:                 ${instrument}`,
    `Requested window (UTC):     ${new Date(startMs).toISOString()}  →  ${new Date(endMs).toISOString()}`,
    `First / last fill (UTC):    ${Number.isFinite(tMin) ? new Date(tMin).toISOString() : 'n/a'}  →  ${Number.isFinite(tMax) ? new Date(tMax).toISOString() : 'n/a'}`,
    `Fill count:                 ${fills.length}`,
    `Distinct order_id:          ${orders.size}`,
    `Liquidity M / T / other:    ${maker} / ${taker} / ${fills.length - maker - taker}`,
    `Sum fees (API field):       $${_fmtNum(fee, 6)}`,
    `Sum profit_loss (API):      $${_fmtNum(pl, 6)}`,
    `Buy contracts / Sell:       ${_fmtNum(buyAmt, 4)} / ${_fmtNum(sellAmt, 4)}`,
    `Net flow (buy−sell) SOL:    ${_fmtNum(buyAmt - sellAmt, 4)}  (positive ≈ reduced short or added long)`,
    `Approx notional Σ|qty×px|:  $${_fmtNum(notional, 2)}`,
    '',
  ];
  const gx = aggregateFillsForInstrument(fills, instrument);
  lines.push(
    `Maker-leg fees / Taker-leg fees: $${_fmtNum(gx.feeM, 6)} / $${_fmtNum(gx.feeT, 6)}`,
    `Rebate-like on maker legs (Σ max(0, −fee) on M): ≈ $${_fmtNum(gx.rebateLikeM, 6)}`,
    '',
    'Interpretation: SELL fills add to short; BUY reduce short. Compare net to DB inventory / orphan ENTRYs.',
    'Manual trades or other strategies on the same instrument appear here too.',
    '',
  );
  return lines.join('\n');
}

/** Extra metrics on Deribit fills only (chronological array). */
function analyzeExchangeExtended(fills) {
  if (!fills.length) return '';
  const byDay = {};
  for (const f of fills) {
    const ts = f.timestamp;
    if (!Number.isFinite(ts)) continue;
    const dk = new Date(ts).toISOString().slice(0, 10);
    byDay[dk] = byDay[dk] || { n: 0, fee: 0, pl: 0, buy: 0, sell: 0 };
    byDay[dk].n++;
    byDay[dk].fee += parseFloat(f.fee) || 0;
    byDay[dk].pl += parseFloat(f.profit_loss) || 0;
    const d = (f.direction || '').toLowerCase();
    const a = Math.abs(parseFloat(f.amount) || 0);
    if (d === 'buy') byDay[dk].buy += a;
    else if (d === 'sell') byDay[dk].sell += a;
  }
  let cum = 0;
  let cumMin = 0;
  let cumMax = 0;
  for (const f of fills) {
    cum += parseFloat(f.profit_loss) || 0;
    cumMin = Math.min(cumMin, cum);
    cumMax = Math.max(cumMax, cum);
  }
  const topFee = [...fills]
    .map((f) => ({ ...f, _feeAbs: Math.abs(parseFloat(f.fee) || 0) }))
    .sort((a, b) => b._feeAbs - a._feeAbs)
    .slice(0, 10);
  const lines = [
    _section('Exchange-only — extended'),
    'Cumulative profit_loss (chronological, first→last fill in window):',
    `  Ending cumulative: $${_fmtNum(cum, 6)}  (running min $${_fmtNum(cumMin, 6)} / max $${_fmtNum(cumMax, 6)})`,
    '',
    'By calendar day (UTC):',
  ];
  for (const dk of Object.keys(byDay).sort()) {
    const o = byDay[dk];
    lines.push(
      `  ${dk}  fills=${String(o.n).padStart(3)}  sum_pl=$${_fmtNum(o.pl, 4)}  sum_fee=$${_fmtNum(o.fee, 6)}  buy/sell=${_fmtNum(o.buy, 2)}/${_fmtNum(o.sell, 2)}`,
    );
  }
  lines.push('', 'Top 10 fills by |fee| (timestamp, dir, amount, price, fee, liq, order_id):');
  for (const f of topFee) {
    const ts = Number.isFinite(f.timestamp) ? new Date(f.timestamp).toISOString() : '';
    lines.push(
      `  ${ts}  ${(f.direction || '').padEnd(4)} amt=${_fmtNum(f.amount, 4)} px=${_fmtNum(f.price, 4)} fee=$${_fmtNum(f.fee, 6)} ${(f.liquidity || '').padEnd(1)} oid=${f.order_id || ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Exchange window = first sol_live_trades row for this bot (MIN(eventAt)), inclusive — no padding,
 * not anchored on SolLiveBot.createdAt. If no rows, use rolling lookback.
 */
async function resolveExchangeWindowMs(botId) {
  const endMs = Date.now();
  const firstTrade = await SolLiveTrade.findOne({
    where: { botId },
    order: [['eventAt', 'ASC']],
    attributes: ['eventAt', 'id'],
    raw: true,
  });
  const tTrade = firstTrade?.eventAt ? new Date(firstTrade.eventAt).getTime() : null;
  if (tTrade != null) {
    return {
      startMs: tTrade,
      endMs,
      firstRowId: firstTrade.id,
      note:
        `Exchange window: first sol_live_trades row for bot ${botId} → now.\n` +
        `  eventAt (UTC): ${new Date(tTrade).toISOString()}  row id=${firstTrade.id}`,
    };
  }
  return {
    startMs: endMs - DERIBIT_LOOKBACK_MS,
    endMs,
    firstRowId: null,
    note: `No sol_live_trades rows for bot ${botId}; using rolling ${DERIBIT_LOOKBACK_MS / 86400000}d for exchange.`,
  };
}

function parseArgvPairs(argv) {
  const pairsArg = argv.find((a) => /^--pairs=/.test(a));
  if (!pairsArg) return null;
  const list = pairsArg
    .slice('--pairs='.length)
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return list.length ? list : null;
}

function parseSnapshotTailMax(argv) {
  const tailArg = argv.find((a) => /^--snapshot-tail=/.test(a));
  if (!tailArg) return 4000;
  const v = tailArg.slice('--snapshot-tail='.length).trim().toLowerCase();
  if (v === 'full' || v === 'all' || v === '0') return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(50000, Math.max(0, n)) : 4000;
}

function parseSnapshotIndividualMax(argv) {
  const indEq = argv.find((a) => /^--snapshot-individual=/.test(a));
  if (indEq) {
    const v = indEq.slice('--snapshot-individual='.length).trim().toLowerCase();
    if (v === 'full' || v === 'all' || v === '0') return 0;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(50000, Math.max(0, n)) : 20000;
  }
  if (argv.some((a) => a === '--snapshot-individual')) return 20000;
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const includeRaw = argv.includes('--raw');
  const paperOnly = argv.includes('--paper-only');
  const liveOnly = argv.includes('--live-only');
  const wantedPairs = parseArgvPairs(argv);
  const writeSolAnalysis = !wantedPairs || wantedPairs.includes('SOL');
  const snapshotTailMax = parseSnapshotTailMax(argv);
  const snapshotIndividualMax = parseSnapshotIndividualMax(argv);

  if (paperOnly && liveOnly) {
    console.error('Cannot combine --paper-only and --live-only');
    process.exit(1);
  }

  const numArg = argv.find((a) => /^\d+$/.test(a));
  const botId = Math.max(1, parseInt(numArg || '4', 10) || 4);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

  const bot = await SolLiveBot.findByPk(botId);
  const accountId = bot?.deribitAccountId ?? 3;
  const instrument = (bot?.instrumentName && String(bot.instrumentName).trim()) || INSTRUMENT;

  const { startMs: exchangeStartMsEarly, endMs: exchangeEndMsEarly, note: exchangeNoteEarly, firstRowId } =
    await resolveExchangeWindowMs(botId);
  const meta = {
    exportedAt: new Date().toISOString(),
    botId,
    deribitAccountId: accountId,
    instrumentName: instrument,
    exchangeWindow: {
      startMs: exchangeStartMsEarly,
      endMs: exchangeEndMsEarly,
      firstSolLiveRowId: firstRowId,
      note: exchangeNoteEarly,
    },
    includeRaw,
    paperOnly,
    liveOnly,
    wantedPairs,
  };

  const txtPaths = { solPaper: null, crossPaper: [], liveDb: null, deribitFills: null };
  let solPath = null;
  let livePath = null;
  let derPath = null;
  const crossByPair = {};
  let solRoundtrips = [];

  // ── SOL paper (all sessions, capped) ─────────────────────────────────────
  if (!liveOnly) {
  const solPaperExits = await SolPaperTrade.findAll({
    where: { type: 'EXIT' },
    order: [['id', 'DESC']],
    limit: 5000,
    raw: true,
  });
  const solEntryIds = [...new Set(solPaperExits.map((r) => r.entryRowId).filter(Boolean))];
  let solEntryById = {};
  if (solEntryIds.length) {
    const ents = await SolPaperTrade.findAll({
      where: { id: solEntryIds },
      attributes: ['id', 'signalSpread', 'eventAt', 'sessionId'],
      raw: true,
    });
    solEntryById = Object.fromEntries(ents.map((e) => [e.id, e]));
  }
  solRoundtrips = solPaperExits.map((r) => ({
    pairKey: 'SOL',
    exitId: r.id,
    entryRowId: r.entryRowId,
    sessionId: r.sessionId,
    zoneId: r.zoneId,
    gridLevel: r.gridLevel,
    qty: r.qty,
    entrySpread: r.entryRowId ? solEntryById[r.entryRowId]?.signalSpread ?? null : null,
    entryAt: r.entryRowId ? solEntryById[r.entryRowId]?.eventAt ?? null : null,
    exitSpread: r.signalSpread,
    pnlUsd: r.pnlUsd,
    holdSec: r.holdSec,
    exitReason: r.exitReason,
    exitAt: r.eventAt,
  }));
  if (includeRaw) {
    solPath = path.join(REPORT_DIR, `paper_sol_${ts}.json`);
    fs.writeFileSync(
      solPath,
      JSON.stringify({ ...meta, source: 'sol_paper_trades', roundtripCount: solRoundtrips.length, roundtrips: solRoundtrips }, null, 2),
      'utf8',
    );
    const solTxtPath = path.join(REPORT_DIR, `paper_sol_${ts}.txt`);
    writeRoundtripsTxt(solTxtPath, 'SOL paper (sol_paper_trades)', meta, 'SOL', solRoundtrips);
    txtPaths.solPaper = solTxtPath;
    console.log(`[raw] ${solPath} + ${path.basename(solTxtPath)} (${solRoundtrips.length} roundtrips)`);
  }
  }

  // ── Cross paper per pair ───────────────────────────────────────────────────
  let pairKeys = [];
  if (!liveOnly) {
  try {
    const rows = await sequelize.query(
      'SELECT DISTINCT pairKey AS pairKey FROM cross_paper_trades ORDER BY pairKey',
      { type: QueryTypes.SELECT },
    );
    pairKeys = rows.map((r) => r.pairKey).filter(Boolean);
  } catch (_) {
    pairKeys = [];
  }
  if (pairKeys.length === 0) {
    pairKeys = ['ETH', 'BTC', 'XRP', 'AVAX', 'PAXG'];
  }
  const defaultPairs = ['ETH', 'BTC', 'XRP', 'AVAX', 'PAXG'];
  pairKeys = [...new Set([...defaultPairs, ...pairKeys])];
  if (wantedPairs && wantedPairs.length) {
    const crossW = wantedPairs.filter((p) => p !== 'SOL');
    pairKeys = crossW.length ? pairKeys.filter((pk) => crossW.includes(pk)) : [];
  }
  for (const pk of pairKeys) {
    const roundtrips = await roundtripsFromPaperExits(CrossPaperTrade, { pairKey: pk });
    crossByPair[pk] = roundtrips;
    if (includeRaw) {
      const outPath = path.join(REPORT_DIR, `paper_cross_${pk}_${ts}.json`);
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          { ...meta, source: 'cross_paper_trades', pairKey: pk, roundtripCount: roundtrips.length, roundtrips },
          null,
          2,
        ),
        'utf8',
      );
      const crossTxt = path.join(REPORT_DIR, `paper_cross_${pk}_${ts}.txt`);
      writeRoundtripsTxt(crossTxt, `Cross paper ${pk} (cross_paper_trades)`, meta, pk, roundtrips);
      txtPaths.crossPaper.push(crossTxt);
      console.log(`[raw] ${outPath} + ${path.basename(crossTxt)} (${roundtrips.length} roundtrips)`);
    }
  }
  }

  // ── Live DB bot rows ───────────────────────────────────────────────────────
  const liveRows = await SolLiveTrade.findAll({
    where: { botId },
    order: [['id', 'ASC']],
    raw: true,
  });
  if (includeRaw) {
    livePath = path.join(REPORT_DIR, `live_bot${botId}_db_${ts}.json`);
    fs.writeFileSync(
      livePath,
      JSON.stringify({ ...meta, source: 'sol_live_trades', rowCount: liveRows.length, rows: liveRows }, null, 2),
      'utf8',
    );
    const liveTxtPath = path.join(REPORT_DIR, `live_bot${botId}_db_${ts}.txt`);
    writeLiveDbTxt(liveTxtPath, meta, liveRows);
    txtPaths.liveDb = liveTxtPath;
    console.log(`[raw] ${livePath} + ${path.basename(liveTxtPath)} (${liveRows.length} rows)`);
  }

  // ── Deribit (window from bot / first DB activity; raw dumps only with --raw) ─
  let fills = [];
  let tradeAccount = '';
  let deribitErr = null;
  try {
    const creds = await loadDeribitKeys(accountId);
    tradeAccount = creds.tradeAccount;
    fills = await fetchDeribitUserTrades(creds.apiKey, creds.secretKey, instrument, exchangeStartMsEarly, exchangeEndMsEarly);
    if (includeRaw) {
      derPath = path.join(REPORT_DIR, `live_bot${botId}_deribit_${instrument.replace(/[^A-Z0-9_-]+/gi, '_')}_${ts}.json`);
      fs.writeFileSync(
        derPath,
        JSON.stringify(
          {
            ...meta,
            source: 'deribit_api',
            tradeAccount,
            window: {
              startMs: exchangeStartMsEarly,
              endMs: exchangeEndMsEarly,
              note: exchangeNoteEarly,
            },
            fillCount: fills.length,
            fills,
          },
          null,
          2,
        ),
        'utf8',
      );
      const derTxtPath = derPath.replace(/\.json$/i, '.txt');
      writeDeribitTxt(derTxtPath, meta, tradeAccount, fills);
      txtPaths.deribitFills = derTxtPath;
      console.log(`[raw] ${derPath} + ${path.basename(derTxtPath)} (${fills.length} fills)`);
    }
  } catch (e) {
    deribitErr = e.message;
    console.error(`Deribit fetch: ${e.message}`);
  }

  if (liveOnly) {
    const liveSolCompletePath = path.join(REPORT_DIR, `report_bot${botId}_live_sol_complete_${ts}.txt`);
    const zonesAndRecon = analyzeZoneTradeStats(liveRows, botId, deribitErr ? null : fills, bot, instrument);
    const completeParts = [
      analysisDocHeader(
        ['LIVE SOL — complete analysis', '(sol_live_trades + Deribit; zones, TP/SL, DB↔exchange)'],
        meta,
      ),
      'Sections: (1) database summary  (2) zones / TP-SL / grid + DB↔exchange reconciliation  (3) full exchange fills  (4) 1-SOL open legs.',
      '',
      'Exchange: Deribit `get_user_trades_by_instrument_and_time` (fills).',
      '',
      exchangeNoteEarly,
      '',
      analyzeLiveDbComplete(liveRows, botId),
      '',
      zonesAndRecon,
    ];
    if (deribitErr) {
      completeParts.push('', `Deribit API error: ${deribitErr}`);
    } else {
      completeParts.push(
        '',
        analyzeDeribitComplete(fills, tradeAccount, instrument, exchangeStartMsEarly, exchangeEndMsEarly, ''),
        analyzeExchangeExtended(fills),
      );
      const oneSolOpens = fills.filter(isOneSolOpenLegFill);
      completeParts.push(
        _section('Exchange — 1 SOL opening legs only (excludes position closes)'),
        'Short-grid semantics: new exposure = SELL. Covers / exits = BUY — omitted here.',
        'Also omitted: reduce_only or risk_reducing fills, and any SELL size ≠ 1.',
        `Matching fills: ${oneSolOpens.length} of ${fills.length} in window.`,
        '',
      );
      completeParts.push(
        analyzeDeribitComplete(oneSolOpens, tradeAccount, instrument, exchangeStartMsEarly, exchangeEndMsEarly, '', {
          sectionTitle: 'Deribit — 1 SOL SELL open legs only (filtered)',
        }),
        analyzeExchangeExtended(oneSolOpens),
      );
    }
    fs.writeFileSync(liveSolCompletePath, completeParts.join('\n') + '\n', 'utf8');
    console.log(`Wrote ${liveSolCompletePath}`);

    const summaryPath = path.join(REPORT_DIR, `report_index_${ts}.json`);
    const indexPayload = {
      ...meta,
      includeRaw,
      mode: 'live-only',
      liveSolCompleteReport: liveSolCompletePath,
      raw: includeRaw
        ? {
            liveDbJson: livePath,
            liveDbTsv: txtPaths.liveDb,
            deribitJson: derPath,
            deribitTsv: txtPaths.deribitFills,
          }
        : null,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(indexPayload, null, 2), 'utf8');

    const summaryTxtPath = path.join(REPORT_DIR, `report_index_${ts}.txt`);
    const indexLines = [
      `Report index ${ts} (live-only)`,
      `exportedAt=${meta.exportedAt} botId=${botId}`,
      '',
      'Complete live SOL report:',
      `  ${liveSolCompletePath}`,
      '',
      `JSON index: ${summaryPath}`,
      '',
    ];
    if (includeRaw) {
      indexLines.push('Raw (--raw), live paths only:');
      if (livePath) indexLines.push(`  ${livePath}`);
      if (derPath) indexLines.push(`  ${derPath}`);
      indexLines.push(`  live TSV: ${txtPaths.liveDb || '(none)'}`, `  deribit TSV: ${txtPaths.deribitFills || '(none)'}`, '');
    }
    fs.writeFileSync(summaryTxtPath, indexLines.join('\n') + '\n', 'utf8');
    console.log(`Wrote ${summaryPath}`);
    console.log(`Wrote ${summaryTxtPath}`);
    return;
  }

  // ── Narrative: one analysis file per topic + master index ────────────────
  const reportSummaryPath = path.join(REPORT_DIR, `report_bot${botId}_summary_${ts}.txt`);
  const liveSolExchangeReportPath = path.join(REPORT_DIR, `report_bot${botId}_live_sol_exchange_${ts}.txt`);

  const safePairKey = (pk) => String(pk || 'pair').replace(/[^A-Za-z0-9_-]+/g, '_');
  const analysisReports = {
    paperCross: {},
    liveDatabase: path.join(REPORT_DIR, `report_bot${botId}_analysis_live_db_${ts}.txt`),
    zonesOperational: path.join(REPORT_DIR, `report_bot${botId}_analysis_zones_${ts}.txt`),
    reconciliation: path.join(REPORT_DIR, `report_bot${botId}_analysis_reconciliation_${ts}.txt`),
  };
  for (const pk of pairKeys) {
    analysisReports.paperCross[pk] = path.join(
      REPORT_DIR,
      `report_bot${botId}_analysis_paper_cross_${safePairKey(pk)}_${ts}.txt`,
    );
  }

  if (writeSolAnalysis) {
    analysisReports.paperSol = path.join(REPORT_DIR, `report_bot${botId}_analysis_paper_sol_${ts}.txt`);
    const solBody =
      `${analysisDocHeader(['Paper SOL — full analysis', '(sol_paper_trades)'], meta)}${analyzeRoundtripsComplete(
        'Paper SOL (DB)',
        'SOL',
        solRoundtrips,
      )}\n`;
    fs.writeFileSync(analysisReports.paperSol, solBody + formatSnapshotAppendix('SOL', snapshotTailMax), 'utf8');
    console.log(`Wrote ${analysisReports.paperSol}`);
  }
  for (const pk of pairKeys) {
    const pth = analysisReports.paperCross[pk];
    const crossBody =
      `${analysisDocHeader([`Cross paper — full analysis (${pk})`, '(cross_paper_trades)'], meta)}${analyzeRoundtripsComplete(
        'Cross paper (DB)',
        pk,
        crossByPair[pk] || [],
      )}\n`;
    fs.writeFileSync(pth, crossBody + formatSnapshotAppendix(pk, snapshotTailMax), 'utf8');
    console.log(`Wrote ${pth}`);
  }

  const paperSnapshotsOnly = {};
  if (snapshotIndividualMax > 0 && !liveOnly) {
    if (writeSolAnalysis) {
      const pOnly = path.join(REPORT_DIR, `report_bot${botId}_paper_snapshots_only_SOL_${ts}.txt`);
      const hdr = `${analysisDocHeader([`Paper snapshots only — SOL`, '(continuous JSONL tail)'], meta)}\n`;
      fs.writeFileSync(pOnly, `${hdr}${formatSnapshotAppendix('SOL', snapshotIndividualMax)}`, 'utf8');
      paperSnapshotsOnly.SOL = pOnly;
      console.log(`Wrote ${pOnly}`);
    }
    for (const pk of pairKeys) {
      const pOnly = path.join(
        REPORT_DIR,
        `report_bot${botId}_paper_snapshots_only_${safePairKey(pk)}_${ts}.txt`,
      );
      const hdr = `${analysisDocHeader([`Paper snapshots only — ${pk}`, '(continuous JSONL tail)'], meta)}\n`;
      fs.writeFileSync(pOnly, `${hdr}${formatSnapshotAppendix(pk, snapshotIndividualMax)}`, 'utf8');
      paperSnapshotsOnly[pk] = pOnly;
      console.log(`Wrote ${pOnly}`);
    }
  }
  if (!paperOnly) {
  fs.writeFileSync(
    analysisReports.liveDatabase,
    `${analysisDocHeader(
      [`Live SOL bot ${botId} — database full analysis`, '(sol_live_trades)'],
      meta,
    )}${analyzeLiveDbComplete(liveRows, botId)}\n`,
    'utf8',
  );
  console.log(`Wrote ${analysisReports.liveDatabase}`);
  fs.writeFileSync(
    analysisReports.zonesOperational,
    `${analysisDocHeader(
      [`Live SOL bot ${botId} — zone trade analysis`, '(sol_live_trades; Deribit slice if fills loaded)'],
      meta,
    )}${analyzeZoneTradeStats(liveRows, botId, deribitErr ? null : fills, bot, instrument)}\n`,
    'utf8',
  );
  console.log(`Wrote ${analysisReports.zonesOperational}`);
  const reconBody = deribitErr
    ? `Deribit fills unavailable: ${deribitErr}\n\n${analyzeReconciliationExtended(liveRows, [], instrument, botId)}`
    : analyzeReconciliationExtended(liveRows, fills, instrument, botId);
  fs.writeFileSync(
    analysisReports.reconciliation,
    `${analysisDocHeader(
      [`Live SOL bot ${botId} — reconciliation`, 'DB (sol_live_trades) vs Deribit fills'],
      meta,
    )}${exchangeNoteEarly}\n\n${reconBody}\n`,
    'utf8',
  );
  console.log(`Wrote ${analysisReports.reconciliation}`);
  }

  const masterTitle = paperOnly
    ? `SOL / CROSS PAPER — MASTER INDEX (paper-only)`
    : `SOL / CROSS PAPER + LIVE BOT ${botId} — MASTER INDEX`;
  const indexBodyLines = [];
  if (analysisReports.paperSol) indexBodyLines.push(`  Paper SOL:              ${analysisReports.paperSol}`);
  indexBodyLines.push(...pairKeys.map((pk) => `  Paper cross ${String(pk).padEnd(5)} ${analysisReports.paperCross[pk]}`));
  if (Object.keys(paperSnapshotsOnly).length) {
    indexBodyLines.push('', 'Snapshot-only (JSONL tail, no trade stats):');
    for (const k of Object.keys(paperSnapshotsOnly).sort()) {
      indexBodyLines.push(`  ${k.padEnd(6)} ${paperSnapshotsOnly[k]}`);
    }
  }
  if (!paperOnly) {
    indexBodyLines.push(
      `  Live database:          ${analysisReports.liveDatabase}`,
      `  Zone trade analysis:    ${analysisReports.zonesOperational}`,
      `  DB vs exchange:         ${analysisReports.reconciliation}`,
      `  Live SOL (Deribit):     ${liveSolExchangeReportPath}`,
    );
  }
  indexBodyLines.push(
    '',
    'Continuous snapshot JSONL (same dir): paper_snapshots_<PAIR>.jsonl',
    `  Throttle: PAPER_SNAPSHOT_INTERVAL_MS (default 15000).`,
    `  Analysis appendix: last ${snapshotTailMax === 0 ? 'ALL (capped)' : snapshotTailMax} lines per pair.`,
    snapshotIndividualMax > 0
      ? `  Snapshot-only text files: report_bot${botId}_paper_snapshots_only_<PAIR>_${ts}.txt (${snapshotIndividualMax === 0 ? 'ALL (capped)' : snapshotIndividualMax} lines).`
      : '  Snapshot-only files: add --snapshot-individual[=N] for large per-pair snapshot dumps.',
  );
  fs.writeFileSync(
    reportSummaryPath,
    `${analysisDocHeader([masterTitle], meta)}${exchangeNoteEarly}\n\nIndividual analysis reports (this run):\n${indexBodyLines.join(
      '\n',
    )}\n\nRow-level dumps: see report_index_*.json field "raw" (requires --raw).\n`,
    'utf8',
  );
  console.log(`Wrote ${reportSummaryPath}`);

  if (!paperOnly) {
  const liveSolParts = [
    analysisDocHeader(
      ['LIVE SOL — exchange report', '(per-zone DB trade stats + Deribit fills + 1-SOL open-leg slice)'],
      meta,
    ),
    'Data source: Deribit private API `get_user_trades_by_instrument_and_time` (fills only).',
    'Time window: first `sol_live_trades.eventAt` for this bot → now. DB used only to anchor the window.',
    `Same per-zone trade section as standalone file:  ${analysisReports.zonesOperational}`,
    '',
    exchangeNoteEarly,
    '',
    analyzeZoneTradeStats(liveRows, botId, deribitErr ? null : fills, bot, instrument),
  ];
  if (deribitErr) {
    liveSolParts.push(`Deribit error: ${deribitErr}\n`);
  } else {
    liveSolParts.push(
      analyzeDeribitComplete(fills, tradeAccount, instrument, exchangeStartMsEarly, exchangeEndMsEarly, ''),
    );
    liveSolParts.push(analyzeExchangeExtended(fills));
    const oneSolOpens = fills.filter(isOneSolOpenLegFill);
    liveSolParts.push(
      _section('Exchange — 1 SOL opening legs only (excludes position closes)'),
      'Short-grid semantics: new exposure = SELL. Covers / exits = BUY — omitted here.',
      'Also omitted: reduce_only or risk_reducing fills, and any SELL size ≠ 1.',
      `Matching fills: ${oneSolOpens.length} of ${fills.length} in window.`,
      '',
    );
    liveSolParts.push(
      analyzeDeribitComplete(oneSolOpens, tradeAccount, instrument, exchangeStartMsEarly, exchangeEndMsEarly, '', {
        sectionTitle: 'Deribit — 1 SOL SELL open legs only (filtered)',
      }),
    );
    liveSolParts.push(analyzeExchangeExtended(oneSolOpens));
  }
  fs.writeFileSync(liveSolExchangeReportPath, liveSolParts.join('\n'), 'utf8');
  console.log(`Wrote ${liveSolExchangeReportPath}`);
  }

  const summaryPath = path.join(REPORT_DIR, `report_index_${ts}.json`);
  const indexPayload = {
    ...meta,
    includeRaw,
    summaryReport: reportSummaryPath,
    liveSolExchangeReport: paperOnly ? null : liveSolExchangeReportPath,
    analysisReports,
    snapshotJsonlNote: 'reports/paper_snapshots_<PAIR>.jsonl (throttled while paper engines run)',
    paperSnapshotsOnly: Object.keys(paperSnapshotsOnly).length ? paperSnapshotsOnly : null,
    raw: includeRaw
      ? {
          solPaperJson: solPath,
          solPaperTsv: txtPaths.solPaper,
          crossPaperJson: pairKeys.map((pk) => path.join(REPORT_DIR, `paper_cross_${pk}_${ts}.json`)),
          crossPaperTsv: txtPaths.crossPaper,
          liveDbJson: paperOnly ? null : livePath,
          liveDbTsv: paperOnly ? null : txtPaths.liveDb,
          deribitJson: paperOnly ? null : derPath,
          deribitTsv: paperOnly ? null : txtPaths.deribitFills,
        }
      : null,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(indexPayload, null, 2), 'utf8');

  const summaryTxtPath = path.join(REPORT_DIR, `report_index_${ts}.txt`);
  const indexLines = [
    `Report index ${ts}`,
    `exportedAt=${meta.exportedAt} botId=${botId}`,
    paperOnly ? 'mode=paper-only' : '',
    '',
    'Master index + individual analysis:',
    `  ${reportSummaryPath}`,
    ...(analysisReports.paperSol ? [`  ${analysisReports.paperSol}`] : []),
    ...pairKeys.map((pk) => `  ${analysisReports.paperCross[pk]}`),
    ...(paperOnly
      ? []
      : [
          `  ${analysisReports.liveDatabase}`,
          `  ${analysisReports.zonesOperational}`,
          `  ${analysisReports.reconciliation}`,
          `  ${liveSolExchangeReportPath}`,
        ]),
    '',
    `JSON index: ${summaryPath}`,
    '',
    ...(Object.keys(paperSnapshotsOnly).length
      ? ['Snapshot-only reports (--snapshot-individual):', ...Object.values(paperSnapshotsOnly).map((p) => `  ${p}`), '']
      : []),
  ].filter((ln) => ln !== '');
  if (includeRaw) {
    indexLines.push('Raw trade data (--raw):');
    if (solPath) indexLines.push(`  ${solPath}`);
    pairKeys.forEach((pk) => indexLines.push(`  ${path.join(REPORT_DIR, `paper_cross_${pk}_${ts}.json`)}`));
    if (livePath) indexLines.push(`  ${livePath}`);
    if (derPath) indexLines.push(`  ${derPath}`);
    indexLines.push('', 'TSV:', `  ${txtPaths.solPaper || '(none)'}`);
    txtPaths.crossPaper.forEach((p) => indexLines.push(`  ${p}`));
    indexLines.push(`  ${txtPaths.liveDb || '(none)'}`, `  ${txtPaths.deribitFills || '(none)'}`, '');
  } else {
    indexLines.push('Raw trade dumps were not written. Re-run with:  node scripts/exportPaperAndLiveReports.js', `  ${botId} --raw`, '');
  }
  fs.writeFileSync(summaryTxtPath, indexLines.join('\n'), 'utf8');

  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${summaryTxtPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
