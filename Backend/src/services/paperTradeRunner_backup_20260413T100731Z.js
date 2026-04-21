'use strict';

/**
 * Paper Trade Runner — importable module
 *
 * Manages its own Deribit + Hyperliquid WebSocket connections (completely
 * isolated from orderbookStreams and the live unilateralExecutor) and feeds
 * live orderbook data into the zone-grid + A-S + breakout paper engine.
 *
 * Usage from server.js:
 *   const paperTrader = require('./services/paperTradeRunner');
 *   paperTrader.start({ stopAt: '2026-04-12T05:30:00' }); // 11:00 IST
 *   // later:  paperTrader.stop();
 *
 * Data is saved to:  Backend/reports/paper_trade_sol_<timestamp>.log
 * Summary written on stop to:  Backend/reports/paper_trade_sol_<timestamp>_summary.txt
 */

const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');

const executor  = require('./unilateraltest_hft');

// ─── State (all scoped inside module, zero interaction with live bot) ────────

let _running     = false;
let _stopTimer   = null;
let _deribitWs   = null;
let _hyperWs     = null;
let _deribitReconnect = null;
let _hyperReconnect   = null;
let _deribitBook = null;
let _hyperBook   = null;
let _tickCount   = 0;
let _lastStatusAt = 0;
let _deribitFirstTick = false;
let _hyperFirstTick   = false;
let _spreadWindow = [];
let _LOG_FILE    = '';
let _SUMMARY_FILE = '';
let _CSV_FILE    = '';
/** Scheduled stop time (ms), or `null` for no auto-stop. */
let _STOP_AT     = null;

function _stopTimeReached() {
  return _STOP_AT != null && Date.now() >= _STOP_AT;
}

const DERIBIT_SYMBOL = 'SOL_USDC-PERPETUAL';
const HYPER_COIN     = 'SOL';
const WINDOW_LEN     = 120;
const LOG_DIR        = path.resolve(__dirname, '../../reports');

// ─── Rolling spread stats ───────────────────────────────────────────────────

function _updateSpreadStats(spread) {
  _spreadWindow.push(spread);
  if (_spreadWindow.length > WINDOW_LEN * 2) _spreadWindow.splice(0, _spreadWindow.length - WINDOW_LEN);
  const s = _spreadWindow.slice(-WINDOW_LEN);
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  const std  = Math.sqrt(s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length) || 0.001;
  const zScore = (spread - mean) / std;
  return { mean, std, zScore };
}

// ─── Book update → executor feed ────────────────────────────────────────────

function _onBookUpdate() {
  if (!_deribitBook || !_hyperBook) return;

  const futAsk  = parseFloat(_deribitBook.asks?.[0]?.price || 0);
  const futBid  = parseFloat(_deribitBook.bids?.[0]?.price || 0);
  const perpBid = parseFloat(_hyperBook.bids?.[0]?.price || 0);
  const perpAsk = parseFloat(_hyperBook.asks?.[0]?.price || 0);
  if (!futAsk || !futBid || !perpBid || !perpAsk) return;

  const signalSpread = futAsk - perpBid;
  const midSpread    = (futBid + futAsk) / 2 - (perpBid + perpAsk) / 2;
  const deribitMid   = (futBid + futAsk) / 2;
  const hyperMid     = (perpBid + perpAsk) / 2;

  const stats = _updateSpreadStats(midSpread);
  _tickCount++;

  if (_tickCount <= 3 || _tickCount % 500 === 0) {
    console.log(
      `[PaperWS Tick #${_tickCount}] deribit=$${deribitMid.toFixed(4)} hyper=$${hyperMid.toFixed(4)} ` +
      `signal=$${signalSpread.toFixed(4)} mid=$${midSpread.toFixed(4)} z=${stats.zScore.toFixed(2)}`
    );
  }

  try {
    executor.onPaperSpreadUpdate({
      signalSpread, midSpread, deribitMid, hyperMid,
      zScore: stats.zScore, mean: stats.mean, std: stats.std,
      velocity: 0,
      ob1: _deribitBook, ob2: _hyperBook,
      timestamp: Date.now(),
    });
  } catch (err) {
    if (_tickCount <= 5) console.error(`[PaperTrade ERROR] ${err.message}\n${err.stack}`);
  }

  // CSV is now written directly from the executor on each entry/exit

  const now = Date.now();
  if (now - _lastStatusAt > 30000) {
    _lastStatusAt = now;
    const st = executor.getPaperState();
    if (st) {
      const statusLine =
        `ticks=${_tickCount} regime=${st.regime} inv=${st.inventory} ` +
        `equity=$${st.equity} pnl=$${st.dailyPnl.toFixed(4)} ` +
        `trades=${st.totalTrades} open=${st.openPositions} ` +
        `zone=${st.activeZone || 'none'} dd=$${st.maxDrawdown} ` +
        `spread=$${signalSpread.toFixed(4)} z=${stats.zScore.toFixed(2)} ` +
        `price=$${deribitMid.toFixed(2)}`;
      console.log(`[PaperTrade Status] ${statusLine}`);
      // Same cadence as console (30s) so the log file is not silent for minutes.
      if (_LOG_FILE) {
        fs.appendFileSync(_LOG_FILE, `[${new Date().toISOString()}] STATUS | ${statusLine}\n`);
      }
    }
  }
}

// ─── Deribit WebSocket (paper-trade-only, separate from live streams) ───────

function _connectDeribit() {
  if (!_running || _stopTimeReached()) return;
  console.log(`[PaperWS Deribit] Connecting...`);
  _deribitWs = new WebSocket('wss://www.deribit.com/ws/api/v2');

  _deribitWs.on('open', () => {
    console.log(`[PaperWS Deribit] Connected — subscribing ${DERIBIT_SYMBOL}`);
    _deribitWs.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'public/subscribe',
      params: { channels: [`book.${DERIBIT_SYMBOL}.none.20.100ms`] },
    }));
  });

  _deribitWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.params?.channel?.startsWith('book.') && msg.params?.data) {
        const book = msg.params.data;
        const bids = (book.bids || []).slice(0, 10).map(b => ({ price: String(b[0]), size: String(b[1]) }));
        const asks = (book.asks || []).slice(0, 10).map(a => ({ price: String(a[0]), size: String(a[1]) }));
        if (bids.length > 0 && asks.length > 0) {
          if (!_deribitFirstTick) { _deribitFirstTick = true; console.log(`[PaperWS Deribit] First book: bid=$${bids[0].price} ask=$${asks[0].price}`); }
          _deribitBook = { bids, asks, exchange: 'deribit', symbol: DERIBIT_SYMBOL, timestamp: Date.now() };
          _onBookUpdate();
        }
      }
    } catch (_) {}
  });

  _deribitWs.on('close', () => {
    if (!_running) return;
    console.log('[PaperWS Deribit] Disconnected — reconnecting in 5s');
    _scheduleDeribitReconnect();
  });

  _deribitWs.on('error', (err) => {
    console.error(`[PaperWS Deribit] Error: ${err.message}`);
    try { _deribitWs.close(); } catch (_) {}
    _scheduleDeribitReconnect();
  });
}

function _scheduleDeribitReconnect() {
  if (_deribitReconnect || !_running) return;
  if (_stopTimeReached()) { stop('Stop time'); return; }
  _deribitReconnect = setTimeout(() => { _deribitReconnect = null; _connectDeribit(); }, 5000);
}

// ─── Hyperliquid WebSocket (paper-trade-only, separate from live streams) ───

function _connectHyperliquid() {
  if (!_running || _stopTimeReached()) return;
  console.log(`[PaperWS Hyperliquid] Connecting...`);
  _hyperWs = new WebSocket('wss://api.hyperliquid.xyz/ws');

  _hyperWs.on('open', () => {
    console.log(`[PaperWS Hyperliquid] Connected — subscribing ${HYPER_COIN}`);
    _hyperWs.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'l2Book', coin: HYPER_COIN },
    }));
  });

  _hyperWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.channel === 'l2Book' && msg.data) {
        const book = msg.data;
        const bids = (book.levels?.[0] || []).slice(0, 10).map(l => ({ price: l.px, size: l.sz }));
        const asks = (book.levels?.[1] || []).slice(0, 10).map(l => ({ price: l.px, size: l.sz }));
        if (bids.length > 0 && asks.length > 0) {
          if (!_hyperFirstTick) { _hyperFirstTick = true; console.log(`[PaperWS Hyperliquid] First book: bid=$${bids[0].price} ask=$${asks[0].price}`); }
          _hyperBook = { bids, asks, exchange: 'hyperliquid', symbol: HYPER_COIN, timestamp: Date.now() };
          _onBookUpdate();
        }
      }
    } catch (_) {}
  });

  _hyperWs.on('close', () => {
    if (!_running) return;
    console.log('[PaperWS Hyperliquid] Disconnected — reconnecting in 5s');
    _scheduleHyperReconnect();
  });

  _hyperWs.on('error', (err) => {
    console.error(`[PaperWS Hyperliquid] Error: ${err.message}`);
    try { _hyperWs.close(); } catch (_) {}
    _scheduleHyperReconnect();
  });
}

function _scheduleHyperReconnect() {
  if (_hyperReconnect || !_running) return;
  if (_stopTimeReached()) { stop('Stop time'); return; }
  _hyperReconnect = setTimeout(() => { _hyperReconnect = null; _connectHyperliquid(); }, 5000);
}

// ─── Public API ─────────────────────────────────────────────────────────────

function start(opts = {}) {
  if (_running) { console.log('[PaperTrade] Already running'); return; }

  _STOP_AT = null;
  if (opts.stopAt != null && opts.stopAt !== '') {
    const t = new Date(opts.stopAt).getTime();
    if (Number.isFinite(t)) {
      if (t <= Date.now()) {
        console.warn('[PaperTrade] stopAt is in the past — ignoring (no scheduled stop)');
      } else {
        _STOP_AT = t;
      }
    }
  }

  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  _LOG_FILE     = path.join(LOG_DIR, 'paper_trade_sol_live.log');
  _SUMMARY_FILE = path.join(LOG_DIR, 'paper_trade_sol_live_summary.txt');
  _CSV_FILE     = path.join(LOG_DIR, 'paper_trades_sol_live.csv');

  const CSV_HEADER = 'timestamp,type,zone,level,qty,spread,price,asAsk,asBid,regime,zScore,inventory,pnlUsd,equity,holdSec,peakNarrow,exitReason\n';
  // Consolidate any old timestamped CSVs into the live file
  const oldCsvs = fs.readdirSync(LOG_DIR)
    .filter(f => /^paper_trades_sol_2\d{3}.*\.csv$/.test(f))
    .sort();
  if (oldCsvs.length) {
    const allRows = new Set();
    // Collect existing live rows
    if (fs.existsSync(_CSV_FILE)) {
      for (const line of fs.readFileSync(_CSV_FILE, 'utf8').split('\n')) {
        if (line.trim() && !line.startsWith('timestamp,')) allRows.add(line.trim());
      }
    }
    // Collect rows from old timestamped files
    for (const f of oldCsvs) {
      for (const line of fs.readFileSync(path.join(LOG_DIR, f), 'utf8').split('\n')) {
        if (line.trim() && !line.startsWith('timestamp,')) allRows.add(line.trim());
      }
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
    const sorted = [...allRows].sort();
    fs.writeFileSync(_CSV_FILE, CSV_HEADER + sorted.join('\n') + '\n');
    console.log(`[PaperTrade] Merged ${oldCsvs.length} old CSV(s) → ${sorted.length} rows in live file`);
  } else if (!fs.existsSync(_CSV_FILE)) {
    fs.writeFileSync(_CSV_FILE, CSV_HEADER);
  }

  // Recover last equity from existing CSV so we don't reset on restart
  let resumeCapital = opts.capital ?? 3000;
  try {
    const csvContent = fs.readFileSync(_CSV_FILE, 'utf8').trim().split('\n');
    for (let i = csvContent.length - 1; i >= 1; i--) {
      const cols = csvContent[i].split(',');
      if (cols[1] === 'EXIT' && cols[13]) {
        resumeCapital = parseFloat(cols[13]);
        console.log(`[PaperTrade] Resuming from last equity: $${resumeCapital.toFixed(2)}`);
        break;
      }
    }
  } catch (_) { /* first run, no file yet */ }

  // Reset state
  _deribitBook = null; _hyperBook = null;
  _tickCount = 0; _lastStatusAt = 0;
  _deribitFirstTick = false; _hyperFirstTick = false;
  _spreadWindow = [];

  executor.initPaperTrading('paper_sol', {
    capital:          resumeCapital,
    dailyLossLimit:   opts.dailyLossLimit ?? 320,
    cooldownMs:       opts.cooldownMs     ?? 5000,
    analyticsWindow:  opts.analyticsWindow ?? 120,
    tpConfirmTicks:   opts.tpConfirmTicks ?? 3,
    slConfirmTicks:   opts.slConfirmTicks ?? 7,
    minHoldMs:        opts.minHoldMs      ?? 15000,
    hurstGate:        opts.hurstGate      ?? 0.55,
    logFile:          _LOG_FILE,
    csvFile:          _CSV_FILE,

    as: opts.as || {
      gamma_short: 0.08, gamma_long: 0.14,
      beta_premium: 0.75, k: 50.0, tau: 1.5,
    },

    bidWidenLambda: opts.bidWidenLambda ?? 1.0,
    askTightenPhi:  opts.askTightenPhi  ?? 0.6,
    entryLevels:    opts.entryLevels    || [0.06, 0.08, 0.12, 0.18],

    zoneGrid: opts.zoneGrid || { anchorPrice: 83.40, range: 4, zoneCount: 4 },

    zones: opts.zones || [
      { qty: 10, tp: 0.05, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
      { qty: 10, tp: 0.10, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
      { qty: 10, tp: 0.20, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
      { qty: 10, tp: 0.40, sl: 1.0, trailPct: 0.50, maxPositions: 4 },
    ],
  });

  _running = true;

  console.log('═'.repeat(70));
  console.log('  PAPER TRADE ENGINE  (in-process, isolated WS feeds)');
  console.log('═'.repeat(70));
  console.log(`  Deribit symbol:   ${DERIBIT_SYMBOL}`);
  console.log(`  Hyperliquid coin: ${HYPER_COIN}`);
  console.log(`  Stop at:          ${_STOP_AT != null ? new Date(_STOP_AT).toISOString() : 'none (manual / API stop)'}`);
  console.log(`  Log file:         ${_LOG_FILE}`);
  console.log(`  Capital:          $${opts.capital ?? 3000}  |  Anchor: $83.40 ± $4.00`);
  console.log(`  A-S:  γ_s=0.08 γ_l=0.14 β=0.75 k=6.0 τ=1.5s`);
  console.log(`  Mults: MR=0.90 TR=1.20 BO=2.40`);
  console.log(`  Skew:  bid_λ=1.0  ask_φ=0.6`);
  console.log('═'.repeat(70));

  if (_STOP_AT != null && _STOP_AT > Date.now()) {
    _stopTimer = setTimeout(() => stop('Scheduled stop time reached'), _STOP_AT - Date.now());
  }

  _connectDeribit();
  _connectHyperliquid();
}

function stop(reason) {
  if (!_running) return null;
  _running = false;
  console.log(`\n[PaperTrade] Stopping: ${reason || 'manual'}`);

  if (_stopTimer) { clearTimeout(_stopTimer); _stopTimer = null; }
  if (_deribitReconnect) { clearTimeout(_deribitReconnect); _deribitReconnect = null; }
  if (_hyperReconnect) { clearTimeout(_hyperReconnect); _hyperReconnect = null; }
  try { _deribitWs?.close(); } catch (_) {}
  try { _hyperWs?.close(); } catch (_) {}

  const result = executor.stopPaperTrading();
  if (result) {
    console.log('\n' + result.summary);

    const tradeDetails = result.trades.map((t, i) =>
      `${String(i + 1).padStart(4)}. ${(t.exitReason || 'open').padEnd(16)} zone=${(t.zoneId || '').padEnd(8)} ` +
      `lvl=${t.gridLevel} qty=${t.qty} entry=$${t.entrySpread.toFixed(4)} ` +
      `exit=$${(t.exitSpread || 0).toFixed(4)} pnl=$${(t.pnlUsd || 0).toFixed(4)} ` +
      `hold=${((t.holdMs || 0) / 1000).toFixed(0)}s`
    ).join('\n');

    fs.writeFileSync(_SUMMARY_FILE, result.summary + '\n\nTRADE DETAILS:\n' + tradeDetails + '\n', 'utf8');
    console.log(`[PaperTrade] Summary saved: ${_SUMMARY_FILE}`);
    console.log(`[PaperTrade] Trades CSV:    ${_CSV_FILE}`);
    console.log(`[PaperTrade] Full log:      ${_LOG_FILE}`);
  }
  return result;
}

function getState() {
  return executor.getPaperState();
}

function isRunning() {
  return _running;
}

function getLogFile() {
  return _LOG_FILE;
}

function getCsvFile()     { return _CSV_FILE; }
function getSummaryFile() { return _SUMMARY_FILE; }

module.exports = { start, stop, getState, isRunning, getLogFile, getCsvFile, getSummaryFile };
