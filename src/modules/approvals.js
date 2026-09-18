/**
 * The approval centre — the Finance Manager's queue.
 *
 * Approvals are generic (`entity_type` + `entity_id`), so reports, payouts and
 * anything else that needs a second pair of eyes share one queue and one
 * decision path.
 */

import { createRouter } from '../http/router.js';
import { ok, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { nowIso, monthKey, periodBounds, secondsBetween } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit } from '../services/audit.js';

const router = createRouter();

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('approvals', 'a');
  where.eqIf('a.entity_type', ctx.q('entityType'));
  where.eqIf('a.stage', ctx.q('stage'));
  where.eqIf('a.status', ctx.q('status', 'pending'));
  if (ctx.qBool('mine', false)) where.add('a.assignee_id = ?', ctx.userId);

  const { rows, total } = await scope.paginate('approvals', where, {
    columns: `a.*, r.title AS report_title, r.reference_no, r.period_key, r.totals_json,
              r.type AS report_type, c.display_name AS client_name,
              u.full_name AS requested_by_name`,
    joins: `LEFT JOIN reports r ON r.id = a.entity_id AND a.entity_type = 'report'
            LEFT JOIN clients c ON c.id = r.client_id
            LEFT JOIN users u ON u.id = a.requested_by`,
    alias: 'a',
    orderBy: `a.${safeOrder(ctx.q('sort', 'requested_at'), ctx.q('dir', 'asc'), ['requested_at', 'due_at', 'status'], 'requested_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'approved' AND substr(decided_at,1,7) = ? THEN 1 ELSE 0 END) AS approved_mtd,
       SUM(CASE WHEN status = 'rejected' AND substr(decided_at,1,7) = ? THEN 1 ELSE 0 END) AS rejected_mtd
     FROM approvals WHERE tenant_id = ?`, [monthKey(), monthKey(), ctx.tenantId]);

  return paginated(rows.map(r => ({
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    stage: r.stage,
    status: r.status,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    requestedAt: r.requested_at,
    assigneeId: r.assignee_id,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    comment: r.comment,
    dueAt: r.due_at,
    sequence: r.sequence,
    waitingSeconds: r.status === 'pending' ? secondsBetween(r.requested_at, nowIso()) : null,
    report: r.report_title ? {
      title: r.report_title,
      referenceNo: r.reference_no,
      periodKey: r.period_key,
      type: r.report_type,
      clientName: r.client_name,
      totals: safeJson(r.totals_json, {}),
    } : null,
  })), {
    page, pageSize, total,
    summary: {
      pending: Number(counts?.pending) || 0,
      approvedMtd: Number(counts?.approved_mtd) || 0,
      rejectedMtd: Number(counts?.rejected_mtd) || 0,
    },
  }, ctx);
}, { permission: 'approvals.view' });

/** The Manager Dashboard's headline metrics. */
router.get('/stats', async (ctx) => {
  const scope = scopeFor(ctx);
  const month = monthKey();
  const bounds = periodBounds('monthly', month);

  const row = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM approvals WHERE tenant_id = ?1 AND status = 'pending') AS awaiting,
       (SELECT COUNT(*) FROM approvals WHERE tenant_id = ?1 AND status = 'approved'
          AND substr(decided_at,1,7) = ?2) AS approved_mtd,
       (SELECT COUNT(DISTINCT u.id) FROM users u
          JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ?1 AND u.status = 'active'
           AND r.key IN ('finance_executive','accountant')) AS team_executives,
       (SELECT COALESCE(SUM(amount_paise),0) FROM payments
         WHERE tenant_id = ?1 AND status = 'success' AND created_at BETWEEN ?3 AND ?4) AS revenue_mtd,
       (SELECT COUNT(*) FROM reports WHERE tenant_id = ?1 AND status = 'pending_approval') AS reports_awaiting`,
    [ctx.tenantId, month, bounds.start, bounds.end]);

  // Executive performance for the manager's bar chart.
  const performance = await scope.raw(
    `SELECT u.id, u.full_name,
            COUNT(vr.id) AS decisions,
            SUM(CASE WHEN vr.sla_met = 1 THEN 1 ELSE 0 END) AS sla_met,
            SUM(CASE WHEN vr.sla_met IS NOT NULL THEN 1 ELSE 0 END) AS sla_measured
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN verification_records vr ON vr.verifier_id = u.id AND vr.created_at BETWEEN ? AND ?
      WHERE u.tenant_id = ? AND u.status = 'active'
        AND r.key IN ('finance_executive','accountant')
      GROUP BY u.id, u.full_name ORDER BY decisions DESC LIMIT 12`,
    [bounds.start, bounds.end, ctx.tenantId]);

  // Revenue split by client, for the doughnut.
  const revenueSplit = await scope.raw(
    `SELECT c.display_name AS label, COALESCE(SUM(p.amount_paise),0) AS value
       FROM payments p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.status = 'success' AND p.created_at BETWEEN ? AND ?
      GROUP BY c.id, c.display_name ORDER BY value DESC LIMIT 6`,
    [ctx.tenantId, bounds.start, bounds.end]);

  const pendingReports = await scope.raw(
    `SELECT r.id, r.title, r.reference_no, r.period_key, r.submitted_at, c.display_name AS client_name
       FROM reports r LEFT JOIN clients c ON c.id = r.client_id
      WHERE r.tenant_id = ? AND r.status = 'pending_approval'
      ORDER BY r.submitted_at ASC LIMIT 10`, [ctx.tenantId]);

  return ok({
    awaitingApproval: Number(row?.awaiting) || 0,
    approvedMtd: Number(row?.approved_mtd) || 0,
    teamExecutives: Number(row?.team_executives) || 0,
    revenueMtdPaise: Number(row?.revenue_mtd) || 0,
    revenueMtdFormatted: formatINR(Number(row?.revenue_mtd) || 0),
    reportsAwaiting: Number(row?.reports_awaiting) || 0,
    executivePerformance: performance.map(p => ({
      id: p.id,
      name: p.full_name,
      decisions: Number(p.decisions) || 0,
      slaCompliancePct: Number(p.sla_measured)
        ? Math.round((Number(p.sla_met) / Number(p.sla_measured)) * 100) : null,
    })),
    revenueSplit: revenueSplit.map(r => ({ label: r.label, valuePaise: Number(r.value) || 0 })),
    pendingReports,
    periodKey: month,
  }, { ctx });
}, { permission: 'approvals.view' });

/** Decide a non-report approval directly. Reports go through /api/reports. */
router.post('/:id/decide', async (ctx) => {
  const scope = scopeFor(ctx);
  const approval = await scope.getOrFail('approvals', ctx.params.id, { resource: 'Approval' });
  if (approval.status !== 'pending') throw new ConflictError('This item has already been decided.');

  const body = await ctx.body();
  const input = validate(body, {
    decision: { type: 'enum', required: true, values: ['approve', 'reject'] },
    comment: { type: 'text', max: 2000 },
  });
  if (input.decision === 'reject' && !input.comment) {
    throw new BadRequestError('Give a reason when rejecting.');
  }

  if (approval.entity_type === 'report') {
    throw new BadRequestError('Decide report approvals through the report itself, so the report status stays in step.');
  }

  await scope.update('approvals', approval.id, {
    status: input.decision === 'approve' ? 'approved' : 'rejected',
    decided_by: ctx.userId,
    decided_at: nowIso(),
    comment: input.comment,
  });

  await audit(ctx, {
    action: input.decision === 'approve' ? 'reports.approved' : 'reports.rejected',
    category: 'approvals', severity: 'notice',
    entityType: approval.entity_type, entityId: approval.entity_id,
    oldValue: { status: 'pending' },
    newValue: { status: input.decision === 'approve' ? 'approved' : 'rejected', comment: input.comment ?? null },
  });

  const updated = await scope.first('approvals', { id: approval.id });
  return ok({ approval: updated }, { ctx });
}, { permission: 'approvals.decide' });

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as approvalsRouter };
