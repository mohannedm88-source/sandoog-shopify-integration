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
          // can no longer be created as of Jan 1 2026 — see README).
          clientId: required('SHOPIFY_CLIENT_ID'),
          clientSecret: required('SHOPIFY_CLIENT_SECRET'),
          // The orders/create webhook was registered via Settings -> Notifications
          // -> Webhooks (the Admin API's webhookSubscriptionCreate mutation is
          // blocked for this app), and THAT kind of webhook is HMAC-signed with the
          // per-store secret shown on that same settings page — a different value
          // from the app's Client secret. If a future webhook is instead created
          // via the Admin API/app config, it would use the Client secret and this
          // var can be left unset (verifyShopifyWebhookHmac falls back to it).
          webhookSecret: required('SHOPIFY_WEBHOOK_SECRET'),
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
