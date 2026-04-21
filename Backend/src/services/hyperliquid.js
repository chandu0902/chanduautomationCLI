const { Hyperliquid } = require('hyperliquid');

const sdk = new Hyperliquid();

const DEX_TYPES = ['xyz', 'flx', 'vntl', 'hyna', 'km', 'cash'];

/**
 * Returns all perp symbols (e.g. BTC, ETH, SOL ...)
 */
async function getPerpSymbols() {
  const meta = await sdk.info.perpetuals.getMeta();
  return meta.universe.map((m) => m.name);
}

/**
 * Returns symbols for a specific DEX (e.g. 'xyz', 'flx').
 * Strips the dex prefix from names.
 */
async function getDexSymbols(dex) {
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }),
  });
  const data = await res.json();
  const prefix = `${dex}:`;
  return data[0].universe.map((a) => a.name.replace(prefix, ''));
}

module.exports = {
  DEX_TYPES,
  getPerpSymbols,
  getDexSymbols,
};
