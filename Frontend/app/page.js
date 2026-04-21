"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import ExchangeSelector from "@/components/ExchangeSelector";
import TypeSelector from "@/components/TypeSelector";
import SymbolSelector from "@/components/SymbolSelector";
import PairTable from "@/components/PairTable";
import AccountManager from "@/components/AccountManager";
import TradeLogsPage from "@/components/TradeLogsPage";
import { api } from "@/lib/api";
import { useOrderbook } from "@/lib/useOrderbook";

function StatArbPage({ fetchPairs, sync, onNavigate, editingPair, editMode = "create", onClearEdit }) {
  const [exchange1, setExchange1] = useState("");
  const [type1, setType1] = useState("");
  const [symbol1, setSymbol1] = useState("");

  const [exchange2, setExchange2] = useState("");
  const [type2, setType2] = useState("");
  const [symbol2, setSymbol2] = useState("");

  const [agentName, setAgentName] = useState("");
  const [tradeAccountA, setTradeAccountA] = useState("");
  const [qty1, setQty1] = useState("");
  const [tradeAccountB, setTradeAccountB] = useState("");
  const [qty2, setQty2] = useState("");
  const [maxQty1, setMaxQty1] = useState("");
  const [beta, setBeta] = useState("");
  const [accounts, setAccounts] = useState([]);

  // Strategy parameters
  const [profitTarget, setProfitTarget] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [maxHoldHours, setMaxHoldHours] = useState("");
  const [dailyLossLimitUsd, setDailyLossLimitUsd] = useState("");
  const [zEntryThreshold, setZEntryThreshold] = useState("");
  const [zEntryMax, setZEntryMax] = useState("");
  const [maxLegAQty, setMaxLegAQty] = useState("");
  const [maxLegBQty, setMaxLegBQty] = useState("");
  const [maxNetQtyImbalance, setMaxNetQtyImbalance] = useState("");
  const [maxPositions, setMaxPositions] = useState("");
  const [spreadEntryLevels, setSpreadEntryLevels] = useState("");
  const [maxSpreadCap, setMaxSpreadCap] = useState("");
  const [entryPollTimeoutSec, setEntryPollTimeoutSec] = useState("");

  // Unilateral mode
  const [unilateralMode, setUnilateralMode] = useState(false);
  const [tradeLeg, setTradeLeg] = useState("A");
  const [tpSpreadDelta, setTpSpreadDelta] = useState("");
  const [slSpreadDelta, setSlSpreadDelta] = useState("");

  // Adaptive levels
  const [adaptLevels, setAdaptLevels] = useState(false);
  const [adaptSigmaMin, setAdaptSigmaMin] = useState("");
  const [adaptSigmaMax, setAdaptSigmaMax] = useState("");
  const [adaptTpSigma, setAdaptTpSigma] = useState("");
  const [adaptSlSigma, setAdaptSlSigma] = useState("");
  const [adaptMinTpSlRatio, setAdaptMinTpSlRatio] = useState("");
  const [trendPauseJumpPct, setTrendPauseJumpPct] = useState("");
  const [trendPauseDurationSec, setTrendPauseDurationSec] = useState("");
  const [adaptIntervalUsaSec, setAdaptIntervalUsaSec] = useState("");
  const [adaptIntervalOffHoursSec, setAdaptIntervalOffHoursSec] = useState("");

  // Kill switches
  const [priceUpperLimit, setPriceUpperLimit] = useState("");
  const [priceLowerLimit, setPriceLowerLimit] = useState("");
  const [optionInstruments, setOptionInstruments] = useState("");
  const [optionProfitTargetUsd, setOptionProfitTargetUsd] = useState("");
  const [maxDrawdownUsd, setMaxDrawdownUsd] = useState("");
  const [drawdownPct, setDrawdownPct] = useState("");
  const [dailyProfitLimitPct, setDailyProfitLimitPct] = useState("");

  // Advanced / executor
  const [executorVersion, setExecutorVersion] = useState("");
  const [fixedTpUsd, setFixedTpUsd] = useState("");
  const [maxSingleTradeLossUsd, setMaxSingleTradeLossUsd] = useState("");
  const [grossNegativeScratchMs, setGrossNegativeScratchMs] = useState("");
  const [entryRequoteOnMovePx, setEntryRequoteOnMovePx] = useState("");

  const [saving, setSaving] = useState(false);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await api.get("/api/accounts");
      setAccounts(data);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Pre-fill form when editing or replicating an existing pair
  useEffect(() => {
    if (!editingPair) return;
    const p = editingPair;
    const str = (v) => (v == null ? "" : String(v));
    const num = (v) => (v == null ? "" : String(v));
    const ms2sec = (v) => (v == null ? "" : String(v / 1000));
    const ms2hr  = (v) => (v == null ? "" : String(v / 3600000));
    setExchange1(p.exchange1 || "");
    setType1(p.type1 || "");
    setSymbol1(p.symbol1 || "");
    setExchange2(p.exchange2 || "");
    setType2(p.type2 || "");
    setSymbol2(p.symbol2 || "");
    setAgentName(str(p.agentName));
    setTradeAccountA(str(p.tradeAccountA));
    setQty1(num(p.qty1));
    setTradeAccountB(str(p.tradeAccountB));
    setQty2(num(p.qty2));
    setMaxQty1(num(p.maxQty1));
    setBeta(num(p.beta));
    setProfitTarget(num(p.profitTarget));
    setStopLoss(num(p.stopLoss));
    setMaxHoldHours(ms2hr(p.maxHoldMs));
    setDailyLossLimitUsd(num(p.dailyLossLimitUsd));
    setZEntryThreshold(num(p.zEntryThreshold));
    setZEntryMax(num(p.zEntryMax));
    setMaxLegAQty(num(p.maxLegAQty));
    setMaxLegBQty(num(p.maxLegBQty));
    setMaxNetQtyImbalance(num(p.maxNetQtyImbalance));
    setMaxPositions(num(p.maxPositions));
    setSpreadEntryLevels(str(p.spreadEntryLevels));
    setMaxSpreadCap(num(p.maxSpreadCap));
    setEntryPollTimeoutSec(ms2sec(p.entryPollTimeoutMs));
    setUnilateralMode(!!p.unilateralMode);
    setTradeLeg(p.tradeLeg || "A");
    setTpSpreadDelta(num(p.tpSpreadDelta));
    setSlSpreadDelta(num(p.slSpreadDelta));
    setAdaptLevels(!!p.adaptLevels);
    setAdaptSigmaMin(num(p.adaptSigmaMin));
    setAdaptSigmaMax(num(p.adaptSigmaMax));
    setAdaptTpSigma(num(p.adaptTpSigma));
    setAdaptSlSigma(num(p.adaptSlSigma));
    setAdaptMinTpSlRatio(num(p.adaptMinTpSlRatio));
    setTrendPauseJumpPct(num(p.trendPauseJumpPct));
    setTrendPauseDurationSec(ms2sec(p.trendPauseDurationMs));
    setAdaptIntervalUsaSec(ms2sec(p.adaptIntervalUsaMs));
    setAdaptIntervalOffHoursSec(ms2sec(p.adaptIntervalOffHoursMs));
    setPriceUpperLimit(num(p.priceUpperLimit));
    setPriceLowerLimit(num(p.priceLowerLimit));
    setOptionInstruments(str(p.optionInstruments));
    setOptionProfitTargetUsd(num(p.optionProfitTargetUsd));
    setMaxDrawdownUsd(num(p.maxDrawdownUsd));
    setDrawdownPct(num(p.drawdownPct));
    setDailyProfitLimitPct(num(p.dailyProfitLimitPct));
    setExecutorVersion(str(p.executorVersion));
    setFixedTpUsd(num(p.fixedTpUsd));
    setMaxSingleTradeLossUsd(num(p.maxSingleTradeLossUsd));
    setGrossNegativeScratchMs(num(p.grossNegativeScratchMs));
    setEntryRequoteOnMovePx(num(p.entryRequoteOnMovePx));
  }, [editingPair]);

  const handleExchange1Change = (val) => { setExchange1(val); setType1(""); setSymbol1(""); };
  const handleType1Change = (val) => { setType1(val); setSymbol1(""); };
  const handleExchange2Change = (val) => { setExchange2(val); setType2(""); setSymbol2(""); };
  const handleType2Change = (val) => { setType2(val); setSymbol2(""); };

  const handleSave = async () => {
    setSaving(true);
    const savedAgentName = agentName;
    try {
      const payload = {
        exchange1, type1, symbol1,
        exchange2, type2, symbol2,
        agentName: agentName || null,
        tradeAccountA: tradeAccountA || null,
        qty1: qty1 ? parseFloat(qty1) : null,
        tradeAccountB: tradeAccountB || null,
        qty2: qty2 ? parseFloat(qty2) : null,
        maxQty1: maxQty1 ? parseFloat(maxQty1) : null,
        beta: isDifferentUnderlying && beta ? parseFloat(beta) : null,
        dailyLossLimitPct: null,
        profitTarget: profitTarget ? parseFloat(profitTarget) : null,
        stopLoss: stopLoss ? parseFloat(stopLoss) : null,
        maxHoldMs: maxHoldHours ? Math.round(parseFloat(maxHoldHours) * 3600000) : null,
        dailyLossLimitUsd: dailyLossLimitUsd ? parseFloat(dailyLossLimitUsd) : null,
        zEntryThreshold: zEntryThreshold ? parseFloat(zEntryThreshold) : null,
        zEntryMax: zEntryMax ? parseFloat(zEntryMax) : null,
        maxLegAQty: maxLegAQty ? parseFloat(maxLegAQty) : null,
        maxLegBQty: maxLegBQty ? parseFloat(maxLegBQty) : null,
        maxNetQtyImbalance: maxNetQtyImbalance ? parseFloat(maxNetQtyImbalance) : null,
        maxPositions: maxPositions ? parseInt(maxPositions) : null,
        spreadEntryLevels: spreadEntryLevels || null,
        maxSpreadCap: maxSpreadCap ? parseFloat(maxSpreadCap) : null,
        entryPollTimeoutMs: entryPollTimeoutSec ? Math.round(parseFloat(entryPollTimeoutSec) * 1000) : null,
        // Unilateral mode
        unilateralMode,
        tradeLeg: unilateralMode ? tradeLeg : null,
        tpSpreadDelta: tpSpreadDelta ? parseFloat(tpSpreadDelta) : null,
        slSpreadDelta: slSpreadDelta ? parseFloat(slSpreadDelta) : null,
        // Adaptive levels
        adaptLevels,
        adaptSigmaMin: adaptSigmaMin ? parseFloat(adaptSigmaMin) : null,
        adaptSigmaMax: adaptSigmaMax ? parseFloat(adaptSigmaMax) : null,
        adaptTpSigma: adaptTpSigma ? parseFloat(adaptTpSigma) : null,
        adaptSlSigma: adaptSlSigma ? parseFloat(adaptSlSigma) : null,
        adaptMinTpSlRatio: adaptMinTpSlRatio ? parseFloat(adaptMinTpSlRatio) : null,
        trendPauseJumpPct: trendPauseJumpPct ? parseFloat(trendPauseJumpPct) : null,
        trendPauseDurationMs: trendPauseDurationSec ? Math.round(parseFloat(trendPauseDurationSec) * 1000) : null,
        adaptIntervalUsaMs: adaptIntervalUsaSec ? Math.round(parseFloat(adaptIntervalUsaSec) * 1000) : null,
        adaptIntervalOffHoursMs: adaptIntervalOffHoursSec ? Math.round(parseFloat(adaptIntervalOffHoursSec) * 1000) : null,
        // Kill switches
        priceUpperLimit: priceUpperLimit ? parseFloat(priceUpperLimit) : null,
        priceLowerLimit: priceLowerLimit ? parseFloat(priceLowerLimit) : null,
        optionInstruments: optionInstruments.trim() || null,
        optionProfitTargetUsd: optionProfitTargetUsd ? parseFloat(optionProfitTargetUsd) : null,
        maxDrawdownUsd: maxDrawdownUsd ? parseFloat(maxDrawdownUsd) : null,
        drawdownPct: drawdownPct ? parseFloat(drawdownPct) : null,
        dailyProfitLimitPct: dailyProfitLimitPct ? parseFloat(dailyProfitLimitPct) : null,
        // Advanced
        executorVersion: executorVersion || null,
        fixedTpUsd: fixedTpUsd ? parseFloat(fixedTpUsd) : null,
        maxSingleTradeLossUsd: maxSingleTradeLossUsd ? parseFloat(maxSingleTradeLossUsd) : null,
        grossNegativeScratchMs: grossNegativeScratchMs ? parseInt(grossNegativeScratchMs) : null,
        entryRequoteOnMovePx: entryRequoteOnMovePx ? parseFloat(entryRequoteOnMovePx) : null,
      };

      if (editMode === "edit" && editingPair) {
        await api.put(`/api/pairs/${editingPair.id}`, payload);
      } else {
        await api.post("/api/pairs", payload);
      }
      setExchange1(""); setType1(""); setSymbol1("");
      setExchange2(""); setType2(""); setSymbol2("");
      setAgentName(""); setTradeAccountA(""); setQty1(""); setTradeAccountB(""); setQty2(""); setMaxQty1(""); setBeta("");
      setProfitTarget(""); setStopLoss(""); setMaxHoldHours(""); setDailyLossLimitUsd(""); setZEntryThreshold(""); setZEntryMax("");
      setMaxLegAQty(""); setMaxLegBQty(""); setMaxNetQtyImbalance(""); setMaxPositions(""); setSpreadEntryLevels(""); setMaxSpreadCap(""); setEntryPollTimeoutSec("");
      setUnilateralMode(false); setTradeLeg("A"); setTpSpreadDelta(""); setSlSpreadDelta("");
      setAdaptLevels(false); setAdaptSigmaMin(""); setAdaptSigmaMax(""); setAdaptTpSigma(""); setAdaptSlSigma("");
      setAdaptMinTpSlRatio(""); setTrendPauseJumpPct(""); setTrendPauseDurationSec(""); setAdaptIntervalUsaSec(""); setAdaptIntervalOffHoursSec("");
      setPriceUpperLimit(""); setPriceLowerLimit(""); setOptionInstruments(""); setOptionProfitTargetUsd(""); setMaxDrawdownUsd(""); setDrawdownPct(""); setDailyProfitLimitPct("");
      setExecutorVersion(""); setFixedTpUsd(""); setMaxSingleTradeLossUsd(""); setGrossNegativeScratchMs(""); setEntryRequoteOnMovePx("");
      if (onClearEdit) onClearEdit();
      fetchPairs();
      sync();
      if (savedAgentName && onNavigate) {
        onNavigate(`agent:${savedAgentName}`);
      }
    } catch (err) {
      console.error("Failed to save pair:", err);
    } finally {
      setSaving(false);
    }
  };

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const getBaseAsset = (symbol) => {
    if (!symbol) return "";
    return symbol.split(/[_-]/)[0];
  };
  const isDifferentUnderlying = symbol1 && symbol2 && getBaseAsset(symbol1) !== getBaseAsset(symbol2);
  const allSelected = agentName && exchange1 && exchange2 && symbol1 && symbol2 && tradeAccountA && tradeAccountB && qty1 && qty2 && profitTarget && stopLoss && maxHoldHours && dailyLossLimitUsd && zEntryThreshold && maxPositions;

  return (
    <>
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-xl font-bold text-white">
            {editMode === "edit" ? `Edit Pair #${editingPair?.id}` : editMode === "replicate" ? `Replicate Pair #${editingPair?.id}` : "Create StatArb"}
          </h2>
          <p className="text-sm text-slate-500">
            {editMode === "edit"
              ? `Editing ${editingPair?.symbol1} / ${editingPair?.symbol2}`
              : editMode === "replicate"
              ? `Cloned from pair #${editingPair?.id} — will create a new pair`
              : "Configure exchange pairs for spread monitoring"}
          </p>
        </div>
        {(editMode === "edit" || editMode === "replicate") && (
          <button
            onClick={() => { if (onClearEdit) onClearEdit(); }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-400 text-sm hover:text-slate-200 hover:border-slate-600 transition-all cursor-pointer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New Bot
          </button>
        )}
      </div>

      {/* Mode action bar — shown in edit/replicate, contains the primary save button */}
      {editMode !== "create" && (
        <div className={`sticky top-4 z-20 mb-5 rounded-2xl border px-5 py-4 flex items-center justify-between gap-4 backdrop-blur-sm ${
          editMode === "edit"
            ? "border-amber-500/40 bg-amber-500/8 shadow-lg shadow-amber-500/5"
            : "border-violet-500/40 bg-violet-500/8 shadow-lg shadow-violet-500/5"
        }`} style={{ background: editMode === "edit" ? "rgba(245,158,11,0.06)" : "rgba(139,92,246,0.06)" }}>
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-xl flex-shrink-0">{editMode === "edit" ? "✏️" : "⎘"}</span>
            <div className="min-w-0">
              <p className={`text-sm font-bold ${editMode === "edit" ? "text-amber-300" : "text-violet-300"}`}>
                {editMode === "edit" ? `Editing Pair #${editingPair?.id}` : `Replicating Pair #${editingPair?.id}`}
              </p>
              <p className="text-xs text-slate-500 truncate">
                {editMode === "edit"
                  ? "Changes will overwrite the existing pair — scroll down to edit fields"
                  : "A brand-new pair will be created — scroll down to adjust fields"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => { if (onClearEdit) onClearEdit(); }}
              className="px-3 py-2 rounded-xl border border-slate-700/50 bg-slate-800/50 text-slate-400 text-sm hover:text-slate-200 hover:border-slate-600 transition-all cursor-pointer"
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-6 py-2 rounded-xl text-white text-sm font-bold shadow-md transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                editMode === "edit"
                  ? "bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 shadow-amber-500/25"
                  : "bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-400 hover:to-purple-500 shadow-violet-500/25"
              }`}
            >
              {saving
                ? "Saving..."
                : editMode === "edit"
                ? `Update Pair #${editingPair?.id}`
                : "Create Replicated Pair"}
            </button>
          </div>
        </div>
      )}

      {/* Agent Name */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Agent Name</label>
            <input
              type="text"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
              placeholder="Enter agent name"
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
            />
          </div>
        </div>
      </div>

      {/* Exchange Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6 space-y-5">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-blue-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-blue-400">1</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Exchange 1</span>
            {symbol1 && (
              <span className="ml-auto text-xs font-mono text-emerald-400/80 bg-emerald-500/10 px-2.5 py-1 rounded-full">{symbol1}</span>
            )}
          </div>
          <ExchangeSelector label="Exchange" value={exchange1} onChange={handleExchange1Change} />
          <TypeSelector label="Type" exchange={exchange1} value={type1} onChange={handleType1Change} />
          <SymbolSelector label="Symbol" exchange={exchange1} type={type1} value={symbol1} onChange={setSymbol1} />
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Trade Account</label>
            <select
              value={tradeAccountA}
              onChange={(e) => setTradeAccountA(e.target.value)}
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all cursor-pointer"
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.Trade_Account}>{a.Trade_Account} ({a.Exchange})</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Quantity</label>
            <input
              type="number"
              value={qty1}
              onChange={(e) => setQty1(e.target.value)}
              placeholder="Enter quantity"
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Quantity</label>
            <input
              type="number"
              value={maxQty1}
              onChange={(e) => setMaxQty1(e.target.value)}
              placeholder="No limit"
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
            />
          </div>
        </div>

        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6 space-y-5">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-violet-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-violet-400">2</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Exchange 2</span>
            {symbol2 && (
              <span className="ml-auto text-xs font-mono text-emerald-400/80 bg-emerald-500/10 px-2.5 py-1 rounded-full">{symbol2}</span>
            )}
          </div>
          <ExchangeSelector label="Exchange" value={exchange2} onChange={handleExchange2Change} />
          <TypeSelector label="Type" exchange={exchange2} value={type2} onChange={handleType2Change} />
          <SymbolSelector label="Symbol" exchange={exchange2} type={type2} value={symbol2} onChange={setSymbol2} />
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Trade Account</label>
            <select
              value={tradeAccountB}
              onChange={(e) => setTradeAccountB(e.target.value)}
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all cursor-pointer"
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.Trade_Account}>{a.Trade_Account} ({a.Exchange})</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Quantity</label>
            <input
              type="number"
              value={qty2}
              onChange={(e) => setQty2(e.target.value)}
              placeholder="Enter quantity"
              className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
            />
          </div>
        </div>
      </div>

      {/* Beta — only shown when underlying assets differ */}
      {isDifferentUnderlying && (
        <div className="mb-5">
          <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
            <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
              <div className="w-6 h-6 rounded-md bg-amber-500/20 flex items-center justify-center">
                <span className="text-xs font-bold text-amber-400">β</span>
              </div>
              <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Beta Coefficient</span>
              <span className="ml-auto text-xs text-slate-600 font-mono">spread = {symbol1} − β × {symbol2}</span>
            </div>
            <div className="pt-4">
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Beta Value</label>
                <input
                  type="number"
                  step="any"
                  value={beta}
                  onChange={(e) => setBeta(e.target.value)}
                  placeholder="Enter beta"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 transition-all"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Strategy Parameters */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-emerald-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-emerald-400">S</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Strategy Parameters</span>
          </div>
          <div className="pt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Profit Target ($)</label>
              <input
                type="number" step="any" min="0"
                value={profitTarget}
                onChange={(e) => setProfitTarget(e.target.value)}
                placeholder="e.g. 1.40"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Stop Loss ($)</label>
              <input
                type="number" step="any" min="0"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                placeholder="e.g. 2.40"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Time Stop (hours)</label>
              <input
                type="number" step="any" min="0"
                value={maxHoldHours}
                onChange={(e) => setMaxHoldHours(e.target.value)}
                placeholder="e.g. 1"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 transition-all"
              />
              {maxHoldHours && <p className="text-xs text-slate-500 font-mono">{Math.round(parseFloat(maxHoldHours) * 3600000).toLocaleString()} ms</p>}
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Z-Entry Threshold</label>
              <input
                type="number" step="any" min="0"
                value={zEntryThreshold}
                onChange={(e) => setZEntryThreshold(e.target.value)}
                placeholder="e.g. 1.2"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Z-Entry Max</label>
              <input
                type="number" step="any" min="0"
                value={zEntryMax}
                onChange={(e) => setZEntryMax(e.target.value)}
                placeholder="e.g. 4"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Positions</label>
              <input
                type="number" step="1" min="1"
                value={maxPositions}
                onChange={(e) => setMaxPositions(e.target.value)}
                placeholder="e.g. 4"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Leg A Qty</label>
              <input
                type="number" step="any" min="0"
                value={maxLegAQty}
                onChange={(e) => setMaxLegAQty(e.target.value)}
                placeholder="e.g. 2680"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Leg B Qty</label>
              <input
                type="number" step="any" min="0"
                value={maxLegBQty}
                onChange={(e) => setMaxLegBQty(e.target.value)}
                placeholder="e.g. 2144"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Spread Entry Levels</label>
              <input
                type="text"
                value={spreadEntryLevels}
                onChange={(e) => setSpreadEntryLevels(e.target.value)}
                placeholder="e.g. 40,55,70,85"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Comma-separated dollar spread levels</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Spread Cap ($)</label>
              <input
                type="number" step="any" min="0"
                value={maxSpreadCap}
                onChange={(e) => setMaxSpreadCap(e.target.value)}
                placeholder="e.g. 120"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Block entries above this dollar spread</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Entry Poll Timeout (sec)</label>
              <input
                type="number" step="any" min="1"
                value={entryPollTimeoutSec}
                onChange={(e) => setEntryPollTimeoutSec(e.target.value)}
                placeholder="e.g. 90"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Seconds to wait for legA fill before cancelling</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Net Qty Imbalance</label>
              <input
                type="number" step="any" min="0"
                value={maxNetQtyImbalance}
                onChange={(e) => setMaxNetQtyImbalance(e.target.value)}
                placeholder="e.g. 500"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Disable if |legA qty − legB qty| exceeds this</p>
            </div>
          </div>
        </div>
      </div>

      {/* Unilateral Mode */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-cyan-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-cyan-400">U</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Unilateral Mode</span>
            <span className="ml-auto text-xs text-slate-600 font-mono">Trade one leg; other leg is spread signal only</span>
          </div>
          <div className="pt-4 space-y-4">
            {/* Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-300">Enable Unilateral Mode</p>
                <p className="text-xs text-slate-500 mt-0.5">BTC bot: tradeLeg B (perp). ETH bot: tradeLeg A (perp).</p>
              </div>
              <button
                type="button"
                onClick={() => setUnilateralMode((v) => !v)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none ${unilateralMode ? "bg-cyan-500" : "bg-slate-700"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${unilateralMode ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
            {unilateralMode && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pt-2 border-t border-slate-800/40">
                {/* Trade Leg */}
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Trade Leg</label>
                  <div className="flex gap-3">
                    {["A", "B"].map((leg) => (
                      <button
                        key={leg}
                        type="button"
                        onClick={() => setTradeLeg(leg)}
                        className={`flex-1 py-3 rounded-xl text-sm font-bold transition-all border ${tradeLeg === leg ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-300" : "bg-slate-800/40 border-slate-700/50 text-slate-500 hover:text-slate-300"}`}
                      >
                        Leg {leg}
                        <span className="block text-[10px] font-normal mt-0.5 opacity-70">{leg === "A" ? symbol1 || "symbol1" : symbol2 || "symbol2"}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-600 font-mono">BTC → B · ETH → A</p>
                </div>
                {/* TP Spread Delta */}
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-slate-500">TP Spread Delta ($)</label>
                  <input
                    type="number" step="any" min="0"
                    value={tpSpreadDelta}
                    onChange={(e) => setTpSpreadDelta(e.target.value)}
                    placeholder="e.g. 14.35 (BTC) / 0.52 (ETH)"
                    className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-all"
                  />
                  <p className="text-xs text-slate-500 font-mono">Exit TP when spread narrows by this $</p>
                </div>
                {/* SL Spread Delta */}
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-slate-500">SL Spread Delta ($)</label>
                  <input
                    type="number" step="any" min="0"
                    value={slSpreadDelta}
                    onChange={(e) => setSlSpreadDelta(e.target.value)}
                    placeholder="e.g. 9.79 (BTC) / 0.17 (ETH)"
                    className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
                  />
                  <p className="text-xs text-slate-500 font-mono">Exit SL when spread widens by this $</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Adaptive Levels */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-teal-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-teal-400">A</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Adaptive Levels</span>
            <span className="ml-auto text-xs text-slate-600 font-mono">Hourly recalc of entry levels / TP / SL via rolling spread stats</span>
          </div>
          <div className="pt-4 space-y-4">
            {/* Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-300">Enable Adaptive Levels</p>
                <p className="text-xs text-slate-500 mt-0.5">Recalculates entry levels from dollarMean ± σ × dollarStd each cycle</p>
              </div>
              <button
                type="button"
                onClick={() => setAdaptLevels((v) => !v)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none ${adaptLevels ? "bg-teal-500" : "bg-slate-700"}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${adaptLevels ? "translate-x-6" : "translate-x-1"}`} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 pt-2 border-t border-slate-800/40">
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Sigma Min (lowest entry)</label>
                <input
                  type="number" step="any"
                  value={adaptSigmaMin}
                  onChange={(e) => setAdaptSigmaMin(e.target.value)}
                  placeholder="default 0.5"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">L1 = mean + sigmaMin × std</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Sigma Max (highest entry)</label>
                <input
                  type="number" step="any"
                  value={adaptSigmaMax}
                  onChange={(e) => setAdaptSigmaMax(e.target.value)}
                  placeholder="default 2.0"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">LN = mean + sigmaMax × std</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">TP Sigma</label>
                <input
                  type="number" step="any"
                  value={adaptTpSigma}
                  onChange={(e) => setAdaptTpSigma(e.target.value)}
                  placeholder="default 0.8"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">tpDelta = tpSigma × std</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">SL Sigma</label>
                <input
                  type="number" step="any"
                  value={adaptSlSigma}
                  onChange={(e) => setAdaptSlSigma(e.target.value)}
                  placeholder="default 1.5"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">slDelta = slSigma × std</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Min TP/SL Ratio Floor</label>
                <input
                  type="number" step="any" min="0"
                  value={adaptMinTpSlRatio}
                  onChange={(e) => setAdaptMinTpSlRatio(e.target.value)}
                  placeholder="e.g. 0.5 (optional)"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">newTp ≥ ratio × newSl</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Trend Pause Jump % Trigger</label>
                <input
                  type="number" step="any" min="0"
                  value={trendPauseJumpPct}
                  onChange={(e) => setTrendPauseJumpPct(e.target.value)}
                  placeholder="e.g. 0.20 = 20% (optional)"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">Pause entries if maxSpreadCap jumps by this fraction</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Trend Pause Duration (sec)</label>
                <input
                  type="number" step="any" min="0"
                  value={trendPauseDurationSec}
                  onChange={(e) => setTrendPauseDurationSec(e.target.value)}
                  placeholder="e.g. 300 (optional)"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/40 transition-all"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Adapt Interval — USA Hours (sec)</label>
                <input
                  type="number" step="any" min="0"
                  value={adaptIntervalUsaSec}
                  onChange={(e) => setAdaptIntervalUsaSec(e.target.value)}
                  placeholder="default 900 (15 min)"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">13:30–20:00 UTC cycle interval</p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Adapt Interval — Off-Hours (sec)</label>
                <input
                  type="number" step="any" min="0"
                  value={adaptIntervalOffHoursSec}
                  onChange={(e) => setAdaptIntervalOffHoursSec(e.target.value)}
                  placeholder="default 1800 (30 min)"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-teal-500/40 focus:border-teal-500/40 transition-all"
                />
                <p className="text-xs text-slate-500 font-mono">Outside USA hours cycle interval</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Kill Switches */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-red-900/30 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex items-center gap-2 pb-4 border-b border-red-900/20">
            <div className="w-6 h-6 rounded-md bg-red-500/20 flex items-center justify-center">
              <span className="text-xs font-bold text-red-400">!</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Kill Switches &amp; Risk Limits</span>
            <span className="ml-auto text-xs text-slate-600 font-mono">Stop bot + close all when triggered</span>
          </div>
          <div className="pt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Price Upper Limit ($)</label>
              <input
                type="number" step="any" min="0"
                value={priceUpperLimit}
                onChange={(e) => setPriceUpperLimit(e.target.value)}
                placeholder="e.g. 100000"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Close all + stop if asset price ≥ this</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Price Lower Limit ($)</label>
              <input
                type="number" step="any" min="0"
                value={priceLowerLimit}
                onChange={(e) => setPriceLowerLimit(e.target.value)}
                placeholder="e.g. 60000"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Close all + stop if asset price ≤ this</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Drawdown ($)</label>
              <input
                type="number" step="any" min="0"
                value={maxDrawdownUsd}
                onChange={(e) => setMaxDrawdownUsd(e.target.value)}
                placeholder="e.g. 5000"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Equity drawdown from peak</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Drawdown % (from start balance)</label>
              <input
                type="number" step="any" min="0" max="100"
                value={drawdownPct}
                onChange={(e) => setDrawdownPct(e.target.value)}
                placeholder="e.g. 10"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Balance drop % from session start</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Daily Profit Limit (%)</label>
              <input
                type="number" step="any" min="0"
                value={dailyProfitLimitPct}
                onChange={(e) => setDailyProfitLimitPct(e.target.value)}
                placeholder="e.g. 5"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Stop bot after hitting this daily profit %</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Option Profit Target ($)</label>
              <input
                type="number" step="any" min="0"
                value={optionProfitTargetUsd}
                onChange={(e) => setOptionProfitTargetUsd(e.target.value)}
                placeholder="e.g. 10000"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Close all options + perps when net option PnL ≥ this</p>
            </div>
            <div className="md:col-span-2 xl:col-span-3 flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Option Instruments (JSON)</label>
              <textarea
                rows={3}
                value={optionInstruments}
                onChange={(e) => setOptionInstruments(e.target.value)}
                placeholder={`e.g. [{"name":"BTC-29MAY26-75000-C","size":-6},{"name":"BTC-29MAY26-73000-P","size":4}]`}
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all resize-none"
              />
              <p className="text-xs text-slate-500 font-mono">JSON array of option instruments to close when price limits hit. size &gt; 0 = long, &lt; 0 = short.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Advanced */}
      <div className="mb-5">
        <div className="card-hover rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-6">
          <div className="flex items-center gap-2 pb-4 border-b border-slate-800/50">
            <div className="w-6 h-6 rounded-md bg-slate-700/50 flex items-center justify-center">
              <span className="text-xs font-bold text-slate-400">⚙</span>
            </div>
            <span className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Advanced</span>
            <span className="ml-auto text-xs text-slate-600 font-mono">Executor version + fine-tuning (mostly ETH-specific)</span>
          </div>
          <div className="pt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Executor Version</label>
              <select
                value={executorVersion}
                onChange={(e) => setExecutorVersion(e.target.value)}
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all cursor-pointer"
              >
                <option value="">V1 — default (unilateralExecutor)</option>
                <option value="v2">V2 — regime filter + fee gate + dynamic TP</option>
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Fixed TP ($)</label>
              <input
                type="number" step="any" min="0"
                value={fixedTpUsd}
                onChange={(e) => setFixedTpUsd(e.target.value)}
                placeholder="e.g. 50 (optional)"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Fixed favorable price move that triggers TP (ignores spread)</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Max Single Trade Loss ($)</label>
              <input
                type="number" step="any" min="0"
                value={maxSingleTradeLossUsd}
                onChange={(e) => setMaxSingleTradeLossUsd(e.target.value)}
                placeholder="e.g. 200 (optional)"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-red-500/40 focus:border-red-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Hard per-round-trip loss cap — immediate stop-exit</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Gross-Neg Scratch Delay (ms)</label>
              <input
                type="number" step="1" min="0"
                value={grossNegativeScratchMs}
                onChange={(e) => setGrossNegativeScratchMs(e.target.value)}
                placeholder="e.g. 2000 (optional)"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Wait this ms then scratch at mid if exit would be gross-negative</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold uppercase tracking-widest text-slate-500">Entry Requote on Move Px ($)</label>
              <input
                type="number" step="any" min="0"
                value={entryRequoteOnMovePx}
                onChange={(e) => setEntryRequoteOnMovePx(e.target.value)}
                placeholder="e.g. 5 (optional)"
                className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3 text-sm font-mono placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
              <p className="text-xs text-slate-500 font-mono">Re-quote during entry poll if signal mid drifts by this $</p>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom save bar — always visible in edit/replicate; gated by allSelected in create */}
      {(editMode !== "create" || allSelected) && (
        <div className="animate-fade-in mb-8">
          <div className={`rounded-2xl border p-5 ${
            editMode === "edit"
              ? "border-amber-500/20 bg-gradient-to-r from-amber-500/5 via-slate-900/80 to-orange-500/5"
              : editMode === "replicate"
              ? "border-violet-500/20 bg-gradient-to-r from-violet-500/5 via-slate-900/80 to-purple-500/5"
              : "border-slate-800/60 bg-gradient-to-r from-blue-500/5 via-slate-900/80 to-violet-500/5"
          }`}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-5 flex-wrap">
                {symbol1 && (
                <div className="flex items-center gap-3 bg-slate-800/40 rounded-xl px-4 py-2.5 border border-slate-700/30">
                  <div className="w-2 h-2 rounded-full bg-blue-400 glow-dot" />
                  <div className="flex flex-col">
                    <span className="text-xs text-slate-500 uppercase tracking-wider">{capitalize(exchange1)} / {type1.toUpperCase()}</span>
                    <span className="text-base font-bold text-white font-mono">{symbol1}</span>
                  </div>
                </div>
                )}
                {symbol1 && symbol2 && (
                <div className="flex items-center gap-2">
                  <div className="w-6 h-px bg-slate-700" />
                  <span className="text-xs font-bold text-slate-600">VS</span>
                  <div className="w-6 h-px bg-slate-700" />
                </div>
                )}
                {symbol2 && (
                <div className="flex items-center gap-3 bg-slate-800/40 rounded-xl px-4 py-2.5 border border-slate-700/30">
                  <div className="w-2 h-2 rounded-full bg-violet-400 glow-dot" />
                  <div className="flex flex-col">
                    <span className="text-xs text-slate-500 uppercase tracking-wider">{capitalize(exchange2)} / {type2.toUpperCase()}</span>
                    <span className="text-base font-bold text-white font-mono">{symbol2}</span>
                  </div>
                </div>
                )}
                {editMode !== "create" && !symbol1 && (
                  <span className="text-sm text-slate-500 font-mono">Pair #{editingPair?.id}</span>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className={`px-8 py-3 rounded-xl text-white text-base font-semibold shadow-lg transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  editMode === "edit"
                    ? "bg-gradient-to-r from-amber-500 to-orange-600 shadow-amber-500/20 hover:from-amber-400 hover:to-orange-500"
                    : editMode === "replicate"
                    ? "bg-gradient-to-r from-violet-500 to-purple-600 shadow-violet-500/20 hover:from-violet-400 hover:to-purple-500"
                    : "bg-gradient-to-r from-blue-500 to-violet-600 shadow-blue-500/20 hover:from-blue-400 hover:to-violet-500"
                }`}
              >
                {saving
                  ? "Saving..."
                  : editMode === "edit"
                  ? `Update Pair #${editingPair?.id}`
                  : editMode === "replicate"
                  ? "Create Replicated Pair"
                  : "Save Pair"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PairCard({ pair, onClick, sellSpreadData, tradeState, onEdit, onReplicate }) {
  const isActive = pair.status === "active";
  const capitalize = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
  const pairKey = `${pair.exchange1}:${pair.symbol1}-${pair.exchange2}:${pair.symbol2}`;
  const spreadEntry = sellSpreadData?.[pairKey];
  const lastSpread = spreadEntry?.length > 0 ? spreadEntry[spreadEntry.length - 1] : null;
  const ts = tradeState || {};
  const positions = ts.positions || [];

  // Live session-elapsed ticker — re-renders every 10 s to update the duration display.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ts.enabled || !ts.sessionStartedAt) return;
    const id = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(id);
  }, [ts.enabled, ts.sessionStartedAt]);

  // Derive session currency from the traded symbol (e.g. ETH-PERPETUAL → ETH)
  const sym1 = (pair.symbol1 || '').toUpperCase();
  const sessionCcy = sym1.includes('_USDC') ? 'USDC' : sym1.startsWith('ETH') ? 'ETH' : 'BTC';

  // Format elapsed time from a timestamp to "Xh Ym" or "Ym" string
  const fmtElapsed = (startIso) => {
    if (!startIso) return '—';
    const ms = Date.now() - new Date(startIso).getTime();
    if (ms < 0) return '—';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  // Short wall-clock display for session start in IST
  const fmtIstTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(new Date(iso).getTime() + (5 * 60 + 30) * 60000);
    return d.toUTCString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, '$1') + ' IST';
  };
  const levels = pair.spreadEntryLevels ? pair.spreadEntryLevels.split(",").map(Number) : [];
  const options = (() => {
    try {
      const raw = pair.optionInstruments ? JSON.parse(pair.optionInstruments) : [];
      // normalise: support both plain strings ["ETH-24APR-C"] and objects [{name,size}]
      return raw.map(o => typeof o === 'string' ? { name: o, size: null } : o);
    } catch { return []; }
  })();
  const utcH = new Date().getUTCHours();
  const utcM = new Date().getUTCMinutes();
  const utcMins = utcH * 60 + utcM;
  const isUsaHours = utcMins >= 13 * 60 + 30 && utcMins < 20 * 60;

  const Row = ({ label, value, color }) => (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-[10px] text-slate-500 uppercase tracking-wider">{label}</span>
      <span className={`text-[11px] font-mono ${color || "text-slate-300"}`}>{value}</span>
    </div>
  );

  const SectionTitle = ({ children, icon }) => (
    <div className="flex items-center gap-1.5 pt-3 pb-1.5 border-t border-slate-800/40 mt-2">
      <span className="text-[9px]">{icon}</span>
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{children}</span>
    </div>
  );

  return (
    <div
      onClick={onClick}
      className={`w-full text-left rounded-2xl border p-5 transition-all duration-200 cursor-pointer group ${
        isActive
          ? "border-emerald-500/20 bg-gradient-to-b from-emerald-500/5 to-slate-900/90 hover:border-emerald-500/30 hover:bg-emerald-500/10"
          : "border-slate-800/60 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] hover:border-slate-700/60 hover:bg-slate-800/30"
      }`}
    >
      {/* Status + Trading State */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${ts.enabled ? "bg-emerald-400 animate-pulse" : isActive ? "bg-amber-400" : "bg-slate-600"}`} />
          <span className={`text-[10px] font-bold uppercase tracking-widest ${ts.enabled ? "text-emerald-400/70" : isActive ? "text-amber-400/70" : "text-slate-600"}`}>
            {ts.enabled ? "Trading" : isActive ? "Active (not trading)" : "Inactive"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {ts.state === "POSITION_OPEN" && (
            <span className="text-[10px] font-mono bg-blue-500/15 text-blue-400 px-2 py-0.5 rounded-full">
              {positions.length} pos
            </span>
          )}
          {lastSpread && (
            <span className="text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-full">
              ${lastSpread.value?.toFixed(2)}
            </span>
          )}
        </div>
      </div>

      {/* Instruments */}
      <div className="flex items-center gap-2 mb-1">
        <div className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        <span className="text-[10px] text-slate-500 uppercase">{capitalize(pair.exchange1)}</span>
        <span className="text-sm font-bold text-blue-400 font-mono">{pair.symbol1}</span>
      </div>
      <div className="flex items-center gap-2 mb-1 pl-1">
        <div className="w-4 h-px bg-slate-700" /><span className="text-[10px] font-bold text-slate-600">VS</span><div className="w-4 h-px bg-slate-700" />
      </div>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
        <span className="text-[10px] text-slate-500 uppercase">{capitalize(pair.exchange2)}</span>
        <span className="text-sm font-bold text-violet-400 font-mono">{pair.symbol2}</span>
      </div>

      {/* Session Performance — shown only when bot is enabled */}
      {ts.enabled && (
        <>
          <SectionTitle icon="📅">Session</SectionTitle>
          <Row
            label="Started"
            value={fmtIstTime(ts.sessionStartedAt || pair.sessionStartedAt)}
            color="text-cyan-400"
          />
          <Row
            label="Running"
            value={fmtElapsed(ts.sessionStartedAt || pair.sessionStartedAt)}
            color="text-cyan-400"
          />
          {ts.sessionPnlNative != null && (
            <Row
              label={`Session PnL (${sessionCcy})`}
              value={`${ts.sessionPnlNative >= 0 ? '+' : ''}${ts.sessionPnlNative.toFixed(6)}`}
              color={ts.sessionPnlNative >= 0 ? "text-emerald-400" : "text-red-400"}
            />
          )}
          {ts.sessionStartBalance != null && (
            <Row
              label={`Start Bal (${sessionCcy})`}
              value={ts.sessionStartBalance.toFixed(6)}
              color="text-slate-400"
            />
          )}
        </>
      )}

      {/* Sizing */}
      <SectionTitle icon="📐">Sizing</SectionTitle>
      <Row label="Base Qty" value={`$${(pair.qty1 || 0).toLocaleString()}`} />
      <Row label="Max Qty" value={`$${(pair.maxQty1 || 0).toLocaleString()}`} />
      <Row label="Max Positions" value={pair.maxPositions || "—"} />
      <Row label="Account" value={pair.tradeAccountA || "—"} />

      {/* Entry */}
      <SectionTitle icon="🎯">Entry</SectionTitle>
      <Row label="Z-Entry" value={`${pair.zEntryThreshold || "—"} → ${pair.zEntryMax || "—"}`} />
      <Row label="Spread Cap" value={ts.maxSpreadCap ? `$${ts.maxSpreadCap.toFixed(2)}` : pair.maxSpreadCap ? `$${pair.maxSpreadCap}` : "auto"} />

      {/* Adaptive Entry Levels */}
      <SectionTitle icon="📊">Entry Levels ({levels.length})</SectionTitle>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {levels.map((lvl, i) => {
          const sigma = levels.length <= 1 ? (pair.adaptSigmaMin || 0.5) : (pair.adaptSigmaMin || 0.5) + ((pair.adaptSigmaMax || 2) - (pair.adaptSigmaMin || 0.5)) * (i / (levels.length - 1));
          return (
            <div key={i} className="flex items-center justify-between">
              <span className="text-[10px] text-slate-600">L{i + 1} <span className="text-slate-700">σ{sigma.toFixed(2)}</span></span>
              <span className="text-[10px] font-mono text-cyan-400/80">${lvl.toFixed(2)}</span>
            </div>
          );
        })}
      </div>

      {/* TP / SL */}
      <SectionTitle icon="⚡">TP / SL</SectionTitle>
      <Row label="TP Delta" value={`$${(ts.tpSpreadDelta || pair.tpSpreadDelta || 0).toFixed(2)}`} color="text-emerald-400" />
      <Row label="SL Delta" value={`$${(ts.slSpreadDelta || pair.slSpreadDelta || 0).toFixed(2)}`} color="text-red-400" />
      <Row label="TP Sigma" value={pair.adaptTpSigma || "—"} />
      <Row label="SL Sigma" value={pair.adaptSlSigma || "—"} />
      <Row label="R:R" value={ts.tpSpreadDelta && ts.slSpreadDelta ? `${(ts.tpSpreadDelta / ts.slSpreadDelta).toFixed(2)}:1` : "—"} color="text-amber-400" />
      <Row label="Max Hold" value={pair.maxHoldMs ? `${pair.maxHoldMs / 60000} min` : "—"} />

      {/* Adaptive Scheduler */}
      <SectionTitle icon="🔄">Adapt Scheduler</SectionTitle>
      <Row label="Adapt Levels" value={pair.adaptLevels ? "ON" : "OFF"} color={pair.adaptLevels ? "text-emerald-400" : "text-slate-600"} />
      <Row label="Sigma Range" value={`${pair.adaptSigmaMin || 0.5} → ${pair.adaptSigmaMax || 2.0}`} />
      <Row label="Current Mode" value={isUsaHours ? "USA Open (15 min)" : "Off-Hours (30 min)"} color={isUsaHours ? "text-amber-400" : "text-blue-400"} />
      {ts.adaptedAt && (
        <Row label="Last Adapted" value={new Date(ts.adaptedAt).toLocaleTimeString()} color="text-cyan-400" />
      )}

      {/* Open Positions */}
      {positions.length > 0 && (
        <>
          <SectionTitle icon="📈">Open Positions ({positions.length})</SectionTitle>
          {positions.map((p, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="text-[10px] text-slate-500">L{p.gridLevel} @ ${p.fillSpread}</span>
              <span className="text-[10px] font-mono text-slate-400">
                {p.holdSec}s | tp:{p.profitTicks} sl:{p.stopTicks}
              </span>
            </div>
          ))}
        </>
      )}

      {/* Risk / Kill Switches */}
      <SectionTitle icon="🛡️">Risk Management</SectionTitle>
      <Row
        label="Daily PnL (UTC)"
        value={`$${(ts.dailyPnl || 0).toFixed(2)}`}
        color={ts.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}
      />
      <Row label="Daily Loss Limit" value={`$${ts.dailyLossLimitUsd || pair.dailyLossLimitUsd || 0}`} />
      <Row
        label="Drawdown"
        value={`$${(ts.currentDrawdownUsd || 0).toFixed(2)} / $${ts.maxDrawdownUsd || pair.maxDrawdownUsd || 0}`}
        color={ts.currentDrawdownUsd > 0 ? "text-amber-400" : "text-slate-300"}
      />
      <Row
        label="Kill Switch"
        value={ts.killSwitchTriggered ? "TRIGGERED" : "Clear"}
        color={ts.killSwitchTriggered ? "text-red-500 font-bold" : "text-emerald-400"}
      />
      {/* Stop-streak cooldown live status */}
      {(ts.stopStreakN > 0) && (
        <Row
          label="Stop Streak"
          value={
            ts.entryCooldownRemaining > 0
              ? `COOLING (${ts.entryCooldownRemaining} left)`
              : `${ts.stopStreak || 0} / ${ts.stopStreakN}`
          }
          color={ts.entryCooldownRemaining > 0 ? "text-amber-400" : "text-slate-400"}
        />
      )}
      {/* IST-hour gate status */}
      {ts.disableIstHours?.length > 0 && (
        <Row
          label="IST Block Hrs"
          value={ts.disableIstHours.join(', ')}
          color="text-slate-500"
        />
      )}

      {/* Price Band */}
      {(pair.priceUpperLimit || pair.priceLowerLimit) && (
        <>
          <SectionTitle icon="🚨">Price Kill Band</SectionTitle>
          <Row label="Upper" value={pair.priceUpperLimit ? `$${Number(pair.priceUpperLimit).toLocaleString()}` : "—"} color="text-red-400" />
          <Row label="Lower" value={pair.priceLowerLimit ? `$${Number(pair.priceLowerLimit).toLocaleString()}` : "—"} color="text-red-400" />
          <Row label="Action" value="Close ALL + stop" color="text-red-400/70" />
        </>
      )}

      {/* Option Profit TP */}
      {pair.optionProfitTargetUsd > 0 && (
        <>
          <SectionTitle icon="💰">Option Profit TP</SectionTitle>
          <Row label="Target" value={`$${pair.optionProfitTargetUsd} net`} color="text-emerald-400" />
          <Row label="Current PnL" value={ts.optionPnlUsd != null ? `$${ts.optionPnlUsd.toFixed(2)}` : "pending..."} color={ts.optionPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"} />
          <Row label="Action" value="Close ALL + stop" color="text-emerald-400/70" />
        </>
      )}

      {/* Options Instruments */}
      {options.length > 0 && (
        <>
          <SectionTitle icon="🔮">Options Hedge</SectionTitle>
          {options.map((o, i) => (
            <div key={i} className="flex items-center justify-between py-0.5">
              <span className="text-[10px] font-mono text-slate-400">{o.name}</span>
              <span className={`text-[10px] font-mono ${o.size > 0 ? "text-emerald-400" : o.size < 0 ? "text-red-400" : "text-slate-400"}`}>
                {o.size == null ? "WATCH" : o.size > 0 ? `LONG ${Math.abs(o.size)}` : `SHORT ${Math.abs(o.size)}`}
              </span>
            </div>
          ))}
        </>
      )}

      {/* Edit / Replicate actions */}
      {(onEdit || onReplicate) && (
        <div className="flex gap-2 mt-4 pt-3 border-t border-slate-800/40" onClick={(e) => e.stopPropagation()}>
          {onEdit && (
            <button
              onClick={() => onEdit(pair)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] font-semibold hover:bg-amber-500/20 transition-all cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit
            </button>
          )}
          {onReplicate && !ts.enabled && (
            <button
              onClick={() => onReplicate(pair)}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 text-[11px] font-semibold hover:bg-violet-500/20 transition-all cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Replicate
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AgentDashboard({ agentName, pairs, tradeStates, onNavigate, sellSpreadData, onEditPair, onReplicatePair }) {
  const [botLoading, setBotLoading] = useState(false);
  const agentPairs = pairs.filter((p) => p.agentName === agentName);
  const activePairs = agentPairs.filter((p) => p.status === "active");
  const inactivePairs = agentPairs.filter((p) => p.status !== "active");

  // Check how many pairs have trading enabled
  const enabledCount = agentPairs.filter((p) => tradeStates?.[p.id]?.enabled).length;

  const enableAll = async () => {
    setBotLoading(true);
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentName)}/trade/enable`);
    } catch (err) {
      console.error("Failed to enable agent:", err);
    } finally {
      setBotLoading(false);
    }
  };

  const cancelAll = async () => {
    setBotLoading(true);
    try {
      await api.post(`/api/agents/${encodeURIComponent(agentName)}/trade/disable`);
    } catch (err) {
      console.error("Failed to cancel agent:", err);
    } finally {
      setBotLoading(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-500/15 flex items-center justify-center border border-emerald-500/20">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{agentName}</h2>
            <p className="text-sm text-slate-500">
              {agentPairs.length} pair{agentPairs.length !== 1 ? "s" : ""} &middot; {activePairs.length} active &middot; {enabledCount} trading
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {enabledCount > 0 ? (
            <button
              onClick={cancelAll}
              disabled={botLoading}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-500 to-red-600 text-white text-sm font-semibold shadow-lg shadow-red-500/20 hover:from-red-400 hover:to-red-500 transition-all cursor-pointer disabled:opacity-50"
            >
              {botLoading ? "Cancelling..." : `Cancel All (${enabledCount})`}
            </button>
          ) : (
            <button
              onClick={enableAll}
              disabled={botLoading || activePairs.length === 0}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-semibold shadow-lg shadow-emerald-500/20 hover:from-emerald-400 hover:to-emerald-500 transition-all cursor-pointer disabled:opacity-50"
            >
              {botLoading ? "Enabling..." : `Enable All (${activePairs.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Active Pairs */}
      {activePairs.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Active Pairs</h3>
            <span className="text-xs text-slate-600 font-mono ml-1">({activePairs.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {activePairs.map((p) => (
              <PairCard
                key={p.id}
                pair={p}
                sellSpreadData={sellSpreadData}
                tradeState={tradeStates?.[p.id]}
                onClick={() => onNavigate(`pair:${p.id}`)}
                onEdit={onEditPair}
                onReplicate={onReplicatePair}
              />
            ))}
          </div>
        </div>
      )}

      {/* Inactive Pairs */}
      {inactivePairs.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-slate-600" />
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Inactive Pairs</h3>
            <span className="text-xs text-slate-600 font-mono ml-1">({inactivePairs.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {inactivePairs.map((p) => (
              <PairCard
                key={p.id}
                pair={p}
                tradeState={tradeStates?.[p.id]}
                onClick={() => onNavigate(`pair:${p.id}`)}
                onEdit={onEditPair}
                onReplicate={onReplicatePair}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {agentPairs.length === 0 && (
        <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-12 text-center">
          <p className="text-slate-500 text-sm">No pairs for this agent</p>
        </div>
      )}
    </>
  );
}

function PairDetailPage({ pairId, pairs, books, sellSpreadData, buySpreadData, sellExtremes, buyExtremes, midSpreadData, midExtremes, tradeStates, leadLag, accountInfo, fetchPairs, sync, onNavigate, onEditPair, onReplicatePair }) {
  const pair = pairs.find((p) => String(p.id) === String(pairId));

  if (!pair) {
    return (
      <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-[#0a0e17] p-12 text-center">
        <p className="text-slate-500 text-sm">Pair not found</p>
      </div>
    );
  }

  return (
    <>
      {/* Back button + Edit/Replicate actions */}
      <div className="flex items-center justify-between mb-6">
      <button
        onClick={() => onNavigate(pair.agentName ? `agent:${pair.agentName}` : "statarb")}
          className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to {pair.agentName || "StatArb"}
      </button>
        <div className="flex items-center gap-2">
          {onEditPair && (
            <button
              onClick={() => onEditPair(pair)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm font-semibold hover:bg-amber-500/20 transition-all cursor-pointer"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
              Edit Config
            </button>
          )}
          {onReplicatePair && !tradeStates?.[pairId]?.enabled && (
            <button
              onClick={() => onReplicatePair(pair)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400 text-sm font-semibold hover:bg-violet-500/20 transition-all cursor-pointer"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              Replicate
            </button>
          )}
        </div>
      </div>

      <PairTable
        pairs={[pair]}
        books={books}
        sellSpreadData={sellSpreadData}
        buySpreadData={buySpreadData}
        sellExtremes={sellExtremes}
        buyExtremes={buyExtremes}
        midSpreadData={midSpreadData}
        midExtremes={midExtremes}
        tradeStates={tradeStates}
        leadLag={leadLag}
        accountInfo={accountInfo}
        onUpdate={() => { fetchPairs(); sync(); }}
      />
    </>
  );
}

function AccountsPage() {
  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-bold text-white">Accounts</h2>
        <p className="text-sm text-slate-500">Manage exchange API accounts for Hyperliquid and Deribit</p>
      </div>
      <AccountManager />
    </>
  );
}

export default function Home() {
  const [activePage, setActivePage] = useState("statarb");
  const [pairs, setPairs] = useState([]);
  const [editingPair, setEditingPair] = useState(null);   // pair object for edit/replicate
  const [editMode, setEditMode] = useState("create");     // "create" | "edit" | "replicate"
  const { books, sellSpreadData, buySpreadData, sellExtremes, buyExtremes, midSpreadData, midExtremes, tradeStates, leadLag, accountInfo, sync } = useOrderbook();

  const openEdit = useCallback((pair) => {
    setEditingPair(pair);
    setEditMode("edit");
    setActivePage("statarb");
  }, []);

  const openReplicate = useCallback((pair) => {
    setEditingPair(pair);
    setEditMode("replicate");
    setActivePage("statarb");
  }, []);

  const fetchPairs = useCallback(async () => {
    try {
      const data = await api.get("/api/pairs");
      setPairs(data);
    } catch {
      setPairs([]);
    }
  }, []);

  useEffect(() => {
    fetchPairs();
  }, [fetchPairs]);

  const allAgents = useMemo(() => {
    const map = {};
    for (const p of pairs) {
      if (p.agentName) {
        if (!map[p.agentName]) map[p.agentName] = { name: p.agentName, activeCount: 0 };
        if (p.status === "active") map[p.agentName].activeCount++;
      }
    }
    return Object.values(map)
      .filter((a) => a.activeCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [pairs]);

  const orderbookProps = { books, sellSpreadData, buySpreadData, sellExtremes, buyExtremes, midSpreadData, midExtremes, tradeStates, leadLag, accountInfo, sync };

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background glow effects */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-500/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-violet-500/5 rounded-full blur-[120px]" />
      </div>

      <Sidebar active={activePage} onNavigate={setActivePage} allAgents={allAgents} />

      {/* Main content */}
      <div className="ml-[220px] relative">
        <div className="max-w-[1920px] mx-auto px-8 py-8">
          {activePage === "statarb" && (
            <StatArbPage
              fetchPairs={fetchPairs}
              sync={sync}
              onNavigate={setActivePage}
              editingPair={editingPair}
              editMode={editMode}
              onClearEdit={() => { setEditingPair(null); setEditMode("create"); }}
            />
          )}
          {activePage === "accounts" && <AccountsPage />}
          {activePage === "trades" && <TradeLogsPage pairs={pairs} />}
          {activePage.startsWith("agent:") && (
            <AgentDashboard
              agentName={activePage.slice(6)}
              pairs={pairs}
              tradeStates={tradeStates}
              sellSpreadData={sellSpreadData}
              onNavigate={setActivePage}
              onEditPair={openEdit}
              onReplicatePair={openReplicate}
            />
          )}
          {activePage.startsWith("pair:") && (
            <PairDetailPage
              pairId={activePage.slice(5)}
              pairs={pairs}
              fetchPairs={fetchPairs}
              {...orderbookProps}
              onNavigate={setActivePage}
              onEditPair={openEdit}
              onReplicatePair={openReplicate}
            />
          )}
        </div>
      </div>
    </div>
  );
}
