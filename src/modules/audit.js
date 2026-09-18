/**
 * The audit trail, and its integrity check.
 *
 * Entries are hash-chained: each one's hash covers the previous hash plus its
 * own canonical form, so an edit or a deletion anywhere in the chain breaks
 * every link after it. That property is only worth having if somebody can
 * check it, which is what /verify is for — it re-derives the chain from the
 * stored rows and reports exactly where it first diverges.
 *
 * Nothing here writes to audit_logs. There is no edit and no delete, not even
 * for a Super Admin: an audit trail that its subject can amend is not one.
 */

import { createRouter } from '../http/router.js';
import { ok, paginated, fileResponse } from '../http/response.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { addDays, nowIso } from '../utils/time.js';
import { verifyChain, AUDIT_CATEGORIES, AUDITED_ACTIONS } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { escapeCsv } from '../utils/validate.js';

const router = createRouter();

const SEVERITIES = ['info', 'notice', 'warning', 'critical'];
const RESULTS = ['success', 'failure', 'denied'];

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination({ defaultSize: 50, maxSize: 200 });

  const where = scope.where('audit_logs', 'al');
  where.eqIf('al.category', ctx.q('category'));
  where.eqIf('al.action', ctx.q('action'));
  where.eqIf('al.actor_id', ctx.q('actorId'));
  where.eqIf('al.entity_type', ctx.q('entityType'));
  where.eqIf('al.entity_id', ctx.q('entityId'));
  where.eqIf('al.result', ctx.q('result'));
  where.betweenIf('al.created_at', ctx.q('from'), ctx.q('to'));
  where.searchIf(['al.action', 'al.entity_label', 'al.actor_name'], ctx.q('q'));

  const severities = ctx.qList('severity');
  if (severities.length) where.inIf('al.severity', severities);

  const { rows, total } = await scope.paginate('audit_logs', where, {
    columns: 'al.*',
    alias: 'al',
    orderBy: `al.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'sequence', 'severity'], 'created_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical,
            SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning,
            SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END) AS denied,
            MIN(created_at) AS earliest, MAX(created_at) AS latest
       FROM audit_logs WHERE tenant_id = ?`, [ctx.tenantId]);

  return paginated(rows.map(toEntry), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      critical: Number(counts?.critical) || 0,
      warning: Number(counts?.warning) || 0,
      denied: Number(counts?.denied) || 0,
      earliest: counts?.earliest ?? null,
      latest: counts?.latest ?? null,
    },
    filters: {
      categories: AUDIT_CATEGORIES,
      severities: SEVERITIES,
      results: RESULTS,
      actions: AUDITED_ACTIONS,
    },
  }, ctx);
}, { permission: 'audit.view' });

/**
 * Integrity check.
 *
 * Re-derives every hash from the stored rows. A tenant's chain is either
 * intact, or the response names the first entry that does not agree with its
 * predecessor — which is the entry to investigate.
 */
router.get('/verify', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const limit = Math.min(ctx.qInt('limit', 5000), 20000);
  const result = await verifyChain(db, ctx.tenantId, { limit });

  return ok({
    ...result,
    checkedAt: nowIso(),
    explanation: result.valid
      ? `Every one of the ${result.checked} entries hashes to the value stored with the next, so no entry has been altered, and none has been removed from between entries ${result.firstSequence} and ${result.lastSequence}.`
      : 'The chain does not verify. The entry named below is the first that disagrees with its predecessor: either it was edited, or an entry before it was removed.',
    // Said plainly rather than left for someone to assume otherwise: a hash
    // chain cannot prove that entries were not deleted from the end. Compare
    // the highest sequence against your own records to close that gap.
    limitation: 'Entries removed from the end of the chain leave a shorter but internally consistent chain. This check cannot detect that; compare the last sequence against your own records.',
  }, { ctx });
}, { permission: 'audit.view' });

/** One entry, with the before/after diff the UI renders side by side. */
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const entry = await scope.first('audit_logs', { id: ctx.params.id });
  if (!entry) throw new NotFoundError('Audit entry');

  const neighbours = await scope.raw(
    `SELECT id, sequence, action, created_at FROM audit_logs
      WHERE tenant_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence`,
    [ctx.tenantId, entry.sequence - 2, entry.sequence + 2]);

  const related = entry.entity_id
    ? await scope.raw(
        `SELECT id, sequence, action, actor_name, severity, created_at FROM audit_logs
          WHERE tenant_id = ? AND entity_id = ? AND id != ?
          ORDER BY created_at DESC LIMIT 20`,
        [ctx.tenantId, entry.entity_id, entry.id])
    : [];

  const oldValue = parseJson(entry.old_value_json);
  const newValue = parseJson(entry.new_value_json);

  return ok({
    entry: toEntry(entry),
    diff: buildDiff(oldValue, newValue),
    neighbours,
    relatedEntries: related,
  }, { ctx });
}, { permission: 'audit.view' });

/** A compliance export. CSV by default; the filters match the list screen. */
router.get('/export/csv', async (ctx) => {
  await assertFeature(ctx, 'audit_logs');
  const scope = scopeFor(ctx);

  const from = ctx.q('from') ?? addDays(-90);
  const to = ctx.q('to') ?? nowIso();
  const where = scope.where('audit_logs', 'al');
  where.betweenIf('al.created_at', from, to);
  where.eqIf('al.category', ctx.q('category'));
  const severities = ctx.qList('severity');
  if (severities.length) where.inIf('al.severity', severities);

  const rows = await scope.raw(
    `SELECT al.* FROM audit_logs al
      WHERE al.tenant_id = ? ${where.clauses.length ? 'AND ' + where.clauses.join(' AND ') : ''}
      ORDER BY al.sequence ASC LIMIT 50000`,
    [ctx.tenantId, ...where.params]);

  if (!rows.length) {
    throw new BadRequestError('There are no audit entries in that period, so there is nothing to export.');
  }

  // escapeCsv neutralises a leading =, +, - or @, so a client-supplied entity
  // label cannot become a formula when the export is opened in a spreadsheet.
  const header = ['Sequence', 'Timestamp', 'Actor', 'Role', 'Action', 'Category',
    'Severity', 'Result', 'Entity', 'Entity ID', 'IP', 'Hash'];
  const lines = [header.map(escapeCsv).join(',')];
  for (const r of rows) {
    lines.push([
      r.sequence, r.created_at, r.actor_name ?? 'system', r.actor_role ?? '',
      r.action, r.category, r.severity, r.result,
      r.entity_label ?? r.entity_type ?? '', r.entity_id ?? '',
      r.ip ?? '', r.hash,
    ].map(escapeCsv).join(','));
  }
  // A BOM so Excel reads the file as UTF-8.
  const csv = '\ufeff' + lines.join('\r\n');

  return fileResponse(csv, {
    contentType: 'text/csv; charset=utf-8',
    fileName: `audit-log-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv`,
    download: true,
  });
}, { permission: 'audit.export' });

/** Everything that has happened to one record. */
router.get('/entity/:entityType/:entityId', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.raw(
    `SELECT * FROM audit_logs
      WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?
      ORDER BY sequence ASC LIMIT 200`,
    [ctx.tenantId, ctx.params.entityType, ctx.params.entityId]);

  return ok({
    entityType: ctx.params.entityType,
    entityId: ctx.params.entityId,
    history: rows.map(r => ({
      ...toEntry(r),
      diff: buildDiff(parseJson(r.old_value_json), parseJson(r.new_value_json)),
    })),
  }, { ctx });
}, { permission: 'audit.view' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toEntry(r) {
  return {
    id: r.id,
    sequence: r.sequence,
    action: r.action,
    category: r.category,
    severity: r.severity,
    result: r.result,
    actor: {
      id: r.actor_id,
      name: r.actor_name ?? 'System',
      role: r.actor_role,
      type: r.actor_type,
    },
    entity: {
      type: r.entity_type,
      id: r.entity_id,
      label: r.entity_label,
    },
    oldValue: parseJson(r.old_value_json),
    newValue: parseJson(r.new_value_json),
    metadata: parseJson(r.metadata_json),
    ip: r.ip,
    userAgent: r.user_agent,
    requestId: r.request_id,
    // The hashes are shown so an auditor can spot-check a row against the
    // verification endpoint rather than take its word for it.
    hash: r.hash,
    prevHash: r.prev_hash,
    retainUntil: r.retain_until,
    createdAt: r.created_at,
  };
}

/**
 * A field-by-field diff for the side-by-side view.
 *
 * Only changed fields appear. A field present on one side alone is an add or a
 * removal, which is exactly what an auditor is looking for.
 */
function buildDiff(oldValue, newValue) {
  if (!oldValue && !newValue) return [];
  const keys = [...new Set([
    ...Object.keys(oldValue ?? {}),
    ...Object.keys(newValue ?? {}),
  ])].sort();

  const rows = [];
  for (const key of keys) {
    const before = oldValue?.[key];
    const after = newValue?.[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    rows.push({
      field: key,
      label: humanise(key),
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
      change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    });
  }
  return rows;
}

function humanise(key) {
  return String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export { router as auditRouter };
