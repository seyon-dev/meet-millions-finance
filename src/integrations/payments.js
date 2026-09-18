/**
 * Payment gateways: Razorpay (the Integration Stack default), Stripe,
 * Cashfree and PhonePe — the four the addendum names.
 *
 * Every gateway implements the same three operations, so the billing module
 * never branches on provider:
 *
 *   createOrder(...)      → an order/intent the client can pay against
 *   verifyPayment(...)    → confirm a completed payment, by signature
 *   verifyWebhook(...)    → authenticate an inbound webhook
 *
 * A payment is only ever recorded as successful when the gateway says so and
 * the signature verifies. There is no path through this file that marks a
 * payment paid without a verified upstream confirmation.
 */

import { Provider, RESULT_STATUS, basicAuth } from './base.js';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../auth/crypto.js';

class PaymentProvider extends Provider {
  constructor(options) { super({ ...options, category: 'payments' }); }

  /** Payment methods this gateway can present. */
  get methods() { return ['upi', 'credit_card', 'debit_card', 'net_banking']; }

  async createOrder() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
  async verifyPayment() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
  async verifyWebhook() { return { valid: false, reason: 'not_implemented' }; }
  async refund() { return this.failure('Not implemented.', { code: 'not_implemented' }); }
}

// ===========================================================================
// RAZORPAY — the default for India: UPI, cards and net banking in one
// ===========================================================================

export class RazorpayProvider extends PaymentProvider {
  constructor(env) {
    super({
      key: 'razorpay',
      name: 'Razorpay',
      requiredKeys: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
      optionalKeys: ['RAZORPAY_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://razorpay.com/docs/api/',
    });
  }

  get methods() { return ['upi', 'credit_card', 'debit_card', 'net_banking', 'wallet', 'emi']; }

  get authHeader() {
    return basicAuth(this.env.RAZORPAY_KEY_ID, this.env.RAZORPAY_KEY_SECRET);
  }

  async createOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
    if (!this.isConfigured()) return this.notConfigured('start that payment');

    const res = await this.request('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
      body: JSON.stringify({
        amount: amountPaise,           // Razorpay works in paise natively
        currency,
        receipt: String(receipt).slice(0, 40),
        notes,
      }),
    });

    if (!res.ok) return this.failure(res.error, { code: 'razorpay_order_failed', raw: res.body });

    return this.success({
      orderId: res.body.id,
      amountPaise: res.body.amount,
      currency: res.body.currency,
      status: res.body.status,
      // What the browser checkout needs. The key id is public by design;
      // the secret never leaves the Worker.
      checkout: {
        provider: 'razorpay',
        key: this.env.RAZORPAY_KEY_ID,
        orderId: res.body.id,
        amount: res.body.amount,
        currency: res.body.currency,
      },
    }, { providerId: res.body.id, raw: res.body });
  }

  /** Razorpay signs `order_id|payment_id` with the key secret. */
  async verifyPayment({ orderId, paymentId, signature }) {
    if (!this.isConfigured()) return this.notConfigured('verify that payment');
    if (!orderId || !paymentId || !signature) {
      return this.failure('The payment confirmation was incomplete.', { code: 'missing_fields' });
    }

    const expected = await hmacSha256Hex(this.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`);
    if (!timingSafeEqual(expected, signature)) {
      return this.failure('The payment signature did not verify. This payment has not been accepted.', {
        code: 'signature_mismatch',
      });
    }

    // Signature verified — now confirm the gateway's own record of it.
    const res = await this.request(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'razorpay_fetch_failed', raw: res.body });

    const captured = res.body.status === 'captured' || res.body.status === 'authorized';
    if (!captured) {
      return this.failure(`Razorpay reports this payment as "${res.body.status}".`, {
        code: `razorpay_${res.body.status}`, raw: res.body,
      });
    }

    return this.success({
      paymentId: res.body.id,
      orderId: res.body.order_id,
      amountPaise: res.body.amount,
      method: normaliseMethod(res.body.method),
      status: res.body.status,
      email: res.body.email,
      contact: res.body.contact,
      capturedAt: res.body.created_at ? new Date(res.body.created_at * 1000).toISOString() : null,
    }, { status: RESULT_STATUS.OK, providerId: res.body.id, raw: res.body });
  }

  async verifyWebhook(rawBody, signature) {
    const secret = this.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const expected = await hmacSha256Hex(secret, rawBody);
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  async refund({ paymentId, amountPaise, notes = {} }) {
    if (!this.isConfigured()) return this.notConfigured('issue that refund');
    const res = await this.request(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader },
        body: JSON.stringify({ amount: amountPaise, notes }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'razorpay_refund_failed', raw: res.body });
    return this.success({
      refundId: res.body.id, amountPaise: res.body.amount, status: res.body.status,
    }, { providerId: res.body.id, raw: res.body });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request('https://api.razorpay.com/v1/payments?count=1', {
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return this.failure(res.error, { code: 'razorpay_test_failed', raw: res.body });
    return this.success({ reachable: true, keyId: this.env.RAZORPAY_KEY_ID });
  }
}

// ===========================================================================
// STRIPE
// ===========================================================================

export class StripeProvider extends PaymentProvider {
  constructor(env) {
    super({
      key: 'stripe',
      name: 'Stripe',
      requiredKeys: ['STRIPE_SECRET_KEY'],
      optionalKeys: ['STRIPE_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://stripe.com/docs/api',
    });
  }

  get methods() { return ['credit_card', 'debit_card', 'wallet']; }

  async createOrder({ amountPaise, currency = 'inr', receipt, notes = {} }) {
    if (!this.isConfigured()) return this.notConfigured('start that payment');

    const params = new URLSearchParams({
      amount: String(amountPaise),
      currency: String(currency).toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      description: `Invoice ${receipt}`,
    });
    for (const [k, v] of Object.entries(notes)) params.set(`metadata[${k}]`, String(v));

    const res = await this.request('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) return this.failure(res.error, { code: 'stripe_intent_failed', raw: res.body });
    return this.success({
      orderId: res.body.id,
      amountPaise: res.body.amount,
      currency: res.body.currency,
      status: res.body.status,
      checkout: { provider: 'stripe', clientSecret: res.body.client_secret, paymentIntentId: res.body.id },
    }, { providerId: res.body.id, raw: res.body });
  }

  async verifyPayment({ orderId }) {
    if (!this.isConfigured()) return this.notConfigured('verify that payment');
    const res = await this.request(
      `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` },
      });
    if (!res.ok) return this.failure(res.error, { code: 'stripe_fetch_failed', raw: res.body });
    if (res.body.status !== 'succeeded') {
      return this.failure(`Stripe reports this payment as "${res.body.status}".`, {
        code: `stripe_${res.body.status}`, raw: res.body,
      });
    }
    return this.success({
      paymentId: res.body.latest_charge ?? res.body.id,
      orderId: res.body.id,
      amountPaise: res.body.amount_received,
      method: 'credit_card',
      status: 'success',
    }, { providerId: res.body.id, raw: res.body });
  }

  /** Stripe's `t=…,v1=…` scheme over `timestamp.payload`. */
  async verifyWebhook(rawBody, signatureHeader) {
    const secret = this.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signatureHeader) return { valid: false, reason: 'missing_signature' };

    const parts = Object.fromEntries(
      String(signatureHeader).split(',').map(p => p.split('=').map(s => s.trim())));
    if (!parts.t || !parts.v1) return { valid: false, reason: 'malformed_signature' };

    // Reject anything older than five minutes to blunt replay.
    const age = Math.abs(Date.now() / 1000 - Number(parts.t));
    if (!Number.isFinite(age) || age > 300) return { valid: false, reason: 'timestamp_out_of_tolerance' };

    const expected = await hmacSha256Hex(secret, `${parts.t}.${rawBody}`);
    return { valid: timingSafeEqual(expected, parts.v1), reason: null };
  }

  async refund({ paymentId, amountPaise }) {
    if (!this.isConfigured()) return this.notConfigured('issue that refund');
    const res = await this.request('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ charge: paymentId, amount: String(amountPaise) }).toString(),
    });
    if (!res.ok) return this.failure(res.error, { code: 'stripe_refund_failed', raw: res.body });
    return this.success({ refundId: res.body.id, amountPaise: res.body.amount, status: res.body.status });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) return this.failure(res.error, { code: 'stripe_test_failed', raw: res.body });
    return this.success({ reachable: true, livemode: res.body?.livemode });
  }
}

// ===========================================================================
// CASHFREE
// ===========================================================================

export class CashfreeProvider extends PaymentProvider {
  constructor(env) {
    super({
      key: 'cashfree',
      name: 'Cashfree',
      requiredKeys: ['CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY'],
      optionalKeys: ['CASHFREE_WEBHOOK_SECRET'],
      env,
      docsUrl: 'https://docs.cashfree.com/reference',
    });
  }

  get baseUrl() {
    return String(this.env.APP_ENV) === 'production'
      ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-version': '2023-08-01',
      'x-client-id': this.env.CASHFREE_APP_ID,
      'x-client-secret': this.env.CASHFREE_SECRET_KEY,
    };
  }

  async createOrder({ amountPaise, currency = 'INR', receipt, customer = {}, returnUrl }) {
    if (!this.isConfigured()) return this.notConfigured('start that payment');

    const res = await this.request(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        order_id: String(receipt).slice(0, 45),
        order_amount: amountPaise / 100,           // Cashfree takes rupees
        order_currency: currency,
        customer_details: {
          customer_id: customer.id ?? `cust_${receipt}`,
          customer_name: customer.name ?? 'Client',
          customer_email: customer.email ?? 'billing@example.com',
          customer_phone: (customer.phone ?? '+919999999999').replace('+', ''),
        },
        order_meta: returnUrl ? { return_url: returnUrl } : undefined,
      }),
    });

    if (!res.ok) return this.failure(res.error, { code: 'cashfree_order_failed', raw: res.body });
    return this.success({
      orderId: res.body.order_id,
      amountPaise: Math.round((res.body.order_amount ?? 0) * 100),
      currency: res.body.order_currency,
      status: res.body.order_status,
      checkout: { provider: 'cashfree', paymentSessionId: res.body.payment_session_id, orderId: res.body.order_id },
    }, { providerId: res.body.order_id, raw: res.body });
  }

  async verifyPayment({ orderId }) {
    if (!this.isConfigured()) return this.notConfigured('verify that payment');
    const res = await this.request(`${this.baseUrl}/orders/${encodeURIComponent(orderId)}/payments`, {
      headers: this.headers,
    });
    if (!res.ok) return this.failure(res.error, { code: 'cashfree_fetch_failed', raw: res.body });

    const payments = Array.isArray(res.body) ? res.body : [];
    const paid = payments.find(p => p.payment_status === 'SUCCESS');
    if (!paid) {
      return this.failure('Cashfree has no successful payment against this order.', {
        code: 'cashfree_not_paid', raw: res.body,
      });
    }
    return this.success({
      paymentId: String(paid.cf_payment_id),
      orderId,
      amountPaise: Math.round((paid.payment_amount ?? 0) * 100),
      method: normaliseMethod(Object.keys(paid.payment_method ?? {})[0]),
      status: 'success',
    }, { providerId: String(paid.cf_payment_id), raw: paid });
  }

  async verifyWebhook(rawBody, signature, timestamp) {
    const secret = this.env.CASHFREE_WEBHOOK_SECRET;
    if (!secret) return { valid: false, reason: 'missing_secret' };
    if (!signature || !timestamp) return { valid: false, reason: 'missing_signature' };
    // Cashfree signs base64(HMAC-SHA256(timestamp + rawBody)).
    const { hmacSha256, toBase64Url } = await import('../auth/crypto.js');
    const mac = await hmacSha256(secret, `${timestamp}${rawBody}`);
    const expected = btoa(String.fromCharCode(...mac));
    return { valid: timingSafeEqual(expected, signature), reason: null };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(`${this.baseUrl}/orders/connection-test-probe`, { headers: this.headers });
    // A 404 for an unknown order still proves the credentials were accepted.
    if (res.httpStatus === 404) return this.success({ reachable: true, note: 'Credentials accepted.' });
    if (!res.ok) return this.failure(res.error, { code: 'cashfree_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

// ===========================================================================
// PHONEPE
// ===========================================================================

export class PhonePeProvider extends PaymentProvider {
  constructor(env) {
    super({
      key: 'phonepe',
      name: 'PhonePe',
      requiredKeys: ['PHONEPE_MERCHANT_ID', 'PHONEPE_SALT_KEY'],
      optionalKeys: ['PHONEPE_SALT_INDEX'],
      env,
      docsUrl: 'https://developer.phonepe.com/v1/reference',
    });
  }

  get methods() { return ['upi', 'credit_card', 'debit_card', 'net_banking', 'wallet']; }

  get baseUrl() {
    return String(this.env.APP_ENV) === 'production'
      ? 'https://api.phonepe.com/apis/hermes'
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  }

  get saltIndex() { return this.env.PHONEPE_SALT_INDEX || '1'; }

  /** PhonePe's X-VERIFY is sha256(base64Payload + path + saltKey) + "###" + saltIndex. */
  async #sign(base64Payload, path) {
    const digest = await sha256Hex(`${base64Payload}${path}${this.env.PHONEPE_SALT_KEY}`);
    return `${digest}###${this.saltIndex}`;
  }

  async createOrder({ amountPaise, receipt, customer = {}, returnUrl, callbackUrl }) {
    if (!this.isConfigured()) return this.notConfigured('start that payment');

    const payload = {
      merchantId: this.env.PHONEPE_MERCHANT_ID,
      merchantTransactionId: String(receipt).slice(0, 35),
      merchantUserId: customer.id ?? `user_${receipt}`,
      amount: amountPaise,
      redirectUrl: returnUrl,
      redirectMode: 'POST',
      callbackUrl,
      mobileNumber: (customer.phone ?? '').replace('+91', ''),
      paymentInstrument: { type: 'PAY_PAGE' },
    };

    const base64Payload = btoa(JSON.stringify(payload));
    const path = '/pg/v1/pay';
    const checksum = await this.#sign(base64Payload, path);

    const res = await this.request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VERIFY': checksum, accept: 'application/json' },
      body: JSON.stringify({ request: base64Payload }),
    });

    if (!res.ok || !res.body?.success) {
      return this.failure(res.error ?? res.body?.message ?? 'PhonePe rejected the order.', {
        code: 'phonepe_order_failed', raw: res.body,
      });
    }

    return this.success({
      orderId: payload.merchantTransactionId,
      amountPaise,
      status: 'created',
      checkout: {
        provider: 'phonepe',
        redirectUrl: res.body?.data?.instrumentResponse?.redirectInfo?.url,
        merchantTransactionId: payload.merchantTransactionId,
      },
    }, { providerId: payload.merchantTransactionId, raw: res.body });
  }

  async verifyPayment({ orderId }) {
    if (!this.isConfigured()) return this.notConfigured('verify that payment');
    const path = `/pg/v1/status/${this.env.PHONEPE_MERCHANT_ID}/${orderId}`;
    const checksum = await this.#sign('', path);

    const res = await this.request(`${this.baseUrl}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': checksum,
        'X-MERCHANT-ID': this.env.PHONEPE_MERCHANT_ID,
      },
    });
    if (!res.ok) return this.failure(res.error, { code: 'phonepe_fetch_failed', raw: res.body });

    const state = res.body?.data?.state ?? res.body?.code;
    if (state !== 'COMPLETED' && res.body?.code !== 'PAYMENT_SUCCESS') {
      return this.failure(`PhonePe reports this payment as "${state}".`, {
        code: `phonepe_${String(state).toLowerCase()}`, raw: res.body,
      });
    }

    return this.success({
      paymentId: res.body?.data?.transactionId ?? orderId,
      orderId,
      amountPaise: res.body?.data?.amount ?? 0,
      method: normaliseMethod(res.body?.data?.paymentInstrument?.type),
      status: 'success',
    }, { providerId: res.body?.data?.transactionId ?? orderId, raw: res.body });
  }

  async verifyWebhook(rawBody, signature) {
    if (!this.isConfigured()) return { valid: false, reason: 'missing_secret' };
    if (!signature) return { valid: false, reason: 'missing_signature' };
    const [provided] = String(signature).split('###');
    const expected = await sha256Hex(`${rawBody}${this.env.PHONEPE_SALT_KEY}`);
    return { valid: timingSafeEqual(expected, provided), reason: null };
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    // A status check for a transaction that cannot exist proves reachability
    // and that the checksum was accepted, without moving money.
    const result = await this.verifyPayment({ orderId: 'connection-test-probe' });
    if (result.status === 'not_configured') return result;
    return this.success({ reachable: true, note: 'Credentials accepted by PhonePe.' });
  }
}

// ===========================================================================

export const PAYMENT_PROVIDERS = {
  razorpay: RazorpayProvider,
  stripe: StripeProvider,
  cashfree: CashfreeProvider,
  phonepe: PhonePeProvider,
};

export const PAYMENT_PROVIDER_LIST = [
  { key: 'razorpay', name: 'Razorpay', region: 'India', recommended: true,
    methods: ['UPI', 'Credit card', 'Debit card', 'Net banking', 'Wallet', 'EMI'] },
  { key: 'stripe', name: 'Stripe', region: 'Global',
    methods: ['Credit card', 'Debit card', 'Wallet'] },
  { key: 'cashfree', name: 'Cashfree', region: 'India',
    methods: ['UPI', 'Credit card', 'Debit card', 'Net banking'] },
  { key: 'phonepe', name: 'PhonePe', region: 'India',
    methods: ['UPI', 'Credit card', 'Debit card', 'Net banking', 'Wallet'] },
];

/** Build a gateway by key, or the tenant's configured default. */
export function paymentProvider(key, env) {
  const Ctor = PAYMENT_PROVIDERS[key];
  if (!Ctor) return null;
  return new Ctor(env);
}

/** The first gateway that has credentials, preferring Razorpay. */
export function firstConfiguredProvider(env) {
  for (const key of ['razorpay', 'cashfree', 'phonepe', 'stripe']) {
    const provider = paymentProvider(key, env);
    if (provider?.isConfigured()) return provider;
  }
  return null;
}

/** Describe every gateway for the settings screen. */
export function describePaymentProviders(env) {
  return PAYMENT_PROVIDER_LIST.map(meta => {
    const provider = paymentProvider(meta.key, env);
    return { ...meta, ...provider.describe() };
  });
}

function normaliseMethod(raw) {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('upi')) return 'upi';
  if (value.includes('netbanking') || value.includes('net_banking')) return 'net_banking';
  if (value.includes('wallet')) return 'wallet';
  if (value.includes('emi')) return 'emi';
  if (value.includes('debit')) return 'debit_card';
  if (value.includes('card') || value.includes('credit')) return 'credit_card';
  return null;
}

export { normaliseMethod };
