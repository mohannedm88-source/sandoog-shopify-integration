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

// Total available stock across warehouses, or null when Sandoog did not tell us.
function availableOf(match) {
  const wp = match && match.warehouse_products;
  if (Array.isArray(wp) && wp.length) {
    let total = 0;
    let seen = false;
    for (const w of wp) {
      const q = Number(w && w.available_quantity);
      if (Number.isFinite(q)) { total += q; seen = true; }
    }
    if (seen) return total;
  }
  const q = Number(match && match.available_quantity);
  return Number.isFinite(q) ? q : null;
}

function describeProblem(p) {
  if (p.kind === 'nosku') return 'بدون SKU: ' + (p.title || '');
  if (p.kind === 'missing') return 'غير موجود في صندوق: ' + p.sku;
  return 'غير متوفر: ' + p.sku + ' (المتاح ' + p.available + '، المطلوب ' + p.needed + ')';
}

// Resolves every delivery item to its Sandoog product id. Instead of stopping at the first bad item it checks all of
// them and throws ONE error (err.problems = [{kind: nosku|missing|stock, sku, title, needed, available}]) so the admin
// page can show every unavailable product together.
async function resolveSandoogProductIds(orderPost, shopifyOrder) {
  const lines = shopifyOrder.line_items || [];
  const items = orderPost.delivery.delivery_items;
  const problems = [];
  const need = new Map();
  for (let i = 0; i < items.length; i++) {
    const rawSku = (lines[i] && lines[i].sku) || '';
    if (!rawSku) {
      problems.push({ kind: 'nosku', title: items[i].name });
      continue;
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
      problems.push({ kind: 'missing', sku: rawSku, title: items[i].name });
      continue;
    }
    const idKey = ['id', 'product_id', 'productId'].find((k) => match[k] != null);
    if (!idKey) {
      throw new Error('Sandoog product for SKU "' + rawSku + '" has no id field: ' + JSON.stringify(match));
    }
    items[i].id = Number(match[idKey]);
    const skuKey = Object.keys(match).find((key) => /sku/i.test(key) && typeof match[key] === 'string');
    items[i].sku = skuKey ? match[skuKey] : rawSku;
    logger.info('SKU "' + rawSku + '" -> Sandoog product id ' + items[i].id);
    const key = normSku(items[i].sku);
    const cur = need.get(key) || { sku: items[i].sku, title: items[i].name, needed: 0, available: availableOf(match) };
    cur.needed += Number(items[i].quantity) || 1;
    need.set(key, cur);
  }
  for (const n of need.values()) {
    if (n.available !== null && n.available < n.needed) problems.push({ kind: 'stock', sku: n.sku, title: n.title, needed: n.needed, available: n.available });
  }
  if (problems.length) {
    const e = new Error('منتجات غير متوفرة أو غير موجودة في صندوق (' + problems.length + '): ' + problems.map(describeProblem).join(' ؛ '));
    e.problems = problems;
    throw e;
  }
  return orderPost;
}

module.exports = { resolveSandoogProductIds, normSku, findProduct };
