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
  BadRequestError, ForbiddenError, NotFoundError, IntegrationError, ConflictError,
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
// Cloud storage folder mappings — where verified documents are mirrored
//
// services/cloud-sync.js has always known how to push a document into Google
// Drive, Dropbox or OneDrive: it reads storage_folder_maps, matches the
// document against each map's scope, and queues it. But nothing could WRITE a
// map — no endpoint, no screen — so the query returned nothing on every
// deployment and three paid add-ons (15, 16, 17) silently did nothing.
// ---------------------------------------------------------------------------

const STORAGE_PROVIDERS = ['google_drive', 'dropbox', 'onedrive'];

router.get('/storage/folders', async (ctx) => {
  const scope = scopeFor(ctx);
  const where = scope.where('storage_folder_maps', 'm');
  where.eqIf('m.provider', ctx.q('provider'));
  where.eqIf('m.scope_type', ctx.q('scopeType'));

  const rows = await scope.raw(
    `SELECT m.*, c.display_name AS client_name, co.name AS company_name,
            i.status AS integration_status
       FROM storage_folder_maps m
       LEFT JOIN clients c ON c.id = m.scope_id AND m.scope_type = 'client'
       LEFT JOIN companies co ON co.id = m.scope_id AND m.scope_type = 'company'
       LEFT JOIN integrations i ON i.id = m.integration_id
      WHERE m.tenant_id = ?
      ORDER BY m.created_at DESC`, [ctx.tenantId]);

  // Pending work per map, so a screen can say whether sync is actually moving.
  const pending = await scope.raw(
    `SELECT map_id, COUNT(*) AS n FROM storage_sync_items
      WHERE tenant_id = ? AND status IN ('pending','retrying')
      GROUP BY map_id`, [ctx.tenantId]);
  const pendingByMap = new Map(pending.map(r => [r.map_id, Number(r.n)]));

  return ok({
    folders: rows.map(r => toFolderMap(r, pendingByMap.get(r.id) ?? 0)),
    providers: STORAGE_PROVIDERS,
    syncTriggers: ['upload', 'verified', 'approved'],
    scopeTypes: ['tenant', 'company', 'client'],
  }, { ctx });
}, { permission: 'integrations.view' });

router.post('/storage/folders', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    provider: { type: 'enum', values: STORAGE_PROVIDERS, required: true },
    remotePath: { type: 'string', required: true, max: 400 },
    remoteFolderId: { type: 'string', max: 200 },
    scopeType: { type: 'enum', values: ['tenant', 'company', 'client'], default: 'tenant' },
    scopeId: { type: 'id' },
    syncOn: { type: 'enum', values: ['upload', 'verified', 'approved'], default: 'verified' },
    autoSync: { type: 'boolean', default: true },
    preserveVersions: { type: 'boolean', default: true },
  });

  if (input.scopeType !== 'tenant' && !input.scopeId) {
    throw new BadRequestError(`A ${input.scopeType} mapping needs the ${input.scopeType} it applies to.`);
  }
  if (input.scopeType === 'client') {
    await scope.getOrFail('clients', input.scopeId, { resource: 'Client' });
  }
  if (input.scopeType === 'company') {
    await scope.getOrFail('companies', input.scopeId, { resource: 'Company' });
  }

  // The vendor has to be linked, or the map would point nowhere. Saying so
  // here is better than queueing documents that can never be delivered.
  const integration = await scope.first('integrations', { provider: input.provider });
  if (!integration) {
    throw new IntegrationError(input.provider,
      `${input.provider.replace(/_/g, ' ')} is not connected on this deployment. Connect the account first.`);
  }
  if (integration.status !== 'connected') {
    throw new IntegrationError(input.provider,
      `${input.provider.replace(/_/g, ' ')} is ${integration.status}. Reconnect it before mapping a folder.`);
  }

  const duplicate = await scope.rawOne(
    `SELECT id FROM storage_folder_maps
      WHERE tenant_id = ? AND provider = ? AND scope_type = ? AND COALESCE(scope_id,'') = ?`,
    [ctx.tenantId, input.provider, input.scopeType, input.scopeId ?? '']);
  if (duplicate) {
    throw new ConflictError('That provider already has a folder mapped for this scope.');
  }

  const row = await scope.insert('storage_folder_maps', {
    id: ID.folderMap(),
    integration_id: integration.id,
    provider: input.provider,
    scope_type: input.scopeType,
    scope_id: input.scopeId ?? null,
    remote_folder_id: input.remoteFolderId ?? null,
    remote_path: input.remotePath.trim(),
    auto_sync: input.autoSync ? 1 : 0,
    sync_on: input.syncOn,
    preserve_versions: input.preserveVersions ? 1 : 0,
  });

  await audit(ctx, {
    action: 'integrations.folder_mapped', category: 'integrations',
    entityType: 'storage_folder_map', entityId: row.id,
    entityLabel: `${input.provider} → ${input.remotePath}`,
    newValue: { provider: input.provider, scopeType: input.scopeType, syncOn: input.syncOn },
  });

  return created({ folder: toFolderMap(row, 0) }, { ctx });
}, { permission: 'integrations.manage' });

router.patch('/storage/folders/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await scope.getOrFail('storage_folder_maps', ctx.params.id, { resource: 'Folder mapping' });

  const body = await ctx.body();
  const input = validate(body, {
    remotePath: { type: 'string', max: 400 },
    remoteFolderId: { type: 'string', max: 200 },
    syncOn: { type: 'enum', values: ['upload', 'verified', 'approved'] },
    autoSync: { type: 'boolean' },
    preserveVersions: { type: 'boolean' },
  });

  const patch = {};
  if (input.remotePath) patch.remote_path = input.remotePath.trim();
  if (input.remoteFolderId !== null) patch.remote_folder_id = input.remoteFolderId;
  if (input.syncOn) patch.sync_on = input.syncOn;
  if (input.autoSync !== null) patch.auto_sync = input.autoSync ? 1 : 0;
  if (input.preserveVersions !== null) patch.preserve_versions = input.preserveVersions ? 1 : 0;

  if (!Object.keys(patch).length) {
    return ok({ folder: toFolderMap(row, 0), changed: false }, { ctx });
  }

  await scope.update('storage_folder_maps', row.id, patch);
  const updated = await scope.first('storage_folder_maps', { id: row.id });

  await audit(ctx, {
    action: 'integrations.folder_updated', category: 'integrations',
    entityType: 'storage_folder_map', entityId: row.id,
    entityLabel: `${row.provider} → ${updated.remote_path}`,
    oldValue: { remotePath: row.remote_path, syncOn: row.sync_on, autoSync: !!row.auto_sync },
    newValue: { remotePath: updated.remote_path, syncOn: updated.sync_on, autoSync: !!updated.auto_sync },
  });

  return ok({ folder: toFolderMap(updated, 0), changed: true }, { ctx });
}, { permission: 'integrations.manage' });

router.delete('/storage/folders/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await scope.getOrFail('storage_folder_maps', ctx.params.id, { resource: 'Folder mapping' });

  // Queued items belong to the map; leaving them would strand rows pointing at
  // a mapping that no longer exists.
  const dropped = await scope.rawOne(
    `SELECT COUNT(*) AS n FROM storage_sync_items
      WHERE tenant_id = ? AND map_id = ? AND status IN ('pending','retrying')`,
    [ctx.tenantId, row.id]);

  const db = new Db(ctx.env.DB);
  await db.run('DELETE FROM storage_sync_items WHERE tenant_id = ? AND map_id = ?', [ctx.tenantId, row.id]);
  await scope.delete('storage_folder_maps', row.id);

  await audit(ctx, {
    action: 'integrations.folder_unmapped', category: 'integrations',
    entityType: 'storage_folder_map', entityId: row.id,
    entityLabel: `${row.provider} → ${row.remote_path}`,
    oldValue: { provider: row.provider, remotePath: row.remote_path, queuedDropped: Number(dropped?.n) || 0 },
  });

  return ok({ id: row.id, removed: true, queuedDropped: Number(dropped?.n) || 0 }, { ctx });
}, { permission: 'integrations.manage' });

/** The sync queue for one mapping — what moved, what is waiting, what failed. */
router.get('/storage/folders/:id/queue', async (ctx) => {
  const scope = scopeFor(ctx);
  const row = await scope.getOrFail('storage_folder_maps', ctx.params.id, { resource: 'Folder mapping' });
  const { page, pageSize } = ctx.pagination({ defaultSize: 25, maxSize: 100 });

  const where = scope.where('storage_sync_items', 's');
  where.add('s.map_id = ?', row.id);
  where.eqIf('s.status', ctx.q('status'));

  const { rows, total } = await scope.paginate('storage_sync_items', where, {
    columns: 's.*, d.title AS document_title',
    joins: 'LEFT JOIN documents d ON d.id = s.document_id',
    alias: 's',
    orderBy: 's.created_at DESC',
    page, pageSize,
  });

  return paginated(rows.map(r => ({
    id: r.id,
    documentId: r.document_id,
    documentTitle: r.document_title ?? null,
    status: r.status,
    attempts: Number(r.attempts) || 0,
    error: r.error ?? null,
    remoteFileId: r.remote_file_id ?? null,
    syncedAt: r.synced_at ?? null,
    createdAt: r.created_at,
  })), { page, pageSize, total }, ctx);
}, { permission: 'integrations.view' });

function toFolderMap(row, pendingCount) {
  return {
    id: row.id,
    provider: row.provider,
    integrationId: row.integration_id,
    integrationStatus: row.integration_status ?? null,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    scopeLabel: row.scope_type === 'tenant'
      ? 'Every client'
      : (row.client_name ?? row.company_name ?? row.scope_id),
    remotePath: row.remote_path,
    remoteFolderId: row.remote_folder_id,
    autoSync: !!row.auto_sync,
    syncOn: row.sync_on,
    preserveVersions: !!row.preserve_versions,
    pendingCount,
    lastSyncAt: row.last_sync_at ?? null,
    createdAt: row.created_at,
  };
}

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
