"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function TypeSelector({ label, exchange, value, onChange }) {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!exchange) {
      setTypes([]);
      onChange("");
      return;
    }

    setLoading(true);
    api
      .get(`/api/exchanges/${exchange}/types`)
      .then((data) => setTypes(data.types))
      .catch(() => setTypes([]))
      .finally(() => setLoading(false));
  }, [exchange]);

  if (!exchange) return null;

  return (
    <div className="flex flex-col gap-2 animate-fade-in">
      <label className="text-xs font-bold uppercase tracking-widest text-slate-500">
        {label}
      </label>
      {loading ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="w-4 h-4 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
          <span className="text-xs text-slate-500">Loading types...</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {types.map((t) => (
            <button
              key={t}
              onClick={() => onChange(t === value ? "" : t)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold uppercase tracking-wide transition-all duration-200 cursor-pointer border ${
                value === t
                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-400 shadow-[0_0_15px_-5px_rgba(16,185,129,0.3)]"
                  : "bg-slate-800/30 border-slate-700/40 text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 hover:border-slate-600"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
