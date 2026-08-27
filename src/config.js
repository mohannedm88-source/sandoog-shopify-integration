require('dotenv').config();

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    // Don't throw at import time for every field — only the ones the
    // currently-running entrypoint actually needs will complain loudly
    // (see server.js / scripts/*). This keeps `--help`-style usage easy.
    return undefined;
  }
  return value;
}

module.exports = {
  sandoog: {
    baseUrl: required('SANDOOG_BASE_URL', 'https://iq.api.sandbox.sandoog.net'),
    apiKey: required('SANDOOG_API_KEY'),
    entityId: required('SANDOOG_ENTITY_ID'),
    callbackSecret: required('SANDOOG_CALLBACK_SECRET'),
  },
  shopify: {
    shopDomain: required('SHOPIFY_SHOP_DOMAIN', 'irq.zorita.com'),
    // Dev Dashboard app credentials (legacy "custom apps" from Shopify admin
    // can no longer be created as of Jan 1 2026 — see README). The client
    // secret doubles as the webhook-HMAC signing key, so there's no separate
    // SHOPIFY_WEBHOOK_SECRET.
    clientId: required('SHOPIFY_CLIENT_ID'),
    clientSecret: required('SHOPIFY_CLIENT_SECRET'),
    apiVersion: required('SHOPIFY_API_VERSION', '2024-10'),
  },
  service: {
    port: Number(required('PORT', '3000')),
    publicBaseUrl: required('PUBLIC_BASE_URL'),
  },
  mapping: {
    centerCities: (required('SANDOOG_CENTER_CITIES', 'Baghdad,بغداد') || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  },
};
