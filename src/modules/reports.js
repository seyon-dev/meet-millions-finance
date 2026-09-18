/**
 * Reports: generation, the manager approval chain, client sign-off, and
 * export to CSV and PDF.
 *
 * The approval chain is the proposal's: Executive generates → submits →
 * Finance Manager approves or rejects → Client reviews and signs off. Each
 * step is an `approvals` row, so the queue is queryable and auditable.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit, recordActivity } from '../services/audit.js';
import { assertFeature, hasFeature } from '../services/features.js';
import {
  generateReport, reportToCsv, reportToPdf, REPORT_TYPES, REPORT_TYPE_MAP,
} from '../services/reporting.js';
import { draftFilingSummary } from '../services/ai.js';
import { dispatchNotification } from '../services/notifications.js';
import { refreshFilingPeriod } from '../services/workflow.js';
import { putObject, reportKey } from '../services/storage.js';
import { loadClientIdsForUser } from '../auth/identity.js';

const router = createRouter();
const SORTABLE = ['created_at', 'period_key', 'status', 'title', 'approved_at'];

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
router.get('/types', async (ctx) => {
  return ok(REPORT_TYPES.map(t => ({
    ...t,
    available: t.needs.every(p => ctx.has(p)),
  })), { ctx });
}, { anyPermission: ['reports.view', 'reports.view.own'] });

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('reports', 'r');
  await applyReportVisibility(ctx, where);

  where.eqIf('r.type', ctx.q('type'));
  where.eqIf('r.client_id', ctx.q('clientId'));
  where.eqIf('r.period_key', ctx.q('periodKey'));
  where.eqIf('r.filing_period_id', ctx.q('periodId'));
  const statuses = ctx.qList('status');
  if (statuses.length) where.inIf('r.status', statuses);
  else where.eqIf('r.status', ctx.q('status'));
  where.searchIf(['r.title', 'r.reference_no'], ctx.q('q'));
  where.betweenIf('r.created_at', ctx.q('from'), ctx.q('to'));

  const { rows, total } = await scope.paginate('reports', where, {
    columns: `r.*, c.display_name AS client_name, c.client_code,
              g.full_name AS generated_by_name, a.full_name AS approved_by_name`,
    joins: `LEFT JOIN clients c ON c.id = r.client_id
            LEFT JOIN users g ON g.id = r.generated_by
            LEFT JOIN users a ON a.id = r.approved_by`,
    alias: 'r',
    orderBy: `r.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), SORTABLE, 'created_at')}`,
    page, pageSize,
  });

  const counts = await scope.raw(
    'SELECT status, COUNT(*) AS n FROM reports WHERE tenant_id = ? GROUP BY status', [ctx.tenantId]);

  return paginated(rows.map(toReport), {
    page, pageSize, total,
    summary: Object.fromEntries(counts.map(c => [c.status, Number(c.n)])),
  }, ctx);
}, { anyPermission: ['reports.view', 'reports.view.own'] });

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const report = await getVisibleReport(ctx, scope, ctx.params.id);

  const payload = safeJson(report.payload_json, { sections: [], meta: {} });
  const items = await scope.all('report_items', { report_id: report.id }, { order: 'sort_order ASC', limit: 500 });
  const approvals = await scope.raw(
    `SELECT a.*, u.full_name AS decided_by_name, r.full_name AS requested_by_name
       FROM approvals a
       LEFT JOIN users u ON u.id = a.decided_by
       LEFT JOIN users r ON r.id = a.requested_by
      WHERE a.tenant_id = ? AND a.entity_type = 'report' AND a.entity_id = ?
      ORDER BY a.sequence ASC, a.created_at ASC`, [ctx.tenantId, report.id]);

  const client = report.client_id ? await scope.first('clients', { id: report.client_id }) : null;
  const company = report.company_id ? await scope.first('companies', { id: report.company_id }) : null;

  return ok({
    report: toReport(report),
    sections: payload.sections ?? [],
    meta: payload.meta ?? {},
    totals: safeJson(report.totals_json, {}),
    items,
    approvals,
    client,
    company,
    permissions: {
      canSubmit: ctx.has('reports.submit') && report.status === 'draft',
      canApprove: ctx.has('reports.approve') && report.status === 'pending_approval',
      canSignOff: ctx.has('reports.signoff') && report.status === 'client_review',
      canExport: ctx.has('reports.export'),
      canRegenerate: ctx.has('reports.create') && ['draft', 'rejected'].includes(report.status),
    },
  }, { ctx });
}, { anyPermission: ['reports.view', 'reports.view.own'] });

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
router.post('/', async (ctx) => {
  await assertFeature(ctx, 'gst_reports');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    type: { type: 'enum', required: true, values: REPORT_TYPES.map(t => t.key) },
    clientId: { type: 'id' },
    filingPeriodId: { type: 'id' },
    periodType: { type: 'enum', values: ['monthly', 'quarterly', 'yearly'], default: 'monthly' },
    periodKey: { type: 'string', max: 12, default: monthKey() },
    from: { type: 'date' },
    to: { type: 'date' },
    title: { type: 'string', max: 200 },
    filters: { type: 'json' },
    includeAiNarrative: { type: 'boolean', default: false },
  });

  const definition = REPORT_TYPE_MAP.get(input.type);
  const missing = definition.needs.filter(p => !ctx.has(p));
  if (missing.length) {
    throw new ForbiddenError(`You do not have permission to generate a ${definition.name} report.`, { required: missing });
  }

  const { report, sections, totals } = await generateReport(ctx, scope, {
    type: input.type,
    clientId: input.clientId,
    filingPeriodId: input.filingPeriodId,
    periodType: input.periodType,
    periodKey: input.periodKey,
    from: input.from,
    to: input.to,
    title: input.title,
    filters: input.filters ?? {},
  });

  // Optional AI narrative — clearly marked as a draft for review.
  let narrative = null;
  if (input.includeAiNarrative && await hasFeature(ctx, 'ai_tax_assistant') && report.computation_id) {
    const computation = await scope.first('tax_computations', { id: report.computation_id });
    const client = await scope.first('clients', { id: report.client_id });
    const company = await scope.first('companies', { id: report.company_id });
    const drafted = await draftFilingSummary(ctx, scope, { computation, client, company });
    if (drafted.ok) {
      narrative = drafted.narrative;
      await scope.update('reports', report.id, {
        narrative, ai_generated: 1,
      });
    }
  }

  await audit(ctx, {
    action: 'reports.generated', category: 'reports',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    newValue: { type: input.type, periodKey: input.periodKey, clientId: input.clientId, totals },
  });

  if (report.client_id) {
    await recordActivity(ctx, {
      clientId: report.client_id, companyId: report.company_id,
      verb: 'generated', entityType: 'report', entityId: report.id,
      summary: `${ctx.user.full_name} generated ${report.title}`,
      visibility: 'internal', icon: 'file-text',
    });
  }

  return created({
    report: toReport({ ...report, narrative }),
    sections,
    totals,
    aiNarrative: narrative ? {
      text: narrative,
      disclaimer: 'Draft generated from the computed figures. A reviewer must confirm it before approval.',
    } : null,
  }, { ctx });
}, { permission: 'reports.create' });

// ---------------------------------------------------------------------------
// Submit for manager approval
// ---------------------------------------------------------------------------
router.post('/:id/submit', async (ctx) => {
  await assertFeature(ctx, 'manager_approval');
  const scope = scopeFor(ctx);
  const report = await scope.getOrFail('reports', ctx.params.id, { resource: 'Report' });

  if (report.status !== 'draft' && report.status !== 'rejected') {
    throw new ConflictError(`A report that is "${report.status.replace(/_/g, ' ')}" cannot be submitted again.`);
  }

  const body = await ctx.body();
  const input = validate(body, {
    managerId: { type: 'id' },
    note: { type: 'text', max: 2000 },
  });

  // Route to the named manager, the client's manager, or any manager.
  let assigneeId = input.managerId;
  if (!assigneeId && report.client_id) {
    const client = await scope.first('clients', { id: report.client_id });
    assigneeId = client?.assigned_manager_id ?? null;
  }
  if (!assigneeId) {
    const manager = await scope.rawOne(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE u.tenant_id = ? AND u.status = 'active' AND r.key IN ('finance_manager','admin')
        ORDER BY r.level DESC LIMIT 1`, [ctx.tenantId]);
    assigneeId = manager?.id ?? null;
  }

  await scope.update('reports', report.id, { status: 'pending_approval', submitted_at: nowIso() });

  const approval = await scope.insert('approvals', {
    id: ID.approval(),
    entity_type: 'report',
    entity_id: report.id,
    stage: 'manager',
    status: 'pending',
    requested_by: ctx.userId,
    requested_at: nowIso(),
    assignee_id: assigneeId,
    comment: input.note,
    sequence: 1,
  });

  if (report.filing_period_id) {
    await scope.update('filing_periods', report.filing_period_id, { status: 'pending_approval' });
  }

  await audit(ctx, {
    action: 'reports.submitted', category: 'reports',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    oldValue: { status: report.status }, newValue: { status: 'pending_approval', assigneeId },
  });

  if (assigneeId) {
    const client = report.client_id ? await scope.first('clients', { id: report.client_id }) : null;
    const totals = safeJson(report.totals_json, {});
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'report.submitted',
      userId: assigneeId,
      clientId: report.client_id,
      entityType: 'report', entityId: report.id,
      variables: {
        executiveName: ctx.user.full_name,
        reportTitle: report.title,
        clientName: client?.display_name ?? '',
        period: report.period_key ?? '',
        totalTax: formatINR(totals.totalTaxPaise ?? totals.netPayablePaise ?? 0),
        link: `${ctx.env.APP_URL || ''}/reports/${report.id}`,
      },
      link: { path: `/reports/${report.id}` },
    }));
  }

  const updated = await scope.first('reports', { id: report.id });
  return ok({ report: toReport(updated), approval }, { ctx });
}, { permission: 'reports.submit' });

// ---------------------------------------------------------------------------
// Manager decision
// ---------------------------------------------------------------------------
router.post('/:id/decision', async (ctx) => {
  const scope = scopeFor(ctx);
  const report = await scope.getOrFail('reports', ctx.params.id, { resource: 'Report' });

  if (report.status !== 'pending_approval') {
    throw new ConflictError('This report is not waiting for approval.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    decision: { type: 'enum', required: true, values: ['approve', 'reject'] },
    comment: { type: 'text', max: 2000 },
    sendToClient: { type: 'boolean', default: true },
  });

  if (input.decision === 'reject' && !input.comment) {
    throw new BadRequestError('Tell the executive what needs changing before rejecting.');
  }

  const approval = await scope.rawOne(
    `SELECT * FROM approvals WHERE tenant_id = ? AND entity_type = 'report' AND entity_id = ?
       AND status = 'pending' ORDER BY sequence DESC LIMIT 1`, [ctx.tenantId, report.id]);

  if (approval) {
    await scope.update('approvals', approval.id, {
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      decided_by: ctx.userId,
      decided_at: nowIso(),
      comment: input.comment,
    });
  }

  const approved = input.decision === 'approve';
  const nextStatus = approved ? (input.sendToClient ? 'client_review' : 'approved') : 'rejected';

  await scope.update('reports', report.id, {
    status: nextStatus,
    approved_by: approved ? ctx.userId : null,
    approved_at: approved ? nowIso() : null,
    rejected_reason: approved ? null : input.comment,
  });

  if (report.filing_period_id) {
    await scope.update('filing_periods', report.filing_period_id, {
      status: approved ? (input.sendToClient ? 'client_review' : 'approved') : 'calculated',
    });
  }

  // Approving the report makes its computation final.
  if (approved && report.computation_id) {
    await scope.update('tax_computations', report.computation_id, { status: 'final' });
  }

  await audit(ctx, {
    action: approved ? 'reports.approved' : 'reports.rejected', category: 'reports',
    severity: 'notice',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    oldValue: { status: 'pending_approval' },
    newValue: { status: nextStatus, comment: input.comment ?? null },
  });

  const client = report.client_id ? await scope.first('clients', { id: report.client_id }) : null;
  if (client) {
    await recordActivity(ctx, {
      clientId: client.id, companyId: report.company_id,
      verb: approved ? 'approved' : 'rejected', entityType: 'report', entityId: report.id,
      summary: `${ctx.user.full_name} ${approved ? 'approved' : 'sent back'} ${report.title}`,
      visibility: approved ? 'client' : 'internal',
      icon: approved ? 'check-circle' : 'x-circle',
    });
  }

  const totals = safeJson(report.totals_json, {});
  if (approved && input.sendToClient && client) {
    const contacts = await scope.raw(
      `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [client.id]);
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'report.approved',
      userIds: contacts.map(c => c.id),
      toEmail: contacts.length ? null : client.primary_contact_email,
      toPhone: contacts.length ? null : client.primary_contact_phone,
      clientId: client.id,
      entityType: 'report', entityId: report.id,
      variables: {
        clientName: client.display_name,
        reportTitle: report.title,
        period: report.period_key ?? '',
        managerName: ctx.user.full_name,
        totalTax: formatINR(totals.netPayablePaise ?? totals.totalTaxPaise ?? 0),
        link: `${ctx.env.APP_URL || ''}/client/reports/${report.id}`,
      },
      link: { path: `/client/reports/${report.id}` },
    }));
  } else if (!approved) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'report.rejected',
      userId: report.generated_by,
      clientId: report.client_id,
      entityType: 'report', entityId: report.id,
      variables: {
        reportTitle: report.title, managerName: ctx.user.full_name,
        reason: input.comment, link: `${ctx.env.APP_URL || ''}/reports/${report.id}`,
      },
      link: { path: `/reports/${report.id}` },
    }));
  }

  const updated = await scope.first('reports', { id: report.id });
  return ok({ report: toReport(updated), decision: input.decision }, { ctx });
}, { permission: 'reports.approve' });

// ---------------------------------------------------------------------------
// Client sign-off
// ---------------------------------------------------------------------------
router.post('/:id/sign-off', async (ctx) => {
  const scope = scopeFor(ctx);
  const report = await getVisibleReport(ctx, scope, ctx.params.id);

  if (report.status !== 'client_review' && report.status !== 'approved') {
    throw new ConflictError('This report is not ready for your sign-off yet.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    accepted: { type: 'boolean', required: true },
    comment: { type: 'text', max: 2000 },
  });

  if (!input.accepted) {
    if (!input.comment) throw new BadRequestError('Tell us what looks wrong so we can correct it.');

    await scope.update('reports', report.id, { status: 'rejected', rejected_reason: input.comment });
    if (report.filing_period_id) {
      await scope.update('filing_periods', report.filing_period_id, { status: 'calculated' });
    }

    await audit(ctx, {
      action: 'reports.rejected', category: 'reports', severity: 'notice',
      entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
      newValue: { status: 'rejected', byClient: true, comment: input.comment },
    });

    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'report.rejected',
      userIds: [report.generated_by, report.approved_by].filter(Boolean),
      clientId: report.client_id,
      entityType: 'report', entityId: report.id,
      variables: { reportTitle: report.title, reason: input.comment, managerName: ctx.user.full_name },
      link: { path: `/reports/${report.id}` },
    }));

    const updated = await scope.first('reports', { id: report.id });
    return ok({ report: toReport(updated), accepted: false }, { ctx });
  }

  await scope.update('reports', report.id, {
    status: 'signed_off',
    client_signed_off_by: ctx.userId,
    client_signed_off_at: nowIso(),
  });

  await scope.insert('approvals', {
    id: ID.approval(),
    entity_type: 'report',
    entity_id: report.id,
    stage: 'client',
    status: 'approved',
    requested_by: report.approved_by,
    requested_at: report.approved_at ?? nowIso(),
    assignee_id: ctx.userId,
    decided_by: ctx.userId,
    decided_at: nowIso(),
    comment: input.comment,
    sequence: 2,
  });

  if (report.filing_period_id) {
    await scope.update('filing_periods', report.filing_period_id, { status: 'signed_off' });
    await refreshFilingPeriod(scope, report.filing_period_id);
  }

  await audit(ctx, {
    action: 'reports.signed_off', category: 'reports', severity: 'notice',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    newValue: { status: 'signed_off', comment: input.comment ?? null },
  });

  await recordActivity(ctx, {
    clientId: report.client_id, companyId: report.company_id,
    verb: 'signed_off', entityType: 'report', entityId: report.id,
    summary: `${ctx.user.full_name} signed off ${report.title}`,
    visibility: 'client', icon: 'pen-tool',
  });

  ctx.defer(dispatchNotification(ctx, {
    triggerKey: 'report.signed_off',
    userIds: [report.generated_by, report.approved_by].filter(Boolean),
    clientId: report.client_id,
    entityType: 'report', entityId: report.id,
    variables: {
      clientName: ctx.user.full_name, reportTitle: report.title,
      link: `${ctx.env.APP_URL || ''}/reports/${report.id}`,
    },
    link: { path: `/reports/${report.id}` },
  }));

  const updated = await scope.first('reports', { id: report.id });
  return ok({ report: toReport(updated), accepted: true }, { ctx });
}, { anyPermission: ['reports.signoff', 'reports.approve'] });

// ---------------------------------------------------------------------------
// Archive the filing
// ---------------------------------------------------------------------------
router.post('/:id/archive', async (ctx) => {
  const scope = scopeFor(ctx);
  const report = await scope.getOrFail('reports', ctx.params.id, { resource: 'Report' });

  if (!['signed_off', 'approved', 'published'].includes(report.status)) {
    throw new ConflictError('Only a signed-off report can be archived.');
  }

  await scope.update('reports', report.id, { status: 'archived' });

  if (report.filing_period_id) {
    await scope.update('filing_periods', report.filing_period_id, {
      status: 'archived', archived_at: nowIso(), locked_at: nowIso(),
    });
    // Lock every document in the archived package.
    await scope.updateWhere('documents', { filing_period_id: report.filing_period_id }, {
      status: 'archived', is_locked: 1, locked_at: nowIso(), locked_by: ctx.userId,
    });
  }

  await audit(ctx, {
    action: 'documents.archived', category: 'reports', severity: 'notice',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    newValue: { status: 'archived', filingPeriodId: report.filing_period_id },
  });

  if (report.client_id) {
    await recordActivity(ctx, {
      clientId: report.client_id, verb: 'archived', entityType: 'report', entityId: report.id,
      summary: `${report.period_key ?? ''} filing archived`,
      visibility: 'client', icon: 'archive',
    });

    const contacts = await scope.raw(
      `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [report.client_id]);
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'filing.archived',
      userIds: contacts.map(c => c.id),
      clientId: report.client_id,
      entityType: 'report', entityId: report.id,
      variables: { period: report.period_key ?? '', reportTitle: report.title },
      link: { path: `/client/filings` },
    }));
  }

  const updated = await scope.first('reports', { id: report.id });
  return ok({ report: toReport(updated) }, { ctx });
}, { permission: 'documents.archive' });

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
router.get('/:id/export', async (ctx) => {
  const scope = scopeFor(ctx);
  const report = await getVisibleReport(ctx, scope, ctx.params.id);
  const format = (ctx.q('format', 'csv') || 'csv').toLowerCase();

  const payload = safeJson(report.payload_json, { sections: [], meta: {} });
  const sections = payload.sections ?? [];

  audit(ctx, {
    action: 'data.exported', category: 'reports',
    entityType: 'report', entityId: report.id, entityLabel: report.reference_no,
    metadata: { format },
  }).catch(() => {});

  if (format === 'csv') {
    return fileResponse(reportToCsv(report, sections), {
      contentType: 'text/csv; charset=utf-8',
      fileName: `${report.reference_no}.csv`,
      download: true,
    });
  }

  if (format === 'pdf') {
    const branding = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });
    const brand = branding?.enabled && branding.product_name
      ? branding.product_name
      : (ctx.env.APP_NAME || 'Meet Millions Finance CRM');

    const bytes = reportToPdf(report, sections, { brand, meta: payload.meta ?? {} });

    // Keep the rendered PDF so the same bytes can be re-served and attached.
    if (!report.pdf_key) {
      const key = reportKey({ tenantId: ctx.tenantId, reportId: report.id, format: 'pdf' });
      ctx.defer(putObject(ctx.env, key, bytes, {
        contentType: 'application/pdf', fileName: `${report.reference_no}.pdf`,
      }).then(() => scope.update('reports', report.id, { pdf_key: key })).catch(() => {}));
    }

    return fileResponse(bytes, {
      contentType: 'application/pdf',
      fileName: `${report.reference_no}.pdf`,
      download: ctx.qBool('download', true),
    });
  }

  if (format === 'json') {
    return fileResponse(JSON.stringify({
      report: toReport(report), sections, totals: safeJson(report.totals_json, {}), meta: payload.meta,
    }, null, 2), {
      contentType: 'application/json',
      fileName: `${report.reference_no}.json`,
      download: true,
    });
  }

  throw new BadRequestError('Choose an export format of csv, pdf or json.');
}, { permission: 'reports.export' });

// ---------------------------------------------------------------------------
// Scheduled exports (Advanced Analytics add-on)
// ---------------------------------------------------------------------------
router.get('/schedules/list', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('scheduled_reports', {}, { order: 'created_at DESC', limit: 100 });
  return ok(rows.map(r => ({ ...r, filters: safeJson(r.filters_json, {}), recipients: safeJson(r.recipients_json, []) })), { ctx });
}, { permission: 'reports.schedule' });

router.post('/schedules', async (ctx) => {
  await assertFeature(ctx, 'advanced_reports');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    reportType: { type: 'enum', required: true, values: REPORT_TYPES.map(t => t.key) },
    filters: { type: 'json' },
    format: { type: 'enum', values: ['csv', 'pdf', 'json'], default: 'csv' },
    frequency: { type: 'enum', values: ['daily', 'weekly', 'monthly', 'quarterly'], default: 'monthly' },
    dayOfWeek: { type: 'int', min: 0, max: 6 },
    dayOfMonth: { type: 'int', min: 1, max: 28 },
    hourUtc: { type: 'int', min: 0, max: 23, default: 3 },
    recipients: { type: 'array', required: true, max: 20, of: { type: 'email' } },
  });

  const schedule = await scope.insert('scheduled_reports', {
    id: ID.schedule(),
    name: input.name,
    report_type: input.reportType,
    filters_json: JSON.stringify(input.filters ?? {}),
    format: input.format,
    frequency: input.frequency,
    day_of_week: input.dayOfWeek,
    day_of_month: input.dayOfMonth,
    hour_utc: input.hourUtc,
    recipients_json: JSON.stringify(input.recipients),
    is_active: 1,
    next_run_at: nowIso(),
    created_by: ctx.userId,
  });

  audit(ctx, {
    action: 'settings.changed', category: 'reports',
    entityType: 'scheduled_report', entityId: schedule.id, entityLabel: input.name,
    newValue: { reportType: input.reportType, frequency: input.frequency, recipients: input.recipients.length },
  }).catch(() => {});

  return created(schedule, { ctx });
}, { permission: 'reports.schedule' });

router.delete('/schedules/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const schedule = await scope.getOrFail('scheduled_reports', ctx.params.id, { resource: 'Schedule' });
  await scope.delete('scheduled_reports', schedule.id);
  return ok({ deleted: true }, { ctx });
}, { permission: 'reports.schedule' });

// ---------------------------------------------------------------------------

async function applyReportVisibility(ctx, where) {
  if (ctx.has('reports.view')) return true;
  if (ctx.has('reports.view.own') || ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) { where.add('1 = 0'); return false; }
    where.inIf('r.client_id', ids);
    // A client never sees a report that has not reached them.
    where.inIf('r.status', ['client_review', 'signed_off', 'published', 'archived', 'approved']);
    return true;
  }
  throw new ForbiddenError('You do not have permission to view reports.');
}

async function getVisibleReport(ctx, scope, reportId) {
  const report = await scope.first('reports', { id: reportId });
  if (!report) throw new NotFoundError('Report');

  if (!ctx.has('reports.view')) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    const visibleStatuses = ['client_review', 'signed_off', 'published', 'archived', 'approved'];
    if (!ids.includes(report.client_id) || !visibleStatuses.includes(report.status)) {
      throw new NotFoundError('Report');
    }
  }
  return report;
}

function toReport(row) {
  return {
    id: row.id,
    referenceNo: row.reference_no,
    type: row.type,
    title: row.title,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    clientCode: row.client_code ?? null,
    companyId: row.company_id,
    filingPeriodId: row.filing_period_id,
    computationId: row.computation_id,
    periodType: row.period_type,
    periodKey: row.period_key,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    totals: safeJson(row.totals_json, {}),
    narrative: row.narrative,
    aiGenerated: !!row.ai_generated,
    generatedBy: row.generated_by,
    generatedByName: row.generated_by_name ?? null,
    generatedAt: row.generated_at,
    submittedAt: row.submitted_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name ?? null,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    clientSignedOffBy: row.client_signed_off_by,
    clientSignedOffAt: row.client_signed_off_at,
    pdfKey: row.pdf_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as reportsRouter, toReport };
