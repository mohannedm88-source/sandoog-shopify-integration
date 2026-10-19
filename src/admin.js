const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const sandoog = require('./sandoogClient');
const shopify = require('./shopifyClient');
const { mapShopifyOrderToSandoog, lookupCityCode } = require('./orderMapper');
const { resolveSandoogProductIds } = require('./productResolver');

// Manual-review dashboard: lists recent Shopify orders, lets the operator fix
// the governorate / phone / address, then sends the order to Sandoog.
// State lives in Shopify itself (order tag "sandoog-sent"), so nothing is lost
// when the free Render instance restarts.

const SENT_TAG = 'sandoog-sent';
const PAGE_PATH = path.join(__dirname, 'adminPage.html');

// Sandoog's governorate codes (Arabic labels for the dropdown).
const CITIES = [
  ['baghdad', 'بغداد'], ['arbeel', 'أربيل'], ['basra', 'البصرة'], ['mosul', 'نينوى (الموصل)'],
  ['dihok', 'دهوك'], ['solaimania', 'السليمانية'], ['karkok', 'كركوك'], ['najaf', 'النجف'],
  ['karbala', 'كربلاء'], ['babel', 'بابل'], ['anbar', 'الأنبار'], ['diyala', 'ديالى'],
  ['saladin', 'صلاح الدين'], ['koot', 'واسط (الكوت)'], ['diwania', 'القادسية (الديوانية)'],
  ['simawa', 'المثنى (السماوة)'], ['zeeqar', 'ذي قار'], ['maysan', 'ميسان'],
].map(([code, label]) => ({ code, label }));
const CITY_CODES = new Set(CITIES.map((c) => c.code));

// Orders created before this moment are ignored by the dashboard (they were
// handled before the integration existed). Override with ADMIN_FROM_DATE.
function fromDate() {
  return process.env.ADMIN_FROM_DATE || '2026-10-18T14:00:00Z';
}

function centers() {
  return (config.mapping.centerCities || []).map((s) => String(s).trim().toLowerCase());
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

function auth(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return res.status(503).send('ADMIN_PASSWORD is not set on the server yet.');
  const m = (req.get('authorization') || '').match(/^Basic (.+)$/i);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (crypto.timingSafeEqual(sha(given), sha(pw))) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Sandoog integration", charset="UTF-8"');
  return res.status(401).send('Authentication required');
}

// Best-effort governorate guess: exact city/province match first, then any
// single word of the city/address that is a known governorate/city alias.
function guessCity(city, province, address1, address2) {
  for (const c of [city, province, address1, address2]) {
    const code = lookupCityCode(c);
    if (code && CITY_CODES.has(code)) return { code, how: 'exact' };
  }
  const words = [city, province, address1, address2]
    .filter(Boolean)
    .join(' ')
    .split(/[\s,.،؛:;/\\\-_()]+/)
    .filter((w) => w.length > 2);
  for (const w of words) {
    const code = lookupCityCode(w);
    if (code && CITY_CODES.has(code)) return { code, how: 'guess' };
  }
  return { code: '', how: '' };
}

function statusOf(o) {
  const tags = o.tags || [];
  const sandoogStatusTag = tags.find((t) => /^sandoog:/i.test(t));
  if (tags.includes(SENT_TAG) || sandoogStatusTag) {
    return { status: 'sent', sandoogStatus: sandoogStatusTag ? sandoogStatusTag.slice(8) : '' };
  }
  if (o.cancelledAt) return { status: 'cancelled', sandoogStatus: '' };
  return { status: 'pending', sandoogStatus: '' };
}

const ORDERS_QUERY = `query ($first: Int!, $q: String) {
  orders(first: $first, sortKey: CREATED_AT, reverse: true, query: $q) {
    nodes {
      id name createdAt cancelledAt tags note
      email phone paymentGatewayNames
      totalPriceSet { shopMoney { amount currencyCode } }
      shippingAddress { name phone city province address1 address2 }
      lineItems(first: 30) { nodes { title variantTitle sku quantity } }
    }
  }
}`;

function shape(o) {
  const a = o.shippingAddress || {};
  const g = guessCity(a.city, a.province, a.address1, a.address2);
  const st = statusOf(o);
  const cod = (o.paymentGatewayNames || []).some((n) => /cash|cod|delivery/i.test(n));
  const region = g.code ? (centers().includes(g.code) ? 'Center' : 'County') : 'County';
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    status: st.status,
    sandoogStatus: st.sandoogStatus,
    customer: a.name || '',
    phone: a.phone || o.phone || '',
    city: a.city || '',
    province: a.province || '',
    address: [a.address1, a.address2].filter(Boolean).join(', '),
    cityCode: g.code,
    cityGuess: g.how,
    region,
    items: ((o.lineItems && o.lineItems.nodes) || []).map((l) => ({
      title: l.title, variant: l.variantTitle || '', sku: l.sku || '', qty: l.quantity,
    })),
    total: o.totalPriceSet ? o.totalPriceSet.shopMoney.amount : '',
    currency: o.totalPriceSet ? o.totalPriceSet.shopMoney.currencyCode : '',
    cod,
    note: o.note || '',
  };
}

const sending = new Set();

function errText(err) {
  if (err && err.response && err.response.data) {
    const d = err.response.data;
    const msg = d.message || d.Message || (typeof d === 'string' ? d : JSON.stringify(d));
    return `Sandoog (HTTP ${err.response.status}): ${msg}`;
  }
  return (err && err.message) || String(err);
}

function mount(app) {
  const json = express.json({ limit: '100kb' });

  app.get('/admin', auth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(fs.readFileSync(PAGE_PATH, 'utf8'));
  });

  app.get('/admin/api/orders', auth, async (_req, res) => {
    try {
      const q = `created_at:>=${fromDate()}`;
      const data = await shopify.graphql(ORDERS_QUERY, { first: 60, q });
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, cities: CITIES, from: fromDate(), orders: data.orders.nodes.map(shape) });
    } catch (err) {
      logger.error('Admin: could not load Shopify orders', err.response ? err.response.data : err.message);
      res.status(500).json({ ok: false, error: 'Could not read orders from Shopify: ' + errText(err) });
    }
  });

  app.post('/admin/api/send', auth, json, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const code = String(b.city || '').trim();
    const phone = String(b.phone || '').trim();
    const address = String(b.address || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Missing order name' });
    if (!CITY_CODES.has(code)) return res.status(400).json({ ok: false, error: 'اختر المحافظة من القائمة' });
    if (!phone) return res.status(400).json({ ok: false, error: 'رقم الهاتف فارغ' });
    if (sending.has(name)) return res.status(409).json({ ok: false, error: 'هذا الطلب قيد الإرسال الآن' });
    sending.add(name);
    try {
      const found = await shopify.graphql(
        'query ($q: String!) { orders(first: 1, query: $q) { nodes { id name tags note cancelledAt } } }',
        { q: 'name:' + name }
      );
      const node = found.orders.nodes[0];
      if (!node || node.name !== name) return res.status(404).json({ ok: false, error: 'الطلب غير موجود في Shopify' });
      if (node.cancelledAt) return res.status(409).json({ ok: false, error: 'الطلب ملغي في Shopify' });
      if (statusOf(node).status === 'sent') return res.status(409).json({ ok: false, error: 'هذا الطلب أُرسل سابقاً' });

      const rest = await shopify.getOrderRestByName(name);
      if (!rest) return res.status(404).json({ ok: false, error: 'تعذر تحميل تفاصيل الطلب من Shopify' });

      const base = rest.shipping_address || rest.billing_address || {};
      rest.shipping_address = Object.assign({}, base, {
        phone,
        address1: address || base.address1 || '',
        address2: address ? '' : base.address2 || '',
      });

      const orderPost = mapShopifyOrderToSandoog(rest);
      orderPost.customer.state = code;
      orderPost.delivery.delivery_region = b.region === 'Center' || b.region === 'County'
        ? b.region
        : (centers().includes(code) ? 'Center' : 'County');
      await resolveSandoogProductIds(orderPost, rest);

      logger.info('Admin: sending Sandoog order for Shopify order ' + name + ': ' + JSON.stringify(orderPost));
      const result = await sandoog.createOrder(orderPost);
      logger.info('Sandoog accepted order ' + name + ' (manual send)', result);

      const sandoogId = typeof result === 'string' ? result : ((result && (result.id || (result.data && (result.data.id || result.data)))) || '');
      const sandoogIdText = typeof sandoogId === 'string' ? sandoogId : JSON.stringify(sandoogId);
      try {
        await shopify.graphql(
          'mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }',
          { id: node.id, tags: [SENT_TAG] }
        );
        const line = `[Sandoog] ${new Date().toISOString()} sent manually ${sandoogIdText}`.trim();
        await shopify.graphql(
          'mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }',
          { input: { id: node.id, note: node.note ? node.note + '\n' + line : line } }
        );
      } catch (tagErr) {
        logger.error('Order ' + name + ' was sent to Sandoog but tagging it in Shopify failed', tagErr.message);
        return res.json({ ok: true, sandoogId: sandoogIdText, warning: 'أُرسل إلى صندوق لكن تعذر وسمه في Shopify - لا تعد الإرسال' });
      }
      return res.json({ ok: true, sandoogId: sandoogIdText });
    } catch (err) {
      logger.error('Admin: failed to send order ' + name, err.response ? err.response.data : err.message);
      return res.status(500).json({ ok: false, error: errText(err) });
    } finally {
      sending.delete(name);
    }
  });
}

module.exports = { mount, guessCity, CITIES };
