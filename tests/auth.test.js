import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, login } from './helpers/app.js';

describe('Authentication', () => {
  test('health endpoint responds before any auth', async () => {
    const app = await createApp();
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'ok');
  });

  test('registration creates an organisation, company, admin user and subscription', async () => {
    const app = await createApp();
    const { res } = await registerOrg(app);

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.data.token, 'a session token is returned');
    assert.equal(res.data.landing, '/admin/dashboard');
    assert.equal(res.data.user.email, 'asha@meridiantax.test');
    assert.deepEqual(res.data.user.roles.map(r => r.key), ['admin']);

    const tenant = await app.DB.prepare('SELECT * FROM tenants').first();
    assert.equal(tenant.name, 'Meridian Tax Associates');
    assert.equal(tenant.gstin, '33AABCR1234M1ZK');

    const company = await app.DB.prepare('SELECT * FROM companies').first();
    assert.equal(company.gstin, '33AABCR1234M1ZK');
    assert.equal(company.pan, 'AABCR1234M');
    assert.equal(company.tan, 'CHEN12345A');

    const sub = await app.DB.prepare(
      'SELECT s.*, p.key AS plan_key FROM subscriptions s JOIN plans p ON p.id = s.plan_id').first();
    assert.equal(sub.plan_key, 'basic');
    assert.equal(sub.status, 'active');

    const branch = await app.DB.prepare('SELECT * FROM branches').first();
    assert.equal(branch.is_head_office, 1);
  });

  test('registration rejects a weak password and an invalid GSTIN', async () => {
    const app = await createApp();

    const weak = await app.request('/api/auth/register', {
      method: 'POST',
      body: { organisationName: 'Test Firm', fullName: 'Test User', email: 'a@b.test', password: 'password' },
    });
    assert.equal(weak.status, 422);
    assert.ok(weak.error.details.fields.password);

    const badGstin = await app.request('/api/auth/register', {
      method: 'POST',
      body: {
        organisationName: 'Test Firm', fullName: 'Test User', email: 'a@b.test',
        password: 'Str0ng-Passw0rd!24', gstin: '99XXXXX0000X0X0',
      },
    });
    assert.equal(badGstin.status, 422);
    assert.ok(badGstin.error.details.fields.gstin);
  });

  test('a duplicate email is refused', async () => {
    const app = await createApp();
    await registerOrg(app);
    const second = await registerOrg(app, { organisationName: 'Another Firm' });
    assert.equal(second.res.status, 409);
  });

  test('sign-in succeeds and /me returns the full bootstrap payload', async () => {
    const app = await createApp();
    const { payload } = await registerOrg(app);

    const res = await login(app, payload.email, payload.password);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.status, 'authenticated');

    const me = await app.request('/api/auth/me', { token: res.data.token });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, payload.email);
    assert.equal(me.data.tenant.name, 'Meridian Tax Associates');
    assert.ok(me.data.permissions.length > 50, 'admin carries a broad permission set');
    assert.ok(me.data.navigation.groups.length > 0, 'navigation is built');
    assert.ok(me.data.entitlements.features.includes('document_upload'));
    assert.ok(!me.data.entitlements.features.includes('ocr_ai'), 'Basic plan does not include OCR');
    assert.equal(me.data.companies.length, 1);
  });

  test('a wrong password is rejected with the same message as an unknown account', async () => {
    const app = await createApp();
    const { payload } = await registerOrg(app);

    const wrongPassword = await login(app, payload.email, 'Completely-Wrong-1!');
    const unknownUser = await login(app, 'nobody@nowhere.test', 'Completely-Wrong-1!');

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.equal(wrongPassword.error.message, unknownUser.error.message);
    assert.equal(wrongPassword.error.code, 'invalid_credentials');
  });

  test('repeated failures lock the account per the security policy', async () => {
    const app = await createApp();
    const { payload } = await registerOrg(app);

    let last;
    for (let i = 0; i < 5; i++) {
      last = await login(app, payload.email, `Wrong-Password-${i}!`);
    }
    assert.equal(last.status, 403);
    assert.match(last.error.message, /locked/i);

    // Even the correct password is refused while the lock holds.
    const correct = await login(app, payload.email, payload.password);
    assert.equal(correct.status, 403);
  });

  test('an unauthenticated request to a protected route is refused', async () => {
    const app = await createApp();
    const res = await app.request('/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.error.code, 'auth_required');
    assert.equal(res.body.success, false);
    assert.equal(res.body.data, null);
  });

  test('a tampered token is refused', async () => {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const token = res.data.token;
    const tampered = token.slice(0, -4) + 'aaaa';

    const bad = await app.request('/api/auth/me', { token: tampered });
    assert.equal(bad.status, 401);
  });

  test('sign-out revokes the session immediately', async () => {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const token = res.data.token;

    assert.equal((await app.request('/api/auth/me', { token })).status, 200);
    const out = await app.request('/api/auth/logout', { method: 'POST', token });
    assert.equal(out.status, 200);
    assert.equal((await app.request('/api/auth/me', { token })).status, 401);
  });

  test('every response follows the { success, data, error, meta } contract', async () => {
    const app = await createApp();
    const good = await app.request('/api/auth/register', {
      method: 'POST',
      body: { organisationName: 'Contract Co', fullName: 'Contract User',
              email: 'contract@test.test', password: 'Str0ng-Passw0rd!24' },
    });
    for (const key of ['success', 'data', 'error', 'meta']) {
      assert.ok(key in good.body, `success response has ${key}`);
    }
    assert.equal(good.body.success, true);
    assert.equal(good.body.error, null);
    assert.ok(good.body.meta.timestamp);

    const bad = await app.request('/api/auth/me');
    for (const key of ['success', 'data', 'error', 'meta']) {
      assert.ok(key in bad.body, `error response has ${key}`);
    }
    assert.equal(bad.body.success, false);
    assert.equal(bad.body.data, null);
    assert.ok(bad.body.error.code);
  });

  test('an unknown endpoint returns a 404 in the same envelope', async () => {
    const app = await createApp();
    const res = await app.request('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.error.code, 'not_found');
  });
});
