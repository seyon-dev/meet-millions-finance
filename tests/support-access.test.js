import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole, firstTenantId } from './helpers/app.js';

/**
 * Platform support access.
 *
 * The properties under test are the ones that make support access safe rather
 * than a synonym for impersonation: the administrator's own identity is never
 * lost, every action inside the organisation is attributed to the
 * administrator, view mode cannot write, an exited session is dead, and a
 * suspended organisation stays closed to its own people while remaining
 * reachable for support.
 */
describe('Support access', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const orgToken = res.data.token;
    const orgAdmin = res.data.user;
    const tenantId = await firstTenantId(app);
    const platform = await createUserWithRole(app, {
      tenantId: null,
      email: 'owner@meetmillions.test',
      fullName: 'Priyanka Deshmukh',
      roleKey: 'super_admin',
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { app, tenantId, orgToken, orgAdmin, platform, platformToken: login.data.token };
  }

  async function openSupport(app, tenantId, orgAdmin, platformToken, mode = 'support') {
    const res = await app.request(`/api/platform/tenants/${tenantId}/impersonate`, {
      method: 'POST', token: platformToken,
      body: { userId: orgAdmin.id, reason: 'Investigating a billing report, ticket TKT-777.', mode },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  }

  test('a support session carries the administrator, and the original identity survives', async () => {
    const { app, tenantId, orgAdmin, platformToken } = await setup();

    const opened = await openSupport(app, tenantId, orgAdmin, platformToken);
    assert.equal(opened.mode, 'support');
    assert.ok(opened.token, 'a support token was minted');

    // The support session knows who really holds it.
    const me = await app.request('/api/auth/me', { token: opened.token });
    assert.equal(me.status, 200);
    assert.ok(me.data.supportAccess, '/me reports the support session');
    assert.equal(me.data.supportAccess.mode, 'support');
    assert.match(me.data.supportAccess.by, /owner@meetmillions\.test/);
    assert.ok(me.data.supportAccess.expiresAt, 'the session has an expiry');
    assert.ok(me.data.supportAccess.organisation, 'the target organisation is named');

    // The platform session was never touched — the original identity survives.
    const stillMe = await app.request('/api/auth/me', { token: platformToken });
    assert.equal(stillMe.status, 200);
    assert.equal(stillMe.data.supportAccess, null);
    assert.equal(stillMe.data.user.email, 'owner@meetmillions.test');
  });

  test('actions during support access are attributed to the administrator, not the person acted as', async () => {
    const { app, tenantId, orgAdmin, platform, platformToken } = await setup();
    const opened = await openSupport(app, tenantId, orgAdmin, platformToken);

    const change = await app.request('/api/settings/security', {
      method: 'PATCH', token: opened.token, body: { maxFailedLogins: 6 },
    });
    assert.equal(change.status, 200, JSON.stringify(change.body));

    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const entry = await db.one(
      `SELECT * FROM audit_logs WHERE tenant_id = ? AND action = 'security.policy_updated'
        ORDER BY sequence DESC LIMIT 1`, [tenantId]);
    assert.ok(entry, 'the change was audited');
    assert.equal(entry.actor_id, platform.userId, 'attributed to the administrator');
    assert.equal(entry.actor_role, 'super_admin');
    assert.match(entry.actor_name, /owner@meetmillions\.test/);
    const meta = JSON.parse(entry.metadata_json);
    assert.equal(meta.supportAccess.mode, 'support');
    assert.equal(meta.supportAccess.actingAs.email, orgAdmin.email, 'and says who was acted as');
  });

  test('view mode reads, and refuses every write except leaving', async () => {
    const { app, tenantId, orgAdmin, platformToken } = await setup();
    const opened = await openSupport(app, tenantId, orgAdmin, platformToken, 'view');
    assert.equal(opened.mode, 'view');

    const read = await app.request('/api/clients', { token: opened.token });
    assert.equal(read.status, 200, 'view mode can read');

    const write = await app.request('/api/settings/security', {
      method: 'PATCH', token: opened.token, body: { maxFailedLogins: 6 },
    });
    assert.equal(write.status, 403, 'view mode cannot write');
    assert.equal(write.error.details.reason, 'support_view_only');

    const exit = await app.request('/api/auth/support/exit', {
      method: 'POST', token: opened.token,
    });
    assert.equal(exit.status, 200, 'leaving is the one write view mode may perform');
  });

  test('an exited support session is dead, and the exit is audited on both trails', async () => {
    const { app, tenantId, orgAdmin, platformToken } = await setup();
    const opened = await openSupport(app, tenantId, orgAdmin, platformToken);

    const exit = await app.request('/api/auth/support/exit', {
      method: 'POST', token: opened.token,
    });
    assert.equal(exit.status, 200);
    assert.equal(exit.data.exited, true);

    const reuse = await app.request('/api/dashboard', { token: opened.token });
    assert.equal(reuse.status, 401, 'the token cannot be reused after exit');

    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const orgTrail = await db.one(
      `SELECT actor_role FROM audit_logs WHERE tenant_id = ? AND action = 'platform.impersonation_ended' LIMIT 1`,
      [tenantId]);
    const platformTrail = await db.one(
      `SELECT actor_role FROM audit_logs WHERE tenant_id IS NULL AND action = 'platform.impersonation_ended' LIMIT 1`);
    assert.ok(orgTrail, 'the organisation sees the exit in its own trail');
    assert.ok(platformTrail, 'and the platform records it too');

    // The platform session is still standing.
    const still = await app.request('/api/platform/tenants', { token: platformToken });
    assert.equal(still.status, 200);
  });

  test('a suspended organisation blocks its own people but not support access', async () => {
    const { app, tenantId, orgAdmin, platformToken } = await setup();

    const suspend = await app.request(`/api/platform/tenants/${tenantId}`, {
      method: 'PATCH', token: platformToken,
      body: { status: 'suspended', reason: 'Invoice unpaid for 60 days.' },
    });
    assert.equal(suspend.status, 200, JSON.stringify(suspend.body));

    // Its own administrator cannot sign in, and is told why in plain words.
    const blocked = await app.request('/api/auth/login', {
      method: 'POST', body: { email: orgAdmin.email, password: 'Str0ng-Passw0rd!24' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.error.details.reason, 'organisation_suspended');
    assert.match(blocked.error.message, /suspended/i);

    // The platform can still open a support session inside it.
    const opened = await openSupport(app, tenantId, orgAdmin, platformToken);
    const read = await app.request('/api/clients', { token: opened.token });
    assert.equal(read.status, 200, 'support access works inside the suspended organisation');

    const me = await app.request('/api/auth/me', { token: opened.token });
    assert.equal(me.data.supportAccess.organisationStatus, 'suspended', 'the state is visible');

    // Reactivation restores ordinary sign-in.
    const reactivate = await app.request(`/api/platform/tenants/${tenantId}`, {
      method: 'PATCH', token: platformToken, body: { status: 'active' },
    });
    assert.equal(reactivate.status, 200);
    const restored = await app.request('/api/auth/login', {
      method: 'POST', body: { email: orgAdmin.email, password: 'Str0ng-Passw0rd!24' },
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  });

  test('a cancelled organisation is blocked at sign-in with its own reason', async () => {
    const { app, tenantId, orgAdmin, platformToken } = await setup();
    const cancel = await app.request(`/api/platform/tenants/${tenantId}`, {
      method: 'PATCH', token: platformToken,
      body: { status: 'cancelled', reason: 'Organisation requested closure.' },
    });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

    const blocked = await app.request('/api/auth/login', {
      method: 'POST', body: { email: orgAdmin.email, password: 'Str0ng-Passw0rd!24' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.error.details.reason, 'organisation_cancelled');
  });

  test('an organisation admin cannot open support sessions, even into their own organisation', async () => {
    const { app, tenantId, orgAdmin, orgToken } = await setup();
    const res = await app.request(`/api/platform/tenants/${tenantId}/impersonate`, {
      method: 'POST', token: orgToken,
      body: { userId: orgAdmin.id, reason: 'Trying my luck from inside the organisation.' },
    });
    assert.equal(res.status, 403);
  });
});
