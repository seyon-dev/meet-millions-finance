/**
 * The query workflow.
 *
 *   Executive raises a query → client is notified → client opens it →
 *   client replies and re-uploads the corrected document → executive reviews →
 *   query resolved.
 *
 * Both sides post on the same thread. Internal notes are visible only to the
 * firm; everything else the client can read. Attachments on a reply are real
 * document versions, not loose files, so a correction stays traceable.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, secondsBetween } from '../utils/time.js';
import { audit, recordActivity } from '../services/audit.js';
import { refreshFilingPeriod } from '../services/workflow.js';
import { dispatchNotification } from '../services/notifications.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import { createQueryForDocument } from './verification.js';

const router = createRouter();
const SORTABLE = ['created_at', 'updated_at', 'priority', 'status', 'reference_no'];

const OPEN_STATUSES = ['open', 'awaiting_client', 'client_responded', 'under_review'];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('queries', 'q');
  await applyQueryVisibility(ctx, where);

  const statusFilter = ctx.qList('status');
  if (statusFilter.length) where.inIf('q.status', statusFilter);
  else if (ctx.qBool('openOnly', false)) where.inIf('q.status', OPEN_STATUSES);
  else where.eqIf('q.status', ctx.q('status'));

  where.eqIf('q.client_id', ctx.q('clientId'));
  where.eqIf('q.document_id', ctx.q('documentId'));
  where.eqIf('q.filing_period_id', ctx.q('periodId'));
  where.eqIf('q.priority', ctx.q('priority'));
  where.eqIf('q.assigned_to', ctx.q('assignedTo'));
  where.searchIf(['q.subject', 'q.body', 'q.reference_no'], ctx.q('q'));
  where.betweenIf('q.created_at', ctx.q('from'), ctx.q('to'));

  const orderBy = `q.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), SORTABLE, 'created_at')}`;
  const joins = `
    JOIN clients c ON c.id = q.client_id
    LEFT JOIN documents d ON d.id = q.document_id
    LEFT JOIN users u ON u.id = q.raised_by`;

  const { rows, total } = await scope.paginate('queries', where, {
    columns: `q.*, c.display_name AS client_name, c.client_code,
              d.title AS document_title, u.full_name AS raised_by_name`,
    joins, alias: 'q', orderBy, page, pageSize,
  });

  const counts = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM queries WHERE tenant_id = ? GROUP BY status`, [ctx.tenantId]);
  const byStatus = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));

  return paginated(rows.map(toQuery), {
    page, pageSize, total,
    summary: {
      open: byStatus.open ?? 0,
      awaitingClient: byStatus.awaiting_client ?? 0,
      clientResponded: byStatus.client_responded ?? 0,
      underReview: byStatus.under_review ?? 0,
      resolved: byStatus.resolved ?? 0,
      cancelled: byStatus.cancelled ?? 0,
    },
  }, ctx);
}, { anyPermission: ['queries.view', 'queries.view.own'] });

// ---------------------------------------------------------------------------
// Read one — the thread
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const query = await getVisibleQuery(ctx, scope, ctx.params.id);

  const visibilityClause = ctx.isClient ? "AND r.visibility = 'shared'" : '';
  const replies = await scope.raw(
    `SELECT r.*, u.full_name AS author_name, u.avatar_key AS author_avatar
       FROM query_replies r
       LEFT JOIN users u ON u.id = r.author_id
      WHERE r.tenant_id = ? AND r.query_id = ? ${visibilityClause}
      ORDER BY r.created_at ASC`, [ctx.tenantId, query.id]);

  const client = await scope.first('clients', { id: query.client_id },
    'id, display_name, client_code, primary_contact_name, primary_contact_email');
  const document = query.document_id
    ? await scope.first('documents', { id: query.document_id })
    : null;
  const period = query.filing_period_id
    ? await scope.first('filing_periods', { id: query.filing_period_id })
    : null;

  return ok({
    query: toQuery(query),
    replies: replies.map(r => ({ ...r, attachments: safeJson(r.attachments_json, []) })),
    client,
    document,
    period,
    permissions: {
      canReply: ctx.has('queries.reply'),
      canResolve: ctx.has('queries.resolve'),
      canAddInternalNote: ctx.has('documents.note.internal'),
      canUploadCorrection: ctx.has('documents.replace') && !!query.document_id,
    },
  }, { ctx });
}, { anyPermission: ['queries.view', 'queries.view.own'] });

// ---------------------------------------------------------------------------
// Raise a query (outside the verification screen)
// ---------------------------------------------------------------------------
router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    clientId: { type: 'id', required: true },
    documentId: { type: 'id' },
    filingPeriodId: { type: 'id' },
    subject: { type: 'string', required: true, min: 3, max: 200 },
    body: { type: 'text', required: true, min: 3, max: 4000 },
    category: { type: 'enum', values: ['document', 'data', 'clarification', 'missing', 'mismatch', 'other'], default: 'clarification' },
    priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    dueAt: { type: 'date' },
  });

  const client = await scope.getOrFail('clients', input.clientId, { resource: 'Client' });
  const document = input.documentId
    ? await scope.first('documents', { id: input.documentId, client_id: client.id })
    : null;
  if (input.documentId && !document) throw new NotFoundError('Document');

  const query = await createQueryForDocument(ctx, scope, {
    document,
    client,
    subject: input.subject,
    body: input.body,
    priority: input.priority,
    category: input.category,
    filingPeriodId: input.filingPeriodId,
  });

  if (input.dueAt) await scope.update('queries', query.id, { due_at: input.dueAt });

  // A query against a document moves that document out of "verified".
  if (document && !['query_raised', 'awaiting_client'].includes(document.status)) {
    await scope.update('documents', document.id, { status: 'query_raised' });
    if (document.filing_period_id) await refreshFilingPeriod(scope, document.filing_period_id);
  }

  await recordActivity(ctx, {
    clientId: client.id, companyId: client.company_id,
    verb: 'raised_query', entityType: 'query', entityId: query.id,
    summary: `${ctx.user.full_name} raised query ${query.reference_no}: ${input.subject}`,
    visibility: 'client', icon: 'help-circle',
  });

  await notifyClientOfQuery(ctx, scope, query, client, input.body);

  return created({ query: toQuery(query) }, { ctx });
}, { permission: 'queries.create' });

// ---------------------------------------------------------------------------
// Reply — both sides use this
// ---------------------------------------------------------------------------
router.post('/:id/replies', async (ctx) => {
  const scope = scopeFor(ctx);
  const query = await getVisibleQuery(ctx, scope, ctx.params.id);

  if (['resolved', 'cancelled'].includes(query.status)) {
    throw new BadRequestError('This query is closed. Raise a new one if something else needs attention.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    body: { type: 'text', required: true, min: 1, max: 4000 },
    visibility: { type: 'enum', values: ['shared', 'internal'], default: 'shared' },
    attachments: { type: 'array', max: 10, of: { type: 'json' } },
    resolve: { type: 'boolean', default: false },
  });

  if (input.visibility === 'internal' && !ctx.has('documents.note.internal')) {
    throw new ForbiddenError('You do not have permission to add internal notes.');
  }

  const isClientAuthor = ctx.isClient;

  const reply = await scope.insert('query_replies', {
    id: ID.reply(),
    query_id: query.id,
    author_id: ctx.userId,
    author_role: ctx.roleKeys[0],
    body: input.body,
    visibility: input.visibility,
    attachments_json: input.attachments?.length ? JSON.stringify(input.attachments) : null,
    channel: 'portal',
  });

  // An internal note does not change the query's state — it is a side note.
  const patch = { reply_count: (query.reply_count ?? 0) + 1 };
  if (input.visibility === 'shared') {
    if (isClientAuthor) {
      patch.status = 'client_responded';
      if (!query.first_response_at) patch.first_response_at = nowIso();
    } else if (query.status === 'client_responded') {
      patch.status = 'under_review';
    } else if (query.status === 'open') {
      patch.status = 'awaiting_client';
    }
  }

  if (input.resolve && ctx.has('queries.resolve')) {
    patch.status = 'resolved';
    patch.resolved_by = ctx.userId;
    patch.resolved_at = nowIso();
    patch.resolution_note = input.body;
  }

  await scope.update('queries', query.id, patch);

  await audit(ctx, {
    action: 'queries.replied', category: 'queries',
    entityType: 'query', entityId: query.id, entityLabel: query.reference_no,
    newValue: { visibility: input.visibility, resolved: !!patch.resolved_at },
  });

  if (input.visibility === 'shared') {
    await recordActivity(ctx, {
      clientId: query.client_id, verb: 'replied', entityType: 'query', entityId: query.id,
      summary: `${ctx.user.full_name} replied to ${query.reference_no}`,
      visibility: 'client', icon: 'message-circle',
    });

    const client = await scope.first('clients', { id: query.client_id });
    if (isClientAuthor) {
      // Tell the firm their client has answered.
      const staff = [query.raised_by, query.assigned_to, client?.assigned_executive_id].filter(Boolean);
      ctx.defer(dispatchNotification(ctx, {
        triggerKey: 'query.client_replied',
        userIds: [...new Set(staff)],
        clientId: query.client_id,
        entityType: 'query', entityId: query.id,
        variables: {
          clientName: client?.display_name ?? '',
          reference: query.reference_no,
          subject: query.subject,
          body: input.body.slice(0, 500),
          link: `${ctx.env.APP_URL || ''}/queries/${query.id}`,
        },
        link: { path: `/queries/${query.id}` },
      }));
    } else {
      await notifyClientOfQuery(ctx, scope, { ...query, ...patch }, client, input.body,
        patch.status === 'resolved' ? 'query.resolved' : 'query.raised');
    }
  }

  const updated = await scope.first('queries', { id: query.id });
  return created({ reply, query: toQuery(updated) }, { ctx });
}, { permission: 'queries.reply' });

// ---------------------------------------------------------------------------
// Resolve / reopen
// ---------------------------------------------------------------------------
router.post('/:id/resolve', async (ctx) => {
  const scope = scopeFor(ctx);
  const query = await scope.getOrFail('queries', ctx.params.id, { resource: 'Query' });

  const body = await ctx.body();
  const input = validate(body, {
    resolutionNote: { type: 'text', max: 2000 },
    releaseDocument: { type: 'boolean', default: true },
  });

  if (query.status === 'resolved') {
    return ok({ query: toQuery(query), alreadyResolved: true }, { ctx });
  }

  await scope.update('queries', query.id, {
    status: 'resolved',
    resolved_by: ctx.userId,
    resolved_at: nowIso(),
    resolution_note: input.resolutionNote,
  });

  // With the query closed, the document goes back into the review queue.
  if (input.releaseDocument && query.document_id) {
    const document = await scope.first('documents', { id: query.document_id });
    if (document && ['query_raised', 'awaiting_client'].includes(document.status)) {
      await scope.update('documents', document.id, { status: 'under_review' });
      if (document.filing_period_id) await refreshFilingPeriod(scope, document.filing_period_id);
    }
  }
  if (query.filing_period_id) await refreshFilingPeriod(scope, query.filing_period_id);

  const resolutionSeconds = secondsBetween(query.created_at, nowIso());

  await audit(ctx, {
    action: 'queries.resolved', category: 'queries',
    entityType: 'query', entityId: query.id, entityLabel: query.reference_no,
    oldValue: { status: query.status },
    newValue: { status: 'resolved', resolutionSeconds },
  });

  await recordActivity(ctx, {
    clientId: query.client_id, verb: 'resolved', entityType: 'query', entityId: query.id,
    summary: `${ctx.user.full_name} resolved query ${query.reference_no}`,
    visibility: 'client', icon: 'check-circle',
  });

  const client = await scope.first('clients', { id: query.client_id });
  await notifyClientOfQuery(ctx, scope, query, client,
    input.resolutionNote ?? 'This query has been resolved.', 'query.resolved');

  const updated = await scope.first('queries', { id: query.id });
  return ok({ query: toQuery(updated), resolutionSeconds }, { ctx });
}, { permission: 'queries.resolve' });

router.post('/:id/reopen', async (ctx) => {
  const scope = scopeFor(ctx);
  const query = await scope.getOrFail('queries', ctx.params.id, { resource: 'Query' });
  if (query.status !== 'resolved') throw new BadRequestError('Only a resolved query can be reopened.');

  await scope.update('queries', query.id, {
    status: 'under_review', resolved_by: null, resolved_at: null, resolution_note: null,
  });

  await audit(ctx, {
    action: 'queries.created', category: 'queries', severity: 'notice',
    entityType: 'query', entityId: query.id, entityLabel: query.reference_no,
    oldValue: { status: 'resolved' }, newValue: { status: 'under_review', reopened: true },
  });

  const updated = await scope.first('queries', { id: query.id });
  return ok({ query: toQuery(updated) }, { ctx });
}, { permission: 'queries.resolve' });

// ---------------------------------------------------------------------------

async function notifyClientOfQuery(ctx, scope, query, client, body, triggerKey = 'query.raised') {
  const contacts = await scope.raw(
    `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
      WHERE cc.client_id = ? AND u.status = 'active'`, [query.client_id]);

  return ctx.defer(dispatchNotification(ctx, {
    triggerKey,
    userIds: contacts.map(c => c.id),
    toEmail: contacts.length ? null : client?.primary_contact_email,
    toPhone: contacts.length ? null : client?.primary_contact_phone,
    clientId: query.client_id,
    entityType: 'query',
    entityId: query.id,
    variables: {
      clientName: client?.display_name ?? '',
      executiveName: ctx.user?.full_name ?? '',
      reference: query.reference_no,
      subject: query.subject,
      body: String(body).slice(0, 800),
      period: query.filing_period_id ? '' : '',
      link: `${ctx.env.APP_URL || ''}/client/queries/${query.id}`,
    },
    link: { path: `/client/queries/${query.id}` },
  }));
}

async function applyQueryVisibility(ctx, where) {
  if (ctx.has('queries.view')) return true;
  if (ctx.has('queries.view.own') || ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) { where.add('1 = 0'); return false; }
    where.inIf('q.client_id', ids);
    return true;
  }
  throw new ForbiddenError('You do not have permission to view queries.');
}

async function getVisibleQuery(ctx, scope, queryId) {
  const query = await scope.first('queries', { id: queryId });
  if (!query) throw new NotFoundError('Query');

  if (!ctx.has('queries.view')) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.includes(query.client_id)) throw new NotFoundError('Query');
  }
  return query;
}

function toQuery(row) {
  return {
    id: row.id,
    referenceNo: row.reference_no,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    documentId: row.document_id,
    documentTitle: row.document_title ?? null,
    filingPeriodId: row.filing_period_id,
    subject: row.subject,
    body: row.body,
    category: row.category,
    priority: row.priority,
    status: row.status,
    raisedBy: row.raised_by,
    raisedByName: row.raised_by_name ?? null,
    assignedTo: row.assigned_to,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    dueAt: row.due_at,
    firstResponseAt: row.first_response_at,
    replyCount: row.reply_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isOpen: OPEN_STATUSES.includes(row.status),
  };
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as queriesRouter, toQuery, OPEN_STATUSES };
