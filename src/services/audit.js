/**
 * The audit trail.
 *
 * Each entry stores the SHA-256 of (previous hash + this row's canonical
 * fields). Deleting or editing any row breaks every hash after it, which
 * `verifyChain()` detects — that is what makes the log tamper-evident rather
 * than merely append-only. Retention is configurable up to seven years for
 * the Advanced Audit Logs add-on.
 */

import { ID } from '../utils/id.js';
import { nowIso, addDays } from '../utils/time.js';
import { sha256Hex } from '../auth/crypto.js';
import { Db } from '../db/client.js';

export const AUDIT_CATEGORIES = {
  auth: 'Authentication',
  users: 'Users & roles',
  clients: 'Clients',
  documents: 'Documents',
  verification: 'Verification',
  queries: 'Queries',
  tax: 'Tax',
  reports: 'Reports',
  billing: 'Billing',
  payments: 'Payments',
  addons: 'Add-ons',
  calls: 'Calling',
  integrations: 'Integrations',
  security: 'Security',
  settings: 'Settings',
  data: 'Data & backups',
  api: 'API',
  general: 'General',
};

/** Actions that must always produce an audit record (§63). */
export const AUDITED_ACTIONS = [
  'auth.login', 'auth.login_failed', 'auth.logout', 'auth.2fa_enabled', 'auth.2fa_disabled',
  'auth.password_changed', 'auth.password_reset', 'auth.session_revoked',
  'users.created', 'users.updated', 'users.deactivated', 'users.role_changed', 'users.permission_changed',
  'clients.created', 'clients.updated', 'clients.archived', 'clients.assigned',
  'documents.uploaded', 'documents.replaced', 'documents.deleted', 'documents.downloaded',
  'documents.locked', 'documents.archived',
  'verification.approved', 'verification.rejected', 'verification.query_raised', 'verification.changes_requested',
  'queries.created', 'queries.replied', 'queries.resolved',
  'tax.computed', 'tax.finalised', 'tax.rule_changed', 'tax.record_edited',
  'reports.generated', 'reports.submitted', 'reports.approved', 'reports.rejected', 'reports.signed_off',
  'billing.plan_changed', 'billing.invoice_created', 'billing.invoice_voided',
  'payments.initiated', 'payments.succeeded', 'payments.failed', 'payments.refunded',
  'addons.activated', 'addons.deactivated', 'addons.configured',
  'calls.placed', 'calls.received', 'calls.recording_downloaded', 'calls.settings_changed',
  'integrations.connected', 'integrations.disconnected',
  'security.policy_changed', 'security.ip_allowlist_changed', 'security.device_blocked',
  'settings.changed',
  'data.backup_created', 'data.restore_run', 'data.exported',
  'api.key_created', 'api.key_revoked',
];

function canonical(entry) {
  // A stable serialisation — key order here defines the hash, so it must not
  // depend on object insertion order.
  return [
    entry.tenant_id ?? '', entry.sequence, entry.actor_id ?? '', entry.action,
    entry.entity_type ?? '', entry.entity_id ?? '', entry.result,
    entry.old_value_json ?? '', entry.new_value_json ?? '', entry.created_at,
  ].join('|');
}

async function nextSequenceAndHash(db, tenantId) {
  const last = await db.one(
    `SELECT sequence, hash FROM audit_logs
      WHERE tenant_id IS ? ORDER BY sequence DESC LIMIT 1`, [tenantId ?? null]);
  return { sequence: (last?.sequence ?? 0) + 1, prevHash: last?.hash ?? null };
}

/**
 * Write an audit entry. Call sites pass the request context so actor, IP and
 * request id are captured consistently.
 *
 * Deliberately not batched with the caller's own writes: an audit failure must
 * never roll back the business action, and a business failure must still leave
 * the attempt recorded when `result` says so.
 */
export async function audit(ctx, {
  action,
  category = inferCategory(action),
  entityType = null,
  entityId = null,
  entityLabel = null,
  oldValue = null,
  newValue = null,
  severity = 'info',
  result = 'success',
  metadata = null,
  tenantId,
  actorId,
  actorName,
  actorRole,
  actorType = 'user',
}) {
  const db = new Db(ctx.env.DB);
  const tid = tenantId !== undefined ? tenantId : ctx.tenantId ?? null;
  const { sequence, prevHash } = await nextSequenceAndHash(db, tid);

  const retentionDays = Number(ctx.env.AUDIT_RETENTION_DAYS || 2555);
  const created = nowIso();

  const entry = {
    id: ID.audit(),
    tenant_id: tid,
    sequence,
    actor_id: actorId !== undefined ? actorId : ctx.userId,
    actor_name: actorName ?? ctx.user?.full_name ?? (ctx.apiKey ? `API key: ${ctx.apiKey.name}` : null),
    actor_role: actorRole ?? ctx.roleKeys?.[0] ?? null,
    actor_type: ctx.apiKey ? 'api_key' : actorType,
    action,
    category,
    entity_type: entityType,
    entity_id: entityId,
    entity_label: entityLabel ? String(entityLabel).slice(0, 200) : null,
    old_value_json: oldValue ? JSON.stringify(redact(oldValue)) : null,
    new_value_json: newValue ? JSON.stringify(redact(newValue)) : null,
    severity,
    result,
    ip: ctx.ip ?? null,
    user_agent: (ctx.userAgent || '').slice(0, 400),
    session_id: ctx.session?.id ?? null,
    request_id: ctx.requestId ?? null,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    prev_hash: prevHash,
    hash: '',
    retain_until: addDays(retentionDays, new Date(created)),
    created_at: created,
  };

  entry.hash = await sha256Hex(`${prevHash ?? ''}::${canonical(entry)}`);
  await db.insert('audit_logs', entry);
  return entry;
}

/** Fire-and-forget audit — the response does not wait for the write. */
export function auditAsync(ctx, payload) {
  return ctx.defer(audit(ctx, payload).catch(err => {
    console.error('audit write failed', { action: payload.action, message: err.message });
  }));
}

/** Never let a secret reach the audit trail, even as an "old value". */
const SENSITIVE_KEYS = /(password|secret|token|api_key|apikey|authorization|auth|private_key|signature|otp|cvv|pan_number|aadhaar)/i;

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function inferCategory(action) {
  const prefix = String(action).split('.')[0];
  return AUDIT_CATEGORIES[prefix] ? prefix : 'general';
}

/**
 * Walk the chain for a tenant and report the first break, if any.
 * Backs the "verify integrity" button on the Advanced Audit Log screen.
 */
export async function verifyChain(db, tenantId, { limit = 5000 } = {}) {
  const rows = await db.many(
    `SELECT * FROM audit_logs WHERE tenant_id IS ? ORDER BY sequence ASC LIMIT ?`,
    [tenantId ?? null, limit]);

  let prevHash = null;
  let expectedSequence = rows.length ? rows[0].sequence : 1;

  for (const row of rows) {
    if (row.sequence !== expectedSequence) {
      return {
        valid: false, checked: rows.length, brokenAt: row.id,
        reason: `Sequence gap: expected ${expectedSequence}, found ${row.sequence}. A record may have been deleted.`,
      };
    }
    if ((row.prev_hash ?? null) !== prevHash) {
      return {
        valid: false, checked: rows.length, brokenAt: row.id,
        reason: 'Chain link mismatch: this entry does not follow the previous one.',
      };
    }
    const recomputed = await sha256Hex(`${prevHash ?? ''}::${canonical(row)}`);
    if (recomputed !== row.hash) {
      return {
        valid: false, checked: rows.length, brokenAt: row.id,
        reason: 'Hash mismatch: this entry has been modified since it was written.',
      };
    }
    prevHash = row.hash;
    expectedSequence++;
  }

  return { valid: true, checked: rows.length, brokenAt: null, reason: null };
}

/** Purge entries past their retention date (cron). */
export async function purgeExpiredAuditLogs(db) {
  const meta = await db.run('DELETE FROM audit_logs WHERE retain_until IS NOT NULL AND retain_until < ?', [nowIso()]);
  return meta?.changes ?? 0;
}

/** Human-readable timeline entry, written alongside the audit record. */
export async function recordActivity(ctx, {
  clientId = null, companyId = null, verb, entityType, entityId = null,
  summary, detail = null, visibility = 'internal', icon = null,
}) {
  const db = new Db(ctx.env.DB);
  const row = {
    id: ID.activity(),
    tenant_id: ctx.tenantId,
    company_id: companyId,
    client_id: clientId,
    actor_id: ctx.userId,
    actor_name: ctx.user?.full_name ?? 'System',
    actor_role: ctx.roleKeys?.[0] ?? null,
    verb,
    entity_type: entityType,
    entity_id: entityId,
    summary,
    detail_json: detail ? JSON.stringify(detail) : null,
    visibility,
    icon,
    created_at: nowIso(),
  };
  await db.insert('activities', row);
  return row;
}
