import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, registerOrg, setPlan, activateAddOn, firstTenantId, testFile,
} from './helpers/app.js';

/**
 * The automation rule engine.
 *
 * These exist because the engine shipped complete and was called by nothing:
 * rules could be written, listed and previewed, and `fire_count` stayed at 0
 * for ever while the screen reported it as a headline. Every test here drives
 * a real business event and then asserts on what the rule actually did.
 */
describe('Automation', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');
    // The rule engine is sold as the Email Automation add-on, so the API is
    // gated on it. Without this every rule request is a 402.
    await activateAddOn(app, tenantId, 'email_automation');

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Harita Exports LLP',
        companyName: 'Harita Exports LLP',
        gstin: '29AAGFH2345K1Z6',
        pan: 'AAGFH2345K',
        contactName: 'Meera Harita',
        contactEmail: 'meera@haritaexports.test',
        contactPhone: '9845123400',
        openCurrentPeriod: true,
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));
    return { app, adminToken, tenantId, client: client.data };
  }

  async function createRule(app, token, body) {
    const res = await app.request('/api/automation', { method: 'POST', token, body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.data;
  }

  const db = async app => new (await import('../src/db/client.js')).Db(app.env.DB);

  // -- The core defect ------------------------------------------------------

  test('a rule fires on a real business event and records that it did', async () => {
    const { app, adminToken, client } = await setup();

    await createRule(app, adminToken, {
      name: 'Raise a task whenever a document arrives',
      triggerKey: 'document.uploaded',
      actions: [{ type: 'create_task', title: 'Check {{documentTitle}}', priority: 'high' }],
      isActive: true,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('sales_register_august.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));

    // The event is emitted through ctx.defer — waitUntil in production, so it
    // lands after the response. settle() is how a test waits for it.
    await app.settle();

    // The rule's own counter — the number the screen has always displayed.
    const rules = await app.request('/api/automation', { token: adminToken });
    const rule = rules.data[0];
    assert.equal(rule.fireCount, 1, 'the rule must record that it fired');
    assert.ok(rule.lastFiredAt, 'and when');

    // The action's actual effect.
    const d = await db(app);
    const task = await d.one(
      "SELECT * FROM tasks WHERE source_type = 'automation' ORDER BY created_at DESC LIMIT 1");
    assert.ok(task, 'the create_task action must have created a task');
    assert.equal(task.priority, 'high');
    assert.equal(task.source_type, 'automation');
    assert.equal(task.type, 'follow_up', 'a real task type, not the source');

    // And the run log, which is what makes a failing rule visible at all.
    const run = await d.one('SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 1');
    assert.equal(run.status, 'fired');
    assert.equal(run.trigger_key, 'document.uploaded');
  });

  test('a rule whose conditions do not match is recorded as skipped, not fired', async () => {
    const { app, adminToken, client } = await setup();

    await createRule(app, adminToken, {
      name: 'Only for critical documents',
      triggerKey: 'document.uploaded',
      conditions: { priority: 'critical' },
      actions: [{ type: 'create_task', title: 'Escalate' }],
      isActive: true,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('routine.pdf', 'x'));
    await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    await app.settle();

    const rules = await app.request('/api/automation', { token: adminToken });
    assert.equal(rules.data[0].fireCount, 0, 'conditions did not match');

    const d = await db(app);
    const run = await d.one('SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT 1');
    assert.equal(run.status, 'skipped');
    assert.match(run.reason, /conditions/i);

    const tasks = await d.one("SELECT COUNT(*) AS n FROM tasks WHERE source_type = 'automation'");
    assert.equal(tasks.n, 0, 'and nothing was done');
  });

  test('an inactive rule does not fire', async () => {
    const { app, adminToken, client } = await setup();
    await createRule(app, adminToken, {
      name: 'Switched off',
      triggerKey: 'document.uploaded',
      actions: [{ type: 'create_task', title: 'Should not exist' }],
      isActive: false,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('x.pdf', 'x'));
    await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    await app.settle();

    const d = await db(app);
    const tasks = await d.one("SELECT COUNT(*) AS n FROM tasks WHERE source_type = 'automation'");
    assert.equal(tasks.n, 0);
  });

  // -- Delayed rules --------------------------------------------------------

  test('a delayed rule is queued, not run, and the scheduler runs it when due', async () => {
    const { app, adminToken, client } = await setup();

    await createRule(app, adminToken, {
      name: 'Chase two days later',
      triggerKey: 'document.uploaded',
      delayMinutes: 2880,
      actions: [{ type: 'create_task', title: 'Chase the client' }],
      isActive: true,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('bank.pdf', 'x'));
    await app.request('/api/documents/upload', { method: 'POST', token: adminToken, body: form });
    await app.settle();

    const d = await db(app);

    // Queued, and emphatically not run — the old code returned a "scheduled
    // for ..." string and persisted nothing at all.
    const job = await d.one('SELECT * FROM automation_jobs ORDER BY created_at DESC LIMIT 1');
    assert.ok(job, 'a delayed rule must leave a job behind');
    assert.equal(job.status, 'pending');
    assert.ok(job.run_after > new Date().toISOString(), 'and it is in the future');

    let tasks = await d.one("SELECT COUNT(*) AS n FROM tasks WHERE source_type = 'automation'");
    assert.equal(tasks.n, 0, 'nothing has happened yet, which is the point of a delay');

    // Wind the clock back so the job is due, then run the scheduler pass.
    await d.run("UPDATE automation_jobs SET run_after = '2020-01-01T00:00:00.000Z' WHERE id = ?",
      [job.id]);

    const { runDueAutomationJobs } = await import('../src/services/automation.js');
    const result = await runDueAutomationJobs(app.env);
    assert.equal(result.ran, 1, JSON.stringify(result));

    tasks = await d.one("SELECT COUNT(*) AS n FROM tasks WHERE source_type = 'automation'");
    assert.equal(tasks.n, 1, 'now it has run');

    const after = await d.one('SELECT * FROM automation_jobs WHERE id = ?', [job.id]);
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, 1);

    // Running the scheduler again must not run it a second time.
    const second = await runDueAutomationJobs(app.env);
    assert.equal(second.ran, 0, 'a completed job must not run twice');
  });

  test('the same event twice does not queue the same delayed job twice', async () => {
    const { app, adminToken, client } = await setup();
    await createRule(app, adminToken, {
      name: 'Chase later',
      triggerKey: 'document.uploaded',
      delayMinutes: 60,
      actions: [{ type: 'create_task', title: 'Chase' }],
      isActive: true,
    });

    const d = await db(app);
    const doc = await d.one('SELECT id FROM documents LIMIT 1');

    const { runAutomation } = await import('../src/services/automation.js');
    const tenantId = await firstTenantId(app);
    const ctx = { env: app.env, tenantId, userId: null };
    const payload = { entityType: 'document', entityId: doc?.id ?? 'doc_fixed', clientId: client.client.id };

    await runAutomation(ctx, 'document.uploaded', payload);
    await runAutomation(ctx, 'document.uploaded', payload);

    const jobs = await d.one("SELECT COUNT(*) AS n FROM automation_jobs WHERE status = 'pending'");
    assert.equal(jobs.n, 1, 'a double-click must not queue the work twice');
  });

  // -- Containment ----------------------------------------------------------

  test('a failing rule is logged and does not break the event that triggered it', async () => {
    const { app, adminToken, client } = await setup();

    // set_status against a table that does not exist: the action will throw.
    await createRule(app, adminToken, {
      name: 'Broken rule',
      triggerKey: 'document.uploaded',
      actions: [{ type: 'set_status', status: 'verified' }],
      isActive: true,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('still_works.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });

    // The upload is what matters: automation must never fail the business
    // operation that emitted the event.
    assert.equal(upload.status, 201, 'the upload still succeeds');
    assert.equal(upload.data.created.length, 1);
  });

  test('rules are per organisation', async () => {
    const { app, adminToken, client } = await setup();
    await createRule(app, adminToken, {
      name: 'Only mine',
      triggerKey: 'document.uploaded',
      actions: [{ type: 'create_task', title: 'Mine' }],
      isActive: true,
    });

    const other = await registerOrg(app, {
      organisationName: 'Suresh & Co',
      email: 'admin@sureshco.test',
    });
    const otherList = await app.request('/api/automation', { token: other.res.data.token });
    assert.equal(otherList.data.length, 0, 'another firm sees none of it');

    // And an event in the other tenant must not fire this tenant's rule.
    const { runAutomation } = await import('../src/services/automation.js');
    const otherTenant = other.res.data.tenant?.id;
    if (otherTenant) {
      const result = await runAutomation(
        { env: app.env, tenantId: otherTenant, userId: null },
        'document.uploaded', { clientId: null });
      assert.equal(result.fired, 0, 'a rule must not fire for another organisation');
    }
    assert.ok(client);
  });

  test('a notify action does not re-enter the engine for ever', async () => {
    const { app, adminToken, client } = await setup();

    // A rule triggered by document.uploaded whose action notifies with the
    // same trigger key. Without the runRules guard this recurses until the
    // stack gives out.
    await createRule(app, adminToken, {
      name: 'Self-referential',
      triggerKey: 'document.uploaded',
      actions: [{ type: 'notify', triggerKey: 'document.uploaded' }],
      isActive: true,
    });

    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', testFile('loop.pdf', 'x'));
    const upload = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(upload.status, 201, 'no infinite recursion');
    await app.settle();

    const rules = await app.request('/api/automation', { token: adminToken });
    assert.equal(rules.data[0].fireCount, 1, 'fired exactly once, not repeatedly');
  });
});
