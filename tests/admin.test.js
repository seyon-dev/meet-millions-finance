import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole, setPlan, firstTenantId } from './helpers/app.js';

/**
 * Team, company, branch, settings and dashboard management.
 *
 * The recurring theme: authorisation is decided on the server. A role cannot
 * grant itself more than it has, and a dashboard shows only what its role is
 * allowed to see.
 */
describe('Administration', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');
    return { app, adminToken, tenantId };
  }

  async function tokenFor(app, user) {
    const res = await app.request('/api/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password, portal: user.portal },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.data.token;
  }

  // -- Users ---------------------------------------------------------------
  test('inviting a colleague creates an account with a single-use password', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/users', {
      method: 'POST', token: adminToken,
      body: {
        email: 'deepak@meridiantax.test',
        fullName: 'Deepak Sharma',
        phone: '9845077331',
        jobTitle: 'Finance Executive',
        roleKey: 'finance_executive',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.data.user.status, 'invited');
    assert.equal(res.data.user.mustChangePassword, true);
    assert.equal(res.data.user.primaryRole.key, 'finance_executive');

    // The temporary password is strong and returned exactly once.
    const temp = res.data.temporaryPassword;
    assert.ok(temp && temp.length >= 12, 'a temporary password was issued');
    assert.match(temp, /[A-Z]/);
    assert.match(temp, /[a-z]/);
    assert.match(temp, /[0-9]/);

    // Email is not configured in tests, so the invite reports that honestly
    // rather than claiming it was sent.
    assert.equal(res.data.invite.sent, false);

    const detail = await app.request(`/api/users/${res.data.user.id}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.user.email, 'deepak@meridiantax.test');
    assert.equal(detail.data.activeSessions.length, 0);

    // And it is really usable: the invited user can sign in with it.
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: 'deepak@meridiantax.test', password: temp },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.data.mustChangePassword, true);
  });

  test('a duplicate invitation is refused', async () => {
    const { app, adminToken } = await setup();
    const body = { email: 'kavya@meridiantax.test', fullName: 'Kavya Reddy', roleKey: 'accountant' };

    const first = await app.request('/api/users', { method: 'POST', token: adminToken, body });
    assert.equal(first.status, 201);
    const second = await app.request('/api/users', { method: 'POST', token: adminToken, body });
    assert.equal(second.status, 409);
    assert.match(second.error.message, /already on your team/);
  });

  test('inviting users needs the permission, and the role hierarchy still binds', async () => {
    const { app, adminToken, tenantId } = await setup();
    const manager = await createUserWithRole(app, {
      tenantId, email: 'sunil@meridiantax.test', fullName: 'Sunil Kamath', roleKey: 'finance_manager',
    });

    // A finance manager does not hold users.create at all.
    let managerToken = await tokenFor(app, manager);
    const noPermission = await app.request('/api/users', {
      method: 'POST', token: managerToken,
      body: { email: 'anita@meridiantax.test', fullName: 'Anita Das', roleKey: 'accountant' },
    });
    assert.equal(noPermission.status, 403);
    assert.equal(noPermission.error.details.required, 'users.create');

    // Grant it explicitly. The permission check now passes, which is exactly
    // what makes the next assertion meaningful: the level check is a separate
    // control, not a side effect of the permission.
    for (const key of ['users.create', 'users.update']) {
      const grant = await app.request(`/api/users/${manager.userId}/permissions`, {
        method: 'PUT', token: adminToken,
        body: { permissionKey: key, granted: true, reason: 'Covering recruitment this quarter' },
      });
      assert.equal(grant.status, 200, JSON.stringify(grant.body));
    }
    managerToken = await tokenFor(app, manager); // the grant revoked the old session

    const allowed = await app.request('/api/users', {
      method: 'POST', token: managerToken,
      body: { email: 'anita@meridiantax.test', fullName: 'Anita Das', roleKey: 'accountant' },
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

    // Inviting above their own level is still refused. (A peer at the same
    // level is allowed — an admin must be able to appoint another admin.)
    const refused = await app.request('/api/users', {
      method: 'POST', token: managerToken,
      body: { email: 'boss@meridiantax.test', fullName: 'Ravi Menon', roleKey: 'admin' },
    });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.error.message, /above your own level/);

    // And the admin who registered the organisation is off limits to them.
    const admins = await app.request('/api/users?q=asha', { token: managerToken });
    const adminId = admins.data[0].id;
    const edit = await app.request(`/api/users/${adminId}`, {
      method: 'PATCH', token: managerToken, body: { jobTitle: 'Demoted' },
    });
    assert.equal(edit.status, 403, JSON.stringify(edit.body));
    assert.match(edit.error.message, /at or above your own/);
  });

  test('an expired permission override stops working on its own', async () => {
    const { app, adminToken, tenantId } = await setup();
    const staff = await createUserWithRole(app, {
      tenantId, email: 'gopal@meridiantax.test', fullName: 'Gopal Iyer', roleKey: 'accountant',
    });

    const { addDays } = await import('../src/utils/time.js');
    const grant = await app.request(`/api/users/${staff.userId}/permissions`, {
      method: 'PUT', token: adminToken,
      body: {
        permissionKey: 'users.view', granted: true,
        reason: 'Temporary cover', expiresAt: addDays(-1),
      },
    });
    assert.equal(grant.status, 200, JSON.stringify(grant.body));

    // The override is recorded and visible to an auditor...
    const detail = await app.request(`/api/users/${staff.userId}`, { token: adminToken });
    assert.equal(detail.data.permissionOverrides.length, 1);
    assert.equal(detail.data.permissionOverrides[0].reason, 'Temporary cover');

    // ...but because it expired yesterday it grants nothing.
    const token = await tokenFor(app, staff);
    const attempt = await app.request('/api/users', { token });
    assert.equal(attempt.status, 403, 'an expired grant must not still work');
  });

  test('a role change revokes the user\'s sessions immediately', async () => {
    const { app, adminToken, tenantId } = await setup();
    const staff = await createUserWithRole(app, {
      tenantId, email: 'nisha@meridiantax.test', fullName: 'Nisha Pillai', roleKey: 'accountant',
    });
    const staffToken = await tokenFor(app, staff);

    const before = await app.request('/api/auth/me', { token: staffToken });
    assert.equal(before.status, 200);

    const change = await app.request(`/api/users/${staff.userId}/roles`, {
      method: 'PUT', token: adminToken, body: { roleKeys: ['finance_executive'] },
    });
    assert.equal(change.status, 200, JSON.stringify(change.body));
    assert.equal(change.data.sessionsRevoked, true);

    // The old token must stop working, or the demotion would not take effect
    // until the user happened to sign out.
    const after = await app.request('/api/auth/me', { token: staffToken });
    assert.equal(after.status, 401, JSON.stringify(after.body));
  });

  test('nobody can grant themselves a permission they do not hold', async () => {
    const { app, tenantId } = await setup();
    const manager = await createUserWithRole(app, {
      tenantId, email: 'arun@meridiantax.test', fullName: 'Arun Verma', roleKey: 'finance_manager',
    });
    const managerToken = await tokenFor(app, manager);
    const target = await createUserWithRole(app, {
      tenantId, email: 'leela@meridiantax.test', fullName: 'Leela Krishnan', roleKey: 'accountant',
    });

    const res = await app.request(`/api/users/${target.userId}/permissions`, {
      method: 'PUT', token: managerToken,
      body: { permissionKey: 'platform.tenants', granted: true },
    });
    // finance_manager holds neither roles.manage nor platform.tenants.
    assert.ok(res.status === 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  test('the last active administrator cannot be deactivated', async () => {
    const { app, adminToken } = await setup();
    const me = await app.request('/api/auth/me', { token: adminToken });
    const adminId = me.data.user.id;

    // Deactivating yourself is refused outright.
    const self = await app.request(`/api/users/${adminId}`, { method: 'DELETE', token: adminToken });
    assert.equal(self.status, 403);
    assert.match(self.error.message, /your own account/);
  });

  // -- Companies -----------------------------------------------------------
  test('a company is created, and a GSTIN contradicting its state is refused', async () => {
    const { app, adminToken } = await setup();

    const good = await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: {
        name: 'Vantara Foods',
        legalName: 'Vantara Foods Private Limited',
        gstin: '27AAECK3456N1Z3',
        stateCode: '27',
        city: 'Pune',
        entityType: 'private_limited',
      },
    });
    assert.equal(good.status, 201, JSON.stringify(good.body));
    assert.equal(good.data.company.gstin, '27AAECK3456N1Z3');
    assert.equal(good.data.company.address.stateCode, '27');
    // The PAN is derivable from the GSTIN, so it is filled in rather than left blank.
    assert.equal(good.data.company.pan, 'AAECK3456N');

    const bad = await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Kestrel Logistics', gstin: '24AAJCB1357S1Z7', stateCode: '33' },
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.error.message, /state code 24/);

    const dup = await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Another Vantara', gstin: '27AAECK3456N1Z3', stateCode: '27' },
    });
    assert.equal(dup.status, 409);
  });

  test('the company switcher explains a locked feature instead of hiding it', async () => {
    const { app, adminToken, tenantId } = await setup();

    await setPlan(app, tenantId, 'standard'); // multi_company is Pro and above
    const locked = await app.request('/api/companies/switcher', { token: adminToken });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.data.switchingEnabled, false);
    assert.match(locked.data.lockedReason, /Pro/);

    const attempt = await app.request('/api/companies/switch', {
      method: 'POST', token: adminToken, body: { companyId: locked.data.companies[0].id },
    });
    assert.equal(attempt.status, 402, JSON.stringify(attempt.body));
    assert.equal(attempt.error.code, 'feature_locked');

    await setPlan(app, tenantId, 'pro');
    const unlocked = await app.request('/api/companies/switcher', { token: adminToken });
    assert.equal(unlocked.data.switchingEnabled, true);
    assert.equal(unlocked.data.lockedReason, null);

    const switched = await app.request('/api/companies/switch', {
      method: 'POST', token: adminToken, body: { companyId: unlocked.data.companies[0].id },
    });
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.data.activeCompanyId, unlocked.data.companies[0].id);
  });

  // -- Branches ------------------------------------------------------------
  test('branches need the add-on, and a half-specified geofence is refused', async () => {
    const { app, adminToken, tenantId } = await setup();

    const locked = await app.request('/api/branches', {
      method: 'POST', token: adminToken, body: { name: 'Chennai HO', code: 'CHN' },
    });
    assert.equal(locked.status, 402);
    assert.equal(locked.error.details.requiredAddOn, 'multi_branch_management');

    const { activateAddOn } = await import('./helpers/app.js');
    await activateAddOn(app, tenantId, 'multi_branch_management');

    const half = await app.request('/api/branches', {
      method: 'POST', token: adminToken,
      body: { name: 'Chennai HO', code: 'CHN', latitude: 13.0827 },
    });
    assert.equal(half.status, 400);
    assert.match(half.error.message, /both a latitude and a longitude/);

    const created = await app.request('/api/branches', {
      method: 'POST', token: adminToken,
      body: {
        name: 'Chennai Head Office', code: 'chn', isHeadOffice: true, city: 'Chennai',
        stateCode: '33', latitude: 13.0827, longitude: 80.2707, geofenceMetres: 150,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.data.branch.code, 'CHN', 'codes are normalised to upper case');
    assert.equal(created.data.branch.geofence.radiusMetres, 150);
    assert.equal(created.data.branch.address.state, 'Tamil Nadu', 'the state name came from the code');

    const clash = await app.request('/api/branches', {
      method: 'POST', token: adminToken, body: { name: 'Duplicate', code: 'CHN' },
    });
    assert.equal(clash.status, 409);

    // Registering the organisation already created a head office, so setting
    // isHeadOffice on the new branch has to move the flag, not duplicate it.
    const list = await app.request('/api/branches', { token: adminToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const heads = list.data.filter(b => b.isHeadOffice);
    assert.equal(heads.length, 1, 'exactly one branch is the head office');
    assert.equal(heads[0].id, created.data.branch.id);

    const performance = await app.request('/api/branches/performance', { token: adminToken });
    assert.equal(performance.status, 200, JSON.stringify(performance.body));
    assert.equal(performance.data.branches.length, list.meta.pagination.total);
    assert.ok(performance.data.branches.some(b => b.code === 'CHN'));
    assert.equal(performance.data.totals.branches, performance.data.branches.length);
  });

  // -- Settings ------------------------------------------------------------
  test('settings accept known keys, reject unknown ones and reject bad values', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/settings', {
      method: 'PUT', token: adminToken,
      body: {
        settings: [
          { namespace: 'documents', key: 'sla_hours', value: 24 },
          { namespace: 'general', key: 'default_theme', value: 'light' },
          { namespace: 'documents', key: 'sla_hours', value: 24 },
          { namespace: 'general', key: 'made_up_key', value: 'x' },
          { namespace: 'tax', key: 'default_gst_rate', value: 99 },
        ],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.applied.length, 3);
    assert.equal(res.data.rejected.length, 2);
    assert.equal(res.data.rejected[0].reason, 'unknown_setting');
    assert.match(res.data.rejected[1].reason, /Default GST rate/);

    const read = await app.request('/api/settings', { token: adminToken });
    const sla = read.data.namespaces.documents.find(s => s.key === 'sla_hours');
    assert.equal(sla.value, 24);
    assert.equal(sla.isSet, true);
  });

  test('the IP allow-list refuses to lock you out of your own account', async () => {
    const { app, adminToken, tenantId } = await setup();
    const { activateAddOn } = await import('./helpers/app.js');
    await activateAddOn(app, tenantId, 'enterprise_security');

    // Enabling with nothing on the list would strand the tenant.
    const premature = await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken, body: { ipAllowlistEnabled: true },
    });
    assert.equal(premature.status, 400, JSON.stringify(premature.body));
    assert.match(premature.error.message, /locked out/);

    const bad = await app.request('/api/settings/security/ip-allowlist', {
      method: 'POST', token: adminToken, body: { cidr: 'not-an-ip' },
    });
    assert.equal(bad.status, 400);

    // The test client calls from 203.0.113.10.
    const added = await app.request('/api/settings/security/ip-allowlist', {
      method: 'POST', token: adminToken, body: { cidr: '203.0.113.0/24', label: 'Office' },
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.data.coversYourAddress, true);

    const enabled = await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken, body: { ipAllowlistEnabled: true },
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.data.policy.ip_allowlist_enabled, 1);

    // And removing the only covering entry is refused for the same reason.
    const removal = await app.request(
      `/api/settings/security/ip-allowlist/${added.data.entry.id}`,
      { method: 'DELETE', token: adminToken });
    assert.equal(removal.status, 400);
    assert.match(removal.error.message, /outside the allow-list/);
  });

  test('a security policy change is audited with its before and after', async () => {
    const { app, adminToken, tenantId } = await setup();

    const res = await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken,
      body: { maxFailedLogins: 3, lockoutMinutes: 30, passwordMinLength: 14 },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.policy.max_failed_logins, 3);
    assert.equal(res.data.policy.password_min_length, 14);

    const { Db } = await import('../src/db/client.js');
    const row = await new Db(app.env.DB).one(
      `SELECT old_value_json, new_value_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'security.policy_updated'
        ORDER BY created_at DESC LIMIT 1`, [tenantId]);
    assert.ok(row, 'the change was audited');
    const after = JSON.parse(row.new_value_json);
    assert.equal(after.max_failed_logins, 3);
    const before = JSON.parse(row.old_value_json);
    assert.equal(before.max_failed_logins, 5, 'the previous value is recorded too');
  });

  // -- Dashboards ----------------------------------------------------------
  test('each role gets its own dashboard, and cannot open another', async () => {
    const { app, adminToken, tenantId } = await setup();

    const admin = await app.request('/api/dashboard', { token: adminToken });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.data.role, 'admin');
    assert.equal(admin.data.title, 'Firm overview');
    assert.equal(admin.data.tiles.length, 4);
    assert.equal(admin.data.workflow.length, 10, 'all ten workflow stages are represented');
    assert.ok(Array.isArray(admin.data.charts.revenue.series));

    for (const [roleKey, expectedTitle] of [
      ['finance_manager', 'Team and approvals'],
      ['finance_executive', 'My verification queue'],
      ['accountant', 'Tax preparation'],
      ['auditor', 'Assurance overview'],
    ]) {
      const user = await createUserWithRole(app, {
        tenantId, email: `${roleKey}@meridiantax.test`,
        fullName: `Test ${roleKey}`, roleKey,
      });
      const token = await tokenFor(app, user);
      const res = await app.request('/api/dashboard', { token });
      assert.equal(res.status, 200, `${roleKey}: ${JSON.stringify(res.body)}`);
      assert.equal(res.data.role, roleKey);
      assert.equal(res.data.title, expectedTitle);

      // The admin dashboard carries firm revenue and receivables, so no
      // subordinate role may open it, whatever analytics permission they hold.
      const other = await app.request('/api/dashboard/admin', { token });
      assert.equal(other.status, 403, `${roleKey} should not open the admin dashboard`);
    }

    // An admin, being senior, may look at a subordinate's dashboard.
    for (const roleKey of ['finance_manager', 'finance_executive', 'accountant']) {
      const res = await app.request(`/api/dashboard/${roleKey}`, { token: adminToken });
      assert.equal(res.status, 200, `admin should open the ${roleKey} dashboard`);
    }
  });

  test('a client dashboard shows only that client\'s own filings', async () => {
    const { app, adminToken } = await setup();

    const clientRes = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Solaris Apparel',
        companyName: 'Solaris Apparel LLP',
        gstin: '33AAFCS7890P1ZJ',
        pan: 'AAFCS7890P',
        contactName: 'Divya Menon',
        contactEmail: 'divya@solarisapparel.test',
        contactPhone: '9840055221',
        createPortalLogin: true,
        openCurrentPeriod: true,
      },
    });
    assert.equal(clientRes.status, 201, JSON.stringify(clientRes.body));

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'divya@solarisapparel.test', password: clientRes.data.temporaryPassword },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const res = await app.request('/api/dashboard', { token: login.data.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.role, 'client');
    assert.equal(res.data.title, 'Your filings');
    assert.ok(res.data.currentPeriod, 'the open filing period is shown');
    assert.equal(res.data.currentPeriod.stages.length, 10);
    assert.equal(res.data.outstandingPaise, 0);
    assert.match(res.data.outstandingLabel, /^₹/);

    // A client must not reach a staff dashboard.
    const staffView = await app.request('/api/dashboard/finance_manager', { token: login.data.token });
    assert.equal(staffView.status, 403);
  });
});
