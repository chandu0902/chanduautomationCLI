"use client";

const EXCHANGES = [
  { value: "hyperliquid", label: "Hyperliquid", icon: "H" },
  { value: "deribit", label: "Deribit", icon: "D" },
];

export default function ExchangeSelector({ label, value, onChange }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-bold uppercase tracking-widest text-slate-500">
        {label}
      </label>
      <div className="flex gap-2">
        {EXCHANGES.map((ex) => (
          <button
            key={ex.value}
            onClick={() => onChange(ex.value === value ? "" : ex.value)}
            className={`flex-1 flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-xl text-base font-semibold transition-all duration-200 cursor-pointer border ${
              value === ex.value
                ? "bg-blue-500/15 border-blue-500/50 text-blue-400 shadow-[0_0_20px_-6px_rgba(59,130,246,0.3)]"
                : "bg-slate-800/40 border-slate-700/50 text-slate-400 hover:bg-slate-800/70 hover:border-slate-600 hover:text-slate-300"
            }`}
          >
            <span
              className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold ${
                value === ex.value
                  ? "bg-blue-500/25 text-blue-300"
                  : "bg-slate-700/50 text-slate-500"
              }`}
            >
              {ex.icon}
            </span>
            {ex.label}
          </button>
        ))}
      </div>
    </div>
  );
}
