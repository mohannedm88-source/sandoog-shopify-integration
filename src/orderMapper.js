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
    // Lowercase + trim, unify Arabic letter variants, drop diacritics, and strip
    // "governorate"/"محافظة" wrappers and the Arabic "ال" prefix so that e.g.
    // "محافظة أربيل", "اربيل" and "Erbil Governorate" all match the same key.
    let s = String(str || '').trim().toLowerCase();
    s = s.replace(/[ً-ٰٟـ]/g, '');
    s = s.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
    s = s.replace(/^(محافظه|محافضه)\s+/, '');
    s = s.replace(/\s+(governorate|province|gov\.?)$/, '').replace(/^(governorate|province)\s+of\s+/, '');
    s = s.replace(/^ال(?=\S)/, '');
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Iraqi Shopify addresses typically put a neighborhood/district in `city`
 * (e.g. "Zayona 710") and the actual governorate in `province` (e.g.
 * "Baghdad") — the city_code map only knows governorate-level names, so try
 * `city` first (in case it happens to be a governorate name) then fall back
 * to `province`.
 */
function resolveCityCode(city, province) {
    const raw = loadCityCodeMap();
    const map = {};
    for (const [k, v] of Object.entries(raw)) map[normalize(k)] = v;
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

function lookupCityCode(candidate) {
    const raw = loadCityCodeMap();
    const key = normalize(candidate);
    if (!key) return null;
    for (const [k, v] of Object.entries(raw)) {
        if (normalize(k) === key && v && v !== 'REPLACE_ME') return v;
    }
    return null;
}

function resolveDeliveryRegion(city, province) {
    const centerList = config.mapping.centerCities.map(normalize);
    const cityKey = normalize(city);
    const provinceKey = normalize(province);
    const isCenter =
          centerList.includes(cityKey) ||
          centerList.includes(provinceKey);
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

  const rawPhone = addr.phone || customer.phone || shopifyOrder.phone || '';
  // Sandoog adds its own leading 0 to the phone, so send the Iraqi local format (07xxxxxxxxx) instead of +964...
  let phoneDigits = String(rawPhone).replace(/\D/g, '');
  if (phoneDigits.startsWith('00964')) phoneDigits = phoneDigits.slice(5);
  else if (phoneDigits.startsWith('964')) phoneDigits = phoneDigits.slice(3);
  if (phoneDigits.length === 10 && phoneDigits.startsWith('7')) phoneDigits = '0' + phoneDigits;
  const phone = phoneDigits || rawPhone;
    const city = addr.city || '';
    const province = addr.province || '';

  const deliveryItems = (shopifyOrder.line_items || []).map((li, idx) => ({
        id: idx + 1, // Sandoog's API rejects a delivery_items[].id this large (real Shopify line-item ids overflow it) - use a small per-order sequential id instead
        name: li.title || li.name || `Item ${idx + 1}`,
description: [li.variant_title, li.sku ? ('SKU: ' + li.sku) : ''].filter(Boolean).join(' | '),
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
    lookupCityCode,
    resolveDeliveryRegion,
    isCashOnDelivery,
};
