/**
 * The demonstration seed's production guard.
 *
 * This is a security control, not a convenience: the demonstration set
 * includes a Super Admin who sees every organisation on the platform, and its
 * fallback password is in this repository. If the guard regresses, `npm run
 * seed` on the production database creates that account with a password
 * anyone can read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideSeed } from '../scripts/seed-guard.mjs';

test('refuses production seeding with the published password', () => {
  const d = decideSeed({ argv: [], env: { NODE_ENV: 'production' } });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'published_password_in_production');
  assert.match(d.message, /DEMO_PASSWORD/);
});

test('allows production seeding once DEMO_PASSWORD is set', () => {
  const d = decideSeed({ argv: [], env: { NODE_ENV: 'production', DEMO_PASSWORD: 'set-by-the-operator' } });
  assert.equal(d.allowed, true);
  assert.equal(d.passwordIsPublished, false);
});

test('allows production seeding when the risk is accepted out loud', () => {
  const d = decideSeed({ argv: ['--i-accept-the-risk'], env: { NODE_ENV: 'production' } });
  assert.equal(d.allowed, true);
});

test('does not guard development, where the published password is the point', () => {
  assert.equal(decideSeed({ argv: [], env: {} }).allowed, true);
  assert.equal(decideSeed({ argv: [], env: { NODE_ENV: 'development' } }).allowed, true);
});

test('--check is read-only, so it reports rather than refusing', () => {
  const d = decideSeed({ argv: ['--check'], env: { NODE_ENV: 'production' } });
  assert.equal(d.allowed, true);
  assert.equal(d.dryRun, true);
  assert.equal(d.reason, 'dry_run');
});

test('the server startup path can accept the risk through the environment', () => {
  // server.js has no argv to pass, so SEED_DEMO_ACCEPT_RISK is the same
  // decision in the only form that path can express.
  const d = decideSeed({ argv: [], env: { NODE_ENV: 'production', SEED_DEMO_ACCEPT_RISK: 'true' } });
  assert.equal(d.allowed, true);
});

test('only the exact string true accepts it', () => {
  for (const value of ['1', 'yes', 'TRUE', '', 'false']) {
    const d = decideSeed({ argv: [], env: { NODE_ENV: 'production', SEED_DEMO_ACCEPT_RISK: value } });
    assert.equal(d.allowed, false, `SEED_DEMO_ACCEPT_RISK=${value} must not be enough`);
  }
});
