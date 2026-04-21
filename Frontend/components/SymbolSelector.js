"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function SymbolSelector({ label, exchange, type, value, onChange }) {
  const [symbols, setSymbols] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!exchange || !type) {
      setSymbols([]);
      onChange("");
      return;
    }

    setLoading(true);
    api
      .get(`/api/exchanges/${exchange}/types/${type}/symbols`)
      .then((data) => setSymbols(data.symbols))
      .catch(() => setSymbols([]))
      .finally(() => setLoading(false));
  }, [exchange, type]);

  if (!exchange || !type) return null;

  return (
    <div className="flex flex-col gap-2 animate-fade-in">
      <div className="flex items-center justify-between">
        <label className="text-xs font-bold uppercase tracking-widest text-slate-500">
          {label}
        </label>
        {symbols.length > 0 && (
          <span className="text-xs text-slate-600 font-mono">
            {symbols.length} available
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
          <span className="text-xs text-slate-500">Loading symbols...</span>
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-slate-700/50 bg-slate-800/40 text-slate-100 px-4 py-3.5 text-base font-medium focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-all cursor-pointer hover:border-slate-500/60"
        >
          <option value="">Select symbol</option>
          {symbols.map((symbol) => (
            <option key={symbol} value={symbol}>
              {symbol}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
