const crypto = require('crypto');
const { AccountDetails } = require('../models');

function encryptText(plainText) {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return iv.toString('base64') + ',' + encrypted + ',' + key.toString('base64');
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

async function accountRoutes(fastify, options) {
  // GET /api/accounts
  fastify.get('/api/accounts', async (request, reply) => {
    const accounts = await AccountDetails.findAll({ order: [['createdAt', 'DESC']] });
    return accounts.map((a) => {
      const json = a.toJSON();
      json.Api_Key = maskKey(json.Api_Key);
      json.Secret_Key = maskKey(json.Secret_Key);
      return json;
    });
  });

  // GET /api/accounts/main?exchange=hyperliquid — for sub-account parent dropdown
  fastify.get('/api/accounts/main', async (request, reply) => {
    const { exchange } = request.query;
    const where = { Account_Type: 'Main Account' };
    if (exchange) where.Exchange = exchange;
    const accounts = await AccountDetails.findAll({ where, order: [['createdAt', 'DESC']] });
    return accounts.map((a) => ({
      id: a.id,
      Trade_Account: a.Trade_Account,
      Email: a.Email,
      Exchange: a.Exchange,
    }));
  });

  // POST /api/accounts
  fastify.post('/api/accounts', async (request, reply) => {
    const data = { ...request.body };

    // Encrypt sensitive fields before storing
    if (data.Api_Key) data.Api_Key = encryptText(data.Api_Key);
    if (data.Secret_Key) data.Secret_Key = encryptText(data.Secret_Key);
    if (data.vaultAddress) data.vaultAddress = encryptText(data.vaultAddress);
    if (data.passphrase) data.passphrase = encryptText(data.passphrase);
    if (data.seed) data.seed = encryptText(data.seed);

    const account = await AccountDetails.create(data);
    return reply.status(201).send(account);
  });

  // DELETE /api/accounts/:id
  fastify.delete('/api/accounts/:id', async (request, reply) => {
    const { id } = request.params;
    const account = await AccountDetails.findByPk(id);
    if (!account) return reply.status(404).send({ error: 'Account not found' });
    await account.destroy();
    return { message: 'Account deleted' };
  });
}

module.exports = accountRoutes;
