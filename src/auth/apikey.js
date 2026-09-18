/**
 * API keys for the API Marketplace add-on.
 *
 * A key looks like `mmk_live_<prefix>_<secret>`. Only the SHA-256 of the whole
 * key is stored, so the plaintext is shown exactly once, at creation.
 */

import { randomToken, sha256Hex } from './crypto.js';
import { ID } from '../utils/id.js';
import { nowIso, isPast } from '../utils/time.js';
import { PERMISSION_KEYS } from '../permissions/catalog.js';

const KEY_PREFIX = 'mmk';

/** The scopes an API key may be granted — a read/write view of the catalogue. */
export const API_SCOPES = [
  { key: 'clients.read', permissions: ['clients.view'], label: 'Read clients' },
  { key: 'clients.write', permissions: ['clients.view', 'clients.create', 'clients.update'], label: 'Create and update clients' },
  { key: 'documents.read', permissions: ['documents.view', 'documents.download'], label: 'Read documents' },
  { key: 'documents.write', permissions: ['documents.view', 'documents.upload', 'documents.replace'], label: 'Upload documents' },
  { key: 'queries.read', permissions: ['queries.view'], label: 'Read queries' },
  { key: 'queries.write', permissions: ['queries.view', 'queries.create', 'queries.reply'], label: 'Raise and answer queries' },
  { key: 'tax.read', permissions: ['tax.view'], label: 'Read tax computations' },
  { key: 'reports.read', permissions: ['reports.view', 'reports.export'], label: 'Read and export reports' },
  { key: 'invoices.read', permissions: ['invoices.view', 'payments.view'], label: 'Read invoices and payments' },
  { key: 'invoices.write', permissions: ['invoices.view', 'invoices.create'], label: 'Raise invoices' },
  { key: 'leads.write', permissions: ['leads.view', 'leads.manage'], label: 'Create and update leads' },
  { key: 'calls.read', permissions: ['calls.view', 'calls.analytics'], label: 'Read call history and analytics' },
  { key: 'analytics.read', permissions: ['analytics.view'], label: 'Read analytics' },
  { key: 'webhooks.receive', permissions: [], label: 'Receive webhooks' },
];

const SCOPE_MAP = new Map(API_SCOPES.map(s => [s.key, s]));

export function scopesToPermissions(scopes) {
  const set = new Set();
  for (const scope of scopes) {
    for (const p of SCOPE_MAP.get(scope)?.permissions ?? []) set.add(p);
  }
  return set;
}

export function isKnownScope(scope) { return SCOPE_MAP.has(scope); }

/** Create a key. The plaintext is returned once and never stored. */
export async function issueApiKey(scope, {
  tenantId, name, scopes, rateLimitPerMin = 60, allowedIps = null, expiresAt = null, createdBy,
}) {
  const env = 'live';
  const prefix = randomToken(6).slice(0, 8);
  const secret = randomToken(32);
  const plaintext = `${KEY_PREFIX}_${env}_${prefix}_${secret}`;
  const keyHash = await sha256Hex(plaintext);

  const row = {
    id: ID.apiKey(),
    tenant_id: tenantId,
    name,
    key_prefix: `${KEY_PREFIX}_${env}_${prefix}`,
    key_hash: keyHash,
    scopes_json: JSON.stringify(scopes),
    rate_limit_per_min: rateLimitPerMin,
    allowed_ips_json: allowedIps ? JSON.stringify(allowedIps) : null,
    status: 'active',
    request_count: 0,
    expires_at: expiresAt,
    created_by: createdBy,
    created_at: nowIso(),
  };
  await scope.insert('api_keys', row);
  return { plaintext, apiKey: row };
}

/** Resolve a presented key, or null. Also enforces IP pinning and expiry. */
export async function verifyApiKey(db, presented, ip) {
  if (typeof presented !== 'string' || !presented.startsWith(`${KEY_PREFIX}_`)) return null;

  const keyHash = await sha256Hex(presented.trim());
  const apiKey = await db.findOne('api_keys', { key_hash: keyHash });
  if (!apiKey) return null;
  if (apiKey.status !== 'active') return null;
  if (apiKey.expires_at && isPast(apiKey.expires_at)) {
    await db.update('api_keys', { id: apiKey.id }, { status: 'expired' });
    return null;
  }

  if (apiKey.allowed_ips_json) {
    const allowed = safeJson(apiKey.allowed_ips_json, []);
    if (allowed.length && !allowed.includes(ip)) return null;
  }

  const tenant = await db.findOne('tenants', { id: apiKey.tenant_id });
  if (!tenant || tenant.status === 'suspended') return null;

  const scopes = safeJson(apiKey.scopes_json, []);
  const permissions = scopesToPermissions(scopes);

  await db.update('api_keys', { id: apiKey.id }, {
    last_used_at: nowIso(),
    request_count: (apiKey.request_count ?? 0) + 1,
  });

  return { apiKey, tenant, scopes, permissions };
}

export async function revokeApiKey(scope, id, revokedBy) {
  return scope.update('api_keys', id, {
    status: 'revoked', revoked_at: nowIso(), revoked_by: revokedBy,
  });
}

/** Record a call for the usage dashboard and rate-limit rollups. */
export async function recordApiUsage(scope, { apiKeyId, method, path, statusCode, durationMs, ip, userAgent, errorCode }) {
  return scope.insert('api_usage', {
    id: ID.apiUsage(),
    api_key_id: apiKeyId,
    method,
    path: path.slice(0, 300),
    status_code: statusCode,
    duration_ms: durationMs,
    ip,
    user_agent: (userAgent || '').slice(0, 200),
    error_code: errorCode ?? null,
    bucket_hour: nowIso().slice(0, 13),
  });
}

function safeJson(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

export { PERMISSION_KEYS };
