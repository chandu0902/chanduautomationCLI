const orderbookManager = require('../services/orderbookStreams');
const tradeExecutor    = require('../services/tradeExecutor');
const unilateralExecutor = require('../services/unilateralExecutor');
const { StatArbInput } = require('../models');

async function wsRoutes(fastify, options) {
  const pickExecutor = () => unilateralExecutor;

  fastify.get('/ws/orderbook', { websocket: true }, (connection, req) => {
    const socket = connection.socket || connection;
    console.log('[WS] Frontend client connected');
    orderbookManager.addClient(socket);

    // Sync active pairs on new connection
    StatArbInput.findAll({ where: { status: 'active' } }).then((pairs) => {
      orderbookManager.syncWithActivePairs(pairs);
      // Push current trade states to newly connected client
      for (const pair of pairs) {
        const ex = pickExecutor(pair);
        const state = ex.getState(pair.id);
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify({ type: 'trade_state', pairId: pair.id, ...state }));
          const acct = typeof ex.getAccountInfo === 'function' ? ex.getAccountInfo(pair.id) : null;
          if (acct) socket.send(JSON.stringify({ type: 'account_info', pairId: pair.id, ...acct }));
        }
      }
    });

    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'sync') {
          const pairs = await StatArbInput.findAll({ where: { status: 'active' } });
          orderbookManager.syncWithActivePairs(pairs);
        }
      } catch (e) {
        // ignore
      }
    });
  });
}

module.exports = wsRoutes;
