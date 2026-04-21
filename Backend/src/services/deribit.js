const DERIBIT_API = 'https://www.deribit.com/api/v2/public';

/**
 * Returns list of currencies (e.g. BTC, ETH, SOL ...)
 */
async function getCurrencies() {
  const res = await fetch(`${DERIBIT_API}/get_currencies`);
  const data = await res.json();
  return data.result.map((c) => c.currency);
}

/**
 * Returns live instrument names for a given currency
 */
async function getSymbolsByCurrency(currency) {
  const res = await fetch(
    `${DERIBIT_API}/get_instruments?currency=${currency}`
  );
  const data = await res.json();
  return data.result.map((i) => i.instrument_name);
}

module.exports = {
  getCurrencies,
  getSymbolsByCurrency,
};
