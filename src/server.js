const express = require('express');
const config = require('./config');
const logger = require('./logger');
const sandoog = require('./sandoogClient');
const shopify = require('./shopifyClient');
const { mapShopifyOrderToSandoog } = require('./orderMapper');

const app = express();

// Terminal statuses where we mark the Shopify order as fulfilled.
const FULFILLED_EVENT_TYPES = new Set(['Delivered', 'Complete']);

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * One-time setup helper: tells Sandoog where to POST order status updates.
 * Safe to call more than once (it just re-registers the same URL). Needs no
 * secret from the caller — it uses this service's own configured
 * SANDOOG_API_KEY / SANDOOG_CALLBACK_SECRET / PUBLIC_BASE_URL.
 * Remove this route once the webhook is confirmed registered.
 */
app.get('/setup/register-sandoog-webhook', async (_req, res) => {
  try {
    if (!config.service.publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL is not set');
    }
    if (!config.sandoog.callbackSecret) {
      throw new Error('SANDOOG_CALLBACK_SECRET is not set');
    }
    const orderUrl = `${config.service.publicBaseUrl.replace(/\/$/, '')}/webhooks/sandoog/order-status`;
    const result = await sandoog.registerWebhook({
      callbackKey: config.sandoog.callbackSecret,
      orderUrl,
    });
    logger.info(`Registered Sandoog webhook -> ${orderUrl}`, result);
    res.json({ ok: true, orderUrl, result });
  } catch (err) {
    const detail = err.response ? err.response.data : err.message;
    logger.error('register-sandoog-webhook failed', detail);
    res.status(500).json({ ok: false, error: detail });
  }
});

/**
 * Shopify -> this service: fired on `orders/create`.
 * Needs the RAW body to verify Shopify's HMAC signature, so this route uses
 * express.raw() instead of the global json() parser.
 */
app.post(
  '/webhooks/shopify/orders-create',
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const valid = shopify.verifyShopifyWebhookHmac(req.body, hmac);
    if (!valid) {
      logger.warn('Rejected Shopify webhook: invalid HMAC');
      return res.status(401).send('invalid signature');
    }

    // Ack fast — Shopify expects a 2xx within a few seconds and will retry
    // (with the same payload) if it doesn't get one.
    res.status(200).send('ok');

    let shopifyOrder;
    try {
      shopifyOrder = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      logger.error('Could not parse Shopify webhook body', e);
      return;
    }

    try {
      const orderPost = mapShopifyOrderToSandoog(shopifyOrder);
      logger.info(`Creating Sandoog order for Shopify order ${shopifyOrder.name}`, orderPost);
      const result = await sandoog.createOrder(orderPost);
      logger.info(`Sandoog accepted order ${shopifyOrder.name}`, result);
    } catch (err) {
      logger.error(
        `Failed to create Sandoog order for Shopify order ${shopifyOrder && shopifyOrder.name}`,
        err.response ? err.response.data : err.message
      );
      // TODO: push to a retry queue / alert channel instead of just logging.
    }
  }
);

/**
 * Sandoog -> this service: order status callbacks.
 * https://developers.sandoog.net/docs/webhooks-response-1
 * Verified via the `secret-key` header, which must equal the callback_key we
 * registered with POST /webhooks-register-urls (see scripts/register-sandoog-webhook.js).
 */
app.post(
  '/webhooks/sandoog/order-status',
  express.json({ limit: '2mb' }),
  async (req, res) => {
    const secret = req.get('secret-key');
    if (!config.sandoog.callbackSecret || secret !== config.sandoog.callbackSecret) {
      logger.warn('Rejected Sandoog webhook: bad or missing secret-key header');
      return res.status(401).send('invalid secret');
    }

    res.status(200).send('ok');

    const { event_type: eventType, external_reference: externalReference, event_data: eventData } =
      req.body || {};
    logger.info(`Sandoog status update: ${eventType} for order ${externalReference}`, eventData);

    if (!externalReference) {
      logger.warn('Sandoog callback missing external_reference — cannot map to a Shopify order');
      return;
    }

    try {
      const order = await shopify.findOrderByName(externalReference);
      if (!order) {
        logger.warn(`No Shopify order found matching external_reference "${externalReference}"`);
        return;
      }

      const driverNote = eventData && eventData.driver_data
        ? `driver: ${eventData.driver_data.driver_name || ''} ${eventData.driver_data.driver_phone || ''}`.trim()
        : undefined;

      await shopify.syncSandoogStatus(order, eventType, driverNote);

      if (FULFILLED_EVENT_TYPES.has(eventType)) {
        await shopify.fulfillOrder(order);
      }
    } catch (err) {
      logger.error(
        `Failed to sync Sandoog status "${eventType}" for ${externalReference} into Shopify`,
        err.response ? err.response.data : err.message
      );
    }
  }
);

app.listen(config.service.port, () => {
  logger.info(`sandoog-shopify-integration listening on port ${config.service.port}`);
  logger.info(`  Shopify orders webhook:  POST /webhooks/shopify/orders-create`);
  logger.info(`  Sandoog status webhook:  POST /webhooks/sandoog/order-status`);
});
