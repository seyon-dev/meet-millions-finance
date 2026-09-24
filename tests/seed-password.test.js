/**
 * The demonstration seed honours DEMO_PASSWORD.
 *
 * scripts/seed-guard.mjs allows a production seed once DEMO_PASSWORD is set.
 * That permission is only meaningful if the seed then actually uses it. It
 * did not: the password was a module-level constant, captured the first time
 * the file was imported, while the guard read the variable when it decided.
 *
 * The way they disagreed was the dangerous one — the guard saw the variable
 * set and allowed the seed, and every account was created with the password
 * published in this repository, including a Super Admin who can see every
 * organisation on the platform.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { demoPassword, PUBLISHED_DEMO_PASSWORD, seedDemoData } from '../scripts/seed-demo.mjs';
import { verifyPassword } from '../src/auth/password.js';
import { ensureBootstrapped } from '../src/services/bootstrap.js';
import { createTestD1, R2Shim, KVShim } from './helpers/d1.js';
import { TEST_ENV_BASE } from './helpers/app.js';

describe('demoPassword', () => {
  test('prefers the environment it is handed', () => {
    assert.equal(demoPassword({ DEMO_PASSWORD: 'Set-By-Operator!24' }), 'Set-By-Operator!24');
  });

  test('falls back to the published one only when nothing is set', () => {
    const saved = process.env.DEMO_PASSWORD;
    delete process.env.DEMO_PASSWORD;
    try {
      assert.equal(demoPassword({}), PUBLISHED_DEMO_PASSWORD);
    } finally {
      if (saved !== undefined) process.env.DEMO_PASSWORD = saved;
    }
  });
});

describe('seeding with DEMO_PASSWORD set', () => {
  test('every account it creates uses that password, not the published one', async () => {
    const chosen = 'Chosen-By-The-Operator!24';
    const env = {
      ...TEST_ENV_BASE,
      DB: createTestD1(), DOCS: new R2Shim(), CACHE: new KVShim(),
      DEMO_PASSWORD: chosen,
    };

    await ensureBootstrapped(env);          // roles must exist before a tenant is provisioned
    const result = await seedDemoData(env);
    assert.equal(result.reused, false);

    const users = await env.DB.prepare('SELECT email, password_hash FROM users').all();
    assert.ok(users.results.length >= 12, `expected the full demo set, got ${users.results.length}`);

    for (const user of users.results) {
      assert.ok(await verifyPassword(chosen, user.password_hash),
        `${user.email} was not created with DEMO_PASSWORD`);
      assert.equal(await verifyPassword(PUBLISHED_DEMO_PASSWORD, user.password_hash), false,
        `${user.email} accepts the password published in this repository`);
    }
  });
});
