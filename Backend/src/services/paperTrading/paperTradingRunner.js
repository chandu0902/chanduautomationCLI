/**
 * Paper Trading Runner — wires PaperUnilateralExecutor to the live orderbook feed.
 *
 * Responsibilities:
 *  - Load pair config from DB (StatArbInput) or accept a plain config object.
 *  - Subscribe to orderbookStreams spread updates.
 *  - Provide start/stop/status API used by REST routes.
 *
 * One runner instance per process. Multiple pairs are supported.
 */

'use strict';

const path = require('path');
const { PaperUnilateralExecutor } = require('./paperUnilateralExecutor');

// Map<pairId, { exec: PaperUnilateralExecutor, unsubscribe: fn }>
const _runners = new Map();

/**
 * Start paper trading for a pair.
 * @param {object} cfg  StatArbInput DB row (or plain object with same fields).
 * @param {string} [logDir]  Directory for trade logs. Defaults to Backend/reports/paper_uni/<pairId>
 */
async function startPaper(cfg, logDir) {
  const pairId = String(cfg.id ?? 'paper');
  if (_runners.has(pairId)) {
    return { success: false, message: `Paper trading already running for pair ${pairId}` };
  }

  const dir  = logDir || path.join(__dirname, '../../../../reports/paper_uni', pairId);
  const exec = new PaperUnilateralExecutor(dir);

  try {
    exec.enable(cfg);
  } catch (e) {
    return { success: false, message: `enable failed: ${e.message}` };
  }

  // Hook into orderbookStreams if available
  let unsubscribe = () => {};
  try {
    const orderbookManager = require('../orderbookStreams');

    // orderbookStreams fires spread updates via the onSpreadUpdate callback registered
    // on each active pair executor. We inject ourselves by subscribing to raw WS ticks.
    // The simplest integration: register a paper listener that the stream manager calls.
    if (typeof orderbookManager.addPaperSpreadListener === 'function') {
      unsubscribe = orderbookManager.addPaperSpreadListener(pairId, (sellStats, ctx) => {
        exec.onSpreadUpdate(sellStats, ctx).catch(e =>
          console.error(`[PaperRunner] pair ${pairId} onSpreadUpdate error: ${e.message}`)
        );
      });
    } else {
      console.warn(
        `[PaperRunner] orderbookStreams.addPaperSpreadListener not found. ` +
        `Call exec.onSpreadUpdate(sellStats, ctx) manually from your spread feed.`
      );
    }
  } catch (_) {
    console.warn(`[PaperRunner] orderbookStreams not available — feed spread updates manually.`);
  }

  _runners.set(pairId, { exec, unsubscribe });
  console.log(`[PaperRunner] started pair ${pairId}`);
  return { success: true, pairId };
}

/**
 * Stop paper trading for a pair.
 */
function stopPaper(pairId) {
  const entry = _runners.get(String(pairId));
  if (!entry) return { success: false, message: `No paper runner for pair ${pairId}` };
  entry.exec.disable();
  entry.unsubscribe();
  _runners.delete(String(pairId));
  console.log(`[PaperRunner] stopped pair ${pairId}`);
  return { success: true, pairId };
}

/**
 * Get state of a running paper executor.
 */
function getState(pairId) {
  const entry = _runners.get(String(pairId));
  if (!entry) return null;
  return entry.exec.getState();
}

/**
 * List all active paper pairs.
 */
function listActive() {
  return [..._runners.keys()];
}

/**
 * Feed a spread update manually (use when orderbookStreams integration is not available).
 * @param {string|number} pairId
 * @param {object} sellStats  { zScore, ... }
 * @param {object} ctx        { leg1: orderbook, leg2: orderbook }
 */
async function feedSpreadUpdate(pairId, sellStats, ctx) {
  const entry = _runners.get(String(pairId));
  if (!entry) return;
  await entry.exec.onSpreadUpdate(sellStats, ctx);
}

/**
 * Direct access to the executor instance (for advanced use).
 */
function getExecutor(pairId) {
  return _runners.get(String(pairId))?.exec ?? null;
}

module.exports = {
  startPaper,
  stopPaper,
  getState,
  listActive,
  feedSpreadUpdate,
  getExecutor,
};
