'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleEvent } = require('../server/webhook-handler');

let n = 0;
const deps = { generateKey: () => `PULSE-TEST-${++n}`, now: () => '2026-11-08T00:00:00.000Z' };
const ev = (type, object) => ({ id: `evt_${type}_${++n}`, type, data: { object } });

const lifetimeSession = (over = {}) => ({
  id: 'cs_life',
  mode: 'payment',
  payment_status: 'paid',
  customer_details: { email: 'a@example.com' },
  payment_intent: 'pi_life',
  metadata: { app: 'profilepulse' },
  ...over,
});
const monthlySession = (over = {}) => ({
  id: 'cs_month',
  mode: 'subscription',
  payment_status: 'paid',
  customer_details: { email: 'm@example.com' },
  customer: 'cus_m',
  subscription: 'sub_m',
  metadata: { app: 'profilepulse' },
  ...over,
});
const renewal = (over = {}) => ({
  id: 'in_1',
  billing_reason: 'subscription_cycle',
  customer_email: 'm@example.com',
  customer: 'cus_m',
  parent: { subscription_details: { subscription: 'sub_m', metadata: { app: 'profilepulse' } } },
  ...over,
});

test('paid lifetime checkout creates exactly one lifetime license', () => {
  const r = handleEvent(ev('checkout.session.completed', lifetimeSession()), [], deps);
  assert.equal(r.licenses.length, 1);
  assert.equal(r.licenses[0].type, 'lifetime');
  assert.equal(r.licenses[0].stripePaymentIntentId, 'pi_life');
});

test('foreign checkout session (other app on the shared account) is ignored', () => {
  const r = handleEvent(ev('checkout.session.completed', lifetimeSession({ metadata: {} })), [], deps);
  assert.equal(r.licenses.length, 0);
  assert.equal(r.changed, false);
});

test('unpaid checkout session does not create a license', () => {
  const r = handleEvent(ev('checkout.session.completed', lifetimeSession({ payment_status: 'unpaid' })), [], deps);
  assert.equal(r.licenses.length, 0);
});

test('async payment success creates the license later', () => {
  const r = handleEvent(ev('checkout.session.async_payment_succeeded', lifetimeSession()), [], deps);
  assert.equal(r.licenses.length, 1);
});

test('redelivered checkout event is idempotent', () => {
  const first = handleEvent(ev('checkout.session.completed', lifetimeSession()), [], deps);
  const again = handleEvent(ev('checkout.session.completed', lifetimeSession()), first.licenses, deps);
  assert.equal(again.licenses.length, 1);
  assert.equal(again.changed, false);
});

test('monthly checkout stores the subscription id', () => {
  const r = handleEvent(ev('checkout.session.completed', monthlySession()), [], deps);
  assert.equal(r.licenses[0].type, 'monthly');
  assert.equal(r.licenses[0].stripeSubscriptionId, 'sub_m');
});

test('monthly renewal invoice NEVER creates a lifetime license', () => {
  const start = handleEvent(ev('checkout.session.completed', monthlySession()), [], deps).licenses;
  let lic = start;
  for (let i = 0; i < 3; i++) lic = handleEvent(ev('invoice.payment_succeeded', renewal()), lic, deps).licenses;
  assert.equal(lic.length, 1);
  assert.equal(lic.filter((l) => l.type === 'lifetime').length, 0);
});

test('first invoice of the subscription alongside checkout yields one license, not two', () => {
  let lic = handleEvent(ev('checkout.session.completed', monthlySession()), [], deps).licenses;
  lic = handleEvent(ev('invoice.payment_succeeded', renewal({ billing_reason: 'subscription_create' })), lic, deps).licenses;
  assert.equal(lic.length, 1);
});

test('first invoice without a checkout event still licenses our own subscription (safety net)', () => {
  const r = handleEvent(ev('invoice.paid', renewal({ billing_reason: 'subscription_create' })), [], deps);
  assert.equal(r.licenses.length, 1);
  assert.equal(r.licenses[0].type, 'monthly');
});

test('first invoice of a FOREIGN subscription creates nothing', () => {
  const foreign = renewal({
    billing_reason: 'subscription_create',
    parent: { subscription_details: { subscription: 'sub_x', metadata: { app: 'viacamp' } } },
  });
  assert.equal(handleEvent(ev('invoice.paid', foreign), [], deps).licenses.length, 0);
});

test('legacy invoice shape (subscription on the invoice) is understood', () => {
  let lic = handleEvent(ev('checkout.session.completed', monthlySession()), [], deps).licenses;
  lic[0].active = false;
  lic[0].deactivatedReason = 'subscription_unpaid';
  const legacy = { id: 'in_2', billing_reason: 'subscription_cycle', subscription: 'sub_m' };
  lic = handleEvent(ev('invoice.payment_succeeded', legacy), lic, deps).licenses;
  assert.equal(lic[0].active, true);
});

test('subscription deleted deactivates only the matching monthly license', () => {
  const other = { key: 'K2', type: 'monthly', active: true, stripeSubscriptionId: 'sub_other' };
  const life = { key: 'K3', type: 'lifetime', active: true, stripeCustomerId: 'cus_m' };
  let lic = handleEvent(ev('checkout.session.completed', monthlySession()), [other, life], deps).licenses;
  lic = handleEvent(ev('customer.subscription.deleted', { id: 'sub_m', customer: 'cus_m', status: 'canceled' }), lic, deps).licenses;
  assert.equal(lic.find((l) => l.stripeSubscriptionId === 'sub_m').active, false);
  assert.equal(lic.find((l) => l.key === 'K2').active, true);
  assert.equal(lic.find((l) => l.key === 'K3').active, true, 'lifetime must survive a cancelled subscription');
});

test('subscription updated: unpaid deactivates, past_due keeps, active restores', () => {
  let lic = handleEvent(ev('checkout.session.completed', monthlySession()), [], deps).licenses;
  const upd = (status) => ev('customer.subscription.updated', { id: 'sub_m', customer: 'cus_m', status });
  lic = handleEvent(upd('past_due'), lic, deps).licenses;
  assert.equal(lic[0].active, true);
  lic = handleEvent(upd('unpaid'), lic, deps).licenses;
  assert.equal(lic[0].active, false);
  lic = handleEvent(upd('active'), lic, deps).licenses;
  assert.equal(lic[0].active, true);
});

test('subscription becoming active does not revive a refunded license', () => {
  const lic = [{ key: 'K', type: 'monthly', active: false, deactivatedReason: 'refunded', stripeSubscriptionId: 'sub_m' }];
  const r = handleEvent(ev('customer.subscription.updated', { id: 'sub_m', status: 'active' }), lic, deps);
  assert.equal(r.licenses[0].active, false);
});

test('legacy monthly license without subscription id is matched by customer', () => {
  const lic = [{ key: 'K', type: 'monthly', active: true, stripeCustomerId: 'cus_m' }];
  const r = handleEvent(ev('customer.subscription.deleted', { id: 'sub_m', customer: 'cus_m' }), lic, deps);
  assert.equal(r.licenses[0].active, false);
});

test('full refund deactivates the lifetime license, partial refund keeps it', () => {
  let lic = handleEvent(ev('checkout.session.completed', lifetimeSession()), [], deps).licenses;
  lic = handleEvent(ev('charge.refunded', { id: 'ch', payment_intent: 'pi_life', amount: 4900, amount_refunded: 1000, refunded: false }), lic, deps).licenses;
  assert.equal(lic[0].active, true);
  lic = handleEvent(ev('charge.refunded', { id: 'ch', payment_intent: 'pi_life', amount: 4900, amount_refunded: 4900, refunded: true }), lic, deps).licenses;
  assert.equal(lic[0].active, false);
  assert.equal(lic[0].deactivatedReason, 'refunded');
});

test('refund of a foreign payment touches nothing', () => {
  const lic = handleEvent(ev('checkout.session.completed', lifetimeSession()), [], deps).licenses;
  const r = handleEvent(ev('charge.refunded', { id: 'ch', payment_intent: 'pi_other', refunded: true }), lic, deps);
  assert.equal(r.licenses[0].active, true);
  assert.equal(r.changed, false);
});

test('dispute deactivates, won dispute restores', () => {
  let lic = handleEvent(ev('checkout.session.completed', lifetimeSession()), [], deps).licenses;
  lic = handleEvent(ev('charge.dispute.created', { payment_intent: 'pi_life' }), lic, deps).licenses;
  assert.equal(lic[0].active, false);
  lic = handleEvent(ev('charge.dispute.closed', { payment_intent: 'pi_life', status: 'lost' }), lic, deps).licenses;
  assert.equal(lic[0].active, false);
  lic = handleEvent(ev('charge.dispute.closed', { payment_intent: 'pi_life', status: 'won' }), lic, deps).licenses;
  assert.equal(lic[0].active, true);
});

test('input array is not mutated', () => {
  const input = [{ key: 'K', type: 'monthly', active: true, stripeSubscriptionId: 'sub_m' }];
  handleEvent(ev('customer.subscription.deleted', { id: 'sub_m' }), input, deps);
  assert.equal(input[0].active, true);
});
