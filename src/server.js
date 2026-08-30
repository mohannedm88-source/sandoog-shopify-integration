const express = require('express');
const config = require('./config');
const logger = require('./logger');
const sandoog = require('./sandoogClient');
const shopify = require('./shopifyClient');
const { mapShopifyOrderToSandoog } = require('./orderMapper');

const app = express();

const FULFILLED_EVENT_TYPES = new Set(['Delivered', 'Complete']);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Guards against duplicate/concurrent Shopify webhook deliveries for the
// same order. Shopify uses "at least once" delivery: the same orders/create
// event can (and does) arrive more than once, sometimes within
// milliseconds of each other. Observed directly for order Q1358: two
// orders/create deliveries landed about 113ms apart, and BOTH then failed
// against Sandoog's POST /orders about 14 seconds later with a generic
// "Failed to post order." (HTTP 500), most likely because Sandoog's
// backend can't cleanly handle two concurrent requests carrying the same
// external_reference. Every payload shape we could construct (including
// one built from Q1358's real customer/phone/address data) posted
// successfully on its own, which points at this race rather than the
// payload itself.
//
// This in-memory map only lives for the life of this process (it resets
// on every deploy/restart/free-tier spin-down), which is fine: its job is
// to absorb near-simultaneous duplicate deliveries, not to be a durable
// ledger. orderName -> 'pending' | 'done'
const sandoogOrderState = new Map();

// Shopify -> this service: fired on orders/create. Needs the RAW body to
// verify Shopify's HMAC signature, so this route uses express.raw()
// instead of the global json() parser.
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

      res.status(200).send('ok');

      let shopifyOrder;
          try {
                  shopifyOrder = JSON.parse(req.body.toString('utf8'));
          } catch (e) {
                  logger.error('Could not parse Shopify webhook body', e);
                  return;
          }

      const orderName = shopifyOrder.name || String(shopifyOrder.order_number || shopifyOrder.id);
          const existingState = sandoogOrderState.get(orderName);
          if (existingState) {
                  logger.warn('Skipping duplicate Shopify webhook delivery for order ' + orderName + ' (already ' + existingState + ')');
                  return;
          }
          sandoogOrderState.set(orderName, 'pending');

      try {
              const orderPost = mapShopifyOrderToSandoog(shopifyOrder);
              logger.info('Creating Sandoog order for Shopify order ' + orderName, orderPost);
              const result = await sandoog.createOrder(orderPost);
              logger.info('Sandoog accepted order ' + orderName, result);
              sandoogOrderState.set(orderName, 'done');
      } catch (err) {
              sandoogOrderState.delete(orderName);
              logger.error(
                        'Failed to create Sandoog order for Shopify order ' + orderName + (err.response ? (' (HTTP ' + err.response.status + ')') : ''),
                        err.response ? err.response.data : err.message
                      );
      }
    }
  );

// Sandoog -> this service: order status callbacks.
// https://developers.sandoog.net/docs/webhooks-response-1
// Verified via the secret-key header, which must equal the callback_key
// we registered with POST /webhooks-register-urls (see
// scripts/register-sandoog-webhook.js).
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

      const eventType = (req.body || {}).event_type;
          const externalReference = (req.body || {}).external_reference;
          const eventData = (req.body || {}).event_data;
          logger.info('Sandoog status update: ' + eventType + ' for order ' + externalReference, eventData);

      if (!externalReference) {
              logger.warn('Sandoog callback missing external_reference, cannot map to a Shopify order');
              return;
      }

      try {
              const order = await shopify.findOrderByName(externalReference);
              if (!order) {
                        logger.warn('No Shopify order found matching external_reference "' + externalReference + '"');
                        return;
              }

            const driverNote = eventData && eventData.driver_data
                ? ('driver: ' + (eventData.driver_data.driver_name || '') + ' ' + (eventData.driver_data.driver_phone || '')).trim()
                      : undefined;

            await shopify.syncSandoogStatus(order, eventType, driverNote);

            if (FULFILLED_EVENT_TYPES.has(eventType)) {
                      await shopify.fulfillOrder(order);
            }
      } catch (err) {
              logger.error(
                        'Failed to sync Sandoog status "' + eventType + '" for ' + externalReference + ' into Shopify',
                        err.response ? err.response.data : err.message
                      );
      }
    }
  );

app.listen(config.service.port, () => {
    logger.info('sandoog-shopify-integration listening on port ' + config.service.port);
    logger.info('  Shopify orders webhook:  POST /webhooks/shopify/orders-create');
    logger.info('  Sandoog status webhook:  POST /webhooks/sandoog/order-status');
});
