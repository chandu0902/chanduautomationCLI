'use strict';

async function routes(fastify) {
  fastify.register(require('./pairs'));
  fastify.register(require('./trades'));
  fastify.register(require('./accounts'));
  fastify.register(require('./exchanges'));
  fastify.register(require('./spreadLogs'));
  fastify.register(require('./ai'));
}

module.exports = routes;
