"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "https://unilateral.stringx.io/ws/orderbook";

export function useOrderbook() {
  const [books, setBooks] = useState({});
  const [sellSpreadData, setSellSpreadData] = useState({});
  const [buySpreadData, setBuySpreadData] = useState({});
  const [sellExtremes, setSellExtremes] = useState({});
  const [buyExtremes, setBuyExtremes] = useState({});
  const [midSpreadData, setMidSpreadData] = useState({});
  const [midExtremes, setMidExtremes] = useState({});
  const [tradeStates, setTradeStates] = useState({});
  const [leadLag, setLeadLag] = useState({});
  const [accountInfo, setAccountInfo] = useState({});
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Spread stats (single point)
        if (data.type === 'spread_stats') {
          // Mid spread (beta/different-symbol pairs)
          if (data.mid) {
            setMidSpreadData((prev) => {
              const existing = prev[data.pairId] || [];
              const updated = [...existing, {
                timestamp: data.mid.timestamp,
                spread: data.mid.spread,
                mean: data.mid.mean,
                std: data.mid.std,
                zScore: data.mid.zScore,
                upperBand: data.mid.upperBand,
                lowerBand: data.mid.lowerBand,
                dollarSpread:    data.mid.dollarSpread,
                dollarMean:      data.mid.dollarMean,
                dollarStd:       data.mid.dollarStd,
                dollarUpperBand: data.mid.dollarUpperBand,
                dollarLowerBand: data.mid.dollarLowerBand,
                dollarConvFactor: data.mid.dollarConvFactor,
              }];
              return { ...prev, [data.pairId]: updated.slice(-300) };
            });
            if (data.mid.extremes) {
              setMidExtremes((prev) => ({ ...prev, [data.pairId]: data.mid.extremes }));
            }
            if (data.leadLag) {
              setLeadLag((prev) => ({ ...prev, [data.pairId]: data.leadLag }));
            }
            return;
          }
          // Sell/buy spread (same-symbol pairs)
          setSellSpreadData((prev) => {
            const existing = prev[data.pairId] || [];
            const updated = [...existing, {
              timestamp: data.sell.timestamp,
              spread: data.sell.spread,
              mean: data.sell.mean,
              std: data.sell.std,
              zScore: data.sell.zScore,
              upperBand: data.sell.upperBand,
              lowerBand: data.sell.lowerBand,
            }];
            return { ...prev, [data.pairId]: updated.slice(-300) };
          });
          setBuySpreadData((prev) => {
            const existing = prev[data.pairId] || [];
            const updated = [...existing, {
              timestamp: data.buy.timestamp,
              spread: data.buy.spread,
              mean: data.buy.mean,
              std: data.buy.std,
              zScore: data.buy.zScore,
              upperBand: data.buy.upperBand,
              lowerBand: data.buy.lowerBand,
            }];
            return { ...prev, [data.pairId]: updated.slice(-300) };
          });
          if (data.sell.extremes) {
            setSellExtremes((prev) => ({ ...prev, [data.pairId]: data.sell.extremes }));
          }
          if (data.buy.extremes) {
            setBuyExtremes((prev) => ({ ...prev, [data.pairId]: data.buy.extremes }));
          }
          return;
        }

        // Spread history (bulk on connect)
        if (data.type === 'spread_history') {
          // Mid history (beta pairs)
          if (data.mid) {
            setMidSpreadData((prev) => ({
              ...prev,
              [data.pairId]: (data.mid.history || []).slice(-300),
            }));
            if (data.mid.extremes) {
              setMidExtremes((prev) => ({ ...prev, [data.pairId]: data.mid.extremes }));
            }
            return;
          }
          // Sell/buy history (same-symbol pairs)
          setSellSpreadData((prev) => ({
            ...prev,
            [data.pairId]: (data.sell.history || []).slice(-300),
          }));
          setBuySpreadData((prev) => ({
            ...prev,
            [data.pairId]: (data.buy.history || []).slice(-300),
          }));
          if (data.sell.extremes) {
            setSellExtremes((prev) => ({ ...prev, [data.pairId]: data.sell.extremes }));
          }
          if (data.buy.extremes) {
            setBuyExtremes((prev) => ({ ...prev, [data.pairId]: data.buy.extremes }));
          }
          return;
        }

        // Trade state updates
        if (data.type === 'trade_state') {
          const { type: _, pairId, ...rest } = data;
          setTradeStates((prev) => ({ ...prev, [pairId]: rest }));
          return;
        }

        // Account info (balance, positions)
        if (data.type === 'account_info') {
          const { type: _, pairId, ...rest } = data;
          setAccountInfo((prev) => ({ ...prev, [pairId]: rest }));
          return;
        }

        // Orderbook data
        if (data.pairId && data.side) {
          setBooks((prev) => ({
            ...prev,
            [`${data.pairId}_${data.side}`]: data,
          }));
        }
      } catch {}
    };

    ws.onclose = () => {
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const sync = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "sync" }));
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { books, sellSpreadData, buySpreadData, sellExtremes, buyExtremes, midSpreadData, midExtremes, tradeStates, leadLag, accountInfo, sync };
}
