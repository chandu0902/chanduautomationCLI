"use client";

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
  ComposedChart, Area,
} from "recharts";

const COLORS = {
  amber: { spread: "#f59e0b", text: "text-amber-400", label: "text-amber-300", mono: "text-amber-300" },
  cyan: { spread: "#06b6d4", text: "text-cyan-400", label: "text-cyan-300", mono: "text-cyan-300" },
};

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function CustomTooltip({ active, payload, color = "amber", isDeribitBasis = false }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const c = COLORS[color] || COLORS.amber;
  const fmtSpread = isDeribitBasis
    ? (v) => v != null ? `$${v.toFixed(2)}` : "-"
    : (v) => v?.toFixed(4) ?? "-";
  return (
    <div className="rounded-lg border border-slate-700/60 bg-[#0c1018] px-4 py-3 shadow-xl">
      <p className="text-xs text-slate-500 mb-2 font-mono">{formatTime(d.timestamp)}</p>
      <div className="space-y-1.5">
        <div className="flex justify-between gap-6">
          <span className={`text-xs ${c.text} font-semibold`}>Spread</span>
          <span className={`text-xs font-mono ${c.mono} tabular-nums`}>{fmtSpread(d.spread)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-xs text-blue-400 font-semibold">Mean</span>
          <span className="text-xs font-mono text-blue-300 tabular-nums">{fmtSpread(d.mean)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-xs text-slate-400 font-semibold">Std</span>
          <span className="text-xs font-mono text-slate-300 tabular-nums">{fmtSpread(d.std)}</span>
        </div>
        <div className="flex justify-between gap-6">
          <span className="text-xs text-violet-400 font-semibold">Z-Score</span>
          <span className={`text-xs font-mono tabular-nums font-bold ${
            d.zScore > 2 ? "text-red-400" : d.zScore < -2 ? "text-emerald-400" : "text-violet-300"
          }`}>{d.zScore?.toFixed(3)}</span>
        </div>
      </div>
    </div>
  );
}

function formatTime2(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ExtremeRow({ label, high, low, color, fmt = (v) => v.toFixed(4) }) {
  return (
    <div className="rounded-lg border border-slate-800/30 bg-slate-800/15 p-3">
      <span className={`text-[10px] font-bold uppercase tracking-widest ${color} block mb-2`}>{label}</span>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col">
          <span className="text-[10px] text-slate-600 uppercase font-bold mb-0.5">High</span>
          <span className="text-sm font-mono font-bold text-red-400 tabular-nums">
            {high?.value != null && isFinite(high.value) ? fmt(high.value) : "-"}
          </span>
          <span className="text-[10px] font-mono text-slate-600">{formatTime2(high?.timestamp)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-slate-600 uppercase font-bold mb-0.5">Low</span>
          <span className="text-sm font-mono font-bold text-emerald-400 tabular-nums">
            {low?.value != null && isFinite(low.value) ? fmt(low.value) : "-"}
          </span>
          <span className="text-[10px] font-mono text-slate-600">{formatTime2(low?.timestamp)}</span>
        </div>
      </div>
    </div>
  );
}

export default function SpreadChart({ data, extremes, color = "amber", isDeribitBasis = false }) {
  const c = COLORS[color] || COLORS.amber;

  if (!data || data.length < 3) {
    return (
      <div className="text-center py-8">
        <div className="flex items-center justify-center gap-2">
          <div className="w-4 h-4 border-2 border-slate-700 border-t-violet-400 rounded-full animate-spin" />
          <span className="text-sm text-slate-600">Collecting spread data...</span>
        </div>
      </div>
    );
  }

  // Use last 200 points for display
  const rawData = data.slice(-200);

  // For Deribit basis: replace spread/mean/std/bands with dollar equivalents in chart data
  const chartData = isDeribitBasis ? rawData.map(d => ({
    ...d,
    spread:    d.dollarSpread    ?? d.spread,
    mean:      d.dollarMean      ?? d.mean,
    std:       d.dollarStd       ?? d.std,
    upperBand: d.dollarUpperBand ?? d.upperBand,
    lowerBand: d.dollarLowerBand ?? d.lowerBand,
  })) : rawData;

  const latest = chartData[chartData.length - 1] || {};
  const latestZ = latest.zScore || 0;
  const latestSpread = latest.spread || 0;
  const latestMean = latest.mean || 0;
  const latestStd = latest.std || 0;
  // dollarConvFactor from latest raw point — used to convert extremes (% p.a.) → USD
  const latestConvFactor = rawData[rawData.length - 1]?.dollarConvFactor ?? null;

  // Dynamic Z-Score domain — pad to at least ±4, extend if data exceeds that
  const zValues = chartData.map(d => d.zScore).filter(z => z != null && isFinite(z));
  const zAbsMax = zValues.length > 0 ? Math.max(4, ...zValues.map(z => Math.abs(z))) : 4;
  const zDomain = [-(zAbsMax * 1.05).toFixed(2) * 1, (zAbsMax * 1.05).toFixed(2) * 1];
  const zTicks = [-3, -2, -1, 0, 1, 2, 3].filter(t => Math.abs(t) <= zAbsMax * 1.05);

  const fmtVal   = isDeribitBasis ? (v) => `$${Number(v).toFixed(2)}` : (v) => Number(v).toFixed(4);
  const fmtYAxis = isDeribitBasis ? (v) => `$${Number(v).toFixed(0)}` : (v) => Number(v).toFixed(2);

  return (
    <div className="space-y-4">
      {/* Live stats row */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2 bg-slate-800/30 rounded-lg px-3 py-2 border border-slate-700/30">
          <span className="text-xs text-slate-500 uppercase font-bold">Spread</span>
          <span className={`text-sm font-mono font-bold ${c.text} tabular-nums`}>{fmtVal(latestSpread)}</span>
        </div>
        <div className="flex items-center gap-2 bg-slate-800/30 rounded-lg px-3 py-2 border border-slate-700/30">
          <span className="text-xs text-slate-500 uppercase font-bold">Mean</span>
          <span className="text-sm font-mono font-bold text-blue-400 tabular-nums">{fmtVal(latestMean)}</span>
        </div>
        <div className="flex items-center gap-2 bg-slate-800/30 rounded-lg px-3 py-2 border border-slate-700/30">
          <span className="text-xs text-slate-500 uppercase font-bold">Std</span>
          <span className="text-sm font-mono font-bold text-slate-400 tabular-nums">{fmtVal(latestStd)}</span>
        </div>
        <div className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${
          Math.abs(latestZ) > 2
            ? "bg-red-500/10 border-red-500/30"
            : Math.abs(latestZ) > 1
              ? "bg-amber-500/10 border-amber-500/30"
              : "bg-slate-800/30 border-slate-700/30"
        }`}>
          <span className="text-xs text-slate-500 uppercase font-bold">Z-Score</span>
          <span className={`text-sm font-mono font-bold tabular-nums ${
            latestZ > 2 ? "text-red-400" : latestZ < -2 ? "text-emerald-400" :
            Math.abs(latestZ) > 1 ? "text-amber-400" : "text-violet-400"
          }`}>{latestZ > 0 ? "+" : ""}{latestZ.toFixed(3)}</span>
        </div>
        <span className="text-xs text-slate-600 font-mono">{data.length} ticks</span>
      </div>

      {/* Session High / Low */}
      {extremes && (
        <div className="rounded-xl border border-slate-800/40 bg-[#080c14] p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
              Session Extremes
            </span>
            <span className="text-xs text-slate-600 font-mono">(high / low)</span>
          </div>
          {/* For Deribit basis, convert % p.a. extremes → dollar using latest conversion factor */}
          {(() => {
            const fmtEx = (isDeribitBasis && latestConvFactor)
              ? (v) => `$${(v * latestConvFactor).toFixed(2)}`
              : (v) => v.toFixed(4);
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <ExtremeRow label="Spread" high={extremes.highSpread} low={extremes.lowSpread} color={c.text} fmt={fmtEx} />
                <ExtremeRow label="Mean" high={extremes.highMean} low={extremes.lowMean} color="text-blue-400" fmt={fmtEx} />
                <ExtremeRow label="Std" high={extremes.highStd} low={extremes.lowStd} color="text-slate-400" fmt={fmtEx} />
                <ExtremeRow label="Z-Score" high={extremes.highZScore} low={extremes.lowZScore} color="text-violet-400" />
              </div>
            );
          })()}
        </div>
      )}

      {/* Spread + Bollinger Band chart */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Spread vs Rolling Mean ± Std
          </span>
          <span className="text-xs text-slate-600 font-mono">{isDeribitBasis ? "(5000-tick slow mean)" : "(rolling mean)"}</span>
        </div>
        <div className="rounded-xl border border-slate-800/40 bg-[#080c14] p-2">
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                stroke="#334155"
                tick={{ fill: "#64748b", fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              <YAxis
                stroke="#334155"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={fmtYAxis}
                domain={["auto", "auto"]}
              />
              <Tooltip content={<CustomTooltip color={color} isDeribitBasis={isDeribitBasis} />} />
              {/* Std bands */}
              <Area
                type="monotone"
                dataKey="upperBand"
                stroke="none"
                fill="#3b82f6"
                fillOpacity={0.06}
              />
              <Area
                type="monotone"
                dataKey="lowerBand"
                stroke="none"
                fill="transparent"
                fillOpacity={0}
              />
              <Line type="monotone" dataKey="upperBand" stroke="#3b82f6" strokeWidth={1} dot={false} strokeDasharray="4 4" opacity={0.4} />
              <Line type="monotone" dataKey="lowerBand" stroke="#3b82f6" strokeWidth={1} dot={false} strokeDasharray="4 4" opacity={0.4} />
              {/* Mean line */}
              <Line type="monotone" dataKey="mean" stroke="#3b82f6" strokeWidth={1.5} dot={false} />
              {/* Spread line */}
              <Line type="monotone" dataKey="spread" stroke={c.spread} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Z-Score chart */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
            Z-Score
          </span>
          <div className="flex items-center gap-3 ml-2">
            {isDeribitBasis ? (
              <span className="text-xs text-slate-500/60 font-mono">rate-based entries (grid levels)</span>
            ) : (
              <>
                <span className="text-xs text-red-400/60 font-mono">+2σ sell</span>
                <span className="text-xs text-emerald-400/60 font-mono">-2σ buy</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800/40 bg-[#080c14] p-2">
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="timestamp"
                tickFormatter={formatTime}
                stroke="#334155"
                tick={{ fill: "#64748b", fontSize: 10 }}
                interval="preserveStartEnd"
                minTickGap={60}
              />
              <YAxis
                stroke="#334155"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                domain={zDomain}
                ticks={zTicks}
              />
              <Tooltip content={<CustomTooltip color={color} />} />
              <ReferenceLine y={2} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: "+2σ", fill: "#ef4444", fontSize: 10, position: "right" }} />
              <ReferenceLine y={-2} stroke="#10b981" strokeDasharray="4 4" strokeWidth={1.5} label={{ value: "-2σ", fill: "#10b981", fontSize: 10, position: "right" }} />
              <ReferenceLine y={1} stroke="#f59e0b" strokeDasharray="2 4" strokeWidth={0.8} opacity={0.4} />
              <ReferenceLine y={-1} stroke="#f59e0b" strokeDasharray="2 4" strokeWidth={0.8} opacity={0.4} />
              <ReferenceLine y={0} stroke="#475569" strokeWidth={1} />
              <Line
                type="monotone"
                dataKey="zScore"
                stroke="#a78bfa"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, fill: "#a78bfa" }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
