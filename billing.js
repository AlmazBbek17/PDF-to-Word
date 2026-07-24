import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';
import { PLANS, activatePlan, deactivatePlan, findUserByDodoCustomerId, setDodoCustomerId } from './db.js';

// Created lazily (not at import time) so a missing DODO_PAYMENTS_API_KEY / DODO_WEBHOOK_SECRET
// doesn't crash the whole server on boot — only the billing endpoints that actually need them fail.
let _dodo = null;
function getDodoClient() {
  if (!process.env.DODO_PAYMENTS_API_KEY) {
    throw new Error('DODO_PAYMENTS_API_KEY is not set — billing is not configured on this server');
  }
  if (!_dodo) {
    _dodo = new DodoPayments({
      bearerToken: process.env.DODO_PAYMENTS_API_KEY,
      environment: process.env.DODO_PAYMENTS_ENVIRONMENT || 'test_mode',
    });
  }
  return _dodo;
}

let _webhook = null;
function getWebhookVerifier() {
  if (!process.env.DODO_WEBHOOK_SECRET) {
    throw new Error('DODO_WEBHOOK_SECRET is not set — webhook verification is not configured on this server');
  }
  if (!_webhook) {
    _webhook = new Webhook(process.env.DODO_WEBHOOK_SECRET);
  }
  return _webhook;
}

// Maps our internal plan keys to the product IDs you create in the Dodo dashboard.
// Set these as env vars once you've created the three subscription products there.
const PRODUCT_ID_BY_PLAN = {
  plan_5: process.env.DODO_PRODUCT_ID_5,
  plan_10: process.env.DODO_PRODUCT_ID_10,
  plan_15: process.env.DODO_PRODUCT_ID_15,
};

export async function createCheckoutSession({ email, planKey, returnUrl }) {
  if (!PLANS[planKey]) throw new Error(`Unknown plan: ${planKey}`);
  const productId = PRODUCT_ID_BY_PLAN[planKey];
  if (!productId) throw new Error(`No Dodo product configured for ${planKey} — set the matching env var`);

  const session = await getDodoClient().checkoutSessions.create({
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email },
    return_url: returnUrl,
    metadata: { plan_key: planKey, app: 'pdf-to-word' },
  });
  return session.checkout_url;
}

// Lets a subscribed customer manage/cancel their subscription directly with
// Dodo (update card, cancel, view invoices) without us building any of that UI.
export async function createCustomerPortalSession(dodoCustomerId) {
  const session = await getDodoClient().customers.customerPortal.create(dodoCustomerId);
  return session.link;
}

export async function verifyAndParseWebhook(rawBody, headers) {
  const webhookHeaders = {
    'webhook-id': headers['webhook-id'] || '',
    'webhook-signature': headers['webhook-signature'] || '',
    'webhook-timestamp': headers['webhook-timestamp'] || '',
  };
  return getWebhookVerifier().verify(rawBody, webhookHeaders); // throws if invalid
}

// Reverse-lookup which of our plan keys a Dodo product_id corresponds to.
function planKeyForProductId(productId) {
  return Object.entries(PRODUCT_ID_BY_PLAN).find(([, id]) => id === productId)?.[0] || null;
}

export async function handleDodoEvent(event) {
  const type = event.event_type || event.type;
  const data = event.data || {};
  const customerEmail = data.customer?.email;
  const customerId = data.customer?.customer_id || data.customer_id;
  const productId = data.product_id || data.product?.product_id;
  const subscriptionId = data.subscription_id || data.id;

  switch (type) {
    case 'subscription.active':
    case 'subscription.renewed':
    case 'subscription.plan_changed': {
      const planKey = planKeyForProductId(productId);
      if (!planKey || !customerEmail) break;
      if (customerId) await setDodoCustomerId(customerEmail, customerId);
      await activatePlan({ email: customerEmail, dodoCustomerId: customerId, dodoSubscriptionId: subscriptionId, planKey });
      break;
    }
    case 'subscription.cancelled':
    case 'subscription.expired':
    case 'subscription.failed': {
      let email = customerEmail;
      if (!email && customerId) {
        const user = await findUserByDodoCustomerId(customerId);
        email = user?.email;
      }
      if (email) await deactivatePlan(email);
      break;
    }
    default:
      // payment.succeeded etc. — subscription.* events above are what actually drive plan state.
      break;
  }
}
