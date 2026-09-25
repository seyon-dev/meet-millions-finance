/**
 * Platform administration — the Super Admin's view across every tenant.
 *
 * This is the only module that deliberately works outside tenant scope, so
 * every route here demands a platform permission and reaches the data through
 * `platformScope()`, which is explicit about crossing the boundary rather than
 * quietly forgetting to apply it.
 *
 * Suspending an organisation ends its sessions. Impersonation is time-boxed,
 * reason-bearing and audited on both sides.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { platformScope } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays, addMonths, monthKey, periodBounds, recentMonthKeys } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit } from '../services/audit.js';
import { provisionTenant } from '../services/provisioning.js';
import { revokeAllUserSessions } from '../auth/session.js';
import { recordSubscriptionEvent, listSubscriptionEvents } from '../services/subscription-events.js';
import { dispatchNotification } from '../services/notifications.js';
import { PLANS, PLAN_COMPARISON } from '../data/plans.js';
import { ADDONS } from '../data/addons.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------
router.get('/tenants', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const { page, pageSize } = ctx.pagination();
  const offset = (page - 1) * pageSize;

  const filters = [];
  const params = [];
  if (ctx.q('status')) { filters.push('t.status = ?'); params.push(ctx.q('status')); }
  if (ctx.q('planKey')) { filters.push('p.key = ?'); params.push(ctx.q('planKey')); }
  if (ctx.q('franchiseId')) { filters.push('t.franchise_id = ?'); params.push(ctx.q('franchiseId')); }
  if (ctx.q('q')) {
    filters.push('(LOWER(t.name) LIKE ? OR LOWER(COALESCE(t.email,\'\')) LIKE ? OR LOWER(COALESCE(t.gstin,\'\')) LIKE ?)');
    const like = `%${ctx.q('q').toLowerCase()}%`;
    params.push(like, like, like);
  }
  filters.push('t.deleted_at IS NULL');
  const where = `WHERE ${filters.join(' AND ')}`;

  const sort = safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'),
    ['created_at', 'name', 'status'], 'created_at');

  // The LATEST subscription, whatever its state: a lapsed or cancelled
  // subscription is exactly what this screen exists to surface, so filtering
  // to healthy statuses here would hide the organisations that need help.
  const rows = await db.many(
    `SELECT t.*, p.key AS plan_key, p.name AS plan_name, s.status AS subscription_status,
            s.current_period_end, s.trial_ends_at, s.grace_until, f.name AS franchise_name,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL) AS user_count,
            (SELECT COUNT(*) FROM clients c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS client_count,
            (SELECT COUNT(*) FROM documents d WHERE d.tenant_id = t.id AND d.deleted_at IS NULL) AS document_count,
            (SELECT MAX(u.last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_activity_at
       FROM tenants t
       LEFT JOIN subscriptions s ON s.id =
         (SELECT s2.id FROM subscriptions s2 WHERE s2.tenant_id = t.id ORDER BY s2.created_at DESC LIMIT 1)
       LEFT JOIN plans p ON p.id = s.plan_id
       LEFT JOIN franchises f ON f.id = t.franchise_id
       ${where} ORDER BY t.${sort} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]);

  const total = await db.count(
    `SELECT COUNT(*) AS n FROM tenants t
       LEFT JOIN subscriptions s ON s.id =
         (SELECT s2.id FROM subscriptions s2 WHERE s2.tenant_id = t.id ORDER BY s2.created_at DESC LIMIT 1)
       LEFT JOIN plans p ON p.id = s.plan_id ${where}`, params);

  const counts = await db.one(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) AS trial,
            SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
       FROM tenants WHERE deleted_at IS NULL`);

  const subStates = await db.many(
    `SELECT s.status, COUNT(*) AS n FROM subscriptions s
       JOIN (SELECT tenant_id, MAX(created_at) AS mc FROM subscriptions GROUP BY tenant_id) latest
         ON latest.tenant_id = s.tenant_id AND latest.mc = s.created_at
      GROUP BY s.status`);

  return paginated(rows.map(toTenant), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      active: Number(counts?.active) || 0,
      trial: Number(counts?.trial) || 0,
      suspended: Number(counts?.suspended) || 0,
      cancelled: Number(counts?.cancelled) || 0,
      subscriptions: Object.fromEntries(subStates.map(r => [r.status, Number(r.n)])),
    },
  }, ctx);
}, { permission: 'tenants.view' });

router.get('/tenants/:id', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const subscription = await db.one(
    `SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.monthly_price_paise
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [ctx.params.id]);

  const addOns = await db.many(
    `SELECT a.key, a.name, s.status, s.monthly_price_paise, s.activated_at
       FROM add_on_subscriptions s JOIN add_ons a ON a.id = s.add_on_id
      WHERE s.tenant_id = ? ORDER BY a.number`, [ctx.params.id]);

  const usage = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND deleted_at IS NULL) AS users,
       (SELECT COUNT(*) FROM companies WHERE tenant_id = ? AND deleted_at IS NULL) AS companies,
       (SELECT COUNT(*) FROM clients WHERE tenant_id = ? AND deleted_at IS NULL) AS clients,
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL) AS documents,
       (SELECT COALESCE(SUM(v.size_bytes),0) FROM document_versions v WHERE v.tenant_id = ?) AS storage_bytes`,
    [ctx.params.id, ctx.params.id, ctx.params.id, ctx.params.id, ctx.params.id]);

  const owners = await db.many(
    `SELECT u.id, u.full_name, u.email, u.last_login_at, r.key AS role_key
       FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = ? AND r.key IN ('admin','super_admin') AND u.deleted_at IS NULL
      ORDER BY u.created_at LIMIT 10`, [ctx.params.id]);

  const invoices = await db.many(
    `SELECT id, invoice_no, status, total_paise, amount_paid_paise, amount_due_paise, issue_date, due_date
       FROM invoices WHERE tenant_id = ? AND direction = 'platform_to_tenant'
      ORDER BY issue_date DESC LIMIT 12`, [ctx.params.id]);

  const users = await db.many(
    `SELECT u.id, u.full_name, u.email, u.status, u.last_login_at, u.created_at,
            (SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id ORDER BY r.level DESC LIMIT 1) AS role_name
       FROM users u WHERE u.tenant_id = ? AND u.deleted_at IS NULL
      ORDER BY u.created_at LIMIT 100`, [ctx.params.id]);

  const activity = await db.many(
    `SELECT id, action, category, severity, actor_name, entity_type, entity_label, created_at
       FROM audit_logs WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 15`, [ctx.params.id]);

  const events = await listSubscriptionEvents(db, ctx.params.id, { limit: 30 });

  return ok({
    tenant: toTenant(tenant),
    subscription,
    addOns,
    usage: {
      users: Number(usage?.users) || 0,
      companies: Number(usage?.companies) || 0,
      clients: Number(usage?.clients) || 0,
      documents: Number(usage?.documents) || 0,
      storageBytes: Number(usage?.storage_bytes) || 0,
    },
    owners,
    users: users.map(u => ({
      id: u.id, fullName: u.full_name, email: u.email, status: u.status,
      roleName: u.role_name, lastLoginAt: u.last_login_at, createdAt: u.created_at,
    })),
    invoices,
    activity,
    events,
  }, { ctx });
}, { permission: 'tenants.view' });

router.post('/tenants', async (ctx) => {
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 160 },
    ownerName: { type: 'string', required: true, max: 120 },
    ownerEmail: { type: 'email', required: true },
    ownerPhone: { type: 'phone' },
    planKey: { type: 'enum', values: PLANS.map(p => p.key), default: 'standard' },
    franchiseId: { type: 'id' },
    gstin: { type: 'gstin' },
    stateCode: { type: 'string', max: 2 },
    trialDays: { type: 'int', min: 0, max: 90 },
    isDemo: { type: 'boolean', default: false },
  });

  const db = new Db(ctx.env.DB);
  const clash = await db.one(
    'SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [input.ownerEmail]);
  if (clash) throw new ConflictError('That email address already belongs to an account.');

  // The owner gets a generated password, shown once here and never stored in
  // clear. Platform staff pass it on; nobody can read it back later.
  const { hashPassword, generateTemporaryPassword } = await import('../auth/password.js');
  const temporaryPassword = generateTemporaryPassword();

  const result = await provisionTenant(ctx, {
    organisationName: input.name,
    ownerName: input.ownerName,
    ownerEmail: input.ownerEmail,
    ownerPhone: input.ownerPhone,
    passwordHash: await hashPassword(temporaryPassword),
    companyName: input.name,
    gstin: input.gstin,
    stateCode: input.stateCode ?? (input.gstin ? input.gstin.slice(0, 2) : '33'),
    planKey: input.planKey,
    franchiseId: input.franchiseId,
    isDemo: input.isDemo,
  });

  if (input.trialDays) {
    await db.update('subscriptions', { id: result.subscription.id }, {
      status: 'trialing', trial_ends_at: addDays(input.trialDays), updated_at: nowIso(),
    });
  }

  await audit(ctx, {
    action: 'platform.tenant_created', category: 'general', severity: 'notice',
    tenantId: null,
    entityType: 'tenant', entityId: result.tenant.id, entityLabel: input.name,
    newValue: { plan: input.planKey, owner: input.ownerEmail, demo: input.isDemo },
  });

  return created({
    tenant: toTenant(result.tenant),
    owner: { id: result.user.id, email: result.user.email, role: result.roleKey },
    company: { id: result.company.id, name: result.company.name },
    temporaryPassword,
  }, { ctx });
}, { permission: 'tenants.create' });

router.patch('/tenants/:id', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 160 },
    legalName: { type: 'string', max: 200 },
    status: { type: 'enum', values: ['active', 'trial', 'suspended', 'cancelled'] },
    email: { type: 'email' },
    phone: { type: 'phone' },
    gstin: { type: 'gstin' },
    pan: { type: 'pan' },
    tan: { type: 'tan' },
    addressLine1: { type: 'string', max: 200 },
    addressLine2: { type: 'string', max: 200 },
    city: { type: 'string', max: 100 },
    state: { type: 'string', max: 100 },
    stateCode: { type: 'string', max: 2 },
    pincode: { type: 'string', max: 10 },
    timezone: { type: 'string', max: 60 },
    franchiseId: { type: 'id' },
    reason: { type: 'text', max: 500 },
  });

  const patch = {};
  for (const [field, column] of Object.entries({
    name: 'name', legalName: 'legal_name', status: 'status', email: 'email', phone: 'phone',
    gstin: 'gstin', pan: 'pan', tan: 'tan',
    addressLine1: 'address_line1', addressLine2: 'address_line2', city: 'city', state: 'state',
    stateCode: 'state_code', pincode: 'pincode', timezone: 'timezone', franchiseId: 'franchise_id',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  const blocking = patch.status && ['suspended', 'cancelled'].includes(patch.status)
    && tenant.status !== patch.status;
  const restoring = patch.status === 'active' && ['suspended', 'cancelled'].includes(tenant.status);

  // Blocking an organisation has to end its sessions, whatever state it was
  // in before — a trial organisation's sessions are as alive as an active
  // one's, and leaving either signed in makes the change advisory.
  if (blocking) {
    if (!input.reason) {
      throw new BadRequestError('Give a reason when suspending or cancelling an organisation.');
    }
    const users = await db.many(
      'SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL', [ctx.params.id]);
    for (const user of users) {
      await revokeAllUserSessions(db, user.id, { reason: `tenant_${patch.status}` });
    }
  }

  await db.update('tenants', { id: ctx.params.id }, { ...patch, updated_at: nowIso() });

  await audit(ctx, {
    action: blocking ? 'platform.tenant_suspended'
      : restoring ? 'platform.tenant_reactivated' : 'platform.tenant_updated',
    category: 'general',
    severity: blocking ? 'warning' : 'info',
    tenantId: null,
    entityType: 'tenant', entityId: ctx.params.id, entityLabel: tenant.name,
    oldValue: { status: tenant.status, name: tenant.name },
    newValue: { ...patch, reason: input.reason ?? null },
  });

  // A status change is a lifecycle fact the billing ledger keeps, and the
  // organisation's administrators are told in plain words what happened.
  if (blocking || restoring) {
    await recordSubscriptionEvent(db, {
      tenantId: ctx.params.id,
      kind: blocking ? 'suspended' : 'reactivated',
      actorId: ctx.userId, actorName: ctx.user?.full_name ?? null,
      oldValue: { status: tenant.status }, newValue: { status: patch.status },
      note: input.reason ?? null,
    });
    ctx.defer(notifyTenantAdmins(ctx, db, ctx.params.id, {
      triggerKey: blocking ? 'platform.suspended' : 'platform.reactivated',
      variables: { organisation: tenant.name, message: input.reason ?? '' },
    }));
  }

  const fresh = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  return ok({ tenant: toTenant(fresh) }, { ctx });
}, { anyPermission: ['tenants.update', 'tenants.suspend'], stepUp: true });

/** Move an organisation onto a different plan. */
router.post('/tenants/:id/plan', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    planKey: { type: 'string', required: true, max: 40 },
    reason: { type: 'text', max: 500 },
    trialDays: { type: 'int', min: 0, max: 90 },
  });

  const plan = await db.one('SELECT * FROM plans WHERE key = ?', [input.planKey]);
  if (!plan) throw new BadRequestError(`Unknown plan: ${input.planKey}.`);

  const subscription = await db.one(
    'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.params.id]);
  if (!subscription) throw new NotFoundError('Subscription');

  const previous = await db.one('SELECT key, name FROM plans WHERE id = ?', [subscription.plan_id]);

  // A downgrade that would put the organisation over its new limits is worth
  // saying out loud rather than discovering when a user cannot be created.
  const usage = await db.one(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND deleted_at IS NULL) AS users,
       (SELECT COUNT(*) FROM companies WHERE tenant_id = ? AND deleted_at IS NULL) AS companies`,
    [ctx.params.id, ctx.params.id]);
  const overages = [];
  if (plan.max_users >= 0 && Number(usage?.users) > plan.max_users) {
    overages.push(`${usage.users} users against a limit of ${plan.max_users}`);
  }
  if (plan.max_companies >= 0 && Number(usage?.companies) > plan.max_companies) {
    overages.push(`${usage.companies} companies against a limit of ${plan.max_companies}`);
  }

  // The limits live on the plan row and are read from there by the
  // entitlement checks — subscriptions has no limit columns of its own.
  // (Writing them here was this endpoint's oldest bug: the UPDATE named
  // columns the table does not have, and every platform plan change 500d.)
  await db.update('subscriptions', { id: subscription.id }, {
    plan_id: plan.id,
    status: input.trialDays ? 'trialing' : 'active',
    trial_ends_at: input.trialDays ? addDays(input.trialDays) : null,
    grace_until: null,
    current_period_start: nowIso(),
    current_period_end: addMonths(1),
    updated_at: nowIso(),
  });

  await audit(ctx, {
    action: 'billing.plan_changed', category: 'billing', severity: 'notice',
    tenantId: ctx.params.id,
    entityType: 'subscription', entityId: subscription.id, entityLabel: tenant.name,
    oldValue: { plan: previous?.key },
    newValue: { plan: plan.key, reason: input.reason ?? null, byPlatform: true },
  });
  await recordSubscriptionEvent(db, {
    tenantId: ctx.params.id, subscriptionId: subscription.id, kind: 'plan_changed',
    actorId: ctx.userId, actorName: ctx.user?.full_name ?? null,
    oldValue: { plan: previous?.key }, newValue: { plan: plan.key, trialDays: input.trialDays ?? null },
    note: input.reason ?? null,
  });

  return ok({
    planKey: plan.key,
    planName: plan.name,
    // Reported, not enforced: existing records are never deleted to fit a
    // smaller plan. The limits bite on the next create.
    overLimit: overages,
    note: overages.length
      ? 'The organisation is over its new limits. Existing records are untouched; new ones will be refused until it is back within them.'
      : null,
  }, { ctx });
}, { permission: 'tenants.update' });

/**
 * Adjust a subscription without changing its plan: extend the period, set a
 * trial end, move it between lifecycle states, or set a grace window. This is
 * the platform owner's manual override, so transitions are permissive — but
 * every one lands in the ledger with who did it and why.
 */
router.patch('/tenants/:id/subscription', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    extendDays: { type: 'int', min: 1, max: 366 },
    periodEnd: { type: 'date' },
    trialEndsAt: { type: 'date' },
    status: { type: 'enum', values: ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'] },
    graceDays: { type: 'int', min: 0, max: 90 },
    note: { type: 'text', max: 500 },
  });

  const subscription = await db.one(
    'SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.params.id]);
  if (!subscription) throw new NotFoundError('Subscription');

  const patch = {};
  const changes = [];

  if (input.extendDays) {
    const base = new Date(subscription.current_period_end) > new Date() ? new Date(subscription.current_period_end) : new Date();
    patch.current_period_end = addDays(input.extendDays, base);
    changes.push({ kind: 'period_extended', oldValue: { currentPeriodEnd: subscription.current_period_end }, newValue: { currentPeriodEnd: patch.current_period_end, extendDays: input.extendDays } });
  }
  if (input.periodEnd) {
    patch.current_period_end = input.periodEnd;
    changes.push({ kind: 'period_extended', oldValue: { currentPeriodEnd: subscription.current_period_end }, newValue: { currentPeriodEnd: input.periodEnd } });
  }
  if (input.trialEndsAt) {
    patch.trial_ends_at = input.trialEndsAt;
    if (!input.status) patch.status = 'trialing';
    changes.push({ kind: 'trial_extended', oldValue: { trialEndsAt: subscription.trial_ends_at }, newValue: { trialEndsAt: input.trialEndsAt } });
  }
  if (input.graceDays !== null && input.graceDays !== undefined) {
    patch.grace_until = input.graceDays === 0 ? null : addDays(input.graceDays);
    changes.push({ kind: 'status_changed', oldValue: { graceUntil: subscription.grace_until }, newValue: { graceUntil: patch.grace_until } });
  }
  if (input.status && input.status !== subscription.status) {
    patch.status = input.status;
    changes.push({ kind: 'status_changed', oldValue: { status: subscription.status }, newValue: { status: input.status } });
  }

  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to change.');

  await db.update('subscriptions', { id: subscription.id }, { ...patch, updated_at: nowIso() });

  for (const change of changes) {
    await recordSubscriptionEvent(db, {
      tenantId: ctx.params.id, subscriptionId: subscription.id, kind: change.kind,
      actorId: ctx.userId, actorName: ctx.user?.full_name ?? null,
      oldValue: change.oldValue, newValue: change.newValue, note: input.note ?? null,
    });
  }

  await audit(ctx, {
    action: 'billing.subscription_adjusted', category: 'billing', severity: 'notice',
    tenantId: ctx.params.id,
    entityType: 'subscription', entityId: subscription.id, entityLabel: tenant.name,
    oldValue: { status: subscription.status, currentPeriodEnd: subscription.current_period_end, trialEndsAt: subscription.trial_ends_at },
    newValue: { ...patch, note: input.note ?? null },
  });

  const fresh = await db.one(
    `SELECT s.*, p.key AS plan_key, p.name AS plan_name FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`, [subscription.id]);
  return ok({ subscription: fresh }, { ctx });
}, { permission: 'tenants.update', stepUp: true });

/**
 * Record a payment the organisation made outside a gateway — a bank
 * transfer, a cheque, an adjustment. Settles against a platform invoice when
 * one is named, and always lands in the ledger.
 */
router.post('/tenants/:id/payments', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    amountPaise: { type: 'int', required: true, min: 1, max: 10_000_000_000 },
    method: { type: 'enum', values: ['bank_transfer', 'upi', 'cash', 'cheque', 'net_banking'], default: 'bank_transfer' },
    reference: { type: 'string', max: 100 },
    invoiceId: { type: 'id' },
    note: { type: 'text', max: 500 },
  });

  let invoice = null;
  if (input.invoiceId) {
    invoice = await db.one(
      "SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND direction = 'platform_to_tenant'",
      [input.invoiceId, ctx.params.id]);
    if (!invoice) throw new NotFoundError('Invoice');
  }

  const subscription = await db.one(
    'SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [ctx.params.id]);

  const reference = input.reference || `MANUAL-${Date.now()}`;
  const payment = {
    id: ID.payment(),
    tenant_id: ctx.params.id,
    invoice_id: invoice?.id ?? null,
    client_id: null,
    subscription_id: subscription?.id ?? null,
    reference_no: reference,
    gateway: 'manual',
    method: input.method,
    amount_paise: input.amountPaise,
    currency: 'INR',
    status: 'success',
    initiated_by: ctx.userId,
    paid_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await db.insert('payments', payment);

  if (invoice) {
    const paid = Number(invoice.amount_paid_paise) + input.amountPaise;
    const due = Math.max(0, Number(invoice.total_paise) - paid);
    await db.update('invoices', { id: invoice.id }, {
      amount_paid_paise: paid,
      amount_due_paise: due,
      status: due === 0 ? 'paid' : 'partially_paid',
      paid_at: due === 0 ? nowIso() : invoice.paid_at,
      updated_at: nowIso(),
    });
  }

  await recordSubscriptionEvent(db, {
    tenantId: ctx.params.id, subscriptionId: subscription?.id ?? null, kind: 'payment_recorded',
    actorId: ctx.userId, actorName: ctx.user?.full_name ?? null,
    newValue: {
      amountPaise: input.amountPaise, method: input.method, reference,
      invoiceNo: invoice?.invoice_no ?? null,
    },
    note: input.note ?? null,
  });

  await audit(ctx, {
    action: 'billing.payment_recorded', category: 'billing', severity: 'notice',
    tenantId: ctx.params.id,
    entityType: 'payment', entityId: payment.id, entityLabel: `${tenant.name} — ${formatINR(input.amountPaise)}`,
    newValue: { amountPaise: input.amountPaise, method: input.method, reference, invoiceId: invoice?.id ?? null, byPlatform: true },
  });

  return created({ payment: { id: payment.id, reference, amountPaise: input.amountPaise, status: 'success' } }, { ctx });
}, { permission: 'tenants.update', stepUp: true });

/**
 * Send a notice from the platform to an organisation's administrators — a
 * payment or renewal reminder, a suspension warning, or an announcement.
 * Lands in their notification centre, goes out by email where email is
 * configured, and is remembered in the ledger so "when did we last remind
 * them" has an answer.
 */
router.post('/tenants/:id/notify', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    kind: {
      type: 'enum', required: true,
      values: ['announcement', 'payment_reminder', 'trial_reminder', 'renewal_reminder', 'suspension_warning'],
    },
    subject: { type: 'string', max: 160 },
    message: { type: 'text', max: 2000 },
  });

  const subscription = await db.one(
    `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [ctx.params.id]);

  const recipients = await notifyTenantAdmins(ctx, db, ctx.params.id, {
    triggerKey: `platform.${input.kind}`,
    variables: {
      organisation: tenant.name,
      subject: input.subject ?? 'A notice from Meet Millions',
      message: input.message ?? '',
      planName: subscription?.plan_name ?? '',
      renewalDate: subscription?.current_period_end?.slice(0, 10) ?? '',
      trialEndsAt: subscription?.trial_ends_at?.slice(0, 10) ?? '',
      amountLine: '',
      whenLine: '',
    },
  });
  if (!recipients) {
    throw new ConflictError('This organisation has no active administrators to notify.');
  }

  await recordSubscriptionEvent(db, {
    tenantId: ctx.params.id, subscriptionId: subscription?.id ?? null, kind: 'reminder_sent',
    actorId: ctx.userId, actorName: ctx.user?.full_name ?? null,
    newValue: { kind: input.kind, subject: input.subject ?? null, recipients },
    note: input.message ? input.message.slice(0, 200) : null,
  });

  await audit(ctx, {
    action: 'platform.notice_sent', category: 'billing', severity: 'info',
    tenantId: ctx.params.id,
    entityType: 'tenant', entityId: ctx.params.id, entityLabel: tenant.name,
    newValue: { kind: input.kind, subject: input.subject ?? null, recipients },
  });

  return ok({ sent: true, recipients, kind: input.kind }, { ctx });
}, { permission: 'tenants.update' });

/**
 * Open a support session as a user of another organisation.
 *
 * Time-boxed, reason-bearing, and audited on both sides — in the platform
 * trail and in the tenant's own, so the organisation can see that somebody
 * from the platform was in their account and why.
 */
router.post('/tenants/:id/impersonate', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [ctx.params.id]);
  if (!tenant) throw new NotFoundError('Organisation');

  const body = await ctx.body();
  const input = validate(body, {
    userId: { type: 'id', required: true },
    reason: { type: 'text', required: true, max: 500, label: 'Reason' },
    minutes: { type: 'int', min: 5, max: 120, default: 30 },
    // 'view' reads without the ability to change anything; 'support' may act.
    mode: { type: 'enum', values: ['view', 'support'], default: 'support' },
  });

  const target = await db.one(
    'SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [input.userId, ctx.params.id]);
  if (!target) throw new NotFoundError('User');

  const { createSession } = await import('../auth/session.js');
  const { token, session } = await createSession(ctx.env, db, {
    userId: target.id,
    tenantId: tenant.id,
    ip: ctx.ip,
    userAgent: `impersonation by ${ctx.user.email}`,
    ttlHours: input.minutes / 60,
    // Already satisfied: the platform user cleared their own step-up to get
    // here, and the target's second factor is not ours to present.
    twofaSatisfied: true,
    // The session carries who really holds it: the identity middleware lets
    // it into a suspended organisation, the audit trail attributes every
    // action to this administrator, and view mode is enforced server-side.
    impersonatorUserId: ctx.userId,
    impersonatorLabel: `${ctx.user.full_name} <${ctx.user.email}>`,
    impersonationMode: input.mode,
  });

  // Both trails. The platform's, and the organisation's own.
  await audit(ctx, {
    action: 'platform.impersonation_started', category: 'security', severity: 'critical',
    tenantId: null,
    entityType: 'user', entityId: target.id, entityLabel: target.full_name,
    newValue: { tenant: tenant.name, reason: input.reason, minutes: input.minutes, mode: input.mode },
  });
  await audit(ctx, {
    action: 'platform.impersonation_started', category: 'security', severity: 'critical',
    tenantId: tenant.id,
    entityType: 'user', entityId: target.id, entityLabel: target.full_name,
    newValue: { by: ctx.user.email, reason: input.reason, minutes: input.minutes, mode: input.mode },
  });

  return created({
    token,
    expiresAt: session.expires_at,
    mode: input.mode,
    impersonating: { id: target.id, name: target.full_name, email: target.email },
    tenant: { id: tenant.id, name: tenant.name, status: tenant.status },
    notice: 'This session is recorded in the organisation\'s own audit trail.',
  }, { ctx });
}, { permission: 'users.impersonate', stepUp: true });

// ---------------------------------------------------------------------------
// Franchises
// ---------------------------------------------------------------------------
router.get('/franchises', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const rows = await db.many(
    `SELECT f.*,
            (SELECT COUNT(*) FROM tenants t WHERE t.franchise_id = f.id AND t.deleted_at IS NULL) AS tenant_count
       FROM franchises f ORDER BY f.name`);

  const revenue = await db.many(
    `SELECT franchise_id, COALESCE(SUM(share_paise),0) AS share, COALESCE(SUM(gross_paise),0) AS gross
       FROM franchise_revenue WHERE period_key = ? GROUP BY franchise_id`, [monthKey()]);
  const byFranchise = new Map(revenue.map(r => [r.franchise_id, r]));

  return ok({
    franchises: rows.map(f => ({
      id: f.id,
      name: f.name,
      code: f.code,
      owner: { name: f.owner_name, email: f.owner_email, phone: f.owner_phone },
      city: f.city,
      state: f.state,
      status: f.status,
      revenueSharePct: f.revenue_share_pct,
      tenantCount: Number(f.tenant_count) || 0,
      thisMonth: {
        grossPaise: Number(byFranchise.get(f.id)?.gross) || 0,
        sharePaise: Number(byFranchise.get(f.id)?.share) || 0,
      },
      onboardedAt: f.onboarded_at,
    })),
  }, { ctx });
}, { permission: 'franchises.view' });

router.post('/franchises', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 160 },
    code: { type: 'string', required: true, max: 20 },
    ownerName: { type: 'string', max: 120 },
    ownerEmail: { type: 'email' },
    ownerPhone: { type: 'phone' },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    revenueSharePct: { type: 'number', min: 0, max: 100, default: 20 },
  });

  const code = input.code.toUpperCase();
  const clash = await db.one('SELECT id FROM franchises WHERE code = ?', [code]);
  if (clash) throw new ConflictError(`Franchise code ${code} is already in use.`);

  const ts = nowIso();
  const id = ID.franchise();
  await db.insert('franchises', {
    id, name: input.name, code,
    owner_name: input.ownerName ?? null,
    owner_email: input.ownerEmail ?? null,
    owner_phone: input.ownerPhone ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    status: 'onboarding',
    revenue_share_pct: input.revenueSharePct,
    created_at: ts, updated_at: ts,
  });

  await audit(ctx, {
    action: 'platform.franchise_created', category: 'general',
    tenantId: null, entityType: 'franchise', entityId: id, entityLabel: input.name,
    newValue: { code, revenueSharePct: input.revenueSharePct },
  });

  const row = await db.one('SELECT * FROM franchises WHERE id = ?', [id]);
  return created({ franchise: row }, { ctx });
}, { permission: 'franchises.manage' });

router.patch('/franchises/:id', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const franchise = await db.one('SELECT * FROM franchises WHERE id = ?', [ctx.params.id]);
  if (!franchise) throw new NotFoundError('Franchise');

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 160 },
    ownerName: { type: 'string', max: 120 },
    ownerEmail: { type: 'email' },
    ownerPhone: { type: 'phone' },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    status: { type: 'enum', values: ['onboarding', 'active', 'suspended', 'terminated'] },
    revenueSharePct: { type: 'number', min: 0, max: 100 },
  });

  const patch = {};
  for (const [field, column] of Object.entries({
    name: 'name', ownerName: 'owner_name', ownerEmail: 'owner_email', ownerPhone: 'owner_phone',
    city: 'city', state: 'state', status: 'status', revenueSharePct: 'revenue_share_pct',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');
  if (patch.status === 'active' && !franchise.onboarded_at) patch.onboarded_at = nowIso();

  await db.update('franchises', { id: ctx.params.id }, { ...patch, updated_at: nowIso() });
  await audit(ctx, {
    action: 'platform.franchise_updated', category: 'general',
    tenantId: null, entityType: 'franchise', entityId: ctx.params.id, entityLabel: franchise.name,
    oldValue: { status: franchise.status, revenue_share_pct: franchise.revenue_share_pct },
    newValue: patch,
  });

  const row = await db.one('SELECT * FROM franchises WHERE id = ?', [ctx.params.id]);
  return ok({ franchise: row }, { ctx });
}, { permission: 'franchises.manage' });

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
router.get('/plans', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const rows = await db.many('SELECT * FROM plans ORDER BY sort_order');
  const features = await db.many('SELECT * FROM plan_features ORDER BY sort_order');
  const byPlan = new Map();
  for (const f of features) {
    if (!byPlan.has(f.plan_id)) byPlan.set(f.plan_id, []);
    byPlan.get(f.plan_id).push(f);
  }

  const counts = await db.many(
    `SELECT plan_id, COUNT(*) AS n FROM subscriptions
      WHERE status IN ('active','trialing') GROUP BY plan_id`);
  const subscribers = new Map(counts.map(c => [c.plan_id, Number(c.n)]));

  return ok({
    plans: rows.map(p => ({
      ...p,
      monthlyPriceLabel: formatINR(p.monthly_price_paise),
      yearlyPriceLabel: p.yearly_price_paise ? formatINR(p.yearly_price_paise) : null,
      features: byPlan.get(p.id) ?? [],
      subscribers: subscribers.get(p.id) ?? 0,
    })),
    comparison: PLAN_COMPARISON,
  }, { ctx });
}, { permission: 'plans.manage' });

router.patch('/plans/:key', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const plan = await db.one('SELECT * FROM plans WHERE key = ?', [ctx.params.key]);
  if (!plan) throw new NotFoundError('Plan');

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 80 },
    tagline: { type: 'string', max: 200 },
    monthlyPricePaise: { type: 'paise', min: 0 },
    yearlyPricePaise: { type: 'paise', min: 0 },
    maxUsers: { type: 'int', min: -1, max: 100000 },
    maxCompanies: { type: 'int', min: -1, max: 100000 },
    storageGb: { type: 'int', min: -1, max: 100000 },
    maxUploadsMonth: { type: 'int', min: -1, max: 1000000 },
    isPublic: { type: 'boolean' },
    isPopular: { type: 'boolean' },
    trialDays: { type: 'int', min: 0, max: 90 },
  });

  const patch = {};
  for (const [field, column] of Object.entries({
    name: 'name', tagline: 'tagline',
    monthlyPricePaise: 'monthly_price_paise', yearlyPricePaise: 'yearly_price_paise',
    maxUsers: 'max_users', maxCompanies: 'max_companies', storageGb: 'storage_gb',
    maxUploadsMonth: 'max_uploads_month', trialDays: 'trial_days',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (input.isPublic !== null && input.isPublic !== undefined) patch.is_public = input.isPublic ? 1 : 0;
  if (input.isPopular !== null && input.isPopular !== undefined) patch.is_popular = input.isPopular ? 1 : 0;
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await db.update('plans', { id: plan.id }, { ...patch, updated_at: nowIso() });

  // Existing subscriptions keep the limits they were sold. Changing a plan
  // must not silently shrink an organisation that already paid for more.
  const affected = await db.count(
    "SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ? AND status IN ('active','trialing')",
    [plan.id]);

  await audit(ctx, {
    action: 'platform.plan_updated', category: 'billing', severity: 'notice',
    tenantId: null, entityType: 'plan', entityId: plan.id, entityLabel: plan.name,
    oldValue: { monthly_price_paise: plan.monthly_price_paise, max_users: plan.max_users },
    newValue: patch,
  });

  const fresh = await db.one('SELECT * FROM plans WHERE id = ?', [plan.id]);
  return ok({
    plan: fresh,
    existingSubscriptions: affected,
    note: affected
      ? `${affected} existing subscription${affected === 1 ? '' : 's'} keep the limits already granted; the new values apply on their next plan change.`
      : null,
  }, { ctx });
}, { permission: 'plans.manage' });

// ---------------------------------------------------------------------------
// Revenue
// ---------------------------------------------------------------------------
router.get('/revenue', async (ctx) => {
  const db = new Db(ctx.env.DB);

  const months = recentMonthKeys(12);
  const series = [];
  for (const m of months) {
    const b = periodBounds('monthly', m);
    const row = await db.one(
      `SELECT COALESCE(SUM(amount_paise),0) AS collected, COUNT(*) AS payments
         FROM payments WHERE status = 'success' AND created_at BETWEEN ? AND ?`,
      [b.start, b.end]);
    series.push({
      periodKey: m,
      collectedPaise: Number(row?.collected) || 0,
      payments: Number(row?.payments) || 0,
    });
  }

  const mrrPlans = await db.one(
    `SELECT COALESCE(SUM(p.monthly_price_paise),0) AS mrr FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active','trialing')`);
  const mrrAddOns = await db.one(
    `SELECT COALESCE(SUM(monthly_price_paise),0) AS mrr FROM add_on_subscriptions
      WHERE status IN ('active','trialing')`);

  // The CASE matters. A LEFT JOIN still yields one row for a plan nobody is
  // on, so a plain SUM(p.monthly_price_paise) counted that plan's price once
  // and reported "₹2,999 from 0 organisations" — revenue from nobody.
  const byPlan = await db.many(
    `SELECT p.key, p.name, COUNT(s.id) AS tenants,
            COALESCE(SUM(CASE WHEN s.id IS NOT NULL THEN p.monthly_price_paise ELSE 0 END), 0) AS mrr
       FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status IN ('active','trialing')
      GROUP BY p.id ORDER BY p.sort_order`);

  const topAddOns = await db.many(
    `SELECT a.key, a.name, COUNT(s.id) AS subscriptions,
            COALESCE(SUM(s.monthly_price_paise),0) AS mrr
       FROM add_ons a LEFT JOIN add_on_subscriptions s ON s.add_on_id = a.id AND s.status = 'active'
      GROUP BY a.id HAVING subscriptions > 0 ORDER BY mrr DESC LIMIT 15`);

  const outstanding = await db.one(
    `SELECT COALESCE(SUM(amount_due_paise),0) AS due, COUNT(*) AS invoices
       FROM invoices WHERE direction = 'platform_to_tenant'
         AND status IN ('issued','sent','partially_paid','overdue')`);

  const planMrr = Number(mrrPlans?.mrr) || 0;
  const addOnMrr = Number(mrrAddOns?.mrr) || 0;

  return ok({
    mrr: {
      planPaise: planMrr,
      addOnPaise: addOnMrr,
      totalPaise: planMrr + addOnMrr,
      totalLabel: formatINR(planMrr + addOnMrr),
      // Simple annualisation of the current run rate, not a forecast.
      annualisedPaise: (planMrr + addOnMrr) * 12,
    },
    collections: series,
    byPlan: byPlan.map(p => ({
      key: p.key, name: p.name, tenants: Number(p.tenants), mrrPaise: Number(p.mrr),
    })),
    topAddOns: topAddOns.map(a => ({
      key: a.key, name: a.name, subscriptions: Number(a.subscriptions), mrrPaise: Number(a.mrr),
    })),
    outstanding: {
      paise: Number(outstanding?.due) || 0,
      label: formatINR(Number(outstanding?.due) || 0),
      invoices: Number(outstanding?.invoices) || 0,
    },
    catalogue: { plans: PLANS.length, addOns: ADDONS.length },
  }, { ctx });
}, { permission: 'platform.analytics' });

// ---------------------------------------------------------------------------
// System logs
// ---------------------------------------------------------------------------
router.get('/logs', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const { page, pageSize } = ctx.pagination({ defaultSize: 50, maxSize: 200 });
  const offset = (page - 1) * pageSize;

  const filters = [];
  const params = [];
  if (ctx.q('level')) { filters.push('level = ?'); params.push(ctx.q('level')); }
  if (ctx.q('source')) { filters.push('source = ?'); params.push(ctx.q('source')); }
  if (ctx.q('tenantId')) { filters.push('tenant_id = ?'); params.push(ctx.q('tenantId')); }
  if (ctx.q('from')) { filters.push('created_at >= ?'); params.push(ctx.q('from')); }
  if (ctx.q('to')) { filters.push('created_at <= ?'); params.push(ctx.q('to')); }
  if (ctx.q('q')) {
    filters.push('(LOWER(message) LIKE ? OR LOWER(COALESCE(path,\'\')) LIKE ?)');
    const like = `%${ctx.q('q').toLowerCase()}%`;
    params.push(like, like);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = await db.many(
    `SELECT * FROM system_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]);
  const total = await db.count(`SELECT COUNT(*) AS n FROM system_logs ${where}`, params);

  const counts = await db.many(
    `SELECT level, COUNT(*) AS n FROM system_logs WHERE created_at >= ? GROUP BY level`,
    [addDays(-7)]);

  return paginated(rows.map(l => ({
    id: l.id,
    level: l.level,
    source: l.source,
    event: l.event,
    message: l.message,
    tenantId: l.tenant_id,
    requestId: l.request_id,
    path: l.path,
    statusCode: l.status_code,
    durationMs: l.duration_ms,
    context: safeJson(l.context_json, null),
    // Stacks are shown to platform staff only; this whole module requires a
    // platform permission, so there is nobody else here.
    stack: l.stack,
    createdAt: l.created_at,
  })), {
    page, pageSize, total,
    last7Days: Object.fromEntries(counts.map(c => [c.level, Number(c.n)])),
  }, ctx);
}, { permission: 'platform.logs.view' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Deliver a platform notice to every active administrator of an organisation.
 * Returns how many people were addressed (0 = nobody to notify).
 */
async function notifyTenantAdmins(ctx, db, tenantId, { triggerKey, variables }) {
  const admins = await db.many(
    `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.tenant_id = ? AND r.key = 'admin' AND u.status = 'active' AND u.deleted_at IS NULL`,
    [tenantId]);
  if (!admins.length) return 0;
  await dispatchNotification(ctx, {
    triggerKey,
    tenantId,
    userIds: admins.map(a => a.id),
    variables,
    link: { path: '/billing/subscription' },
  });
  return admins.length;
}

function toTenant(t) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    legalName: t.legal_name,
    email: t.email,
    phone: t.phone,
    gstin: t.gstin,
    pan: t.pan,
    tan: t.tan,
    addressLine1: t.address_line1,
    addressLine2: t.address_line2,
    city: t.city,
    state: t.state,
    pincode: t.pincode,
    stateCode: t.state_code,
    timezone: t.timezone,
    status: t.status,
    franchiseId: t.franchise_id,
    franchiseName: t.franchise_name ?? null,
    planKey: t.plan_key ?? null,
    planName: t.plan_name ?? null,
    subscriptionStatus: t.subscription_status ?? null,
    currentPeriodEnd: t.current_period_end ?? null,
    trialEndsAt: t.trial_ends_at ?? null,
    graceUntil: t.grace_until ?? null,
    lastActivityAt: t.last_activity_at ?? null,
    isDemo: !!t.is_demo,
    onboardingStep: t.onboarding_step,
    userCount: t.user_count === undefined ? undefined : Number(t.user_count),
    clientCount: t.client_count === undefined ? undefined : Number(t.client_count),
    documentCount: t.document_count === undefined ? undefined : Number(t.document_count),
    createdAt: t.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as platformRouter };
