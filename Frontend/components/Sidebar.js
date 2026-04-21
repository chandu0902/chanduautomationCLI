"use client";

const NAV_ITEMS = [
  {
    id: "statarb",
    label: "StatArb",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
        <polyline points="16,7 22,7 22,13" />
      </svg>
    ),
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    id: "trades",
    label: "Trades",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="18" rx="2" />
        <line x1="2" y1="9" x2="22" y2="9" />
        <line x1="10" y1="3" x2="10" y2="21" />
      </svg>
    ),
  },
];

export default function Sidebar({ active, onNavigate, allAgents = [] }) {
  return (
    <div className="fixed left-0 top-0 bottom-0 w-[220px] bg-[#080c14] border-r border-slate-800/60 flex flex-col z-40">
      {/* Logo */}
      <div className="flex items-center gap-3 px-5 py-5 border-b border-slate-800/40">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22,7 13.5,15.5 8.5,10.5 2,17" />
            <polyline points="16,7 22,7 22,13" />
          </svg>
        </div>
        <div>
          <h1 className="text-base font-bold text-white tracking-tight leading-none">StatArb</h1>
          <p className="text-[10px] text-slate-500 tracking-wide">Arbitrage Platform</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer ${
              active === item.id
                ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent"
            }`}
          >
            <span className={active === item.id ? "text-blue-400" : "text-slate-500"}>{item.icon}</span>
            {item.label}
          </button>
        ))}

        {/* Agents */}
        <div className="pt-4 mt-3 border-t border-slate-800/40">
          <div className="flex items-center justify-between px-3 mb-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-600">Agents</span>
            <span className="text-[10px] font-mono text-slate-600 bg-slate-800/60 px-1.5 py-0.5 rounded">{allAgents.length}</span>
          </div>
          {allAgents.length > 0 ? (
            allAgents.map(({ name, activeCount, tradingCount = 0 }) => {
              const agentId = `agent:${name}`;
              const isSelected = active === agentId;
              const showLive = activeCount > 0 || tradingCount > 0;
              return (
                <button
                  key={agentId}
                  onClick={() => onNavigate(agentId)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer ${
                    isSelected
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent"
                  }`}
                  title={
                    tradingCount > 0
                      ? `${tradingCount} pair(s) trading now · ${activeCount} pair(s) status active in DB`
                      : activeCount > 0
                        ? `${activeCount} pair(s) status active (DB)`
                        : "No active config and no live trading on this agent"
                  }
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showLive ? "bg-emerald-400" : "bg-slate-600"}`} />
                  <span className="truncate flex-1 text-left">{name}</span>
                  {tradingCount > 0 ? (
                    <span className="text-[10px] font-mono bg-violet-500/15 text-violet-300 px-1.5 py-0.5 rounded flex-shrink-0">
                      {tradingCount} on
                    </span>
                  ) : activeCount > 0 ? (
                    <span className="text-[10px] font-mono bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded flex-shrink-0">
                      {activeCount}
                    </span>
                  ) : null}
                </button>
              );
            })
          ) : (
            <p className="px-3 text-xs text-slate-600">No agents yet</p>
          )}
        </div>
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-slate-800/40">
        <div className="flex items-center gap-2">
          <span className="glow-dot w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs text-slate-500 font-medium">Live</span>
        </div>
      </div>
    </div>
  );
}
