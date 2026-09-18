import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, setPlan, firstTenantId, activateAddOn } from './helpers/app.js';

/**
 * A sweep across the whole API surface.
 *
 * Every GET route is called as a fully-entitled administrator. The point is
 * not to check business logic — the focused suites do that — but to catch the
 * failures that only appear at runtime: a column that does not exist, a
 * helper called with the wrong arguments, a permission key that was never
 * defined. A 500 anywhere here is a bug.
 *
 * It also asserts the negative: an unauthenticated caller gets 401 from every
 * one of them, and a client-role user is refused the staff-only ones.
 */
describe('API surface', () => {
  /** Every GET endpoint that needs no path parameters. */
  const GET_ROUTES = [
    '/api/auth/me',
    '/api/auth/sessions',
    '/api/auth/permissions-catalogue',
    '/api/clients',
    '/api/documents',
    '/api/documents/types/list',
    '/api/verification/queue',
    '/api/verification/stats',
    '/api/queries',
    '/api/tax/computations',
    '/api/tax/summary',
    '/api/tax/rules',
    '/api/reports',
    '/api/approvals',
    '/api/tasks',
    '/api/billing/subscription',
    '/api/billing/invoices',
    '/api/billing/payments',
    '/api/addons',
    '/api/calls',
    '/api/calls/settings',
    '/api/calls/live',
    '/api/calls/voicemails',
    '/api/calls/ivr',
    '/api/calls/analytics/overview',
    '/api/calls/analytics/performance',
    '/api/calls/analytics/reports',
    '/api/users',
    '/api/users/assignable-roles',
    '/api/companies',
    '/api/companies/switcher',
    '/api/branches',
    '/api/branches/performance',
    '/api/settings',
    '/api/settings/security',
    '/api/settings/views',
    '/api/dashboard',
    '/api/audit',
    '/api/audit/verify',
    '/api/notifications',
    '/api/notifications/unread-count',
    '/api/notifications/preferences',
    '/api/notifications/templates',
    '/api/notifications/deliveries',
    '/api/search?q=test',
    '/api/integrations',
    '/api/leads',
    '/api/leads/campaigns/list',
    '/api/leads/rules/list',
    '/api/messaging/threads',
    '/api/messaging/templates',
    '/api/messaging/broadcasts',
    '/api/automation',
    '/api/support',
    '/api/support/stats/overview',
    '/api/attendance',
    '/api/attendance/today',
    '/api/attendance/summary',
    '/api/calendar',
    '/api/esign',
    '/api/api-keys',
    '/api/branding',
    '/api/backups',
    '/api/ai/ocr',
    '/api/ai/verifications',
    '/api/ai/conversations',
    '/api/ai/insights',
    '/api/ai/status',
    '/api/analytics/datasets',
    '/api/analytics/dashboards',
    '/api/analytics/schedules',
    '/api/analytics/trends',
  ];

  /** Staff-only endpoints a client-role user must never reach. */
  const STAFF_ONLY = [
    '/api/users',
    '/api/audit',
    '/api/settings/security',
    '/api/integrations',
    '/api/leads',
    '/api/messaging/threads',
    '/api/automation',
    '/api/api-keys',
    '/api/backups',
    '/api/analytics/datasets',
    '/api/platform/tenants',
    '/api/platform/revenue',
    '/api/platform/logs',
  ];

  async function fullyEntitledApp() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'enterprise');

    // Every add-on active, so nothing in the sweep is skipped as locked and a
    // broken feature-gated route cannot hide behind a 402.
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const addOns = await db.many('SELECT key FROM add_ons');
    for (const a of addOns) await activateAddOn(app, tenantId, a.key);

    return { app, token: res.data.token, tenantId };
  }

  test('every GET endpoint answers without a server error', async () => {
    const { app, token } = await fullyEntitledApp();

    const failures = [];
    for (const path of GET_ROUTES) {
      const res = await app.request(path, { token });
      if (res.status >= 500) {
        failures.push(`${path} → ${res.status} ${res.error?.message ?? ''} (${res.error?.code ?? ''})`);
      } else if (res.status !== 200) {
        // A 402 or 403 is a decision, not a crash — but on a fully entitled
        // administrator it usually means a wrong permission key, so it is
        // reported too.
        failures.push(`${path} → ${res.status} ${res.error?.code ?? ''} ${res.error?.message ?? ''}`);
      }
    }

    assert.deepEqual(failures, [], `Endpoints did not answer 200:\n${failures.join('\n')}`);
  });

  test('every endpoint refuses an unauthenticated caller', async () => {
    const { app } = await fullyEntitledApp();

    const leaks = [];
    for (const path of GET_ROUTES) {
      const res = await app.request(path);
      if (res.status !== 401) leaks.push(`${path} → ${res.status}`);
    }
    assert.deepEqual(leaks, [], `Endpoints answered without authentication:\n${leaks.join('\n')}`);
  });

  test('a client-role user cannot reach staff-only endpoints', async () => {
    const { app, token } = await fullyEntitledApp();

    const client = await app.request('/api/clients', {
      method: 'POST', token,
      body: {
        displayName: 'Radiant Traders',
        companyName: 'Radiant Traders Private Limited',
        gstin: '33AACCN5678K1Z3',
        pan: 'AACCN5678K',
        contactName: 'Priya Sharma',
        contactEmail: 'priya@radianttraders.test',
        contactPhone: '9845012299',
        createPortalLogin: true,
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'priya@radianttraders.test', password: client.data.temporaryPassword },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const reachable = [];
    for (const path of STAFF_ONLY) {
      const res = await app.request(path, { token: login.data.token });
      if (res.status === 200) reachable.push(path);
    }
    assert.deepEqual(reachable, [],
      `A client-role user reached staff-only endpoints:\n${reachable.join('\n')}`);
  });

  test('an unknown endpoint and a wrong method both answer in the envelope', async () => {
    const { app, token } = await fullyEntitledApp();

    const unknown = await app.request('/api/not-a-real-endpoint', { token });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.success, false);
    assert.equal(unknown.error.code, 'not_found');

    const wrongMethod = await app.request('/api/audit/verify', { method: 'POST', token });
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.error.message, /does not accept POST/);
  });

  test('the health endpoint answers without authentication', async () => {
    const { app } = await fullyEntitledApp();
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');
  });
});
