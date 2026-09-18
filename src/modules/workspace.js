/**
 * Calendar, e-signature, API keys, branding and backups.
 *
 * Grouped because they share a shape: each wraps a capability that is only
 * partly ours — a calendar that may or may not be synced to a provider, a
 * signature a vendor collects, a domain Cloudflare must verify, a backup that
 * has to be verifiable afterwards. In every case the honest answer about the
 * external half is part of the response.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import {
  BadRequestError, ConflictError, ForbiddenError, NotFoundError, IntegrationError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, dayKey, addDays, addMinutes } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { randomToken, sha256Hex } from '../auth/crypto.js';
import { putObject, getObject, tenantAssetKey, validateUpload, signDownloadUrl } from '../services/storage.js';
import { buildProvider } from '../services/integrations.js';
import { PERMISSION_MAP } from '../permissions/catalog.js';

const router = createRouter();

// ===========================================================================
// Calendar
// ===========================================================================
const EVENT_KINDS = ['meeting', 'deadline', 'reminder', 'filing', 'visit', 'holiday', 'other'];

router.get('/calendar', async (ctx) => {
  const scope = scopeFor(ctx);
  const from = ctx.q('from') ?? dayKey();
  const to = ctx.q('to') ?? dayKey(new Date(Date.now() + 30 * 86400000));

  const where = scope.where('calendar_events', 'e');
  where.add('e.starts_at >= ? AND e.starts_at <= ?', `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`);
  where.eqIf('e.kind', ctx.q('kind'));
  where.eqIf('e.client_id', ctx.q('clientId'));
  // Your own events plus anything not owned by one person.
  if (!ctx.qBool('all')) where.add('(e.owner_id = ? OR e.owner_id IS NULL)', ctx.userId);

  const events = await scope.raw(
    `SELECT e.*, c.display_name AS client_name, u.full_name AS owner_name
       FROM calendar_events e
       LEFT JOIN clients c ON c.id = e.client_id
       LEFT JOIN users u ON u.id = e.owner_id
      WHERE e.tenant_id = ? ${where.clauses.length ? 'AND ' + where.clauses.join(' AND ') : ''}
      ORDER BY e.starts_at ASC LIMIT 500`,
    [ctx.tenantId, ...where.params]);

  // Statutory due dates are not stored as events — they are derived from the
  // filing periods themselves, so they can never drift out of step with them.
  const deadlines = await scope.raw(
    `SELECT fp.id, fp.period_key, fp.period_type, fp.due_date, fp.status,
            c.display_name AS client_name
       FROM filing_periods fp LEFT JOIN clients c ON c.id = fp.client_id
      WHERE fp.tenant_id = ? AND fp.due_date BETWEEN ? AND ? AND fp.status != 'filed'
      ORDER BY fp.due_date`, [ctx.tenantId, from, to]);

  return ok({
    range: { from, to },
    events: events.map(toEvent),
    deadlines: deadlines.map(d => ({
      id: d.id,
      title: `${d.period_type === 'monthly' ? 'GST' : 'Filing'} due — ${d.client_name ?? 'client'}`,
      date: d.due_date,
      periodKey: d.period_key,
      status: d.status,
      kind: 'deadline',
      derived: true,
    })),
    kinds: EVENT_KINDS,
  }, { ctx });
}, { permission: 'calendar.view' });

router.post('/calendar', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    title: { type: 'string', required: true, max: 200 },
    description: { type: 'text', max: 2000 },
    kind: { type: 'enum', values: EVENT_KINDS, default: 'meeting' },
    startsAt: { type: 'date', required: true },
    endsAt: { type: 'date' },
    allDay: { type: 'boolean', default: false },
    location: { type: 'string', max: 200 },
    clientId: { type: 'id' },
    attendees: { type: 'array', max: 50, of: { type: 'string', max: 160 } },
    reminderMinutes: { type: 'int', min: 0, max: 20160 },
  });

  if (input.endsAt && input.endsAt < input.startsAt) {
    throw new BadRequestError('An event cannot end before it starts.');
  }

  const event = await scope.insert('calendar_events', {
    id: ID.event(),
    client_id: input.clientId ?? null,
    owner_id: ctx.userId,
    title: input.title,
    description: input.description ?? null,
    kind: input.kind,
    location: input.location ?? null,
    starts_at: input.startsAt,
    ends_at: input.endsAt ?? null,
    all_day: input.allDay ? 1 : 0,
    attendees_json: input.attendees ? JSON.stringify(input.attendees) : null,
    reminder_minutes: input.reminderMinutes ?? 30,
    status: 'confirmed',
    // Not synced unless a provider is connected and a sync actually runs.
    sync_status: 'local',
  });

  return created({ event: toEvent(event) }, { ctx });
}, { permission: 'calendar.manage' });

router.patch('/calendar/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const event = await scope.getOrFail('calendar_events', ctx.params.id, { resource: 'Event' });
  if (event.owner_id && event.owner_id !== ctx.userId && !ctx.has('calendar.manage')) {
    throw new ForbiddenError('That is somebody else\'s event.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    title: { type: 'string', max: 200 },
    description: { type: 'text', max: 2000 },
    startsAt: { type: 'date' },
    endsAt: { type: 'date' },
    location: { type: 'string', max: 200 },
    status: { type: 'enum', values: ['confirmed', 'tentative', 'cancelled'] },
    reminderMinutes: { type: 'int', min: 0, max: 20160 },
  });

  const patch = {};
  for (const [field, column] of Object.entries({
    title: 'title', description: 'description', startsAt: 'starts_at', endsAt: 'ends_at',
    location: 'location', status: 'status', reminderMinutes: 'reminder_minutes',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  // An event that came from a provider is now out of step with it until the
  // next sync, and the record says so rather than implying they agree.
  if (event.provider_event_id) patch.sync_status = 'pending';

  await scope.update('calendar_events', event.id, patch);
  return ok({ event: toEvent(await scope.first('calendar_events', { id: event.id })) }, { ctx });
}, { permission: 'calendar.manage' });

router.delete('/calendar/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const event = await scope.getOrFail('calendar_events', ctx.params.id, { resource: 'Event' });
  if (event.owner_id && event.owner_id !== ctx.userId && !ctx.has('calendar.manage')) {
    throw new ForbiddenError('That is somebody else\'s event.');
  }
  await scope.delete('calendar_events', event.id);
  return ok({ id: event.id, removed: true }, { ctx });
}, { permission: 'calendar.manage' });

// ===========================================================================
// e-Signature
// ===========================================================================
router.get('/esign', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('esign_requests', 'e');
  where.eqIf('e.status', ctx.q('status'));
  where.eqIf('e.client_id', ctx.q('clientId'));
  where.searchIf(['e.title', 'e.reference_no'], ctx.q('q'));

  const { rows, total } = await scope.paginate('esign_requests', where, {
    columns: 'e.*, c.display_name AS client_name',
    joins: 'LEFT JOIN clients c ON c.id = e.client_id',
    alias: 'e',
    orderBy: `e.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'status'], 'created_at')}`,
    page, pageSize,
  });

  const ids = rows.map(r => r.id);
  const signers = ids.length
    ? await scope.raw(
        `SELECT * FROM esign_signers WHERE tenant_id = ? AND request_id IN (${ids.map(() => '?').join(',')})
          ORDER BY sequence`, [ctx.tenantId, ...ids])
    : [];
  const byRequest = new Map();
  for (const s of signers) {
    if (!byRequest.has(s.request_id)) byRequest.set(s.request_id, []);
    byRequest.get(s.request_id).push(s);
  }

  return paginated(rows.map(r => toEsign(r, byRequest.get(r.id) ?? [])), { page, pageSize, total }, ctx);
}, { permission: 'esign.view' });

router.post('/esign', async (ctx) => {
  await assertFeature(ctx, 'esign');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    title: { type: 'string', required: true, max: 200 },
    documentId: { type: 'id' },
    reportId: { type: 'id' },
    clientId: { type: 'id' },
    provider: { type: 'enum', values: ['digio', 'leegality'], default: 'digio' },
    method: { type: 'enum', values: ['aadhaar', 'dsc', 'electronic'], default: 'aadhaar' },
    sequential: { type: 'boolean', default: false },
    signers: { type: 'array', required: true, max: 10 },
    expiresInDays: { type: 'int', min: 1, max: 90, default: 14 },
  });

  if (!input.documentId && !input.reportId) {
    throw new BadRequestError('Choose a document or a report to send for signature.');
  }
  if (!input.signers.length) throw new BadRequestError('Add at least one signer.');

  const provider = buildProvider(input.provider, ctx.env);
  if (!provider?.isConfigured()) {
    throw new IntegrationError(provider?.name ?? input.provider,
      `${provider?.name ?? 'That e-sign provider'} has no credentials on this deployment. Missing: ${(provider?.missingKeys() ?? []).join(', ')}.`,
      { configured: false, details: { missingKeys: provider?.missingKeys() ?? [] } });
  }

  const source = input.documentId
    ? await scope.getOrFail('documents', input.documentId, { resource: 'Document' })
    : await scope.getOrFail('reports', input.reportId, { resource: 'Report' });

  const sourceKey = input.documentId
    ? (await scope.first('document_versions', { id: source.current_version_id }))?.storage_key
    : source.pdf_key;
  if (!sourceKey) {
    throw new ConflictError('That record has no stored file to sign. Generate or upload it first.');
  }

  const reference = `ESG-${Date.now().toString(36).toUpperCase()}`;
  const request = await scope.insert('esign_requests', {
    id: ID.esign(),
    client_id: input.clientId ?? source.client_id ?? null,
    document_id: input.documentId ?? null,
    report_id: input.reportId ?? null,
    reference_no: reference,
    title: input.title,
    provider: input.provider,
    method: input.method,
    // Draft until the provider accepts it. Nothing is "sent" on our say-so.
    status: 'draft',
    source_key: sourceKey,
    sequential: input.sequential ? 1 : 0,
    expires_at: addDays(input.expiresInDays),
    created_by: ctx.userId,
  });

  for (const [i, signer] of input.signers.entries()) {
    if (!signer?.email && !signer?.phone) continue;
    await scope.insert('esign_signers', {
      id: ID.signer(),
      request_id: request.id,
      name: String(signer.name ?? '').slice(0, 120) || signer.email || signer.phone,
      email: signer.email ?? null,
      phone: signer.phone ?? null,
      sequence: i + 1,
      status: 'pending',
    });
  }

  const signers = await scope.all('esign_signers', { request_id: request.id }, { order: 'sequence ASC' });

  // The provider needs the file itself, so it is read from R2 here rather
  // than being handed a URL it cannot reach into private storage with.
  const object = await getObject(ctx.env, sourceKey);
  if (!object) {
    await scope.update('esign_requests', request.id, { status: 'failed' });
    throw new ConflictError('The stored file could not be read, so there is nothing to send.');
  }
  const fileBase64 = base64FromArrayBuffer(await new Response(object.body).arrayBuffer());

  const result = await provider.sendForSignature({
    fileName: `${reference}.pdf`,
    fileBase64,
    signers: signers.map(s => ({
      name: s.name, email: s.email, phone: s.phone, method: input.method,
    })),
    sequential: input.sequential,
    expiresInDays: input.expiresInDays,
  });

  if (!result.ok) {
    await scope.update('esign_requests', request.id, { status: 'failed' });
    throw new IntegrationError(provider.name,
      result.error?.message ?? 'The provider did not accept the signature request.',
      { configured: true });
  }

  await scope.update('esign_requests', request.id, {
    status: 'sent',
    provider_request_id: result.data?.requestId ?? null,
  });

  await audit(ctx, {
    action: 'settings.updated', category: 'documents', severity: 'notice',
    entityType: 'esign_request', entityId: request.id, entityLabel: reference,
    newValue: { provider: input.provider, signers: signers.length, method: input.method },
  });

  const fresh = await scope.first('esign_requests', { id: request.id });
  return created({ request: toEsign(fresh, signers), signingUrls: result.data?.signingUrls ?? null }, { ctx });
}, { permission: 'esign.send' });

router.get('/esign/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const request = await scope.getOrFail('esign_requests', ctx.params.id, { resource: 'Signature request' });
  const signers = await scope.all('esign_signers', { request_id: request.id }, { order: 'sequence ASC' });
  return ok({ request: toEsign(request, signers) }, { ctx });
}, { permission: 'esign.view' });

// ===========================================================================
// API keys
// ===========================================================================
router.get('/api-keys', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('api_keys', {}, { limit: 100 });

  const usage = await scope.raw(
    `SELECT api_key_id, COUNT(*) AS calls,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
       FROM api_usage WHERE tenant_id = ? AND created_at >= ? GROUP BY api_key_id`,
    [ctx.tenantId, addDays(-30)]);
  const byKey = new Map(usage.map(u => [u.api_key_id, u]));

  return ok({
    keys: rows.map(k => ({
      id: k.id,
      name: k.name,
      // The prefix only. The secret is stored as a hash and cannot be shown
      // again, which is the point of hashing it.
      keyPrefix: k.key_prefix,
      scopes: safeJson(k.scopes_json, []),
      rateLimitPerMin: k.rate_limit_per_min,
      allowedIps: safeJson(k.allowed_ips_json, []),
      status: k.status,
      lastUsedAt: k.last_used_at,
      requestCount: k.request_count,
      expiresAt: k.expires_at,
      revokedAt: k.revoked_at,
      createdAt: k.created_at,
      last30Days: {
        calls: Number(byKey.get(k.id)?.calls) || 0,
        errors: Number(byKey.get(k.id)?.errors) || 0,
      },
    })),
    availableScopes: [...PERMISSION_MAP.values()]
      .filter(p => /^(clients|documents|reports|tax|invoices|leads)\./.test(p.key))
      .map(p => ({ key: p.key, name: p.name, category: p.category })),
  }, { ctx });
}, { permission: 'api.view' });

router.post('/api-keys', async (ctx) => {
  await assertFeature(ctx, 'api_access');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 80 },
    scopes: { type: 'array', required: true, max: 50, of: { type: 'string', max: 60 } },
    rateLimitPerMin: { type: 'int', min: 1, max: 6000, default: 120 },
    allowedIps: { type: 'array', max: 20, of: { type: 'string', max: 50 } },
    expiresInDays: { type: 'int', min: 1, max: 730 },
  });

  if (!input.scopes.length) throw new BadRequestError('A key needs at least one scope.');
  for (const scopeKey of input.scopes) {
    if (!PERMISSION_MAP.has(scopeKey)) throw new BadRequestError(`Unknown scope: ${scopeKey}.`);
    // A key cannot be given more than the person creating it holds, or an API
    // key becomes a way around the role hierarchy.
    if (!ctx.has(scopeKey)) {
      throw new ForbiddenError(`You cannot grant "${scopeKey}" to a key — you do not hold it yourself.`);
    }
  }

  const secret = randomToken(32);
  const prefix = `mm_${randomToken(4).slice(0, 8)}`;
  const fullKey = `${prefix}.${secret}`;

  const key = await scope.insert('api_keys', {
    id: ID.apiKey(),
    name: input.name,
    key_prefix: prefix,
    key_hash: await sha256Hex(fullKey),
    scopes_json: JSON.stringify(input.scopes),
    rate_limit_per_min: input.rateLimitPerMin,
    allowed_ips_json: input.allowedIps ? JSON.stringify(input.allowedIps) : null,
    status: 'active',
    request_count: 0,
    expires_at: input.expiresInDays ? addDays(input.expiresInDays) : null,
    created_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'api.key_created', category: 'api', severity: 'warning',
    entityType: 'api_key', entityId: key.id, entityLabel: input.name,
    newValue: { scopes: input.scopes, prefix, expiresAt: key.expires_at },
  });

  return created({
    key: { id: key.id, name: key.name, keyPrefix: prefix, scopes: input.scopes },
    // Shown exactly once. Only its hash is stored.
    secret: fullKey,
    warning: 'Copy this key now. It cannot be shown again.',
  }, { ctx });
}, { permission: 'api.manage', stepUp: true });

router.delete('/api-keys/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const key = await scope.getOrFail('api_keys', ctx.params.id, { resource: 'API key' });
  if (key.status === 'revoked') return ok({ id: key.id, alreadyRevoked: true }, { ctx });

  await scope.update('api_keys', key.id, {
    status: 'revoked', revoked_at: nowIso(), revoked_by: ctx.userId,
  });
  await audit(ctx, {
    action: 'api.key_revoked', category: 'api', severity: 'warning',
    entityType: 'api_key', entityId: key.id, entityLabel: key.name,
  });

  return ok({ id: key.id, revoked: true }, { ctx });
}, { permission: 'api.manage' });

router.get('/api-keys/:id/usage', async (ctx) => {
  const scope = scopeFor(ctx);
  const key = await scope.getOrFail('api_keys', ctx.params.id, { resource: 'API key' });

  const byHour = await scope.raw(
    `SELECT bucket_hour, COUNT(*) AS calls,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
            AVG(duration_ms) AS avg_ms
       FROM api_usage WHERE tenant_id = ? AND api_key_id = ? AND created_at >= ?
      GROUP BY bucket_hour ORDER BY bucket_hour`, [ctx.tenantId, key.id, addDays(-7)]);

  const byPath = await scope.raw(
    `SELECT path, method, COUNT(*) AS calls,
            SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
       FROM api_usage WHERE tenant_id = ? AND api_key_id = ? AND created_at >= ?
      GROUP BY path, method ORDER BY calls DESC LIMIT 25`, [ctx.tenantId, key.id, addDays(-30)]);

  return ok({
    key: { id: key.id, name: key.name, keyPrefix: key.key_prefix },
    byHour: byHour.map(h => ({
      hour: h.bucket_hour,
      calls: Number(h.calls),
      errors: Number(h.errors),
      averageMs: Math.round(Number(h.avg_ms) || 0),
    })),
    byEndpoint: byPath.map(p => ({
      method: p.method, path: p.path, calls: Number(p.calls), errors: Number(p.errors),
    })),
  }, { ctx });
}, { permission: 'api.view' });

// ===========================================================================
// White-label branding
// ===========================================================================
router.get('/branding', async (ctx) => {
  const scope = scopeFor(ctx);
  const settings = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  const dns = buildProvider('cloudflare_dns', ctx.env);

  return ok({
    branding: settings ? toBranding(settings) : defaultBranding(ctx),
    customDomain: settings?.custom_domain ? {
      domain: settings.custom_domain,
      status: settings.domain_status,
      // The proof the domain's owner must publish. Until it resolves, the
      // domain is not verified, whatever the settings screen shows.
      verificationToken: settings.domain_verification_token,
      verifiedAt: settings.domain_verified_at,
      sslStatus: settings.ssl_status,
    } : null,
    dnsProvider: {
      configured: !!dns?.isConfigured(),
      missingKeys: dns?.missingKeys() ?? [],
    },
  }, { ctx });
}, { permission: 'settings.view' });

router.patch('/branding', async (ctx) => {
  await assertFeature(ctx, 'white_label');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    enabled: { type: 'boolean' },
    productName: { type: 'string', max: 80 },
    primaryColour: { type: 'string', max: 9 },
    accentColour: { type: 'string', max: 9 },
    sidebarStyle: { type: 'enum', values: ['glass', 'solid', 'minimal'] },
    loginHeadline: { type: 'string', max: 120 },
    loginSubtext: { type: 'string', max: 300 },
    emailFromName: { type: 'string', max: 80 },
    emailFromAddress: { type: 'email' },
    emailFooter: { type: 'text', max: 1000 },
    smsSenderId: { type: 'string', max: 11 },
    supportEmail: { type: 'email' },
    supportPhone: { type: 'phone' },
    hidePoweredBy: { type: 'boolean' },
  });

  for (const field of ['primaryColour', 'accentColour']) {
    if (input[field] && !/^#[0-9a-fA-F]{6}$/.test(input[field])) {
      throw new BadRequestError(`${field === 'primaryColour' ? 'Primary' : 'Accent'} colour must be a six-digit hex value such as #2F6BFF.`);
    }
  }

  const patch = {};
  for (const [field, column] of Object.entries({
    productName: 'product_name', primaryColour: 'primary_colour', accentColour: 'accent_colour',
    sidebarStyle: 'sidebar_style', loginHeadline: 'login_headline', loginSubtext: 'login_subtext',
    emailFromName: 'email_from_name', emailFromAddress: 'email_from_address',
    emailFooter: 'email_footer', smsSenderId: 'sms_sender_id',
    supportEmail: 'support_email', supportPhone: 'support_phone',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (input.enabled !== null && input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (input.hidePoweredBy !== null && input.hidePoweredBy !== undefined) {
    patch.hide_powered_by = input.hidePoweredBy ? 1 : 0;
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  const existing = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  if (existing) {
    await scope.updateWhere('white_label_settings', { tenant_id: ctx.tenantId },
      { ...patch, updated_by: ctx.userId, updated_at: nowIso() });
  } else {
    await scope.insert('white_label_settings', {
      tenant_id: ctx.tenantId, enabled: 0, ...patch,
      updated_by: ctx.userId, updated_at: nowIso(),
    });
  }

  await audit(ctx, {
    action: 'settings.updated', category: 'settings',
    entityType: 'branding', entityId: ctx.tenantId,
    newValue: patch,
  });

  const fresh = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  return ok({ branding: toBranding(fresh) }, { ctx });
}, { permission: 'whitelabel.manage' });

router.post('/branding/logo', async (ctx) => {
  await assertFeature(ctx, 'white_label');
  const scope = scopeFor(ctx);
  const form = await ctx.formData();
  const file = form.get('file');
  const kind = String(form.get('kind') ?? 'logo');

  if (!file || typeof file === 'string') throw new BadRequestError('Attach an image file.');
  if (!['logo', 'logo_dark', 'favicon', 'app_icon', 'login_image'].includes(kind)) {
    throw new BadRequestError('Unknown image slot.');
  }

  // Images only: a branding upload must not become a way to host arbitrary
  // files on the tenant's own domain. validateUpload throws a typed error
  // naming what is allowed, and returns the sanitised name and type.
  const checked = validateUpload({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    limits: {
      maxBytes: 2 * 1024 * 1024,
      allowedExtensions: ['png', 'jpg', 'jpeg', 'svg', 'webp', 'ico'],
      allowedMime: ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp',
        'image/x-icon', 'image/vnd.microsoft.icon'],
      blockedExtensions: [],
      maxZipEntries: 0,
    },
  });

  const key = tenantAssetKey({
    tenantId: ctx.tenantId, kind, id: ID.setting(), fileName: checked.fileName,
  });
  await putObject(ctx.env, key, await file.arrayBuffer(), {
    contentType: checked.mimeType, fileName: checked.fileName,
  });

  const column = { logo: 'logo_key', logo_dark: 'logo_dark_key', favicon: 'favicon_key',
    app_icon: 'app_icon_key', login_image: 'login_image_key' }[kind];

  const existing = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  if (existing) {
    await scope.updateWhere('white_label_settings', { tenant_id: ctx.tenantId },
      { [column]: key, updated_by: ctx.userId, updated_at: nowIso() });
  } else {
    await scope.insert('white_label_settings', {
      tenant_id: ctx.tenantId, enabled: 0, [column]: key,
      updated_by: ctx.userId, updated_at: nowIso(),
    });
  }

  return created({ kind, key, fileName: checked.fileName, sizeBytes: checked.sizeBytes }, { ctx });
}, { permission: 'whitelabel.manage' });

router.post('/branding/domain', async (ctx) => {
  await assertFeature(ctx, 'white_label');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    domain: { type: 'string', required: true, max: 200 },
  });

  const domain = input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new BadRequestError(`"${input.domain}" is not a valid domain name.`);
  }

  const clash = await new Db(ctx.env.DB).one(
    'SELECT tenant_id FROM white_label_settings WHERE custom_domain = ? AND tenant_id != ?',
    [domain, ctx.tenantId]);
  if (clash) throw new ConflictError('That domain is already claimed by another organisation.');

  const token = `mm-verify-${randomToken(16)}`;
  const existing = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  const patch = {
    custom_domain: domain,
    // Pending until DNS actually shows the record. Nothing here marks a domain
    // verified on the strength of somebody typing it in.
    domain_status: 'pending',
    domain_verification_token: token,
    domain_verified_at: null,
    ssl_status: 'pending',
    updated_by: ctx.userId,
    updated_at: nowIso(),
  };

  if (existing) await scope.updateWhere('white_label_settings', { tenant_id: ctx.tenantId }, patch);
  else await scope.insert('white_label_settings', { tenant_id: ctx.tenantId, enabled: 0, ...patch });

  await audit(ctx, {
    action: 'settings.updated', category: 'settings', severity: 'notice',
    entityType: 'branding', entityId: ctx.tenantId,
    newValue: { customDomain: domain },
  });

  return created({
    domain,
    status: 'pending',
    instructions: [
      { type: 'TXT', name: `_mm-verify.${domain}`, value: token },
      { type: 'CNAME', name: domain, value: new URL(ctx.env.APP_URL || 'https://app.example').hostname },
    ],
    note: 'Add both records with your DNS provider, then run the verification check.',
  }, { ctx });
}, { permission: 'whitelabel.manage' });

router.post('/branding/domain/verify', async (ctx) => {
  const scope = scopeFor(ctx);
  const settings = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
  if (!settings?.custom_domain) throw new NotFoundError('Custom domain');

  const dns = buildProvider('cloudflare_dns', ctx.env);
  if (!dns?.isConfigured()) {
    throw new IntegrationError('Cloudflare DNS',
      `Domain verification needs Cloudflare credentials on this deployment. Missing: ${(dns?.missingKeys() ?? []).join(', ')}.`,
      { configured: false, details: { missingKeys: dns?.missingKeys() ?? [] } });
  }

  const result = await dns.verifyDomain(settings.custom_domain);

  // Verified means the DNS record is actually there. A pending lookup is
  // pending, not "nearly done".
  const verified = !!result.ok && result.data?.found === true;
  await scope.updateWhere('white_label_settings', { tenant_id: ctx.tenantId }, {
    domain_status: verified ? 'verified' : 'pending',
    domain_verified_at: verified ? nowIso() : null,
    ssl_status: verified ? 'provisioning' : 'pending',
    updated_at: nowIso(),
  });

  return ok({
    domain: settings.custom_domain,
    verified,
    status: verified ? 'verified' : 'pending',
    // The real reason, so somebody can fix their DNS rather than guess.
    reason: verified ? null
      : (result.error?.message
        ?? 'The DNS record was not found yet. Changes can take a few minutes to propagate.'),
    lookup: result.ok ? result.data : null,
  }, { ctx });
}, { permission: 'whitelabel.manage' });

// ===========================================================================
// Backups
// ===========================================================================
router.get('/backups', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('backups', {}, { limit: 60 });
  const restores = await scope.all('restore_jobs', {}, { limit: 20 });

  return ok({
    backups: rows.map(toBackup),
    restores: restores.map(r => ({
      id: r.id,
      backupId: r.backup_id,
      mode: r.mode,
      status: r.status,
      error: r.error_message,
      startedAt: r.started_at,
      completedAt: r.completed_at,
    })),
    retentionDays: Number(ctx.env.BACKUP_RETENTION_DAYS || 30),
  }, { ctx });
}, { permission: 'backup.view' });

router.post('/backups', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    scope: { type: 'enum', values: ['data', 'documents', 'full'], default: 'data' },
  });

  const running = await scope.first('backups', { status: 'running' });
  if (running) throw new ConflictError('A backup is already running.');

  const backup = await scope.insert('backups', {
    id: ID.backup(),
    kind: 'manual',
    scope: input.scope,
    status: 'running',
    trigger: 'user',
    created_by: ctx.userId,
    started_at: nowIso(),
    expires_at: addDays(Number(ctx.env.BACKUP_RETENTION_DAYS || 30)),
  });

  const result = await runBackup(ctx, scope, backup, input.scope);

  await audit(ctx, {
    action: 'data.backup_created', category: 'data', severity: 'notice',
    result: result.ok ? 'success' : 'failure',
    entityType: 'backup', entityId: backup.id,
    newValue: { scope: input.scope, tables: result.tableCount, rows: result.rowCount },
  });

  const fresh = await scope.first('backups', { id: backup.id });
  return created({ backup: toBackup(fresh) }, { ctx });
}, { permission: 'backup.manage' });

router.get('/backups/:id/download', async (ctx) => {
  const scope = scopeFor(ctx);
  const backup = await scope.getOrFail('backups', ctx.params.id, { resource: 'Backup' });
  if (backup.status !== 'completed' || !backup.storage_key) {
    throw new ConflictError(`That backup is ${backup.status}, so there is nothing to download yet.`);
  }

  const object = await getObject(ctx.env, backup.storage_key);
  if (!object) throw new NotFoundError('Backup file');

  await audit(ctx, {
    action: 'data.exported', category: 'data', severity: 'warning',
    entityType: 'backup', entityId: backup.id,
    newValue: { sizeBytes: backup.size_bytes },
  });

  return fileResponse(object.body, {
    contentType: 'application/json',
    fileName: `backup-${backup.id}.json`,
    download: true,
  });
}, { permission: 'backup.manage', stepUp: true });

/**
 * Verify a backup by reading it back.
 *
 * A backup nobody has restored is a hope, not a backup. This re-reads the
 * stored object, re-computes its checksum and counts its rows, so the history
 * screen can show when each one was last proven readable.
 */
router.post('/backups/:id/verify', async (ctx) => {
  const scope = scopeFor(ctx);
  const backup = await scope.getOrFail('backups', ctx.params.id, { resource: 'Backup' });
  if (!backup.storage_key) throw new ConflictError('That backup has no stored file.');

  const object = await getObject(ctx.env, backup.storage_key);
  if (!object) {
    await scope.update('backups', backup.id, {
      status: 'failed', error_message: 'The stored file is missing from object storage.',
    });
    return ok({
      verified: false,
      reason: 'The stored file is missing from object storage. This backup cannot be restored.',
    }, { ctx });
  }

  const text = await new Response(object.body).text();
  const checksum = await sha256Hex(text);
  let rowCount = 0;
  let tableCount = 0;
  let parseError = null;

  try {
    const parsed = JSON.parse(text);
    tableCount = Object.keys(parsed.tables ?? {}).length;
    rowCount = Object.values(parsed.tables ?? {}).reduce((n, rows) => n + rows.length, 0);
  } catch (err) {
    parseError = err.message;
  }

  const checksumMatches = !backup.checksum_sha256 || backup.checksum_sha256 === checksum;
  const verified = !parseError && checksumMatches;

  return ok({
    verified,
    checksumMatches,
    storedChecksum: backup.checksum_sha256,
    computedChecksum: checksum,
    tableCount,
    rowCount,
    reason: verified ? null
      : (parseError ? `The backup file is not readable: ${parseError}`
        : 'The checksum does not match what was recorded when the backup was taken.'),
  }, { ctx });
}, { permission: 'backup.manage' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The tables a tenant backup covers. */
const BACKUP_TABLES = [
  'companies', 'branches', 'clients', 'client_contacts', 'filing_periods',
  'documents', 'document_versions', 'checklist_items', 'queries', 'query_replies',
  'tax_computations', 'gst_records', 'tds_records', 'reports', 'report_items',
  'invoices', 'invoice_items', 'payments', 'tasks', 'approvals', 'activities',
  'call_records', 'call_notes', 'leads', 'support_tickets', 'ticket_messages',
  'settings', 'automation_rules', 'calendar_events',
];

async function runBackup(ctx, scope, backup, kind) {
  const db = new Db(ctx.env.DB);
  const payload = { tenantId: ctx.tenantId, takenAt: nowIso(), scope: kind, tables: {} };
  let rowCount = 0;

  try {
    for (const table of BACKUP_TABLES) {
      const rows = await db.many(`SELECT * FROM ${table} WHERE tenant_id = ? LIMIT 50000`, [ctx.tenantId]);
      payload.tables[table] = rows;
      rowCount += rows.length;
    }

    // Documents are listed, not embedded: the bytes live in R2 and copying
    // them into a JSON file would produce something too large to restore.
    if (kind !== 'data') {
      const versions = await db.many(
        'SELECT id, document_id, storage_key, file_name, size_bytes, checksum_sha256 FROM document_versions WHERE tenant_id = ?',
        [ctx.tenantId]);
      payload.documentObjects = versions;
    }

    const text = JSON.stringify(payload);
    const checksum = await sha256Hex(text);
    const key = `tenant/${ctx.tenantId}/backups/${backup.id}.json`;
    await putObject(ctx.env, key, new TextEncoder().encode(text), {
      contentType: 'application/json', fileName: `backup-${backup.id}.json`,
    });

    await scope.update('backups', backup.id, {
      status: 'completed',
      storage_key: key,
      size_bytes: text.length,
      table_count: BACKUP_TABLES.length,
      row_count: rowCount,
      document_count: payload.documentObjects?.length ?? 0,
      checksum_sha256: checksum,
      manifest_json: JSON.stringify(
        Object.fromEntries(Object.entries(payload.tables).map(([t, rows]) => [t, rows.length]))),
      completed_at: nowIso(),
    });

    return { ok: true, tableCount: BACKUP_TABLES.length, rowCount };
  } catch (err) {
    await scope.update('backups', backup.id, {
      status: 'failed',
      error_message: err.message.slice(0, 500),
      completed_at: nowIso(),
    });
    return { ok: false, tableCount: 0, rowCount: 0, error: err.message };
  }
}

function toEvent(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    kind: e.kind,
    location: e.location,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: !!e.all_day,
    clientId: e.client_id,
    clientName: e.client_name ?? null,
    ownerId: e.owner_id,
    ownerName: e.owner_name ?? null,
    attendees: safeJson(e.attendees_json, []),
    reminderMinutes: e.reminder_minutes,
    status: e.status,
    provider: e.provider,
    syncStatus: e.sync_status,
    derived: false,
  };
}

function toEsign(r, signers) {
  const signed = signers.filter(s => s.status === 'signed').length;
  return {
    id: r.id,
    referenceNo: r.reference_no,
    title: r.title,
    provider: r.provider,
    method: r.method,
    status: r.status,
    sequential: !!r.sequential,
    clientId: r.client_id,
    clientName: r.client_name ?? null,
    documentId: r.document_id,
    reportId: r.report_id,
    expiresAt: r.expires_at,
    completedAt: r.completed_at,
    signers: signers.map(s => ({
      id: s.id, name: s.name, email: s.email, phone: s.phone,
      sequence: s.sequence, status: s.status, signedAt: s.signed_at,
      declinedReason: s.declined_reason,
    })),
    progress: { signed, total: signers.length },
    createdAt: r.created_at,
  };
}

function toBranding(b) {
  return {
    enabled: !!b.enabled,
    productName: b.product_name,
    logoKey: b.logo_key,
    logoDarkKey: b.logo_dark_key,
    faviconKey: b.favicon_key,
    appIconKey: b.app_icon_key,
    primaryColour: b.primary_colour,
    accentColour: b.accent_colour,
    sidebarStyle: b.sidebar_style,
    loginHeadline: b.login_headline,
    loginSubtext: b.login_subtext,
    loginImageKey: b.login_image_key,
    emailFromName: b.email_from_name,
    emailFromAddress: b.email_from_address,
    emailFooter: b.email_footer,
    smsSenderId: b.sms_sender_id,
    supportEmail: b.support_email,
    supportPhone: b.support_phone,
    hidePoweredBy: !!b.hide_powered_by,
    updatedAt: b.updated_at,
  };
}

function defaultBranding(ctx) {
  return {
    enabled: false,
    productName: ctx.env.APP_NAME ?? 'Meet Millions Finance CRM',
    primaryColour: '#2F6BFF',
    accentColour: '#22D3EE',
    sidebarStyle: 'glass',
    hidePoweredBy: false,
  };
}

function toBackup(b) {
  return {
    id: b.id,
    kind: b.kind,
    scope: b.scope,
    status: b.status,
    trigger: b.trigger,
    sizeBytes: b.size_bytes,
    tableCount: b.table_count,
    rowCount: b.row_count,
    documentCount: b.document_count,
    checksum: b.checksum_sha256,
    manifest: safeJson(b.manifest_json, null),
    error: b.error_message,
    startedAt: b.started_at,
    completedAt: b.completed_at,
    expiresAt: b.expires_at,
  };
}

function base64FromArrayBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: spreading a multi-megabyte array into String.fromCharCode at
  // once overflows the call stack.
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as workspaceRouter };
