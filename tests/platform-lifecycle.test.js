import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole, firstTenantId } from './helpers/app.js';

/**
 * The subscription lifecycle from the platform owner's chair.
 *
 * Extending, adjusting, recording payments and sending reminders all leave a
 * durable trail in subscription_events; the scheduler moves subscriptions
 * through trial end -> past_due (grace) -> expired without any human, and an
 * expired subscription loses its paid features but never its data.
 */
describe('Platform subscription lifecycle', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const orgToken = res.data.token;
    const tenantId = await firstTenantId(app);
    const platform = await createUserWithRole(app, {
      tenantId: null, email: 'owner@meetmillions.test', fullName: 'Priyanka Deshmukh', roleKey: 'super_admin',
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { app, tenantId, orgToken, platformToken: login.data.token };
  }

  async function db(app) {
    const { Db } = await import('../src/db/client.js');
    return new Db(app.env.DB);
  }

  test('a platform-created owner cannot keep the temporary password', async () => {
    const { app, platformToken } = await setup();
    const res = await app.request('/api/platform/tenants', {
      method: 'POST', token: platformToken,
      body: { name: 'Harbourline Advisors', ownerName: 'Nikhil Bose', ownerEmail: 'nikhil@harbourline.test', planKey: 'standard' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.data.temporaryPassword, 'the one-time password is returned once');

    const d = await db(app);
    const owner = await d.one('SELECT must_change_password FROM users WHERE email = ?', ['nikhil@harbourline.test']);
    assert.equal(Number(owner.must_change_password), 1, 'first sign-in forces a real password');
  });

  test('extending a subscription moves the period and lands in the ledger', async () => {
    const { app, tenantId, platformToken } = await setup();
    const d = await db(app);
    const before = await d.one('SELECT * FROM subscriptions WHERE tenant_id = ?', [tenantId]);

    const res = await app.request(`/api/platform/tenants/${tenantId}/subscription`, {
      method: 'PATCH', token: platformToken,
      body: { extendDays: 30, note: 'Goodwill extension after the outage.' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(new Date(res.data.subscription.current_period_end) > new Date(before.current_period_end),
      'the period end moved forward');

    const event = await d.one(
      "SELECT * FROM subscription_events WHERE tenant_id = ? AND kind = 'period_extended'", [tenantId]);
    assert.ok(event, 'the extension is in the ledger');
    assert.match(event.note, /Goodwill/);
  });

  test('a manual payment settles a platform invoice', async () => {
    const { app, tenantId, platformToken } = await setup();
    const d = await db(app);
    const { ID } = await import('../src/utils/id.js');
    const { nowIso, addDays } = await import('../src/utils/time.js');

    const sub = await d.one('SELECT id FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    const invoiceId = ID.invoice ? ID.invoice() : `inv_${Date.now()}`;
    await d.insert('invoices', {
      id: invoiceId, tenant_id: tenantId, subscription_id: sub.id,
      invoice_no: 'MM-2026-0042', direction: 'platform_to_tenant', kind: 'subscription',
      status: 'issued', currency: 'INR',
      subtotal_paise: 299900, total_paise: 299900, amount_paid_paise: 0, amount_due_paise: 299900,
      issue_date: nowIso(), due_date: addDays(15), created_at: nowIso(), updated_at: nowIso(),
    });

    const res = await app.request(`/api/platform/tenants/${tenantId}/payments`, {
      method: 'POST', token: platformToken,
      body: { amountPaise: 299900, method: 'bank_transfer', reference: 'NEFT-8891', invoiceId },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const invoice = await d.one('SELECT status, amount_due_paise FROM invoices WHERE id = ?', [invoiceId]);
    assert.equal(invoice.status, 'paid');
    assert.equal(Number(invoice.amount_due_paise), 0);

    const event = await d.one(
      "SELECT * FROM subscription_events WHERE tenant_id = ? AND kind = 'payment_recorded'", [tenantId]);
    assert.ok(event);
    assert.equal(JSON.parse(event.new_value_json).reference, 'NEFT-8891');
  });

  test('a platform reminder reaches the administrators and is remembered', async () => {
    const { app, tenantId, platformToken } = await setup();
    const d = await db(app);

    const res = await app.request(`/api/platform/tenants/${tenantId}/notify`, {
      method: 'POST', token: platformToken,
      body: { kind: 'payment_reminder', message: 'Invoice MM-2026-0042 is due this Friday.' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.data.recipients >= 1, 'somebody was notified');

    const note = await d.one(
      "SELECT * FROM notifications WHERE tenant_id = ? AND trigger_key = 'platform.payment_reminder'",
      [tenantId]);
    assert.ok(note, 'the reminder is in their notification centre');

    const event = await d.one(
      "SELECT * FROM subscription_events WHERE tenant_id = ? AND kind = 'reminder_sent'", [tenantId]);
    assert.ok(event, 'and the ledger remembers it was sent');
  });

  test('the scheduler walks trial end -> past_due (grace) -> expired, and renews auto-renewing periods', async () => {
    const { app, tenantId } = await setup();
    const d = await db(app);
    const { addDays } = await import('../src/utils/time.js');
    const { flagSubscriptionRenewals } = await import('../src/services/scheduler.js');

    // Put the subscription at the end of its trial, in the past.
    await d.run(
      `UPDATE subscriptions SET status = 'trialing', trial_ends_at = ?, auto_renew = 1 WHERE tenant_id = ?`,
      [addDays(-1), tenantId]);
    let out = await flagSubscriptionRenewals(app.env);
    assert.ok(out.dunned >= 1, 'the ended trial was moved to past_due');

    let sub = await d.one('SELECT status, grace_until FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    assert.equal(sub.status, 'past_due');
    assert.ok(sub.grace_until, 'with a grace window');

    const dunNote = await d.one(
      "SELECT id FROM notifications WHERE tenant_id = ? AND trigger_key = 'platform.trial_reminder'", [tenantId]);
    assert.ok(dunNote, 'the administrators were told the trial ended');

    // Let the grace window lapse.
    await d.run('UPDATE subscriptions SET grace_until = ? WHERE tenant_id = ?', [addDays(-1), tenantId]);
    out = await flagSubscriptionRenewals(app.env);
    sub = await d.one('SELECT status FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    assert.equal(sub.status, 'expired', 'grace over, subscription expired');

    // An active auto-renewing subscription simply rolls forward.
    await d.run(
      `UPDATE subscriptions SET status = 'active', auto_renew = 1, grace_until = NULL,
              current_period_end = ? WHERE tenant_id = ?`,
      [addDays(-1), tenantId]);
    out = await flagSubscriptionRenewals(app.env);
    assert.ok(out.renewed >= 1);
    sub = await d.one('SELECT status, current_period_end FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    assert.equal(sub.status, 'active');
    assert.ok(new Date(sub.current_period_end) > new Date(), 'the period advanced');

    const events = await d.many(
      "SELECT kind FROM subscription_events WHERE tenant_id = ? ORDER BY created_at", [tenantId]);
    const kinds = events.map(e => e.kind);
    assert.ok(kinds.includes('status_changed') && kinds.includes('renewed'),
      `the ledger tells the story: ${kinds.join(', ')}`);
  });

  test('an expired subscription loses its paid features but keeps its data', async () => {
    const { app, tenantId, orgToken, platformToken } = await setup();

    // Give the organisation a paid plan through the REAL platform endpoint —
    // the one that used to 500 on columns subscriptions never had.
    const up = await app.request(`/api/platform/tenants/${tenantId}/plan`, {
      method: 'POST', token: platformToken, body: { planKey: 'pro' },
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));

    const before = await app.request('/api/auth/me', { token: orgToken });
    assert.equal(before.data.entitlements.planKey, 'pro');
    assert.ok(before.data.entitlements.features.includes('gst_reports'),
      'a paid feature is on while the plan is live');

    // ...then expire it from the platform.
    const drop = await app.request(`/api/platform/tenants/${tenantId}/subscription`, {
      method: 'PATCH', token: platformToken, body: { status: 'expired', note: 'Non-payment.' },
    });
    assert.equal(drop.status, 200, JSON.stringify(drop.body));

    const after = await app.request('/api/auth/me', { token: orgToken });
    assert.equal(after.data.entitlements.planKey, 'basic',
      'entitlements collapse to the free tier');
    assert.ok(!after.data.entitlements.features.includes('gst_reports'),
      'the paid feature is gone');

    // And the paywall answers 402 with the upgrade path, not a silent 403.
    const gated = await app.request('/api/reports', {
      method: 'POST', token: orgToken, body: { type: 'gst_summary' },
    });
    assert.equal(gated.status, 402, JSON.stringify(gated.body));

    // Core data was never touched: their clients still answer.
    const clients = await app.request('/api/clients', { token: orgToken });
    assert.equal(clients.status, 200, 'core records remain readable');
  });
});
