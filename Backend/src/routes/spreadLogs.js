const { readLogs, readExtremes } = require('../services/spreadFileLogger');

async function spreadLogRoutes(fastify, options) {
  // Get spread logs for a pair + side (sell/buy)
  fastify.get('/api/pairs/:pairId/spread-logs/:side', async (request, reply) => {
    const { pairId, side } = request.params;
    const { limit = 500, since } = request.query;

    const logs = await readLogs(parseInt(pairId), side, {
      limit: parseInt(limit),
      since,
    });

    return logs;
  });

  // Get extreme values for a pair + side
  fastify.get('/api/pairs/:pairId/spread-extremes/:side', async (request, reply) => {
    const { pairId, side } = request.params;
    return readExtremes(parseInt(pairId), side);
  });
}

module.exports = spreadLogRoutes;
