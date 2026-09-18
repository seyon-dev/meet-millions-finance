/**
 * The verification workspace.
 *
 * This is the Finance Executive's core screen: a filterable queue, a document
 * viewer, and four decisions — approve, reject, request changes, raise query.
 * Every decision writes an immutable verification record, moves the document
 * through a checked state transition, refreshes the filing period, notifies
 * the client and lands in the audit trail. There is no visual-only action here.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID, formatReference } from '../utils/id.js';
import { nowIso, secondsBetween, dayKey } from '../utils/time.js';
import { audit, recordActivity } from '../services/audit.js';
import { hasFeature } from '../services/features.js';
import {
  assertDocumentTransition, refreshFilingPeriod, syncChecklistForDocument,
} from '../services/workflow.js';
import { dispatchNotification } from '../services/notifications.js';
import { queueCloudSync } from '../services/cloud-sync.js';
import { toDocument, withRelated, getVisibleDocument } from './documents.js';

const router = createRouter();

/** Queue statuses the workspace groups by, in the order the PDF shows them. */
export const QUEUE_TABS = [
  { key: 'pending', label: 'Pending Review', statuses: ['submitted'] },
  { key: 'in_review', label: 'Under Review', statuses: ['under_review'] },
  { key: 'query_raised', label: 'Query Raised', statuses: ['query_raised', 'awaiting_client'] },
  { key: 'verified', label: 'Verified', statuses: ['verified', 'approved'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
];

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------
router.get('/queue', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const tabKey = ctx.q('tab', 'pending');
  const tab = QUEUE_TABS.find(t => t.key === tabKey);

  const where = scope.where('documents', 'd');
  where.add('d.deleted_at IS NULL');

  if (ctx.q('status')) where.eqIf('d.status', ctx.q('status'));
  else if (tab) where.inIf('d.status', tab.statuses);

  // An executive without the broad client permission sees only their own queue.
  if (!ctx.has('clients.view') && ctx.has('clients.view.assigned')) {
    where.add('(d.assigned_to = ? OR c.assigned_executive_id = ?)', ctx.userId, ctx.userId);
  }

  where.eqIf('d.client_id', ctx.q('clientId'));
  where.eqIf('d.assigned_to', ctx.q('assignedTo'));
  where.eqIf('d.document_type_id', ctx.q('typeId'));
  where.eqIf('d.priority', ctx.q('priority'));
  where.eqIf('d.period_key', ctx.q('periodKey'));
  where.searchIf(['d.title', 'c.display_name', 'c.client_code'], ctx.q('q'));
  where.betweenIf('d.created_at', ctx.q('from'), ctx.q('to'));
  if (ctx.qBool('slaBreached')) where.add("d.sla_due_at < ?", nowIso());
  if (ctx.qBool('flagged')) where.add("d.ai_precheck_status = 'flagged'");

  const sortable = ['created_at', 'sla_due_at', 'priority', 'title', 'status'];
  const orderBy = ctx.q('sort') === 'priority'
    ? `CASE d.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC, d.sla_due_at ASC`
    : `d.${safeOrder(ctx.q('sort', 'sla_due_at'), ctx.q('dir', 'asc'), sortable, 'sla_due_at')}`;

  const joins = `
    JOIN clients c ON c.id = d.client_id
    JOIN document_types dt ON dt.id = d.document_type_id
    LEFT JOIN users u ON u.id = d.assigned_to`;

  const { rows, total } = await scope.paginate('documents', where, {
    columns: `d.*, c.display_name AS client_name, c.client_code, c.sla_hours,
              dt.name AS type_name, dt.category AS type_category, dt.key AS type_key,
              u.full_name AS assignee_name`,
    joins, alias: 'd', orderBy, page, pageSize,
  });

  // Tab counts, in one query rather than five.
  const countRows = await scope.raw(
    `SELECT d.status, COUNT(*) AS n FROM documents d
       JOIN clients c ON c.id = d.client_id
      WHERE d.tenant_id = ? AND d.deleted_at IS NULL
        ${!ctx.has('clients.view') && ctx.has('clients.view.assigned')
          ? 'AND (d.assigned_to = ? OR c.assigned_executive_id = ?)' : ''}
      GROUP BY d.status`,
    !ctx.has('clients.view') && ctx.has('clients.view.assigned')
      ? [ctx.tenantId, ctx.userId, ctx.userId] : [ctx.tenantId]);

  const byStatus = Object.fromEntries(countRows.map(r => [r.status, Number(r.n)]));
  const tabs = QUEUE_TABS.map(t => ({
    ...t,
    count: t.statuses.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0),
  }));

  return paginated(rows.map(r => ({
    ...toDocument(r),
    assigneeName: r.assignee_name,
    slaHours: r.sla_hours,
    slaBreached: !!r.sla_due_at && r.sla_due_at < nowIso() && ['submitted', 'under_review'].includes(r.status),
  })), { page, pageSize, total, tabs, activeTab: tabKey }, ctx);
}, { permission: 'documents.verify' });

/** Queue summary tiles — the Finance Team dashboard's four metrics. */
router.get('/stats', async (ctx) => {
  const scope = scopeFor(ctx);
  const mine = !ctx.has('clients.view') && ctx.has('clients.view.assigned');
  const scopeClause = mine ? 'AND (d.assigned_to = ?2 OR c.assigned_executive_id = ?2)' : '';
  const params = mine ? [ctx.tenantId, ctx.userId] : [ctx.tenantId];
  const today = dayKey();

  const row = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM documents d JOIN clients c ON c.id = d.client_id
         WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL AND d.status = 'submitted' ${scopeClause}) AS pending_review,
       (SELECT COUNT(*) FROM documents d JOIN clients c ON c.id = d.client_id
         WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL AND d.status = 'under_review' ${scopeClause}) AS under_review,
       (SELECT COUNT(*) FROM queries q
         WHERE q.tenant_id = ?1 AND q.status IN ('open','awaiting_client','client_responded','under_review')) AS queries_raised,
       (SELECT COUNT(*) FROM documents d JOIN clients c ON c.id = d.client_id
         WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL AND d.status IN ('verified','approved')
           AND substr(d.verified_at, 1, 10) = ?${mine ? '3' : '2'} ${scopeClause}) AS verified_today,
       (SELECT COUNT(*) FROM documents d JOIN clients c ON c.id = d.client_id
         WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL
           AND d.sla_due_at < ?${mine ? '4' : '3'} AND d.status IN ('submitted','under_review') ${scopeClause}) AS sla_breached,
       (SELECT COUNT(DISTINCT c.id) FROM clients c
         WHERE c.tenant_id = ?1 AND c.deleted_at IS NULL AND c.status = 'active'
           ${mine ? 'AND c.assigned_executive_id = ?2' : ''}) AS clients_assigned`,
    mine ? [ctx.tenantId, ctx.userId, today, nowIso()] : [ctx.tenantId, today, nowIso()]);

  // SLA compliance over the last 30 days, from the recorded decisions.
  const sla = await scope.rawOne(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN sla_met = 1 THEN 1 ELSE 0 END) AS met
       FROM verification_records
      WHERE tenant_id = ? AND created_at >= date('now','-30 days')
        AND decision IN ('approved','rejected')`, [ctx.tenantId]);

  const total = Number(sla?.total) || 0;
  const met = Number(sla?.met) || 0;

  const queryStatus = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM queries WHERE tenant_id = ? GROUP BY status`, [ctx.tenantId]);

  return ok({
    pendingReview: Number(row?.pending_review) || 0,
    underReview: Number(row?.under_review) || 0,
    queriesRaised: Number(row?.queries_raised) || 0,
    verifiedToday: Number(row?.verified_today) || 0,
    slaBreached: Number(row?.sla_breached) || 0,
    clientsAssigned: Number(row?.clients_assigned) || 0,
    slaCompliancePct: total ? Math.round((met / total) * 100) : null,
    slaSampleSize: total,
    queryStatus: Object.fromEntries(queryStatus.map(q => [q.status, Number(q.n)])),
  }, { ctx });
}, { permission: 'documents.verify' });

// ---------------------------------------------------------------------------
// Open a document for review — claims it into "under review"
// ---------------------------------------------------------------------------
router.post('/:id/open', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await scope.getOrFail('documents', ctx.params.id, { resource: 'Document' });

  if (document.status === 'submitted') {
    await scope.update('documents', document.id, {
      status: 'under_review',
      assigned_to: document.assigned_to ?? ctx.userId,
    });
    if (document.filing_period_id) await refreshFilingPeriod(scope, document.filing_period_id);
  }

  const updated = await scope.first('documents', { id: document.id });
  return ok({ document: toDocument(updated), openedAt: nowIso() }, { ctx });
}, { permission: 'documents.verify' });

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
router.post('/:id/decision', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const document = await scope.getOrFail('documents', ctx.params.id, { resource: 'Document' });

  if (document.is_locked) {
    throw new ForbiddenError('This document is locked. Unlock it before recording a new decision.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    decision: { type: 'enum', required: true, values: ['approve', 'reject', 'request_changes', 'raise_query'] },
    notes: { type: 'text', max: 4000 },
    reasonCode: { type: 'string', max: 60 },
    checklist: { type: 'json' },
    timeSpentSeconds: { type: 'int', min: 0, max: 86400 },
    lockOnApprove: { type: 'boolean', default: true },
    // Only used when decision = raise_query
    querySubject: { type: 'string', max: 200 },
    queryBody: { type: 'text', max: 4000 },
    queryPriority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    queryCategory: { type: 'enum', values: ['document', 'data', 'clarification', 'missing', 'mismatch', 'other'], default: 'document' },
  });

  const client = await scope.first('clients', { id: document.client_id });
  const targetStatus = {
    approve: 'verified',
    reject: 'rejected',
    request_changes: 'awaiting_client',
    raise_query: 'query_raised',
  }[input.decision];

  assertDocumentTransition(document.status, targetStatus);

  if (input.decision === 'reject' && !input.notes) {
    throw new BadRequestError('Tell the client why the document was rejected — a reason is required.');
  }
  if (input.decision === 'raise_query' && !input.queryBody) {
    throw new BadRequestError('Describe what you need from the client before raising the query.');
  }

  // Was the decision within the SLA the client is on?
  const slaMet = document.sla_due_at ? (nowIso() <= document.sla_due_at ? 1 : 0) : null;

  const decisionMap = {
    approve: 'approved', reject: 'rejected',
    request_changes: 'changes_requested', raise_query: 'query_raised',
  };

  const record = await scope.insert('verification_records', {
    id: ID.verification(),
    document_id: document.id,
    version_id: document.current_version_id,
    verifier_id: ctx.userId,
    decision: decisionMap[input.decision],
    reason_code: input.reasonCode,
    notes: input.notes,
    checklist_json: input.checklist ? JSON.stringify(input.checklist) : null,
    time_spent_seconds: input.timeSpentSeconds ?? null,
    sla_met: slaMet,
  });

  const patch = {
    status: targetStatus,
    verified_by: input.decision === 'approve' ? ctx.userId : null,
    verified_at: input.decision === 'approve' ? nowIso() : null,
    rejected_reason: input.decision === 'reject' ? input.notes : null,
  };
  if (input.decision === 'approve' && input.lockOnApprove && ctx.has('documents.lock')) {
    patch.is_locked = 1;
    patch.locked_by = ctx.userId;
    patch.locked_at = nowIso();
  }
  await scope.update('documents', document.id, patch);

  const updated = await scope.first('documents', { id: document.id });
  await syncChecklistForDocument(scope, updated);

  // Raising a query creates the thread the client replies on.
  let query = null;
  if (input.decision === 'raise_query') {
    query = await createQueryForDocument(ctx, scope, {
      document: updated,
      client,
      subject: input.querySubject || `Query on ${document.title}`,
      body: input.queryBody,
      priority: input.queryPriority,
      category: input.queryCategory,
    });
  }

  if (updated.filing_period_id) await refreshFilingPeriod(scope, updated.filing_period_id);

  // Mirror a verified document into connected cloud storage, if configured.
  if (input.decision === 'approve') {
    ctx.defer(queueCloudSync(ctx, scope, updated, { trigger: 'verified' }).catch(() => {}));
  }

  const auditAction = {
    approve: 'verification.approved',
    reject: 'verification.rejected',
    request_changes: 'verification.changes_requested',
    raise_query: 'verification.query_raised',
  }[input.decision];

  await audit(ctx, {
    action: auditAction, category: 'verification',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { status: document.status },
    newValue: { status: targetStatus, notes: input.notes ?? null, reasonCode: input.reasonCode ?? null },
    severity: input.decision === 'reject' ? 'notice' : 'info',
  });

  await recordActivity(ctx, {
    clientId: document.client_id, companyId: document.company_id,
    verb: decisionMap[input.decision], entityType: 'document', entityId: document.id,
    summary: `${ctx.user.full_name} ${humanDecision(input.decision)} ${document.title}`,
    detail: input.notes ? { notes: input.notes } : null,
    visibility: 'client',
    icon: input.decision === 'approve' ? 'check-circle' : input.decision === 'reject' ? 'x-circle' : 'help-circle',
  });

  // Notify the client on every decision that needs them to know or act.
  const contacts = await scope.raw(
    `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
      WHERE cc.client_id = ? AND u.status = 'active'`, [document.client_id]);

  const triggerKey = {
    approve: 'document.verified',
    reject: 'document.rejected',
    request_changes: 'document.changes_requested',
    raise_query: 'query.raised',
  }[input.decision];

  ctx.defer(dispatchNotification(ctx, {
    triggerKey,
    userIds: contacts.map(c => c.id),
    toEmail: contacts.length ? null : client?.primary_contact_email,
    toPhone: contacts.length ? null : client?.primary_contact_phone,
    clientId: document.client_id,
    entityType: 'document',
    entityId: document.id,
    variables: {
      clientName: client?.display_name ?? '',
      documentTitle: document.title,
      period: document.period_key ?? '',
      executiveName: ctx.user.full_name,
      reason: input.notes ?? '',
      filingStatus: updated.status,
      reference: query?.reference_no ?? '',
      subject: query?.subject ?? document.title,
      body: input.queryBody ?? input.notes ?? '',
      link: `${ctx.env.APP_URL || ''}/client/filings`,
    },
    link: { path: query ? `/client/queries/${query.id}` : '/client/filings' },
  }));

  return ok({
    document: toDocument(updated),
    record,
    query,
    slaMet: slaMet === null ? null : !!slaMet,
  }, { ctx });
}, { permission: 'documents.verify' });

/** Shared by the decision route and the queries module. */
export async function createQueryForDocument(ctx, scope, {
  document, client, subject, body, priority = 'normal', category = 'document', filingPeriodId = null,
}) {
  const year = new Date().getUTCFullYear();
  const count = await scope.rawCount(
    `SELECT COUNT(*) FROM queries WHERE tenant_id = ? AND reference_no LIKE ?`,
    [scope.tenantId, `QRY-${year}-%`]);
  const referenceNo = formatReference('QRY', year, count + 1);

  const query = await scope.insert('queries', {
    id: ID.query(),
    company_id: document?.company_id ?? client.company_id,
    client_id: client.id,
    document_id: document?.id ?? null,
    filing_period_id: filingPeriodId ?? document?.filing_period_id ?? null,
    reference_no: referenceNo,
    subject,
    body,
    category,
    priority,
    status: 'awaiting_client',
    raised_by: ctx.userId,
    assigned_to: ctx.userId,
    due_at: null,
    reply_count: 0,
  });

  await scope.insert('query_replies', {
    id: ID.reply(),
    query_id: query.id,
    author_id: ctx.userId,
    author_role: ctx.roleKeys?.[0] ?? null,
    body,
    visibility: 'shared',
    channel: 'portal',
  });

  await audit(ctx, {
    action: 'queries.created', category: 'queries',
    entityType: 'query', entityId: query.id, entityLabel: referenceNo,
    newValue: { subject, priority, category, documentId: document?.id ?? null },
  });

  return query;
}

// ---------------------------------------------------------------------------
// Bulk decisions — the queue's bulk action bar
// ---------------------------------------------------------------------------
router.post('/bulk', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    documentIds: { type: 'array', required: true, max: 100, of: { type: 'id' } },
    decision: { type: 'enum', required: true, values: ['approve', 'reject', 'assign', 'priority'] },
    notes: { type: 'text', max: 2000 },
    assignTo: { type: 'id' },
    priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'] },
  });

  if (input.decision === 'reject' && !input.notes) {
    throw new BadRequestError('Give a reason when rejecting documents in bulk.');
  }

  const results = { updated: [], skipped: [] };

  for (const id of input.documentIds) {
    const document = await scope.first('documents', { id });
    if (!document || document.deleted_at) { results.skipped.push({ id, reason: 'Not found.' }); continue; }
    if (document.is_locked) { results.skipped.push({ id, reason: 'Document is locked.' }); continue; }

    try {
      if (input.decision === 'assign') {
        await scope.update('documents', id, { assigned_to: input.assignTo });
        results.updated.push(id);
        continue;
      }
      if (input.decision === 'priority') {
        await scope.update('documents', id, { priority: input.priority ?? 'normal' });
        results.updated.push(id);
        continue;
      }

      const target = input.decision === 'approve' ? 'verified' : 'rejected';
      assertDocumentTransition(document.status, target);

      await scope.insert('verification_records', {
        id: ID.verification(),
        document_id: id,
        version_id: document.current_version_id,
        verifier_id: ctx.userId,
        decision: input.decision === 'approve' ? 'approved' : 'rejected',
        notes: input.notes,
        sla_met: document.sla_due_at ? (nowIso() <= document.sla_due_at ? 1 : 0) : null,
      });

      await scope.update('documents', id, {
        status: target,
        verified_by: input.decision === 'approve' ? ctx.userId : null,
        verified_at: input.decision === 'approve' ? nowIso() : null,
        rejected_reason: input.decision === 'reject' ? input.notes : null,
      });

      const updated = await scope.first('documents', { id });
      await syncChecklistForDocument(scope, updated);
      if (updated.filing_period_id) await refreshFilingPeriod(scope, updated.filing_period_id);
      results.updated.push(id);
    } catch (err) {
      results.skipped.push({ id, reason: err.expose ? err.message : 'Could not apply that decision.' });
    }
  }

  await audit(ctx, {
    action: input.decision === 'approve' ? 'verification.approved' : 'verification.rejected',
    category: 'verification',
    entityType: 'document', entityId: null,
    entityLabel: `Bulk: ${results.updated.length} documents`,
    newValue: { decision: input.decision, count: results.updated.length, skipped: results.skipped.length },
  });

  return ok({
    ...results,
    summary: { updated: results.updated.length, skipped: results.skipped.length },
  }, { ctx });
}, { permission: 'documents.verify' });

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------
router.post('/:id/assign', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await scope.getOrFail('documents', ctx.params.id, { resource: 'Document' });
  const body = await ctx.body();
  const input = validate(body, {
    assignTo: { type: 'id', required: true },
    priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'] },
  });

  const assignee = await scope.first('users', { id: input.assignTo }, 'id, full_name, status');
  if (!assignee) throw new NotFoundError('User');

  await scope.update('documents', document.id, {
    assigned_to: input.assignTo,
    ...(input.priority ? { priority: input.priority } : {}),
  });

  await audit(ctx, {
    action: 'documents.assigned', category: 'documents',
    entityType: 'document', entityId: document.id, entityLabel: document.title,
    oldValue: { assignedTo: document.assigned_to },
    newValue: { assignedTo: input.assignTo, assigneeName: assignee.full_name },
  });

  ctx.defer(dispatchNotification(ctx, {
    triggerKey: 'task.assigned',
    userId: input.assignTo,
    clientId: document.client_id,
    entityType: 'document', entityId: document.id,
    variables: { taskTitle: `Verify ${document.title}` },
    link: { path: `/verification/${document.id}` },
  }));

  const updated = await scope.first('documents', { id: document.id });
  return ok({ document: toDocument(updated) }, { ctx });
}, { permission: 'documents.assign' });

// ---------------------------------------------------------------------------
// The document under review, with everything the rail needs
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const document = await getVisibleDocument(ctx, scope, ctx.params.id);

  const [client, type, version, history, comments, queries, aiCheck, ocr] = await Promise.all([
    scope.first('clients', { id: document.client_id }),
    scope.rawOne('SELECT * FROM document_types WHERE id = ?', [document.document_type_id]),
    scope.first('document_versions', { id: document.current_version_id }),
    scope.raw(
      `SELECT vr.*, u.full_name AS verifier_name FROM verification_records vr
         LEFT JOIN users u ON u.id = vr.verifier_id
        WHERE vr.tenant_id = ? AND vr.document_id = ? ORDER BY vr.created_at DESC`,
      [ctx.tenantId, document.id]),
    scope.raw(
      `SELECT dc.*, u.full_name AS author_name FROM document_comments dc
         LEFT JOIN users u ON u.id = dc.author_id
        WHERE dc.tenant_id = ? AND dc.document_id = ? AND dc.deleted_at IS NULL
        ORDER BY dc.created_at ASC`, [ctx.tenantId, document.id]),
    scope.all('queries', { document_id: document.id }, { order: 'created_at DESC' }),
    scope.rawOne(
      `SELECT * FROM ai_verifications WHERE tenant_id = ? AND document_id = ?
        ORDER BY created_at DESC LIMIT 1`, [ctx.tenantId, document.id]),
    scope.rawOne(
      `SELECT * FROM ocr_extractions WHERE tenant_id = ? AND document_id = ?
        ORDER BY created_at DESC LIMIT 1`, [ctx.tenantId, document.id]),
  ]);

  const siblings = await scope.raw(
    `SELECT d.id, d.title, d.status FROM documents d
      WHERE d.tenant_id = ? AND d.filing_period_id = ? AND d.deleted_at IS NULL
      ORDER BY d.created_at ASC`, [ctx.tenantId, document.filing_period_id ?? '']);

  const index = siblings.findIndex(s => s.id === document.id);

  return ok({
    document: withRelated(document, { client, type }),
    client,
    type,
    version,
    history,
    comments,
    queries,
    aiCheck: aiCheck ? {
      ...aiCheck,
      checks: safeJson(aiCheck.checks_json, []),
      flags: safeJson(aiCheck.flags_json, []),
    } : null,
    ocr: ocr ? { ...ocr, fields: safeJson(ocr.fields_json, []) } : null,
    navigation: {
      total: siblings.length,
      index: index >= 0 ? index + 1 : null,
      previousId: index > 0 ? siblings[index - 1].id : null,
      nextId: index >= 0 && index < siblings.length - 1 ? siblings[index + 1].id : null,
    },
    features: {
      ocr: await hasFeature(ctx, 'ocr_ai'),
      aiVerification: await hasFeature(ctx, 'ai_doc_verification'),
      assistant: await hasFeature(ctx, 'ai_tax_assistant'),
    },
  }, { ctx });
}, { permission: 'documents.verify' });

function humanDecision(decision) {
  return {
    approve: 'verified', reject: 'rejected',
    request_changes: 'requested changes on', raise_query: 'raised a query on',
  }[decision] ?? decision;
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as verificationRouter };
