'use strict';

/**
 * Multi-asset paper + spread snapshot service (ETH, BTC, XRP, AVAX, PAXG, …).
 * Signal: Deribit USDC-perp best ask − Hyperliquid coin best bid (same as SOL paper).
 * Uses unilateraltest_hft keyed paper states (pair keys must not collide with SOL paper).
 */

const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const executor = require('./unilateraltest_hft');
const paperSnapshotLogger = require('./paperSnapshotLogger');

const LOG_DIR = path.resolve(__dirname, '../../reports');
const WINDOW_LEN = 120;

const profilesPath = path.join(__dirname, '../config/crossPaperProfiles.json');
const bootstrapPath = path.join(__dirname, '../config/crossPaperBootstrap.json');

function _readProfilesFile() {
  return JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
}

/** @type {Array<{ id: string, deribitInstrument: string, hyperliquidCoin: string, notes?: string }>} */
let profiles = _readProfilesFile();

function reloadProfilesFromDisk() {
  const next = _readProfilesFile();
  profiles.splice(0, profiles.length, ...next);
}

function writeProfilesToDisk(nextArr) {
  fs.writeFileSync(profilesPath, `${JSON.stringify(nextArr, null, 2)}\n`, 'utf8');
  reloadProfilesFromDisk();
}

function getProfiles() {
  return profiles;
}

function pairSlotBusy(id) {
  return !!_pairs[id];
}

function addCrossProfile(row) {
  const id = String(row.id || '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(id)) return { ok: false, error: 'invalid_id' };
  if (id === 'SOL') return { ok: false, error: 'reserved_id_sol' };
  if (profiles.some((p) => p.id === id)) return { ok: false, error: 'duplicate_id' };
  if (pairSlotBusy(id)) return { ok: false, error: 'pair_active_stop_first' };
  const deribitInstrument = String(row.deribitInstrument || '').trim();
  const hyperliquidCoin = String(row.hyperliquidCoin || '').trim();
  if (!deribitInstrument || !hyperliquidCoin) return { ok: false, error: 'missing_instruments' };
  const entry = { id, deribitInstrument, hyperliquidCoin };
  if (row.notes) entry.notes = String(row.notes).trim();
  const next = [...profiles, entry];
  writeProfilesToDisk(next);
  return { ok: true, profile: entry };
}

function updateCrossProfile(id, row) {
  const key = String(id || '').trim().toUpperCase();
  const idx = profiles.findIndex((p) => p.id === key);
  if (idx < 0) return { ok: false, error: 'not_found' };
  if (pairSlotBusy(key)) return { ok: false, error: 'pair_active_stop_first' };
  const cur = { ...profiles[idx] };
  if (row.deribitInstrument != null) cur.deribitInstrument = String(row.deribitInstrument).trim();
  if (row.hyperliquidCoin != null) cur.hyperliquidCoin = String(row.hyperliquidCoin).trim();
  if (row.notes !== undefined) cur.notes = row.notes ? String(row.notes).trim() : undefined;
  const next = profiles.map((p, i) => (i === idx ? cur : p));
  writeProfilesToDisk(next);
  return { ok: true, profile: cur };
}

function deleteCrossProfile(id) {
  const key = String(id || '').trim().toUpperCase();
  if (key === 'SOL') return { ok: false, error: 'reserved_id_sol' };
  const idx = profiles.findIndex((p) => p.id === key);
  if (idx < 0) return { ok: false, error: 'not_found' };
  if (pairSlotBusy(key)) return { ok: false, error: 'pair_active_stop_first' };
  const next = profiles.filter((p) => p.id !== key);
  writeProfilesToDisk(next);
  return { ok: true, removed: key };
}

function upsertBootstrapPair(pairKey, pairConfig) {
  const id = String(pairKey || '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(id)) return { ok: false, error: 'invalid_pair_key' };
  if (typeof pairConfig !== 'object' || pairConfig == null || Array.isArray(pairConfig)) {
    return { ok: false, error: 'invalid_pair_config' };
  }
  if (!Object.keys(pairConfig).length) return { ok: false, error: 'empty_pair_config' };
  const boot = _loadBootstrap();
  if (!boot || typeof boot !== 'object') return { ok: false, error: 'bootstrap_read_failed' };
  if (!boot.pairs || typeof boot.pairs !== 'object') boot.pairs = {};
  boot.pairs[id] = pairConfig;
  fs.writeFileSync(bootstrapPath, `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  return { ok: true, pairKey: id };
}

function deleteBootstrapPair(pairKey) {
  const id = String(pairKey || '').trim().toUpperCase();
  const boot = _loadBootstrap();
  if (!boot?.pairs?.[id]) return { ok: false, error: 'not_found' };
  delete boot.pairs[id];
  fs.writeFileSync(bootstrapPath, `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  return { ok: true, removed: id };
}

function patchBootstrapGlobals(partial) {
  if (typeof partial !== 'object' || partial == null || Array.isArray(partial)) {
    return { ok: false, error: 'invalid_body' };
  }
  const boot = _loadBootstrap();
  if (!boot || typeof boot !== 'object') return { ok: false, error: 'bootstrap_read_failed' };
  const allowed = new Set([
    'capitalPerPair', 'dailyLossLimitPerPair', 'stopLossRequireZoneExit', 'stopLossRangeMult',
    'hurstGate', 'cooldownMs', 'minHoldMs', 'tpConfirmTicks', 'slConfirmTicks', 'analyticsWindow',
    'bidWidenLambda', 'askTightenPhi', 'as',
  ]);
  for (const k of Object.keys(partial)) {
    if (allowed.has(k)) boot[k] = partial[k];
  }
  fs.writeFileSync(bootstrapPath, `${JSON.stringify(boot, null, 2)}\n`, 'utf8');
  return { ok: true, keys: Object.keys(partial).filter((k) => allowed.has(k)) };
}
const generatedBootstrapPath = path.join(__dirname, '../config/crossPaperBootstrap.generated.json');

let _snapshotSession = '';
let _snapshotRunning = false;
let _paperSession = '';
let _paperRunning = false;
/** @type {Record<string, { profile: object, deribitWs: any, hyperWs: any, deribitBook: any, hyperBook: any, spreadWindow: number[], lastSnapWrite: number, snapshotPath: string|null, snapshotOnly: boolean, throttleMs: number }>} */
const _pairs = {};

function _profileById(id) {
  return profiles.find((p) => p.id === id) || null;
}

function _spreadStats(spreadWindow, spread) {
  spreadWindow.push(spread);
  if (spreadWindow.length > WINDOW_LEN * 2) spreadWindow.splice(0, spreadWindow.length - WINDOW_LEN);
  const s = spreadWindow.slice(-WINDOW_LEN);
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  const std = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length) || 0.001;
  return { mean, std, zScore: (spread - mean) / std };
}

function _writeSnapshotLine(pairKey, row) {
  const st = _pairs[pairKey];
  if (!st?.snapshotPath || !st.snapshotOnly) return;
  const now = Date.now();
  if (now - (st.lastSnapWrite || 0) < (st.throttleMs || 500)) return;
  st.lastSnapWrite = now;
  fs.appendFileSync(st.snapshotPath, JSON.stringify(row) + '\n');
}

function _onPairBooks(pairKey) {
  const st = _pairs[pairKey];
  if (!st || !st.deribitBook || !st.hyperBook) return;

  const futAsk = parseFloat(st.deribitBook.asks?.[0]?.price || 0);
  const futBid = parseFloat(st.deribitBook.bids?.[0]?.price || 0);
  const perpBid = parseFloat(st.hyperBook.bids?.[0]?.price || 0);
  const perpAsk = parseFloat(st.hyperBook.asks?.[0]?.price || 0);
  if (!futAsk || !futBid || !perpBid || !perpAsk) return;

  const signalSpread = futAsk - perpBid;
  const midSpread = (futBid + futAsk) / 2 - (perpBid + perpAsk) / 2;
  const deribitMid = (futBid + futAsk) / 2;
  const hlMid = (perpBid + perpAsk) / 2;
  const stats = _spreadStats(st.spreadWindow, midSpread);

  if (st.snapshotOnly) {
    _writeSnapshotLine(pairKey, {
      ts: new Date().toISOString(),
      pairKey,
      deribitInstrument: st.profile.deribitInstrument,
      hyperliquidCoin: st.profile.hyperliquidCoin,
      signalSpread,
      midSpread,
      deribitMid,
      hlMid,
      zScore: stats.zScore,
    });
    return;
  }

  executor.onPaperSpreadUpdate(pairKey, {
    signalSpread,
    midSpread,
    deribitMid,
    hyperMid: hlMid,
    zScore: stats.zScore,
    mean: stats.mean,
    std: stats.std,
    velocity: 0,
    ob1: st.deribitBook,
    ob2: st.hyperBook,
    timestamp: Date.now(),
  });

  const pst = executor.getPaperState(pairKey);
  paperSnapshotLogger.appendSnapshot(pairKey, {
    sessionId: pst?.sessionId || null,
    signalSpread,
    midSpread,
    deribitMid,
    hlMid,
    zScore: stats.zScore,
    equity: pst?.equity,
    inventory: pst?.inventory,
    regime: pst?.regime,
    openPositions: pst?.openPositions,
    dailyPnl: pst?.dailyPnl,
    totalTrades: pst?.totalTrades,
    activeZone: pst?.activeZone || null,
  });
}

function _connectDeribit(pairKey) {
  const st = _pairs[pairKey];
  if (!st) return;
  const inst = st.profile.deribitInstrument;
  const ws = new WebSocket('wss://www.deribit.com/ws/api/v2');
  st.deribitWs = ws;
  ws.on('open', () => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'public/subscribe',
      params: { channels: [`book.${inst}.none.20.100ms`] },
    }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.params?.channel?.startsWith('book.') && msg.params?.data) {
        const book = msg.params.data;
        const bids = (book.bids || []).slice(0, 10).map((b) => ({ price: String(b[0]), size: String(b[1]) }));
        const asks = (book.asks || []).slice(0, 10).map((a) => ({ price: String(a[0]), size: String(a[1]) }));
        if (bids.length && asks.length) {
          st.deribitBook = { bids, asks, exchange: 'deribit', symbol: inst, timestamp: Date.now() };
          _onPairBooks(pairKey);
        }
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    if (!_snapshotRunning && !_paperRunning) return;
    setTimeout(() => _connectDeribit(pairKey), 5000);
  });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

function _connectHyper(pairKey) {
  const st = _pairs[pairKey];
  if (!st) return;
  const coin = st.profile.hyperliquidCoin;
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  st.hyperWs = ws;
  ws.on('open', () => {
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'l2Book', coin },
    }));
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'l2Book' && msg.data) {
        const book = msg.data;
        const bids = (book.levels?.[0] || []).slice(0, 10).map((l) => ({ price: l.px, size: l.sz }));
        const asks = (book.levels?.[1] || []).slice(0, 10).map((l) => ({ price: l.px, size: l.sz }));
        if (bids.length && asks.length) {
          st.hyperBook = { bids, asks, exchange: 'hyperliquid', symbol: coin, timestamp: Date.now() };
          _onPairBooks(pairKey);
        }
      }
    } catch (_) {}
  });
  ws.on('close', () => {
    if (!_snapshotRunning && !_paperRunning) return;
    setTimeout(() => _connectHyper(pairKey), 5000);
  });
  ws.on('error', () => { try { ws.close(); } catch (_) {} });
}

function _closePairSockets(pairKey) {
  const st = _pairs[pairKey];
  if (!st) return;
  try { st.deribitWs?.close(); } catch (_) {}
  try { st.hyperWs?.close(); } catch (_) {}
  st.deribitWs = null;
  st.hyperWs = null;
  st.deribitBook = null;
  st.hyperBook = null;
}

/**
 * Log live spread snapshots to JSONL (one file per pair under reports/).
 * @param {{ durationMs?: number, pairKeys?: string[], throttleMs?: number }} opts
 */
function startSnapshots(opts = {}) {
  if (_snapshotRunning) return { ok: false, reason: 'snapshots already running' };
  const durationMs = Math.min(Math.max(opts.durationMs || 600000, 10000), 86400000);
  const keys = (opts.pairKeys && opts.pairKeys.length)
    ? opts.pairKeys
    : profiles.map((p) => p.id);
  const busy = new Set(keys.filter((k) => _pairs[k] && !_pairs[k].snapshotOnly));
  const keysActive = keys.filter((k) => !busy.has(k));
  if (!keysActive.length) {
    return { ok: false, reason: `no pairs to log — paper/sockets active for: ${[...busy].join(', ')}` };
  }
  if (busy.size) {
    console.warn(`[CrossPaper] snapshot skipping busy pairs: ${[...busy].join(', ')}`);
  }
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  _snapshotSession = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  _snapshotRunning = true;

  for (const id of keysActive) {
    const profile = _profileById(id);
    if (!profile) continue;
    // One stable file per symbol; truncated on each new snapshot run (no per-session copies).
    const snapPath = path.join(LOG_DIR, `cross_spread_snapshots_${id}.jsonl`);
    fs.writeFileSync(snapPath, '');
    _pairs[id] = {
      profile,
      deribitWs: null,
      hyperWs: null,
      deribitBook: null,
      hyperBook: null,
      spreadWindow: [],
      lastSnapWrite: 0,
      snapshotPath: snapPath,
      snapshotOnly: true,
      throttleMs: opts.throttleMs ?? 500,
    };
    _connectDeribit(id);
    _connectHyper(id);
  }

  const startedSnap = keysActive.filter((k) => _pairs[k]?.snapshotOnly);
  if (!startedSnap.length) {
    _snapshotRunning = false;
    _snapshotSession = '';
    return { ok: false, reason: 'no snapshot sockets started (unknown pairKeys or missing profiles)' };
  }

  setTimeout(() => {
    stopSnapshots('duration');
  }, durationMs);

  console.log(`[CrossPaper] Snapshot logging ${_snapshotSession} for ${startedSnap.join(',')} (${(durationMs / 60000).toFixed(1)} min)`);
  return {
    ok: true,
    session: _snapshotSession,
    pairKeys: keysActive,
    skippedBusy: [...busy],
    durationMs,
    files: startedSnap.map((k) => _pairs[k]?.snapshotPath).filter(Boolean),
  };
}

/** Set `CROSS_SNAPSHOT_AUTOGEN=0` to skip writing `crossPaperBootstrap.generated.json` after snapshots stop. */
function _runSnapshotBootstrapGenerator(reason) {
  const backendRoot = path.join(__dirname, '..', '..');
  const script = path.join(backendRoot, 'scripts', 'generateCrossPaperConfig.js');
  const boot = _loadBootstrap();
  const capital = boot?.capitalPerPair ?? 10_000;
  const outRel = 'src/config/crossPaperBootstrap.generated.json';
  console.log(`[CrossPaper] generateCrossPaperConfig (${reason || 'stop'}) capital=${capital}`);
  const r = spawnSync(process.execPath, [script, `--out=${outRel}`, `--capital=${capital}`], {
    cwd: backendRoot,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[CrossPaper] generateCrossPaperConfig failed exit=', r.status);
    return false;
  }
  console.log('[CrossPaper] snapshot-based config:', path.join(backendRoot, outRel));
  return true;
}

function stopSnapshots(reason) {
  if (!_snapshotRunning) return { ok: true, stopped: false };
  _snapshotRunning = false;
  let stoppedSnapCount = 0;
  for (const k of Object.keys(_pairs)) {
    const st = _pairs[k];
    if (st?.snapshotOnly) {
      stoppedSnapCount++;
      _closePairSockets(k);
      delete _pairs[k];
    }
  }
  console.log(`[CrossPaper] Snapshots stopped: ${reason || 'manual'}`);
  const autogen = stoppedSnapCount > 0 && process.env.CROSS_SNAPSHOT_AUTOGEN !== '0';
  if (autogen) {
    setImmediate(() => {
      try {
        _runSnapshotBootstrapGenerator(reason);
      } catch (e) {
        console.error('[CrossPaper] autogen config error', e.message);
      }
    });
  }
  return {
    ok: true,
    stopped: true,
    configAutogenScheduled: autogen,
    generatedBootstrapPath: autogen ? generatedBootstrapPath : null,
  };
}

function _loadBootstrap() {
  try {
    return JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
  } catch (e) {
    console.error('[CrossPaper] bootstrap read failed', e.message);
    return null;
  }
}

/** Deribit-mid SL distance = zoneGrid.range × stopLossRangeMult (e.g. ETH range 200 → 250 @ 1.25). */
function _pairWithDerivedSl(boot, pc) {
  const mult = boot.stopLossRangeMult;
  if (mult == null || !pc?.zoneGrid || typeof pc.zoneGrid.range !== 'number') return pc;
  const slPx = Math.max(1e-8, Number((Number(pc.zoneGrid.range) * mult).toPrecision(8)));
  return {
    ...pc,
    zones: (pc.zones || []).map((z) => ({ ...z, sl: slPx })),
  };
}

/**
 * Start keyed paper engines for listed pairs ($10k each by default from bootstrap).
 * @param {{ pairKeys?: string[], bootstrapPath?: string, sessionPrefix?: string }} opts
 */
function startPaperMulti(opts = {}) {
  if (_paperRunning) return { ok: false, reason: 'cross paper already running' };
  if (_snapshotRunning) {
    return { ok: false, reason: 'spread snapshot session active — stop snapshots or wait for duration end' };
  }
  const boot = opts.bootstrapPath
    ? JSON.parse(fs.readFileSync(opts.bootstrapPath, 'utf8'))
    : _loadBootstrap();
  if (!boot?.pairs) return { ok: false, reason: 'invalid bootstrap' };

  const keys = (opts.pairKeys && opts.pairKeys.length)
    ? opts.pairKeys
    : Object.keys(boot.pairs);
  const cap = boot.capitalPerPair ?? 10_000;
  const daily = boot.dailyLossLimitPerPair ?? 8000;
  _paperSession = opts.sessionPrefix || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);

  const startedIds = [];
  for (const id of keys) {
    const profile = _profileById(id);
    const pc = boot.pairs[id];
    if (!profile || !pc) continue;
    if (_pairs[id]?.snapshotOnly) {
      _closePairSockets(id);
      delete _pairs[id];
    }
    if (_pairs[id]) {
      console.warn(`[CrossPaper] skip ${id} — socket slot busy (non-snapshot)`);
      continue;
    }
    if (executor.listPaperPairKeys().includes(id)) {
      console.warn(`[CrossPaper] skip ${id} — paper slot already in use`);
      continue;
    }

    const pcUse = _pairWithDerivedSl(boot, pc);

    const logFile = path.join(LOG_DIR, `cross_paper_${id}_${_paperSession}.log`);
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(logFile, '');

    startedIds.push(id);
    executor.initPaperTrading(id, {
      capital: cap,
      dailyLossLimit: daily,
      cooldownMs: boot.cooldownMs ?? 5000,
      minHoldMs: boot.minHoldMs ?? 15000,
      tpConfirmTicks: boot.tpConfirmTicks ?? 3,
      slConfirmTicks: boot.slConfirmTicks ?? 7,
      hurstGate: boot.hurstGate ?? 0.55,
      analyticsWindow: boot.analyticsWindow ?? 120,
      as: { ...boot.as, ...(pcUse.as || {}) },
      bidWidenLambda: boot.bidWidenLambda ?? 1,
      askTightenPhi: boot.askTightenPhi ?? 0.6,
      entryLevels: pcUse.entryLevels,
      zoneGrid: pcUse.zoneGrid,
      zones: pcUse.zones,
      stopLossRequireZoneExit: boot.stopLossRequireZoneExit === true,
      logFile,
      csvFile: null,
      persistDb: opts.persistDb !== false,
      persistModel: 'cross',
      sessionId: `${_paperSession}_${id}`,
    });

    _pairs[id] = {
      profile,
      deribitWs: null,
      hyperWs: null,
      deribitBook: null,
      hyperBook: null,
      spreadWindow: [],
      lastSnapWrite: 0,
      snapshotPath: null,
      snapshotOnly: false,
      throttleMs: 0,
    };
    _connectDeribit(id);
    _connectHyper(id);
  }

  if (startedIds.length === 0) {
    return { ok: false, reason: 'no pairs started (check bootstrap pair keys vs profiles)' };
  }
  _paperRunning = true;
  console.log(`[CrossPaper] Paper engines started session=${_paperSession} pairs=${startedIds.join(',')}`);
  return { ok: true, session: _paperSession, pairKeys: startedIds };
}

function stopPaperMulti() {
  if (!_paperRunning) return { ok: true, stopped: false };
  _paperRunning = false;
  const keys = Object.keys(_pairs).filter((k) => !_pairs[k].snapshotOnly);
  for (const k of keys) {
    executor.stopPaperTrading(k);
    _closePairSockets(k);
    delete _pairs[k];
  }
  console.log('[CrossPaper] Paper engines stopped');
  return { ok: true, stopped: true };
}

function isSnapshotRunning() {
  return _snapshotRunning;
}

function isPaperRunning() {
  return _paperRunning;
}

function getSnapshotSession() {
  return _snapshotSession || null;
}

function getPaperSession() {
  return _paperSession || null;
}

function getState() {
  const out = { snapshotRunning: _snapshotRunning, paperRunning: _paperRunning, snapshotSession: _snapshotSession, paperSession: _paperSession, pairs: {} };
  for (const k of Object.keys(_pairs)) {
    out.pairs[k] = {
      snapshotOnly: !!_pairs[k].snapshotOnly,
      snapshotPath: _pairs[k].snapshotPath || null,
      paper: executor.getPaperState(k),
    };
  }
  return out;
}

/** Open paper positions: cross pairs + optional SOL (`paperTradeRunner`). */
function getUnifiedOpenPaperPositions(pairKeyFilter = null) {
  const fk = pairKeyFilter ? String(pairKeyFilter).toUpperCase() : null;
  const wantSol = !fk || fk === 'SOL';
  const wantCross = !fk || fk !== 'SOL';

  const paperTrader = require('./paperTradeRunner');
  const out = [];
  const stSol = paperTrader.getState?.();
  if (wantSol && stSol?.positions?.length) {
    for (const p of stSol.positions) {
      const gl = p.gridLevel ?? p.level;
      out.push({
        type: 'open',
        pairKey: 'SOL',
        zoneId: p.zoneId,
        gridLevel: gl,
        qty: p.qty,
        lifeId: p.lifeId,
        entrySpread: p.entrySpread,
        holdSec: p.holdSec != null ? p.holdSec : ((Date.now() - (p.openedAt || 0)) / 1000).toFixed(0),
        openedAt: p.openedAt,
      });
    }
  }
  if (!wantCross) return out;
  for (const k of Object.keys(_pairs)) {
    if (_pairs[k].snapshotOnly) continue;
    if (fk && String(k).toUpperCase() !== fk) continue;
    const st = executor.getPaperState(k);
    if (!st?.positions?.length) continue;
    for (const p of st.positions) {
      const gl = p.gridLevel ?? p.level;
      out.push({
        type: 'open',
        pairKey: k,
        zoneId: p.zoneId,
        gridLevel: gl,
        qty: p.qty,
        lifeId: p.lifeId,
        entrySpread: p.entrySpread,
        holdSec: p.holdSec != null ? p.holdSec : ((Date.now() - (p.openedAt || 0)) / 1000).toFixed(0),
        openedAt: p.openedAt,
      });
    }
  }
  return out;
}

/**
 * Merged paper round-trips: `cross_paper_trades` + optional `sol_paper_trades` as pairKey SOL.
 * One response shape for the Sol Bot dashboard “Paper Trades” table.
 */
async function fetchPaperTradesUnified(opts = {}) {
  const { CrossPaperTrade, SolPaperTrade } = require('../models');
  const limit = Math.min(Math.max(parseInt(String(opts.limit || 500), 10) || 500, 1), 2000);
  const offset = Math.max(parseInt(String(opts.offset || 0), 10) || 0, 0);
  const includeSol = opts.includeSol !== false && opts.includeSol !== '0';
  const pairKeyFilter = opts.pairKey ? String(opts.pairKey).toUpperCase() : null;

  const cap = limit + offset + 100;
  let merged = [];

  if (!pairKeyFilter || pairKeyFilter !== 'SOL') {
    const crossWhere = { type: 'EXIT' };
    if (pairKeyFilter) crossWhere.pairKey = pairKeyFilter;
    const crossExits = await CrossPaperTrade.findAll({
      where: crossWhere,
      order: [['id', 'DESC']],
      limit: cap,
      raw: true,
    });
    const crossEntryIds = [...new Set(crossExits.map((r) => r.entryRowId).filter(Boolean))];
    let crossEntryById = {};
    if (crossEntryIds.length) {
      const ents = await CrossPaperTrade.findAll({
        where: { id: crossEntryIds },
        attributes: ['id', 'signalSpread'],
        raw: true,
      });
      crossEntryById = Object.fromEntries(ents.map((e) => [e.id, e.signalSpread]));
    }
    merged = crossExits.map((r) => ({
      type: 'roundtrip',
      pairKey: r.pairKey,
      id: r.id,
      entryRowId: r.entryRowId,
      sessionId: r.sessionId,
      zoneId: r.zoneId,
      gridLevel: r.gridLevel,
      qty: r.qty,
      entrySpread: r.entryRowId ? crossEntryById[r.entryRowId] ?? null : null,
      exitSpread: r.signalSpread,
      signalSpread: r.signalSpread,
      deribitMid: r.deribitMid ?? null,
      hlMid: r.hlMid ?? null,
      pnlUsd: r.pnlUsd,
      holdSec: r.holdSec,
      exitReason: r.exitReason,
      eventAt: r.eventAt,
    }));
  }

  if (includeSol && (!pairKeyFilter || pairKeyFilter === 'SOL')) {
    const solExits = await SolPaperTrade.findAll({
      where: { type: 'EXIT' },
      order: [['id', 'DESC']],
      limit: cap,
      raw: true,
    });
    const solEntryIds = [...new Set(solExits.map((r) => r.entryRowId).filter(Boolean))];
    let solEntryById = {};
    if (solEntryIds.length) {
      const ents = await SolPaperTrade.findAll({
        where: { id: solEntryIds },
        attributes: ['id', 'signalSpread'],
        raw: true,
      });
      solEntryById = Object.fromEntries(ents.map((e) => [e.id, e.signalSpread]));
    }
    const solMapped = solExits.map((r) => ({
      type: 'roundtrip',
      pairKey: 'SOL',
      id: r.id,
      entryRowId: r.entryRowId,
      sessionId: r.sessionId,
      zoneId: r.zoneId,
      gridLevel: r.gridLevel,
      qty: r.qty,
      entrySpread: r.entryRowId ? solEntryById[r.entryRowId] ?? null : null,
      exitSpread: r.signalSpread,
      signalSpread: r.signalSpread,
      deribitMid: r.deribitMid ?? null,
      hlMid: r.hlMid ?? null,
      pnlUsd: r.pnlUsd,
      holdSec: r.holdSec,
      exitReason: r.exitReason,
      eventAt: r.eventAt,
    }));
    merged = merged.concat(solMapped);
  }

  merged.sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());
  const total = merged.length;
  const closed = merged.slice(offset, offset + limit);
  const open = getUnifiedOpenPaperPositions(pairKeyFilter);

  return { source: 'db', closed, open, total, includeSol, pairKey: pairKeyFilter || null };
}

module.exports = {
  startSnapshots,
  stopSnapshots,
  startPaperMulti,
  stopPaperMulti,
  isSnapshotRunning,
  isPaperRunning,
  getSnapshotSession,
  getPaperSession,
  getState,
  fetchPaperTradesUnified,
  getProfiles,
  reloadProfilesFromDisk,
  addCrossProfile,
  updateCrossProfile,
  deleteCrossProfile,
  upsertBootstrapPair,
  deleteBootstrapPair,
  patchBootstrapGlobals,
  bootstrapPath,
  generatedBootstrapPath,
  profilesPath,
};
