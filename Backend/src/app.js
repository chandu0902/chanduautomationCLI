const fastify = require('fastify');

function buildApp(opts = {}) {
  const app = fastify({
    logger: {
      level: 'error',
      // disable request logging emitted at info/debug levels
      transport: process.env.NODE_ENV === 'development' ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' }
      } : undefined,
    },
    ...opts,
  });

  // Allow POST/PUT requests with Content-Type: application/json but no body
  // (Fastify's default parser rejects empty-body JSON requests with FST_ERR_CTP_EMPTY_JSON_BODY).
  // Routes like /api/pairs/:id/trade/enable have no body; they just carry the
  // action in the URL. This parser treats an absent/empty body as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, bodyStr, done) => {
    if (!bodyStr || bodyStr.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(bodyStr));
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Register plugins
  app.register(require('./plugins/cors'));
  app.register(require('@fastify/websocket'));

  // Register routes
  app.register(require('./routes'));

  // Register WebSocket route
  app.register(require('./routes/ws'));

  return app;
}

module.exports = buildApp;
