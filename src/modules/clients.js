/**
 * Clients — the firm's customer records, their filing periods and their
 * activity timeline.
 *
 * Visibility follows the role: an executive with only `clients.view.assigned`
 * sees the clients assigned to them; a client user sees their own record and
 * nothing else. That narrowing happens in `clientVisibility()` and is applied
 * to every query in this module, on top of the tenant scope.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ForbiddenError, NotFoundError, ConflictError } from '../http/errors.js';
import { Db, Where, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey, daysBetween } from '../utils/time.js';
import { audit, auditAsync, recordActivity } from '../services/audit.js';
import { assertWithinLimit } from '../services/features.js';
import { provisionClient, openFilingPeriod } from '../services/provisioning.js';
import { refreshFilingPeriod, buildStageProgress } from '../services/workflow.js';
import { hashPassword } from '../auth/password.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import { dispatchNotification } from '../services/notifications.js';

const router = createRouter();

/**
 * Add the caller's client-visibility narrowing to a Where.
 * Returns false when the caller can see nothing.
 */
export async function applyClientVisibility(ctx, where, column = 'id') {
  if (ctx.has('clients.view')) return true;                 // full view within tenant

  if (ctx.isClient || ctx.has('clients.view.own')) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) { where.add('1 = 0'); return false; }
    where.inIf(column, ids);
    return true;
  }

  if (ctx.has('clients.view.assigned')) {
    where.add(`(assigned_executive_id = ? OR assigned_manager_id = ?)`, ctx.userId, ctx.userId);
    return true;
  }

  throw new ForbiddenError('You do not have permission to view clients.');
}

const SORTABLE = ['created_at', 'updated_at', 'display_name', 'client_code', 'status', 'health_score'];

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('clients');
  where.add('deleted_at IS NULL');
  await applyClientVisibility(ctx, where);

  where.eqIf('status', ctx.q('status'));
  where.eqIf('assigned_executive_id', ctx.q('executiveId'));
  where.eqIf('branch_id', ctx.q('branchId'));
  where.eqIf('company_id', ctx.q('companyId'));
  where.eqIf('source', ctx.q('source'));
  where.searchIf(
    ['display_name', 'client_code', 'primary_contact_name', 'primary_contact_email', 'primary_contact_phone'],
    ctx.q('q'));
  where.betweenIf('created_at', ctx.q('from'), ctx.q('to'));

  const orderBy = safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), SORTABLE, 'created_at');

  const { rows, total } = await scope.paginate('clients', where, { orderBy, page, pageSize });

  // Enrich with each client's live filing state in one extra query, not N.
  const enriched = await enrichClients(scope, rows);

  return paginated(enriched, { page, pageSize, total,
    filters: { status: ctx.q('status'), executiveId: ctx.q('executiveId'), q: ctx.q('q') } }, ctx);
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

async function enrichClients(scope, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const periods = await scope.raw(
    `SELECT client_id, period_key, status, due_date, documents_expected,
            documents_received, documents_verified
       FROM filing_periods
      WHERE tenant_id = ? AND client_id IN (${placeholders})
      ORDER BY period_key DESC`, [scope.tenantId, ...ids]);

  const queries = await scope.raw(
    `SELECT client_id, COUNT(*) AS open_queries FROM queries
      WHERE tenant_id = ? AND client_id IN (${placeholders})
        AND status IN ('open','awaiting_client','client_responded','under_review')
      GROUP BY client_id`, [scope.tenantId, ...ids]);

  const outstanding = await scope.raw(
    `SELECT client_id, COALESCE(SUM(amount_due_paise),0) AS due FROM invoices
      WHERE tenant_id = ? AND client_id IN (${placeholders})
        AND status IN ('issued','sent','partially_paid','overdue')
      GROUP BY client_id`, [scope.tenantId, ...ids]);

  const latestByClient = new Map();
  for (const p of periods) if (!latestByClient.has(p.client_id)) latestByClient.set(p.client_id, p);
  const queriesByClient = new Map(queries.map(q => [q.client_id, Number(q.open_queries)]));
  const dueByClient = new Map(outstanding.map(o => [o.client_id, Number(o.due)]));

  return rows.map(row => ({
    ...toClient(row),
    currentPeriod: latestByClient.get(row.id) ? {
      periodKey: latestByClient.get(row.id).period_key,
      status: latestByClient.get(row.id).status,
      dueDate: latestByClient.get(row.id).due_date,
      documentsExpected: latestByClient.get(row.id).documents_expected,
      documentsReceived: latestByClient.get(row.id).documents_received,
      documentsVerified: latestByClient.get(row.id).documents_verified,
      daysToDue: latestByClient.get(row.id).due_date
        ? daysBetween(nowIso(), latestByClient.get(row.id).due_date) : null,
    } : null,
    openQueries: queriesByClient.get(row.id) ?? 0,
    outstandingPaise: dueByClient.get(row.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------
router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await getVisibleClient(ctx, scope, ctx.params.id);

  const company = await scope.first('companies', { id: client.company_id });
  const contacts = await scope.all('client_contacts', { client_id: client.id }, { order: 'is_primary DESC, created_at ASC' });
  const periods = await scope.all('filing_periods', { client_id: client.id }, { order: 'period_key DESC', limit: 24 });

  const executive = client.assigned_executive_id
    ? await scope.first('users', { id: client.assigned_executive_id }, 'id, full_name, email, avatar_key')
    : null;
  const manager = client.assigned_manager_id
    ? await scope.first('users', { id: client.assigned_manager_id }, 'id, full_name, email, avatar_key')
    : null;

  const stats = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ?1 AND client_id = ?2 AND deleted_at IS NULL) AS documents,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ?1 AND client_id = ?2 AND status IN ('verified','approved','archived') AND deleted_at IS NULL) AS verified,
       (SELECT COUNT(*) FROM queries WHERE tenant_id = ?1 AND client_id = ?2 AND status IN ('open','awaiting_client','client_responded','under_review')) AS open_queries,
       (SELECT COUNT(*) FROM reports WHERE tenant_id = ?1 AND client_id = ?2) AS reports,
       (SELECT COALESCE(SUM(amount_due_paise),0) FROM invoices WHERE tenant_id = ?1 AND client_id = ?2 AND status IN ('issued','sent','partially_paid','overdue')) AS outstanding,
       (SELECT COALESCE(SUM(amount_paid_paise),0) FROM invoices WHERE tenant_id = ?1 AND client_id = ?2) AS collected,
       (SELECT COUNT(*) FROM call_records WHERE tenant_id = ?1 AND client_id = ?2) AS calls`,
    [scope.tenantId, client.id]);

  return ok({
    client: toClient(client),
    company,
    contacts,
    periods,
    executive,
    manager,
    stats: {
      documents: Number(stats?.documents) || 0,
      verified: Number(stats?.verified) || 0,
      openQueries: Number(stats?.open_queries) || 0,
      reports: Number(stats?.reports) || 0,
      outstandingPaise: Number(stats?.outstanding) || 0,
      collectedPaise: Number(stats?.collected) || 0,
      calls: Number(stats?.calls) || 0,
    },
  }, { ctx });
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post('/', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    displayName: { type: 'string', required: true, min: 2, max: 160 },
    companyName: { type: 'string', max: 160 },
    entityType: { type: 'enum', values: ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'trust', 'society', 'huf', 'other'], default: 'private_limited' },
    gstin: { type: 'gstin', label: 'GSTIN' },
    pan: { type: 'pan', label: 'PAN' },
    tan: { type: 'tan', label: 'TAN' },
    stateCode: { type: 'string', max: 2, default: '33' },
    contactName: { type: 'string', max: 120 },
    contactEmail: { type: 'email' },
    contactPhone: { type: 'phone' },
    assignedExecutiveId: { type: 'id' },
    assignedManagerId: { type: 'id' },
    branchId: { type: 'id' },
    slaHours: { type: 'int', min: 1, max: 720, default: 48 },
    source: { type: 'enum', values: ['manual', 'meta_ads', 'website_form', 'google_form', 'sheet', 'referral', 'api'], default: 'manual' },
    createPortalLogin: { type: 'boolean', default: false },
    portalPassword: { type: 'string', max: 256 },
    openCurrentPeriod: { type: 'boolean', default: true },
  });

  // A client record implies a company record, so it counts against the limit.
  await assertWithinLimit(ctx, 'companies', 1);

  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);

  if (input.gstin) {
    const clash = await scope.rawOne(
      'SELECT id, name FROM companies WHERE tenant_id = ? AND gstin = ? AND deleted_at IS NULL',
      [ctx.tenantId, input.gstin]);
    if (clash) throw new ConflictError(`${clash.name} is already registered with that GSTIN.`, { field: 'gstin' });
  }

  if (input.createPortalLogin && !input.contactEmail) {
    throw new BadRequestError('A portal login needs the client contact\'s email address.');
  }

  let passwordHash = null;
  if (input.createPortalLogin) {
    const temp = input.portalPassword || `Mm-${ID.client().slice(-8)}-${Math.floor(Math.random() * 9000 + 1000)}`;
    passwordHash = await hashPassword(temp);
    ctx._tempPortalPassword = input.portalPassword ? null : temp;
  }

  const result = await provisionClient(scope, db, {
    displayName: input.displayName,
    companyName: input.companyName || input.displayName,
    gstin: input.gstin,
    pan: input.pan,
    tan: input.tan,
    stateCode: input.stateCode,
    entityType: input.entityType,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    passwordHash,
    assignedExecutiveId: input.assignedExecutiveId ?? ctx.userId,
    assignedManagerId: input.assignedManagerId,
    branchId: input.branchId,
    source: input.source,
    createdBy: ctx.userId,
    sla: input.slaHours,
  });

  let period = null;
  if (input.openCurrentPeriod) {
    const opened = await openFilingPeriod(scope, db, {
      clientId: result.client.id,
      companyId: result.company.id,
      periodKey: monthKey(),
    });
    period = opened.period;
  }

  await audit(ctx, {
    action: 'clients.created', category: 'clients',
    entityType: 'client', entityId: result.client.id, entityLabel: result.client.display_name,
    newValue: { displayName: input.displayName, gstin: input.gstin, source: input.source },
  });

  await recordActivity(ctx, {
    clientId: result.client.id, companyId: result.company.id,
    verb: 'created', entityType: 'client', entityId: result.client.id,
    summary: `${ctx.user.full_name} onboarded ${result.client.display_name}`,
    visibility: 'internal', icon: 'user-plus',
  });

  if (result.portalUser && input.contactEmail) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'account.invited',
      userId: result.portalUser.id,
      clientId: result.client.id,
      variables: {
        name: input.contactName || input.displayName,
        inviterName: ctx.user.full_name,
        roleName: 'Client',
        organisation: ctx.tenant?.name,
        inviteUrl: `${ctx.env.APP_URL || ''}/login`,
        expiresIn: '7 days',
      },
    }));
  }

  return created({
    client: toClient(result.client),
    company: result.company,
    contact: result.contact,
    period,
    portalUser: result.portalUser ? { id: result.portalUser.id, email: result.portalUser.email } : null,
    // A generated password is shown once, here, and never stored in plaintext.
    temporaryPassword: ctx._tempPortalPassword ?? null,
  }, { ctx });
}, { permission: 'clients.create' });

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await getVisibleClient(ctx, scope, ctx.params.id);

  const body = await ctx.body();
  const input = validate(body, {
    displayName: { type: 'string', min: 2, max: 160 },
    primaryContactName: { type: 'string', max: 120 },
    primaryContactEmail: { type: 'email' },
    primaryContactPhone: { type: 'phone' },
    status: { type: 'enum', values: ['active', 'inactive', 'at_risk', 'churned', 'archived'] },
    slaHours: { type: 'int', min: 1, max: 720 },
    billingDay: { type: 'int', min: 1, max: 28 },
    notes: { type: 'text', max: 5000 },
    tags: { type: 'array', max: 20, of: { type: 'string', max: 40 } },
    branchId: { type: 'id' },
  });

  const patch = pruneUndefined({
    display_name: input.displayName,
    primary_contact_name: input.primaryContactName,
    primary_contact_email: input.primaryContactEmail,
    primary_contact_phone: input.primaryContactPhone,
    status: input.status,
    sla_hours: input.slaHours,
    billing_day: input.billingDay,
    notes: input.notes,
    tags_json: input.tags ? JSON.stringify(input.tags) : undefined,
    branch_id: input.branchId,
  });

  if (!Object.keys(patch).length) return ok({ client: toClient(client), changed: false }, { ctx });

  await scope.update('clients', client.id, patch);
  const updated = await scope.first('clients', { id: client.id });

  auditAsync(ctx, {
    action: 'clients.updated', category: 'clients',
    entityType: 'client', entityId: client.id, entityLabel: client.display_name,
    oldValue: pick(client, Object.keys(patch)),
    newValue: patch,
  });

  return ok({ client: toClient(updated), changed: true }, { ctx });
}, { permission: 'clients.update' });

// ---------------------------------------------------------------------------
// Assign
// ---------------------------------------------------------------------------
router.post('/:id/assign', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await scope.getOrFail('clients', ctx.params.id, { resource: 'Client' });

  const body = await ctx.body();
  const input = validate(body, {
    executiveId: { type: 'id' },
    managerId: { type: 'id' },
  });

  for (const [field, id] of [['executiveId', input.executiveId], ['managerId', input.managerId]]) {
    if (!id) continue;
    const user = await scope.first('users', { id }, 'id, full_name, status');
    if (!user) throw new NotFoundError('User', `The ${field === 'executiveId' ? 'executive' : 'manager'} you selected is not in this organisation.`);
    if (user.status !== 'active') throw new BadRequestError(`${user.full_name} is not an active user.`);
  }

  const patch = pruneUndefined({
    assigned_executive_id: input.executiveId,
    assigned_manager_id: input.managerId,
  });
  await scope.update('clients', client.id, patch);

  await audit(ctx, {
    action: 'clients.assigned', category: 'clients',
    entityType: 'client', entityId: client.id, entityLabel: client.display_name,
    oldValue: { executive: client.assigned_executive_id, manager: client.assigned_manager_id },
    newValue: { executive: input.executiveId, manager: input.managerId },
  });

  await recordActivity(ctx, {
    clientId: client.id, verb: 'assigned', entityType: 'client', entityId: client.id,
    summary: `${ctx.user.full_name} reassigned ${client.display_name}`,
    icon: 'user-check',
  });

  if (input.executiveId && input.executiveId !== client.assigned_executive_id) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'task.assigned',
      userId: input.executiveId,
      clientId: client.id,
      variables: { taskTitle: `${client.display_name} assigned to you` },
      link: { path: `/clients/${client.id}` },
    }));
  }

  const updated = await scope.first('clients', { id: client.id });
  return ok({ client: toClient(updated) }, { ctx });
}, { permission: 'clients.assign' });

// ---------------------------------------------------------------------------
// Archive (soft delete)
// ---------------------------------------------------------------------------
router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await scope.getOrFail('clients', ctx.params.id, { resource: 'Client' });

  const openInvoices = await scope.rawCount(
    `SELECT COUNT(*) FROM invoices WHERE tenant_id = ? AND client_id = ?
       AND status IN ('issued','sent','partially_paid','overdue')`, [ctx.tenantId, client.id]);
  if (openInvoices > 0) {
    throw new ConflictError(
      `${client.display_name} has ${openInvoices} unpaid invoice${openInvoices === 1 ? '' : 's'}. Settle or void them before archiving.`);
  }

  await scope.update('clients', client.id, { status: 'archived', deleted_at: nowIso() });

  await audit(ctx, {
    action: 'clients.archived', category: 'clients', severity: 'notice',
    entityType: 'client', entityId: client.id, entityLabel: client.display_name,
  });

  return ok({ archived: true, id: client.id }, { ctx });
}, { permission: 'clients.delete' });

// ---------------------------------------------------------------------------
// Filing periods
// ---------------------------------------------------------------------------
router.get('/:id/periods', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await getVisibleClient(ctx, scope, ctx.params.id);
  const periods = await scope.all('filing_periods', { client_id: client.id }, { order: 'period_key DESC', limit: 60 });
  return ok(periods, { ctx });
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

router.post('/:id/periods', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const client = await scope.getOrFail('clients', ctx.params.id, { resource: 'Client' });

  const body = await ctx.body();
  const input = validate(body, {
    periodType: { type: 'enum', values: ['monthly', 'quarterly', 'yearly'], default: 'monthly' },
    periodKey: { type: 'string', required: true, max: 12 },
    dueDate: { type: 'date' },
  });

  const result = await openFilingPeriod(scope, db, {
    clientId: client.id,
    companyId: client.company_id,
    periodType: input.periodType,
    periodKey: input.periodKey,
    dueDate: input.dueDate,
  });

  if (!result.created) {
    throw new ConflictError(`A ${input.periodType} filing for ${input.periodKey} already exists for this client.`);
  }

  auditAsync(ctx, {
    action: 'clients.updated', category: 'clients',
    entityType: 'filing_period', entityId: result.period.id,
    entityLabel: `${client.display_name} — ${input.periodKey}`,
    newValue: { periodKey: input.periodKey, periodType: input.periodType },
  });

  return created({ period: result.period, checklist: result.checklist }, { ctx });
}, { permission: 'clients.update' });

/** One filing period, with its checklist, documents, queries and stage state. */
router.get('/:id/periods/:periodId', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await getVisibleClient(ctx, scope, ctx.params.id);

  const period = await scope.first('filing_periods', { id: ctx.params.periodId, client_id: client.id });
  if (!period) throw new NotFoundError('Filing period');

  const refreshed = await refreshFilingPeriod(scope, period.id);

  const checklist = await scope.raw(
    `SELECT ci.*, dt.name AS type_name, dt.category AS type_category, dt.key AS type_key,
            d.status AS document_status, d.id AS doc_id, d.title AS document_title
       FROM checklist_items ci
       JOIN document_types dt ON dt.id = ci.document_type_id
       LEFT JOIN documents d ON d.id = ci.document_id
      WHERE ci.tenant_id = ? AND ci.filing_period_id = ?
      ORDER BY ci.sort_order`, [ctx.tenantId, period.id]);

  const documents = await scope.raw(
    `SELECT d.*, dt.name AS type_name FROM documents d
       JOIN document_types dt ON dt.id = d.document_type_id
      WHERE d.tenant_id = ? AND d.filing_period_id = ? AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC`, [ctx.tenantId, period.id]);

  const queries = await scope.all('queries', { filing_period_id: period.id }, { order: 'created_at DESC', limit: 50 });
  const computations = await scope.all('tax_computations', { filing_period_id: period.id }, { order: 'created_at DESC' });
  const reports = await scope.all('reports', { filing_period_id: period.id }, { order: 'created_at DESC' });

  const openQueries = queries.filter(q => ['open', 'awaiting_client', 'client_responded', 'under_review'].includes(q.status)).length;

  return ok({
    period: refreshed ?? period,
    checklist,
    documents,
    queries,
    computations,
    reports,
    stages: buildStageProgress(refreshed ?? period, {
      openQueries,
      hasReport: reports.length > 0,
      hasPayment: (refreshed ?? period).status === 'paid',
    }),
  }, { ctx });
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
router.get('/:id/timeline', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await getVisibleClient(ctx, scope, ctx.params.id);
  const { page, pageSize } = ctx.pagination({ defaultSize: 40 });

  const where = scope.where('activities');
  where.eqIf('client_id', client.id);
  // A client user sees only client-visible entries, never internal notes.
  if (ctx.isClient) where.inIf('visibility', ['client', 'public']);
  where.eqIf('entity_type', ctx.q('entityType'));

  const { rows, total } = await scope.paginate('activities', where, {
    orderBy: 'created_at DESC', page, pageSize,
  });

  return paginated(rows.map(r => ({
    ...r,
    detail: safeJson(r.detail_json, null),
  })), { page, pageSize, total }, ctx);
}, { anyPermission: ['clients.view', 'clients.view.assigned', 'clients.view.own'] });

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
router.post('/:id/contacts', async (ctx) => {
  const scope = scopeFor(ctx);
  const client = await scope.getOrFail('clients', ctx.params.id, { resource: 'Client' });

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    email: { type: 'email' },
    phone: { type: 'phone' },
    designation: { type: 'string', max: 80 },
    isPrimary: { type: 'boolean', default: false },
    whatsappOptIn: { type: 'boolean', default: false },
  });

  if (input.isPrimary) {
    await scope.updateWhere('client_contacts', { client_id: client.id }, { is_primary: 0 });
  }

  const contact = await scope.insert('client_contacts', {
    id: ID.contact(),
    client_id: client.id,
    name: input.name,
    email: input.email,
    phone: input.phone,
    designation: input.designation,
    is_primary: input.isPrimary ? 1 : 0,
    whatsapp_opt_in: input.whatsappOptIn ? 1 : 0,
  });

  auditAsync(ctx, {
    action: 'clients.updated', category: 'clients',
    entityType: 'client_contact', entityId: contact.id, entityLabel: input.name,
    newValue: { name: input.name, email: input.email },
  });

  return created(contact, { ctx });
}, { permission: 'clients.update' });

router.delete('/:id/contacts/:contactId', async (ctx) => {
  const scope = scopeFor(ctx);
  await scope.getOrFail('clients', ctx.params.id, { resource: 'Client' });
  const contact = await scope.first('client_contacts', { id: ctx.params.contactId, client_id: ctx.params.id });
  if (!contact) throw new NotFoundError('Contact');
  if (contact.is_primary) throw new BadRequestError('Set another contact as primary before removing this one.');

  await scope.delete('client_contacts', contact.id);
  auditAsync(ctx, {
    action: 'clients.updated', category: 'clients',
    entityType: 'client_contact', entityId: contact.id, entityLabel: contact.name,
    oldValue: { name: contact.name }, severity: 'notice',
  });
  return ok({ deleted: true }, { ctx });
}, { permission: 'clients.update' });

// ---------------------------------------------------------------------------

/** Fetch a client the caller is allowed to see, or 404 (never 403-by-leak). */
export async function getVisibleClient(ctx, scope, clientId) {
  const where = scope.where('clients');
  where.add('id = ?', clientId);
  where.add('deleted_at IS NULL');
  const visible = await applyClientVisibility(ctx, where);
  if (!visible) throw new NotFoundError('Client');

  const rows = await scope.raw(`SELECT * FROM clients ${where.sql} LIMIT 1`, where.params);
  if (!rows.length) throw new NotFoundError('Client');
  return rows[0];
}

export function toClient(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    branchId: row.branch_id,
    clientCode: row.client_code,
    displayName: row.display_name,
    contactName: row.primary_contact_name,
    contactEmail: row.primary_contact_email,
    contactPhone: row.primary_contact_phone,
    assignedExecutiveId: row.assigned_executive_id,
    assignedManagerId: row.assigned_manager_id,
    onboardingStatus: row.onboarding_status,
    status: row.status,
    healthScore: row.health_score,
    source: row.source,
    tags: safeJson(row.tags_json, []),
    notes: row.notes,
    slaHours: row.sla_hours,
    billingDay: row.billing_day,
    isDemo: !!row.is_demo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pruneUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}
function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as clientsRouter };
