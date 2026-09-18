import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, registerOrg, createUserWithRole, setPlan, activateAddOn, firstTenantId, testFile,
} from './helpers/app.js';

/**
 * The hardening work: upload scanning, the chatbot, cloud-storage folder
 * mapping, audit anchoring, the Content-Security-Policy and the deployment
 * preflight.
 *
 * The rule running through all of it is the same one the rest of this suite
 * holds to: the system records what actually happened. An unscanned file is
 * not "clean", an unreachable scanner is not "clean", a bot with nothing to
 * say hands over rather than inventing an answer, and a deployment with a
 * placeholder resource id does not deploy.
 */
describe('Hardening', () => {
  async function setup({ env = {}, addOns = [] } = {}) {
    const app = await createApp({ env });
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');
    for (const key of addOns) await activateAddOn(app, tenantId, key);

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Ravindra Textiles LLP',
        companyName: 'Ravindra Textiles LLP',
        gstin: '27AAGFR1234M1Z2',
        pan: 'AAGFR1234M',
        contactName: 'Sunita Ravindra',
        contactEmail: 'sunita@ravindratextiles.test',
        contactPhone: '9820114477',
        openCurrentPeriod: true,
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));
    return { app, adminToken, tenantId, client: client.data };
  }

  async function upload(app, token, client, file) {
    const form = new FormData();
    form.set('clientId', client.client.id);
    form.set('filingPeriodId', client.period.id);
    form.append('files', file);
    return app.request('/api/documents/upload', { method: 'POST', token, body: form });
  }

  /** The scan_status recorded for the newest version of a document. */
  async function scanStatusOf(app, documentId) {
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const row = await db.one(
      `SELECT scan_status FROM document_versions WHERE document_id = ?
        ORDER BY version_no DESC LIMIT 1`, [documentId]);
    return row?.scan_status ?? null;
  }

  // -- Upload scanning ------------------------------------------------------

  test('with no scanner configured an upload is recorded skipped, never clean', async () => {
    const { app, adminToken, client } = await setup();

    const res = await upload(app, adminToken, client, testFile('purchase_register.pdf', 'x'));
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const status = await scanStatusOf(app, res.data.created[0].id);
    assert.equal(status, 'skipped',
      'an unconfigured deployment must not claim files were checked');
    assert.notEqual(status, 'clean');
  });

  test('a scanner that reports a threat refuses the upload before it is stored', async () => {
    const { app, adminToken, client } = await setup({
      env: { VIRUS_SCAN_URL: 'https://scanner.test' },
    });

    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      JSON.stringify({ infected: true, viruses: ['Eicar-Test-Signature'] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      // The endpoint takes several files, so one rejected file is reported
      // against that file rather than failing the whole request.
      const res = await upload(app, adminToken, client, testFile('invoice.pdf', 'x'));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(res.data.created, [], 'nothing was accepted');
      assert.equal(res.data.failed.length, 1);
      assert.equal(res.data.failed[0].fileName, 'invoice.pdf');
      assert.match(res.data.failed[0].reason, /rejected/i);
      assert.match(res.data.failed[0].reason, /Eicar-Test-Signature/,
        'the person is told what was found, not just that it failed');
      assert.match(res.data.failed[0].reason, /not been stored/);
    } finally {
      globalThis.fetch = original;
    }

    // Nothing was written: no document, and no orphan version row.
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);
    const count = await db.one('SELECT COUNT(*) AS n FROM document_versions');
    assert.equal(count.n, 0, 'an infected file must not leave a version row behind');
  });

  test('a scanner that cannot be reached records failed, which is not clean', async () => {
    const { app, adminToken, client } = await setup({
      env: { VIRUS_SCAN_URL: 'https://scanner.test' },
    });

    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('connection refused'); };

    let created;
    try {
      const res = await upload(app, adminToken, client, testFile('bank_statement.pdf', 'x'));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      created = res.data.created[0].id;
    } finally {
      globalThis.fetch = original;
    }

    const status = await scanStatusOf(app, created);
    assert.equal(status, 'failed',
      'a scanner that errored has not cleared the file');
  });

  test('the scanner test fails when the scanner calls EICAR clean', async () => {
    const { VirusScanProvider } = await import('../src/integrations/antivirus.js');
    const provider = new VirusScanProvider({ VIRUS_SCAN_URL: 'https://scanner.test' });

    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ infected: false }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });

    try {
      const result = await provider.test();
      assert.equal(result.ok, false,
        'a scanner that misses EICAR is not detecting anything and must not pass');
      assert.match(result.error.message, /EICAR/);
      assert.equal(result.error.code, 'scanner_not_detecting');
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an unconfigured scanner reports skipped rather than failing', async () => {
    const { VirusScanProvider } = await import('../src/integrations/antivirus.js');
    const result = await new VirusScanProvider({}).scan(new Uint8Array([1, 2, 3]));
    assert.equal(result.scanStatus, 'skipped');
    assert.equal(result.threat, null);
  });

  // -- Upload limits, which the client upload screen needs ------------------

  test('the upload screen can read the limits the server enforces', async () => {
    const { app, adminToken } = await setup();

    // The client upload screen used to hard-code these and 403 on the
    // settings endpoint it had no permission for. This is the endpoint it
    // reads instead.
    const res = await app.request('/api/documents/limits', { token: adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.data.maxBytes > 0, 'a size ceiling is reported');
    assert.ok(typeof res.data.maxBytesLabel === 'string');
    assert.ok(Array.isArray(res.data.allowedExtensions) && res.data.allowedExtensions.length);
    assert.ok(Array.isArray(res.data.blockedExtensions));
    assert.ok(res.data.blockedExtensions.includes('exe'),
      'the deny list is part of what the screen must show');
    assert.ok(res.data.maxFilesPerUpload > 0);
  });

  test('a client can reach the limits endpoint and still cannot reach settings', async () => {
    const { app, tenantId } = await setup();

    const user = await createUserWithRole(app, {
      tenantId,
      email: 'sunita@ravindratextiles.test',
      fullName: 'Sunita Ravindra',
      roleKey: 'client',
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = login.data.token;

    // This is the request the upload screen used to make, and this is the
    // 403 that made it fall back to guessed limits.
    const settings = await app.request('/api/settings', { token });
    assert.equal(settings.status, 403, 'a client still holds no settings permission');

    const limits = await app.request('/api/documents/limits', { token });
    assert.equal(limits.status, 200, JSON.stringify(limits.body));
    assert.ok(limits.data.maxBytes > 0);
    assert.ok(limits.data.allowedExtensions.length);
  });

  test('the gateway list a client used to request is staff-only', async () => {
    const { app, adminToken, tenantId } = await setup();

    const user = await createUserWithRole(app, {
      tenantId,
      email: 'arun@ravindratextiles.test',
      fullName: 'Arun Ravindra',
      roleKey: 'client',
    });
    const login = await app.request('/api/auth/login', {
      method: 'POST', body: { email: user.email, password: user.password },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    // The payments screen called this unconditionally, so /client/payments
    // 403'd on every visit. The endpoint is right to refuse; the screen was
    // wrong to ask.
    const asClient = await app.request('/api/billing/gateways', { token: login.data.token });
    assert.equal(asClient.status, 403,
      'which gateways a firm has connected is not a client\'s business');

    const asStaff = await app.request('/api/billing/gateways', { token: adminToken });
    assert.equal(asStaff.status, 200, JSON.stringify(asStaff.body));
  });

  // -- Audit anchoring ------------------------------------------------------

  test('the anchor detects a chain truncated at its tail', async () => {
    const { app, tenantId } = await setup();
    const { Db } = await import('../src/db/client.js');
    const { anchorChain, verifyAgainstAnchor } = await import('../src/services/audit.js');
    const db = new Db(app.env.DB);

    const anchored = await anchorChain(db, tenantId);
    assert.equal(anchored.anchored, true, JSON.stringify(anchored));
    assert.ok(anchored.sequence > 0, 'registering an organisation writes audit entries');

    const clean = await verifyAgainstAnchor(db, tenantId);
    assert.equal(clean.covered, true, JSON.stringify(clean));
    assert.equal(clean.intact, true, JSON.stringify(clean));

    // Delete the tail — exactly what the bare hash chain cannot see.
    await db.run(
      'DELETE FROM audit_logs WHERE tenant_id IS ? AND sequence >= ?',
      [tenantId, anchored.sequence]);

    const after = await verifyAgainstAnchor(db, tenantId);
    assert.equal(after.covered, true, 'an anchor exists, so the answer is meaningful');
    assert.equal(after.intact, false, 'truncation must be reported');
    assert.match(after.reason, /removed/i);
  });

  test('verifying with no anchor reports not covered rather than passing', async () => {
    const { app, tenantId } = await setup();
    const { Db } = await import('../src/db/client.js');
    const { verifyAgainstAnchor } = await import('../src/services/audit.js');

    const result = await verifyAgainstAnchor(new Db(app.env.DB), tenantId);
    assert.equal(result.covered, false,
      'an absent anchor proves nothing and must not read as a pass');
  });

  test('anchoring refuses to move backwards', async () => {
    const { app, tenantId } = await setup();
    const { Db } = await import('../src/db/client.js');
    const { anchorChain } = await import('../src/services/audit.js');
    const db = new Db(app.env.DB);

    const first = await anchorChain(db, tenantId);
    assert.equal(first.anchored, true);

    await db.run('DELETE FROM audit_logs WHERE tenant_id IS ? AND sequence >= ?',
      [tenantId, first.sequence]);

    const second = await anchorChain(db, tenantId);
    assert.equal(second.anchored, false);
    assert.equal(second.reason, 'chain_shrank',
      'overwriting the anchor would erase the only evidence of the truncation');
  });

  // -- Chatbot --------------------------------------------------------------

  test('a flow with a jump to a node that does not exist is refused', async () => {
    const { validateFlow } = await import('../src/services/chatbot.js');

    const result = validateFlow({
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'message', prompt: 'Hello.', next: 'nowhere' },
      ],
    });

    assert.equal(result.valid, false);
    assert.match(JSON.stringify(result.errors), /nowhere/);
  });

  test('a flow whose entry node is missing is refused', async () => {
    const { validateFlow } = await import('../src/services/chatbot.js');
    const result = validateFlow({
      entryNodeId: 'missing',
      nodes: [{ id: 'start', type: 'message', prompt: 'Hello.' }],
    });
    assert.equal(result.valid, false);
    assert.match(JSON.stringify(result.errors), /missing/);
  });

  test('a well-formed flow validates', async () => {
    const { validateFlow } = await import('../src/services/chatbot.js');
    const result = validateFlow({
      entryNodeId: 'start',
      nodes: [
        { id: 'start', type: 'message', prompt: 'Hello.', next: 'ask' },
        { id: 'ask', type: 'question', prompt: 'What do you need?', options: [
          { label: 'Status', next: 'status' },
          { label: 'Someone else', next: 'human' },
        ] },
        { id: 'status', type: 'status', prompt: 'Checking that for you.' },
        { id: 'human', type: 'handover' },
      ],
    });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  // -- Cloud-storage folder mapping ----------------------------------------

  /**
   * Mark a storage provider connected.
   *
   * The API refuses to map a folder for a provider nobody has linked, which is
   * the right behaviour and means these tests have to link one first.
   */
  async function connectStorage(app, tenantId, provider = 'google_drive') {
    const { Db } = await import('../src/db/client.js');
    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const db = new Db(app.env.DB);
    const id = ID.integration();
    await db.run(
      `INSERT INTO integrations
         (id, tenant_id, provider, category, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'storage', ?, 'connected', ?, ?)`,
      [id, tenantId, provider, provider.replace(/_/g, ' '), nowIso(), nowIso()]);
    return id;
  }

  test('a folder mapping is refused while the provider is not connected', async () => {
    const { app, adminToken } = await setup({ addOns: ['google_drive'] });

    const res = await app.request('/api/integrations/storage/folders', {
      method: 'POST', token: adminToken,
      body: { provider: 'google_drive', remotePath: '/GST Returns 2026-27' },
    });
    assert.notEqual(res.status, 201,
      'a map pointing at an unlinked account would queue documents that can never arrive');
    assert.match(JSON.stringify(res.body), /not connected/i);
  });

  test('a folder mapping is created, listed and removed', async () => {
    const { app, adminToken, tenantId } = await setup({ addOns: ['google_drive'] });
    await connectStorage(app, tenantId);

    const created = await app.request('/api/integrations/storage/folders', {
      method: 'POST', token: adminToken,
      body: {
        provider: 'google_drive',
        remotePath: '/GST Returns 2026-27',
        remoteFolderId: '1AbCdEfGhIjKlMnOpQrStUv',
        syncOn: 'verified',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mapId = created.data.folder.id;
    assert.ok(mapId, 'the new mapping is returned with its id');

    const list = await app.request('/api/integrations/storage/folders', { token: adminToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.data.folders.length, 1);
    assert.equal(list.data.folders[0].remotePath, '/GST Returns 2026-27');
    assert.ok(list.data.providers.includes('google_drive'));

    const removed = await app.request(
      `/api/integrations/storage/folders/${mapId}`,
      { method: 'DELETE', token: adminToken });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const after = await app.request('/api/integrations/storage/folders', { token: adminToken });
    assert.equal(after.data.folders.length, 0);
  });

  test('one provider cannot be mapped twice for the same scope', async () => {
    const { app, adminToken, tenantId } = await setup({ addOns: ['google_drive'] });
    await connectStorage(app, tenantId);

    const body = { provider: 'google_drive', remotePath: '/Bank Statements' };
    const first = await app.request('/api/integrations/storage/folders', {
      method: 'POST', token: adminToken, body,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const second = await app.request('/api/integrations/storage/folders', {
      method: 'POST', token: adminToken,
      body: { provider: 'google_drive', remotePath: '/Somewhere Else' },
    });
    assert.equal(second.status, 409, JSON.stringify(second.body));
  });

  test('a folder mapping is invisible to another organisation', async () => {
    const { app, adminToken, tenantId } = await setup({ addOns: ['google_drive'] });
    await connectStorage(app, tenantId);

    const created = await app.request('/api/integrations/storage/folders', {
      method: 'POST', token: adminToken,
      body: { provider: 'google_drive', remotePath: '/Confidential' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mapId = created.data.folder.id;
    assert.ok(mapId, 'the new mapping is returned with its id');

    const other = await registerOrg(app, {
      organisationName: 'Kalyan & Associates',
      email: 'admin@kalyanassociates.test',
    });
    const otherToken = other.res.data.token;
    const otherTenant = other.res.data.tenant?.id ?? null;
    await setPlan(app, otherTenant ?? await firstTenantId(app), 'pro');

    const list = await app.request('/api/integrations/storage/folders', { token: otherToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.data.folders.length, 0, 'another firm sees none of it');

    const reach = await app.request(
      `/api/integrations/storage/folders/${mapId}`,
      { method: 'DELETE', token: otherToken });
    assert.equal(reach.status, 404, 'and cannot delete it by id either');
  });

  // -- The global call widget's endpoint ------------------------------------

  test('the live-calls endpoint answers a platform owner with an empty list', async () => {
    const app = await createApp({
      env: {
        PLATFORM_OWNER_EMAIL: 'owner@meetmillions.test',
        PLATFORM_OWNER_PASSWORD: 'A-Long-Enough-Passw0rd',
      },
    });

    let login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@meetmillions.test', password: 'A-Long-Enough-Passw0rd' },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));

    const changed = await app.request('/api/auth/change-password', {
      method: 'POST', token: login.data.token,
      body: {
        currentPassword: 'A-Long-Enough-Passw0rd',
        newPassword: 'Another-Str0ng-Passw0rd',
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));

    login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@meetmillions.test', password: 'Another-Str0ng-Passw0rd' },
    });

    // The widget polls this on every screen. Before the guard it threw
    // "A tenant scope requires a tenant id" and 500ed on every heartbeat.
    const res = await app.request('/api/calls/live', { token: login.data.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.data.calls, []);
  });

  // -- Deployment preflight -------------------------------------------------

  test('the preflight refuses a placeholder resource id and passes a real one', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { readFile, writeFile } = await import('node:fs/promises');
    const run = promisify(execFile);

    const original = await readFile('wrangler.jsonc', 'utf8');
    const attempt = async (databaseId) => {
      await writeFile('wrangler.jsonc',
        original.replace('"REPLACE_WITH_D1_DATABASE_ID"', JSON.stringify(databaseId)));
      try {
        await run(process.execPath, ['scripts/preflight-deploy.mjs']);
        return 0;
      } catch (err) {
        return err.code ?? 1;
      }
    };

    try {
      // The exact value that reached the Cloudflare API and came back as
      // "binding DB of type d1 must have a valid database_id" [code: 10021].
      assert.equal(await attempt('00000000-0000-0000-0000-000000000000'), 1,
        'an all-zero id must never reach a deploy');
      assert.equal(await attempt('REPLACE_WITH_D1_DATABASE_ID'), 1);
      assert.equal(await attempt('8f2a1c9e-4b7d-4e3a-9c15-6d0f2b8a7e41'), 0,
        'a real id must not be mistaken for a placeholder');
    } finally {
      await writeFile('wrangler.jsonc', original);
    }
  });

  test('the build enforces the preflight when the pipeline also deploys', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    // Cloudflare Workers Builds defaults its deploy command to
    // `npx wrangler deploy`, which never runs `npm run deploy`. The build has
    // to catch a placeholder by itself or nothing does.
    let failed = false;
    let output = '';
    try {
      await run(process.execPath, ['scripts/build.mjs', '--quiet'],
        { env: { ...process.env, WORKERS_CI: '1' } });
    } catch (err) {
      failed = true;
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }

    assert.ok(failed, 'a placeholder database_id must fail a build that will deploy');
    assert.match(output, /database_id/);
    assert.match(output, /wrangler d1 create/, 'and must name the command that fixes it');

    // The same build must still pass for somebody who has just cloned the
    // repository and is not deploying anything.
    await run(process.execPath, ['scripts/build.mjs', '--quiet'],
      { env: { ...process.env, WORKERS_CI: undefined, DEPLOY_PREFLIGHT: '0' } });
  });

  // -- Content-Security-Policy ---------------------------------------------

  test('the document policy allows the inline theme script by hash, not by unsafe-inline', async () => {
    const { documentCsp, INLINE_THEME_SCRIPT_HASH } = await import('../src/http/security.js');
    const policy = documentCsp();

    assert.match(policy, /script-src [^;]*'sha256-/);
    assert.ok(policy.includes(INLINE_THEME_SCRIPT_HASH));
    assert.doesNotMatch(policy, /script-src [^;]*'unsafe-inline'/,
      "a hash is the point; 'unsafe-inline' would discard it");
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
  });

  test('the API policy allows nothing at all', async () => {
    const { apiCsp } = await import('../src/http/security.js');
    assert.match(apiCsp(), /default-src 'none'/);
    assert.match(apiCsp(), /frame-ancestors 'none'/);
  });

  test('a white-label origin is added to connect-src, and a malformed one is not', async () => {
    const { documentCsp } = await import('../src/http/security.js');

    assert.match(documentCsp({ appUrl: 'https://crm.ravindratextiles.test' }),
      /connect-src [^;]*https:\/\/crm\.ravindratextiles\.test/);
    assert.doesNotMatch(documentCsp({ appUrl: 'not a url' }), /not a url/);
    assert.doesNotMatch(documentCsp({ appUrl: 'http://insecure.test' }), /insecure\.test/,
      'a plain-http origin is not added');
  });

  test('HSTS is sent over https and withheld over http', async () => {
    const { hstsFor } = await import('../src/http/security.js');
    assert.ok(hstsFor(new URL('https://crm.test/'))['Strict-Transport-Security']);
    assert.deepEqual(hstsFor(new URL('http://localhost:8787/')), {});
  });

  // -- The Meta webhook handshake, which read the wrong variable name -------

  test('the Meta lead handshake uses the variable the rest of the system documents', async () => {
    const app = await createApp({ env: { META_LEADGEN_VERIFY_TOKEN: 'meta-verify-abc' } });

    const good = await app.request(
      '/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=meta-verify-abc&hub.challenge=42',
      { raw: true });
    assert.equal(good.status, 200, 'the documented variable must be the one that is read');
    assert.equal((await good.text()).trim(), '42');

    const bad = await app.request(
      '/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42',
      { raw: true });
    assert.equal(bad.status, 403);
  });
});
