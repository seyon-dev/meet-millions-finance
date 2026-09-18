/**
 * The activity feed.
 *
 * Business events — a document uploaded, a query raised, a report approved —
 * as opposed to `audit_logs`, which is the tamper-evident security record.
 * The two are deliberately separate: this one is readable by anybody who can
 * see the client, and it is allowed to be incomplete; the audit trail is
 * neither.
 *
 * A client user sees only entries marked visible to clients, and only for
 * their own record. That narrowing is applied here, not left to the caller.
 */

import { createRouter } from '../http/router.js';
import { paginated, ok } from '../http/response.js';
import { scopeFor } from '../db/tenancy.js';
import { Db } from '../db/client.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import { addDays } from '../utils/time.js';

const router = createRouter();

const VERB_TONE = {
  uploaded: 'brand', verified: 'success', approved: 'success', resolved: 'success',
  paid: 'success', created: 'brand', assigned: 'brand', signed_off: 'success',
  rejected: 'danger', deleted: 'danger', failed: 'danger',
  raised_query: 'warning', replied: 'warning', reopened: 'warning', noted: 'warning',
};

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const { page, pageSize } = ctx.pagination({ defaultSize: 50, maxSize: 200 });

  const where = scope.where('activities', 'a');
  where.eqIf('a.client_id', ctx.q('clientId'));
  where.eqIf('a.entity_type', ctx.q('entityType'));
  where.eqIf('a.verb', ctx.q('verb'));
  where.eqIf('a.actor_id', ctx.q('actorId'));
  where.betweenIf('a.created_at', ctx.q('from'), ctx.q('to'));
  where.searchIf(['a.summary'], ctx.q('q'));

  // A client sees their own record, and only what was marked for them.
  if (ctx.isClient) {
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) {
      return paginated([], { page, pageSize, total: 0, verbs: [], note: 'Your account is not linked to a client record yet.' }, ctx);
    }
    where.inIf('a.client_id', ids);
    where.inIf('a.visibility', ['client', 'public']);
  } else if (!ctx.has('clients.view') && ctx.has('clients.view.assigned')) {
    // An executive sees the clients assigned to them, and nothing wider.
    where.add(`a.client_id IN (
      SELECT id FROM clients WHERE tenant_id = ?
        AND (assigned_executive_id = ? OR assigned_manager_id = ?))`,
      ctx.tenantId, ctx.userId, ctx.userId);
  }

  const { rows, total } = await scope.paginate('activities', where, {
    columns: 'a.*, c.display_name AS client_name, c.client_code',
    joins: 'LEFT JOIN clients c ON c.id = a.client_id',
    alias: 'a',
    orderBy: 'a.created_at DESC',
    page, pageSize,
  });

  // The verbs actually present, so the filter offers only what exists.
  const verbs = await scope.raw(
    `SELECT verb, COUNT(*) AS n FROM activities
      WHERE tenant_id = ? AND created_at >= ?
      GROUP BY verb ORDER BY n DESC`, [ctx.tenantId, addDays(-90)]);

  return paginated(rows.map(toActivity), {
    page, pageSize, total,
    verbs: verbs.map(v => ({ verb: v.verb, count: Number(v.n) })),
  }, ctx);
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

function toActivity(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    verb: row.verb,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
    detail: safeJson(row.detail_json, null),
    visibility: row.visibility,
    icon: row.icon,
    tone: VERB_TONE[row.verb] ?? 'brand',
    // Where this entry points, so a feed row is a link rather than a dead end.
    path: pathFor(row),
    createdAt: row.created_at,
  };
}

function pathFor(row) {
  if (!row.entity_id) return null;
  return {
    document: `/documents/${row.entity_id}`,
    query: `/queries/${row.entity_id}`,
    report: `/reports/${row.entity_id}`,
    client: `/clients/${row.entity_id}`,
    invoice: `/billing/invoices/${row.entity_id}`,
    call: `/calls/${row.entity_id}`,
    task: '/tasks',
  }[row.entity_type] ?? null;
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as activityRouter };
