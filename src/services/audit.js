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
  companies: 'Companies',
  branches: 'Branches',
  documents: 'Documents',
  verification: 'Verification',
  queries: 'Queries',
  approvals: 'Approvals',
  tax: 'Tax',
  reports: 'Reports',
  billing: 'Billing',
  payments: 'Payments',
  addons: 'Add-ons',
  calls: 'Calling',
  communication: 'Communication',
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

/**
 * The fields the hash covers, in a fixed order.
 *
 * Every stored field except `hash` itself is listed. A field left out of this
 * list is a field an attacker may edit without breaking the chain — leaving
 * out `entity_label`, for instance, would let someone change *which* client a
 * recorded action was about while the trail still verified. `prev_hash` is not
 * listed because it is already hashed in as the chain prefix.
 *
 * Adding a column to audit_logs means adding it here, at the end, deliberately.
 */
const HASHED_FIELDS = [
  'tenant_id', 'sequence',
  'actor_id', 'actor_name', 'actor_role', 'actor_type',
  'action', 'category',
  'entity_type', 'entity_id', 'entity_label',
  'old_value_json', 'new_value_json',
  'severity', 'result',
  'ip', 'user_agent', 'session_id', 'request_id',
  'metadata_json', 'retain_until', 'created_at',
];

function canonical(entry) {
  // A stable serialisation — field order here defines the hash, so it must not
  // depend on object insertion order. The separator is escaped out of the
  // values so two different entries cannot serialise identically.
  return HASHED_FIELDS
    .map((field) => {
      const value = entry[field];
      if (value === null || value === undefined) return '';
      return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    })
    .join('|');
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

  // Support access: the person acting is the platform administrator, and the
  // trail must say so — never the account they are acting as. The label was
  // frozen on the session when it was opened.
  if (ctx.session?.impersonator_user_id) {
    entry.actor_id = ctx.session.impersonator_user_id;
    entry.actor_name = ctx.session.impersonator_label || 'Platform administrator';
    entry.actor_role = 'super_admin';
    // actor_type stays 'user' — the CHECK constraint on deployed databases
    // allows nothing else, and it is true: the actor is the platform
    // administrator. metadata.supportAccess is the discriminator.
    entry.metadata_json = JSON.stringify({
      ...(metadata ?? {}),
      supportAccess: {
        mode: ctx.session.impersonation_mode || 'support',
        actingAs: ctx.user
          ? { id: ctx.user.id, name: ctx.user.full_name, email: ctx.user.email }
          : null,
      },
    });
  }

  entry.hash = await sha256Hex(`${prevHash ?? ''}::${canonical(entry)}`);
  await db.insert('audit_logs', entry);
  return entry;
}

/**
 * An audit entry for something the system did on its own — a verified webhook
 * settling a payment, a cron job closing a period.
 *
 * These changes are exactly the ones nobody watched happen, so leaving them out
 * of the chain would put the least observed events beyond review. The actor is
 * recorded as the source that caused it, never as a user who was not there.
 */
export async function auditSystem(env, { tenantId, source = 'system', ...payload }) {
  return audit({
    env,
    tenantId,
    userId: null,
    user: null,
    roleKeys: ['system'],
    ip: source,
    userAgent: `meet-millions-${source}`.slice(0, 400),
    session: null,
    apiKey: null,
    requestId: null,
    defer: (p) => (typeof p === 'function' ? p() : p),
  }, { ...payload, actorType: 'system', actorName: source });
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

  return {
    valid: true,
    checked: rows.length,
    brokenAt: null,
    reason: null,
    // A hash chain proves nothing was edited or removed *from the middle*.
    // Entries deleted from the end leave a shorter but internally consistent
    // chain, so the caller is given the range and the highest sequence to
    // compare against its own records.
    firstSequence: rows.length ? rows[0].sequence : null,
    lastSequence: rows.length ? rows[rows.length - 1].sequence : null,
    coversTailTruncation: false,
  };
}

/**
 * Anchor the chain's head.
 *
 * The hash chain detects an edited or deleted entry in the middle, because the
 * chain stops matching. It cannot detect entries removed from the *end*: a
 * truncated chain is shorter but still internally consistent, and verification
 * reports it as valid.
 *
 * An anchor closes that. The head hash and sequence are written to a settings
 * row on a schedule; each anchor includes the previous one, so the anchors form
 * their own chain. Truncating the audit log now contradicts a record written
 * separately — to hide it, somebody has to forge every anchor since.
 *
 * This is deliberately not perfect: an attacker with full database write access
 * can rewrite the anchors too. Making it genuinely tamper-proof needs the head
 * hash written somewhere outside this database entirely, which
 * docs/disaster-recovery.md lists as the next improvement. What this does give
 * is detection of the ordinary case — a DELETE run against audit_logs.
 */
export async function anchorChain(db, tenantId) {
  const head = await db.one(
    `SELECT sequence, hash FROM audit_logs WHERE tenant_id IS ?
      ORDER BY sequence DESC LIMIT 1`, [tenantId ?? null]);

  if (!head) return { anchored: false, reason: 'empty_chain' };

  const key = `audit_anchor:${tenantId ?? 'platform'}`;
  const existing = await db.one(
    "SELECT * FROM settings WHERE tenant_id IS NULL AND namespace = 'platform' AND key = ?", [key]);

  const previous = existing ? safeJson(existing.value_json, null) : null;

  // Refusing to move an anchor backwards is the point: if the head sequence is
  // lower than the last anchor, entries have been removed from the end.
  if (previous && head.sequence < previous.sequence) {
    return {
      anchored: false,
      reason: 'chain_shrank',
      previousSequence: previous.sequence,
      currentSequence: head.sequence,
    };
  }

  const anchor = {
    sequence: head.sequence,
    hash: head.hash,
    previousAnchorHash: previous?.selfHash ?? null,
    at: nowIso(),
  };
  // Each anchor covers the one before it, so the anchors are a chain too.
  anchor.selfHash = await sha256Hex(
    `${anchor.previousAnchorHash ?? ''}::${anchor.sequence}::${anchor.hash}::${anchor.at}`);

  if (existing) {
    await db.run(
      `UPDATE settings SET value_json = ?, updated_at = ?
        WHERE tenant_id IS NULL AND namespace = 'platform' AND key = ?`,
      [JSON.stringify(anchor), nowIso(), key]);
  } else {
    await db.insertOrIgnore('settings', {
      id: ID.setting(),
      tenant_id: null,
      namespace: 'platform',
      key,
      value_json: JSON.stringify(anchor),
      value_type: 'json',
      description: 'Audit chain head, anchored so tail truncation is detectable.',
      updated_at: nowIso(),
    });
  }

  return { anchored: true, sequence: anchor.sequence, at: anchor.at };
}

/**
 * Check the live chain against its last anchor.
 *
 * Returns `covered: false` when no anchor exists yet — which is the honest
 * answer, not a pass.
 */
export async function verifyAgainstAnchor(db, tenantId) {
  const key = `audit_anchor:${tenantId ?? 'platform'}`;
  const row = await db.one(
    "SELECT * FROM settings WHERE tenant_id IS NULL AND namespace = 'platform' AND key = ?", [key]);

  if (!row) {
    return {
      covered: false,
      reason: 'No anchor has been written yet, so truncation cannot be detected. '
        + 'Anchors are written by the daily scheduled job.',
    };
  }

  const anchor = safeJson(row.value_json, null);
  if (!anchor) return { covered: false, reason: 'The stored anchor could not be read.' };

  const head = await db.one(
    `SELECT sequence, hash FROM audit_logs WHERE tenant_id IS ?
      ORDER BY sequence DESC LIMIT 1`, [tenantId ?? null]);

  if (!head) {
    return {
      covered: true, intact: false, anchoredSequence: anchor.sequence, currentSequence: 0,
      reason: `The anchor records ${anchor.sequence} entries, but the log is now empty. `
        + 'Entries have been removed.',
    };
  }

  if (head.sequence < anchor.sequence) {
    return {
      covered: true, intact: false,
      anchoredSequence: anchor.sequence, currentSequence: head.sequence,
      reason: `The log ends at ${head.sequence} but was anchored at ${anchor.sequence}. `
        + `${anchor.sequence - head.sequence} entr${anchor.sequence - head.sequence === 1 ? 'y has' : 'ies have'} `
        + 'been removed from the end.',
    };
  }

  // The anchored entry must still be present and unchanged.
  const anchored = await db.one(
    'SELECT hash FROM audit_logs WHERE tenant_id IS ? AND sequence = ?',
    [tenantId ?? null, anchor.sequence]);

  if (!anchored) {
    return {
      covered: true, intact: false,
      anchoredSequence: anchor.sequence, currentSequence: head.sequence,
      reason: `Entry ${anchor.sequence} was anchored but is no longer in the log.`,
    };
  }
  if (anchored.hash !== anchor.hash) {
    return {
      covered: true, intact: false,
      anchoredSequence: anchor.sequence, currentSequence: head.sequence,
      reason: `Entry ${anchor.sequence} has been modified since it was anchored.`,
    };
  }

  return {
    covered: true, intact: true,
    anchoredSequence: anchor.sequence,
    currentSequence: head.sequence,
    anchoredAt: anchor.at,
    reason: null,
  };
}

function safeJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
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
