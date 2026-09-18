import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, setPlan, firstTenantId } from './helpers/app.js';

/**
 * Inbound webhooks.
 *
 * The property under test throughout: a payment only settles when a real HMAC
 * over the exact bytes we received matches the secret we hold. Everything else
 * — no secret, wrong secret, altered body, replayed event, mismatched amount —
 * leaves the invoice unpaid and says why.
 */
describe('Webhooks', () => {
  const WEBHOOK_SECRET = 'razorpay-test-webhook-secret-value';

  async function hmacHex(secret, body) {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** An organisation with an invoice and a pending Razorpay payment. */
  async function setup({ withSecret = true } = {}) {
    const app = await createApp({
      env: withSecret ? {
        RAZORPAY_KEY_ID: 'rzp_test_key',
        RAZORPAY_KEY_SECRET: 'rzp_test_secret',
        RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      } : {},
    });
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');

    const clientRes = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Kestrel Logistics',
        companyName: 'Kestrel Logistics Private Limited',
        gstin: '24AAJCB1357S1Z7',
        pan: 'AAJCB1357S',
        contactName: 'Imran Qureshi',
        contactEmail: 'imran@kestrellogistics.test',
        contactPhone: '9820044113',
      },
    });
    assert.equal(clientRes.status, 201, JSON.stringify(clientRes.body));

    const { Db } = await import('../src/db/client.js');
    const { ID } = await import('../src/utils/id.js');
    const { nowIso, addDays, dayKey } = await import('../src/utils/time.js');
    const db = new Db(app.env.DB);
    const ts = nowIso();

    const invoiceId = ID.invoice();
    await db.insert('invoices', {
      id: invoiceId, tenant_id: tenantId, client_id: clientRes.data.client.id,
      company_id: clientRes.data.company.id,
      invoice_no: 'INV-TEST-0001', direction: 'tenant_to_client', kind: 'service',
      status: 'sent', subtotal_paise: 2500000, tax_paise: 450000, total_paise: 2950000,
      amount_paid_paise: 0, amount_due_paise: 2950000,
      issue_date: dayKey(), due_date: dayKey(addDays(15)),
      created_at: ts, updated_at: ts,
    });

    const paymentId = ID.payment();
    await db.insert('payments', {
      id: paymentId, tenant_id: tenantId, invoice_id: invoiceId,
      client_id: clientRes.data.client.id,
      reference_no: 'PAY-TEST-0001', gateway: 'razorpay',
      amount_paise: 2950000, currency: 'INR', status: 'created',
      gateway_order_id: 'order_TESTORDER001',
      created_at: ts, updated_at: ts,
    });

    return { app, adminToken, tenantId, db, invoiceId, paymentId };
  }

  function capturedEvent({ orderId = 'order_TESTORDER001', amount = 2950000, id = 'evt_capture_001' } = {}) {
    return JSON.stringify({
      id,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_TESTPAYMENT001',
            order_id: orderId,
            amount,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    });
  }

  test('a correctly signed capture settles the payment and the invoice', async () => {
    const { app, db, invoiceId, paymentId } = await setup();
    const body = capturedEvent();

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body) },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'processed');

    const payment = await db.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'success');
    assert.equal(payment.gateway_payment_id, 'pay_TESTPAYMENT001');
    assert.ok(payment.paid_at, 'the settlement time was recorded');
    assert.ok(payment.receipt_no, 'a receipt number was issued');

    const invoice = await db.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.status, 'paid');
    assert.equal(invoice.amount_paid_paise, 2950000);
    assert.equal(invoice.amount_due_paise, 0);

    // The settlement is in the audit chain, attributed to the webhook rather
    // than to a person who was not there.
    const entry = await db.one(
      "SELECT * FROM audit_logs WHERE action = 'payments.succeeded' ORDER BY created_at DESC LIMIT 1");
    assert.ok(entry, 'the settlement was audited');
    assert.equal(entry.actor_type, 'system');
    assert.equal(entry.actor_name, 'webhook:razorpay');
    assert.equal(entry.actor_id, null);
  });

  test('a forged signature settles nothing', async () => {
    const { app, db, invoiceId, paymentId } = await setup();
    const body = capturedEvent();

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': await hmacHex('the-wrong-secret', body),
      },
    });
    assert.equal(res.status, 200, 'the sender is told we received it, not that it worked');
    assert.equal(res.body.status, 'rejected');

    const payment = await db.one('SELECT status FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'created', 'the payment is untouched');
    const invoice = await db.one('SELECT status, amount_due_paise FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.status, 'sent');
    assert.equal(invoice.amount_due_paise, 2950000);

    // The attempt is on record.
    const event = await db.one(
      "SELECT * FROM webhook_events WHERE source = 'razorpay' ORDER BY received_at DESC LIMIT 1");
    assert.equal(event.signature_status, 'invalid');
    assert.equal(event.status, 'failed');
  });

  test('a body altered after signing is rejected', async () => {
    const { app, db, paymentId } = await setup();
    const original = capturedEvent();
    const signature = await hmacHex(WEBHOOK_SECRET, original);

    // Same event, but the amount has been raised in transit.
    const tampered = capturedEvent({ amount: 99500000 });

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body: tampered,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    });
    assert.equal(res.body.status, 'rejected');

    const payment = await db.one('SELECT status FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'created');
  });

  test('with no webhook secret configured, nothing is applied', async () => {
    const { app, db, paymentId } = await setup({ withSecret: false });
    const body = capturedEvent();

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body) },
    });
    assert.equal(res.body.status, 'rejected');
    assert.equal(res.body.reason, 'missing_secret');

    const payment = await db.one('SELECT status FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'created');

    const event = await db.one(
      "SELECT * FROM webhook_events WHERE source = 'razorpay' ORDER BY received_at DESC LIMIT 1");
    assert.equal(event.signature_status, 'missing_secret');
    assert.match(event.error_message, /No webhook secret is configured/);
  });

  test('a replayed event is recognised and changes nothing twice', async () => {
    const { app, db, invoiceId } = await setup();
    const body = capturedEvent();
    const signature = await hmacHex(WEBHOOK_SECRET, body);
    const headers = { 'Content-Type': 'application/json', 'x-razorpay-signature': signature };

    const first = await app.request('/webhooks/payments/razorpay', { method: 'POST', body, headers });
    assert.equal(first.body.status, 'processed');

    const second = await app.request('/webhooks/payments/razorpay', { method: 'POST', body, headers });
    assert.equal(second.body.status, 'duplicate');

    // Exactly one payment row, and the invoice was not paid twice.
    const payments = await db.many("SELECT * FROM payments WHERE status = 'success'");
    assert.equal(payments.length, 1);
    const invoice = await db.one('SELECT amount_paid_paise FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.amount_paid_paise, 2950000, 'not doubled');
  });

  test('a captured amount that disagrees with the payment is disputed, not accepted', async () => {
    const { app, db, invoiceId, paymentId } = await setup();
    // Correctly signed, but the gateway reports a smaller capture than we expect.
    const body = capturedEvent({ amount: 1000, id: 'evt_capture_short' });

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body) },
    });
    assert.equal(res.body.status, 'failed');

    const payment = await db.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'disputed');
    assert.equal(payment.failure_code, 'amount_mismatch');

    const invoice = await db.one('SELECT status, amount_due_paise FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.status, 'sent', 'the invoice stays unpaid');
    assert.equal(invoice.amount_due_paise, 2950000);

    const entry = await db.one(
      "SELECT severity FROM audit_logs WHERE action = 'payments.failed' ORDER BY created_at DESC LIMIT 1");
    assert.equal(entry.severity, 'critical');
  });

  test('a failure event marks the payment failed without touching the invoice', async () => {
    const { app, db, invoiceId, paymentId } = await setup();
    const body = JSON.stringify({
      id: 'evt_failed_001',
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_FAILED001', order_id: 'order_TESTORDER001', amount: 2950000,
            status: 'failed', error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment was not completed by the customer.',
          },
        },
      },
    });

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body) },
    });
    assert.equal(res.body.status, 'processed');

    const payment = await db.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
    assert.equal(payment.status, 'failed');
    assert.equal(payment.failure_code, 'BAD_REQUEST_ERROR');
    assert.match(payment.failure_reason, /not completed by the customer/);

    const invoice = await db.one('SELECT status FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.status, 'sent');
  });

  test('an event for an unknown order is stored and ignored', async () => {
    const { app, db } = await setup();
    const body = capturedEvent({ orderId: 'order_NOT_OURS', id: 'evt_unknown_001' });

    const res = await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body) },
    });
    assert.equal(res.body.status, 'ignored');

    const event = await db.one(
      "SELECT * FROM webhook_events WHERE event_id = 'evt_unknown_001'");
    assert.equal(event.signature_status, 'valid');
    assert.equal(event.status, 'ignored');
  });

  test('stored webhook payloads never include credentials from the headers', async () => {
    const { app, db } = await setup();
    const body = capturedEvent({ id: 'evt_headers_001' });

    await app.request('/webhooks/payments/razorpay', {
      method: 'POST', body,
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': await hmacHex(WEBHOOK_SECRET, body),
        Authorization: 'Bearer super-secret-token-value',
      },
    });

    const event = await db.one("SELECT headers_json FROM webhook_events WHERE event_id = 'evt_headers_001'");
    const headers = JSON.parse(event.headers_json);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-razorpay-signature'], undefined);
    assert.ok(headers['content-type'], 'the harmless ones are kept');
    assert.ok(!event.headers_json.includes('super-secret-token-value'));
  });

  test('the WhatsApp verification handshake needs the configured token', async () => {
    const app = await createApp({ env: { WHATSAPP_VERIFY_TOKEN: 'verify-me-123' } });

    const wrong = await app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc', { raw: true });
    assert.equal(wrong.status, 403);

    const right = await app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=abc123',
      { raw: true });
    assert.equal(right.status, 200);
    assert.equal(await right.text(), 'abc123');
  });

  test('an unconfigured WhatsApp endpoint says so instead of accepting anything', async () => {
    const app = await createApp();
    const res = await app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=abc', { raw: true });
    assert.equal(res.status, 503);
  });

  test('a website form submission with an unknown key captures no lead', async () => {
    const { app, db } = await setup();

    const res = await app.request('/webhooks/forms/not-a-real-endpoint', {
      method: 'POST',
      body: JSON.stringify({ name: 'Somebody', email: 'somebody@example.test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.body.status, 'rejected');
    assert.equal(res.body.reason, 'unknown_endpoint');

    const leads = await db.many('SELECT id FROM leads');
    assert.equal(leads.length, 0);
  });

  test('a website form submission on a real endpoint captures a cleaned lead', async () => {
    const { app, db, tenantId } = await setup();
    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const ts = nowIso();

    await db.insert('webhook_endpoints', {
      id: ID.endpoint(), tenant_id: tenantId, name: 'Contact form',
      slug: 'frm_publictestkey', kind: 'website_form', target_entity: 'lead',
      is_active: 1, request_count: 0, created_at: ts, updated_at: ts,
    });

    const res = await app.request('/webhooks/forms/frm_publictestkey', {
      method: 'POST',
      body: 'name=Ritu+Bansal&email=ritu%40example.test&phone=9812345670&message=Need+GST+filing+help',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(res.body.status, 'processed', JSON.stringify(res.body));

    const lead = await db.one('SELECT * FROM leads LIMIT 1');
    assert.equal(lead.full_name, 'Ritu Bansal');
    assert.equal(lead.email, 'ritu@example.test');
    assert.equal(lead.source, 'website_form');
    assert.equal(lead.status, 'new');

    const endpoint = await db.one(
      "SELECT request_count FROM webhook_endpoints WHERE slug = 'frm_publictestkey'");
    assert.equal(endpoint.request_count, 1);
  });
});
