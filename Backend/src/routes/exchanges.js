const { DEX_TYPES, getPerpSymbols, getDexSymbols } = require('../services/hyperliquid');
const { getCurrencies, getSymbolsByCurrency } = require('../services/deribit');

const HYPERLIQUID_TYPES = ['perps', ...DEX_TYPES];

async function exchangeRoutes(fastify, options) {
  // GET /api/exchanges/:exchange/types
  fastify.get('/api/exchanges/:exchange/types', async (request, reply) => {
    const { exchange } = request.params;

    if (exchange === 'hyperliquid') {
      return { exchange, types: HYPERLIQUID_TYPES };
    }
    if (exchange === 'deribit') {
      const currencies = await getCurrencies();
      return { exchange, types: currencies };
    }

    return reply.status(404).send({ error: `Exchange "${exchange}" not found` });
  });

  // GET /api/exchanges/:exchange/types/:type/symbols
  fastify.get('/api/exchanges/:exchange/types/:type/symbols', async (request, reply) => {
    const { exchange, type } = request.params;

    if (exchange === 'hyperliquid') {
      if (type === 'perps') {
        const symbols = await getPerpSymbols();
        return { exchange, type, symbols };
      }
      if (DEX_TYPES.includes(type)) {
        const symbols = await getDexSymbols(type);
        return { exchange, type, symbols };
      }
      return reply.status(404).send({ error: `Type "${type}" not found for hyperliquid` });
    }

    if (exchange === 'deribit') {
      const symbols = await getSymbolsByCurrency(type);
      return { exchange, type, symbols };
    }

    return reply.status(404).send({ error: `Exchange "${exchange}" not found` });
  });
}

module.exports = exchangeRoutes;
