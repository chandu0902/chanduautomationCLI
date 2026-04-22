# Project: Stat-Arb Trading Bot (21042026)

## What this project is

A **statistical arbitrage / basis trading bot** that trades spread between two exchanges (primarily Deribit futures and Hyperliquid perpetuals). It has:

- A **Next.js frontend** (`Frontend/`) — dashboard UI for managing pairs, viewing trade logs, orderbooks, spreads
- A **Fastify backend** (`Backend/`) — REST API + WebSocket server, trade execution engine, Telegram bot

## Backend structure (`Backend/src/`)

| Path | Purpose |
|------|---------|
| `server.js` | Entry point — boots DB, starts orderbook feeds, auto-enables active pairs on startup |
| `app.js` | Fastify app builder |
| `models/` | Sequelize models: `Pair` (StatArbInput), `Trade`, `BasisPosition`, `SpreadLog`, `HourlyRagStat`, etc. |
| `services/orderbookStreams.js` | Live WebSocket orderbook feeds for active pairs |
| `services/unilateralExecutor.js` | Main live trading engine — one-leg (unilateral) mode with zone grid, A-S model, trailing SL |
| `services/tradeExecutor.js` | Two-leg trade executor (older bilateral mode) |
| `services/paperTradeRunner.js` | Paper trade engine — isolated WS connections to Deribit + Hyperliquid, feeds into unilateraltest_hft |
| `services/unilateraltest_hft.js` | HFT paper/test executor — zone grid + A-S + breakout logic |
| `services/unilateralExecutorV2.js` | V2 executor variant |
| `services/telegramBot.js` | Telegram bot polling for `/btc /report /reports` commands |
| `services/telegramReport.js` | Report formatting for Telegram |
| `controllers/apicontroller.js` | Exchange API calls (buy/sell/cancel orders on Deribit, Hyperliquid) |
| `routes/` | REST routes: pairs, trades, accounts, exchanges, spreadLogs, ws, ai |

## Frontend structure (`Frontend/`)

- `app/page.js` — main dashboard page (~90KB, large single file)
- `components/` — PairTable, TradeLogsPage, ActivePairOrderbooks, SpreadChart, AccountManager, etc.

## Key concepts

- **StatArbInput (Pair)** — DB model for a trading pair. Fields: `exchange1/2`, `symbol1/2`, `unilateralMode`, `tradeLeg`, `status` (active/inactive), `tradingEnabled`, `zoneGridConfig`, `tpSpreadDelta`, `slSpreadDelta`, etc.
- **Unilateral mode** — only trades one leg (Deribit future); uses Hyperliquid book as spread signal only
- **Zone grid** — price range divided into zones, each with own qty/TP/SL/maxPositions config
- **A-S model** — Avellaneda-Stoikov market making model for spread quoting
- **Paper trading** — fully isolated from live bot, uses separate WS connections, logs to `Backend/reports/paper_trade_sol_live.*`

## Running the project

```bash
# Backend
cd Backend && node src/server.js

# Frontend
cd Frontend && npm run dev   # runs on port 3000
```

## Database

SQLite (via Sequelize). Config in `Backend/src/config/database.js`.

## Active branches and ongoing work

- `main` — stable base (2 commits: initial + zip cleanup)
- Various `task/...` branches from Claude Code sessions — check `git branch` for current work

## Session continuity rule (CRITICAL)

After completing **every task** sent via Telegram, update `D:/Project/21042026/work_context.md` with:
- What was just done (bullet points)
- What is in progress or pending next
- Which files were modified
- Which git branch is active

Keep it under 30 lines. **Overwrite the whole file each time.** This file is injected into the next session's prompt if the Claude session expires, so it must always reflect the latest state.

## Important notes for Claude

- **Always check git branch** at session start to understand what work was in progress
- **Paper trade files**: `Backend/reports/paper_trade_sol_live.*` (log, CSV, summary)
- The `unilateraltest_hft.js` is the executor used by paper trading — it has `initPaperTrading`, `onPaperSpreadUpdate`, `getPaperState`, `stopPaperTrading` exports
- Bak files (`.bak-*`) are timestamped backups — do not delete, they're the history
- Backend port: 4001, Frontend port: 3000
