const https = require("https");
const axios = require("axios");
const { Hyperliquid } = require('hyperliquid');
const {
    getBucket,
    orderStatusCache,
    orderStatusDedup,
    TERMINAL_STATES,
    TERMINAL_TTL_MS,
    PENDING_TTL_MS,
} = require('../services/deribitRateLimiter');

const accessTokenCache = {};

const retry = async (fn, retries = 3, delay = 1000) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const status = error.response?.status;
            // Retry on 429 (rate limited) with Retry-After header or exponential backoff
            if (status === 429) {
                const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '0', 10);
                const waitMs = retryAfter > 0 ? retryAfter * 1000 : delay;
                console.warn(`[Deribit] 429 rate limited, waiting ${waitMs}ms before retry ${attempt}/${retries}`);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                delay = Math.min(delay * 2, 10000);
                continue;
            }
            if (attempt === retries || (status !== 400 && status !== 503)) {
                throw error;
            }
            console.log(`Attempt ${attempt} failed (status=${status}), retrying after ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

const getDeribitAccessToken = async (apikey, secret, forceRefresh = false) => {
    const cacheKey = `${apikey}`;

    // AUTH: Check if token is valid and not forced to refresh
    if (
        !forceRefresh &&
        accessTokenCache[cacheKey] &&
        accessTokenCache[cacheKey].expires > Date.now()
    ) {
        return accessTokenCache[cacheKey].token;
    }

    try {
        // AUTH: Wrapped token request in retry logic
        const response = await retry(() =>
            axios.post("https://www.deribit.com/api/v2/public/auth", {
                jsonrpc: "2.0",
                id: 1,
                method: "public/auth",
                params: {
                    grant_type: "client_credentials",
                    client_id: apikey,
                    client_secret: secret,
                    scope: "trade:read_write",
                },
            })
        );

        const token = response.data.result.access_token;
        const expiresIn = response.data.result.expires_in * 1000;

        // AUTH: Cache the new token
        accessTokenCache[cacheKey] = {
            token: token,
            expires: Date.now() + expiresIn - 60000,
        };

        return token;
    } catch (error) {
        // AUTH: Enhanced error logging for token fetching
        console.error(
            "Error getting Deribit access token:",
            error.message,
            error.response?.data || ""
        );
        throw error;
    }
};

async function signedRequest(path, apikey, secretkey) {
    const bucket = getBucket(apikey);
    await bucket.acquire();

    let url;
    try {
        const deribitUrl = "https://www.deribit.com";
        let accessToken = await getDeribitAccessToken(apikey, secretkey, false);
        url = `${deribitUrl}${path}`;

        const makeRequest = async (token) => {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 10000,
            });
            return response.data;
        };

        try {
            return await makeRequest(accessToken);
        } catch (apiError) {
            const status = apiError.response?.status;

            if (status === 429) {
                const retryAfter = parseInt(apiError.response?.headers?.['retry-after'] || '2', 10);
                console.warn(`[Deribit] 429 on ${path}, backing off ${retryAfter}s`);
                await new Promise((r) => setTimeout(r, retryAfter * 1000));
                await bucket.acquire();
                return await makeRequest(accessToken);
            }

            if (
                status === 400 &&
                apiError.response?.data?.error?.code === 13009 &&
                apiError.response?.data?.error?.data?.reason === "session_not_found"
            ) {
                console.log("Session not found, refreshing token and retrying...");
                accessToken = await getDeribitAccessToken(apikey, secretkey, true);
                return await makeRequest(accessToken);
            }
            throw apiError;
        }
    } catch (error) {
        const status = error?.response?.status;
        const responseData = error?.response?.data;
        const deribitErrorCode = responseData?.error?.code;
        const deribitErrorMessage = responseData?.error?.message;
        // 11044 not_open_order — expected race (order already filled/cancelled/expired).
        // 10004 order_not_found — expected during bootstrap reconciliation for stale order IDs.
        // Both are fully handled by callers; suppress to warn to keep error log clean.
        if (deribitErrorCode === 11044 || deribitErrorMessage === 'not_open_order') {
            console.warn(
                `[Deribit signedRequest] ${path?.replace(/apikey=.*/, 'apikey=***')} — not_open_order (11044), will reconcile via get_order_state`,
            );
        } else if (deribitErrorCode === 10004 || deribitErrorMessage === 'order_not_found') {
            console.debug(
                `[Deribit signedRequest] ${path?.replace(/apikey=.*/, 'apikey=***')} — order_not_found (10004), bootstrap reconciliation will handle`,
            );
        } else {
            console.error("[Deribit signedRequest] request failed", {
                path: path.replace(/apikey=.*/, 'apikey=***'),
                url: url?.replace(/apikey=.*/, 'apikey=***'),
                status,
                message: error?.message,
                deribitErrorCode,
                deribitErrorMessage,
                deribitErrorData: responseData?.error?.data,
            });
        }
        return responseData?.error?.message || error?.message || "Unknown Deribit request error";
    }
}

// signedRequest swallows Deribit errors and returns the error message string.
// Detect the "not_open_order" race so the caller can branch on it.
const _isNotOpenOrderResponse = (resp) => {
    if (resp == null) return false;
    if (typeof resp === 'string') return resp.toLowerCase().includes('not_open_order');
    // structured (shouldn't happen for errors today, future-proof)
    if (resp?.error?.code === 11044) return true;
    if (typeof resp?.error?.message === 'string' && resp.error.message.toLowerCase().includes('not_open_order')) return true;
    return false;
};

/**
 * Cancel an open Deribit order.
 *
 * When Deribit returns 11044 `not_open_order` (the order is already filled /
 * cancelled / expired / rejected) we transparently call `get_order_state` and
 * return a reconciled shape so callers know the real terminal state instead of
 * seeing a silent failure:
 *   { notOpen: true, orderState: 'filled'|'cancelled'|'rejected'|'untriggered'|'not_found',
 *     order: <full order payload or null>, reconciled: true }
 *
 * For successful cancels the raw Deribit response is returned unchanged.
 */
const cancelorder = async (orderId, apikey, secretkey, label, currency) => {
    try {
        let cancelOrderResponse;
        const hasLabel = label !== undefined && label !== null && String(label).trim() !== '';
        const hasCurrency = currency !== undefined && currency !== null && String(currency).trim() !== '';

        if (hasLabel && hasCurrency) {
            cancelOrderResponse = await signedRequest(`/api/v2/private/cancel_by_label?label=${label}&currency=${currency}`, apikey, secretkey);
            if (cancelOrderResponse?.result === 0) {
                cancelOrderResponse = await signedRequest(
                    `/api/v2/private/cancel?order_id=${orderId}`,
                    apikey,
                    secretkey
                );
            }
        } else {
            cancelOrderResponse = await signedRequest(
                `/api/v2/private/cancel?order_id=${orderId}`,
                apikey,
                secretkey
            );
        }

        // Reconcile when the order is already in a terminal state.
        if (_isNotOpenOrderResponse(cancelOrderResponse) && orderId) {
            try {
                // bypass the status cache to avoid a stale "open" hit right after the race
                orderStatusCache.delete(`os_${orderId}`);
            } catch (_) { /* noop */ }

            const statusResp = await deribitorderStatus(orderId, apikey, secretkey);
            const raw = statusResp?.result;
            const order = Array.isArray(raw) ? raw[0] : raw;
            const orderState = (order?.order_state || '').toLowerCase() || 'not_found';
            console.log(
                `[cancelorder] ${orderId} not_open_order -> reconciled order_state=${orderState}`,
            );
            return {
                notOpen: true,
                reconciled: true,
                orderState,
                order: order || null,
            };
        }

        return cancelOrderResponse;
    } catch (error) {
        console.error(`Error in cancelorder: ${error.message}`);
        return null;
    }
};

const deribitorderStatus = async (orderId, apikey, secretkey, label, currency) => {
    const cacheKey = `os_${orderId}`;
    const cached = orderStatusCache.get(cacheKey);
    if (cached) return cached;

    return orderStatusDedup.dedupe(cacheKey, async () => {
        try {
            let getOrderResponse;
            const hasLabel = label !== undefined && label !== null && String(label).trim() !== '';
            const hasCurrency = currency !== undefined && currency !== null && String(currency).trim() !== '';
            if (hasLabel && hasCurrency) {
                getOrderResponse = await signedRequest(
                    `/api/v2/private/get_order_state_by_label?label=${label}&currency=${currency}&order_id=${orderId}`,
                    apikey,
                    secretkey
                );
                if (getOrderResponse?.result?.length === 0) {
                    getOrderResponse = await signedRequest(
                        `/api/v2/private/get_order_state?order_id=${orderId}`,
                        apikey,
                        secretkey
                    );
                }
            } else {
                getOrderResponse = await signedRequest(
                    `/api/v2/private/get_order_state?order_id=${orderId}`,
                    apikey,
                    secretkey
                );
            }

            // Cache terminal states longer since they won't change
            const state = (getOrderResponse?.result?.order_state ||
                           getOrderResponse?.result?.[0]?.order_state || '').toLowerCase();
            const ttl = TERMINAL_STATES.has(state) ? TERMINAL_TTL_MS : PENDING_TTL_MS;
            orderStatusCache.set(cacheKey, getOrderResponse, ttl);

            return getOrderResponse;
        } catch (error) {
            console.error(`Error in deribitorderStatus: ${error.message}`);
            return null;
        }
    });
};


// Example Order ID
const buyorder = async (symbol, quantity, type, price, apikey, secretkey, trigger_price, label) => {
    try {
        // console.log(symbol, "symbol", quantity, "quantity", type, "type", price, "price", apikey, secretkey);

        if (type === 'limit') {
            const buying = await signedRequest(
                `/api/v2/private/buy?instrument_name=${symbol}&amount=${quantity}&type=${type}&price=${price}&post_only=true`,
                apikey,
                secretkey
            );

            // const orderId = buying.result.order.order_id
            return buying;
        } else if (type === 'market') {
            const buying = await signedRequest(
                `/api/v2/private/buy?instrument_name=${symbol}&amount=${quantity}&type=${type}`,
                apikey,
                secretkey
            );

            // const orderId = buying.result.order.order_id
            return buying;
        } else if (type === 'stop_limit' || type === 'take_limit') {

            const buying = await signedRequest(`/api/v2/private/buy?instrument_name=${symbol}&amount=${quantity}&type=${type}&price=${price}&trigger_price=${trigger_price}&trigger=last_price&label=${label}`, apikey,
                secretkey);
            return buying;
        }
    } catch (error) {
        // Log and respond with an error
        console.error(`Error in buy API: ${error.message}`);
    }
};


const sellorder = async (symbol, quantity, type, price, apikey, secretkey, trigger_price, label) => {
    try {
        if (type === 'limit') {
            const selling = await signedRequest(
                `/api/v2/private/sell?instrument_name=${symbol}&amount=${quantity}&type=${type}&price=${price}&post_only=true`,
                apikey,
                secretkey
            );
            return selling;
        } else if (type === 'market') {
            const selling = await signedRequest(
                `/api/v2/private/sell?instrument_name=${symbol}&amount=${quantity}&type=${type}`,
                apikey,
                secretkey
            );
            return selling;
        }
        else if (type === 'stop_limit' || type === 'take_limit') {
            const selling = await signedRequest(
                `/api/v2/private/sell?instrument_name=${symbol}&amount=${quantity}&type=${type}&price=${price}&trigger_price=${trigger_price}&trigger=last_price&label=${label}`,
                apikey,
                secretkey
            );
            return selling;
        }
    } catch (error) {
        // Log and respond with an error
        console.error(`Error in sell API: ${error.message}`);
    }
};

async function hypeplaceOrder({
    client,
    symbol,
    isBuy,
    quantity,
    Price,
    isMarket = false,
    slippageBps = 50
}) {
    // For IOC (market) orders, add slippage buffer so the order actually fills
    // even if price moved slightly since the orderbook snapshot
    let limitPrice = Price;
    if (isMarket) {
        const slippageMul = slippageBps / 10000;
        limitPrice = isBuy
            ? Price * (1 + slippageMul)   // buy higher to ensure fill
            : Price * (1 - slippageMul);   // sell lower to ensure fill
        // Round to reasonable precision (Hyperliquid uses 5 significant figures)
        limitPrice = parseFloat(limitPrice.toPrecision(5));
    }

    const order = await client.exchange.placeOrder({
        coin: symbol,
        is_buy: isBuy,
        sz: quantity.toString(),
        limit_px: limitPrice.toString(),
        order_type: {
            limit: {
                tif: isMarket ? "Ioc" : "Gtc"
            }
        },
        reduce_only: false
    });

    return order;
}

async function gethypeOrderStatus(client, orderId) {
    if (!orderId) {
        throw new Error("orderId is required");
    }

    const address = client.vaultAddress ?? client.exchange.wallet.address;

    return await client.info.getOrderStatus(
        address,
        Number(orderId),
        true
    );
}
async function hypecancelOrder(client, order) {
    return await client.exchange.cancelOrder({
        coin: order.symbol,
        o: Number(order.id),
    });
}

async function initializeClient(exchange, credentials) {
    switch (exchange) {

        case "deribit":
            return {
                credential: {
                    apiKey: credentials.apiKey,
                    secretKey: credentials.secret,
                },
            };

        case "hyperliquid":
            const hyperliquidInstance = new Hyperliquid({
                enableWs: false,
                privateKey: credentials.secret,
                vaultAddress: credentials.vaultAddress,
                testnet: false,
                disableAssetMapRefresh: false,
            });

            await hyperliquidInstance.initialize();
            return hyperliquidInstance;

        default:
            throw new Error(`Unsupported exchange: ${exchange}`);
    }
}

const getDeribitPositions = async (apikey, secretkey, currency = 'BTC') => {
    try {
        const response = await signedRequest(
            `/api/v2/private/get_positions?currency=${currency}`,
            apikey,
            secretkey
        );
        if (response?.result) return response.result;
        return [];
    } catch (e) {
        console.error(`[getDeribitPositions] ${e.message}`);
        return [];
    }
};

module.exports = {
    getDeribitAccessToken,
    signedRequest,
    buyorder,
    sellorder,
    cancelorder,
    deribitorderStatus,
    getDeribitPositions,
    hypeplaceOrder,
    gethypeOrderStatus,
    hypecancelOrder,
    initializeClient,
};





