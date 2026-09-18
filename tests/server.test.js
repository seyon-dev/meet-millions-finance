import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Node.js server.
 *
 * The application was written for Cloudflare Workers and is served here by
 * Express. These tests drive the real server over real HTTP — not the handler
 * directly — because what could break in that move is precisely the layer in
 * between: request translation, streaming bodies, static files, the SPA
 * fallback and which paths reach the application at all.
 *
 * The database is the same SQLite binding the rest of the suite uses, so a
 * failure here is the server layer rather than the application.
 */
describe('Node server', () => {
  let server; let base; let store; let token; let d1;

  before(async () => {
    store = mkdtempSync(join(tmpdir(), 'mm-store-'));
    Object.assign(process.env, {
      STORAGE_ROOT: store,
      AUTH_SECRET: 'x'.repeat(48),
      ENCRYPTION_KEY: 'y'.repeat(48),
      FILE_SIGNING_SECRET: 'z'.repeat(48),
      DEMO_MODE: 'false',
      RUN_SCHEDULER: 'false',
      DB_HOST: 'unused', DB_NAME: 'unused', DB_USER: 'unused', DB_PASSWORD: 'unused',
    });

    const { createTestD1 } = await import('./helpers/d1.js');
    const { createServer } = await import('../server.js');
    d1 = createTestD1();
    const { app } = await createServer({ db: d1 });
    // Port 0 asks the OS for a free one. A fixed port means a single leftover
    // process from an interrupted run wedges every later run with EADDRINUSE.
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.APP_URL = base;

    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organisationName: 'Prakash & Associates', fullName: 'Prakash Iyer',
        email: 'prakash@prakashassociates.test', password: 'Str0ng-Passw0rd!24',
        phone: '9845001122',
      }),
    });
    token = (await reg.json()).data?.token;

    const tenant = await d1.prepare('SELECT id FROM tenants LIMIT 1').first();
    const pro = await d1.prepare("SELECT id FROM plans WHERE `key` = 'pro'").first();
    if (tenant && pro) {
      await d1.prepare('UPDATE subscriptions SET plan_id = ? WHERE tenant_id = ?')
        .bind(pro.id, tenant.id).run();
    }
  });

  after(() => { server?.close(); });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  // -- Routing --------------------------------------------------------------

  test('the application shell is served for an SPA route', async () => {
    for (const path of ['/', '/clients', '/documents/abc', '/settings/security']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    }
  });

  test('a document policy and the shared headers are on the shell', async () => {
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('static assets are served', async () => {
    const res = await fetch(`${base}/assets/css/app.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /css/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('/health and /ready reach the application, not the SPA shell', async () => {
    // Both sit outside /api/. An Express pattern matching only /api, /webhooks
    // and /files sent them to the HTML shell — a health check that answers 200
    // with a web page is worse than one that fails, because a monitor believes it.
    for (const path of ['/health', '/ready']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /json/,
        `${path} must answer as the application, not as the shell`);
    }
  });

  test('an unauthenticated API request is refused', async () => {
    const res = await fetch(`${base}/api/clients`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });

  // -- The application through Express --------------------------------------

  test('registration, session and the authenticated API all work over HTTP', async () => {
    assert.ok(token, 'registration issued a token');

    const me = await fetch(`${base}/api/auth/me`, { headers: auth() });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.user.email, 'prakash@prakashassociates.test');
  });

  test('a representative route from every module family answers', async () => {
    const routes = [
      '/api/clients', '/api/companies', '/api/users', '/api/documents',
      '/api/documents/types/list', '/api/documents/limits', '/api/verification/queue',
      '/api/queries', '/api/tax/computations', '/api/reports', '/api/approvals',
      '/api/billing/subscription', '/api/billing/invoices', '/api/addons',
      '/api/notifications', '/api/dashboard', '/api/settings', '/api/audit',
      '/api/analytics/overview', '/api/calls', '/api/calls/live',
      '/api/messaging/threads', '/api/support/tickets', '/api/integrations',
      '/api/automation', '/api/tasks', '/api/leads', '/api/marketplace',
      '/api/api-keys', '/api/branches', '/api/activity',
    ];

    const serverErrors = [];
    for (const path of routes) {
      const res = await fetch(base + path, { headers: auth() });
      if (res.status >= 500) serverErrors.push(`${res.status} ${path}`);
    }
    assert.deepEqual(serverErrors, [], 'no route may fault through the Express layer');
  });

  // -- Storage --------------------------------------------------------------

  test('an upload is written to the filesystem and read back', async () => {
    const client = await fetch(`${base}/api/clients`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Vaishali Traders', companyName: 'Vaishali Traders',
        contactName: 'Vaishali Rao', contactEmail: 'vaishali@vaishalitraders.test',
        contactPhone: '9845002200', openCurrentPeriod: true,
      }),
    });
    assert.equal(client.status, 201, JSON.stringify(await client.clone().json()));
    const c = (await client.json()).data;

    const form = new FormData();
    form.set('clientId', c.client.id);
    form.set('filingPeriodId', c.period.id);
    form.append('files', new File(
      [new TextEncoder().encode('%PDF-1.4 sales register')], 'sales_register.pdf',
      { type: 'application/pdf' }));

    const up = await fetch(`${base}/api/documents/upload`, {
      method: 'POST', headers: auth(), body: form,
    });
    assert.equal(up.status, 201, JSON.stringify(await up.clone().json()));
    const created = (await up.json()).data.created[0];

    // On disk, under a tenant-scoped path — the key scheme is what carries
    // tenant isolation into the filesystem.
    const walk = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = walk(store).filter(f => !f.endsWith('.meta.json'));
    assert.equal(files.length, 1);
    assert.match(files[0], /tenant\/ten_/, 'stored under its tenant');
    assert.match(files[0], /sales_register\.pdf$/);

    const dl = await fetch(`${base}/api/documents/${created.id}/download`, {
      headers: auth(), redirect: 'manual',
    });
    assert.ok(dl.status < 400, `download answered ${dl.status}`);
  });

  test('the storage root refuses a key that climbs out of it', async () => {
    const { FilesystemStorage } = await import('../src/storage/filesystem.js');
    const storage = new FilesystemStorage(store);
    await assert.rejects(
      () => storage.put('../../etc/passwd', 'nope'),
      /escapes the storage root/,
      'a traversing key must be refused on the resolved path, not the string');
  });

  test('a document is not reachable without going through the API', async () => {
    // The storage root must sit outside anything express.static publishes.
    const res = await fetch(`${base}/sales_register.pdf`);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/,
      'a document path falls through to the SPA shell, not to the file');
  });

  // -- The Hostinger entry point --------------------------------------------

  test('server.js can be require()d — no top-level await in its graph', async () => {
    // Hostinger's runtime loads the configured entry file with require().
    // A top-level await anywhere in the graph makes that throw
    // ERR_REQUIRE_ASYNC_MODULE, which is what returned 503 on every request.
    const { execFileSync } = await import('node:child_process');
    // The path goes through the environment, not argv: server.js decides
    // whether to start by comparing itself to process.argv[1], and passing it
    // there would make it think it is the entry point and listen for ever.
    const probe = `try { require(process.env.PROBE_TARGET); console.log('OK'); }
      catch (e) { console.log('FAIL:' + e.code); }`;
    const out = execFileSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, PROBE_TARGET: join(process.cwd(), 'server.js') },
      timeout: 30000,
    });
    assert.match(out, /OK/, out);
    assert.doesNotMatch(out, /ERR_REQUIRE_ASYNC_MODULE/);
  });

  test('server.cjs is CommonJS and exports no ESM syntax', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(process.cwd(), 'server.cjs'), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s+[\w{*]/m,
      'a static import would make this file ESM and defeat its purpose');
    assert.doesNotMatch(source, /^\s*export\s/m);
    assert.match(source, /await import\(/, 'it reaches the ESM app through dynamic import');
  });

  test('server.js exports start(), which the bootstrap depends on', async () => {
    // Loaded through server.cjs, process.argv[1] is the bootstrap, so the
    // isMain check in server.js is false and nothing starts by itself. If
    // start() ever stops being exported, the process would come up and serve
    // nothing — a 503 that looks like a healthy deploy.
    const mod = await import('../server.js');
    assert.equal(typeof mod.start, 'function');
    assert.equal(typeof mod.default.start, 'function');
  });

  test('the bootstrap fails loudly when configuration is missing', async () => {
    const { execFileSync } = await import('node:child_process');
    let stdout = ''; let code = 0;
    try {
      stdout = execFileSync(process.execPath, [join(process.cwd(), 'server.cjs')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, STORAGE_ROOT: store },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch (err) {
      code = err.status;
      stdout = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    assert.equal(code, 1, 'a failed start must exit non-zero, not idle behind a 503');
    assert.match(stdout, /failed to start/i);
    assert.match(stdout, /DB_HOST/, 'and must name what is missing');
  });

  // -- Configuration --------------------------------------------------------

  test('missing database configuration fails with a specific message', async () => {
    const { poolConfigFromEnv } = await import('../src/db/mysql.js');
    assert.throws(
      () => poolConfigFromEnv({ DB_HOST: 'h' }),
      /DB_NAME, DB_USER, DB_PASSWORD are not set/,
      'it must name what is missing, not just fail');
  });

  test('storage inside the published directory is refused at startup', async () => {
    const { createServer } = await import('../server.js');
    const saved = process.env.STORAGE_ROOT;
    process.env.STORAGE_ROOT = join(process.cwd(), 'public', 'uploads');
    try {
      await assert.rejects(
        () => createServer({ db: d1 }),
        /would be downloadable without signing in/,
        'documents under the web root would be public');
    } finally {
      process.env.STORAGE_ROOT = saved;
    }
  });
});
