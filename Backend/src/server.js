require('dotenv').config();
const buildApp = require('./app');
const { sequelize, StatArbInput } = require('./models');
const orderbookManager = require('./services/orderbookStreams');
const tradeExecutor = require('./services/tradeExecutor');
const unilateralExecutor = require('./services/unilateralExecutor');
const telegramReport = require('./services/telegramReport');
const telegramBot = require('./services/telegramBot');

const PORT = process.env.PORT || 4001;

const start = async () => {
  const app = buildApp();

  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connected successfully.');

    // Sync models (creates tables if they don't exist)
    await sequelize.sync({ alter: true });
    console.log('Database synced.');

    // Start server
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${PORT}`);

    // Auto-subscribe orderbook feeds and enable trading for active pairs on boot
    const activePairs = await StatArbInput.findAll({ where: { status: 'active' } });
    if (activePairs.length > 0) {
      orderbookManager.syncWithActivePairs(activePairs);
      console.log(`[Boot] Auto-subscribed ${activePairs.length} active pair(s) to orderbook feeds`);

      // Auto-enable trading for all active pairs on boot (parallel so one pair's
      // slow bootstrap / API poll cannot block another — e.g. ETH must not wait on BTC).
      const enableSettled = await Promise.allSettled(
        activePairs.map(async (pair) => {
          const executor = pair.unilateralMode ? unilateralExecutor : tradeExecutor;
          const result = await executor.enableTrading(pair.id);
          await StatArbInput.update({ tradingEnabled: true }, { where: { id: pair.id } }).catch(() => {});
          return { pair, result };
        }),
      );
      for (const s of enableSettled) {
        if (s.status === 'fulfilled') {
          const { pair, result } = s.value;
          console.log(
            `[Boot] Auto-enabled trading pair ${pair.id} (${pair.agentName}): ${result.message || result.state}`,
          );
        } else {
          console.error('[Boot] enableTrading rejected:', s.reason?.message || s.reason);
        }
      }

      // Adaptive levels: 15 min during USA market hours (13:30–20:00 UTC), 30 min otherwise
      unilateralExecutor.startAdaptScheduler();
    }

    // Telegram bot command polling (reports on-demand via /btc /report /reports)
    telegramBot.startPolling();

  } catch (err) {
    console.error('Unable to start server:', err);
    process.exit(1);
  }
};

start();
