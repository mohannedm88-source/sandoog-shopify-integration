const axios = require('axios');
const config = require('./config');
const logger = require('./logger');

/**
 * Thin client around the Sandoog Open API.
 * https://developers.sandoog.net/reference/sandoog-open-api
 *
 * Auth flow:
 *   1) POST /auth with header `Api-Key: <key>` -> { access_token, expires_in }
 *   2) Subsequent calls send `Api-Key` only. (Sandoog's overview also
 *      describes a Bearer step, but sending `Authorization: Bearer <token>`
 *      on the sandbox gateway triggers a gateway-level "Invalid key=value
 *      pair... in Authorization header" error — so we skip it. If a future
 *      Sandoog change requires it again, confirm the exact expected format
 *      with cs@sandoog.net first.)
 */

let cachedToken = null; // { access_token, expiresAt }

function http() {
    return axios.create({
          baseURL: config.sandoog.baseUrl,
          timeout: 15000,
    });
}

async function getAccessToken() {
    if (!config.sandoog.apiKey) {
          throw new Error('SANDOOG_API_KEY is not set (check your .env)');
    }

  const now = Date.now();
    if (cachedToken && cachedToken.expiresAt > now + 5000) {
          return cachedToken.access_token;
    }

  const res = await http().post(
        '/auth',
    {},
    { headers: { 'Api-Key': config.sandoog.apiKey } }
      );

  const { access_token, expires_in } = res.data || {};
    if (!access_token) {
          throw new Error('Sandoog /auth did not return an access_token');
    }

  cachedToken = {
        access_token,
        // expires_in is in seconds; refresh a little early to be safe.
        expiresAt: now + Math.max((expires_in || 300) * 1000 - 30000, 30000),
  };

  return cachedToken.access_token;
}

async function authHeaders() {
    // Sandoog's gateway chokes on a plain "Bearer <token>" Authorization header
  // (returns a gateway-level "Invalid key=value pair... in Authorization
  // header" error), and the per-endpoint reference docs only ever list
  // `Api-Key` as the required header — so send Api-Key only. getAccessToken()
  // is still called first to make sure the key is valid and to keep the
  // token-cache warm in case a future Sandoog change needs it again.
  await getAccessToken();
    return {
          'Api-Key': config.sandoog.apiKey,
          'Content-Type': 'application/json',
    };
}

/** One retry on 401, in case the cached token expired server-side early. */
async function request(method, url, data, extraHeaders) {
    try {
          const headers = { ...(await authHeaders()), ...extraHeaders };
          return await http().request({ method, url, data, headers });
    } catch (err) {
          if (err.response && err.response.status === 401) {
                  logger.warn('Sandoog 401 — refreshing token and retrying once', url);
                  cachedToken = null;
                  const headers = { ...(await authHeaders()), ...extraHeaders };
                  return http().request({ method, url, data, headers });
          }
          throw err;
    }
}

/**
 * Create a delivery order.
 * @param {object} orderPost - shape per POST /orders (see orderMapper.js)
 */
async function createOrder(orderPost) {
    const res = await request('post', '/orders', orderPost);
    return res.data;
}

async function getOrder(orderId) {
    const res = await request('get', `/orders/${encodeURIComponent(orderId)}`);
    return res.data;
}

async function cancelOrder(payload) {
    const res = await request('post', '/orders/canceled', payload);
    return res.data;
}

async function searchOrders(payload) {
    const res = await request('post', '/orders/search', payload);
    return res.data;
}

async function getCityCodes() {
    const res = await request('get', '/city-codes');
    return res.data;
}

/**
 * Register (or re-register) the callback URL Sandoog will POST order-status
 * updates to. Call this once per environment (sandbox / production) after
 * this service is deployed and reachable over HTTPS.
 * https://developers.sandoog.net/reference/post_webhooks-register-urls
 *
 * Unlike the other endpoints below (which only need `Api-Key` on this
 * sandbox gateway), this route replies with a bare gateway-level
 * `{"message":"Unauthorized"}` when no `Authorization` header is present at
 * all — consistent with Sandoog's own docs, which say every call after the
 * first must carry `Authorization: Bearer <access_token>`. So this one call
 * sends both headers; if it turns out other endpoints need the same, apply
 * the same extraHeaders here to request(...) in this file's other functions.
 */
async function registerWebhook({ callbackKey, orderUrl }) {
    const token = await getAccessToken();
    const res = await request(
          'post',
          '/webhooks/register-urls',
      { callback_key: callbackKey, order_url: orderUrl },
      { Authorization: `Bearer ${token}` }
        );
    return res.data;
}

module.exports = {
    getAccessToken,
    createOrder,
    getOrder,
    cancelOrder,
    searchOrders,
    getCityCodes,
    registerWebhook,
};
