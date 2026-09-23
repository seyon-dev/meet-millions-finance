import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './helpers/app.js';

/**
 * A fresh deployment has to bring itself up.
 *
 * A Worker has no deploy hook, so nothing runs between `wrangler deploy` and
 * the first request. Without the lazy bootstrap there are no permissions, no
 * roles and no plans on a new deployment — every request 403s and nobody can
 * sign in to fix it. These tests exist so that failure mode cannot return
 * unnoticed.
 */
describe('Deployment bootstrap', () => {
  test('a Worker with an empty database seeds itself on the first request', async () => {
    // `bootstrap: false` is the state a freshly deployed Worker is actually in:
    // migrations applied, nothing seeded.
    const app = await createApp({ bootstrap: false });

    const before = await app.DB.prepare('SELECT COUNT(*) AS n FROM permissions').first();
    assert.equal(Number(before.n), 0, 'the fixture really is an unseeded deployment');

    const res = await app.request('/ready');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.data.status, 'ready');
    assert.equal(res.data.seededNow, true);

    for (const [table, least] of [['permissions', 130], ['roles', 7], ['plans', 3], ['add_ons', 30]]) {
      const row = await app.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
      assert.ok(Number(row.n) >= least, `${table} has ${row.n}, expected at least ${least}`);
    }
  });

  test('a second request does not seed again', async () => {
    const app = await createApp({ bootstrap: false });

    await app.request('/ready');
    const again = await app.request('/ready');
    assert.equal(again.data.seededNow, false, 'the marker row stopped a second run');

    const roles = await app.DB.prepare(
      "SELECT COUNT(*) AS n FROM roles WHERE tenant_id IS NULL").first();
    assert.equal(Number(roles.n), 7, 'the seven system roles, not fourteen');
  });

  test('health answers without the database, so it stays truthful when D1 is the problem', async () => {
    const app = await createApp({ bootstrap: false });

    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'ok');

    const permissions = await app.DB.prepare('SELECT COUNT(*) AS n FROM permissions').first();
    assert.equal(Number(permissions.n), 0, '/health did not touch the database');
  });

  test('the first Super Admin is created from the environment, once, and must change its password', async () => {
    const app = await createApp({
      bootstrap: false,
      env: {
        PLATFORM_OWNER_EMAIL: 'owner@meetmillions.test',
        PLATFORM_OWNER_PASSWORD: 'A-Long-Enough-Passw0rd',
        PLATFORM_OWNER_NAME: 'Platform Owner',
      },
    });

    const res = await app.request('/ready');
    assert.equal(res.data.platformOwner.created, true);

    const user = await app.DB.prepare(
      'SELECT * FROM users WHERE email = ?').bind('owner@meetmillions.test').first();
    assert.ok(user, 'the account exists');
    assert.equal(user.tenant_id, null, 'it belongs to no organisation');
    assert.equal(Number(user.must_change_password), 1,
      'the value that configured it does not remain the password');

    // And it really can sign in.
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'owner@meetmillions.test', password: 'A-Long-Enough-Passw0rd' },
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.data.mustChangePassword, true);
  });

  test('a short platform-owner password creates no account at all', async () => {
    const app = await createApp({
      bootstrap: false,
      env: { PLATFORM_OWNER_EMAIL: 'owner@meetmillions.test', PLATFORM_OWNER_PASSWORD: 'short' },
    });

    const res = await app.request('/ready');
    assert.equal(res.data.platformOwner.created, false);
    assert.equal(res.data.platformOwner.reason, 'password_too_weak');

    const user = await app.DB.prepare(
      'SELECT id FROM users WHERE email = ?').bind('owner@meetmillions.test').first();
    assert.equal(user ?? null, null, 'a weak password is refused rather than accepted quietly');
  });

  test('with no platform-owner variables there is no default account and no default password', async () => {
    const app = await createApp({ bootstrap: false });
    const res = await app.request('/ready');

    assert.equal(res.data.platformOwner.created, false);
    assert.equal(res.data.platformOwner.reason, 'not_configured');

    const admins = await app.DB.prepare(
      'SELECT COUNT(*) AS n FROM users WHERE tenant_id IS NULL').first();
    assert.equal(Number(admins.n), 0, 'nothing ships with a way in');
  });

  test('a catalogue version bump re-seeds, and updates the marker rather than duplicating it', async () => {
    const app = await createApp({ bootstrap: false });
    const { Db } = await import('../src/db/client.js');
    const { ensureBootstrapped } = await import('../src/services/bootstrap.js');
    const db = new Db(app.env.DB);

    assert.equal((await ensureBootstrapped(app.env)).ran, true, 'the first run seeds');
    assert.equal((await ensureBootstrapped(app.env)).ran, false, 'the second does not');

    // What a released catalogue change looks like to an already-deployed
    // database: the stored version no longer matches the code's.
    await db.run(`UPDATE settings SET value_json = '"0"'
                   WHERE tenant_id IS NULL AND namespace = 'platform' AND key = 'bootstrap_version'`);

    // A different binding object stands in for a fresh isolate, whose memo is
    // empty.
    const fresh = { ...app.env, DB: Object.create(app.env.DB) };
    assert.equal((await ensureBootstrapped(fresh)).ran, true, 'an older version re-seeds');

    const marker = await db.one(
      `SELECT value_json FROM settings
        WHERE tenant_id IS NULL AND namespace = 'platform' AND key = 'bootstrap_version'`);
    assert.equal(marker.value_json, '"1"', 'the marker was brought up to date');

    const rows = await db.one('SELECT COUNT(*) AS n FROM settings');
    assert.equal(Number(rows.n), 1, 'one marker row, not one per run');
  });

  /**
   * The Hostinger outage, in one test.
   *
   * ensureBootstrapped ran *above* the handler's try/catch, so anything it
   * threw bypassed every piece of error handling below it: no requestId, no
   * `unhandled` log line, no system-event row. The exception left the Worker
   * altogether and the Express wrapper answered with a bare 500 carrying no
   * request id — so the runtime logs had nothing tying the failure to a cause,
   * on a code path every single request goes through.
   *
   * What actually threw was a MySQL 1064: the bootstrap's first statement
   * filters on `key`, a reserved word, and nothing quoted it at query time.
   * That half is covered in tests/dialect.test.js. This half is the blind
   * spot, which would have hidden the next failure just as well.
   */
  test('a failing bootstrap returns a handled error with a request id', async () => {
    const app = await createApp({ bootstrap: false });

    // Stand in for the 1064: the first statement the bootstrap issues throws.
    const realPrepare = app.DB.prepare.bind(app.DB);
    app.DB.prepare = (sql) => {
      if (/FROM settings/i.test(sql) && /bootstrap_version/.test(sql)) {
        const err = new Error("You have an error in your SQL syntax near 'key = ...'");
        err.code = 'ER_PARSE_ERROR';
        throw err;
      }
      return realPrepare(sql);
    };

    try {
      const res = await app.request('/ready');

      assert.equal(res.status, 500, 'the failure is reported, not swallowed');
      assert.ok(res.body?.meta?.requestId,
        'the response carries a requestId — without one the runtime logs cannot be tied to it');
      // db_error, not internal_error: the Db layer types the failure on the
      // way past, which is the handling that was being skipped. It is not
      // `expose`d, so fail() swaps the message for the generic sentence and
      // the SQL stays in the log where it belongs.
      assert.equal(res.body?.error?.code, 'db_error');
      assert.doesNotMatch(String(res.body?.error?.message ?? ''), /SQL syntax/,
        'the database error is logged, never shown to the caller');
      assert.doesNotMatch(String(res.body?.error?.message ?? ''), /settings|key/i,
        'nor is the statement that failed');
    } finally {
      app.DB.prepare = realPrepare;
    }
  });

  test('the same holds for an ordinary API request, not just /ready', async () => {
    const app = await createApp({ bootstrap: false });

    const realPrepare = app.DB.prepare.bind(app.DB);
    app.DB.prepare = (sql) => {
      if (/FROM settings/i.test(sql) && /bootstrap_version/.test(sql)) {
        throw new Error('bootstrap unavailable');
      }
      return realPrepare(sql);
    };

    try {
      const res = await app.request('/api/auth/login', {
        method: 'POST', body: { email: 'someone@example.test', password: 'whatever-it-is' },
      });
      assert.equal(res.status, 500);
      assert.ok(res.body?.meta?.requestId, 'every request path gets a requestId, not only /ready');
    } finally {
      app.DB.prepare = realPrepare;
    }
  });
});
