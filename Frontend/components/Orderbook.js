"use client";

function formatPrice(price) {
  const num = parseFloat(price);
  if (num >= 1000) return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

function formatSize(size) {
  const num = parseFloat(size);
  if (num >= 1000000) return (num / 1000000).toFixed(2) + "M";
  if (num >= 1000) return (num / 1000).toFixed(2) + "K";
  if (num >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

export default function Orderbook({ data, label, color }) {
  if (!data || (!data.bids?.length && !data.asks?.length)) {
    return (
      <div className="flex-1 min-w-[300px]">
        <div className="flex items-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${color}`} />
          <span className="text-sm font-bold text-slate-400 uppercase tracking-wider">
            {label}
          </span>
        </div>
        <div className="rounded-xl border border-slate-800/40 bg-slate-900/30 p-6 text-center">
          <div className="flex items-center justify-center gap-2">
            <div className="w-3.5 h-3.5 border-2 border-slate-700 border-t-slate-400 rounded-full animate-spin" />
            <span className="text-base text-slate-600">Waiting for data...</span>
          </div>
        </div>
      </div>
    );
  }

  const maxBidSize = Math.max(...data.bids.map((b) => parseFloat(b.size) || 0), 0.001);
  const maxAskSize = Math.max(...data.asks.map((a) => parseFloat(a.size) || 0), 0.001);
  const asksReversed = [...data.asks].reverse();

  const bestBid = parseFloat(data.bids[0]?.price || 0);
  const bestAsk = parseFloat(data.asks[0]?.price || 0);
  const spreadVal = bestAsk - bestBid;
  const spreadPct = bestBid > 0 ? ((spreadVal / bestBid) * 100).toFixed(3) : "0";

  return (
    <div className="flex-1 min-w-[300px]">
      {/* Label */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full glow-dot ${color}`} />
          <span className="text-sm font-bold text-slate-300 uppercase tracking-wider">
            {label}
          </span>
        </div>
        <span className="text-xs text-slate-500 font-mono">
          {data.exchange} / {data.symbol}
        </span>
      </div>

      <div className="rounded-xl border border-slate-800/50 bg-[#0a0e16] overflow-hidden">
        {/* Column Header */}
        <div className="grid grid-cols-3 px-4 py-2 bg-slate-800/20 border-b border-slate-800/40">
          <span className="text-xs font-extrabold text-slate-500 uppercase tracking-wider">
            Price
          </span>
          <span className="text-xs font-extrabold text-slate-500 uppercase tracking-wider text-right">
            Size
          </span>
          <span className="text-xs font-extrabold text-slate-500 uppercase tracking-wider text-right">
            Total
          </span>
        </div>

        {/* Asks */}
        <div>
          {(() => {
            let cumSize = 0;
            const rows = asksReversed.map((ask) => {
              cumSize += parseFloat(ask.size);
              return { ...ask, cumSize };
            });
            const maxCum = rows[rows.length - 1]?.cumSize || 1;
            return rows.map((ask, i) => {
              const pct = (parseFloat(ask.size) / maxAskSize) * 100;
              return (
                <div key={`a${i}`} className="relative grid grid-cols-3 px-4 py-[5px] items-center hover:bg-red-500/5 transition-colors">
                  <div
                    className="absolute inset-y-0 right-0 bg-red-500/[0.07]"
                    style={{ width: `${(ask.cumSize / maxCum) * 100}%` }}
                  />
                  <span className="relative text-sm font-mono font-semibold text-red-400 tabular-nums">
                    {formatPrice(ask.price)}
                  </span>
                  <span className="relative text-sm font-mono text-slate-400 text-right tabular-nums">
                    {formatSize(ask.size)}
                  </span>
                  <span className="relative text-xs font-mono text-slate-600 text-right tabular-nums">
                    {formatSize(ask.cumSize)}
                  </span>
                </div>
              );
            });
          })()}
        </div>

        {/* Spread */}
        <div className="grid grid-cols-3 px-4 py-2 bg-slate-800/30 border-y border-slate-700/20">
          <span className="text-base font-mono font-bold text-white tabular-nums">
            {formatPrice(bestAsk)}
          </span>
          <span className="text-xs font-mono text-slate-400 text-right self-center">
            {formatPrice(spreadVal)}
          </span>
          <span className="text-xs font-mono text-slate-500 text-right self-center">
            {spreadPct}%
          </span>
        </div>

        {/* Bids */}
        <div>
          {(() => {
            let cumSize = 0;
            const rows = data.bids.map((bid) => {
              cumSize += parseFloat(bid.size);
              return { ...bid, cumSize };
            });
            const maxCum = rows[rows.length - 1]?.cumSize || 1;
            return rows.map((bid, i) => {
              return (
                <div key={`b${i}`} className="relative grid grid-cols-3 px-4 py-[5px] items-center hover:bg-emerald-500/5 transition-colors">
                  <div
                    className="absolute inset-y-0 right-0 bg-emerald-500/[0.07]"
                    style={{ width: `${(bid.cumSize / maxCum) * 100}%` }}
                  />
                  <span className="relative text-sm font-mono font-semibold text-emerald-400 tabular-nums">
                    {formatPrice(bid.price)}
                  </span>
                  <span className="relative text-sm font-mono text-slate-400 text-right tabular-nums">
                    {formatSize(bid.size)}
                  </span>
                  <span className="relative text-xs font-mono text-slate-600 text-right tabular-nums">
                    {formatSize(bid.cumSize)}
                  </span>
                </div>
              );
            });
          })()}
        </div>
      </div>
    </div>
  );
}
