/**
 * Test harness.
 *
 * Boots the real Worker against in-memory D1/R2/KV shims, applies the real
 * migrations, runs the real platform bootstrap, and exposes a small client
 * for issuing requests. Nothing about the application under test is mocked —
 * only the storage bindings are swapped for in-process equivalents.
 */

import worker from '../../src/index.js';
import { createTestD1, R2Shim, KVShim } from './d1.js';
import { bootstrapPlatform } from '../../src/services/bootstrap.js';

export const TEST_ENV_BASE = {
  APP_NAME: 'Meet Millions Finance CRM',
  APP_ENV: 'test',
  APP_URL: 'https://test.meetmillionscrm.in',
  AUTH_SECRET: 'test-auth-secret-value-at-least-32-bytes-long-000',
  ENCRYPTION_KEY: 'test-encryption-key-value-at-least-32-bytes-0000',
  FILE_SIGNING_SECRET: 'test-file-signing-secret-at-least-32-bytes-00000',
  SESSION_TTL_HOURS: '12',
  UPLOAD_MAX_BYTES: String(50 * 1024 * 1024),
  AUDIT_RETENTION_DAYS: '2555',
  DEMO_MODE: 'false',
};

/** Build an isolated application instance. */
export async function createApp({ env = {}, bootstrap = true } = {}) {
  const DB = createTestD1();
  const DOCS = new R2Shim();
  const CACHE = new KVShim();

  const fullEnv = { ...TEST_ENV_BASE, ...env, DB, DOCS, CACHE };
  if (bootstrap) await bootstrapPlatform(fullEnv);

  const pending = [];
  const executionCtx = {
    waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
    passThroughOnException: () => {},
  };

  /** Issue a request and return { status, body, headers }. */
  async function request(path, {
    method = 'GET', body = null, token = null, headers = {}, apiKey = null, ip = '203.0.113.10',
    userAgent = 'meet-millions-tests/1.0', raw = false,
  } = {}) {
    const requestHeaders = new Headers({
      'CF-Connecting-IP': ip,
      'User-Agent': userAgent,
      ...headers,
    });
    if (token) requestHeaders.set('Authorization', `Bearer ${token}`);
    if (apiKey) requestHeaders.set('X-Api-Key', apiKey);

    let payload;
    if (body instanceof FormData) {
      payload = body;
    } else if (typeof body === 'string') {
      // Sent verbatim. Webhook signatures cover the exact bytes, so
      // re-encoding a string body here would break every signature test.
      if (!requestHeaders.has('Content-Type')) {
        requestHeaders.set('Content-Type', 'application/json');
      }
      payload = body;
    } else if (body !== null && body !== undefined) {
      requestHeaders.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }

    const response = await worker.fetch(
      new Request(`https://test.meetmillionscrm.in${path}`, {
        method, headers: requestHeaders, body: payload,
      }), fullEnv, executionCtx);

    await settle();

    if (raw) return response;
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return {
      status: response.status,
      ok: response.ok,
      body: parsed,
      data: parsed?.data ?? null,
      error: parsed?.error ?? null,
      meta: parsed?.meta ?? null,
      headers: response.headers,
    };
  }

  /** Wait for deferred work (audit writes, notifications) to finish. */
  async function settle() {
    while (pending.length) {
      const batch = pending.splice(0);
      await Promise.allSettled(batch);
    }
  }

  async function runCron(cron) {
    const { runScheduled } = await import('../../src/services/scheduler.js');
    return runScheduled({ cron }, fullEnv);
  }

  return { env: fullEnv, request, settle, runCron, DB, DOCS, CACHE };
}

/** Register an organisation and return its token and identifiers. */
export async function registerOrg(app, overrides = {}) {
  const payload = {
    organisationName: 'Meridian Tax Associates',
    fullName: 'Asha Menon',
    email: 'asha@meridiantax.test',
    phone: '9845012233',
    password: 'Str0ng-Passw0rd!24',
    companyName: 'Meridian Tax Associates LLP',
    gstin: '33AABCR1234M1ZK',
    pan: 'AABCR1234M',
    tan: 'CHEN12345A',
    stateCode: '33',
    ...overrides,
  };
  const res = await app.request('/api/auth/register', { method: 'POST', body: payload });
  return { res, payload, token: res.data?.token ?? null };
}

export async function login(app, email, password) {
  const res = await app.request('/api/auth/login', { method: 'POST', body: { email, password } });
  return res;
}

/** Build a File-like object for multipart upload tests. */
export function testFile(name, content = 'test document content', type = 'application/pdf') {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new File([bytes], name, { type });
}

/** Create a staff user with a given role inside an existing tenant. */
export async function createUserWithRole(app, { tenantId, email, fullName, roleKey, password = 'Str0ng-Passw0rd!24', companyIds = null }) {
  const { Db } = await import('../../src/db/client.js');
  const { hashPassword } = await import('../../src/auth/password.js');
  const { ID } = await import('../../src/utils/id.js');
  const { nowIso } = await import('../../src/utils/time.js');

  const db = new Db(app.env.DB);
  const ts = nowIso();
  const userId = ID.user();

  await db.insert('users', {
    id: userId, tenant_id: tenantId, email, password_hash: await hashPassword(password),
    full_name: fullName, status: 'active', theme: 'dark', created_at: ts, updated_at: ts,
  });
  const role = await db.one('SELECT id FROM roles WHERE key = ? AND tenant_id IS NULL', [roleKey]);
  await db.insert('user_roles', { user_id: userId, role_id: role.id, assigned_by: userId, assigned_at: ts });

  if (companyIds) {
    for (const [i, companyId] of companyIds.entries()) {
      await db.insert('user_companies', {
        user_id: userId, company_id: companyId, relationship: 'owner',
        is_default: i === 0 ? 1 : 0, created_at: ts,
      });
    }
  }

  return { userId, email, password };
}

/** Move a tenant onto a different plan — used to exercise plan gating. */
export async function setPlan(app, tenantId, planKey) {
  const { Db } = await import('../../src/db/client.js');
  const { nowIso, addMonths } = await import('../../src/utils/time.js');
  const db = new Db(app.env.DB);
  const plan = await db.one('SELECT id FROM plans WHERE key = ?', [planKey]);
  if (!plan) throw new Error(`Unknown plan: ${planKey}`);
  await db.run(
    `UPDATE subscriptions SET plan_id = ?, status = 'active', current_period_start = ?,
        current_period_end = ?, updated_at = ? WHERE tenant_id = ?`,
    [plan.id, nowIso(), addMonths(1), nowIso(), tenantId]);
  return plan.id;
}

/** Activate an add-on for a tenant, as the marketplace would. */
export async function activateAddOn(app, tenantId, addOnKey) {
  const { Db } = await import('../../src/db/client.js');
  const { ID } = await import('../../src/utils/id.js');
  const { nowIso, addMonths } = await import('../../src/utils/time.js');
  const db = new Db(app.env.DB);
  const addOn = await db.one('SELECT * FROM add_ons WHERE key = ?', [addOnKey]);
  if (!addOn) throw new Error(`Unknown add-on: ${addOnKey}`);
  const ts = nowIso();
  await db.insert('add_on_subscriptions', {
    id: ID.addOnSub(), tenant_id: tenantId, add_on_id: addOn.id, status: 'active',
    activated_at: ts, billing_cycle: 'monthly',
    monthly_price_paise: addOn.monthly_price_paise, setup_fee_paise: addOn.setup_fee_paise,
    setup_fee_charged: 1, current_period_start: ts, current_period_end: addMonths(1),
    created_at: ts, updated_at: ts,
  });
  return addOn;
}

/** The tenant id of the single organisation in a freshly created app. */
export async function firstTenantId(app) {
  const row = await app.DB.prepare('SELECT id FROM tenants LIMIT 1').first();
  return row?.id ?? null;
}
