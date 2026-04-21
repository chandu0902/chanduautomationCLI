"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import Orderbook from "./Orderbook";
import SpreadChart from "./SpreadChart";

function useUptime(enabledAt) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (!enabledAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - new Date(enabledAt).getTime());
    tick();
    ref.current = setInterval(tick, 1000);
    return () => clearInterval(ref.current);
  }, [enabledAt]);
  return elapsed;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Deribit settlement currency for traded leg — matches backend _coinFromSymbol */
function settlementCcyFromPair(pair) {
  const sym = (pair?.symbol1 || "").toUpperCase();
  if (sym.includes("_USDC")) return "USDC";
  if (sym.startsWith("ETH")) return "ETH";
  return "BTC";
}

const STOP_REASON_LABELS = {
  manual:             { label: "Manual stop",         color: "text-slate-400" },
  daily_loss_limit:   { label: "Daily loss limit",    color: "text-red-400" },
  daily_profit_limit: { label: "Daily profit limit",  color: "text-emerald-400" },
  qty_imbalance:      { label: "Qty imbalance",        color: "text-orange-400" },
  leg_qty_limit:      { label: "Leg qty limit",        color: "text-orange-400" },
  error:              { label: "Error",                color: "text-red-400" },
  crash:              { label: "Crash / restart",      color: "text-red-400" },
};

function SessionHistoryPanel({ pairId }) {
  const [sessions, setSessions] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch(`/api/pairs/${pairId}/sessions?limit=20`)
      .then(r => r.json())
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [open, pairId]);

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="text-[10px] font-mono text-slate-500 hover:text-slate-300 underline underline-offset-2"
      >
        {open ? "hide history" : "view session history"}
      </button>
      {open && sessions && (
        <div className="mt-3 space-y-1.5">
          {sessions.length === 0 && (
            <span className="text-xs text-slate-600">No sessions recorded.</span>
          )}
          {sessions.map((s) => {
            const r = STOP_REASON_LABELS[s.stopReason] ?? { label: s.stopReason ?? "—", color: "text-slate-400" };
            return (
              <div key={s.id} className="flex items-center gap-3 bg-slate-800/20 rounded-lg px-3 py-2 text-xs font-mono">
                <span className="text-slate-500 w-36 shrink-0">
                  {s.enabledAt ? new Date(s.enabledAt).toLocaleString() : "—"}
                </span>
                <span className="text-slate-400 w-20 shrink-0">
                  {fmtDuration(s.uptimeMs ? Number(s.uptimeMs) : null)}
                </span>
                {s.downtimeMs != null && (
                  <span className="text-slate-600 w-24 shrink-0">
                    ↓ {fmtDuration(Number(s.downtimeMs))}
                  </span>
                )}
                <span className={`${r.color} shrink-0`}>{r.label}</span>
                {s.sessionPnl != null && (
                  <span className={`ml-auto shrink-0 ${s.sessionPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {s.sessionPnl >= 0 ? "+" : ""}{Number(s.sessionPnl)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExchangePositionsPanel({ pairId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const fetch_ = () => {
    setLoading(true);
    fetch(`/api/pairs/${pairId}/exchange-positions`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  };

  const toggle = () => {
    if (!open) fetch_();
    setOpen(v => !v);
  };

  const fmtUsd = (v) => v != null ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

  return (
    <div className="border-t border-slate-800/40 px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider">Exchange Positions</span>
        <button
          onClick={toggle}
          className="text-[10px] font-mono text-slate-500 hover:text-slate-300 underline underline-offset-2"
        >
          {open ? 'hide' : 'fetch live'}
        </button>
      </div>
      {open && (
        <div className="mt-2">
          {loading && <span className="text-xs text-slate-600">Loading...</span>}
          {!loading && !data && <span className="text-xs text-slate-600">Failed to load.</span>}
          {!loading && data && Object.entries(data).map(([account, positions]) => (
            <div key={account} className="mb-3">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">{account}</div>
              {positions?.error ? (
                <span className="text-xs text-red-400 font-mono">{positions.error}</span>
              ) : !Array.isArray(positions) || positions.length === 0 ? (
                <span className="text-xs text-slate-600">No open positions</span>
              ) : (
                <div className="space-y-1.5">
                  {positions.filter(p => p.size !== 0).map((pos, i) => {
                    const upnl = pos.floating_profit_loss;
                    const nm = (pos.instrument_name || '').toUpperCase();
                    const posCcy = nm.includes('_USDC') ? 'USDC' : nm.startsWith('ETH') ? 'ETH' : 'BTC';
                    const posDecimals = posCcy === 'USDC' ? 2 : 6;
                    return (
                      <div key={i} className="grid grid-cols-5 gap-2 bg-slate-800/20 rounded-lg px-3 py-2 text-xs font-mono items-center">
                        <span className="text-slate-200 col-span-2">{pos.instrument_name}</span>
                        <span className={`font-bold text-center ${pos.direction === 'buy' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {pos.direction?.toUpperCase()} {pos.size}
                        </span>
                        <span className="text-slate-400 text-right">
                          avg {fmtUsd(pos.average_price)}
                        </span>
                        <span className={`text-right font-bold ${upnl == null ? 'text-slate-500' : upnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {upnl != null ? `${upnl >= 0 ? '+' : ''}${Number(upnl).toFixed(posDecimals)} ${posCcy}` : '—'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatVwap(val) {
  if (!val && val !== 0) return "-";
  const num = Number(val);
  if (num >= 1000) return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

function formatQty(val) {
  if (!val && val !== 0) return "-";
  const num = Number(val);
  if (Math.abs(num) >= 1000000) return (num / 1000000).toFixed(2) + "M";
  if (Math.abs(num) >= 1000) return (num / 1000).toFixed(2) + "K";
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

function fmtUsdVol(qty, vwap) {
  if (!qty || !vwap) return "-";
  const usd = qty * vwap;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function VwapCard({ data, label, color }) {
  const hasData = data && data.buyVwap !== undefined;
  return (
    <div className="flex-1 min-w-[320px]">
      <div className="flex items-center gap-2.5 mb-3">
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-4 px-5 py-2.5 bg-slate-800/25 border-b border-slate-800/40">
          <span className="text-xs font-extrabold text-slate-400 uppercase tracking-widest">Side</span>
          <span className="text-xs font-extrabold text-slate-400 uppercase tracking-widest text-right">VWAP</span>
          <span className="text-xs font-extrabold text-slate-400 uppercase tracking-widest text-right">Qty</span>
          <span className="text-xs font-extrabold text-slate-400 uppercase tracking-widest text-right">Vol USD</span>
        </div>
        {hasData ? (
          <>
            {/* Sell VWAP (best 3 asks) */}
            <div className="grid grid-cols-4 px-5 py-3 items-center hover:bg-red-500/5 transition-colors border-b border-slate-800/20">
              <span className="text-base font-bold text-red-400">Sell</span>
              <span className="text-lg font-mono font-bold text-red-300 text-right tabular-nums tracking-tight">
                {formatVwap(data.sellVwap)}
              </span>
              <span className="text-base font-mono font-semibold text-red-400/80 text-right tabular-nums">
                {formatQty(data.sellQty)}
              </span>
              <span className="text-base font-mono font-semibold text-red-400/60 text-right tabular-nums">
                {fmtUsdVol(data.sellQty, data.sellVwap)}
              </span>
            </div>
            {/* Buy VWAP (best 3 bids) */}
            <div className="grid grid-cols-4 px-5 py-3 items-center hover:bg-emerald-500/5 transition-colors border-b border-slate-800/20">
              <span className="text-base font-bold text-emerald-400">Buy</span>
              <span className="text-lg font-mono font-bold text-emerald-300 text-right tabular-nums tracking-tight">
                {formatVwap(data.buyVwap)}
              </span>
              <span className="text-base font-mono font-semibold text-emerald-400/80 text-right tabular-nums">
                {formatQty(data.buyQty)}
              </span>
              <span className="text-base font-mono font-semibold text-emerald-400/60 text-right tabular-nums">
                {fmtUsdVol(data.buyQty, data.buyVwap)}
              </span>
            </div>
            {/* Microprice */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800/20 hover:bg-blue-500/5 transition-colors">
              <span className="text-sm font-extrabold text-slate-400 uppercase tracking-widest">Microprice</span>
              <span className="text-xl font-mono font-bold text-blue-300 tabular-nums tracking-tight">
                {formatVwap(data.microprice)}
              </span>
            </div>
            {/* OBI */}
            <div className="flex items-center justify-between px-5 py-3 bg-slate-800/20">
              <span className="text-sm font-extrabold text-slate-400 uppercase tracking-widest">OBI</span>
              <div className="flex items-center gap-3">
                <div className="w-24 h-2 rounded-full bg-slate-700/50 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      data.obi >= 0 ? "bg-emerald-400" : "bg-red-400"
                    }`}
                    style={{
                      width: `${Math.abs(data.obi || 0) * 100}%`,
                      marginLeft: data.obi < 0 ? "auto" : undefined,
                    }}
                  />
                </div>
                <span className={`text-lg font-mono font-bold tabular-nums ${
                  data.obi > 0.05 ? "text-emerald-400" : data.obi < -0.05 ? "text-red-400" : "text-slate-400"
                }`}>
                  {data.obi > 0 ? "+" : ""}{(data.obi * 100).toFixed(1)}%
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="px-5 py-5 text-center">
            <span className="text-sm text-slate-600">Waiting...</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountInfoSection({ acct, enabledAt }) {
  const uptimeMs = useUptime(enabledAt);
  const { balance, startBalance, positions, feeLevel, makerRebate, currency } = acct;
  const ccy = currency || 'BTC';
  const isUsdc = ccy === 'USDC';
  const pnl = (balance != null && startBalance != null) ? balance - startBalance : null;
  const decimals = isUsdc ? 2 : 8;
  const fmtBal = (v) => v != null ? Number(v).toFixed(decimals) : '—';
  const fmtPnl = (v) => v != null ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(decimals)}` : '—';
  const pnlColor = (v) => v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400';
  return (
    <div className="border-t border-slate-800/40 px-5 py-5">
      <div className="flex items-center gap-2.5 mb-4">
        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Account</span>
        <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{ccy}</span>
        {feeLevel != null && (
          <span className="text-[10px] font-mono text-violet-400 bg-violet-500/10 px-2 py-0.5 rounded-full">Fee Tier {feeLevel}</span>
        )}
        {enabledAt && (
          <span className="text-[10px] font-mono text-emerald-400/70 bg-emerald-500/10 px-2 py-0.5 rounded-full">
            ↑ {fmtDuration(uptimeMs)}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Balance</div>
          <div className="text-sm font-mono font-bold text-slate-200">{fmtBal(balance)} <span className="text-[10px] text-slate-500">{ccy}</span></div>
        </div>
        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Start Balance</div>
          <div className="text-sm font-mono font-bold text-slate-200">{fmtBal(startBalance)} <span className="text-[10px] text-slate-500">{ccy}</span></div>
        </div>
        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Session PnL</div>
          <div className={`text-sm font-mono font-bold ${pnlColor(pnl)}`}>
            {fmtPnl(pnl)} <span className="text-[10px] text-slate-500">{ccy}</span>
          </div>
        </div>
      </div>
      {positions?.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2">Positions</div>
          <div className="space-y-1.5">
            {positions.map((pos, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-800/20 rounded-lg px-3 py-2">
                <span className="text-xs font-mono text-slate-300">{pos.instrument}</span>
                <div className="flex items-center gap-4">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${pos.direction === 'buy' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
                    {pos.direction?.toUpperCase()}
                  </span>
                  <span className="text-xs font-mono text-slate-300">Size: {pos.size}</span>
                  <span className="text-xs font-mono text-slate-400">Avg: {pos.avgPrice > 0 ? `$${Number(pos.avgPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}</span>
                  {pos.unrealizedPnl != null && (
                    <span className={`text-xs font-mono font-bold ${pos.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.unrealizedPnl >= 0 ? '+' : ''}{Number(pos.unrealizedPnl).toFixed(decimals)} {ccy}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExchangeBtcPnlPanel({ pairId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);
  const intervalRef = useRef(null);

  const fetchPnl = () => {
    setLoading(true);
    fetch(`/api/pairs/${pairId}/exchange-pnl`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    fetchPnl();
    intervalRef.current = setInterval(fetchPnl, 30000);
    return () => clearInterval(intervalRef.current);
  }, [open, pairId]);

  const ccy = data?.currency || 'BTC';
  const isUsdc = ccy === 'USDC';
  const decimals = isUsdc ? 2 : 8;
  const fmtBal = (v) => v != null ? Number(v).toFixed(decimals) : '—';
  const fmtPnl = (v) => v != null ? `${v >= 0 ? '+' : ''}${Number(v).toFixed(decimals)}` : '—';
  const pnlColor = (v) => v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="border-t border-slate-800/40 px-5 py-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider">Exchange PnL</span>
          <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{ccy}</span>
          {data?.tradedSymbol && (
            <span className="text-[10px] font-mono text-slate-600">{data.tradedSymbol}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {open && !loading && (
            <button
              onClick={fetchPnl}
              className="text-[10px] font-mono text-slate-500 hover:text-slate-300 underline underline-offset-2"
            >
              refresh
            </button>
          )}
          <button
            onClick={() => setOpen(v => !v)}
            className="text-[10px] font-mono text-slate-500 hover:text-slate-300 underline underline-offset-2"
          >
            {open ? 'hide' : 'show'}
          </button>
        </div>
      </div>
      {open && (
        <>
          {loading && !data && <span className="text-xs text-slate-600">Loading exchange PnL...</span>}
          {data && (
            <div className="space-y-3">
              {/* Main PnL cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Realized PnL</div>
                  <div className={`text-sm font-mono font-bold ${pnlColor(data.realized?.net)}`}>
                    {fmtPnl(data.realized?.net)}
                  </div>
                  <div className="text-[10px] text-slate-600 font-mono mt-0.5">{ccy} (after fees)</div>
                </div>
                <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Unrealized PnL</div>
                  <div className={`text-sm font-mono font-bold ${pnlColor(data.unrealized)}`}>
                    {fmtPnl(data.unrealized)}
                  </div>
                  <div className="text-[10px] text-slate-600 font-mono mt-0.5">{ccy} (open positions)</div>
                </div>
                <div className="bg-gradient-to-br from-slate-800/40 to-slate-800/20 rounded-xl px-4 py-3 border border-slate-700/30">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Total PnL</div>
                  <div className={`text-base font-mono font-extrabold ${pnlColor(data.totalPnl)}`}>
                    {fmtPnl(data.totalPnl)}
                  </div>
                  <div className="text-[10px] text-slate-600 font-mono mt-0.5">{ccy}</div>
                </div>
                <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Balance Δ</div>
                  <div className={`text-sm font-mono font-bold ${pnlColor(data.balanceChange)}`}>
                    {fmtPnl(data.balanceChange)}
                  </div>
                  <div className="text-[10px] text-slate-600 font-mono mt-0.5">{ccy} (start→now)</div>
                </div>
              </div>

              {/* Trade stats row */}
              <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
                <span className="text-slate-500">Trades: <span className="text-slate-300 font-bold">{data.trades?.closed ?? 0}</span></span>
                <span className="text-emerald-400">TP: {data.trades?.tp ?? 0} <span className="text-emerald-400/60">({fmtPnl(data.trades?.tpBtc)})</span></span>
                <span className="text-red-400">SL: {data.trades?.sl ?? 0} <span className="text-red-400/60">({fmtPnl(data.trades?.slBtc)})</span></span>
                {data.trades?.timeout > 0 && <span className="text-amber-400">TO: {data.trades.timeout}</span>}
                <span className="text-slate-600">|</span>
                <span className="text-slate-500">Fees: <span className="text-red-400/70">{fmtBal(data.realized?.fees)}</span></span>
                <span className="text-slate-500">Fills: <span className="text-slate-300">{data.fills?.total ?? 0}</span>
                  {data.fills?.maker > 0 && <span className="text-emerald-400/60"> ({((data.fills.maker / data.fills.total) * 100).toFixed(0)}% maker)</span>}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function toIST(utcStr) {
  const d = new Date(utcStr);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, day: 'numeric', month: 'short' });
}

function toISTHour(utcStr) {
  const d = new Date(utcStr);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true, day: '2-digit', month: 'short', year: 'numeric' });
}

const RAG_COLORS = {
  GREEN: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400', icon: '🟢' },
  AMBER: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-400', icon: '🟡' },
  RED:   { bg: 'bg-red-500/10', border: 'border-red-500/20', text: 'text-red-400', dot: 'bg-red-400', icon: '🔴' },
};

function RagStatsPanel({ pairId }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(3);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/pairs/${pairId}/rag-stats?days=${days}`)
        .then(r => r.json())
        .then(d => { if (!cancelled) setData(d); })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pairId, open, days]);

  return (
    <div className="border-t border-slate-800/40">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-800/20 transition-colors cursor-pointer">
        <div className="flex items-center gap-2.5">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">RAG Performance Log</span>
          <span className="text-[10px] text-slate-600 font-mono">(IST)</span>
          {data?.summary && (
            <div className="flex items-center gap-1.5 ml-2">
              <span className="text-[10px] font-mono text-emerald-400">{data.summary.green}G</span>
              <span className="text-[10px] font-mono text-amber-400">{data.summary.amber}A</span>
              <span className="text-[10px] font-mono text-red-400">{data.summary.red}R</span>
            </div>
          )}
        </div>
        <span className="text-slate-600 text-xs">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            {[1, 3, 7].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
                  days === d ? 'text-blue-400 bg-blue-500/10 border-blue-500/30' : 'text-slate-500 border-slate-700/30 hover:text-slate-300'
                }`}>
                {d}d
              </button>
            ))}
          </div>

          {data?.summary && (
            <div className="grid grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="bg-emerald-500/5 rounded-xl px-3 py-2 border border-emerald-500/10">
                <div className="text-[9px] text-emerald-400/60 uppercase tracking-wider">Green</div>
                <div className="text-lg font-mono font-bold text-emerald-400">{data.summary.green}</div>
              </div>
              <div className="bg-amber-500/5 rounded-xl px-3 py-2 border border-amber-500/10">
                <div className="text-[9px] text-amber-400/60 uppercase tracking-wider">Amber</div>
                <div className="text-lg font-mono font-bold text-amber-400">{data.summary.amber}</div>
              </div>
              <div className="bg-red-500/5 rounded-xl px-3 py-2 border border-red-500/10">
                <div className="text-[9px] text-red-400/60 uppercase tracking-wider">Red</div>
                <div className="text-lg font-mono font-bold text-red-400">{data.summary.red}</div>
              </div>
              <div className="bg-slate-800/30 rounded-xl px-3 py-2 border border-slate-700/20">
                <div className="text-[9px] text-slate-500 uppercase tracking-wider">Total PnL</div>
                <div className={`text-lg font-mono font-bold ${data.summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {data.summary.totalPnl >= 0 ? '+' : ''}${data.summary.totalPnl.toFixed(2)}
                </div>
              </div>
              <div className="bg-slate-800/30 rounded-xl px-3 py-2 border border-slate-700/20">
                <div className="text-[9px] text-slate-500 uppercase tracking-wider">Volume</div>
                <div className="text-lg font-mono font-bold text-blue-400">
                  ${data.summary.totalVolumeUsd >= 1000 ? (data.summary.totalVolumeUsd / 1000).toFixed(1) + 'K' : data.summary.totalVolumeUsd.toFixed(0)}
                </div>
              </div>
            </div>
          )}

          {data?.hours?.length > 0 && (
            <div className="rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
              <div className="grid grid-cols-8 px-4 py-2 bg-slate-800/25 border-b border-slate-800/40 text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">
                <span className="col-span-2">Hour (IST)</span>
                <span className="text-center">RAG</span>
                <span className="text-right">Trades</span>
                <span className="text-right">W/L</span>
                <span className="text-right">Win%</span>
                <span className="text-right">PnL</span>
                <span className="text-right">Vol USD</span>
              </div>
              <div className="max-h-[400px] overflow-y-auto">
                {data.hours.map((h, i) => {
                  const rc = RAG_COLORS[h.rag] || RAG_COLORS.AMBER;
                  const vol = h.volumeUsd >= 1000 ? `$${(h.volumeUsd / 1000).toFixed(1)}K` : `$${(h.volumeUsd || 0).toFixed(0)}`;
                  return (
                    <div key={i} className={`grid grid-cols-8 px-4 py-2 items-center text-xs font-mono border-b border-slate-800/10 hover:bg-slate-800/20 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-800/5'}`}>
                      <span className="col-span-2 text-slate-400 text-[11px]">{toISTHour(h.hourUtc)}</span>
                      <span className="text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${rc.bg} ${rc.border} ${rc.text} border`}>
                          {h.rag}
                        </span>
                      </span>
                      <span className="text-right text-slate-300">{h.totalTrades}</span>
                      <span className="text-right">
                        <span className="text-emerald-400">{h.wins}</span>
                        <span className="text-slate-600">/</span>
                        <span className="text-red-400">{h.losses}</span>
                      </span>
                      <span className={`text-right font-bold ${h.exits > 0 ? (h.winRate >= 80 ? 'text-emerald-400' : h.winRate >= 50 ? 'text-amber-400' : 'text-red-400') : 'text-slate-600'}`}>
                        {h.exits > 0 ? `${Math.round(h.winRate)}%` : '—'}
                      </span>
                      <span className={`text-right font-bold ${h.pnl > 0 ? 'text-emerald-400' : h.pnl < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                        {h.pnl > 0 ? '+' : ''}{(h.pnl || 0).toFixed(2)}
                      </span>
                      <span className="text-right text-slate-400">{vol}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!data && <span className="text-xs text-slate-600">Loading...</span>}
          {data?.hours?.length === 0 && <span className="text-xs text-slate-600">No trades yet.</span>}

          <div className="flex items-center gap-4 text-[10px] text-slate-600 font-mono pt-1">
            <span>🟢 GREEN = PnL &gt; 0 &amp; 0 losses, or PnL ≥ $0.50</span>
            <span>🟡 AMBER = No exits, or low PnL with losses</span>
            <span>🔴 RED = Negative PnL</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PairTable({ pairs, books, sellSpreadData, buySpreadData, sellExtremes, buyExtremes, midSpreadData, midExtremes, tradeStates, leadLag, accountInfo, onUpdate }) {
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const [expanded, setExpanded] = useState({});
  const [tradingLoading, setTradingLoading] = useState({});

  const toggleExpand = (id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleStatus = async (pair) => {
    const newStatus = pair.status === "active" ? "inactive" : "active";
    await api.put(`/api/pairs/${pair.id}/status`, { status: newStatus });
    onUpdate();
  };

  const deletePair = async (id) => {
    await api.del(`/api/pairs/${id}`);
    onUpdate();
  };

  const toggleTrading = async (pairId, currentlyEnabled) => {
    setTradingLoading((prev) => ({ ...prev, [pairId]: true }));
    try {
      const action = currentlyEnabled ? "disable" : "enable";
      await api.post(`/api/pairs/${pairId}/trade/${action}`);
    } catch (err) {
      console.error("Failed to toggle trading:", err);
    } finally {
      setTradingLoading((prev) => ({ ...prev, [pairId]: false }));
    }
  };

  if (pairs.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm text-slate-500">
          No pairs yet. Select exchanges and symbols above to create one.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pairs.map((pair) => {
        const isExpanded = expanded[pair.id] ?? (pair.status === "active");
        const leg1 = books?.[`${pair.id}_leg1`];
        const leg2 = books?.[`${pair.id}_leg2`];

        // Spread calc
        let spread = null;
        if (leg1?.bids?.[0] && leg2?.asks?.[0]) {
          const bid1 = parseFloat(leg1.bids[0].price);
          const ask2 = parseFloat(leg2.asks[0].price);
          if (bid1 > 0) spread = (((ask2 - bid1) / bid1) * 100).toFixed(4);
        }

        return (
          <div
            key={pair.id}
            className={`animate-fade-in rounded-2xl border transition-all duration-300 overflow-hidden ${
              pair.status === "active"
                ? "border-slate-800/60 bg-gradient-to-b from-slate-900/70 to-[#080c14]"
                : "border-slate-800/30 bg-slate-900/20 opacity-50"
            }`}
          >
            {/* Pair Header Row */}
            <div className="flex items-center justify-between gap-4 p-5 flex-wrap">
              <div className="flex items-center gap-5 flex-1 min-w-0 flex-wrap">
                {/* Leg 1 */}
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-400" />
                  <span className="text-xs text-slate-500 uppercase font-medium">
                    {capitalize(pair.exchange1)}
                  </span>
                  <span className="text-xs text-slate-600">/</span>
                  <span className="text-xs text-slate-500 uppercase font-medium">
                    {pair.type1}
                  </span>
                  <span className="text-sm font-bold text-white font-mono">
                    {pair.symbol1}
                  </span>
                </div>

                <span className="text-xs text-slate-600 font-semibold">VS</span>

                {/* Leg 2 */}
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-violet-400" />
                  <span className="text-xs text-slate-500 uppercase font-medium">
                    {capitalize(pair.exchange2)}
                  </span>
                  <span className="text-xs text-slate-600">/</span>
                  <span className="text-xs text-slate-500 uppercase font-medium">
                    {pair.type2}
                  </span>
                  <span className="text-sm font-bold text-white font-mono">
                    {pair.symbol2}
                  </span>
                </div>

                {/* Beta badge */}
                {pair.beta != null && (
                  <span className="text-xs font-mono text-amber-400/70 bg-amber-500/10 px-2 py-0.5 rounded-full">β = {pair.beta}</span>
                )}

                {/* Spread badge */}
                {spread !== null && (
                  <span
                    className={`text-sm font-bold font-mono px-3 py-1 rounded-lg ${
                      parseFloat(spread) >= 0
                        ? "text-emerald-400 bg-emerald-500/10"
                        : "text-red-400 bg-red-500/10"
                    }`}
                  >
                    {spread}%
                  </span>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2.5">
                {pair.status === "active" && (
                  <button
                    onClick={() => toggleExpand(pair.id)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/30 hover:border-slate-600 transition-all cursor-pointer"
                  >
                    {isExpanded ? "Minimize" : "Expand"}
                  </button>
                )}
                <button
                  onClick={() => toggleStatus(pair)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer border ${
                    pair.status === "active"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                      : "bg-slate-800/40 border-slate-700/30 text-slate-500 hover:bg-slate-800/60"
                  }`}
                >
                  {pair.status}
                </button>
                <button
                  onClick={() => deletePair(pair.id)}
                  className="px-3 py-1.5 rounded-lg text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 transition-all cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>

            {/* VWAP Metrics (always visible for active pairs) */}
            {pair.status === "active" && (
              <div className="border-t border-slate-800/40 px-5 py-4">
                <div className="flex items-center gap-2.5 mb-3">
                  <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    Top 3 VWAP
                  </span>
                  <span className="text-xs text-slate-600 font-mono">(best 3 levels)</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <VwapCard
                    data={leg1}
                    label={`${capitalize(pair.exchange1)} ${pair.symbol1}`}
                    color="bg-blue-400"
                  />
                  <VwapCard
                    data={leg2}
                    label={`${capitalize(pair.exchange2)} ${pair.symbol2}`}
                    color="bg-violet-400"
                  />
                </div>

                {/* Lead-Lag Indicator */}
                {leadLag?.[pair.id] && (
                  <div className="mt-4 rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
                    <div className="px-5 py-2.5 bg-slate-800/25 border-b border-slate-800/40">
                      <span className="text-xs font-extrabold text-slate-400 uppercase tracking-widest">Lead-Lag Analysis</span>
                    </div>
                    <div className="px-5 py-3">
                      {(() => {
                        const ll = leadLag[pair.id];
                        const score = ll.leadScore || 0;
                        const absScore = Math.abs(score);
                        const leader = score > 0.1 ? pair.symbol1 : score < -0.1 ? pair.symbol2 : null;
                        const lagger = leader === pair.symbol1 ? pair.symbol2 : leader === pair.symbol2 ? pair.symbol1 : null;
                        const signal = ll.lagSignal;

                        return (
                          <div className="space-y-3">
                            {/* Lead score bar */}
                            <div className="flex items-center gap-3">
                              <span className="text-xs font-bold text-slate-500 w-20 shrink-0">Lead Score</span>
                              <div className="flex-1 flex items-center gap-2">
                                <span className="text-xs font-mono text-slate-500 w-16 text-right">{pair.symbol1}</span>
                                <div className="flex-1 h-3 rounded-full bg-slate-800/60 relative overflow-hidden">
                                  {/* Center line */}
                                  <div className="absolute left-1/2 top-0 w-px h-full bg-slate-600" />
                                  {/* Score bar from center */}
                                  <div
                                    className={`absolute top-0 h-full rounded-full transition-all ${
                                      score > 0 ? "bg-blue-400/70" : "bg-violet-400/70"
                                    }`}
                                    style={{
                                      left: score > 0 ? "50%" : `${50 - Math.min(absScore * 50, 50)}%`,
                                      width: `${Math.min(absScore * 50, 50)}%`,
                                    }}
                                  />
                                </div>
                                <span className="text-xs font-mono text-slate-500 w-16">{pair.symbol2}</span>
                              </div>
                              <span className={`text-sm font-mono font-bold tabular-nums w-14 text-right ${
                                absScore > 0.3 ? (score > 0 ? "text-blue-400" : "text-violet-400") : "text-slate-500"
                              }`}>
                                {score > 0 ? "+" : ""}{score.toFixed(2)}
                              </span>
                            </div>

                            {/* Leader / Lagger labels */}
                            <div className="flex items-center gap-4">
                              {leader ? (
                                <>
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Leader</span>
                                    <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full border ${
                                      leader === pair.symbol1
                                        ? "bg-blue-500/15 text-blue-400 border-blue-500/20"
                                        : "bg-violet-500/15 text-violet-400 border-violet-500/20"
                                    }`}>{leader}</span>
                                  </div>
                                  <span className="text-slate-700">→</span>
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Lagger</span>
                                    <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full border ${
                                      lagger === pair.symbol1
                                        ? "bg-blue-500/15 text-blue-400 border-blue-500/20"
                                        : "bg-violet-500/15 text-violet-400 border-violet-500/20"
                                    }`}>{lagger}</span>
                                  </div>
                                </>
                              ) : (
                                <span className="text-xs text-slate-600">No clear leader — assets moving together</span>
                              )}

                              {/* Directional signal */}
                              {signal && signal.strength >= 0.2 && (
                                <div className="ml-auto flex items-center gap-2">
                                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Signal</span>
                                  <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded-full border ${
                                    signal.direction === "up"
                                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/20"
                                      : "bg-red-500/15 text-red-400 border-red-500/20"
                                  }`}>
                                    {signal.leader} {signal.direction === "up" ? "↑" : "↓"}
                                  </span>
                                  <div className="w-12 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${
                                        signal.direction === "up" ? "bg-emerald-400" : "bg-red-400"
                                      }`}
                                      style={{ width: `${signal.strength * 100}%` }}
                                    />
                                  </div>
                                  <span className="text-xs font-mono text-slate-500">
                                    {(signal.strength * 100).toFixed(0)}%
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Orderbook (collapsible) */}
            {pair.status === "active" && isExpanded && (
              <div className="border-t border-slate-800/40 p-4 animate-fade-in">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Orderbook
                    data={leg1}
                    label={`${capitalize(pair.exchange1)} ${pair.symbol1}`}
                    color="bg-blue-400"
                  />
                  <Orderbook
                    data={leg2}
                    label={`${capitalize(pair.exchange2)} ${pair.symbol2}`}
                    color="bg-violet-400"
                  />
                </div>
              </div>
            )}

            {/* VWAP Price Difference */}
            {pair.status === "active" && leg1?.sellVwap !== undefined && leg2?.sellVwap !== undefined && (() => {
              const hasBeta = pair.beta != null;
              const betaVal = pair.beta || 1;

              if (hasBeta) {
                // Different symbols: single spread value
                const mid1 = (leg1.sellVwap + leg1.buyVwap) / 2;
                const mid2 = (leg2.sellVwap + leg2.buyVwap) / 2;
                const diff = mid1 - betaVal * mid2;
                const pct = mid2 > 0 ? (diff / mid2) * 100 : 0;
                return (
                  <div className="border-t border-slate-800/40 px-5 py-4 animate-fade-in">
                    <div className="flex items-center gap-2.5 mb-4">
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">VWAP Spread</span>
                      <span className="text-xs font-mono text-amber-400/70 bg-amber-500/10 px-2 py-0.5 rounded-full">β = {betaVal}</span>
                    </div>
                    <div className="rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
                      <div className="flex items-center justify-between px-5 py-4">
                        <div className="flex items-center gap-3">
                          <span className="w-2 h-2 rounded-full bg-blue-400" />
                          <span className="text-xs font-bold text-slate-400 uppercase">{pair.symbol1}</span>
                          <span className="text-xs text-slate-600">−</span>
                          <span className="text-xs font-mono text-amber-400">{betaVal}×</span>
                          <span className="w-2 h-2 rounded-full bg-violet-400" />
                          <span className="text-xs font-bold text-slate-400 uppercase">{pair.symbol2}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className={`text-2xl font-mono font-extrabold tabular-nums tracking-tight ${diff >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                            {diff >= 0 ? "+" : ""}{formatVwap(diff)}
                          </span>
                          <span className={`text-sm font-mono font-bold px-3 py-1.5 rounded-lg ${pct >= 0 ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(4)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }

              // Same symbol: separate sell/buy spreads (deribit - hyperliquid)
              const deribitLeg = pair.exchange1 === 'deribit' ? leg1 : leg2;
              const hyperLeg = pair.exchange1 === 'deribit' ? leg2 : leg1;
              const sellDiff = deribitLeg.sellVwap - hyperLeg.sellVwap;
              const sellPct = hyperLeg.sellVwap > 0 ? (sellDiff / hyperLeg.sellVwap) * 100 : 0;
              const buyDiff = deribitLeg.buyVwap - hyperLeg.buyVwap;
              const buyPct = hyperLeg.buyVwap > 0 ? (buyDiff / hyperLeg.buyVwap) * 100 : 0;
              return (
                <div className="border-t border-slate-800/40 px-5 py-4 animate-fade-in">
                  <div className="flex items-center gap-2.5 mb-4">
                    <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">VWAP Spread</span>
                    <span className="text-xs text-slate-600 font-mono">(cross-exchange)</span>
                  </div>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
                      <div className="flex items-center justify-center gap-2.5 px-5 py-3 bg-slate-800/25 border-b border-slate-800/40">
                        <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Sell</span>
                        <span className="text-xs text-slate-600 font-bold">:</span>
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                        <span className="text-xs font-bold text-slate-400 uppercase">Deribit</span>
                        <span className="text-xs text-slate-600 font-bold">−</span>
                        <span className="w-2 h-2 rounded-full bg-violet-400" />
                        <span className="text-xs font-bold text-slate-400 uppercase">Hyperliquid</span>
                      </div>
                      <div className="flex items-center justify-between px-5 py-4">
                        <span className="text-sm font-mono text-slate-500 tabular-nums">
                          {formatVwap(deribitLeg.sellVwap)} − {formatVwap(hyperLeg.sellVwap)}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className={`text-2xl font-mono font-extrabold tabular-nums tracking-tight ${sellDiff >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                            {sellDiff >= 0 ? "+" : ""}{formatVwap(sellDiff)}
                          </span>
                          <span className={`text-sm font-mono font-bold px-3 py-1.5 rounded-lg ${sellPct >= 0 ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
                            {sellPct >= 0 ? "+" : ""}{sellPct.toFixed(4)}%
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-800/40 bg-[#0a0e16] overflow-hidden">
                      <div className="flex items-center justify-center gap-2.5 px-5 py-3 bg-slate-800/25 border-b border-slate-800/40">
                        <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider">Buy</span>
                        <span className="text-xs text-slate-600 font-bold">:</span>
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                        <span className="text-xs font-bold text-slate-400 uppercase">Deribit</span>
                        <span className="text-xs text-slate-600 font-bold">−</span>
                        <span className="w-2 h-2 rounded-full bg-violet-400" />
                        <span className="text-xs font-bold text-slate-400 uppercase">Hyperliquid</span>
                      </div>
                      <div className="flex items-center justify-between px-5 py-4">
                        <span className="text-sm font-mono text-slate-500 tabular-nums">
                          {formatVwap(deribitLeg.buyVwap)} − {formatVwap(hyperLeg.buyVwap)}
                        </span>
                        <div className="flex items-center gap-3">
                          <span className={`text-2xl font-mono font-extrabold tabular-nums tracking-tight ${buyDiff >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                            {buyDiff >= 0 ? "+" : ""}{formatVwap(buyDiff)}
                          </span>
                          <span className={`text-sm font-mono font-bold px-3 py-1.5 rounded-lg ${buyPct >= 0 ? "text-emerald-400 bg-emerald-500/10" : "text-red-400 bg-red-500/10"}`}>
                            {buyPct >= 0 ? "+" : ""}{buyPct.toFixed(4)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Account Info — rendered as a sub-component so useUptime hook is valid */}
            {pair.status === "active" && accountInfo?.[pair.id] && (
              <AccountInfoSection
                acct={accountInfo[pair.id]}
                enabledAt={tradeStates?.[pair.id]?.enabledAt ?? tradeStates?.[String(pair.id)]?.enabledAt}
              />
            )}

            {/* Balance Summary — shown when bot is stopped and any balance data exists */}
            {!pair.tradingEnabled && (pair.botStartBalance != null || pair.sessionEndBalance != null) && (() => {
              const fmtBal = (v) => v != null ? String(Number(v)) : '—';
              const fmtPnl = (v) => v != null ? `${v >= 0 ? '+' : ''}${Number(v)}` : '—';
              const pnlColor = (v) => v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-red-400';
              return (
                <div className="border-t border-slate-800/40 px-5 py-4 space-y-4">

                  {/* Lifetime row — persists forever, never reset */}
                  {pair.botStartBalance != null && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-2">
                        <span className="text-xs font-bold text-violet-400 uppercase tracking-wider">Bot Lifetime</span>
                        {pair.botStartedAt && (
                          <span className="text-[10px] font-mono text-slate-600">
                            since {new Date(pair.botStartedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Bot Start Balance</div>
                          <div className="text-sm font-mono font-bold text-slate-300">{fmtBal(pair.botStartBalance)}</div>
                        </div>
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Current Balance</div>
                          <div className="text-sm font-mono font-bold text-slate-300">{fmtBal(pair.botEndBalance)}</div>
                        </div>
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Lifetime PnL</div>
                          <div className={`text-sm font-mono font-bold ${pnlColor(pair.botPnl)}`}>{fmtPnl(pair.botPnl)}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Last session row */}
                  {pair.sessionEndBalance != null && (
                    <div>
                      <div className="flex items-center gap-2.5 mb-2">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Last Session</span>
                        {pair.lastStopReason && (() => {
                          const r = STOP_REASON_LABELS[pair.lastStopReason] ?? { label: pair.lastStopReason, color: "text-slate-400" };
                          return <span className={`text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800/40 ${r.color}`}>{r.label}</span>;
                        })()}
                        {pair.sessionStoppedAt && (
                          <span className="text-[10px] font-mono text-slate-600">
                            {new Date(pair.sessionStoppedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-3 mb-3">
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Start Balance</div>
                          <div className="text-sm font-mono font-bold text-slate-300">{fmtBal(pair.sessionStartBalance)}</div>
                        </div>
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">End Balance</div>
                          <div className="text-sm font-mono font-bold text-slate-300">{fmtBal(pair.sessionEndBalance)}</div>
                        </div>
                        <div className="bg-slate-800/30 rounded-xl px-4 py-3">
                          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">Session PnL</div>
                          <div className={`text-sm font-mono font-bold ${pnlColor(pair.sessionPnl)}`}>{fmtPnl(pair.sessionPnl)}</div>
                        </div>
                      </div>
                      <SessionHistoryPanel pairId={pair.id} />
                    </div>
                  )}

                </div>
              );
            })()}

            {/* Spread Analytics */}
            {pair.status === "active" && (() => {
              const hasBeta = pair.beta != null;
              const isDeribitBasis = (pair.exchange1 === 'deribit' || pair.exchange2 === 'deribit') && pair.symbol1 !== pair.symbol2;
              return (
                <div className="border-t border-slate-800/40 px-5 py-5">
                  <div className="flex items-center gap-2.5 mb-4">
                    <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Spread Analytics</span>
                    {hasBeta
                      ? <><span className="text-xs text-slate-600 font-mono">({pair.symbol1} − {pair.beta} × {pair.symbol2})</span>
                          <span className="text-xs font-mono text-amber-400/70 bg-amber-500/10 px-2 py-0.5 rounded-full">β = {pair.beta}</span></>
                      : <span className="text-xs text-slate-600 font-mono">({pair.symbol1} − {pair.symbol2})</span>
                    }
                    {isDeribitBasis && (
                      <span className="text-xs font-mono text-slate-500 bg-slate-700/20 px-2 py-0.5 rounded">USD spread</span>
                    )}
                  </div>
                  <SpreadChart data={midSpreadData?.[pair.id]} extremes={midExtremes?.[pair.id]} color="amber" isDeribitBasis={isDeribitBasis} />
                </div>
              );
            })()}

            {/* Trading Toggle — shown once spread data exists */}
            {pair.status === "active" && (midSpreadData?.[pair.id]?.length > 0 || sellSpreadData?.[pair.id]?.length > 0 || buySpreadData?.[pair.id]?.length > 0) && (() => {
              const tradeState = tradeStates?.[pair.id] ?? tradeStates?.[String(pair.id)];
              const isEnabled = (tradeState?.enabled ?? pair.tradingEnabled) || false;
              const isLoading = tradingLoading[pair.id] || false;
              const machineState = tradeState?.state || "IDLE";
              const filledQty = tradeState?.filledQty || 0;
              const maxQty1 = tradeState?.maxQty1;
              const maxReached = maxQty1 != null && filledQty >= maxQty1;
              const profitTarget = tradeState?.profitTarget;
              const stopLoss = tradeState?.stopLoss;
              const isUnilateral = true;
              const execSymbol = tradeState?.execSymbol || pair.symbol1;
              const execExchange = tradeState?.execExchange || pair.exchange1;
              const direction = tradeState?.direction;
              const entryPrice = tradeState?.entryPrice;
              const exitReason = tradeState?.exitReason;
              const tpSpreadDelta = tradeState?.tpSpreadDelta ?? pair.tpSpreadDelta;
              const slSpreadDelta = tradeState?.slSpreadDelta ?? pair.slSpreadDelta;
              const adaptLevelsOn = !!pair.adaptLevels;
              const maxSpreadCapLive = tradeState?.maxSpreadCap ?? pair.maxSpreadCap;
              const adaptedLevelsLive = Array.isArray(tradeState?.adaptedLevels) && tradeState.adaptedLevels.length > 0
                ? tradeState.adaptedLevels
                : null;
              const adaptedAtMs = tradeState?.adaptedAt;
              const adaptedAtLabel = adaptedAtMs
                ? new Date(adaptedAtMs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })
                : null;
              const dbLevels = (pair.spreadEntryLevels || "").split(",").map((s) => s.trim()).filter(Boolean);
              const v2MeanStd = tradeState?.executorVersion === "v2" && (tradeState.dollarMean != null || tradeState.dollarStd != null)
                ? { mean: tradeState.dollarMean, std: tradeState.dollarStd }
                : null;

              const stateColor = {
                IDLE:          "text-slate-400 bg-slate-500/10 border-slate-500/20",
                ENTRY_PENDING: "text-blue-400 bg-blue-500/10 border-blue-500/20",
                POSITION_OPEN: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
                EXIT_PENDING:  "text-amber-400 bg-amber-500/10 border-amber-500/20",
              }[machineState] || "text-slate-400 bg-slate-500/10 border-slate-500/20";

              return (
                <div className="border-t border-slate-800/40 px-5 py-5 animate-fade-in space-y-3">
                  {/* Row 1: status + enable button */}
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`w-2.5 h-2.5 rounded-full ${isEnabled ? "bg-emerald-400 animate-pulse" : "bg-slate-600"}`} />
                      <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                        Unilateral Spread Trading
                      </span>
                      <span className="text-[10px] text-slate-600 font-mono">{execExchange}/{execSymbol}</span>
                      {isUnilateral && (
                        <span className="text-[10px] text-cyan-400 font-mono bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">
                          signal: futAsk - perpBid
                        </span>
                      )}
                      {isEnabled && (
                        <span className={`text-xs font-mono px-2.5 py-1 rounded-lg border ${stateColor}`}>
                          {machineState}
                        </span>
                      )}
                      {isEnabled && exitReason && (
                        <span className="text-xs font-mono text-amber-300 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                          {exitReason}
                        </span>
                      )}
                      {isEnabled && maxReached && (
                        <span className="text-xs font-bold text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-lg border border-amber-500/20">
                          Max Qty Reached
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => toggleTrading(pair.id, isEnabled)}
                      disabled={isLoading}
                      className={`px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all cursor-pointer border disabled:opacity-50 disabled:cursor-not-allowed ${
                        isEnabled
                          ? "bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20"
                          : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                      }`}
                    >
                      {isLoading ? "..." : isEnabled ? "Disable Trading" : "Enable Trading"}
                    </button>
                  </div>

                  {/* Adaptive levels — DB flag + live WS from executor */}
                  {(adaptLevelsOn || adaptedLevelsLive || adaptedAtLabel) && (
                    <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 px-3 py-2.5 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-fuchsia-300">Adaptive levels</span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${adaptLevelsOn ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-700/50 text-slate-500"}`}>
                          {adaptLevelsOn ? "ON (DB)" : "OFF"}
                        </span>
                        {tradeState?.executorVersion === "v2" && (
                          <span className="text-[10px] font-mono text-slate-500 bg-slate-800/60 px-1.5 py-0.5 rounded">V2</span>
                        )}
                        {adaptedAtLabel && (
                          <span className="text-[10px] text-slate-400 font-mono">Last run: {adaptedAtLabel}</span>
                        )}
                        {!adaptedAtLabel && isEnabled && (
                          <span className="text-[10px] text-slate-500 font-mono">Scheduler: hourly — first adapt or WS update pending</span>
                        )}
                        {!adaptedAtLabel && !isEnabled && adaptLevelsOn && (
                          <span className="text-[10px] text-slate-500 font-mono">Enable trading to stream live adapted values</span>
                        )}
                      </div>
                      {v2MeanStd && (v2MeanStd.mean != null || v2MeanStd.std != null) && (
                        <div className="text-[10px] font-mono text-slate-400">
                          Rolling spread μ=${Number(v2MeanStd.mean ?? 0).toFixed(2)} σ=${Number(v2MeanStd.std ?? 0).toFixed(2)} (V2 snapshot)
                        </div>
                      )}
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Max spread cap</span>
                          <span className="text-xs font-mono font-bold text-amber-400">
                            {maxSpreadCapLive != null && Number.isFinite(Number(maxSpreadCapLive)) ? `$${Number(maxSpreadCapLive).toFixed(2)}` : "—"}
                          </span>
                          {isEnabled && tradeState?.maxSpreadCap != null && (
                            <span className="text-[9px] text-fuchsia-400/80 font-mono">live</span>
                          )}
                        </div>
                      </div>
                      {(adaptedLevelsLive || dbLevels.length > 0) && (
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">
                            Entry grid {adaptedLevelsLive ? <span className="text-fuchsia-400/90">(executor)</span> : <span className="text-slate-600">(database)</span>}
                          </span>
                          <div className="flex flex-wrap gap-1">
                            {(adaptedLevelsLive || dbLevels).map((lvl, i) => (
                              <span
                                key={`${i}-${lvl}`}
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${adaptedLevelsLive ? "bg-fuchsia-500/20 text-fuchsia-200" : "bg-blue-500/10 text-blue-400"}`}
                              >
                                L{i + 1}: {typeof lvl === "number" ? Number(lvl).toFixed(4) : lvl}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Row 2: PT / SL / Qty config */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">TP Spread Δ</span>
                      <span className="text-xs font-mono font-bold text-emerald-400">
                        {tpSpreadDelta != null ? `$${Number(tpSpreadDelta).toFixed(2)}` : "-"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">SL Spread Δ</span>
                      <span className="text-xs font-mono font-bold text-red-400">
                        {slSpreadDelta != null ? `$${Number(slSpreadDelta).toFixed(2)}` : "-"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Entry Cooldown</span>
                      <span className="text-xs font-mono font-bold text-slate-300">300s</span>
                    </div>
                    {pair.maxLegAQty != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Max Leg A</span>
                        <span className="text-xs font-mono font-bold text-amber-400">{pair.maxLegAQty}</span>
                      </div>
                    )}
                    {pair.maxLegBQty != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Max Leg B</span>
                        <span className="text-xs font-mono font-bold text-amber-400">{pair.maxLegBQty}</span>
                      </div>
                    )}
                    {pair.maxNetQtyImbalance != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Max Imbalance</span>
                        <span className="text-xs font-mono font-bold text-orange-400">{pair.maxNetQtyImbalance}</span>
                      </div>
                    )}
                    <button
                      onClick={async () => {
                        const body = {};
                        const tp = prompt("TP Spread Delta ($):", pair.tpSpreadDelta ?? 20);
                        if (tp == null) return;
                        const slSpread = prompt("SL Spread Delta ($):", pair.slSpreadDelta ?? 35);
                        if (slSpread == null) return;
                        body.tpSpreadDelta = parseFloat(tp);
                        body.slSpreadDelta = parseFloat(slSpread);
                        const mla = prompt("Max Leg A Qty (blank = no limit):", pair.maxLegAQty ?? "");
                        const mlb = "";
                        const mni = prompt("Max Net Imbalance (blank = no limit):", pair.maxNetQtyImbalance ?? "");
                        const ddPct = prompt("Drawdown Kill % (blank = disabled):", pair.drawdownPct ?? "");
                        try {
                          if (mla !== "" && mla != null) body.maxLegAQty = parseFloat(mla);
                          if (mlb !== "" && mlb != null) body.maxLegBQty = parseFloat(mlb);
                          if (mni !== "" && mni != null) body.maxNetQtyImbalance = parseFloat(mni);
                          if (ddPct !== "" && ddPct != null) body.drawdownPct = parseFloat(ddPct);
                          await api.post(`/api/pairs/${pair.id}/trade/config`, body);
                        } catch (e) {
                          alert("Failed to update: " + e.message);
                        }
                      }}
                      className="text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-slate-300 border border-slate-700/50 rounded-lg px-2.5 py-1 transition-all cursor-pointer"
                    >
                      Edit Config
                    </button>
                  </div>

                  {/* Row 3b: Daily PnL + Stop conditions (both executor types) */}
                  {isEnabled && (() => {
                    const dailyPnl = tradeState?.dailyPnl;
                    const dailyLimit = tradeState?.dailyLossLimitUsd;
                    const dailyLossHit = tradeState?.dailyLossHit;
                    const hasDailyData = dailyPnl != null || dailyLimit > 0;
                    if (!hasDailyData) return null;
                    const pnlVal = dailyPnl || 0;
                    return (
                      <div className="flex items-center gap-4 flex-wrap">
                        {dailyPnl != null && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Daily PnL</span>
                            <span className={`text-xs font-mono font-bold ${pnlVal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {pnlVal >= 0 ? '+' : ''}{pnlVal.toFixed(2)} USD
                            </span>
                          </div>
                        )}
                        {dailyLimit > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Loss Limit</span>
                            <span className="text-xs font-mono font-bold text-orange-400">${Number(dailyLimit).toFixed(2)}</span>
                          </div>
                        )}
                        {dailyLossHit && (
                          <span className="text-[10px] font-bold text-red-400 bg-red-500/10 px-2.5 py-1 rounded-lg border border-red-500/20 animate-pulse">
                            DAILY LOSS LIMIT HIT — entries blocked
                          </span>
                        )}
                      </div>
                    );
                  })()}

                  {/* Row 3bb: Equity drawdown USD (executor) — BTC / ETH / USDC pairs */}
                  {isEnabled && (Number(tradeState?.maxDrawdownUsd ?? pair.maxDrawdownUsd) > 0) && (() => {
                    const ddUsd = Number(tradeState?.currentDrawdownUsd ?? 0);
                    const limUsd = Number(tradeState?.maxDrawdownUsd ?? pair.maxDrawdownUsd ?? 0);
                    const peak = tradeState?.peakEquity;
                    const cur = tradeState?.currentEquity;
                    const coin = settlementCcyFromPair(pair);
                    const dec = coin === 'USDC' ? 2 : coin === 'ETH' ? 6 : 8;
                    const eqLine =
                      peak != null && cur != null && Number.isFinite(Number(peak)) && Number.isFinite(Number(cur))
                        ? `Peak → now: ${Number(peak).toFixed(dec)} → ${Number(cur).toFixed(dec)} ${coin}`
                        : null;
                    const warn = limUsd > 0 && ddUsd >= limUsd * 0.8;
                    return (
                      <div className="flex items-center gap-4 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Drawdown USD</span>
                          <span className={`text-xs font-mono font-bold ${warn ? 'text-amber-400' : ddUsd > 0 ? 'text-slate-300' : 'text-emerald-400/80'}`}>
                            ${ddUsd.toFixed(2)} / ${limUsd.toFixed(2)}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">(bot equity peak→current)</span>
                        </div>
                        {eqLine && (
                          <span className="text-[10px] font-mono text-slate-500">{eqLine}</span>
                        )}
                      </div>
                    );
                  })()}

                  {/* Row 3c: Bot stop conditions summary */}
                  {isEnabled && (
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Bot stops when</span>
                      {(tradeState?.dailyLossLimitUsd > 0) && (
                        <span className="text-[10px] font-mono text-orange-300 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20">
                          daily loss ≥ ${Number(tradeState.dailyLossLimitUsd).toFixed(0)} → blocks entries
                        </span>
                      )}
                      {pair.maxLegAQty != null && (
                        <span className="text-[10px] font-mono text-orange-300 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20">
                          leg A qty ≥ {pair.maxLegAQty}
                        </span>
                      )}
                      {(tradeState?.drawdownPct > 0) && (
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                          tradeState.killSwitchTriggered
                            ? 'text-red-300 bg-red-500/20 border-red-500/40'
                            : 'text-orange-300 bg-orange-500/10 border-orange-500/20'
                        }`}>
                          balance drop ≥ {tradeState.drawdownPct}% → kill + close all
                          {tradeState.currentDrawdownPct > 0 && ` (now: ${tradeState.currentDrawdownPct.toFixed(2)}%)`}
                          {tradeState.killSwitchTriggered && ' [TRIGGERED]'}
                        </span>
                      )}
                      <span className="text-[10px] font-mono text-slate-500 bg-slate-800/30 px-2 py-0.5 rounded border border-slate-700/30">
                        or manual disable
                      </span>
                    </div>
                  )}

                  {/* Row 4: Open positions grid */}
                  {isEnabled && tradeState?.positions?.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Open Positions ({tradeState.positions.length}/{tradeState?.maxPositions || '?'})
                      </div>
                      <div className="grid gap-1.5">
                        {tradeState.positions.map((p, i) => (
                          <div key={i} className="grid grid-cols-6 gap-2 bg-slate-800/20 rounded-lg px-3 py-2 text-xs font-mono items-center">
                            <div>
                              <span className="text-[9px] text-slate-600 block">Grid Lvl</span>
                              <span className="text-cyan-400 font-bold">{p.gridLevel}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-600 block">Fill Spread</span>
                              <span className="text-slate-300">${Number(p.fillSpread).toFixed(2)}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-600 block">Best Spread</span>
                              <span className="text-slate-300">${Number(p.bestSpread).toFixed(2)}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-600 block">TP Ticks</span>
                              <span className={`font-bold ${p.profitTicks > 0 ? 'text-emerald-400' : 'text-slate-400'}`}>{p.profitTicks || 0}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-600 block">SL Ticks</span>
                              <span className={`font-bold ${p.stopTicks > 0 ? 'text-red-400' : 'text-slate-400'}`}>{p.stopTicks || 0}</span>
                            </div>
                            <div>
                              <span className="text-[9px] text-slate-600 block">Hold Time</span>
                              <span className="text-slate-400">{fmtDuration((p.holdSec || 0) * 1000)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Row 5: Filled qty progress */}
                  {isEnabled && maxQty1 != null && (
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                      <span className="text-xs text-slate-500">Filled:</span>
                      <span className={`text-xs font-mono font-bold ${maxReached ? "text-amber-400" : "text-slate-300"}`}>
                        {filledQty} / {maxQty1}
                      </span>
                      {maxQty1 > 0 && (
                        <div className="w-16 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${maxReached ? "bg-amber-400" : "bg-blue-400"}`}
                            style={{ width: `${Math.min((filledQty / maxQty1) * 100, 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Exchange BTC PnL — Deribit pairs, auto-refreshes */}
            {pair.status === "active" && pair.tradingEnabled && (pair.exchange1 === 'deribit' || pair.exchange2 === 'deribit') && (
              <ExchangeBtcPnlPanel pairId={pair.id} />
            )}

            {/* Live Exchange Positions — Deribit pairs only */}
            {pair.status === "active" && (pair.exchange1 === 'deribit' || pair.exchange2 === 'deribit') && (
              <ExchangePositionsPanel pairId={pair.id} />
            )}

            {/* RAG Performance Log */}
            {pair.status === "active" && (
              <RagStatsPanel pairId={pair.id} />
            )}
          </div>
        );
      })}
    </div>
  );
}
