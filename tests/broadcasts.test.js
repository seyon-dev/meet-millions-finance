import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, registerOrg, setPlan, activateAddOn, firstTenantId,
} from './helpers/app.js';

/**
 * Broadcasts.
 *
 * The bug being fixed: an immediate broadcast inserted status 'queued', a
 * value the CHECK constraint did not allow, so it failed outright; a scheduled
 * one was stored and never sent, because the scheduler job its own comment
 * referred to did not exist.
 *
 * The rule these tests hold to is the one that matters for a messaging
 * feature: nothing is ever recorded as sent that a provider did not accept.
 */
describe('Broadcasts', () => {
  const WA = {
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_BUSINESS_ACCOUNT_ID: 'waba-1',
  };

  async function setup({ env = {} } = {}) {
    const app = await createApp({ env });
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');
    await activateAddOn(app, tenantId, 'whatsapp_business_api');

    for (const [name, phone] of [['Anand Traders', '9845000011'], ['Bela Exports', '9845000022']]) {
      const r = await app.request('/api/clients', {
        method: 'POST', token: adminToken,
        body: {
          displayName: name, companyName: name,
          contactName: name.split(' ')[0],
          contactEmail: `${name.split(' ')[0].toLowerCase()}@example.test`,
          contactPhone: phone,
        },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    return { app, adminToken, tenantId };
  }

  async function approvedTemplate(app, tenantId) {
    const { Db } = await import('../src/db/client.js');
    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const db = new Db(app.env.DB);
    const id = `wtp_test_${tenantId.slice(-8)}`;
    await db.run(
      `INSERT INTO whatsapp_templates
         (id, tenant_id, name, category, language, body_text, approval_status, created_at, updated_at)
       VALUES (?, ?, 'filing_reminder', 'UTILITY', 'en', 'Your filing is due.', 'approved', ?, ?)`,
      [id, tenantId, nowIso(), nowIso()]);
    return id;
  }

  const dbOf = async app => new (await import('../src/db/client.js')).Db(app.env.DB);

  // -- The constraint violation --------------------------------------------

  test('an immediate broadcast is accepted rather than rejected by its own schema', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);

    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: {
        name: 'August filing reminder',
        channel: 'whatsapp',
        templateId,
        audience: { kind: 'clients' },
      },
    });

    // This is the request that used to 500 on
    // CHECK constraint failed: status IN ('draft','scheduled',...).
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.data.broadcast.recipient_count, 2);
  });

  test('every recipient is staged individually, so delivery can be audited', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);

    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'Reminder', channel: 'whatsapp', templateId, audience: { kind: 'clients' } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const db = await dbOf(app);
    const rows = await db.many('SELECT * FROM broadcast_recipients WHERE broadcast_id = ?',
      [res.data.broadcast.id]);
    assert.equal(rows.length, 2, 'one row per recipient, not just a counter');
    assert.ok(rows.every(r => r.to_address), 'each carries the address it will go to');
  });

  // -- Honesty --------------------------------------------------------------

  test('with no provider configured nothing is marked sent, and the reason is recorded', async () => {
    // No WhatsApp credentials at all.
    const { app, adminToken, tenantId } = await setup();
    const templateId = await approvedTemplate(app, tenantId);

    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'Goes nowhere', channel: 'whatsapp', templateId, audience: { kind: 'clients' } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await app.settle();

    const db = await dbOf(app);
    const b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [res.data.broadcast.id]);
    assert.equal(b.status, 'failed', 'not "sent", and not left queued for ever');
    assert.equal(b.sent_count, 0);
    assert.match(b.last_error, /not connected/i, 'and it says why');

    const sent = await db.one(
      "SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'sent'",
      [res.data.broadcast.id]);
    assert.equal(sent.n, 0, 'no recipient may be recorded as reached');
  });

  test('a provider rejection is recorded against that recipient, not swallowed', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);

    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'Rejected', channel: 'whatsapp', templateId, audience: { kind: 'clients' } },
    });
    await app.settle();

    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ error: { message: 'Template not approved for this number' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });

    try {
      const { deliverBroadcast } = await import('../src/services/broadcasts.js');
      const db = await dbOf(app);
      const b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [res.data.broadcast.id]);
      // Reset the rows the first (real) pass already touched.
      await db.run("UPDATE broadcast_recipients SET status='pending', attempts=0 WHERE broadcast_id = ?",
        [b.id]);
      await deliverBroadcast(app.env, b);

      const rows = await db.many('SELECT * FROM broadcast_recipients WHERE broadcast_id = ?', [b.id]);
      assert.ok(rows.every(r => r.status === 'failed'), 'a rejection is a failure, not a send');
      assert.ok(rows.every(r => r.error), 'and the provider’s reason is kept per recipient');

      const after = await db.one('SELECT * FROM broadcasts WHERE id = ?', [b.id]);
      assert.equal(after.sent_count, 0, 'the counter is derived from the rows, so it cannot lie');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('a successful send is counted once and not re-sent on the next pass', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);

    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'Goes out', channel: 'whatsapp', templateId, audience: { kind: 'clients' } },
    });

    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls}` }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const db = await dbOf(app);
      await db.run("UPDATE broadcast_recipients SET status='pending', attempts=0 WHERE broadcast_id = ?",
        [res.data.broadcast.id]);

      const { deliverBroadcast, runDueBroadcasts } = await import('../src/services/broadcasts.js');
      const b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [res.data.broadcast.id]);
      const first = await deliverBroadcast(app.env, b);
      assert.equal(first.sent, 2, JSON.stringify(first));

      const after = await db.one('SELECT * FROM broadcasts WHERE id = ?', [b.id]);
      assert.equal(after.status, 'sent');
      assert.equal(after.sent_count, 2);
      assert.ok(after.completed_at);

      const before = calls;
      await runDueBroadcasts(app.env);
      assert.equal(calls, before, 'a completed broadcast must not send again');
    } finally {
      globalThis.fetch = original;
    }
  });

  // -- Scheduling -----------------------------------------------------------

  test('a scheduled broadcast waits, then the scheduler sends it', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);

    const future = new Date(Date.now() + 86400000).toISOString();
    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: {
        name: 'Tomorrow', channel: 'whatsapp', templateId,
        audience: { kind: 'clients' }, scheduledAt: future,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await app.settle();

    const db = await dbOf(app);
    let b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [res.data.broadcast.id]);
    assert.equal(b.status, 'scheduled', 'it waits');
    assert.equal(b.sent_count, 0);

    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls}` }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    try {
      const { runDueBroadcasts } = await import('../src/services/broadcasts.js');

      // Not due yet: the scheduler must leave it alone.
      await runDueBroadcasts(app.env);
      assert.equal(calls, 0, 'a future broadcast is not sent early');

      // Wind the clock back and run the pass again.
      await db.run("UPDATE broadcasts SET scheduled_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [b.id]);
      const result = await runDueBroadcasts(app.env);
      assert.equal(result.sent, 2, JSON.stringify(result));

      b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [b.id]);
      assert.equal(b.status, 'sent');
      assert.equal(b.sent_count, 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  // -- Guards ---------------------------------------------------------------

  test('a WhatsApp broadcast without an approved template is refused', async () => {
    const { app, adminToken } = await setup({ env: WA });
    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'No template', channel: 'whatsapp', audience: { kind: 'clients' } },
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.message, /template/i);
  });

  test('an audience matching nobody is refused rather than stored empty', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);
    const res = await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: {
        name: 'Nobody', channel: 'whatsapp', templateId,
        audience: { kind: 'clients', status: 'no_such_status' },
      },
    });
    assert.notEqual(res.status, 201);
  });

  test('a broadcast is invisible to another organisation', async () => {
    const { app, adminToken, tenantId } = await setup({ env: WA });
    const templateId = await approvedTemplate(app, tenantId);
    await app.request('/api/messaging/broadcasts', {
      method: 'POST', token: adminToken,
      body: { name: 'Mine', channel: 'whatsapp', templateId, audience: { kind: 'clients' } },
    });

    const other = await registerOrg(app, {
      organisationName: 'Nandini & Co', email: 'admin@nandinico.test',
    });
    const list = await app.request('/api/messaging/broadcasts', { token: other.res.data.token });
    if (list.status === 200) {
      const items = list.data.broadcasts ?? list.data ?? [];
      assert.equal(items.length, 0, 'another firm sees none of it');
    } else {
      assert.ok([402, 403].includes(list.status), JSON.stringify(list.body));
    }
  });
});
