'use strict';
/**
 * Pure Stripe webhook logic for the ProfilePulse license server.
 *
 * handleEvent(event, licenses, deps) -> { licenses, changed, log }
 *
 * No file or network access here: the caller loads/saves licenses.json and
 * passes a key generator and a clock. That keeps every rule testable.
 *
 * Rules (each one fixes a real defect found in the 2026-11-08 audit):
 *  - A license is only ever CREATED from a checkout session that belongs to
 *    this app (metadata.app === 'profilepulse'). The Stripe account is shared
 *    with other apps; without the filter every foreign purchase minted a
 *    ProfilePulse lifetime key.
 *  - Creation requires a settled payment (payment_status 'paid', or
 *    'no_payment_required' for a subscription with a free first period).
 *  - Creation is idempotent per checkout session: a redelivered event finds
 *    the existing license and changes nothing.
 *  - invoice.* events NEVER create a lifetime license. Invoices carry no
 *    `mode`, which made every monthly renewal mint a new lifetime key.
 *  - Subscription state is mirrored onto the monthly license by
 *    subscription id: unpaid/canceled/incomplete_expired deactivate,
 *    active/trialing reactivate, past_due keeps access while Stripe retries.
 *  - A full refund or a dispute deactivates the license paid by that
 *    payment intent.
 */

const APP = 'profilepulse';

const DEACTIVATING_SUB_STATES = new Set(['unpaid', 'canceled', 'incomplete_expired']);
const ACTIVE_SUB_STATES = new Set(['active', 'trialing']);

function idOf(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id || null;
}

function sessionIsPaid(session) {
  if (session.payment_status === 'paid') return true;
  return session.mode === 'subscription' && session.payment_status === 'no_payment_required';
}

function invoiceAppMetadata(invoice) {
  // Stripe moved this field in API 2025-03-31 (basil); read both places.
  return (
    invoice?.parent?.subscription_details?.metadata?.app ||
    invoice?.subscription_details?.metadata?.app ||
    null
  );
}

function invoiceSubscriptionId(invoice) {
  return (
    idOf(invoice?.parent?.subscription_details?.subscription) ||
    idOf(invoice?.subscription) ||
    null
  );
}

function setActive(lic, active, reason, now) {
  if (lic.active === active) return false;
  lic.active = active;
  if (active) {
    delete lic.deactivatedReason;
    delete lic.deactivatedAt;
  } else {
    lic.deactivatedReason = reason;
    lic.deactivatedAt = now;
  }
  return true;
}

function handleEvent(event, licensesIn, { generateKey, now = () => new Date().toISOString() }) {
  const licenses = licensesIn.map((l) => ({ ...l }));
  const log = [];
  let changed = false;
  const obj = event?.data?.object || {};
  const ts = now();

  const createLicense = ({ type, email, sessionId, customerId, subscriptionId, paymentIntentId }) => {
    const key = generateKey();
    licenses.push({
      key,
      email,
      type,
      createdAt: ts,
      active: true,
      stripeSessionId: sessionId || null,
      stripeCustomerId: customerId || null,
      stripeSubscriptionId: subscriptionId || null,
      stripePaymentIntentId: paymentIntentId || null,
    });
    changed = true;
    log.push(`license created (${type}) for ${email}: ${key}`);
  };

  switch (event?.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const s = obj;
      if (s.metadata?.app !== APP) {
        log.push(`ignored foreign checkout session ${s.id}`);
        break;
      }
      if (!sessionIsPaid(s)) {
        log.push(`checkout session ${s.id} not paid yet (${s.payment_status})`);
        break;
      }
      if (licenses.some((l) => l.stripeSessionId === s.id)) {
        log.push(`duplicate checkout session ${s.id}, nothing to do`);
        break;
      }
      const subscriptionId = idOf(s.subscription);
      if (subscriptionId && licenses.some((l) => l.stripeSubscriptionId === subscriptionId)) {
        log.push(`subscription ${subscriptionId} already licensed`);
        break;
      }
      const email = s.customer_details?.email || s.customer_email;
      if (!email) {
        log.push(`checkout session ${s.id} has no email, cannot license`);
        break;
      }
      createLicense({
        type: s.mode === 'subscription' ? 'monthly' : 'lifetime',
        email,
        sessionId: s.id,
        customerId: idOf(s.customer),
        subscriptionId,
        paymentIntentId: idOf(s.payment_intent),
      });
      break;
    }

    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const subscriptionId = invoiceSubscriptionId(obj);
      if (!subscriptionId) break;
      const lic = licenses.find((l) => l.stripeSubscriptionId === subscriptionId);
      if (lic) {
        if (setActive(lic, true, null, ts)) {
          changed = true;
          log.push(`renewal reactivated ${lic.key}`);
        }
        break;
      }
      // Safety net: the first invoice of a subscription whose checkout event
      // never arrived. Only for our own subscriptions, and only monthly.
      if (invoiceAppMetadata(obj) === APP && obj.billing_reason === 'subscription_create' && obj.customer_email) {
        createLicense({
          type: 'monthly',
          email: obj.customer_email,
          customerId: idOf(obj.customer),
          subscriptionId,
        });
      }
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = obj;
      const status = event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status;
      // Older licenses predate stripeSubscriptionId; fall back to customer.
      const matches = licenses.filter(
        (l) =>
          l.type === 'monthly' &&
          (l.stripeSubscriptionId
            ? l.stripeSubscriptionId === sub.id
            : l.stripeCustomerId && l.stripeCustomerId === idOf(sub.customer))
      );
      for (const lic of matches) {
        if (DEACTIVATING_SUB_STATES.has(status)) {
          if (setActive(lic, false, `subscription_${status}`, ts)) {
            changed = true;
            log.push(`deactivated ${lic.key} (subscription ${status})`);
          }
        } else if (ACTIVE_SUB_STATES.has(status) && lic.deactivatedReason?.startsWith('subscription_')) {
          if (setActive(lic, true, null, ts)) {
            changed = true;
            log.push(`reactivated ${lic.key} (subscription ${status})`);
          }
        }
      }
      break;
    }

    case 'charge.refunded': {
      const charge = obj;
      const fullyRefunded = charge.refunded === true || (charge.amount > 0 && charge.amount_refunded >= charge.amount);
      if (!fullyRefunded) {
        log.push(`partial refund on ${charge.id}, license kept`);
        break;
      }
      const pi = idOf(charge.payment_intent);
      for (const lic of licenses.filter((l) => pi && l.stripePaymentIntentId === pi)) {
        if (setActive(lic, false, 'refunded', ts)) {
          changed = true;
          log.push(`deactivated ${lic.key} (refunded)`);
        }
      }
      break;
    }

    case 'charge.dispute.created': {
      const pi = idOf(obj.payment_intent);
      for (const lic of licenses.filter((l) => pi && l.stripePaymentIntentId === pi)) {
        if (setActive(lic, false, 'disputed', ts)) {
          changed = true;
          log.push(`deactivated ${lic.key} (dispute)`);
        }
      }
      break;
    }

    case 'charge.dispute.closed': {
      if (obj.status !== 'won') break;
      const pi = idOf(obj.payment_intent);
      for (const lic of licenses.filter((l) => pi && l.stripePaymentIntentId === pi && l.deactivatedReason === 'disputed')) {
        if (setActive(lic, true, null, ts)) {
          changed = true;
          log.push(`reactivated ${lic.key} (dispute won)`);
        }
      }
      break;
    }

    default:
      break;
  }

  return { licenses, changed, log };
}

module.exports = { handleEvent, APP, sessionIsPaid };
