/**
 * reconcileJob.js
 *
 * Every RECONCILE_INTERVAL_MS (default 5 min) — and once immediately on boot —
 * this job compares every open/pending BasisPosition row against the real
 * Deribit order state and corrects mismatches so no ghost rows survive a restart.
 *
 * Cases handled:
 *  A. pending_entry  + order NOT_FOUND / cancelled  → mark failed
 *  B. pending_entry  + order filled                 → promote to open
 *  C. open           + legA_exitOrderId set + order NOT_FOUND / cancelled
 *                                                   → clear exit order, keep open
 *  D. open / pending_exit + exit order filled       → mark closed with PnL
 *  E. open           + no exit order                → stamp reconciledAt if exchange still has size
 *  F. open           + no exit order + exchange FLAT on traded leg → close as orphan (external close)
 *  G. open           + sum(legA_entryQty) > exchange size on traded leg → FIFO vs exchange: truncate one row,
 *                     close excess rows at mark (missed exit / restart drift); clear stale exitTradeId
 *
 * After any DB fix the executor's in-memory state is patched via
 * unilateralExecutor._reconcilePatch() so the two stay in sync without a restart.
 *
 * trade_logs (Trade): entry rows are created with status=open before the order fills.
 * When the reconciler fails or promotes a pending_entry BasisPosition, the linked
 * entry Trade row is updated so the UI cannot show ENTRY+open after a dead entry.
 */

const crypto  = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const BasisPosition = require('../models/BasisPosition');
const Trade = require('../models/Trade');
const { StatArbInput, AccountDetails } = require('../models');
const { signedRequest } = require('../controllers/apicontroller');

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── credential cache (decrypted per Trade_Account, lives for process lifetime) ─
const _credCache = new Map(); // Trade_Account → { apiKey, secretKey }

function _decrypt(k, e, i) {
  const key = Buffer.from(k, 'base64');
  const iv  = Buffer.from(i, 'base64');
  const d   = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return d.update(e, 'base64', 'utf8') + d.final('utf8');
}

async function _getCreds(tradeAccount) {
  if (_credCache.has(tradeAccount)) return _credCache.get(tradeAccount);
  const acc = await AccountDetails.findOne({ where: { Trade_Account: tradeAccount } });
  if (!acc) return null;
  const [ak0, ak1, ak2] = acc.Api_Key.split(',', 3);
  const [sk0, sk1, sk2] = acc.Secret_Key.split(',', 3);
  const creds = {
    apiKey:    _decrypt(ak2, ak1, ak0),
    secretKey: _decrypt(sk2, sk1, sk0),
  };
  _credCache.set(tradeAccount, creds);
  return creds;
}

// ─── exchange helpers ────────────────────────────────────────────────────────

async function _orderState(orderId, creds) {
  try {
    const r = await signedRequest(
      `/api/v2/private/get_order_state?order_id=${encodeURIComponent(orderId)}`,
      creds.apiKey, creds.secretKey
    );
    const o = r?.result;
    if (!o) return { state: 'not_found', filledQty: 0, avgPrice: null };
    return {
      state:     (o.order_state || '').toLowerCase(),  // open | filled | cancelled | rejected
      filledQty: parseFloat(o.filled_amount || 0),
      avgPrice:  parseFloat(o.average_price || 0) || null,
    };
  } catch (e) {
    // Deribit returns 400 + code 10004 for unknown order — treat as not_found
    if (e?.deribitErrorCode === 10004 || (e?.message || '').includes('order_not_found')) {
      return { state: 'not_found', filledQty: 0, avgPrice: null };
    }
    throw e;
  }
}

async function _fillsForOrder(orderId, creds) {
  try {
    const r = await signedRequest(
      `/api/v2/private/get_user_trades_by_order?order_id=${encodeURIComponent(orderId)}`,
      creds.apiKey, creds.secretKey
    );
    return Array.isArray(r?.result) ? r.result : [];
  } catch (_) {
    return [];
  }
}

function _isTerminal(state) {
  return state === 'not_found' || state === 'cancelled' || state === 'canceled' || state === 'rejected';
}

/** Deribit positions for currency (no `kind` filter — some venues omit perps when kind=future only). */
async function _fetchLivePositionsByInstrument(creds, currency) {
  try {
    const r = await signedRequest(
      `/api/v2/private/get_positions?currency=${encodeURIComponent(currency)}`,
      creds.apiKey,
      creds.secretKey
    );
    const map = new Map();
    for (const p of Array.isArray(r?.result) ? r.result : []) {
      const nm = String(p.instrument_name || '').trim();
      if (!nm) continue;
      const key = nm.toUpperCase();
      const sz = parseFloat(p.size || 0);
      const row = { size: sz, average_price: parseFloat(p.average_price || 0) || null };
      const prev = map.get(key);
      if (!prev || Math.abs(sz) > Math.abs(parseFloat(prev.size || 0))) map.set(key, row);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function _settlementCurrencyFromPair(pair) {
  const s1 = (pair.symbol1 || '').toUpperCase();
  const s2 = (pair.symbol2 || '').toUpperCase();
  if (s1.includes('_USDC') || s2.includes('_USDC')) return 'USDC';
  if (s1.includes('SOL') || s2.includes('SOL')) return 'SOL';
  if (s1.includes('ETH') || s2.includes('ETH')) return 'ETH';
  return 'BTC';
}

/** Absolute position size for instrument_name (missing key => flat). Keys in map are UPPERCASE. */
function _liveAbsSizeForInstrument(positionMap, instrumentName) {
  if (!instrumentName) return 0;
  const key = String(instrumentName).trim().toUpperCase();
  const row = positionMap.get(key);
  if (!row) return 0;
  return Math.abs(parseFloat(row.size || 0));
}

async function _getMarkPrice(creds, instrumentName) {
  if (!instrumentName) return null;
  try {
    const r = await signedRequest(
      `/api/v2/public/ticker?instrument_name=${encodeURIComponent(instrumentName)}`,
      creds.apiKey,
      creds.secretKey
    );
    const mark = parseFloat(r?.result?.mark_price || r?.result?.last_price || 0);
    return Number.isFinite(mark) && mark > 0 ? mark : null;
  } catch (_) {
    return null;
  }
}

/**
 * DB says open but exchange has no size on the traded instrument — close row with mark-based PnL.
 */
async function _closeOrphanFlatExchange(pos, pair, isLegB, isLinear, now, creds, tag, pairId) {
  const tradedSym = isLegB ? pair.symbol2 : pair.symbol1;
  const signalSym = isLegB ? pair.symbol1 : pair.symbol2;
  const entryPx = parseFloat(pos.legA_entryPrice || 0);
  const qty = parseFloat(pos.legA_entryQty || 0);
  const exitLegA = (await _getMarkPrice(creds, tradedSym)) || entryPx;
  const refLegB = (await _getMarkPrice(creds, signalSym)) || parseFloat(pos.legB_entryPrice || 0);
  const exitSpread = isLegB
    ? parseFloat((refLegB - exitLegA).toFixed(4))
    : parseFloat((exitLegA - refLegB).toFixed(4));
  const grossPnl = (entryPx && exitLegA && qty)
    ? _computeNetPnl(isLegB, isLinear, qty, entryPx, exitLegA)
    : 0;
  let entryCommUsd = 0;
  if (pos.legA_entryOrderId) {
    const efills = await _fillsForOrder(pos.legA_entryOrderId, creds);
    entryCommUsd = _sumFeeUsd(efills, isLinear);
  }
  const totalCommission = parseFloat(entryCommUsd.toFixed(6));
  const netPnl = parseFloat((grossPnl + totalCommission).toFixed(6));
  const holdMs = Math.min(
    pos.entryTime ? now.getTime() - new Date(pos.entryTime).getTime() : 0,
    2147483647
  );

  await BasisPosition.update({
    state: 'closed',
    exitTime: now,
    holdMs,
    exitReason: 'exchange_flat_orphan',
    legA_exitPrice: exitLegA,
    legB_exitPrice: refLegB,
    legA_exitOrderId: null,
    exitSpread,
    spreadChange: parseFloat((exitSpread - (pos.entrySpread || 0)).toFixed(4)),
    legA_pnl: grossPnl,
    legB_pnl: 0,
    grossPnl,
    commission: totalCommission,
    takerFeeUsd: 0,
    netPnl,
    reconciledAt: now,
    reconcileNote: `reconciler: exchange flat on ${tradedSym} while DB open — closed as orphan (mark exit)`,
  }, { where: { id: pos.id, state: { [Op.in]: ['open', 'pending_exit'] } } });

  console.log(
    `${tag} #${pos.id} pair ${pairId} — DB open but exchange flat on ${tradedSym} → closed orphan ` +
    `(mark exit legA=${exitLegA}, netPnl=${netPnl})`
  );
}

/**
 * Close one open basis row at current mark (same PnL math as orphan-flat) when the row
 * is bookkeeping-only: exchange size is lower than the sum of open DB notionals.
 */
async function _closeGhostQtyMismatchRow(pos, pair, isLegB, isLinear, now, creds, tag, pairId) {
  const tradedSym = isLegB ? pair.symbol2 : pair.symbol1;
  const signalSym = isLegB ? pair.symbol1 : pair.symbol2;
  const entryPx = parseFloat(pos.legA_entryPrice || 0);
  const qty = parseFloat(pos.legA_entryQty || 0);
  const exitLegA = (await _getMarkPrice(creds, tradedSym)) || entryPx;
  const refLegB = (await _getMarkPrice(creds, signalSym)) || parseFloat(pos.legB_entryPrice || 0);
  const exitSpread = isLegB
    ? parseFloat((refLegB - exitLegA).toFixed(4))
    : parseFloat((exitLegA - refLegB).toFixed(4));
  const grossPnl = (entryPx && exitLegA && qty)
    ? _computeNetPnl(isLegB, isLinear, qty, entryPx, exitLegA)
    : 0;
  let entryCommUsd = 0;
  if (pos.legA_entryOrderId) {
    const efills = await _fillsForOrder(pos.legA_entryOrderId, creds);
    entryCommUsd = _sumFeeUsd(efills, isLinear);
  }
  const totalCommission = parseFloat(entryCommUsd.toFixed(6));
  const netPnl = parseFloat((grossPnl + totalCommission).toFixed(6));
  const holdMs = Math.min(
    pos.entryTime ? now.getTime() - new Date(pos.entryTime).getTime() : 0,
    2147483647
  );

  await BasisPosition.update({
    state: 'closed',
    exitTime: now,
    holdMs,
    exitReason: 'exchange_qty_reconcile',
    legA_exitPrice: exitLegA,
    legB_exitPrice: refLegB,
    legA_exitOrderId: null,
    exitTradeId: null,
    exitSpread,
    spreadChange: parseFloat((exitSpread - (pos.entrySpread || 0)).toFixed(4)),
    legA_pnl: grossPnl,
    legB_pnl: 0,
    grossPnl,
    commission: totalCommission,
    takerFeeUsd: 0,
    netPnl,
    reconciledAt: now,
    reconcileNote: `${tag} closed ghost row — summed open DB qty exceeded exchange ${tradedSym} size (mark exit)`,
  }, { where: { id: pos.id, state: { [Op.in]: ['open', 'pending_exit'] } } });

  console.log(
    `${tag} #${pos.id} pair ${pairId} — qty-reconcile ghost close (mark legA=${exitLegA}, netPnl=${netPnl})`
  );
}

/** exitTradeId left pointing at a cancelled/failed exit trade after restart / race. */
async function _clearStaleExitTradePointers(pairId, now, tag) {
  const sequelize = BasisPosition.sequelize;
  const rows = await sequelize.query(
    `SELECT bp.id AS id FROM basis_positions bp
     INNER JOIN trade_logs t ON t.id = bp.exitTradeId
     WHERE bp.pairId = :pairId AND bp.state = 'open'
       AND t.side = 'exit' AND t.status IN ('cancelled','failed')`,
    { type: QueryTypes.SELECT, replacements: { pairId } }
  );
  let n = 0;
  for (const row of rows) {
    await BasisPosition.update({
      exitTradeId: null,
      reconciledAt: now,
      reconcileNote: `${tag} cleared exitTradeId — linked exit trade was cancelled/failed`,
    }, { where: { id: row.id } }).catch(() => {});
    n++;
    console.log(`${tag} pair ${pairId} bp #${row.id} — cleared stale exitTradeId`);
  }
  return n;
}

/**
 * When sum(open legA_entryQty) on the traded instrument exceeds exchange abs size,
 * treat exchange as truth: allocate FIFO (oldest rows first) up to liveAbs, truncate one row,
 * close younger rows at mark (missed exit bookkeeping / restarts / external size reduction).
 */
async function _reconcileOpenQtyVsExchange(
  pairId,
  pair,
  livePosByInstrument,
  creds,
  isLegB,
  isLinear,
  now,
  tag,
  executor,
  executorV2
) {
  const tradedSym = String((isLegB ? pair.symbol2 : pair.symbol1) || '').trim();
  if (!tradedSym) return 0;

  const liveAbs = _liveAbsSizeForInstrument(livePosByInstrument, tradedSym);
  if (liveAbs < 1e-6) return 0;

  const openRows = await BasisPosition.findAll({
    where: { pairId, state: { [Op.in]: ['open', 'pending_exit'] } },
    order: [['entryTime', 'ASC']],
  });
  if (!openRows.length) return 0;

  const sumDb = openRows.reduce((s, r) => s + Math.abs(parseFloat(r.legA_entryQty || 0)), 0);
  const EPS = 5;
  if (sumDb <= liveAbs + EPS) return 0;
  if (sumDb + EPS < liveAbs) {
    console.warn(
      `${tag} pair ${pairId} — exchange ${liveAbs} > DB open sum ${sumDb} on ${tradedSym} (undercount); skip qty-reconcile`
    );
    return 0;
  }

  let fixed = 0;
  let capLeft = liveAbs;

  for (const row of openRows) {
    const q = Math.abs(parseFloat(row.legA_entryQty || 0));
    const keep = Math.min(q, capLeft);
    capLeft -= keep;

    if (keep >= q - EPS) {
      continue;
    }
    if (keep <= EPS) {
      await _closeGhostQtyMismatchRow(row, pair, isLegB, isLinear, now, creds, tag, pairId);
      _execRemove(executor, executorV2, pairId, row.id);
      fixed++;
      continue;
    }
    const newQty = Math.floor(keep / 10) * 10;
    if (newQty < 10) {
      await _closeGhostQtyMismatchRow(row, pair, isLegB, isLinear, now, creds, tag, pairId);
      _execRemove(executor, executorV2, pairId, row.id);
      fixed++;
      continue;
    }
    await BasisPosition.update(
      {
        legA_entryQty: newQty,
        exitTradeId: null,
        reconciledAt: now,
        reconcileNote:
          `${tag} qty reconcile: DB open sum=${sumDb} > exchange=${liveAbs} on ${tradedSym}; ` +
          `FIFO kept oldest lots — row ${q} → ${newQty}`,
      },
      { where: { id: row.id, state: { [Op.in]: ['open', 'pending_exit'] } } }
    );
    _execQtyPatch(executor, executorV2, pairId, row.id, newQty);
    console.log(`${tag} pair ${pairId} bp #${row.id} — truncated qty ${q} → ${newQty}`);
    fixed++;
  }

  return fixed;
}

// ─── PnL computation (mirrors unilateralExecutor logic) ─────────────────────

function _computeNetPnl(isLegB, isLinear, qty, entryPriceA, exitPriceA, exitPx) {
  let grossPnl;
  if (isLinear) {
    grossPnl = isLegB
      ? parseFloat((qty * (exitPriceA - entryPriceA)).toFixed(6))
      : parseFloat((qty * (entryPriceA - exitPriceA)).toFixed(6));
  } else {
    const pnlBtc = isLegB
      ? parseFloat((qty * (1 / entryPriceA - 1 / exitPriceA)).toFixed(8))
      : parseFloat((qty * (1 / exitPriceA - 1 / entryPriceA)).toFixed(8));
    grossPnl = parseFloat((pnlBtc * exitPriceA).toFixed(6));
  }
  return grossPnl;
}

function _sumFeeUsd(fills, isLinear) {
  // Deribit: fee < 0 = maker rebate (income). Negate → positive = income.
  let total = 0;
  for (const f of fills) {
    const fee = Number(f?.fee ?? 0);
    const feeCurrency = String(f?.fee_currency || '').toUpperCase();
    const px = Number(f?.price ?? 0);
    if (feeCurrency === 'BTC' && px > 0) {
      total += -fee * px;
    } else {
      total += -fee;
    }
  }
  return Number.isFinite(total) ? parseFloat(total.toFixed(6)) : 0;
}

// ─── main reconcile pass ─────────────────────────────────────────────────────

async function reconcileAll() {
  const tag = '[Reconcile]';
  const now = new Date();

  // Lazy-load executors to avoid circular dependency at module load time
  let executor = null;
  let executorV2 = null;
  try { executor = require('./unilateralExecutor'); } catch (_) {}
  try { executorV2 = require('./unilateralExecutorV2'); } catch (_) {}

  const pairMap = new Map();

  // Fetch all positions that could be mismatched
  const positions = await BasisPosition.findAll({
    where: {
      state: { [Op.in]: ['pending_entry', 'open', 'pending_exit'] },
    },
    order: [['id', 'ASC']],
  });

  if (positions.length === 0) return;
  console.log(`${tag} checking ${positions.length} open/pending position(s)…`);

  const pairIdsForRows = [...new Set(positions.map((p) => p.pairId))];
  const pairRowsForMap = await StatArbInput.findAll({ where: { id: { [Op.in]: pairIdsForRows } } });
  for (const p of pairRowsForMap) pairMap.set(p.id, p);

  // Group by pairId so we only decrypt credentials once per pair
  const byPair = new Map();
  for (const pos of positions) {
    if (!byPair.has(pos.pairId)) byPair.set(pos.pairId, []);
    byPair.get(pos.pairId).push(pos);
  }

  let fixed = 0;

  for (const [pairId, posList] of byPair) {
    const pair = pairMap.get(pairId);
    if (!pair) continue;

    const creds = await _getCreds(pair.tradeAccountA).catch(() => null);
    if (!creds) {
      console.warn(`${tag} pair ${pairId} — no credentials for account "${pair.tradeAccountA}", skipping`);
      continue;
    }

    const isLinear = (pair.symbol1 || '').includes('_USDC');
    const isLegB   = (pair.tradeLeg || 'A').toUpperCase() === 'B';
    const ccy = _settlementCurrencyFromPair(pair);
    const livePosByInstrument = await _fetchLivePositionsByInstrument(creds, ccy);

    for (const pos of posList) {
      try {
        // ── A / B: pending_entry ──────────────────────────────────────────
        if (pos.state === 'pending_entry') {
          if (!pos.legA_entryOrderId) {
            // No order ID stored — can't check; mark failed
            await _markFailed(pos, 'pending_entry_no_order_id', now);
            _execRemove(executor, executorV2, pairId, pos.id);
            console.log(`${tag} #${pos.id} pair ${pairId} — pending_entry with no orderId → failed`);
            fixed++;
            continue;
          }

          const os = await _orderState(pos.legA_entryOrderId, creds);

          if (_isTerminal(os.state)) {
            const fillsEntry = await _fillsForOrder(pos.legA_entryOrderId, creds);
            if (fillsEntry.length > 0) {
              let sumPxAmt = 0;
              let sumAmt = 0;
              for (const f of fillsEntry) {
                const px = parseFloat(f.price || 0);
                const amt = Math.abs(parseFloat(f.amount || 0));
                if (px > 0 && amt > 0) {
                  sumPxAmt += px * amt;
                  sumAmt += amt;
                }
              }
              const fillPx = sumAmt > 0 ? sumPxAmt / sumAmt : (os.avgPrice || parseFloat(pos.legA_entryPrice || 0));
              await BasisPosition.update({
                state: 'open',
                legA_entryPrice: fillPx,
                reconciledAt: now,
                reconcileNote: `entry promoted by reconciler (fills after order ${os.state})`,
              }, { where: { id: pos.id } });
              const entryCommUsd = _sumFeeUsd(fillsEntry, isLinear);
              const legBpx = parseFloat(pos.legB_entryPrice || 0) || null;
              await _fillEntryTradeFromReconcile(pos.entryTradeId, fillPx, legBpx, entryCommUsd, now);
              _execPromoteToOpen(executor, executorV2, pairId, pos.id, fillPx);
              console.log(`${tag} #${pos.id} pair ${pairId} — entry had fills while order ${os.state} → promoted open @ ${fillPx}`);
              fixed++;
              continue;
            }
            // Case A: order gone — entry never filled
            await _markFailed(pos, `entry_order_${os.state}`, now);
            _execRemove(executor, executorV2, pairId, pos.id);
            console.log(`${tag} #${pos.id} pair ${pairId} — entry order ${pos.legA_entryOrderId} is ${os.state} → failed`);
            fixed++;

          } else if (os.state === 'filled') {
            // Case B: filled but DB not updated — promote to open
            const fillPx = os.avgPrice || parseFloat(pos.legA_entryPrice || 0);
            await BasisPosition.update({
              state: 'open',
              legA_entryPrice: fillPx,
              reconciledAt: now,
              reconcileNote: `entry promoted by reconciler at ${now.toISOString()}`,
            }, { where: { id: pos.id } });
            const fillsFilled = await _fillsForOrder(pos.legA_entryOrderId, creds);
            const entryCommUsd2 = _sumFeeUsd(fillsFilled, isLinear);
            const legBpx2 = parseFloat(pos.legB_entryPrice || 0) || null;
            await _fillEntryTradeFromReconcile(pos.entryTradeId, fillPx, legBpx2, entryCommUsd2, now);
            _execPromoteToOpen(executor, executorV2, pairId, pos.id, fillPx);
            console.log(`${tag} #${pos.id} pair ${pairId} — entry was filled @ ${fillPx} → promoted to open`);
            fixed++;

          } else {
            // still open (in flight) — stamp reconciledAt and move on
            await BasisPosition.update({ reconciledAt: now }, { where: { id: pos.id } }).catch(() => {});
          }
          continue;
        }

        // ── C / D: open with exit order in flight ────────────────────────
        if ((pos.state === 'open' || pos.state === 'pending_exit') && pos.legA_exitOrderId) {
          const os = await _orderState(pos.legA_exitOrderId, creds);

          if (_isTerminal(os.state)) {
            // Exit order gone from get_order_state — may still have fills (filled then archived)
            const fillsCheck = await _fillsForOrder(pos.legA_exitOrderId, creds);
            if (fillsCheck.length > 0) {
              let sumPxAmt = 0;
              let sumAmt = 0;
              for (const f of fillsCheck) {
                const px = parseFloat(f.price || 0);
                const amt = Math.abs(parseFloat(f.amount || 0));
                if (px > 0 && amt > 0) {
                  sumPxAmt += px * amt;
                  sumAmt += amt;
                }
              }
              const exitPxFromFills = sumAmt > 0 ? sumPxAmt / sumAmt : (os.avgPrice || parseFloat(pos.legA_entryPrice || 0));
              const entryPx = parseFloat(pos.legA_entryPrice || 0);
              const qty = parseFloat(pos.legA_entryQty || 0);
              const commissionUsd = _sumFeeUsd(fillsCheck, isLinear);
              const grossPnl = (entryPx && exitPxFromFills && qty)
                ? _computeNetPnl(isLegB, isLinear, qty, entryPx, exitPxFromFills)
                : null;
              const netPnl = (grossPnl != null) ? parseFloat((grossPnl + commissionUsd).toFixed(6)) : null;
              await BasisPosition.update({
                state: 'closed',
                legA_exitPrice: exitPxFromFills,
                exitTime: now,
                holdMs: pos.entryTime ? now.getTime() - new Date(pos.entryTime).getTime() : null,
                exitReason: pos.exitReason || 'reconciler_close',
                exitSpread: null,
                spreadChange: null,
                grossPnl,
                commission: commissionUsd,
                netPnl,
                reconciledAt: now,
                reconcileNote: `exit closed by reconciler (fills after order ${os.state}) @ ${exitPxFromFills}`,
              }, { where: { id: pos.id } });
              const legBRefPx = parseFloat(pos.legB_entryPrice || 0);
              await _fillExitTradeFromReconcile(pos.exitTradeId, {
                exitPx: exitPxFromFills,
                legBRefPx: Number.isFinite(legBRefPx) && legBRefPx > 0 ? legBRefPx : null,
                grossPnl,
                netPnl,
                commissionUsd,
                spreadAtExit: null,
                at: now,
              });
              _execRemove(executor, executorV2, pairId, pos.id);
              console.log(`${tag} #${pos.id} pair ${pairId} — exit had fills while order ${os.state} → closed netPnl=${netPnl}`);
              fixed++;
              continue;
            }
            // Case C: exit order vanished — reset to open so bot re-triggers exit
            await BasisPosition.update({
              state: 'open',
              legA_exitOrderId: null,
              exitReason: null,
              reconciledAt: now,
              reconcileNote: `exit order ${pos.legA_exitOrderId} ${os.state} — cleared by reconciler`,
            }, { where: { id: pos.id } });
            _execResetExit(executor, executorV2, pairId, pos.id, pos.legA_exitOrderId);
            console.log(`${tag} #${pos.id} pair ${pairId} — exit order ${pos.legA_exitOrderId} is ${os.state} → reset to open`);
            fixed++;

          } else if (os.state === 'filled') {
            // Case D: exit filled but DB not updated — close with PnL
            const exitPx = os.avgPrice || parseFloat(pos.legA_exitPrice || pos.legA_entryPrice || 0);
            const entryPx = parseFloat(pos.legA_entryPrice || 0);
            const qty     = parseFloat(pos.legA_entryQty || 0);

            const fills = await _fillsForOrder(pos.legA_exitOrderId, creds);
            const commissionUsd = _sumFeeUsd(fills, isLinear);
            const grossPnl = (entryPx && exitPx && qty)
              ? _computeNetPnl(isLegB, isLinear, qty, entryPx, exitPx)
              : null;
            const netPnl = (grossPnl != null) ? parseFloat((grossPnl + commissionUsd).toFixed(6)) : null;

            await BasisPosition.update({
              state: 'closed',
              legA_exitPrice: exitPx,
              exitTime: now,
              holdMs: pos.entryTime ? now.getTime() - new Date(pos.entryTime).getTime() : null,
              exitReason: pos.exitReason || 'reconciler_close',
              exitSpread: null,
              spreadChange: null,
              grossPnl,
              commission: commissionUsd,
              netPnl,
              reconciledAt: now,
              reconcileNote: `exit closed by reconciler — order ${pos.legA_exitOrderId} filled @ ${exitPx}`,
            }, { where: { id: pos.id } });
            const legBRefPx2 = parseFloat(pos.legB_entryPrice || 0);
            await _fillExitTradeFromReconcile(pos.exitTradeId, {
              exitPx,
              legBRefPx: Number.isFinite(legBRefPx2) && legBRefPx2 > 0 ? legBRefPx2 : null,
              grossPnl,
              netPnl,
              commissionUsd,
              spreadAtExit: null,
              at: now,
            });
            _execRemove(executor, executorV2, pairId, pos.id);
            console.log(`${tag} #${pos.id} pair ${pairId} — exit filled @ ${exitPx}, netPnl=${netPnl} → closed`);
            fixed++;

          } else {
            // exit order still open (in flight) — healthy, just stamp
            await BasisPosition.update({ reconciledAt: now }, { where: { id: pos.id } }).catch(() => {});
          }
          continue;
        }

      } catch (err) {
        console.error(`${tag} #${pos.id} pair ${pairId} — error: ${err.message}`);
      }
    }

    // ── G: Stale exitTradeId + DB open qty vs exchange FIFO (missed exit bookkeeping / restarts).
    try {
      fixed += await _clearStaleExitTradePointers(pairId, now, tag);
      fixed += await _reconcileOpenQtyVsExchange(
        pairId, pair, livePosByInstrument, creds, isLegB, isLinear, now, tag, executor, executorV2
      );
    } catch (err) {
      console.error(`${tag} pair ${pairId} stale-exit / qty sync: ${err.message}`);
    }

    // ── F: Exchange FLAT on traded leg but DB still open/pending_exit (orphan, stale exit id, manual close).
    // Include rows WITH legA_exitOrderId — those were excluded before and never closed.
    const tradedSym = String((isLegB ? pair.symbol2 : pair.symbol1) || '').trim();
    const liveAbs = _liveAbsSizeForInstrument(livePosByInstrument, tradedSym);
    const exchangeFlat = liveAbs < 1e-6;

    const openish = await BasisPosition.findAll({
      where: { pairId, state: { [Op.in]: ['open', 'pending_exit'] } },
    });

    if (openish.length > 0 && !exchangeFlat) {
      const keysSample = [...livePosByInstrument.keys()].slice(0, 12).join(', ');
      console.log(
        `${tag} pair ${pairId} traded=${tradedSym} liveAbs=${liveAbs} dbOpenish=${openish.length} ` +
        `posInstruments(sample)=${keysSample || '(empty)'}`
      );
    }

    for (const pos of openish) {
      try {
        if (exchangeFlat) {
          await _closeOrphanFlatExchange(pos, pair, isLegB, isLinear, now, creds, tag, pairId);
          _execRemove(executor, executorV2, pairId, pos.id);
          fixed++;
        } else if (pos.state === 'open' && !pos.legA_exitOrderId) {
          await BasisPosition.update({ reconciledAt: now }, { where: { id: pos.id } }).catch(() => {});
        }
      } catch (err) {
        console.error(`${tag} orphan-flat #${pos.id} pair ${pairId} — ${err.message}`);
      }
    }
  }

  // Backfill: entry trade_logs left status=open when basis_positions was already failed (legacy desync).
  try {
    const sequelize = BasisPosition.sequelize;
    const staleIds = await sequelize.query(
      `SELECT t.id AS id FROM trade_logs t
       INNER JOIN basis_positions bp ON bp.entryTradeId = t.id
       WHERE t.side = 'entry' AND t.status = 'open' AND bp.state = 'failed'`,
      { type: QueryTypes.SELECT }
    );
    for (const row of staleIds) {
      await Trade.update(
        { status: 'cancelled', cancelReason: 'basis_failed_trade_sync_backfill' },
        { where: { id: row.id, side: 'entry', status: 'open' } }
      ).catch(() => {});
      fixed++;
    }
    if (staleIds.length) {
      console.log(`${tag} backfilled ${staleIds.length} entry trade_log(s) (open → cancelled, basis failed)`);
    }
  } catch (e) {
    console.warn(`${tag} trade_log backfill skipped: ${e.message}`);
  }

  // Backfill: exit trade_logs left status=open when basis_positions was already closed by reconciler.
  try {
    const sequelize = BasisPosition.sequelize;
    const staleExits = await sequelize.query(
      `SELECT t.id AS id, bp.legA_exitPrice AS exitPx, bp.exitTime AS exitAt, bp.netPnl AS netPnl,
              bp.grossPnl AS grossPnl, bp.commission AS commission
       FROM trade_logs t
       INNER JOIN basis_positions bp ON bp.exitTradeId = t.id
       WHERE t.side = 'exit' AND t.status = 'open' AND bp.state = 'closed'`,
      { type: QueryTypes.SELECT }
    );
    for (const row of staleExits) {
      await Trade.update(
        {
          status: 'filled',
          legA_price: row.exitPx,
          legA_filledAt: row.exitAt,
          legB_filledAt: row.exitAt,
          pnl: row.netPnl,
          legA_pnl: row.grossPnl,
          legB_pnl: 0,
          commission: row.commission,
        },
        { where: { id: row.id, side: 'exit', status: 'open' } }
      ).catch(() => {});
      fixed++;
    }
    if (staleExits.length) {
      console.log(`${tag} backfilled ${staleExits.length} exit trade_log(s) (open → filled, basis already closed)`);
    }
  } catch (e) {
    console.warn(`${tag} exit trade_log backfill skipped: ${e.message}`);
  }

  if (fixed > 0) {
    console.log(`${tag} ✓ fixed ${fixed} position(s)`);
  } else {
    console.log(`${tag} ✓ all ${positions.length} position(s) healthy`);
  }
}

// ─── helpers to patch executor in-memory state ──────────────────────────────

function _execRemove(executor, executorV2, pairId, bpId) {
  _execRemoveOne(executor, pairId, bpId);
  _execRemoveOne(executorV2, pairId, bpId);
}

function _execRemoveOne(executor, pairId, bpId) {
  if (!executor) return;
  try {
    const state = executor.pairs?.get(pairId);
    if (!state) return;
    const pos = state.openPositions.find((p) => p.basisPositionId === bpId);
    const removedQty = pos ? parseFloat(pos.qty || 0) : 0;
    const before = state.openPositions.length;
    state.openPositions = state.openPositions.filter(p => p.basisPositionId !== bpId);
    if (state.openPositions.length < before) {
      if (removedQty > 0 && state.filledQty != null) {
        state.filledQty = Math.max(0, parseFloat(state.filledQty) - removedQty);
      }
      console.log(`[Reconcile] executor pair ${pairId} — removed in-mem pos bpId=${bpId}`);
    }
  } catch (_) {}
}

function _execQtyPatch(executor, executorV2, pairId, bpId, newQty) {
  _execQtyPatchOne(executor, pairId, bpId, newQty);
  _execQtyPatchOne(executorV2, pairId, bpId, newQty);
}

function _execQtyPatchOne(executor, pairId, bpId, newQty) {
  if (!executor) return;
  try {
    const state = executor.pairs?.get(pairId);
    if (!state) return;
    const pos = state.openPositions.find((p) => p.basisPositionId === bpId);
    if (!pos) return;
    const oldQty = parseFloat(pos.qty || 0);
    pos.qty = newQty;
    if (oldQty > newQty && state.filledQty != null) {
      state.filledQty = Math.max(0, parseFloat(state.filledQty) - (oldQty - newQty));
    }
    console.log(`[Reconcile] executor pair ${pairId} — bpId=${bpId} qty patched → ${newQty}`);
  } catch (_) {}
}

function _execPromoteToOpen(executor, executorV2, pairId, bpId, fillPx) {
  _execPromoteToOpenOne(executor, pairId, bpId, fillPx);
  _execPromoteToOpenOne(executorV2, pairId, bpId, fillPx);
}

function _execPromoteToOpenOne(executor, pairId, bpId, fillPx) {
  if (!executor) return;
  try {
    const state = executor.pairs?.get(pairId);
    if (!state) return;
    const pos = state.openPositions.find(p => p.basisPositionId === bpId);
    if (!pos) return;
    pos.status = 'open';
    pos.entryPriceA = fillPx;
    pos.openedAt = pos.openedAt || Date.now();
  } catch (_) {}
}

function _execResetExit(executor, executorV2, pairId, bpId, exitOrderId) {
  _execResetExitOne(executor, pairId, bpId, exitOrderId);
  _execResetExitOne(executorV2, pairId, bpId, exitOrderId);
}

function _execResetExitOne(executor, pairId, bpId, exitOrderId) {
  if (!executor) return;
  try {
    const state = executor.pairs?.get(pairId);
    if (!state) return;
    const pos = state.openPositions.find(p => p.basisPositionId === bpId);
    if (!pos) return;
    if (pos.pollTimer) { clearInterval(pos.pollTimer); pos.pollTimer = null; }
    pos.status = 'open';
    pos.exitOrderId = null;
    pos.exitTradeId = null;
    pos.profitTicks = 0;
    pos.stopTicks = 0;
    pos.timeExitTicks = 0;
  } catch (_) {}
}

/** Entry Trade rows are created with status=open before fill; keep them in sync when BasisPosition fails. */
async function _cancelEntryTradeIfOpen(entryTradeId, cancelReason) {
  if (!entryTradeId) return;
  await Trade.update(
    { status: 'cancelled', cancelReason: cancelReason || 'reconcile_basis_failed' },
    { where: { id: entryTradeId, side: 'entry', status: 'open' } }
  ).catch(() => {});
}

async function _fillEntryTradeFromReconcile(entryTradeId, legAPrice, legBPrice, commissionUsd, at) {
  if (!entryTradeId) return;
  await Trade.update(
    {
      status: 'filled',
      legA_price: legAPrice,
      legA_filledAt: at,
      legB_price: legBPrice != null ? legBPrice : undefined,
      legB_filledAt: legBPrice != null ? at : undefined,
      ...(commissionUsd != null ? { commission: commissionUsd } : {}),
    },
    { where: { id: entryTradeId, side: 'entry', status: 'open' } }
  ).catch(() => {});
}

/** Exit trade_logs left status=open when basis was closed via reconciler (executor poll missed fill). */
async function _fillExitTradeFromReconcile(exitTradeId, { exitPx, legBRefPx, grossPnl, netPnl, commissionUsd, spreadAtExit, at }) {
  if (!exitTradeId) return;
  await Trade.update(
    {
      status: 'filled',
      legA_price: exitPx,
      legA_filledAt: at,
      ...(legBRefPx != null && Number.isFinite(Number(legBRefPx))
        ? { legB_price: legBRefPx, legB_filledAt: at }
        : { legB_filledAt: at }),
      ...(spreadAtExit != null && Number.isFinite(Number(spreadAtExit)) ? { spreadAtExit } : {}),
      legA_pnl: grossPnl,
      legB_pnl: 0,
      pnl: netPnl,
      ...(commissionUsd != null ? { commission: commissionUsd } : {}),
    },
    { where: { id: exitTradeId, side: 'exit', status: 'open' } }
  ).catch(() => {});
}

async function _markFailed(pos, note, now) {
  await BasisPosition.update({
    state: 'failed',
    reconciledAt: now,
    reconcileNote: note,
  }, { where: { id: pos.id } }).catch(() => {});
  await _cancelEntryTradeIfOpen(pos.entryTradeId, note);
}

// ─── scheduler ───────────────────────────────────────────────────────────────

let _timer = null;

function startReconcileScheduler(intervalMs = RECONCILE_INTERVAL_MS) {
  // Run immediately on boot (after a short delay so DB sync completes)
  setTimeout(() => {
    reconcileAll().catch(e => console.error('[Reconcile] boot run error:', e.message));
  }, 4_000);

  // Then every intervalMs
  _timer = setInterval(() => {
    reconcileAll().catch(e => console.error('[Reconcile] scheduled run error:', e.message));
  }, intervalMs);

  console.log(`[Reconcile] scheduler started — interval=${intervalMs / 1000}s, first run in 4s`);
}

function stopReconcileScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { startReconcileScheduler, stopReconcileScheduler, reconcileAll };
