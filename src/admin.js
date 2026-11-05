const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const sandoog = require('./sandoogClient');
const shopify = require('./shopifyClient');
const { mapShopifyOrderToSandoog, lookupCityCode } = require('./orderMapper');
const { resolveSandoogProductIds, normSku } = require('./productResolver');

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
  return process.env.ADMIN_FROM_DATE || '2026-10-04T09:00:00Z';
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

// Exchange / return orders created from the dashboard are recorded on the original order as tags.
function exchangeOf(o) {
  const tags = o.tags || [];
  const kinds = [];
  if (tags.includes('sandoog-exchange')) kinds.push('exchange');
  if (tags.includes('sandoog-return')) kinds.push('return');
  if (tags.includes('sandoog-resent')) kinds.push('resend');
  const st = tags.find((t) => /^sandoog-ex:/i.test(t));
  return { kinds, status: st ? st.slice(11) : '' };
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
      email phone paymentGatewayNames displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }
      shippingAddress { name phone city province address1 address2 }
      lineItems(first: 30) { nodes { title variantTitle sku quantity currentQuantity } }
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
    fulfillment: o.displayFulfillmentStatus || '',
    customer: a.name || '',
    phone: a.phone || o.phone || '',
    city: a.city || '',
    province: a.province || '',
    address: [a.address1, a.address2].filter(Boolean).join(', '),
    cityCode: g.code,
    cityGuess: g.how,
    region,
    exchange: exchangeOf(o),
    items: ((o.lineItems && o.lineItems.nodes) || [])
      .filter((l) => typeof l.currentQuantity !== 'number' || l.currentQuantity > 0)
      .map((l) => ({
      title: l.title, variant: l.variantTitle || '', sku: l.sku || '', qty: typeof l.currentQuantity === 'number' ? l.currentQuantity : l.quantity,
    })),
    total: o.totalPriceSet ? (o.totalPriceSet.presentmentMoney || o.totalPriceSet.shopMoney).amount : '',
    currency: o.totalPriceSet ? (o.totalPriceSet.presentmentMoney || o.totalPriceSet.shopMoney).currencyCode : '',
    cod,
    note: o.note || '',
  };
}

// Mark every open fulfillment order of a Shopify order as Fulfilled (no customer email).
// Needs the write_merchant_managed_fulfillment_orders scope.
async function fulfillSentOrder(orderGid, orderName) {
  const data = await shopify.graphql(
    'query ($id: ID!) { order(id: $id) { fulfillmentOrders(first: 20) { nodes { id status } } } }',
    { id: orderGid }
  );
  const nodes = (data.order && data.order.fulfillmentOrders && data.order.fulfillmentOrders.nodes) || [];
  const open = nodes.filter((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS');
  if (!open.length) return { ok: true, already: true };
  const r = await shopify.graphql(
    'mutation ($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }',
    {
      f: {
        notifyCustomer: false,
        trackingInfo: { number: orderName, company: 'Sandoog' },
        lineItemsByFulfillmentOrder: open.map((f) => ({ fulfillmentOrderId: f.id })),
      },
    }
  );
  const errs = r.fulfillmentCreate.userErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join('; ') };
  return { ok: true };
}

const sending = new Set();

// Shopify order edits: use the current quantity and drop removed lines.
function currentLines(rest) {
  return (rest.line_items || [])
    .filter((li) => typeof li.current_quantity !== 'number' || li.current_quantity > 0)
    .map((li) => (typeof li.current_quantity === 'number' ? Object.assign({}, li, { quantity: li.current_quantity }) : li));
}

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
      const data = await shopify.graphql(ORDERS_QUERY, { first: 100, q });
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
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Math.max(0, Math.round(Number(b.amount)));
    if (amount !== null && !Number.isFinite(amount)) return res.status(400).json({ ok: false, error: 'المبلغ غير صحيح' });
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

      rest.line_items = currentLines(rest);
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
      let amountNote = '';
      const origTotal = Math.round(Number(rest.current_total_price || rest.total_price || 0));
      if (amount !== null && amount !== origTotal) {
        orderPost.payment.total_price = amount;
        if (orderPost.payment.lines && orderPost.payment.lines[0]) {
          orderPost.payment.lines[0].value = amount;
          if (orderPost.payment.lines[0].type === 'Cash') orderPost.payment.lines[0].is_paid = amount === 0;
        }
        amountNote = 'المبلغ المطلوب من الزبون عُدّل عند الإرسال: ' + amount + ' د.ع (كان ' + origTotal + ')';
        orderPost.notes = (amountNote + (orderPost.notes ? ' | ' + orderPost.notes : '')).trim();
      }

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
        const line = `[Sandoog] ${new Date().toISOString()} sent manually ${sandoogIdText}${amountNote ? ' | ' + amountNote : ''}`.trim();
        await shopify.graphql(
          'mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }',
          { input: { id: node.id, note: node.note ? node.note + '\n' + line : line } }
        );
      } catch (tagErr) {
        logger.error('Order ' + name + ' was sent to Sandoog but tagging it in Shopify failed', tagErr.message);
        return res.json({ ok: true, sandoogId: sandoogIdText, warning: 'أُرسل إلى صندوق لكن تعذر وسمه في Shopify - لا تعد الإرسال' });
      }
      let fulfilled = false;
      let fulfillWarning = '';
      try {
        const f = await fulfillSentOrder(node.id, name);
        fulfilled = !!f.ok;
        if (!f.ok) fulfillWarning = 'أُرسل إلى صندوق لكن تعذر تحويله إلى Fulfilled: ' + f.error;
      } catch (fErr) {
        logger.error('Order ' + name + ' sent to Sandoog but fulfilling it in Shopify failed', fErr.message);
        fulfillWarning = 'أُرسل إلى صندوق لكن تعذر تحويله إلى Fulfilled: ' + String(fErr.message || fErr).slice(0, 200);
      }
      return res.json({ ok: true, sandoogId: sandoogIdText, fulfilled, warning: fulfillWarning || undefined });
    } catch (err) {
      logger.error('Admin: failed to send order ' + name, err.response ? err.response.data : err.message);
      return res.status(500).json({ ok: false, error: errText(err) });
    } finally {
      sending.delete(name);
    }
  });

  // Exchange / return: create a NEW Sandoog order linked to the original one (own delivery fee).
  app.post('/admin/api/exchange', auth, json, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const kind = b.kind === 'return' ? 'return' : 'exchange';
    const code = String(b.city || '').trim();
    const phone = String(b.phone || '').trim();
    const address = String(b.address || '').trim();
    const amount = Math.max(0, Math.round(Number(b.amount) || 0));
    const refund = Math.max(0, Math.round(Number(b.refund) || 0));
    const clean = (arr) => (Array.isArray(arr) ? arr : [])
      .map((x) => ({
        sku: String((x && x.sku) || '').trim(),
        qty: Math.min(50, Math.max(1, parseInt(x && x.qty, 10) || 1)),
        title: String((x && x.title) || '').trim().slice(0, 80),
      }))
      .filter((x) => x.sku);
    const takeBack = clean(b.takeBack);
    const newItems = kind === 'exchange' ? clean(b.newItems) : [];
    if (!name) return res.status(400).json({ ok: false, error: 'Missing order name' });
    if (!CITY_CODES.has(code)) return res.status(400).json({ ok: false, error: 'اختر المحافظة من القائمة' });
    if (!phone) return res.status(400).json({ ok: false, error: 'رقم الهاتف فارغ' });
    if (!takeBack.length) return res.status(400).json({ ok: false, error: 'اختر القطع اللي رح تنستلم من الزبون' });
    if (kind === 'exchange' && !newItems.length) return res.status(400).json({ ok: false, error: 'أضف القطعة الجديدة (SKU) للتبديل' });
    const lockKey = name + '#ex';
    if (sending.has(lockKey)) return res.status(409).json({ ok: false, error: 'طلب التبديل/الاسترجاع قيد الإرسال الآن' });
    sending.add(lockKey);
    try {
      const found = await shopify.graphql(
        'query ($q: String!) { orders(first: 1, query: $q) { nodes { id name tags note cancelledAt } } }',
        { q: 'name:' + name }
      );
      const node = found.orders.nodes[0];
      if (!node || node.name !== name) return res.status(404).json({ ok: false, error: 'الطلب غير موجود في Shopify' });
      if (statusOf(node).status !== 'sent') return res.status(409).json({ ok: false, error: 'هذا الطلب لم يُرسل إلى صندوق أصلاً' });

      const rest = await shopify.getOrderRestByName(name);
      if (!rest) return res.status(404).json({ ok: false, error: 'تعذر تحميل تفاصيل الطلب من Shopify' });
      const lines = currentLines(rest);
      for (const t of takeBack) {
        const l = lines.find((x) => normSku(x.sku) === normSku(t.sku));
        if (!l) return res.status(400).json({ ok: false, error: 'القطعة ' + t.sku + ' ليست ضمن الطلب الأصلي' });
        if (t.qty > (l.quantity || 1)) return res.status(400).json({ ok: false, error: 'الكمية المسترجعة أكبر من الأصلية للقطعة ' + t.sku });
      }

      const base = rest.shipping_address || rest.billing_address || {};
      rest.line_items = lines;
      rest.shipping_address = Object.assign({}, base, { phone, address1: address || base.address1 || '', address2: address ? '' : base.address2 || '' });

      const prefix = kind === 'exchange' ? '-EX' : '-RT';
      const used = (node.note || '').match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + prefix + '\\d*', 'g')) || [];
      const ref = name + prefix + (used.length ? String(new Set(used).size + 1) : '');

      const label = (x) => (x.title ? x.title + ' ' : '') + '(' + x.sku + ') x' + x.qty;
      const notes = (kind === 'exchange' ? 'تبديل' : 'استرجاع') + ' للطلب ' + name + ' - استلام من الزبون وإعادته للمخزن: '
        + takeBack.map(label).join('، ')
        + (kind === 'exchange' ? ' - وتسليم القطع الجديدة: ' + newItems.map(label).join('، ') : ' - لا يوجد تسليم منتجات')
        + (amount ? ' - المبلغ المطلوب من الزبون: ' + amount + ' د.ع' : ' - لا يوجد مبلغ مطلوب من الزبون')
        + (refund ? ' - مبلغ يُدفع للزبون عند الاستلام: ' + refund + ' د.ع' : '');

      const orderPost = mapShopifyOrderToSandoog(rest);
      orderPost.external_reference = ref;
      orderPost.notes = notes;
      orderPost.customer.state = code;
      orderPost.delivery.delivery_region = b.region === 'Center' || b.region === 'County'
        ? b.region
        : (centers().includes(code) ? 'Center' : 'County');
      orderPost.delivery.delivery_items = newItems.map((i, idx) => ({
        id: idx + 1, name: i.title || i.sku, description: 'SKU: ' + i.sku, quantity: i.qty,
      }));
      orderPost.payment = {
        total_price: amount,
        payment_charge_type: 'Customer',
        amount_include_delivery_charge: true,
        lines: [{ type: 'Cash', value: amount, currency: 'IraqDinar', is_paid: amount === 0 }],
      };
      if (newItems.length) {
        await resolveSandoogProductIds(orderPost, { line_items: newItems.map((i) => ({ sku: i.sku })) });
      }

      logger.info('Admin: sending Sandoog ' + kind + ' order ' + ref + ': ' + JSON.stringify(orderPost));
      const result = await sandoog.createOrder(orderPost);
      logger.info('Sandoog accepted ' + kind + ' order ' + ref + ' (manual)', result);
      const sid = typeof result === 'string' ? result : ((result && (result.id || (result.data && (result.data.id || result.data)))) || '');
      const sidText = typeof sid === 'string' ? sid : JSON.stringify(sid);

      try {
        await shopify.graphql(
          'mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }',
          { id: node.id, tags: [kind === 'exchange' ? 'sandoog-exchange' : 'sandoog-return'] }
        );
        const line = `[Sandoog] ${new Date().toISOString()} ${kind} order ${ref} created ${sidText}${refund ? ' | refund to customer: ' + refund : ''}`.trim();
        await shopify.graphql(
          'mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }',
          { input: { id: node.id, note: node.note ? node.note + '\n' + line : line } }
        );
      } catch (tagErr) {
        logger.error('Exchange order ' + ref + ' was created in Sandoog but tagging the Shopify order failed', tagErr.message);
        return res.json({ ok: true, ref, sandoogId: sidText, warning: 'أُنشئ الطلب في صندوق لكن تعذر وسم الطلب الأصلي في Shopify - لا تعد الإنشاء' });
      }
      return res.json({ ok: true, ref, sandoogId: sidText });
    } catch (err) {
      logger.error('Admin: failed to create ' + kind + ' order for ' + name, err.response ? err.response.data : err.message);
      return res.status(500).json({ ok: false, error: errText(err) });
    } finally {
      sending.delete(lockKey);
    }
  });

  // Resend: the parcel came back but the customer still wants it -> NEW linked Sandoog order (<order>-RS[n]) with the
  // same items / same amount to collect; the Shopify order is NOT returned or restocked (tag sandoog-resent).
  app.post('/admin/api/resend', auth, json, async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const code = String(b.city || '').trim();
    const phone = String(b.phone || '').trim();
    const address = String(b.address || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Missing order name' });
    if (!CITY_CODES.has(code)) return res.status(400).json({ ok: false, error: 'اختر المحافظة من القائمة' });
    if (!phone) return res.status(400).json({ ok: false, error: 'رقم الهاتف فارغ' });
    const amount = (b.amount === undefined || b.amount === null || b.amount === '') ? null : Math.max(0, Math.round(Number(b.amount) || 0));
    const editItems = Array.isArray(b.items)
      ? b.items
        .map((x) => ({
          sku: String((x && x.sku) || '').trim(),
          title: String((x && x.title) || '').trim().slice(0, 80),
          qty: Math.min(50, Math.max(0, parseInt(x && x.qty, 10) || 0)),
        }))
        .filter((x) => (x.sku || x.title) && x.qty > 0)
      : null;
    if (editItems && !editItems.length) return res.status(400).json({ ok: false, error: 'لازم يبقى قطعة وحدة على الأقل في الطلب' });
    const lockKey = name + '#rs';
    if (sending.has(lockKey)) return res.status(409).json({ ok: false, error: 'إعادة الإرسال قيد التنفيذ الآن' });
    sending.add(lockKey);
    try {
      const found = await shopify.graphql(
        'query ($q: String!) { orders(first: 1, query: $q) { nodes { id name tags note cancelledAt } } }',
        { q: 'name:' + name }
      );
      const node = found.orders.nodes[0];
      if (!node || node.name !== name) return res.status(404).json({ ok: false, error: 'الطلب غير موجود في Shopify' });
      if (node.cancelledAt) return res.status(409).json({ ok: false, error: 'الطلب ملغي في Shopify' });
      if (statusOf(node).status !== 'sent') return res.status(409).json({ ok: false, error: 'هذا الطلب لم يُرسل إلى صندوق أصلاً' });

      const rest = await shopify.getOrderRestByName(name);
      if (!rest) return res.status(404).json({ ok: false, error: 'تعذر تحميل تفاصيل الطلب من Shopify' });
      const origLines = currentLines(rest);
      let editSummary = '';
      if (editItems) {
        const lineKey = (sku, title) => (sku ? 'sku:' + normSku(sku) : 'title:' + String(title || '').trim().toLowerCase());
        const edited = editItems.map((it) => {
          const orig = origLines.find((l) => lineKey(l.sku, l.title) === lineKey(it.sku, it.title));
          if (orig) return Object.assign({}, orig, { quantity: it.qty });
          return { title: it.title || it.sku, sku: it.sku, variant_title: '', quantity: it.qty };
        });
        const same = edited.length === origLines.length && edited.every((l) => {
          const o = origLines.find((x) => lineKey(x.sku, x.title) === lineKey(l.sku, l.title));
          return o && o.quantity === l.quantity;
        });
        rest.line_items = edited;
        if (!same) editSummary = 'القطع بعد التعديل: ' + edited.map((l) => (l.title || l.sku) + (l.variant_title ? ' ' + l.variant_title : '') + ' x' + l.quantity).join('، ');
      } else {
        rest.line_items = origLines;
      }
      const base = rest.shipping_address || rest.billing_address || {};
      rest.shipping_address = Object.assign({}, base, { phone, address1: address || base.address1 || '', address2: address ? '' : base.address2 || '' });

      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const used = (node.note || '').match(new RegExp(esc + '-RS\\d*', 'g')) || [];
      const ref = name + '-RS' + (used.length ? String(new Set(used).size + 1) : '');

      const orderPost = mapShopifyOrderToSandoog(rest);
      orderPost.external_reference = ref;
      const origTotal = Math.round(Number(rest.current_total_price || rest.total_price || 0));
      if (amount !== null && amount !== origTotal) editSummary += (editSummary ? ' | ' : '') + 'المبلغ المطلوب: ' + amount + ' د.ع (كان ' + origTotal + ')';
      orderPost.notes = 'إعادة إرسال للطلب ' + name + ' (رجع ولسا الزبون بدو الطلب) - أجور التوصيل على الشركة. '
        + (editSummary ? 'تعديل عند إعادة الإرسال: ' + editSummary + '. ' : 'نفس القطع ونفس المبلغ. ')
        + String(orderPost.notes || '').split('\n').filter((l) => !/^\[Sandoog\]/.test(l)).join(' ').trim();
      orderPost.customer.state = code;
      orderPost.delivery.delivery_region = b.region === 'Center' || b.region === 'County'
        ? b.region
        : (centers().includes(code) ? 'Center' : 'County');
      await resolveSandoogProductIds(orderPost, rest);
      if (amount !== null) {
        orderPost.payment.total_price = amount;
        if (orderPost.payment.lines && orderPost.payment.lines[0]) {
          orderPost.payment.lines[0].value = amount;
          if (orderPost.payment.lines[0].type === 'Cash') orderPost.payment.lines[0].is_paid = amount === 0;
        }
      }

      logger.info('Admin: sending Sandoog resend order ' + ref + ': ' + JSON.stringify(orderPost));
      // Sandoog rejects what it considers a duplicate of an earlier order (same customer/items) with "Duplicated request."
      // -> retry with small, cumulative differences until one is accepted.
      const variants = [
        () => {},
        () => { orderPost.customer.name = orderPost.customer.name + ' (إعادة إرسال)'; },
        () => { orderPost.customer.address = (orderPost.customer.address || '') + ' - إعادة إرسال'; },
        () => { if (orderPost.delivery.delivery_items[0]) orderPost.delivery.delivery_items[0].description += ' (RS)'; },
      ];
      let result;
      let lastErr = null;
      for (let vi = 0; vi < variants.length; vi++) {
        variants[vi]();
        try {
          result = await sandoog.createOrder(orderPost);
          lastErr = null;
          if (vi) logger.info('Resend order ' + ref + ' accepted by Sandoog with variant #' + vi);
          break;
        } catch (e) {
          lastErr = e;
          const txt = JSON.stringify((e.response && e.response.data) || e.message || '');
          if (!/duplicat/i.test(txt)) throw e;
          logger.warn('Sandoog said duplicate for resend ' + ref + ' (variant #' + vi + ')');
        }
      }
      if (lastErr) throw lastErr;
      logger.info('Sandoog accepted resend order ' + ref + ' (manual)', result);
      const sid = typeof result === 'string' ? result : ((result && (result.id || (result.data && (result.data.id || result.data)))) || '');
      const sidText = typeof sid === 'string' ? sid : JSON.stringify(sid);

      const warnings = [];
      if ((node.tags || []).includes('sandoog-returned')) warnings.push('تنبيه: كان قد أُنشئ Return وأُرجع المخزون لهذا الطلب سابقاً، راجع المخزون يدوياً');
      try {
        await shopify.graphql(
          'mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }',
          { id: node.id, tags: ['sandoog-resent'] }
        );
        const line = `[Sandoog] ${new Date().toISOString()} resend order ${ref} created ${sidText}${editSummary ? ' | ' + editSummary : ''}`.trim();
        await shopify.graphql(
          'mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }',
          { input: { id: node.id, note: node.note ? node.note + '\n' + line : line } }
        );
      } catch (tagErr) {
        logger.error('Resend order ' + ref + ' was created in Sandoog but tagging the Shopify order failed', tagErr.message);
        warnings.push('أُنشئ الطلب في صندوق لكن تعذر وسم الطلب الأصلي في Shopify - لا تعد الإنشاء');
      }
      return res.json({ ok: true, ref, sandoogId: sidText, warning: warnings.join(' — ') || undefined });
    } catch (err) {
      logger.error('Admin: failed to resend order ' + name, err.response ? err.response.data : err.message);
      return res.status(500).json({ ok: false, error: errText(err) });
    } finally {
      sending.delete(lockKey);
    }
  });

  // Fulfill every order that was already sent to Sandoog but is still unfulfilled in Shopify.
  app.post('/admin/api/fulfill-sent', auth, json, async (_req, res) => {
    try {
      const q = `created_at:>=${fromDate()} fulfillment_status:unfulfilled status:open`;
      const data = await shopify.graphql(
        'query ($q: String!) { orders(first: 100, query: $q) { nodes { id name tags cancelledAt } } }',
        { q }
      );
      const targets = data.orders.nodes.filter((o) => !o.cancelledAt && statusOf(o).status === 'sent');
      const done = [];
      const failed = [];
      for (const o of targets) {
        try {
          const f = await fulfillSentOrder(o.id, o.name);
          if (f.ok) done.push(o.name); else failed.push(o.name + ': ' + f.error);
        } catch (e) {
          failed.push(o.name + ': ' + String(e.message || e).slice(0, 160));
        }
      }
      logger.info('Admin: fulfilled ' + done.length + ' sent order(s) in Shopify', { done, failed });
      res.json({ ok: true, done, failed });
    } catch (err) {
      logger.error('Admin: fulfill-sent failed', err.response ? err.response.data : err.message);
      res.status(500).json({ ok: false, error: errText(err) });
    }
  });

  // Mark as paid every open order whose Sandoog status is Complete (cash collected) but is still unpaid in Shopify.
  app.post('/admin/api/mark-paid-complete', auth, json, async (_req, res) => {
    try {
      const q = `created_at:>=${fromDate()} tag:'sandoog:Complete' financial_status:pending`;
      const data = await shopify.graphql(
        'query ($q: String!) { orders(first: 100, query: $q) { nodes { id name tags cancelledAt } } }',
        { q }
      );
      const done = [];
      const failed = [];
      for (const o of data.orders.nodes.filter((x) => !x.cancelledAt)) {
        try {
          const r = await require('./shopifyPayments').markOrderPaid(o.id);
          if (r.ok) done.push(o.name); else failed.push(o.name + ': ' + r.error);
        } catch (e) {
          failed.push(o.name + ': ' + String(e.message || e).slice(0, 160));
        }
      }
      logger.info('Admin: marked ' + done.length + ' completed order(s) as paid in Shopify', { done, failed });
      res.json({ ok: true, done, failed });
    } catch (err) {
      logger.error('Admin: mark-paid-complete failed', err.response ? err.response.data : err.message);
      res.status(500).json({ ok: false, error: errText(err) });
    }
  });

  // Register this service's status callback URL with Sandoog (uses the server-side secret; nothing is shown).
  app.post('/admin/api/register-webhook', auth, json, async (_req, res) => {
    try {
      const base = String(config.service.publicBaseUrl || '').replace(/\/+$/, '');
      if (!base || !config.sandoog.callbackSecret) {
        return res.status(500).json({ ok: false, error: 'PUBLIC_BASE_URL أو SANDOOG_CALLBACK_SECRET غير مضبوط' });
      }
      const url = base + '/webhooks/sandoog/order-status';
      const r = await sandoog.registerWebhook({ callbackKey: config.sandoog.callbackSecret, orderUrl: url });
      logger.info('Admin: registered Sandoog status webhook', { url, response: r });
      res.json({ ok: true, url });
    } catch (err) {
      logger.error('Admin: register-webhook failed', err.response ? err.response.data : err.message);
      res.status(500).json({ ok: false, error: errText(err) });
    }
  });
}

module.exports = { mount, guessCity, CITIES };
