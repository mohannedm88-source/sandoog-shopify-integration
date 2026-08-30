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
 * TEMPORARY diagnostic route — isolates why POST /orders returns
 * "Failed to post order." for otherwise-valid-looking payloads. Tries a few
 * payload variants against the real Sandoog sandbox (from Render's network,
 * since the API is not reachable from every environment) and reports which
 * ones succeed/fail with full response bodies. Remove once the real cause is
 * found and fixed.
 */
app.get('/setup/debug-test-order', async (_req, res) => {
              const variants = [];

          const base = {
                          entity_id: config.sandoog.entityId,
                          external_reference: 'DEBUGTEST-' + Date.now(),
                          notes: '',
                          customer: {
                                            name: 'Test Claude',
                                            phone: '+9647737583579',
                                            state: 'baghdad',
                                            address: 'Baghdad, Karrada street 12',
                          },
                          delivery: {
                                            delivery_type: 'Standard',
                                            delivery_region: 'Center',
                                            delivery_items: [{ id: 1, name: 'Test Item', description: '', quantity: 1 }],
                          },
                          payment: {
                                            total_price: 24000,
                                            payment_charge_type: 'Customer',
                                            amount_include_delivery_charge: true,
                                            lines: [{ type: 'Cash', value: 24000, currency: 'IraqDinar', is_paid: false }],
                          },
          };

          variants.push(['baseline (current payload shape)', base]);
              variants.push([
                              'local phone format (07...)',
                          { ...base, external_reference: 'DEBUGTEST-phone-' + Date.now(), customer: { ...base.customer, phone: '07737583579' } },
                            ]);
              variants.push([
                              'without amount_include_delivery_charge',
                          {
                                            ...base,
                                            external_reference: 'DEBUGTEST-noflag-' + Date.now(),
                                            payment: {
                                                                total_price: 24000,
                                                                payment_charge_type: 'Customer',
                                                                lines: [{ type: 'Cash', value: 24000, currency: 'IraqDinar', is_paid: false }],
                                            },
                          },
                            ]);
              variants.push([
                              'Card payment, is_paid true',
                          {
                                            ...base,
                                            external_reference: 'DEBUGTEST-card-' + Date.now(),
                                            payment: {
                                                                total_price: 24000,
                                                                payment_charge_type: 'Customer',
                                                                amount_include_delivery_charge: true,
                                                                lines: [{ type: 'Card', value: 24000, currency: 'IraqDinar', is_paid: true }],
                                            },
                          },
                            ]);
              variants.push([
                              'Merchant payment_charge_type',
                          { ...base, external_reference: 'DEBUGTEST-merchant-' + Date.now(), payment: { ...base.payment, payment_charge_type: 'Merchant' } },
                            ]);
              variants.push([
                              'no email/second_phone/lat/lng keys at all (already true for base, explicit minimal customer)',
                          {
                                            ...base,
                                            external_reference: 'DEBUGTEST-mincust-' + Date.now(),
                                            customer: { name: 'Test Claude', phone: '+9647737583579', state: 'baghdad' },
                          },
                            ]);
              variants.push([
                              'County region instead of Center',
                          { ...base, external_reference: 'DEBUGTEST-county-' + Date.now(), delivery: { ...base.delivery, delivery_region: 'County' } },
                            ]);
              variants.push([
                              'phone WITH spaces, like Shopify displays it (+964 773 758 3579)',
                          { ...base, external_reference: 'DEBUGTEST-phonespace-' + Date.now(), customer: { ...base.customer, phone: '+964 773 758 3579' } },
                            ]);
              variants.push([
                              'address same as city only (no street) — mimics a minimal real order',
                          { ...base, external_reference: 'DEBUGTEST-minaddr-' + Date.now(), customer: { ...base.customer, address: 'Baghdad' } },
                            ]);
              variants.push([
                              'real Q1358-like: name "Moh mOGH", card/is_paid true, address "Baghdad" only, phone with spaces',
                          {
                                            ...base,
                                            external_reference: 'DEBUGTEST-q1358like-' + Date.now(),
                                            customer: { name: 'Moh mOGH', phone: '+964 773 758 3579', state: 'baghdad', address: 'Baghdad' },
                                            payment: {
                                                                total_price: 24000,
                                                                payment_charge_type: 'Customer',
                                                                amount_include_delivery_charge: true,
                                                                lines: [{ type: 'Card', value: 24000, currency: 'IraqDinar', is_paid: true }],
                                            },
                          },
                            ]);

          const results = [];
              for (const [label, payload] of variants) {
                              try {
                                                const result = await sandoog.createOrder(payload);
                                                results.push({ label, ok: true, result });
                              } catch (err) {
                                                results.push({
                                                                    label,
                                                                    ok: false,
                                                                    status: err.response ? err.response.status : null,
                                                                    data: err.response ? err.response.data : err.message,
                                                });
                              }
              }

          res.json({ entity_id: config.sandoog.entityId, results });
});

/**
 * TEMPORARY diagnostic route — fetch a REAL Shopify order (REST shape, same
 * as the orders/create webhook), map it with the actual mapShopifyOrderToSandoog,
 * and try posting it to Sandoog. Returns the mapped payload plus the
 * success/error result so we can see exactly what differs from the synthetic
 * debug-test-order payloads (which all succeeded). Remove once fixed.
 */
app.get('/setup/debug-real-order/:name', async (req, res) => {
              try {
                              const shopifyOrder = await shopify.getOrderRestByName(req.params.name);
                              if (!shopifyOrder) {
                                                return res.status(404).json({ error: `No Shopify order found for name "${req.params.name}"` });
                              }
                              const orderPost = mapShopifyOrderToSandoog(shopifyOrder);
                              try {
                                                const result = await sandoog.createOrder(orderPost);
                                                res.json({ ok: true, orderPost, result });
                              } catch (err) {
                                                res.json({
                                                                    ok: false,
                                                                    orderPost,
                                                                    status: err.response ? err.response.status : null,
                                                                    data: err.response ? err.response.data : err.message,
                                                });
                              }
              } catch (err) {
                              res.status(500).json({
                                                error: 'debug route failed',
                                                status: err.response ? err.response.status : null,
                                                data: err.response ? err.response.data : err.message,
                              });
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
                                                      `Failed to create Sandoog order for Shopify order ${shopifyOrder && shopifyOrder.name}` +
                                                        (err.response ? ` (HTTP ${err.response.status})` : ''),
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
