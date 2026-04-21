"use client";

import Orderbook from "./Orderbook";

export default function ActivePairOrderbooks({ pairs, books }) {
  if (pairs.length === 0) return null;

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <div className="space-y-6">
      {pairs.map((pair) => {
        const leg1 = books[`${pair.id}_leg1`];
        const leg2 = books[`${pair.id}_leg2`];

        // Calculate spread if both have best bid/ask
        let spread = null;
        if (leg1?.bids?.[0] && leg2?.asks?.[0]) {
          const bid1 = parseFloat(leg1.bids[0].price);
          const ask2 = parseFloat(leg2.asks[0].price);
          if (bid1 > 0) {
            spread = (((ask2 - bid1) / bid1) * 100).toFixed(4);
          }
        }

        return (
          <div
            key={pair.id}
            className="rounded-2xl border border-slate-800/60 bg-gradient-to-b from-slate-900/60 to-[#080c14] p-5"
          >
            {/* Pair header */}
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800/40">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-white">
                  {capitalize(pair.exchange1)}
                  <span className="text-slate-500 mx-1">/</span>
                  <span className="text-slate-400">{pair.type1.toUpperCase()}</span>
                  <span className="text-blue-400 ml-1 font-mono">{pair.symbol1}</span>
                </span>
                <span className="text-[10px] text-slate-600 font-bold">VS</span>
                <span className="text-xs font-semibold text-white">
                  {capitalize(pair.exchange2)}
                  <span className="text-slate-500 mx-1">/</span>
                  <span className="text-slate-400">{pair.type2.toUpperCase()}</span>
                  <span className="text-violet-400 ml-1 font-mono">{pair.symbol2}</span>
                </span>
              </div>
              {spread !== null && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500 uppercase tracking-wider">Spread</span>
                  <span
                    className={`text-xs font-bold font-mono px-2 py-0.5 rounded-md ${
                      parseFloat(spread) >= 0
                        ? "text-emerald-400 bg-emerald-500/10"
                        : "text-red-400 bg-red-500/10"
                    }`}
                  >
                    {spread}%
                  </span>
                </div>
              )}
            </div>

            {/* Orderbooks side by side */}
            <div className="flex gap-4 flex-wrap">
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
        );
      })}
    </div>
  );
}
