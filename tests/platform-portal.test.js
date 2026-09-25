import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole } from './helpers/app.js';

/**
 * The platform entrance.
 *
 * Two doors that never blur: the platform account is refused at the public
 * sign-in, an organisation account is refused at the platform entrance, and
 * neither refusal reveals anything to somebody without the password. On a
 * deployment with no owner, the entrance offers a one-time claim that closes
 * itself the moment an owner exists, wherever that owner came from.
 */
describe('Platform entrance', () => {
  test('an unclaimed platform reports itself, and the claim creates the owner exactly once', async () => {
    const app = await createApp();

    const before = await app.request('/api/auth/platform-status');
    assert.equal(before.status, 200);
    assert.equal(before.data.claimed, false, 'a fresh deployment is unclaimed');

    const weak = await app.request('/api/auth/platform-setup', {
      method: 'POST',
      body: { fullName: 'Rohan Verma', email: 'owner@platform.test', password: 'short' },
    });
    assert.equal(weak.status, 422, 'a weak password is refused for the most powerful account');

    const claim = await app.request('/api/auth/platform-setup', {
      method: 'POST',
      body: { fullName: 'Rohan Verma', email: 'owner@platform.test', password: 'Claim-The-Keys!2026x' },
    });
    assert.equal(claim.status, 201, JSON.stringify(claim.body));
    assert.ok(claim.data.token, 'the claim signs the owner straight in');

    const after = await app.request('/api/auth/platform-status');
    assert.equal(after.data.claimed, true);

    const second = await app.request('/api/auth/platform-setup', {
      method: 'POST',
      body: { fullName: 'Somebody Else', email: 'other@platform.test', password: 'Another-Str0ng-Pass!26' },
    });
    assert.equal(second.status, 409, 'the claim never works twice');

    // The claimed owner reaches the platform, through the portal.
    const whoami = await app.request('/api/auth/me', { token: claim.data.token });
    assert.equal(whoami.data.user.email, 'owner@platform.test');
    const tenants = await app.request('/api/platform/tenants', { token: claim.data.token });
    assert.equal(tenants.status, 200, JSON.stringify(tenants.body));

    // And the claim is in the platform audit trail.
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const entry = await db.one(
      "SELECT actor_name FROM audit_logs WHERE tenant_id IS NULL AND action = 'platform.owner_claimed' LIMIT 1");
    assert.ok(entry, 'claiming the platform is audited');
  });

  test('the two doors are exclusive, in both directions', async () => {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const orgEmail = res.data.user.email;
    const platform = await createUserWithRole(app, {
      tenantId: null, email: 'owner@meetmillions.test', fullName: 'Priyanka Deshmukh', roleKey: 'super_admin',
    });

    // The platform account at the public door: refused, but only AFTER the
    // password verified — a wrong password still gets the generic answer.
    const publicDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password },
    });
    assert.equal(publicDoor.status, 403);
    assert.equal(publicDoor.error.details.reason, 'platform_portal_required');
    assert.ok(!publicDoor.error.message.includes('platform-access'), 'the refusal never names the path');

    const wrongPassword = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: 'not-the-password-1A' },
    });
    assert.equal(wrongPassword.status, 401, 'a wrong password reveals nothing about the account');

    // The organisation account at the platform door: refused the same way.
    const platformDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: orgEmail, password: 'Str0ng-Passw0rd!24', portal: 'platform' },
    });
    assert.equal(platformDoor.status, 403);
    assert.equal(platformDoor.error.details.reason, 'not_platform_account');

    // Each door works for its own side.
    const rightDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password, portal: 'platform' },
    });
    assert.equal(rightDoor.status, 200, JSON.stringify(rightDoor.body));
    const orgDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: orgEmail, password: 'Str0ng-Passw0rd!24' },
    });
    assert.equal(orgDoor.status, 200, JSON.stringify(orgDoor.body));
  });

  test('an existing owner closes the claim, wherever the owner came from', async () => {
    const app = await createApp();
    await createUserWithRole(app, {
      tenantId: null, email: 'owner@meetmillions.test', fullName: 'Priyanka Deshmukh', roleKey: 'super_admin',
    });
    const status = await app.request('/api/auth/platform-status');
    assert.equal(status.data.claimed, true);
    const claim = await app.request('/api/auth/platform-setup', {
      method: 'POST',
      body: { fullName: 'Intruder', email: 'intruder@example.test', password: 'Sneaky-Str0ng-Pass!26' },
    });
    assert.equal(claim.status, 409);
  });
});

describe('Your own account', () => {
  test('the platform owner edits their name and sign-in email from their own account', async () => {
    const app = await createApp();
    const platform = await createUserWithRole(app, {
      tenantId: null, email: 'owner@meetmillions.test', fullName: 'Priyanka Deshmukh', roleKey: 'super_admin',
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password, portal: 'platform' },
    });
    const token = login.data.token;

    // The name saves — this used to die on scope_missing_tenant, because the
    // profile screen went through the tenant-scoped /users/:id route.
    const rename = await app.request('/api/auth/profile', {
      method: 'PATCH', token, body: { fullName: 'Priyanka D.' },
    });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(rename.data.user.fullName, 'Priyanka D.');

    // The email will not move without the password...
    const unproven = await app.request('/api/auth/profile', {
      method: 'PATCH', token, body: { email: 'keys@meetmillions.test' },
    });
    assert.equal(unproven.status, 422);
    const wrong = await app.request('/api/auth/profile', {
      method: 'PATCH', token, body: { email: 'keys@meetmillions.test', currentPassword: 'not-it-1Aa' },
    });
    assert.equal(wrong.status, 422);

    // ...and moves with it, after which the OLD address is dead and the new
    // one signs in at the platform entrance.
    const moved = await app.request('/api/auth/profile', {
      method: 'PATCH', token, body: { email: 'keys@meetmillions.test', currentPassword: platform.password },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const oldDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: platform.email, password: platform.password, portal: 'platform' },
    });
    assert.equal(oldDoor.status, 401, 'the old address no longer signs in');
    const newDoor = await app.request('/api/auth/login', {
      method: 'POST', body: { email: 'keys@meetmillions.test', password: platform.password, portal: 'platform' },
    });
    assert.equal(newDoor.status, 200, JSON.stringify(newDoor.body));

    // And the change is audited with both addresses.
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const entry = await db.one("SELECT old_value_json, new_value_json FROM audit_logs WHERE action = 'auth.email_changed' LIMIT 1");
    assert.ok(entry, 'the email change is in the trail');
    assert.match(entry.old_value_json, /owner@meetmillions\.test/);
  });

  test('an organisation user gets the same self-service, inside their own walls', async () => {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const token = res.data.token;

    const rename = await app.request('/api/auth/profile', {
      method: 'PATCH', token, body: { fullName: 'Asha M.' },
    });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));

    // A colleague's address cannot be taken.
    const { createUserWithRole } = await import('./helpers/app.js');
    const { firstTenantId } = await import('./helpers/app.js');
    const tenantId = await firstTenantId(app);
    await createUserWithRole(app, {
      tenantId, email: 'taken@meridiantax.test', fullName: 'Vikram Rao', roleKey: 'accountant',
    });
    const clash = await app.request('/api/auth/profile', {
      method: 'PATCH', token,
      body: { email: 'taken@meridiantax.test', currentPassword: 'Str0ng-Passw0rd!24' },
    });
    assert.equal(clash.status, 409);
  });
});
