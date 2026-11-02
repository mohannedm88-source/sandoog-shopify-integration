const shopify = require('./shopifyClient');

// When Sandoog reports "Balance Updated" (the cash was collected / settled), mark the
// Shopify order as paid. Uses write_orders (already granted).

const ORDER_QUERY = `query ($id: ID!) {
  order(id: $id) { id name tags note displayFinancialStatus cancelledAt }
}`;
const MARK_PAID = `mutation ($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id displayFinancialStatus }
    userErrors { field message }
  }
}`;
const TAG = `mutation ($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`;
const NOTE = `mutation ($input: OrderInput!) { orderUpdate(input: $input) { userErrors { field message } } }`;

async function addNote(o, text) {
  const line = `[Sandoog] ${new Date().toISOString()} ${text}`;
  await shopify.graphql(NOTE, { input: { id: o.id, note: o.note ? o.note + '\n' + line : line } });
}

/** True for "Balance Updated" / "BalanceUpdated" / "balance_updated" etc. */
function isBalanceUpdated(eventType) {
  return String(eventType || '').toLowerCase().replace(/[^a-z]/g, '') === 'balanceupdated';
}

async function markOrderPaid(orderGid) {
  const data = await shopify.graphql(ORDER_QUERY, { id: orderGid });
  const o = data.order;
  if (!o) return { ok: false, error: 'order not found' };
  if (o.cancelledAt) return { ok: false, error: 'order is cancelled' };
  if (o.displayFinancialStatus === 'PAID') {
    if (!o.tags.includes('sandoog-paid')) await shopify.graphql(TAG, { id: o.id, tags: ['sandoog-paid'] });
    return { ok: true, already: true };
  }
  const r = await shopify.graphql(MARK_PAID, { input: { id: o.id } });
  const e = r.orderMarkAsPaid.userErrors || [];
  if (e.length) {
    const msg = e.map((x) => x.message).join('; ');
    await addNote(o, 'Balance Updated من صندوق لكن تعذر وضع الطلب Paid تلقائياً: ' + msg);
    return { ok: false, error: msg };
  }
  await shopify.graphql(TAG, { id: o.id, tags: ['sandoog-paid'] });
  await addNote(o, 'Balance Updated من صندوق: تم تحصيل المبلغ ووُضع الطلب Paid في Shopify');
  return { ok: true, status: r.orderMarkAsPaid.order.displayFinancialStatus };
}

module.exports = { markOrderPaid, isBalanceUpdated };
