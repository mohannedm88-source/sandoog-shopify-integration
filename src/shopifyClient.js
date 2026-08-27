const axios = require('axios');
const crypto = require('crypto');
const config = require('./config');
const logger = require('./logger');

/**
 * Shopify retired admin-created "custom apps" for new apps as of Jan 1 2026.
 * This app lives in the Dev Dashboard instead, and — because it only ever
 * talks to a store in the same Shopify organization — authenticates with the
 * client credentials grant: exchange client_id/client_secret for a token
 * that's valid 24h, no merchant install/redirect needed.
 * https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
 */
let cachedShopifyToken = null; // { access_token, expiresAt }

function requireClientCreds() {
  if (!config.shopify.clientId || !config.shopify.clientSecret) {
    throw new Error(
      'SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set. Create an app ' +
        'in the Dev Dashboard (dev.shopify.com/dashboard), release a version ' +
        'with read_orders/write_orders/read_fulfillments/write_fulfillments ' +
        'scopes, install it on this store, then copy the Client ID and ' +
        'Client secret from the app\'s Settings page into .env. See README.'
    );
  }
}

async function getShopifyAccessToken() {
  requireClientCreds();
  const now = Date.now();
  if (cachedShopifyToken && cachedShopifyToken.expiresAt > now + 5000) {
    return cachedShopifyToken.access_token;
  }

  const res = await axios.post(
    `https://${config.shopify.shopDomain}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.shopify.clientId,
      client_secret: config.shopify.clientSecret,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );

  const { access_token, expires_in } = res.data || {};
  if (!access_token) {
    throw new Error('Shopify client-credentials token request did not return an access_token');
  }

  cachedShopifyToken = {
    access_token,
    // expires_in is ~86399s (24h); refresh a bit early to be safe.
    expiresAt: now + Math.max((expires_in || 3600) * 1000 - 60000, 60000),
  };

  return cachedShopifyToken.access_token;
}

async function adminApi() {
  const token = await getShopifyAccessToken();
  return axios.create({
    baseURL: `https://${config.shopify.shopDomain}/admin/api/${config.shopify.apiVersion}`,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

async function graphql(query, variables) {
  const api = await adminApi();
  let res;
  try {
    res = await api.post('/graphql.json', { query, variables });
  } catch (err) {
    if (err.response && err.response.status === 401) {
      // Token may have expired early / been revoked — refresh once and retry.
      cachedShopifyToken = null;
      const retryApi = await adminApi();
      res = await retryApi.post('/graphql.json', { query, variables });
    } else {
      throw err;
    }
  }
  if (res.data.errors) {
    throw new Error('Shopify GraphQL error: ' + JSON.stringify(res.data.errors));
  }
  return res.data.data;
}

/**
 * Verify the X-Shopify-Hmac-Sha256 header on an incoming webhook request.
 * Shopify signs webhooks with the app's Client secret (same value used for
 * the client-credentials token exchange above) — there's no separate
 * webhook-only secret for Dev Dashboard apps.
 */
function verifyShopifyWebhookHmac(rawBody, hmacHeader) {
  if (!config.shopify.clientSecret) {
    logger.warn('SHOPIFY_CLIENT_SECRET not set — skipping HMAC verification (INSECURE, dev only)');
    return true;
  }
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', config.shopify.clientSecret)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

/**
 * Find a Shopify order by the `name` we sent Sandoog as external_reference
 * (e.g. "#1001"). Returns { id, name, tags, note, fulfillmentOrders } or null.
 */
async function findOrderByName(name) {
  const query = `
    query FindOrder($q: String!) {
      orders(first: 1, query: $q) {
        edges {
          node {
            id
            name
            tags
            note
            fulfillmentOrders(first: 10) {
              edges { node { id status } }
            }
          }
        }
      }
    }
  `;
  const q = name.startsWith('#') ? `name:'${name}'` : `name:'#${name}'`;
  const data = await graphql(query, { q });
  const edge = data.orders.edges[0];
  if (!edge) return null;
  const node = edge.node;
  return {
    id: node.id,
    name: node.name,
    tags: node.tags || [],
    note: node.note || '',
    openFulfillmentOrderIds: (node.fulfillmentOrders.edges || [])
      .map((e) => e.node)
      .filter((fo) => fo.status === 'OPEN' || fo.status === 'IN_PROGRESS')
      .map((fo) => fo.id),
  };
}

/** Replace any previous `sandoog:*` tag with the current status, and append a note line. */
async function syncSandoogStatus(order, eventType, extraNoteLine) {
  const keptTags = order.tags.filter((t) => !t.toLowerCase().startsWith('sandoog:'));
  const newTags = [...keptTags, `sandoog:${eventType}`];

  await graphql(
    `mutation SetTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
    }`,
    { id: order.id, tags: [`sandoog:${eventType}`] }
  );
  if (keptTags.length !== order.tags.length) {
    const oldSandoogTags = order.tags.filter((t) => t.toLowerCase().startsWith('sandoog:'));
    if (oldSandoogTags.length) {
      await graphql(
        `mutation RemoveTags($id: ID!, $tags: [String!]!) {
          tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
        }`,
        { id: order.id, tags: oldSandoogTags }
      );
    }
  }

  const line = `[Sandoog] ${new Date().toISOString()} ${eventType}${extraNoteLine ? ' — ' + extraNoteLine : ''}`;
  const note = order.note ? `${order.note}\n${line}` : line;
  await graphql(
    `mutation SetNote($input: OrderInput!) {
      orderUpdate(input: $input) { userErrors { field message } }
    }`,
    { input: { id: order.id, note } }
  );

  return newTags;
}

/** Mark all open fulfillment orders on this order as fulfilled (best-effort). */
async function fulfillOrder(order, { trackingNumber, trackingUrl } = {}) {
  if (!order.openFulfillmentOrderIds.length) {
    logger.info(`Order ${order.name} has no open fulfillment orders — nothing to fulfill`);
    return;
  }
  const fulfillment = {
    notifyCustomer: false,
    lineItemsByFulfillmentOrder: order.openFulfillmentOrderIds.map((id) => ({
      fulfillmentOrderId: id,
    })),
  };
  if (trackingNumber || trackingUrl) {
    fulfillment.trackingInfo = {
      number: trackingNumber,
      url: trackingUrl,
      company: 'Sandoog',
    };
  }
  const data = await graphql(
    `mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status }
        userErrors { field message }
      }
    }`,
    { fulfillment }
  );
  const errors = data.fulfillmentCreate.userErrors;
  if (errors && errors.length) {
    logger.warn(`fulfillmentCreate userErrors for ${order.name}:`, errors);
  }
}

module.exports = {
  getShopifyAccessToken,
  graphql,
  verifyShopifyWebhookHmac,
  findOrderByName,
  syncSandoogStatus,
  fulfillOrder,
};
