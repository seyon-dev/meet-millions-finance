import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole, setPlan, firstTenantId } from './helpers/app.js';

/**
 * Audit trail, notifications, search and integrations.
 *
 * Two properties recur: the audit chain must actually detect tampering rather
 * than merely claim to, and nothing reports a vendor connection it does not
 * have.
 */
describe('Platform services', () => {
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
      method: 'POST', body: { email: user.email, password: user.password },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.data.token;
  }

  // -- Audit ---------------------------------------------------------------
  test('the audit chain verifies, and detects an edited entry', async () => {
    const { app, adminToken, tenantId } = await setup();

    // Generate a few auditable actions.
    await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Vantara Foods', gstin: '27AAECK3456N1Z3', stateCode: '27' },
    });
    await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken, body: { maxFailedLogins: 4 },
    });

    const before = await app.request('/api/audit/verify', { token: adminToken });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.data.valid, true);
    assert.ok(before.data.checked > 2, 'there are entries to check');
    assert.equal(before.data.brokenAt, null);

    // Tamper with one entry directly in the database, the way someone with
    // database access but not application access would.
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const victim = await db.one(
      'SELECT id, sequence FROM audit_logs WHERE tenant_id = ? ORDER BY sequence LIMIT 1 OFFSET 1',
      [tenantId]);
    await db.run(
      "UPDATE audit_logs SET entity_label = 'Something else entirely' WHERE id = ?", [victim.id]);

    const after = await app.request('/api/audit/verify', { token: adminToken });
    assert.equal(after.data.valid, false, 'the edit was detected');
    assert.equal(after.data.brokenAt, victim.id, 'and the culprit is named');
    assert.match(after.data.reason, /modified since it was written/);
  });

  test('an entry deleted from the middle of the chain is detected', async () => {
    const { app, adminToken, tenantId } = await setup();

    // Three more auditable actions, so there is a middle to delete from.
    await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Kestrel Logistics', gstin: '24AAJCB1357S1Z7', stateCode: '24' },
    });
    await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken, body: { maxFailedLogins: 4 },
    });
    await app.request('/api/settings/security', {
      method: 'PATCH', token: adminToken, body: { lockoutMinutes: 20 },
    });

    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const rows = await db.many(
      'SELECT id, sequence FROM audit_logs WHERE tenant_id = ? ORDER BY sequence', [tenantId]);
    assert.ok(rows.length >= 4, `expected several entries, got ${rows.length}`);

    const victim = rows[1];
    await db.run('DELETE FROM audit_logs WHERE id = ?', [victim.id]);

    const res = await app.request('/api/audit/verify', { token: adminToken });
    assert.equal(res.data.valid, false);
    assert.match(res.data.reason, /Sequence gap/);
  });

  test('verification is honest that it cannot detect a truncated tail', async () => {
    const { app, adminToken, tenantId } = await setup();
    await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Radiant Traders', gstin: '33AACCN5678K1Z3', stateCode: '33' },
    });

    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const rows = await db.many(
      'SELECT id, sequence FROM audit_logs WHERE tenant_id = ? ORDER BY sequence', [tenantId]);
    const last = rows[rows.length - 1];
    await db.run('DELETE FROM audit_logs WHERE id = ?', [last.id]);

    const res = await app.request('/api/audit/verify', { token: adminToken });

    // A shorter chain is still internally consistent, so this reports valid —
    // and says so plainly, with the sequence range, rather than implying a
    // guarantee it does not have.
    assert.equal(res.data.valid, true);
    assert.equal(res.data.lastSequence, last.sequence - 1);
    assert.equal(res.data.coversTailTruncation, false);
    assert.match(res.data.limitation, /removed from the end/);
    assert.ok(!/nothing has been altered or removed\.$/.test(res.data.explanation),
      'the explanation must not overclaim');
  });

  test('an audit entry shows a field-by-field diff', async () => {
    const { app, adminToken } = await setup();

    const company = await app.request('/api/companies', {
      method: 'POST', token: adminToken,
      body: { name: 'Solaris Apparel', gstin: '33AAFCS7890P1ZJ', stateCode: '33', city: 'Chennai' },
    });
    await app.request(`/api/companies/${company.data.company.id}`, {
      method: 'PATCH', token: adminToken, body: { name: 'Solaris Apparel LLP', city: 'Coimbatore' },
    });

    const history = await app.request(
      `/api/audit/entity/company/${company.data.company.id}`, { token: adminToken });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.data.history.length, 2, 'creation and update');

    const update = history.data.history[1];
    const nameChange = update.diff.find(d => d.field === 'name');
    assert.ok(nameChange, 'the name change is in the diff');
    assert.equal(nameChange.before, 'Solaris Apparel');
    assert.equal(nameChange.after, 'Solaris Apparel LLP');
    assert.equal(nameChange.change, 'changed');
  });

  test('an auditor may read the trail but no role may write to it', async () => {
    const { app, adminToken, tenantId } = await setup();
    const auditor = await createUserWithRole(app, {
      tenantId, email: 'compliance@meridiantax.test', fullName: 'Nandini Rao', roleKey: 'auditor',
    });
    const auditorToken = await tokenFor(app, auditor);

    const list = await app.request('/api/audit', { token: auditorToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.data.length > 0);
    assert.ok(list.meta.summary.total > 0);

    // There is no write route at all: POST, PATCH and DELETE all 404/405.
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await app.request(`/api/audit/${list.data[0].id}`, { method, token: adminToken });
      assert.ok(res.status === 404 || res.status === 405,
        `${method} on an audit entry should not exist, got ${res.status}`);
    }
  });

  test('an accountant cannot read the audit trail at all', async () => {
    const { app, tenantId } = await setup();
    const accountant = await createUserWithRole(app, {
      tenantId, email: 'books@meridiantax.test', fullName: 'Suresh Babu', roleKey: 'accountant',
    });
    const token = await tokenFor(app, accountant);
    const res = await app.request('/api/audit', { token });
    assert.equal(res.status, 403);
  });

  // -- Notifications -------------------------------------------------------
  test('the preference screen reports each channel\'s real state', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/notifications/preferences', { token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const byKey = Object.fromEntries(res.data.channels.map(c => [c.key, c]));

    // In-app needs nothing and is always available.
    assert.equal(byKey.in_app.available, true);
    assert.equal(byKey.in_app.unavailableReason, null);

    // Email has no SES credentials in the test environment, so it says so
    // rather than offering a switch that does nothing.
    assert.equal(byKey.email.available, false);
    assert.equal(byKey.email.providerConfigured, false);
    assert.match(byKey.email.unavailableReason, /credentials/);
    assert.ok(byKey.email.missingKeys.length > 0);

    // WhatsApp is included in the Pro plan, so the feature is unlocked — but
    // without Cloud API credentials it still cannot send, and says which.
    assert.equal(byKey.whatsapp.featureUnlocked, true);
    assert.equal(byKey.whatsapp.available, false);
    assert.match(byKey.whatsapp.unavailableReason, /credentials/);

    // On a plan that does not include it, the reason names the add-on instead.
    const { setPlan: movePlan, firstTenantId: tid } = await import('./helpers/app.js');
    await movePlan(app, await tid(app), 'basic');
    const basic = await app.request('/api/notifications/preferences', { token: adminToken });
    const whatsapp = basic.data.channels.find(c => c.key === 'whatsapp');
    assert.equal(whatsapp.featureUnlocked, false);
    assert.match(whatsapp.unavailableReason, /add-on/);
  });

  test('a security notification cannot be switched off', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/notifications/preferences', {
      method: 'PUT', token: adminToken,
      body: {
        preferences: [
          { triggerKey: 'document.uploaded', channels: { email: false, in_app: true } },
          { triggerKey: 'account.password_changed', channels: { email: false, in_app: false } },
          { triggerKey: 'not.a.real.trigger', channels: { email: true } },
        ],
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const applied = res.data.applied.map(a => a.triggerKey);
    assert.ok(applied.includes('document.uploaded'));

    const refused = res.data.rejected.find(r => r.triggerKey === 'account.password_changed');
    assert.ok(refused, 'the mandatory trigger was refused');
    assert.match(refused.reason, /security of your account/);

    assert.ok(res.data.rejected.some(r => r.reason === 'unknown_trigger'));

    // And it is still marked mandatory when the screen is read back.
    const read = await app.request('/api/notifications/preferences', { token: adminToken });
    const mandatory = read.data.triggers.find(t => t.key === 'account.password_changed');
    assert.equal(mandatory.mandatory, true);
    assert.equal(mandatory.channels.email, true, 'still on despite the attempt to disable it');

    const changed = read.data.triggers.find(t => t.key === 'document.uploaded');
    assert.equal(changed.channels.email, false);
    assert.equal(changed.customised, true);
  });

  test('a test message reports failure honestly when no provider is configured', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/notifications/test', {
      method: 'POST', token: adminToken, body: { channel: 'email' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.delivered, false, 'nothing was sent, and it says so');
    assert.equal(res.data.summary.sent, 0);
    assert.ok(res.data.summary.notConfigured > 0 || res.data.summary.skipped > 0);

    // In-app needs no vendor, so it really does deliver.
    const inApp = await app.request('/api/notifications/test', {
      method: 'POST', token: adminToken, body: { channel: 'in_app' },
    });
    assert.equal(inApp.data.delivered, true, JSON.stringify(inApp.data));

    const feed = await app.request('/api/notifications', { token: adminToken });
    assert.ok(feed.data.length > 0, 'the message is in the feed');
    assert.equal(feed.meta.unread > 0, true);

    const marked = await app.request('/api/notifications/read', {
      method: 'POST', token: adminToken, body: { all: true },
    });
    assert.ok(marked.data.marked > 0);
    const after = await app.request('/api/notifications/unread-count', { token: adminToken });
    assert.equal(after.data.unread, 0);
  });

  test('a template using an unknown placeholder is refused', async () => {
    const { app, adminToken } = await setup();

    const templates = await app.request('/api/notifications/templates', { token: adminToken });
    assert.equal(templates.status, 200, JSON.stringify(templates.body));
    const tpl = templates.data.templates.find(t => t.channel === 'email' && t.variables.length > 0);
    assert.ok(tpl, 'at least one email template exposes placeholders');

    const bad = await app.request(
      `/api/notifications/templates/${tpl.triggerKey}/email`, {
        method: 'PUT', token: adminToken,
        body: { subject: tpl.subject, body: 'Hello {{definitelyNotAThing}}, regards.' },
      });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.match(bad.error.message, /never provides/);

    // A template using only real placeholders is accepted.
    const good = await app.request(
      `/api/notifications/templates/${tpl.triggerKey}/email`, {
        method: 'PUT', token: adminToken,
        body: { subject: tpl.subject, body: `Hello {{${tpl.variables[0]}}}, regards.` },
      });
    assert.equal(good.status, 200, JSON.stringify(good.body));

    const preview = await app.request(
      `/api/notifications/templates/${tpl.triggerKey}/email/preview`, {
        method: 'POST', token: adminToken, body: {},
      });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.sent, false, 'a preview sends nothing');
    assert.ok(preview.data.body.includes('Hello'));
  });

  // -- Search --------------------------------------------------------------
  test('search spans records and never returns what the caller may not see', async () => {
    const { app, adminToken, tenantId } = await setup();

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Northline Textiles', companyName: 'Northline Textiles Private Limited',
        gstin: '29AADCV9012L1ZX', pan: 'AADCV9012L',
        contactName: 'Rahul Nair', contactEmail: 'rahul@northlinetextiles.test',
        contactPhone: '9822011456', createPortalLogin: true,
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));

    const found = await app.request('/api/search?q=northline', { token: adminToken });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const clientGroup = found.data.groups.find(g => g.group === 'Clients');
    assert.ok(clientGroup, 'the client was found');
    assert.equal(clientGroup.items[0].title, 'Northline Textiles');

    // Staff are searchable by an admin.
    const team = await app.request('/api/search?q=asha', { token: adminToken });
    assert.ok(team.data.groups.some(g => g.group === 'Team'));

    // The client user searching the same term sees their own record, but the
    // staff directory is not among the groups at all.
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'rahul@northlinetextiles.test', password: client.data.temporaryPassword },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const asClient = await app.request('/api/search?q=asha', { token: login.data.token });
    assert.equal(asClient.status, 200);
    assert.ok(!asClient.data.groups.some(g => g.group === 'Team'),
      'a client must not be able to enumerate staff');
  });

  test('a short query returns navigation suggestions rather than nothing', async () => {
    const { app, adminToken } = await setup();
    const res = await app.request('/api/search?q=', { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.data.suggestions.length > 0, 'the palette offers screens');
    assert.ok(res.data.suggestions.every(s => s.path && s.title));
  });

  // -- Integrations --------------------------------------------------------
  test('integrations report not connected, and name what is missing', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/integrations', { token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.data.integrations.length >= 13, 'the whole vendor list is described');
    assert.equal(res.data.summary.connected, 0, 'nothing claims a connection it does not have');
    assert.ok(res.data.summary.awaitingCredentials > 0);

    for (const integration of res.data.integrations) {
      // Either a vendor with no credentials, or something this Worker serves
      // itself. Never a claimed connection.
      assert.ok(['not_connected', 'self_hosted'].includes(integration.status),
        `${integration.key} reported ${integration.status}`);
      assert.ok(Array.isArray(integration.missingKeys));
      if (integration.status === 'not_connected') {
        assert.ok(integration.missingKeys.length > 0,
          `${integration.key} says not connected but names nothing missing`);
      }
    }
  });

  test('a connection test on an unconfigured vendor says not_configured, not failed', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/integrations/ses/test', { method: 'POST', token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.ok, false);
    assert.equal(res.data.status, 'not_configured');
    assert.ok(res.data.missingKeys.length > 0, 'it names the keys to add');

    // The outcome is recorded against the integration, not just returned.
    const detail = await app.request('/api/integrations/ses', { token: adminToken });
    assert.equal(detail.data.integration.lastTestOk, false);
    assert.ok(detail.data.integration.lastTestAt);
  });

  test('account linking refuses to start without deployment credentials', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/integrations/google_drive/oauth/start', {
      method: 'POST', token: adminToken, body: {},
    });
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.error.code, 'integration_not_configured');
    assert.match(res.error.message, /no credentials on this deployment/);
  });

  test('an OAuth callback with a state we never issued is refused', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/integrations/google_drive/oauth/callback', {
      method: 'POST', token: adminToken,
      body: { code: 'a-code-from-somewhere', state: 'a-state-we-never-issued' },
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.error.message, /not one we started/);
  });

  test('tenant integration config never stores anything that looks like a secret', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/integrations/ses/config', {
      method: 'PATCH', token: adminToken,
      body: {
        config: {
          fromAddress: 'noreply@meridiantax.test',
          replyTo: 'support@meridiantax.test',
          apiSecret: 'somebody-pasted-a-real-secret-here',
          accessToken: 'and-a-token-too',
        },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.data.config.fromAddress, 'noreply@meridiantax.test');
    assert.match(res.data.config.apiSecret, /environment variables/);
    assert.match(res.data.config.accessToken, /environment variables/);

    // And nothing resembling the pasted value reached the database.
    const { Db } = await import('../src/db/client.js');
    const row = await new Db(app.env.DB).one(
      "SELECT config_json FROM integrations WHERE provider = 'ses'");
    assert.ok(!row.config_json.includes('somebody-pasted-a-real-secret-here'));
    assert.ok(!row.config_json.includes('and-a-token-too'));
  });
});
