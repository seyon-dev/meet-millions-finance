import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, registerOrg, createUserWithRole, setPlan, activateAddOn, firstTenantId,
} from './helpers/app.js';

/**
 * The Cloud Calling & Call Recording module.
 *
 * The rule these tests exist to hold: with no telephony credentials the API
 * must say so in the response, and must never fabricate a placed call, a
 * recording or an AI summary to make a screen look alive.
 */
describe('Cloud calling', () => {
  async function setup({ withAddOn = true } = {}) {
    const app = await createApp();
    const { res, payload } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);

    await setPlan(app, tenantId, 'pro');
    if (withAddOn) await activateAddOn(app, tenantId, 'cloud_telephony');

    const clientRes = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Northline Textiles Pvt Ltd',
        companyName: 'Northline Textiles Private Limited',
        gstin: '29AADCV9012L1ZX',
        pan: 'AADCV9012L',
        contactName: 'Rahul Nair',
        contactEmail: 'rahul@northlinetextiles.test',
        contactPhone: '9822011456',
        openCurrentPeriod: true,
      },
    });
    assert.equal(clientRes.status, 201, JSON.stringify(clientRes.body));

    return { app, adminToken, tenantId, payload, client: clientRes.data };
  }

  /** Insert a finished call the way a provider webhook eventually would. */
  async function seedCall(app, { tenantId, clientId, companyId, agentId, overrides = {} }) {
    const { Db } = await import('../src/db/client.js');
    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const db = new Db(app.env.DB);
    const ts = nowIso();
    const id = ID.call();
    await db.insert('call_records', {
      id, tenant_id: tenantId, company_id: companyId, client_id: clientId, agent_id: agentId,
      provider: 'exotel', provider_call_id: `prov-${id}`, direction: 'outbound',
      from_number: '+919845012233', to_number: '+919822011456',
      status: 'completed', answered: 1,
      started_at: ts, answered_at: ts, ended_at: ts,
      duration_seconds: 214, talk_seconds: 198,
      created_at: ts, updated_at: ts, ...overrides,
    });
    return id;
  }

  test('the settings screen reports the provider as not connected rather than pretending', async () => {
    const { app, adminToken } = await setup();

    const res = await app.request('/api/calls/settings', { token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.data.providerCatalogue.length, 7, 'all seven providers are offered');
    assert.equal(res.data.featureGroups.length, 6, 'the addendum lists six capability groups');

    const configured = res.data.providers.filter(p => p.configured);
    assert.equal(configured.length, 0, 'no provider claims to be configured without keys');
    for (const p of res.data.providers) {
      assert.ok(p.missingKeys.length > 0, `${p.key} names the keys it is missing`);
    }
  });

  test('dialling without the add-on is locked, and names what would unlock it', async () => {
    const { app, adminToken } = await setup({ withAddOn: false });

    const res = await app.request('/api/calls/dial', {
      method: 'POST', token: adminToken, body: { to: '9822011456' },
    });

    assert.equal(res.status, 402);
    assert.equal(res.error.code, 'feature_locked');
    assert.equal(res.error.details.requiredAddOn, 'cloud_telephony');
  });

  test('dialling with no credentials fails honestly and logs no successful call', async () => {
    const { app, adminToken, tenantId } = await setup();

    const res = await app.request('/api/calls/dial', {
      method: 'POST', token: adminToken, body: { to: '9822011456' },
    });

    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.error.code, 'integration_not_configured');
    assert.equal(res.error.details.configured, false);
    assert.ok(res.error.details.missingKeys.length > 0, 'the response names the missing keys');
    assert.equal(res.data, null, 'no call object is returned');

    // Nothing was written: a refused dial must not leave a phantom call behind.
    const { Db } = await import('../src/db/client.js');
    const rows = await new Db(app.env.DB).many(
      'SELECT id, status FROM call_records WHERE tenant_id = ?', [tenantId]);
    assert.equal(rows.length, 0, JSON.stringify(rows));
  });

  test('static call routes are not swallowed by /:id', async () => {
    const { app, adminToken } = await setup();

    // `/api/calls/:id` is declared before `/api/calls/voicemails`; specificity
    // ranking, not declaration order, has to decide which one answers.
    const voicemails = await app.request('/api/calls/voicemails', { token: adminToken });
    assert.equal(voicemails.status, 200, JSON.stringify(voicemails.body));
    assert.ok(Array.isArray(voicemails.data.voicemails ?? voicemails.data.items ?? voicemails.data));

    const ivr = await app.request('/api/calls/ivr', { token: adminToken });
    assert.equal(ivr.status, 200, JSON.stringify(ivr.body));

    const unknown = await app.request('/api/calls/cal_does_not_exist', { token: adminToken });
    assert.equal(unknown.status, 404, 'a real id still reaches the detail handler');
  });

  test('a call takes notes, a disposition and an automatic follow-up task', async () => {
    const { app, adminToken, tenantId, client } = await setup();
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);

    const me = await db.one('SELECT id FROM users WHERE email = ?', ['asha@meridiantax.test']);
    const callId = await seedCall(app, {
      tenantId, clientId: client.client.id, companyId: client.company.id, agentId: me.id,
    });

    const note = await app.request(`/api/calls/${callId}/notes`, {
      method: 'POST', token: adminToken,
      body: { body: 'Client will send the July purchase register by Friday.', duringCall: true },
    });
    assert.equal(note.status, 201, JSON.stringify(note.body));
    assert.equal(note.data.is_during_call, 1);

    const disposition = await app.request(`/api/calls/${callId}/disposition`, {
      method: 'POST', token: adminToken,
      body: {
        dispositionKey: 'follow_up',
        tags: ['purchase-register', 'july'],
        note: 'Chase the purchase register.',
        createTask: true,
      },
    });
    assert.equal(disposition.status, 200, JSON.stringify(disposition.body));
    assert.equal(disposition.data.call.dispositionKey ?? disposition.data.call.disposition_key, 'follow_up');
    assert.ok(disposition.data.followUpTask, 'a follow-up task was created');
    assert.equal(disposition.data.followUpTask.source_type, 'call');
    assert.equal(disposition.data.followUpTask.source_id, callId);
    assert.equal(disposition.data.followUpTask.assigned_to, me.id);

    // The task is real: it shows up in the task list, not just in this response.
    const tasks = await app.request('/api/tasks', { token: adminToken });
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
    assert.ok(tasks.data.some(t => t.id === disposition.data.followUpTask.id),
      'the follow-up task is visible in the task list');

    // The tag vocabulary learned both labels.
    const tags = await db.many('SELECT label, usage_count FROM call_tags WHERE tenant_id = ?', [tenantId]);
    assert.equal(tags.length, 2);
    assert.deepEqual(tags.map(t => t.label).sort(), ['july', 'purchase-register']);
  });

  test('history, timeline and analytics count the same calls', async () => {
    const { app, adminToken, tenantId, client } = await setup();
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const me = await db.one('SELECT id FROM users WHERE email = ?', ['asha@meridiantax.test']);

    const base = { tenantId, clientId: client.client.id, companyId: client.company.id, agentId: me.id };
    await seedCall(app, base);
    await seedCall(app, { ...base, overrides: { direction: 'inbound', duration_seconds: 96, talk_seconds: 90 } });
    await seedCall(app, { ...base, overrides: { status: 'missed', answered: 0, direction: 'inbound', duration_seconds: 0, talk_seconds: 0 } });

    const history = await app.request('/api/calls', { token: adminToken });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.data.length, 3);
    assert.equal(history.meta.pagination.total, 3);
    assert.equal(history.meta.summary.inbound, 2);
    assert.equal(history.meta.summary.outbound, 1);
    assert.equal(history.meta.summary.missed, 1);

    const missedOnly = await app.request('/api/calls?missedOnly=true', { token: adminToken });
    assert.equal(missedOnly.data.length, 1);

    const timeline = await app.request(`/api/calls/timeline/${client.client.id}`, { token: adminToken });
    assert.equal(timeline.status, 200, JSON.stringify(timeline.body));

    const analytics = await app.request('/api/calls/analytics/overview', { token: adminToken });
    assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
    assert.equal(analytics.data.totalCalls, 3);
    assert.equal(analytics.data.missedCalls, 1);
    assert.equal(analytics.data.answeredCalls, 2);
    assert.equal(analytics.data.totalDurationSeconds, 214 + 96);
    // Averages ignore zero-duration calls, so a missed call must not drag it down.
    assert.equal(analytics.data.avgDurationSeconds, Math.round((214 + 96) / 2));
    assert.equal(analytics.data.answerRatePct, 67);

    // No AI ran, so sentiment is absent rather than invented.
    assert.equal(analytics.data.positiveSentimentPct, null);
    assert.deepEqual(analytics.data.sentiment, {});
  });

  test('a recording can be played by someone who may not download it', async () => {
    const { app, adminToken, tenantId, client } = await setup();
    const { Db } = await import('../src/db/client.js');
    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const { putObject, recordingKey } = await import('../src/services/storage.js');
    const db = new Db(app.env.DB);

    const executive = await createUserWithRole(app, {
      tenantId, email: 'vikram@meridiantax.test', fullName: 'Vikram Rao',
      roleKey: 'finance_executive',
    });
    const exec = await app.request('/api/auth/login', {
      method: 'POST', body: { email: executive.email, password: executive.password },
    });
    assert.equal(exec.status, 200, JSON.stringify(exec.body));
    const execToken = exec.data.token;

    const callId = await seedCall(app, {
      tenantId, clientId: client.client.id, companyId: client.company.id,
      agentId: executive.userId,
    });

    const audio = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
    const key = recordingKey({ tenantId, callId });
    await putObject(app.env, key, audio, { contentType: 'audio/mpeg', fileName: 'recording.mp3' });
    const ts = nowIso();
    await db.insert('call_recordings', {
      id: ID.recording(), tenant_id: tenantId, call_id: callId, storage_key: key,
      mime_type: 'audio/mpeg', size_bytes: audio.length, duration_seconds: 214,
      status: 'available', created_at: ts, updated_at: ts,
    });

    // Listening is allowed and returns the real bytes.
    const play = await app.request(`/api/calls/${callId}/recording`, { token: execToken, raw: true });
    assert.equal(play.status, 200);
    assert.equal(play.headers.get('content-type'), 'audio/mpeg');
    const played = new Uint8Array(await play.arrayBuffer());
    assert.equal(played.length, audio.length);
    assert.deepEqual(played.slice(0, 16), audio.slice(0, 16));

    // Downloading is a separate permission this role does not hold.
    const download = await app.request(`/api/calls/${callId}/recording?download=true`, { token: execToken });
    assert.equal(download.status, 403, JSON.stringify(download.body));

    // The admin may download, and the download is counted.
    const adminDownload = await app.request(`/api/calls/${callId}/recording?download=true`, {
      token: adminToken, raw: true,
    });
    assert.equal(adminDownload.status, 200);
    assert.match(adminDownload.headers.get('content-disposition') ?? '', /attachment/);
    const counted = await db.one('SELECT downloaded_count FROM call_recordings WHERE call_id = ?', [callId]);
    assert.equal(counted.downloaded_count, 1);

    // And the download left an audit trail.
    const auditRow = await db.one(
      "SELECT action FROM audit_logs WHERE entity_id = ? AND action = 'calls.recording_downloaded'", [callId]);
    assert.ok(auditRow, 'downloading a recording is audited');
  });

  test('an executive sees their own calls but not another agent\'s when scoped', async () => {
    const { app, tenantId, client } = await setup();
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);

    const accountant = await createUserWithRole(app, {
      tenantId, email: 'meera@meridiantax.test', fullName: 'Meera Iyer', roleKey: 'accountant',
    });
    const admin = await db.one('SELECT id FROM users WHERE email = ?', ['asha@meridiantax.test']);

    const mine = await seedCall(app, {
      tenantId, clientId: client.client.id, companyId: client.company.id, agentId: accountant.userId,
    });
    const theirs = await seedCall(app, {
      tenantId, clientId: client.client.id, companyId: client.company.id, agentId: admin.id,
    });

    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: accountant.email, password: accountant.password },
    });
    const token = login.data.token;

    // The accountant holds calls.view.own only.
    const list = await app.request('/api/calls', { token });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.data.map(c => c.id), [mine]);

    const blocked = await app.request(`/api/calls/${theirs}`, { token });
    assert.equal(blocked.status, 404, 'another agent\'s call is not even acknowledged');
  });
});
