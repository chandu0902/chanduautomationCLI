const fp = require('fastify-plugin');
const cors = require('@fastify/cors');

async function corsPlugin(fastify, options) {
  await fastify.register(cors, {
    origin: (process.env.CORS_ORIGIN || 'http://localhost:4000').split(',').map(s => s.trim()),
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  });
}

module.exports = fp(corsPlugin);
