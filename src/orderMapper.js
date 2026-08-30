const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const GENERATED_MAP_PATH = path.join(__dirname, 'mapping', 'city-codes.json');
const SAMPLE_MAP_PATH = path.join(__dirname, 'mapping', 'cityCodes.sample.json');

function loadCityCodeMap() {
    const p = fs.existsSync(GENERATED_MAP_PATH) ? GENERATED_MAP_PATH : SAMPLE_MAP_PATH;
    try {
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          delete raw._comment;
          return raw;
    } catch (e) {
          logger.warn('Could not load city code map from', p, e.message);
          return {};
    }
}

function normalize(str) {
    return String(str || '').trim().toLowerCase();
}

/**
 * Iraqi Shopify addresses typically put a neighborhood/district in `city`
 * (e.g. "Zayona 710") and the actual governorate in `province` (e.g.
 * "Baghdad") — the city_code map only knows governorate-level names, so try
 * `city` first (in case it happens to be a governorate name) then fall back
 * to `province`.
 */
function resolveCityCode(city, province) {
    const map = loadCityCodeMap();
    for (const candidate of [city, province]) {
          const key = normalize(candidate);
          const code = key && map[key];
          if (code && code !== 'REPLACE_ME') return code;
    }
    logger.warn(
          `No Sandoog city_code mapped for city="${city}" / province="${province}". ` +
            'Run `npm run fetch-city-codes` and fill src/mapping/city-codes.json, ' +
            'or add it to cityCodes.sample.json. Falling back to raw city name.'
        );
    return city || province || '';
}

function resolveDeliveryRegion(city, province) {
    const cityKey = normalize(city);
    const provinceKey = normalize(province);
    const isCenter =
          config.mapping.centerCities.includes(cityKey) ||
          config.mapping.centerCities.includes(provinceKey);
    return isCenter ? 'Center' : 'County';
}

function isCashOnDelivery(shopifyOrder) {
    const names = [
          shopifyOrder.gateway,
          ...(shopifyOrder.payment_gateway_names || []),
        ]
      .filter(Boolean)
      .map((s) => s.toLowerCase());
    return names.some((n) => /cash|cod|delivery/.test(n));
}

/**
 * Map a Shopify "orders/create" webhook payload into the Sandoog POST /orders
 * request body. See https://developers.sandoog.net/reference/post_orders
 *
 * @param {object} shopifyOrder - raw Shopify order webhook payload
 * @returns {object} OrderPost body for Sandoog
 */
function mapShopifyOrderToSandoog(shopifyOrder) {
    if (!config.sandoog.entityId) {
          throw new Error('SANDOOG_ENTITY_ID is not set (check your .env)');
    }

  const addr = shopifyOrder.shipping_address || shopifyOrder.billing_address || {};
    const customer = shopifyOrder.customer || {};

  const name =
        [addr.name].filter(Boolean)[0] ||
        [addr.first_name, addr.last_name].filter(Boolean).join(' ') ||
        [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
        'Customer';

  const phone = addr.phone || customer.phone || shopifyOrder.phone || '';
    const city = addr.city || '';
    const province = addr.province || '';

  const deliveryItems = (shopifyOrder.line_items || []).map((li, idx) => ({
        id: li.id || idx + 1,
        name: li.title || li.name || `Item ${idx + 1}`,
        description: li.variant_title || '',
        quantity: li.quantity || 1,
  }));

  const totalPrice = Number(shopifyOrder.total_price || shopifyOrder.current_total_price || 0);
    const cod = isCashOnDelivery(shopifyOrder);

  const orderPost = {
        entity_id: config.sandoog.entityId,
        external_reference: String(shopifyOrder.name || shopifyOrder.order_number || shopifyOrder.id),
        notes: shopifyOrder.note || '',
        customer: {
                name,
                phone,
                state: resolveCityCode(city, province),
                email: customer.email || shopifyOrder.email || undefined,
                second_phone: undefined,
                address: [addr.address1, addr.address2].filter(Boolean).join(', ') || undefined,
                latitude: addr.latitude != null ? Number(addr.latitude) : undefined,
                longitude: addr.longitude != null ? Number(addr.longitude) : undefined,
        },
        delivery: {
                delivery_type: 'Standard',
                delivery_region: resolveDeliveryRegion(city, province),
                delivery_items: deliveryItems,
        },
        payment: {
                total_price: totalPrice,
                payment_charge_type: 'Customer',
                amount_include_delivery_charge: true,
                lines: [
                  {
                              type: cod ? 'Cash' : 'Card',
                              value: totalPrice,
                              currency: 'IraqDinar',
                              is_paid: !cod,
                  },
                        ],
        },
  };

  // Strip undefined optional fields so we don't send them at all.
  const prune = (obj) => {
        Object.keys(obj).forEach((k) => {
                if (obj[k] === undefined) delete obj[k];
                else if (obj[k] && typeof obj[k] === 'object' && !Array.isArray(obj[k])) prune(obj[k]);
        });
        return obj;
  };

  return prune(orderPost);
}

module.exports = {
    mapShopifyOrderToSandoog,
    resolveCityCode,
    resolveDeliveryRegion,
    isCashOnDelivery,
};
