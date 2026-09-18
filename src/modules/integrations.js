/**
 * Integration management: what is connected, what is not, and why.
 *
 * The rule the whole screen turns on: a vendor is "connected" only when its
 * credentials are present and, where the vendor needs a linked account, that
 * account exists. Nothing here reports a connection it does not have, and the
 * connection test makes a real call rather than checking a stored flag.
 *
 * OAuth state is single-use and short-lived, and the callback verifies the
 * state it is handed before it exchanges anything.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import {
  BadRequestError, ForbiddenError, NotFoundError, IntegrationError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays, addMinutes } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { randomToken, sha256Hex, encryptString } from '../auth/crypto.js';
import {
  describeAllIntegrations, testIntegration, PROVIDER_REGISTRY,
} from '../services/integrations.js';
import { ADDONS, ADDON_MAP } from '../data/addons.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const integrations = await describeAllIntegrations(ctx);

  const byCategory = {};
  for (const item of integrations) {
    (byCategory[item.category ?? 'other'] ??= []).push(item);
  }

  const connected = integrations.filter(i => i.status === 'connected');
  const selfHosted = integrations.filter(i => i.status === 'self_hosted');
  const needsKeys = integrations.filter(i => !i.selfHosted && !i.configured);
  const needsLink = integrations.filter(i => i.configured && i.needsAccountLink);

  return ok({
    integrations,
    byCategory,
    summary: {
      total: integrations.length,
      connected: connected.length,
      // Served by this Worker, so there is no vendor to connect to.
      selfHosted: selfHosted.length,
      // Split apart deliberately: "no credentials on the deployment" and
      // "credentials fine, nobody has linked an account" need different fixes.
      awaitingCredentials: needsKeys.length,
      awaitingAccountLink: needsLink.length,
    },
  }, { ctx });
}, { permission: 'integrations.view' });

router.get('/:key', async (ctx) => {
  const integrations = await describeAllIntegrations(ctx);
  const integration = integrations.find(i => i.key === ctx.params.key);
  if (!integration) throw new NotFoundError('Integration');

  const scope = scopeFor(ctx);
  const logs = await scope.raw(
    `SELECT * FROM integration_sync_logs WHERE tenant_id = ? AND provider = ?
      ORDER BY started_at DESC LIMIT 20`, [ctx.tenantId, ctx.params.key]);
  const record = await scope.first('integrations', { provider: ctx.params.key });
  const mappings = record
    ? await scope.all('field_mappings', { integration_id: record.id }, { order: 'sort_order ASC', limit: 100 })
    : [];
  const meta = PROVIDER_REGISTRY.find(p => p.key === ctx.params.key);
  const addOn = integration.addOn ? ADDON_MAP.get(integration.addOn) : null;

  return ok({
    integration,
    // Named, never valued: these are deployment secrets, and this response is
    // read by anyone with integrations.view.
    requiredKeys: integration.requiredKeys ?? [],
    missingKeys: integration.missingKeys ?? [],
    addOn: addOn ? {
      key: addOn.key, name: addOn.name, number: addOn.number,
      monthlyPaise: addOn.monthlyPaise, active: integration.addOnActive,
    } : null,
    docsUrl: meta?.docsUrl ?? null,
    syncLogs: logs.map(toSyncLog),
    fieldMappings: mappings,
  }, { ctx });
}, { permission: 'integrations.view' });

/** Run a real connection test and record the outcome. */
router.post('/:key/test', async (ctx) => {
  const result = await testIntegration(ctx, ctx.params.key);

  await audit(ctx, {
    action: 'integrations.tested', category: 'integrations',
    result: result.ok ? 'success' : 'failure',
    entityType: 'integration', entityId: ctx.params.key,
    entityLabel: ctx.params.key,
    newValue: { ok: result.ok, status: result.status, error: result.error?.message ?? null },
  });

  return ok({
    key: ctx.params.key,
    ok: result.ok,
    // `not_configured` is its own outcome. Reporting it as a failure would
    // send someone hunting for a fault when the answer is "add the keys".
    status: result.status,
    connectionStatus: result.connectionStatus,
    message: result.message,
    missingKeys: result.missingKeys ?? [],
    data: result.ok ? result.data : null,
  }, { ctx });
}, { permission: 'integrations.manage' });

/** Per-tenant configuration that is not a deployment secret. */
router.patch('/:key/config', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    config: { type: 'json', required: true },
    displayName: { type: 'string', max: 80 },
    isActive: { type: 'boolean' },
  });

  const meta = PROVIDER_REGISTRY.find(p => p.key === ctx.params.key);
  if (!meta) throw new NotFoundError('Integration');

  const existing = await scope.first('integrations', { provider: ctx.params.key });
  const patch = {
    config_json: JSON.stringify(redactSecrets(input.config)),
    display_name: input.displayName ?? existing?.display_name ?? meta.label ?? ctx.params.key,
  };
  if (input.isActive !== null && input.isActive !== undefined) {
    patch.status = input.isActive ? (existing?.status ?? 'not_connected') : 'disabled';
  }

  if (existing) {
    await scope.update('integrations', existing.id, patch);
  } else {
    await scope.insert('integrations', {
      id: ID.integration(),
      provider: ctx.params.key,
      category: meta.category ?? 'other',
      add_on_key: meta.addOn ?? null,
      status: 'not_connected',
      ...patch,
    });
  }

  await audit(ctx, {
    action: 'integrations.configured', category: 'integrations',
    entityType: 'integration', entityId: ctx.params.key,
    newValue: { keys: Object.keys(input.config ?? {}) },
  });

  return ok({ key: ctx.params.key, config: redactSecrets(input.config) }, { ctx });
}, { permission: 'integrations.manage' });

// ---------------------------------------------------------------------------
// OAuth account linking
// ---------------------------------------------------------------------------
router.post('/:key/oauth/start', async (ctx) => {
  const scope = scopeFor(ctx);
  const meta = PROVIDER_REGISTRY.find(p => p.key === ctx.params.key);
  if (!meta?.oauth) throw new BadRequestError(`${ctx.params.key} does not use account linking.`);

  const integrations = await describeAllIntegrations(ctx);
  const integration = integrations.find(i => i.key === ctx.params.key);
  if (!integration?.configured) {
    throw new IntegrationError(integration?.name ?? ctx.params.key,
      `${integration?.name ?? 'This integration'} has no credentials on this deployment, so there is nothing to link an account to yet. Missing: ${(integration?.missingKeys ?? []).join(', ')}.`,
      { configured: false, details: { missingKeys: integration?.missingKeys ?? [] } });
  }

  // State is random, single-use and short-lived. Only its hash is stored, so a
  // leaked database row cannot be replayed as a valid callback.
  const state = randomToken(32);
  await scope.insert('oauth_states', {
    state_hash: await sha256Hex(state),
    provider: meta.oauth,
    user_id: ctx.userId,
    redirect_path: (await ctx.body())?.redirectPath ?? '/settings/integrations',
    expires_at: addMinutes(10),
  });

  const provider = (await import('../services/integrations.js')).buildProvider(ctx.params.key, ctx.env);
  const url = provider?.authorizationUrl?.({
    state,
    redirectUri: `${ctx.env.APP_URL || ''}/api/integrations/${ctx.params.key}/oauth/callback`,
  });
  if (!url) {
    throw new IntegrationError(meta.label ?? ctx.params.key,
      'This provider does not expose an authorisation URL in this build.');
  }

  return created({ authorizationUrl: url, expiresInSeconds: 600 }, { ctx });
}, { permission: 'integrations.manage' });

router.post('/:key/oauth/callback', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    code: { type: 'string', required: true, max: 2000 },
    state: { type: 'string', required: true, max: 200 },
  });

  const meta = PROVIDER_REGISTRY.find(p => p.key === ctx.params.key);
  if (!meta?.oauth) throw new NotFoundError('Integration');

  // Verify the state before exchanging anything: the code is worthless to an
  // attacker without a state we issued, and it is single-use.
  const stateHash = await sha256Hex(input.state);
  const stored = await scope.first('oauth_states', { provider: meta.oauth, state_hash: stateHash });
  if (!stored) throw new ForbiddenError('That sign-in attempt is not one we started. Begin again from Settings.');

  // Consumed whether or not the rest succeeds: a state that survives a failed
  // exchange is a state somebody can try again with.
  const db = new Db(ctx.env.DB);
  await db.run('DELETE FROM oauth_states WHERE state_hash = ? AND tenant_id = ?',
    [stateHash, ctx.tenantId]);

  if (stored.expires_at < nowIso()) {
    throw new ForbiddenError('That sign-in attempt expired. Begin again from Settings.');
  }
  if (stored.user_id !== ctx.userId) {
    throw new ForbiddenError('That sign-in attempt was started by someone else.');
  }

  const { buildProvider } = await import('../services/integrations.js');
  const provider = buildProvider(ctx.params.key, ctx.env);
  const result = await provider?.exchangeCode?.({
    code: input.code,
    redirectUri: `${ctx.env.APP_URL || ''}/api/integrations/${ctx.params.key}/oauth/callback`,
  });

  if (!result?.ok) {
    throw new IntegrationError(meta.label ?? ctx.params.key,
      result?.error?.message ?? 'The provider did not accept that authorisation code.',
      { configured: true });
  }

  // Tokens are encrypted at rest. A database dump must not be a set of live
  // credentials for somebody's Google Drive.
  const secret = ctx.env.ENCRYPTION_KEY || ctx.env.AUTH_SECRET;
  const existing = await scope.first('oauth_connections', { provider: meta.oauth });
  const payload = {
    provider: meta.oauth,
    account_email: result.data.accountEmail ?? null,
    account_id: result.data.accountId ?? null,
    access_token_enc: await encryptString(result.data.accessToken, secret),
    refresh_token_enc: result.data.refreshToken
      ? await encryptString(result.data.refreshToken, secret) : null,
    token_type: result.data.tokenType ?? 'Bearer',
    scopes: Array.isArray(result.data.scopes) ? result.data.scopes.join(' ') : (result.data.scopes ?? null),
    expires_at: result.data.expiresAt ?? addDays(30),
    status: 'active',
    connected_by: ctx.userId,
  };

  if (existing) await scope.update('oauth_connections', existing.id, payload);
  else await scope.insert('oauth_connections', { id: ID.oauth(), ...payload });

  await audit(ctx, {
    action: 'integrations.connected', category: 'integrations', severity: 'notice',
    entityType: 'integration', entityId: ctx.params.key,
    entityLabel: meta.label ?? ctx.params.key,
    newValue: { account: result.data.accountEmail ?? null },
  });

  return ok({
    key: ctx.params.key,
    connected: true,
    account: result.data.accountEmail ?? null,
    redirectPath: stored.redirect_path ?? '/settings/integrations',
  }, { ctx });
}, { permission: 'integrations.manage' });

router.delete('/:key/oauth', async (ctx) => {
  const scope = scopeFor(ctx);
  const meta = PROVIDER_REGISTRY.find(p => p.key === ctx.params.key);
  if (!meta?.oauth) throw new NotFoundError('Integration');

  const connection = await scope.first('oauth_connections', { provider: meta.oauth });
  if (!connection) throw new NotFoundError('Connection');

  await scope.delete('oauth_connections', connection.id);
  await audit(ctx, {
    action: 'integrations.disconnected', category: 'integrations', severity: 'warning',
    entityType: 'integration', entityId: ctx.params.key,
    entityLabel: meta.label ?? ctx.params.key,
    oldValue: { account: connection.account_email },
  });

  return ok({ key: ctx.params.key, disconnected: true }, { ctx });
}, { permission: 'integrations.manage' });

// ---------------------------------------------------------------------------
// Sync history
// ---------------------------------------------------------------------------
router.get('/:key/logs', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('integration_sync_logs', 'l');
  where.add('l.provider = ?', ctx.params.key);
  where.eqIf('l.status', ctx.q('status'));
  where.eqIf('l.direction', ctx.q('direction'));

  const { rows, total } = await scope.paginate('integration_sync_logs', where, {
    columns: 'l.*',
    alias: 'l',
    orderBy: `l.${safeOrder(ctx.q('sort', 'started_at'), ctx.q('dir', 'desc'), ['started_at', 'status'], 'started_at')}`,
    page, pageSize,
  });

  return paginated(rows.map(toSyncLog), { page, pageSize, total }, ctx);
}, { permission: 'integrations.view' });

// ---------------------------------------------------------------------------
// Field mappings — how a vendor's fields land on ours
// ---------------------------------------------------------------------------
router.put('/:key/mappings', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    entity: { type: 'string', required: true, max: 40 },
    mappings: { type: 'array', required: true, max: 100 },
  });

  const db = new Db(ctx.env.DB);
  const integration = await scope.first('integrations', { provider: ctx.params.key });
  if (!integration) {
    throw new BadRequestError(
      `Configure ${ctx.params.key} before mapping its fields — there is nothing to map from yet.`);
  }

  await db.run(
    'DELETE FROM field_mappings WHERE tenant_id = ? AND integration_id = ? AND target_entity = ?',
    [ctx.tenantId, integration.id, input.entity]);

  const saved = [];
  for (const [i, m] of input.mappings.entries()) {
    if (!m?.sourceField || !m?.targetField) continue;
    const row = await scope.insert('field_mappings', {
      id: ID.mapping(),
      integration_id: integration.id,
      source_key: String(m.sourceField).slice(0, 120),
      source_label: m.sourceLabel ? String(m.sourceLabel).slice(0, 120) : null,
      target_entity: input.entity,
      target_field: String(m.targetField).slice(0, 120),
      transform: m.transform ? String(m.transform).slice(0, 40) : null,
      is_required: m.required ? 1 : 0,
      default_value: m.defaultValue ? String(m.defaultValue).slice(0, 200) : null,
      sort_order: i,
    });
    saved.push(row);
  }

  await audit(ctx, {
    action: 'integrations.configured', category: 'integrations',
    entityType: 'integration', entityId: ctx.params.key,
    newValue: { entity: input.entity, mappings: saved.length },
  });

  return ok({ entity: input.entity, mappings: saved }, { ctx });
}, { permission: 'integrations.manage' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toSyncLog(l) {
  return {
    id: l.id,
    provider: l.provider,
    direction: l.direction,
    status: l.status,
    operation: l.operation,
    recordsIn: l.records_in,
    recordsOut: l.records_out,
    recordsFailed: l.records_failed,
    durationMs: l.duration_ms,
    detail: safeJson(l.detail_json, null),
    error: l.error_message,
    startedAt: l.started_at,
    finishedAt: l.finished_at,
  };
}

/**
 * Keep anything that looks like a credential out of tenant config.
 *
 * Vendor secrets belong in deployment environment variables, not in a row that
 * any administrator can read back. Keys are kept so the shape is visible; the
 * values are replaced.
 */
function redactSecrets(config) {
  if (!config || typeof config !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = /secret|token|password|key|credential|auth/i.test(key)
      ? '[stored in environment variables]'
      : value;
  }
  return out;
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as integrationsRouter };
