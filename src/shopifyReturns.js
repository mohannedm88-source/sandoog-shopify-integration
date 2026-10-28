const shopify = require('./shopifyClient');
const logger = require('./logger');

// When Sandoog reports "Returned" (the parcel was never handed over and came back
// to the warehouse), record a Shopify Return for the fulfilled items and restock
// them. Needs the read_returns / write_returns scopes.

const ORDER_QUERY = `query ($id: ID!) {
  order(id: $id) {
    id name tags note
    returns(first: 10) { nodes { id status } }
    fulfillments(first: 10) {
      id status
      fulfillmentLineItems(first: 50) { nodes { id quantity } }
    }
  }
}`;

const RETURN_CREATE = `mutation ($input: ReturnInput!) {
  returnCreate(returnInput: $input) {
    return {
      id status
      reverseFulfillmentOrders(first: 10) {
        nodes { id lineItems(first: 50) { nodes { id totalQuantity } } }
      }
    }
    userErrors { field message }
  }
}`;

const DISPOSE = `mutation ($d: [ReverseFulfillmentOrderDisposeInput!]!) {
  reverseFulfillmentOrderDispose(dispositionInputs: $d) {
    reverseFulfillmentOrderLineItems { id }
    userErrors { field message }
  }
}`;

const CLOSE = `mutation ($id: ID!) { returnClose(id: $id) { return { id status } userErrors { field message } } }`;
const TAG = `mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
const NOTE = `mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`;

function errs(r) {
  return (r && r.userErrors && r.userErrors.length) ? r.userErrors.map((e) => e.message).join('; ') : '';
}

async function addNote(orderId, currentNote, text) {
  const line = `[Sandoog] ${new Date().toISOString()} ${text}`;
  await shopify.graphql(NOTE, { input: { id: orderId, note: currentNote ? currentNote + '\n' + line : line } });
}

/** Create a Shopify Return (+ restock) for a fulfilled order that Sandoog marked Returned. */
async function returnOrder(orderGid) {
  const data = await shopify.graphql(ORDER_QUERY, { id: orderGid });
  const o = data.order;
  if (!o) return { ok: false, error: 'order not found' };
  if (o.tags.includes('sandoog-returned')) return { ok: true, already: true };
  if ((o.returns.nodes || []).length) {
    await shopify.graphql(TAG, { id: o.id, tags: ['sandoog-returned'] });
    return { ok: true, already: true };
  }

  const lines = [];
  for (const f of o.fulfillments || []) {
    for (const li of (f.fulfillmentLineItems && f.fulfillmentLineItems.nodes) || []) {
      if (li.quantity > 0) {
        lines.push({
          fulfillmentLineItemId: li.id,
          quantity: li.quantity,
          returnReason: 'OTHER',
          returnReasonNote: 'Sandoog: Returned (لم يُسلَّم للزبون)',
        });
      }
    }
  }
  if (!lines.length) {
    await addNote(o.id, o.note, 'Returned من صندوق لكن الطلب غير Fulfilled في Shopify - لم يُنشأ Return');
    return { ok: false, error: 'order has no fulfilled items' };
  }

  const created = await shopify.graphql(RETURN_CREATE, { input: { orderId: o.id, returnLineItems: lines } });
  const e1 = errs(created.returnCreate);
  if (e1) {
    await addNote(o.id, o.note, 'تعذر إنشاء Return في Shopify: ' + e1);
    return { ok: false, error: e1 };
  }
  const ret = created.returnCreate.return;

  const disp = [];
  for (const rfo of (ret.reverseFulfillmentOrders && ret.reverseFulfillmentOrders.nodes) || []) {
    for (const li of (rfo.lineItems && rfo.lineItems.nodes) || []) {
      disp.push({ reverseFulfillmentOrderLineItemId: li.id, quantity: li.totalQuantity, dispositionType: 'RESTOCKED' });
    }
  }
  let restocked = false;
  let restockErr = '';
  if (disp.length) {
    try {
      const r = await shopify.graphql(DISPOSE, { d: disp });
      restockErr = errs(r.reverseFulfillmentOrderDispose);
      restocked = !restockErr;
    } catch (e) {
      restockErr = String(e.message || e).slice(0, 200);
    }
  }
  if (restocked) {
    try { await shopify.graphql(CLOSE, { id: ret.id }); } catch (e) { logger.warn('returnClose failed (ignored)', e.message); }
  }

  await shopify.graphql(TAG, { id: o.id, tags: ['sandoog-returned'] });
  await addNote(o.id, o.note, restocked
    ? 'Returned من صندوق: تم إنشاء Return وإرجاع المخزون في Shopify'
    : 'Returned من صندوق: تم إنشاء Return لكن تعذر إرجاع المخزون تلقائياً' + (restockErr ? ' (' + restockErr + ')' : '') + ' - أرجعه يدوياً');
  return { ok: true, restocked, restockErr };
}

module.exports = { returnOrder };
