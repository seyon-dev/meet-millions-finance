/**
 * Role dashboards.
 *
 * The proposal specifies a different landing screen per role, so this module
 * exposes one endpoint that assembles the right dashboard for whoever is
 * asking. Every number is computed from stored rows at request time — there
 * are no pre-baked figures, and nothing is shown that the caller's permissions
 * would not otherwise let them see.
 */

import { createRouter } from '../http/router.js';
import { ok } from '../http/response.js';
import { ForbiddenError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { nowIso, addDays, dayKey, monthKey, periodBounds, recentMonthKeys } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import { roleLevel, highestLevel } from '../permissions/roles.js';
import { hasFeature } from '../services/features.js';
import { buildStageProgress, STATUS_TO_STAGE } from '../services/workflow.js';
import { WORKFLOW_STAGES } from '../data/document-types.js';

const router = createRouter();

router.get('/', async (ctx) => {
  const role = primaryRole(ctx);
  // The platform Super Admin has no tenant, and the dashboard built for them
  // reads across all of them. Building a tenant scope first would fail before
  // the right builder was ever chosen.
  const scope = ctx.tenantId ? scopeFor(ctx) : null;

  const builder = {
    super_admin: platformDashboard,
    admin: firmDashboard,
    finance_manager: managerDashboard,
    finance_executive: executiveDashboard,
    accountant: accountantDashboard,
    client: clientDashboard,
    auditor: auditorDashboard,
  }[role] ?? firmDashboard;

  const dashboard = await builder(ctx, scope);
  return ok({ role, generatedAt: nowIso(), ...dashboard }, { ctx });
}, { auth: true });

/**
 * The live counters the sidebar shows beside its items.
 *
 * The navigation names a counter key per item; this resolves those keys to
 * numbers. Kept out of /dashboard because the badges are polled on a timer and
 * a dashboard is not — and every count here respects the caller's own
 * visibility, so an executive's "pending verification" is their queue, not the
 * whole firm's.
 */
router.get('/badges', async (ctx) => {
  // The platform Super Admin belongs to no organisation, and every counter
  // below counts rows inside one. There is nothing to count rather than
  // something that failed, so say so instead of building a scope that cannot
  // exist — the shell polls this on every screen, including the platform ones.
  if (!ctx.tenantId) return ok({}, { ctx });

  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const badges = {};

  // The same narrowing the verification queue itself applies: an executive
  // without the broad client permission is shown their own queue, so the badge
  // matches the screen it points at.
  const ownQueueOnly = !ctx.has('clients.view') && ctx.has('clients.view.assigned');

  if (ctx.has('documents.verify')) {
    const row = ownQueueOnly
      ? await scope.rawOne(
          `SELECT COUNT(*) AS n FROM documents d
             LEFT JOIN clients c ON c.id = d.client_id
            WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL
              AND d.status IN ('submitted','under_review')
              AND (d.assigned_to = ?2 OR c.assigned_executive_id = ?2)`,
          [ctx.tenantId, ctx.userId])
      : await scope.rawOne(
          `SELECT COUNT(*) AS n FROM documents
            WHERE tenant_id = ?1 AND deleted_at IS NULL
              AND status IN ('submitted','under_review')`, [ctx.tenantId]);
    badges.pendingVerification = Number(row?.n) || 0;
  }

  if (ctx.has('tasks.view')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM tasks
        WHERE tenant_id = ?1 AND assigned_to = ?2
          AND status IN ('todo','in_progress','blocked','review')`, [ctx.tenantId, ctx.userId]);
    badges.openTasks = Number(row?.n) || 0;
  }

  if (ctx.has('approvals.view')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND status = 'pending'`,
      [ctx.tenantId]);
    badges.pendingApprovals = Number(row?.n) || 0;
  }

  if (ctx.has('queries.view') || ctx.has('queries.view.own')) {
    if (ctx.isClient) {
      const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
      if (ids.length) {
        const row = await scope.rawOne(
          `SELECT COUNT(*) AS n FROM queries
            WHERE tenant_id = ? AND client_id IN (${ids.map(() => '?').join(',')})
              AND status IN ('open','awaiting_client')`, [ctx.tenantId, ...ids]);
        badges.openQueries = Number(row?.n) || 0;
      } else {
        badges.openQueries = 0;
      }
    } else {
      const row = await scope.rawOne(
        `SELECT COUNT(*) AS n FROM queries WHERE tenant_id = ?
           AND status IN ('open','client_responded')`, [ctx.tenantId]);
      badges.openQueries = Number(row?.n) || 0;
    }
  }

  if (ctx.has('messaging.view')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM chat_threads WHERE tenant_id = ? AND unread_count > 0`,
      [ctx.tenantId]);
    badges.unreadChats = Number(row?.n) || 0;
  }

  if (ctx.has('leads.view')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM leads WHERE tenant_id = ? AND status = 'new'`, [ctx.tenantId]);
    badges.newLeads = Number(row?.n) || 0;
  }

  if (ctx.has('support.view')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM support_tickets WHERE tenant_id = ?
         AND status IN ('open','in_progress','waiting_internal','reopened')`, [ctx.tenantId]);
    badges.openTickets = Number(row?.n) || 0;
  }

  if (ctx.has('ai.ocr')) {
    const row = await scope.rawOne(
      `SELECT COUNT(*) AS n FROM ocr_extractions WHERE tenant_id = ?
         AND status = 'done' AND review_status = 'pending'`, [ctx.tenantId]);
    badges.ocrPending = Number(row?.n) || 0;
  }

  return ok({ badges, generatedAt: nowIso() }, { ctx });
}, { auth: true });

/** A specific dashboard by name, for the role switcher in the UI. */
router.get('/:role', async (ctx) => {
  const wanted = ctx.params.role;
  const builders = {
    admin: firmDashboard,
    finance_manager: managerDashboard,
    finance_executive: executiveDashboard,
    accountant: accountantDashboard,
    client: clientDashboard,
    auditor: auditorDashboard,
  };
  const builder = builders[wanted];
  if (!builder) throw new ForbiddenError(`There is no ${wanted} dashboard.`);

  // Another role's dashboard is only open to someone senior to it. Gating on
  // analytics.view would not do: almost every staff role holds it, so an
  // accountant could read the firm's revenue from the admin dashboard.
  if (primaryRole(ctx) !== wanted
      && !ctx.isSuperAdmin
      && roleLevel(wanted) >= highestLevel(ctx.roleKeys)) {
    throw new ForbiddenError(
      `The ${wanted.replace(/_/g, ' ')} dashboard is above your role, so you cannot open it.`);
  }
  const dashboard = await builder(ctx, scopeFor(ctx));
  return ok({ role: wanted, generatedAt: nowIso(), ...dashboard }, { ctx });
}, { auth: true });

// ---------------------------------------------------------------------------
// Admin / firm owner
// ---------------------------------------------------------------------------
async function firmDashboard(ctx, scope) {
  const month = periodBounds('monthly', monthKey());

  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active') AS active_clients,
       (SELECT COUNT(*) FROM companies WHERE tenant_id = ? AND deleted_at IS NULL) AS companies,
       (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active') AS staff,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND created_at BETWEEN ? AND ?) AS documents_month,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('submitted','under_review')) AS pending_verification,
       (SELECT COUNT(*) FROM queries WHERE tenant_id = ? AND status = 'open') AS open_queries,
       (SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND status != 'done' AND due_at < ?) AS overdue_tasks`,
    [ctx.tenantId, ctx.tenantId, ctx.tenantId, ctx.tenantId, month.start, month.end,
      ctx.tenantId, ctx.tenantId, ctx.tenantId, nowIso()]);

  const revenue = await revenueSeries(scope, ctx.tenantId);
  const receivables = await scope.rawOne(
    `SELECT COALESCE(SUM(amount_due_paise),0) AS outstanding,
            COUNT(*) AS unpaid_invoices,
            COALESCE(SUM(CASE WHEN due_date < ? THEN amount_due_paise ELSE 0 END),0) AS overdue
       FROM invoices WHERE tenant_id = ? AND status IN ('issued','sent','partially_paid','overdue')`,
    [dayKey(), ctx.tenantId]);

  return {
    title: 'Firm overview',
    tiles: [
      tile('Active clients', Number(counts?.active_clients) || 0, { icon: 'users', route: '/clients' }),
      tile('Documents this month', Number(counts?.documents_month) || 0, { icon: 'file', route: '/documents' }),
      tile('Pending verification', Number(counts?.pending_verification) || 0, {
        icon: 'check', route: '/verification',
        tone: Number(counts?.pending_verification) > 20 ? 'warning' : 'default',
      }),
      tile('Outstanding', formatINR(Number(receivables?.outstanding) || 0), {
        icon: 'rupee', route: '/billing/invoices',
        tone: Number(receivables?.overdue) > 0 ? 'danger' : 'default',
        caption: Number(receivables?.overdue) > 0
          ? `${formatINR(Number(receivables.overdue))} overdue` : 'All within terms',
      }),
    ],
    secondary: [
      tile('Companies', Number(counts?.companies) || 0, { icon: 'building', route: '/companies' }),
      tile('Team members', Number(counts?.staff) || 0, { icon: 'team', route: '/team' }),
      tile('Open queries', Number(counts?.open_queries) || 0, { icon: 'message', route: '/queries' }),
      tile('Overdue tasks', Number(counts?.overdue_tasks) || 0, {
        icon: 'clock', route: '/tasks',
        tone: Number(counts?.overdue_tasks) > 0 ? 'warning' : 'default',
      }),
    ],
    charts: {
      revenue: { type: 'bar', unit: 'paise', series: revenue },
      documentsByStatus: await documentsByStatus(scope, ctx.tenantId),
      uploadsByDay: await uploadsByDay(scope, ctx.tenantId, 14),
    },
    workflow: await workflowSnapshot(scope, ctx.tenantId),
    recentActivity: await recentActivity(scope, ctx.tenantId, 12),
    deadlines: await upcomingDeadlines(scope, ctx.tenantId),
  };
}

// ---------------------------------------------------------------------------
// Finance manager — approvals, team load, SLA
// ---------------------------------------------------------------------------
async function managerDashboard(ctx, scope) {
  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM approvals WHERE tenant_id = ? AND status = 'pending') AS pending_approvals,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND status IN ('submitted','under_review')) AS in_review,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL
          AND status IN ('submitted','under_review') AND sla_due_at < ?) AS sla_breached,
       (SELECT COUNT(*) FROM reports WHERE tenant_id = ? AND status = 'pending_approval') AS reports_awaiting,
       (SELECT COUNT(*) FROM queries WHERE tenant_id = ? AND status = 'open') AS open_queries`,
    [ctx.tenantId, ctx.tenantId, ctx.tenantId, nowIso(), ctx.tenantId, ctx.tenantId]);

  const team = await scope.raw(
    `SELECT u.id, u.full_name,
            SUM(CASE WHEN d.status IN ('submitted','under_review') THEN 1 ELSE 0 END) AS queue,
            SUM(CASE WHEN d.status = 'verified' AND d.verified_at >= ? THEN 1 ELSE 0 END) AS verified_7d,
            SUM(CASE WHEN d.status IN ('submitted','under_review') AND d.sla_due_at < ? THEN 1 ELSE 0 END) AS breached
       FROM users u
       LEFT JOIN documents d ON d.assigned_to = u.id AND d.deleted_at IS NULL
      WHERE u.tenant_id = ? AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id ORDER BY queue DESC LIMIT 15`,
    [addDays(-7), nowIso(), ctx.tenantId]);

  return {
    title: 'Team and approvals',
    tiles: [
      tile('Awaiting your approval', Number(counts?.pending_approvals) || 0, {
        icon: 'stamp', route: '/approvals',
        tone: Number(counts?.pending_approvals) > 0 ? 'primary' : 'default',
      }),
      tile('In review', Number(counts?.in_review) || 0, { icon: 'check', route: '/verification' }),
      tile('Past SLA', Number(counts?.sla_breached) || 0, {
        icon: 'alert', route: '/verification?tab=overdue',
        tone: Number(counts?.sla_breached) > 0 ? 'danger' : 'default',
      }),
      tile('Reports to sign off', Number(counts?.reports_awaiting) || 0, { icon: 'report', route: '/reports' }),
    ],
    teamLoad: team.map(t => ({
      userId: t.id, name: t.full_name,
      queue: Number(t.queue) || 0,
      verifiedLast7Days: Number(t.verified_7d) || 0,
      pastSla: Number(t.breached) || 0,
    })),
    charts: {
      documentsByStatus: await documentsByStatus(scope, ctx.tenantId),
      verificationThroughput: await verificationThroughput(scope, ctx.tenantId, 14),
    },
    workflow: await workflowSnapshot(scope, ctx.tenantId),
    deadlines: await upcomingDeadlines(scope, ctx.tenantId),
  };
}

// ---------------------------------------------------------------------------
// Finance executive — my queue
// ---------------------------------------------------------------------------
async function executiveDashboard(ctx, scope) {
  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL
          AND assigned_to = ? AND status IN ('submitted','under_review')) AS my_queue,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL
          AND assigned_to = ? AND status IN ('submitted','under_review') AND sla_due_at < ?) AS my_overdue,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND verified_by = ? AND verified_at >= ?) AS verified_today,
       (SELECT COUNT(*) FROM queries WHERE tenant_id = ? AND raised_by = ? AND status = 'open') AS my_open_queries,
       (SELECT COUNT(*) FROM tasks WHERE tenant_id = ? AND assigned_to = ? AND status != 'done') AS my_tasks`,
    [ctx.tenantId, ctx.userId, ctx.tenantId, ctx.userId, nowIso(),
      ctx.tenantId, ctx.userId, dayKey() + 'T00:00:00.000Z',
      ctx.tenantId, ctx.userId, ctx.tenantId, ctx.userId]);

  const queue = await scope.raw(
    `SELECT d.id, d.title, d.status, d.sla_due_at, d.created_at,
            c.display_name AS client_name, dt.name AS type_name
       FROM documents d
       LEFT JOIN clients c ON c.id = d.client_id
       LEFT JOIN document_types dt ON dt.id = d.document_type_id
      WHERE d.tenant_id = ? AND d.deleted_at IS NULL AND d.assigned_to = ?
        AND d.status IN ('submitted','under_review')
      ORDER BY d.sla_due_at IS NULL, d.sla_due_at ASC LIMIT 15`,
    [ctx.tenantId, ctx.userId]);

  return {
    title: 'My verification queue',
    tiles: [
      tile('In my queue', Number(counts?.my_queue) || 0, { icon: 'inbox', route: '/verification' }),
      tile('Past SLA', Number(counts?.my_overdue) || 0, {
        icon: 'alert', route: '/verification?tab=overdue',
        tone: Number(counts?.my_overdue) > 0 ? 'danger' : 'default',
      }),
      tile('Verified today', Number(counts?.verified_today) || 0, { icon: 'check', tone: 'success' }),
      tile('My open tasks', Number(counts?.my_tasks) || 0, { icon: 'clock', route: '/tasks' }),
    ],
    queue: queue.map(d => ({
      id: d.id, title: d.title, status: d.status,
      clientName: d.client_name, typeName: d.type_name,
      slaDueAt: d.sla_due_at,
      overdue: !!(d.sla_due_at && d.sla_due_at < nowIso()),
      receivedAt: d.created_at,
    })),
    openQueries: Number(counts?.my_open_queries) || 0,
    charts: { myThroughput: await verificationThroughput(scope, ctx.tenantId, 14, ctx.userId) },
  };
}

// ---------------------------------------------------------------------------
// Accountant — tax preparation
// ---------------------------------------------------------------------------
async function accountantDashboard(ctx, scope) {
  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM tax_computations WHERE tenant_id = ? AND status = 'draft') AS draft_computations,
       (SELECT COUNT(*) FROM reports WHERE tenant_id = ? AND status = 'draft') AS draft_reports,
       (SELECT COUNT(*) FROM filing_periods WHERE tenant_id = ? AND status IN ('collecting','verifying')) AS open_periods,
       (SELECT COUNT(*) FROM filing_periods WHERE tenant_id = ? AND status != 'filed' AND due_date < ?) AS overdue_periods,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'verified') AS verified_documents`,
    [ctx.tenantId, ctx.tenantId, ctx.tenantId, ctx.tenantId, dayKey(), ctx.tenantId]);

  const periods = await scope.raw(
    `SELECT fp.id, fp.period_key, fp.period_type, fp.status, fp.due_date, fp.documents_expected, fp.documents_verified,
            c.display_name AS client_name
       FROM filing_periods fp LEFT JOIN clients c ON c.id = fp.client_id
      WHERE fp.tenant_id = ? AND fp.status != 'filed'
      ORDER BY fp.due_date ASC LIMIT 15`, [ctx.tenantId]);

  const taxTotals = await scope.rawOne(
    `SELECT COALESCE(SUM(net_payable_paise),0) AS net_payable, COUNT(*) AS computations
       FROM tax_computations WHERE tenant_id = ? AND period_key = ?`, [ctx.tenantId, monthKey()]);

  return {
    title: 'Tax preparation',
    tiles: [
      tile('Open filing periods', Number(counts?.open_periods) || 0, { icon: 'calendar', route: '/tax' }),
      tile('Draft computations', Number(counts?.draft_computations) || 0, { icon: 'calculator', route: '/tax' }),
      tile('Past due date', Number(counts?.overdue_periods) || 0, {
        icon: 'alert', route: '/tax?filter=overdue',
        tone: Number(counts?.overdue_periods) > 0 ? 'danger' : 'default',
      }),
      tile('Net payable this month', formatINR(Number(taxTotals?.net_payable) || 0), {
        icon: 'rupee', caption: `${Number(taxTotals?.computations) || 0} computations`,
      }),
    ],
    filingPeriods: periods.map(p => ({
      id: p.id, label: p.period_key, periodType: p.period_type, status: p.status, dueDate: p.due_date,
      clientName: p.client_name,
      expected: Number(p.documents_expected) || 0,
      verified: Number(p.documents_verified) || 0,
      readyPct: Number(p.documents_expected)
        ? Math.round((Number(p.documents_verified) / Number(p.documents_expected)) * 100) : null,
      overdue: !!(p.due_date && p.due_date < dayKey() && p.status !== 'filed'),
    })),
    verifiedDocuments: Number(counts?.verified_documents) || 0,
    deadlines: await upcomingDeadlines(scope, ctx.tenantId),
  };
}

// ---------------------------------------------------------------------------
// Client portal
// ---------------------------------------------------------------------------
async function clientDashboard(ctx, scope) {
  const db = new Db(ctx.env.DB);
  const clientIds = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
  if (!clientIds.length) {
    return {
      title: 'Your filings',
      tiles: [],
      empty: true,
      message: 'Your account is not linked to a client record yet. Your accountant can link it from the client screen.',
    };
  }

  const placeholders = clientIds.map(() => '?').join(',');
  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND client_id IN (${placeholders})) AS total_documents,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND client_id IN (${placeholders}) AND status = 'verified') AS verified,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND client_id IN (${placeholders}) AND status IN ('submitted','under_review')) AS in_review,
       (SELECT COUNT(*) FROM queries WHERE tenant_id = ? AND client_id IN (${placeholders}) AND status = 'open') AS open_queries,
       (SELECT COALESCE(SUM(amount_due_paise),0) FROM invoices
          WHERE tenant_id = ? AND client_id IN (${placeholders}) AND status IN ('issued','sent','partially_paid','overdue')) AS outstanding`,
    [ctx.tenantId, ...clientIds, ctx.tenantId, ...clientIds, ctx.tenantId, ...clientIds,
      ctx.tenantId, ...clientIds, ctx.tenantId, ...clientIds]);

  const periods = await scope.raw(
    `SELECT id, period_key, period_type, status, due_date, documents_expected, documents_verified
       FROM filing_periods WHERE tenant_id = ? AND client_id IN (${placeholders})
      ORDER BY period_start DESC LIMIT 6`, [ctx.tenantId, ...clientIds]);

  const checklist = await scope.raw(
    `SELECT ci.id, ci.label, ci.status, ci.is_required, fp.period_key, fp.due_date
       FROM checklist_items ci
       JOIN filing_periods fp ON fp.id = ci.filing_period_id
      WHERE ci.tenant_id = ? AND fp.client_id IN (${placeholders})
        AND ci.status IN ('pending','query_raised','rejected')
      ORDER BY fp.due_date ASC, ci.sort_order ASC LIMIT 12`, [ctx.tenantId, ...clientIds]);

  const queries = await scope.raw(
    `SELECT q.id, q.subject, q.priority, q.created_at, q.status
       FROM queries q WHERE q.tenant_id = ? AND q.client_id IN (${placeholders}) AND q.status = 'open'
      ORDER BY q.created_at DESC LIMIT 8`, [ctx.tenantId, ...clientIds]);

  const current = periods[0] ?? null;

  return {
    title: 'Your filings',
    tiles: [
      tile('Documents uploaded', Number(counts?.total_documents) || 0, { icon: 'file', route: '/documents' }),
      tile('Verified', Number(counts?.verified) || 0, { icon: 'check', tone: 'success' }),
      tile('Being reviewed', Number(counts?.in_review) || 0, { icon: 'clock' }),
      tile('Questions for you', Number(counts?.open_queries) || 0, {
        icon: 'message', route: '/queries',
        tone: Number(counts?.open_queries) > 0 ? 'warning' : 'default',
      }),
    ],
    currentPeriod: current ? {
      id: current.id, label: current.period_key, status: current.status, dueDate: current.due_date,
      expected: Number(current.documents_expected) || 0,
      verified: Number(current.documents_verified) || 0,
      progressPct: Number(current.documents_expected)
        ? Math.round((Number(current.documents_verified) / Number(current.documents_expected)) * 100) : 0,
      stages: buildStageProgress(current),
    } : null,
    outstandingPaise: Number(counts?.outstanding) || 0,
    outstandingLabel: formatINR(Number(counts?.outstanding) || 0),
    pendingChecklist: checklist.map(c => ({
      id: c.id, label: c.label, status: c.status, required: !!c.is_required, dueDate: c.due_date, period: c.period_key,
    })),
    openQueries: queries,
    periods: periods.map(p => ({
      id: p.id, label: p.period_key, status: p.status, dueDate: p.due_date,
    })),
  };
}

// ---------------------------------------------------------------------------
// Auditor — read-only assurance view
// ---------------------------------------------------------------------------
async function auditorDashboard(ctx, scope) {
  const counts = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = ? AND created_at >= ?) AS events_30d,
       (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = ? AND severity IN ('warning','critical') AND created_at >= ?) AS notable_30d,
       (SELECT COUNT(*) FROM reports WHERE tenant_id = ? AND status IN ('approved','archived')) AS signed_reports,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'verified') AS verified_documents`,
    [ctx.tenantId, addDays(-30), ctx.tenantId, addDays(-30), ctx.tenantId, ctx.tenantId]);

  const byCategory = await scope.raw(
    `SELECT category, COUNT(*) AS n FROM audit_logs
      WHERE tenant_id = ? AND created_at >= ? GROUP BY category ORDER BY n DESC LIMIT 12`,
    [ctx.tenantId, addDays(-30)]);

  const recent = await scope.raw(
    `SELECT id, action, category, severity, entity_type, entity_label, actor_name, created_at
       FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20`, [ctx.tenantId]);

  return {
    title: 'Assurance overview',
    tiles: [
      tile('Audit events (30 days)', Number(counts?.events_30d) || 0, { icon: 'shield', route: '/audit' }),
      tile('Notable events', Number(counts?.notable_30d) || 0, {
        icon: 'alert', route: '/audit?severity=warning',
        tone: Number(counts?.notable_30d) > 0 ? 'warning' : 'default',
      }),
      tile('Signed-off reports', Number(counts?.signed_reports) || 0, { icon: 'report', route: '/reports' }),
      tile('Verified documents', Number(counts?.verified_documents) || 0, { icon: 'check' }),
    ],
    eventsByCategory: byCategory.map(c => ({ category: c.category, count: Number(c.n) })),
    recentEvents: recent,
    note: 'This role is read-only. Nothing on this screen can be edited.',
  };
}

// ---------------------------------------------------------------------------
// Super admin — platform, across tenants
// ---------------------------------------------------------------------------
async function platformDashboard(ctx) {
  const db = new Db(ctx.env.DB);
  const counts = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
       (SELECT COUNT(*) FROM tenants) AS total_tenants,
       (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND status = 'active') AS users,
       (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL) AS companies,
       (SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL) AS documents,
       (SELECT COUNT(*) FROM franchises WHERE status = 'active') AS franchises`);

  const mrr = await db.one(
    `SELECT COALESCE(SUM(p.monthly_price_paise),0) AS plan_mrr
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','trialing')`);
  const addOnMrr = await db.one(
    `SELECT COALESCE(SUM(monthly_price_paise),0) AS addon_mrr
       FROM add_on_subscriptions WHERE status IN ('active','trialing')`);

  const byPlan = await db.many(
    `SELECT p.key, p.name, COUNT(s.id) AS tenants
       FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status IN ('active','trialing')
      GROUP BY p.id ORDER BY p.sort_order`);

  const topAddOns = await db.many(
    `SELECT a.key, a.name, COUNT(s.id) AS subscriptions
       FROM add_ons a LEFT JOIN add_on_subscriptions s ON s.add_on_id = a.id AND s.status = 'active'
      GROUP BY a.id HAVING subscriptions > 0 ORDER BY subscriptions DESC LIMIT 10`);

  const recentTenants = await db.many(
    `SELECT t.id, t.name, t.status, t.created_at, p.name AS plan_name
       FROM tenants t
       LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status IN ('active','trialing')
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY t.created_at DESC LIMIT 10`);

  const planMrr = Number(mrr?.plan_mrr) || 0;
  const addonMrr = Number(addOnMrr?.addon_mrr) || 0;

  return {
    title: 'Platform',
    tiles: [
      tile('Active tenants', Number(counts?.active_tenants) || 0, { icon: 'building', route: '/platform/organisations' }),
      tile('Monthly recurring', formatINR(planMrr + addonMrr), {
        icon: 'rupee', route: '/platform/revenue',
        caption: `${formatINR(planMrr)} plans + ${formatINR(addonMrr)} add-ons`,
      }),
      tile('Users', Number(counts?.users) || 0, { icon: 'users' }),
      tile('Documents stored', Number(counts?.documents) || 0, { icon: 'file' }),
    ],
    secondary: [
      tile('Companies', Number(counts?.companies) || 0, { icon: 'building' }),
      tile('Franchises', Number(counts?.franchises) || 0, { icon: 'network', route: '/platform/franchises' }),
      tile('Total tenants', Number(counts?.total_tenants) || 0, { icon: 'list' }),
    ],
    planDistribution: byPlan.map(p => ({ key: p.key, name: p.name, tenants: Number(p.tenants) })),
    topAddOns: topAddOns.map(a => ({ key: a.key, name: a.name, subscriptions: Number(a.subscriptions) })),
    recentTenants,
    mrr: { planPaise: planMrr, addOnPaise: addonMrr, totalPaise: planMrr + addonMrr },
  };
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
function primaryRole(ctx) {
  if (ctx.isSuperAdmin) return 'super_admin';
  const order = ['admin', 'finance_manager', 'finance_executive', 'accountant', 'auditor', 'client'];
  for (const key of order) if (ctx.hasRole(key)) return key;
  return ctx.roleKeys[0] ?? 'client';
}

function tile(label, value, extra = {}) {
  return { label, value, tone: 'default', ...extra };
}

async function revenueSeries(scope, tenantId) {
  const out = [];
  for (const m of recentMonthKeys(6)) {
    const b = periodBounds('monthly', m);
    const row = await scope.rawOne(
      `SELECT COALESCE(SUM(amount_paise),0) AS collected FROM payments
        WHERE tenant_id = ? AND status = 'success' AND created_at BETWEEN ? AND ?`,
      [tenantId, b.start, b.end]);
    out.push({ periodKey: m, valuePaise: Number(row?.collected) || 0 });
  }
  return out;
}

async function documentsByStatus(scope, tenantId) {
  const rows = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM documents
      WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY status`, [tenantId]);
  return { type: 'donut', series: rows.map(r => ({ label: r.status, value: Number(r.n) })) };
}

async function uploadsByDay(scope, tenantId, days) {
  const rows = await scope.raw(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM documents
      WHERE tenant_id = ? AND deleted_at IS NULL AND created_at >= ?
      GROUP BY day ORDER BY day`, [tenantId, addDays(-days)]);
  return { type: 'line', series: rows.map(r => ({ label: r.day, value: Number(r.n) })) };
}

async function verificationThroughput(scope, tenantId, days, userId = null) {
  const params = [tenantId, addDays(-days)];
  const byUser = userId ? 'AND verified_by = ?' : '';
  if (userId) params.push(userId);
  const rows = await scope.raw(
    `SELECT substr(verified_at, 1, 10) AS day, COUNT(*) AS n FROM documents
      WHERE tenant_id = ? AND verified_at >= ? ${byUser}
      GROUP BY day ORDER BY day`, params);
  return { type: 'line', series: rows.map(r => ({ label: r.day, value: Number(r.n) })) };
}

/**
 * Where work currently sits across the proposal's ten workflow stages.
 *
 * Counted over filing periods, because a stage is a property of a period's
 * progress, and mapped with the same table the client's progress stepper
 * uses so the two screens can never disagree.
 */
async function workflowSnapshot(scope, tenantId) {
  const rows = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM filing_periods WHERE tenant_id = ? GROUP BY status`,
    [tenantId]);

  const counts = Object.fromEntries(WORKFLOW_STAGES.map(s => [s.key, 0]));
  for (const row of rows) {
    const stage = STATUS_TO_STAGE[row.status] ?? 'upload';
    counts[stage] = (counts[stage] ?? 0) + Number(row.n);
  }

  return WORKFLOW_STAGES.map(stage => ({
    no: stage.no,
    key: stage.key,
    label: stage.label,
    detail: stage.detail,
    count: counts[stage.key] ?? 0,
  }));
}

async function recentActivity(scope, tenantId, limit) {
  return scope.raw(
    `SELECT a.id, a.verb, a.summary, a.entity_type, a.entity_id, a.icon, a.created_at,
            c.display_name AS client_name, u.full_name AS actor_name
       FROM activities a
       LEFT JOIN clients c ON c.id = a.client_id
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.tenant_id = ? AND a.visibility != 'private'
      ORDER BY a.created_at DESC LIMIT ?`, [tenantId, limit]);
}

async function upcomingDeadlines(scope, tenantId) {
  const rows = await scope.raw(
    `SELECT fp.id, fp.period_key, fp.period_type, fp.due_date, fp.status,
            c.display_name AS client_name
       FROM filing_periods fp LEFT JOIN clients c ON c.id = fp.client_id
      WHERE fp.tenant_id = ? AND fp.status != 'filed' AND fp.due_date IS NOT NULL
      ORDER BY fp.due_date ASC LIMIT 10`, [tenantId]);
  const today = dayKey();
  return rows.map(r => ({
    id: r.id,
    label: r.period_key,
    periodType: r.period_type,
    clientName: r.client_name,
    dueDate: r.due_date,
    status: r.status,
    daysRemaining: daysUntil(today, r.due_date),
    overdue: r.due_date < today,
  }));
}

function daysUntil(fromDay, toDay) {
  if (!toDay) return null;
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

export { router as dashboardsRouter };
