const sandoog = require('./sandoogClient');
const logger = require('./logger');

// Sandoog's production account validates every delivery item against the
// warehouse product catalogue, so delivery_items[].id must be the Sandoog
// product id (not a Shopify id). We look the product up by SKU.
// Shopify SKUs and Sandoog SKUs can differ only by spaces/case
// (e.g. "4320-26-Tiger L/XL" vs "4320-26-TigerL/XL"), so compare normalised.

function normSku(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function findProduct(node, want) {
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findProduct(n, want);
      if (r) return r;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const skuKey = Object.keys(node).find((k) => /sku/i.test(k) && typeof node[k] === 'string');
    if (skuKey && normSku(node[skuKey]) === want) return node;
    for (const k of Object.keys(node)) {
      const r = findProduct(node[k], want);
      if (r) return r;
    }
  }
  return null;
}

async function resolveSandoogProductIds(orderPost, shopifyOrder) {
  const lines = shopifyOrder.line_items || [];
  const items = orderPost.delivery.delivery_items;
  for (let i = 0; i < items.length; i++) {
    const rawSku = (lines[i] && lines[i].sku) || '';
    if (!rawSku) {
      throw new Error('Shopify line item "' + items[i].name + '" has no SKU');
    }
    const want = normSku(rawSku);
    const attempts = [
      { sku: rawSku },
      { sku: rawSku.replace(/\s+/g, '') },
      { query: rawSku.replace(/\s+/g, '') },
    ];
    let match = null;
    for (const a of attempts) {
      const data = await sandoog.searchProducts(Object.assign({ page_number: 0, page_size: 20 }, a));
      logger.info('Sandoog product search ' + JSON.stringify(a) + ' -> ' + JSON.stringify(data).slice(0, 1500));
      match = findProduct(data, want);
      if (match) break;
    }
    if (!match) {
      throw new Error('No Sandoog product found for SKU "' + rawSku + '"');
    }
    const idKey = ['id', 'product_id', 'productId'].find((k) => match[k] != null);
    if (!idKey) {
      throw new Error('Sandoog product for SKU "' + rawSku + '" has no id field: ' + JSON.stringify(match));
    }
    items[i].id = Number(match[idKey]);
    logger.info('SKU "' + rawSku + '" -> Sandoog product id ' + items[i].id);
  }
  return orderPost;
}

module.exports = { resolveSandoogProductIds, normSku, findProduct };
