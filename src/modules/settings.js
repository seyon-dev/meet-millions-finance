/**
 * Organisation settings: general preferences, the security policy, the IP
 * allow-list, saved views and feature flags.
 *
 * Settings are stored as namespaced key/value rows rather than a wide table,
 * so a new preference needs no migration. Anything marked secret is written
 * encrypted and never read back in clear — the API returns whether a value is
 * set, not what it is.
 */

import { createRouter } from '../http/router.js';
import { ok, created } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { DEFAULT_POLICY, getSecurityPolicy, ipInCidr } from '../services/security.js';
import { ROLE_KEYS } from '../permissions/roles.js';
import { STATE_CODES } from '../data/tax-rules.js';
import { UPLOAD_LIMITS, DOCUMENT_TYPES } from '../data/document-types.js';

const router = createRouter();

/**
 * The settings the UI knows how to render. Declaring them here means the
 * settings screen is generated from one list, and an unknown key cannot be
 * written by a client guessing at names.
 */
const SETTING_DEFINITIONS = [
  { namespace: 'general', key: 'organisation_name', type: 'string', label: 'Organisation name', max: 160 },
  { namespace: 'general', key: 'support_email', type: 'email', label: 'Support email address' },
  { namespace: 'general', key: 'support_phone', type: 'phone', label: 'Support phone number' },
  { namespace: 'general', key: 'default_state_code', type: 'enum', label: 'Default state', values: Object.keys(STATE_CODES) },
  { namespace: 'general', key: 'financial_year_start', type: 'string', label: 'Financial year starts', max: 5 },
  { namespace: 'general', key: 'default_theme', type: 'enum', label: 'Default theme', values: ['dark', 'light', 'system'] },
  { namespace: 'general', key: 'date_format', type: 'enum', label: 'Date format', values: ['dd/MM/yyyy', 'yyyy-MM-dd', 'dd MMM yyyy'] },

  { namespace: 'documents', key: 'sla_hours', type: 'int', label: 'Verification SLA (hours)', min: 1, max: 720 },
  { namespace: 'documents', key: 'auto_reminder_days', type: 'int', label: 'Reminder before due date (days)', min: 0, max: 30 },
  { namespace: 'documents', key: 'require_checklist_complete', type: 'boolean', label: 'Require a complete checklist before filing' },
  { namespace: 'documents', key: 'allow_client_delete', type: 'boolean', label: 'Clients may delete their own uploads' },
  { namespace: 'documents', key: 'watermark_downloads', type: 'boolean', label: 'Watermark downloaded documents' },

  { namespace: 'tax', key: 'default_gst_rate', type: 'number', label: 'Default GST rate (%)', min: 0, max: 28 },
  { namespace: 'tax', key: 'round_off_invoice_total', type: 'boolean', label: 'Round invoice totals to the nearest rupee' },
  { namespace: 'tax', key: 'gst_filing_reminder_day', type: 'int', label: 'GST reminder day of month', min: 1, max: 28 },

  { namespace: 'notifications', key: 'digest_enabled', type: 'boolean', label: 'Send the weekly digest' },
  { namespace: 'notifications', key: 'digest_day', type: 'enum', label: 'Digest day', values: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  { namespace: 'notifications', key: 'quiet_hours_start', type: 'string', label: 'Quiet hours start', max: 5 },
  { namespace: 'notifications', key: 'quiet_hours_end', type: 'string', label: 'Quiet hours end', max: 5 },

  { namespace: 'billing', key: 'invoice_prefix', type: 'string', label: 'Invoice number prefix', max: 10 },
  { namespace: 'billing', key: 'payment_terms_days', type: 'int', label: 'Payment terms (days)', min: 0, max: 180 },
  { namespace: 'billing', key: 'late_fee_pct', type: 'number', label: 'Late fee (% per month)', min: 0, max: 24 },
];

const DEFINITION_MAP = new Map(SETTING_DEFINITIONS.map(d => [`${d.namespace}.${d.key}`, d]));

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('settings', {}, { order: 'namespace ASC, key ASC', limit: 500 });
  const stored = new Map(rows.map(r => [`${r.namespace}.${r.key}`, r]));

  const namespaces = {};
  for (const def of SETTING_DEFINITIONS) {
    const row = stored.get(`${def.namespace}.${def.key}`);
    (namespaces[def.namespace] ??= []).push({
      key: def.key,
      label: def.label,
      type: def.type,
      values: def.values ?? null,
      min: def.min ?? null,
      max: def.max ?? null,
      value: row ? parseValue(row) : null,
      isSet: !!row,
      updatedAt: row?.updated_at ?? null,
    });
  }

  return ok({
    namespaces,
    uploadLimits: UPLOAD_LIMITS,
    documentTypes: DOCUMENT_TYPES.map(t => ({ key: t.key, name: t.name, category: t.category })),
    roles: ROLE_KEYS,
  }, { ctx });
}, { permission: 'settings.view' });

router.put('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const entries = Array.isArray(body?.settings) ? body.settings : null;
  if (!entries) throw new BadRequestError('Send { settings: [{ namespace, key, value }] }.');
  if (entries.length > 100) throw new BadRequestError('Change at most 100 settings at a time.');

  const db = new Db(ctx.env.DB);
  const applied = [];
  const rejected = [];
  const ts = nowIso();

  for (const entry of entries) {
    const def = DEFINITION_MAP.get(`${entry?.namespace}.${entry?.key}`);
    if (!def) {
      rejected.push({ namespace: entry?.namespace ?? null, key: entry?.key ?? null, reason: 'unknown_setting' });
      continue;
    }
    let value;
    try {
      const shaped = validate({ v: entry.value }, {
        v: { type: def.type, values: def.values, min: def.min, max: def.max, label: def.label },
      });
      value = shaped.v;
    } catch (err) {
      // A ValidationError carries the per-field message; the envelope message
      // ("Please correct the highlighted fields") says nothing useful here.
      const detail = err?.details?.v ?? err?.details?.fields?.v;
      rejected.push({ namespace: def.namespace, key: def.key, reason: detail ?? err.message });
      continue;
    }

    const existing = await scope.first('settings', { namespace: def.namespace, key: def.key });
    const payload = {
      value_json: JSON.stringify(value ?? null),
      value_type: def.type === 'int' || def.type === 'number' ? 'number'
        : def.type === 'boolean' ? 'boolean'
        : def.type === 'json' ? 'json' : 'string',
      description: def.label,
      updated_by: ctx.userId,
      updated_at: ts,
    };

    if (existing) {
      await db.run(
        `UPDATE settings SET value_json = ?, value_type = ?, description = ?, updated_by = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`,
        [payload.value_json, payload.value_type, payload.description, payload.updated_by, ts, existing.id, ctx.tenantId]);
    } else {
      await scope.insert('settings', {
        id: ID.setting(), namespace: def.namespace, key: def.key, ...payload,
      });
    }
    applied.push({ namespace: def.namespace, key: def.key, value });
  }

  await audit(ctx, {
    action: 'settings.updated', category: 'settings', severity: 'notice',
    entityType: 'settings', entityId: ctx.tenantId,
    newValue: { applied: applied.map(a => `${a.namespace}.${a.key}`), rejected: rejected.length },
  });

  return ok({ applied, rejected }, { ctx });
}, { permission: 'settings.manage' });

// ---------------------------------------------------------------------------
// Security policy
// ---------------------------------------------------------------------------
router.get('/security', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const policy = await getSecurityPolicy(db, ctx.tenantId);
  const scope = scopeFor(ctx);
  const allowlist = await scope.all('ip_allowlist', {}, { order: 'created_at DESC', limit: 100 });

  const stats = await scope.rawOne(
    `SELECT COUNT(*) AS users,
            SUM(CASE WHEN twofa_enabled = 1 THEN 1 ELSE 0 END) AS with_2fa
       FROM users WHERE tenant_id = ? AND status = 'active' AND deleted_at IS NULL`, [ctx.tenantId]);

  return ok({
    policy,
    defaults: DEFAULT_POLICY,
    ipAllowlist: allowlist,
    adoption: {
      activeUsers: Number(stats?.users) || 0,
      twoFactorUsers: Number(stats?.with_2fa) || 0,
      twoFactorPct: Number(stats?.users)
        ? Math.round((Number(stats?.with_2fa) / Number(stats?.users)) * 100) : null,
    },
    roleKeys: ROLE_KEYS,
  }, { ctx });
}, { permission: 'settings.view' });

router.patch('/security', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    enforce2fa: { type: 'boolean' },
    enforce2faRoles: { type: 'array', max: 10, of: { type: 'enum', values: ROLE_KEYS } },
    ipAllowlistEnabled: { type: 'boolean' },
    sessionTtlHours: { type: 'int', min: 1, max: 720 },
    idleTimeoutMinutes: { type: 'int', min: 0, max: 1440 },
    passwordMinLength: { type: 'int', min: 8, max: 64 },
    passwordRequireMixed: { type: 'boolean' },
    passwordExpiryDays: { type: 'int', min: 0, max: 365 },
    maxFailedLogins: { type: 'int', min: 3, max: 20 },
    lockoutMinutes: { type: 'int', min: 1, max: 1440 },
    deviceApproval: { type: 'boolean' },
    anomalyAlerts: { type: 'boolean' },
    stepUpForSensitive: { type: 'boolean' },
  });

  // Turning on the allow-list while your own address is outside it locks
  // everyone out, including you. Refuse rather than strand the tenant.
  if (input.ipAllowlistEnabled) {
    const entries = await scope.all('ip_allowlist', {}, { limit: 200 });
    const covered = entries.some(e => ipInCidr(ctx.ip, e.cidr));
    if (!covered) {
      throw new BadRequestError(
        `Your current address (${ctx.ip}) is not on the allow-list. Add it first, or you will be locked out.`);
    }
  }

  const patch = prune({
    enforce_2fa: bool(input.enforce2fa),
    enforce_2fa_roles: input.enforce2faRoles ? JSON.stringify(input.enforce2faRoles) : undefined,
    ip_allowlist_enabled: bool(input.ipAllowlistEnabled),
    session_ttl_hours: input.sessionTtlHours,
    idle_timeout_minutes: input.idleTimeoutMinutes,
    password_min_length: input.passwordMinLength,
    password_require_mixed: bool(input.passwordRequireMixed),
    password_expiry_days: input.passwordExpiryDays,
    max_failed_logins: input.maxFailedLogins,
    lockout_minutes: input.lockoutMinutes,
    device_approval: bool(input.deviceApproval),
    anomaly_alerts: bool(input.anomalyAlerts),
    step_up_for_sensitive: bool(input.stepUpForSensitive),
  });
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  const db = new Db(ctx.env.DB);
  const before = await getSecurityPolicy(db, ctx.tenantId);
  const existing = await scope.first('security_policies', { tenant_id: ctx.tenantId });

  if (existing) {
    await scope.updateWhere('security_policies', { tenant_id: ctx.tenantId },
      { ...patch, updated_by: ctx.userId, updated_at: nowIso() });
  } else {
    // Every column on this table is NOT NULL, so a first write has to carry a
    // complete row: the defaults the policy already reports, plus the change.
    await scope.insert('security_policies', {
      tenant_id: ctx.tenantId,
      enforce_2fa: before.enforce_2fa ? 1 : 0,
      enforce_2fa_roles: before.enforce_2fa_roles ? JSON.stringify(before.enforce_2fa_roles) : null,
      ip_allowlist_enabled: before.ip_allowlist_enabled ? 1 : 0,
      session_ttl_hours: before.session_ttl_hours,
      idle_timeout_minutes: before.idle_timeout_minutes,
      password_min_length: before.password_min_length,
      password_require_mixed: before.password_require_mixed ? 1 : 0,
      password_expiry_days: before.password_expiry_days,
      max_failed_logins: before.max_failed_logins,
      lockout_minutes: before.lockout_minutes,
      device_approval: before.device_approval ? 1 : 0,
      anomaly_alerts: before.anomaly_alerts ? 1 : 0,
      step_up_for_sensitive: before.step_up_for_sensitive ? 1 : 0,
      ...patch,
      updated_by: ctx.userId,
      updated_at: nowIso(),
    });
  }

  await audit(ctx, {
    action: 'security.policy_updated', category: 'security', severity: 'warning',
    entityType: 'security_policy', entityId: ctx.tenantId,
    oldValue: before, newValue: patch,
  });

  return ok({ policy: await getSecurityPolicy(db, ctx.tenantId) }, { ctx });
}, { permission: 'settings.manage', stepUp: true });

router.post('/security/ip-allowlist', async (ctx) => {
  await assertFeature(ctx, 'enterprise_security');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    cidr: { type: 'string', required: true, max: 50, label: 'IP address or CIDR range' },
    label: { type: 'string', max: 80 },
  });

  // An unparseable range would simply never match, which is worse than
  // useless: it looks like protection while protecting nothing.
  if (!isValidCidr(input.cidr)) {
    throw new BadRequestError(`${input.cidr} is not a valid IP address or CIDR range.`);
  }

  const clash = await scope.first('ip_allowlist', { cidr: input.cidr });
  if (clash) throw new ConflictError('That range is already on the allow-list.');

  const entry = await scope.insert('ip_allowlist', {
    id: ID.setting(),
    cidr: input.cidr,
    label: input.label ?? null,
    created_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'security.policy_updated', category: 'security', severity: 'warning',
    entityType: 'ip_allowlist', entityId: entry.id,
    newValue: { cidr: input.cidr, label: input.label ?? null, covers_current_ip: ipInCidr(ctx.ip, input.cidr) },
  });

  return created({ entry, coversYourAddress: ipInCidr(ctx.ip, input.cidr) }, { ctx });
}, { permission: 'settings.manage' });

router.delete('/security/ip-allowlist/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const entry = await scope.getOrFail('ip_allowlist', ctx.params.id, { resource: 'Allow-list entry' });

  const policy = await getSecurityPolicy(new Db(ctx.env.DB), ctx.tenantId);
  if (policy.ip_allowlist_enabled) {
    const remaining = await scope.all('ip_allowlist', {}, { limit: 200 });
    const others = remaining.filter(e => e.id !== entry.id);
    if (!others.some(e => ipInCidr(ctx.ip, e.cidr))) {
      throw new BadRequestError(
        'Removing that range would leave your own address outside the allow-list, locking you out.');
    }
  }

  await scope.delete('ip_allowlist', entry.id);
  await audit(ctx, {
    action: 'security.policy_updated', category: 'security', severity: 'warning',
    entityType: 'ip_allowlist', entityId: entry.id,
    oldValue: { cidr: entry.cidr }, newValue: { removed: true },
  });
  return ok({ id: entry.id, removed: true }, { ctx });
}, { permission: 'settings.manage' });

// ---------------------------------------------------------------------------
// Saved views — per-user filters on list screens
// ---------------------------------------------------------------------------
router.get('/views', async (ctx) => {
  const scope = scopeFor(ctx);
  const screen = ctx.q('screen');
  const where = scope.where('saved_views', 'v');
  where.add('(v.user_id = ? OR v.is_shared = 1)', ctx.userId);
  where.eqIf('v.screen', screen);
  const rows = await scope.raw(
    `SELECT v.*, u.full_name AS owner_name FROM saved_views v
       LEFT JOIN users u ON u.id = v.user_id
      WHERE v.tenant_id = ? ${where.clauses.length ? 'AND ' + where.clauses.join(' AND ') : ''}
      ORDER BY v.is_default DESC, v.name`,
    [ctx.tenantId, ...where.params]);

  return ok({
    views: rows.map(v => ({
      id: v.id, screen: v.screen, name: v.name,
      filters: safeJson(v.filters_json, {}),
      columns: safeJson(v.columns_json, null),
      sort: safeJson(v.sort_json, null),
      isDefault: !!v.is_default,
      isShared: !!v.is_shared,
      isMine: v.user_id === ctx.userId,
      ownerName: v.owner_name ?? null,
    })),
  }, { ctx });
}, { auth: true });

router.post('/views', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    screen: { type: 'string', required: true, max: 40 },
    name: { type: 'string', required: true, max: 60 },
    filters: { type: 'json', required: true },
    columns: { type: 'json' },
    sort: { type: 'json' },
    isDefault: { type: 'boolean', default: false },
    isShared: { type: 'boolean', default: false },
  });

  if (input.isShared && !ctx.has('settings.manage')) {
    throw new BadRequestError('Only an administrator can share a view with the whole team.');
  }
  if (input.isDefault) {
    await scope.updateWhere('saved_views',
      { user_id: ctx.userId, screen: input.screen }, { is_default: 0 });
  }

  const view = await scope.insert('saved_views', {
    id: ID.view(),
    user_id: ctx.userId,
    screen: input.screen,
    name: input.name,
    filters_json: JSON.stringify(input.filters),
    columns_json: input.columns ? JSON.stringify(input.columns) : null,
    sort_json: input.sort ? JSON.stringify(input.sort) : null,
    is_default: input.isDefault ? 1 : 0,
    is_shared: input.isShared ? 1 : 0,
  });
  return created({ view }, { ctx });
}, { auth: true });

router.delete('/views/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const view = await scope.getOrFail('saved_views', ctx.params.id, { resource: 'Saved view' });
  if (view.user_id !== ctx.userId && !ctx.has('settings.manage')) {
    throw new NotFoundError('Saved view');
  }
  await scope.delete('saved_views', view.id);
  return ok({ id: view.id, removed: true }, { ctx });
}, { auth: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Is this a literal IPv4/IPv6 address, or an address with a prefix length?
 * Deliberately strict — the allow-list is a security control, so a typo must
 * be rejected at entry rather than silently locking people out later.
 */
function isValidCidr(value) {
  const [addr, prefix] = String(value).split('/');
  const isV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(addr)
    && addr.split('.').every(o => Number(o) <= 255 && String(Number(o)) === o.replace(/^0+(?=\d)/, ''));
  const isV6 = addr.includes(':') && /^[0-9a-fA-F:]+$/.test(addr) && !/:::/.test(addr);
  if (!isV4 && !isV6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  return isV4 ? n >= 0 && n <= 32 : n >= 0 && n <= 128;
}

function parseValue(row) {
  try { return JSON.parse(row.value_json); } catch { return row.value_json; }
}
function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
// validate() reports an omitted optional boolean as null — treat it exactly
// like undefined, or every partial PATCH silently writes 0 over the columns
// the caller never mentioned (prune() keeps 0; it only drops null/undefined).
function bool(v) { return v === undefined || v === null ? undefined : (v ? 1 : 0); }
/**
 * Drop absent fields from a patch.
 *
 * validate() reports an omitted optional field as null, not undefined. Writing
 * that null through would clear a column the caller never mentioned — and on a
 * NOT NULL column it fails the whole request. Only fields actually sent should
 * reach the database.
 */
function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

export { router as settingsRouter, SETTING_DEFINITIONS };
