/**
 * Billing: plans, subscriptions, invoices and payments.
 *
 * Invoices flow in two directions — the platform bills the firm for its
 * subscription and add-ons, and the firm bills its own clients for filing
 * work. Both use the same tables, distinguished by `direction`.
 *
 * Payments are only ever marked successful after the gateway confirms them
 * and the signature verifies; see `integrations/payments.js`.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import {
  BadRequestError, ConflictError, ForbiddenError, NotFoundError, IntegrationError,
} from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID, formatReference } from '../utils/id.js';
import { nowIso, addDays, addMonths, monthKey, periodBounds, daysBetween } from '../utils/time.js';
import { formatINR, pctOfPaise, sumPaise } from '../utils/money.js';
import { audit, recordActivity } from '../services/audit.js';
import { assertFeature, getEntitlements, entitlementsPayload, assertWithinLimit } from '../services/features.js';
import { dispatchNotification } from '../services/notifications.js';
import { paymentProvider, firstConfiguredProvider, describePaymentProviders } from '../integrations/payments.js';
import { PLAN_COMPARISON, PAYMENT_OPTIONS } from '../data/plans.js';
import { PdfDocument } from '../services/pdf.js';
import { loadClientIdsForUser } from '../auth/identity.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------
router.get('/plans', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const plans = await db.many(
    `SELECT * FROM plans WHERE is_public = 1 OR ? = 1 ORDER BY sort_order`,
    [ctx.has('plans.manage') ? 1 : 0]);

  const features = await db.many('SELECT * FROM plan_features');
  const byPlan = new Map();
  for (const f of features) {
    if (!byPlan.has(f.plan_id)) byPlan.set(f.plan_id, []);
    byPlan.get(f.plan_id).push(f);
  }

  const current = ctx.tenantId ? await getEntitlements(ctx) : null;

  return ok({
    plans: plans.map(p => ({
      id: p.id,
      key: p.key,
      name: p.name,
      tagline: p.tagline,
      monthlyPaise: p.monthly_price_paise,
      yearlyPaise: p.yearly_price_paise,
      monthlyFormatted: p.monthly_price_paise === 0 ? '₹0' : formatINR(p.monthly_price_paise, { decimals: 0 }),
      yearlyFormatted: p.yearly_price_paise === 0 ? '₹0' : formatINR(p.yearly_price_paise, { decimals: 0 }),
      maxUsers: p.max_users,
      maxCompanies: p.max_companies,
      storageGb: p.storage_gb,
      maxUploadsMonth: p.max_uploads_month,
      supportLevel: p.support_level,
      isPopular: !!p.is_popular,
      isPublic: !!p.is_public,
      trialDays: p.trial_days,
      features: (byPlan.get(p.id) ?? []).filter(f => f.enabled).map(f => f.feature_key),
      isCurrent: current?.planKey === p.key,
    })),
    comparison: PLAN_COMPARISON,
    paymentOptions: PAYMENT_OPTIONS,
  }, { ctx });
}, { auth: false });

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------
router.get('/subscription', async (ctx) => {
  const scope = scopeFor(ctx);
  const entitlements = await entitlementsPayload(ctx);

  const subscription = await scope.rawOne(
    `SELECT s.*, p.name AS plan_name, p.key AS plan_key, p.monthly_price_paise, p.yearly_price_paise
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [ctx.tenantId]);

  const addOns = await scope.raw(
    `SELECT s.*, a.key, a.name, a.category, a.icon, a.accent
       FROM add_on_subscriptions s JOIN add_ons a ON a.id = s.add_on_id
      WHERE s.tenant_id = ? AND s.status IN ('active','trialing','pending_payment')
      ORDER BY a.number`, [ctx.tenantId]);

  const addOnMonthly = sumPaise(addOns.filter(a => a.status === 'active').map(a => a.monthly_price_paise));
  const planMonthly = subscription
    ? (subscription.billing_cycle === 'yearly'
        ? Math.round(subscription.yearly_price_paise / 12)
        : subscription.monthly_price_paise)
    : 0;

  const invoices = await scope.raw(
    `SELECT * FROM invoices WHERE tenant_id = ? AND direction = 'platform_to_tenant'
      ORDER BY issue_date DESC LIMIT 12`, [ctx.tenantId]);

  return ok({
    subscription: subscription ? {
      id: subscription.id,
      planKey: subscription.plan_key,
      planName: subscription.plan_name,
      status: subscription.status,
      billingCycle: subscription.billing_cycle,
      seats: subscription.seats,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      trialEndsAt: subscription.trial_ends_at,
      autoRenew: !!subscription.auto_renew,
      cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
      daysToRenewal: subscription.current_period_end ? daysBetween(nowIso(), subscription.current_period_end) : null,
    } : null,
    entitlements,
    addOns: addOns.map(a => ({
      id: a.id, key: a.key, name: a.name, category: a.category,
      status: a.status, monthlyPaise: a.monthly_price_paise,
      activatedAt: a.activated_at, currentPeriodEnd: a.current_period_end,
      icon: a.icon, accent: a.accent,
    })),
    billing: {
      planMonthlyPaise: planMonthly,
      addOnMonthlyPaise: addOnMonthly,
      totalMonthlyPaise: planMonthly + addOnMonthly,
      totalMonthlyFormatted: formatINR(planMonthly + addOnMonthly),
    },
    invoices,
  }, { ctx });
}, { permission: 'billing.view' });

router.post('/subscription/change-plan', async (ctx) => {
  const scope = scopeFor(ctx);
  const db = new Db(ctx.env.DB);
  const body = await ctx.body();
  const input = validate(body, {
    planKey: { type: 'string', required: true, max: 30 },
    billingCycle: { type: 'enum', values: ['monthly', 'yearly'], default: 'monthly' },
    seats: { type: 'int', min: 1, max: 10000, default: 1 },
  });

  const plan = await db.one('SELECT * FROM plans WHERE key = ?', [input.planKey]);
  if (!plan) throw new NotFoundError('Plan');

  const current = await scope.rawOne(
    `SELECT s.*, p.key AS plan_key, p.name AS plan_name FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [ctx.tenantId]);

  // Downgrading below current usage would silently break things — refuse and
  // say exactly what is over the new limit.
  const blockers = [];
  if (plan.max_users >= 0) {
    const users = await scope.rawCount(
      `SELECT COUNT(*) FROM users WHERE tenant_id = ? AND deleted_at IS NULL
         AND status IN ('active','invited')`, [ctx.tenantId]);
    if (users > plan.max_users) {
      blockers.push(`You have ${users} users; the ${plan.name} plan allows ${plan.max_users}.`);
    }
  }
  if (plan.max_companies >= 0) {
    const companies = await scope.rawCount(
      `SELECT COUNT(*) FROM companies WHERE tenant_id = ? AND deleted_at IS NULL
         AND status != 'archived'`, [ctx.tenantId]);
    if (companies > plan.max_companies) {
      blockers.push(`You have ${companies} companies; the ${plan.name} plan allows ${plan.max_companies}.`);
    }
  }
  if (plan.storage_gb >= 0) {
    const used = await scope.rawCount(
      'SELECT COALESCE(SUM(size_bytes),0) FROM document_versions WHERE tenant_id = ?', [ctx.tenantId]);
    const limit = plan.storage_gb * 1024 * 1024 * 1024;
    if (used > limit) {
      blockers.push(`You are using ${(used / 1024 ** 3).toFixed(1)}GB; the ${plan.name} plan includes ${plan.storage_gb}GB.`);
    }
  }
  if (blockers.length) {
    throw new ConflictError('That plan is smaller than your current usage.', { blockers });
  }

  const unitPrice = input.billingCycle === 'yearly' ? plan.yearly_price_paise : plan.monthly_price_paise;

  if (current) {
    await scope.update('subscriptions', current.id, {
      plan_id: plan.id,
      billing_cycle: input.billingCycle,
      seats: input.seats,
      unit_price_paise: unitPrice,
      status: 'active',
      current_period_start: nowIso(),
      current_period_end: input.billingCycle === 'yearly' ? addMonths(12) : addMonths(1),
    });
  } else {
    await scope.insert('subscriptions', {
      id: ID.subscription(),
      plan_id: plan.id,
      status: 'active',
      billing_cycle: input.billingCycle,
      seats: input.seats,
      unit_price_paise: unitPrice,
      current_period_start: nowIso(),
      current_period_end: input.billingCycle === 'yearly' ? addMonths(12) : addMonths(1),
      auto_renew: 1,
    });
  }

  // A paid plan raises an invoice; the free plan does not.
  let invoice = null;
  if (unitPrice > 0) {
    invoice = await createInvoice(ctx, scope, {
      direction: 'platform_to_tenant',
      kind: 'subscription',
      items: [{
        description: `${plan.name} plan — ${input.billingCycle} (${input.seats} seat${input.seats === 1 ? '' : 's'})`,
        quantity: input.seats,
        unitPricePaise: unitPrice,
        taxRatePct: 18,
        sourceType: 'plan',
        sourceId: plan.id,
      }],
      dueInDays: 7,
      billingName: ctx.tenant?.name,
      billingEmail: ctx.user?.email,
      billingGstin: ctx.tenant?.gstin,
    });
  }

  await audit(ctx, {
    action: 'billing.plan_changed', category: 'billing', severity: 'notice',
    entityType: 'subscription', entityId: current?.id ?? null,
    entityLabel: plan.name,
    oldValue: current ? { plan: current.plan_key, cycle: current.billing_cycle, seats: current.seats } : null,
    newValue: { plan: plan.key, cycle: input.billingCycle, seats: input.seats },
  });

  const entitlements = await entitlementsPayload({ ...ctx, _entitlements: null });
  return ok({ plan: { key: plan.key, name: plan.name }, invoice, entitlements }, { ctx });
}, { permission: 'subscriptions.manage' });

router.post('/subscription/cancel', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    reason: { type: 'text', max: 1000 },
    immediate: { type: 'boolean', default: false },
  });

  const subscription = await scope.rawOne(
    `SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [ctx.tenantId]);
  if (!subscription) throw new NotFoundError('Subscription');

  await scope.update('subscriptions', subscription.id, {
    status: input.immediate ? 'cancelled' : subscription.status,
    cancel_at_period_end: input.immediate ? 0 : 1,
    cancelled_at: input.immediate ? nowIso() : null,
    cancellation_reason: input.reason,
    auto_renew: 0,
  });

  await audit(ctx, {
    action: 'billing.plan_changed', category: 'billing', severity: 'warning',
    entityType: 'subscription', entityId: subscription.id,
    newValue: { cancelled: true, immediate: input.immediate, reason: input.reason ?? null },
  });

  const updated = await scope.first('subscriptions', { id: subscription.id });
  return ok({
    subscription: updated,
    message: input.immediate
      ? 'Your subscription has been cancelled.'
      : `Your subscription will end on ${updated.current_period_end.slice(0, 10)}.`,
  }, { ctx });
}, { permission: 'subscriptions.manage' });

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
router.get('/invoices', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('invoices', 'i');
  await applyInvoiceVisibility(ctx, where);

  where.eqIf('i.direction', ctx.q('direction'));
  where.eqIf('i.client_id', ctx.q('clientId'));
  where.eqIf('i.kind', ctx.q('kind'));
  const statuses = ctx.qList('status');
  if (statuses.length) where.inIf('i.status', statuses);
  else where.eqIf('i.status', ctx.q('status'));
  if (ctx.qBool('openOnly')) where.inIf('i.status', ['issued', 'sent', 'partially_paid', 'overdue']);
  where.searchIf(['i.invoice_no', 'i.billing_name'], ctx.q('q'));
  where.betweenIf('i.issue_date', ctx.q('from'), ctx.q('to'));

  const { rows, total } = await scope.paginate('invoices', where, {
    columns: 'i.*, c.display_name AS client_name, c.client_code',
    joins: 'LEFT JOIN clients c ON c.id = i.client_id',
    alias: 'i',
    orderBy: `i.${safeOrder(ctx.q('sort', 'issue_date'), ctx.q('dir', 'desc'), ['issue_date', 'due_date', 'total_paise', 'status'], 'issue_date')}`,
    page, pageSize,
  });

  const summary = await scope.rawOne(
    `SELECT COALESCE(SUM(total_paise),0) AS billed,
            COALESCE(SUM(amount_paid_paise),0) AS collected,
            COALESCE(SUM(CASE WHEN status IN ('issued','sent','partially_paid','overdue')
                 THEN amount_due_paise ELSE 0 END),0) AS outstanding,
            COALESCE(SUM(CASE WHEN status = 'overdue' THEN amount_due_paise ELSE 0 END),0) AS overdue
       FROM invoices WHERE tenant_id = ? AND status != 'void'`, [ctx.tenantId]);

  return paginated(rows.map(toInvoice), {
    page, pageSize, total,
    summary: {
      billedPaise: Number(summary?.billed) || 0,
      collectedPaise: Number(summary?.collected) || 0,
      outstandingPaise: Number(summary?.outstanding) || 0,
      overduePaise: Number(summary?.overdue) || 0,
    },
  }, ctx);
}, { anyPermission: ['invoices.view', 'invoices.view.own'] });

router.get('/invoices/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const invoice = await getVisibleInvoice(ctx, scope, ctx.params.id);

  const items = await scope.all('invoice_items', { invoice_id: invoice.id }, { order: 'sort_order ASC' });
  const payments = await scope.all('payments', { invoice_id: invoice.id }, { order: 'created_at DESC' });
  const client = invoice.client_id ? await scope.first('clients', { id: invoice.client_id }) : null;

  return ok({
    invoice: toInvoice(invoice),
    items,
    payments: payments.map(toPayment),
    client,
    gateways: describePaymentProviders(ctx.env).filter(g => g.configured).map(g => ({
      key: g.key, name: g.name, methods: g.methods,
    })),
  }, { ctx });
}, { anyPermission: ['invoices.view', 'invoices.view.own'] });

router.post('/invoices', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    clientId: { type: 'id', required: true },
    filingPeriodId: { type: 'id' },
    items: { type: 'array', required: true, max: 50 },
    dueInDays: { type: 'int', min: 0, max: 365, default: 15 },
    notes: { type: 'text', max: 2000 },
    terms: { type: 'text', max: 2000 },
    issue: { type: 'boolean', default: true },
  });

  const client = await scope.getOrFail('clients', input.clientId, { resource: 'Client' });
  const company = await scope.first('companies', { id: client.company_id });

  const items = input.items.map((raw, i) => validate(raw, {
    description: { type: 'string', required: true, max: 300 },
    hsnSac: { type: 'string', max: 12 },
    quantity: { type: 'number', min: 0, default: 1 },
    unitPricePaise: { type: 'paise', required: true, min: 0 },
    discountPaise: { type: 'paise', min: 0, default: 0 },
    taxRatePct: { type: 'number', min: 0, max: 100, default: 18 },
  }));

  const invoice = await createInvoice(ctx, scope, {
    direction: 'tenant_to_client',
    kind: 'service',
    clientId: client.id,
    companyId: client.company_id,
    filingPeriodId: input.filingPeriodId,
    items,
    dueInDays: input.dueInDays,
    notes: input.notes,
    terms: input.terms,
    billingName: client.display_name,
    billingEmail: client.primary_contact_email,
    billingGstin: company?.gstin,
    placeOfSupply: company?.state_code,
    status: input.issue ? 'issued' : 'draft',
  });

  await audit(ctx, {
    action: 'billing.invoice_created', category: 'billing',
    entityType: 'invoice', entityId: invoice.id, entityLabel: invoice.invoice_no,
    newValue: { clientId: client.id, totalPaise: invoice.total_paise, items: items.length },
  });

  await recordActivity(ctx, {
    clientId: client.id, companyId: client.company_id,
    verb: 'invoiced', entityType: 'invoice', entityId: invoice.id,
    summary: `Invoice ${invoice.invoice_no} for ${formatINR(invoice.total_paise)} issued`,
    visibility: 'client', icon: 'receipt',
  });

  if (input.issue) {
    const contacts = await scope.raw(
      `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [client.id]);
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'invoice.issued',
      userIds: contacts.map(c => c.id),
      toEmail: contacts.length ? null : client.primary_contact_email,
      clientId: client.id,
      entityType: 'invoice', entityId: invoice.id,
      variables: {
        clientName: client.display_name,
        invoiceNo: invoice.invoice_no,
        amount: formatINR(invoice.total_paise),
        dueDate: invoice.due_date.slice(0, 10),
        organisation: ctx.tenant?.name ?? '',
        link: `${ctx.env.APP_URL || ''}/client/invoices/${invoice.id}`,
      },
      link: { path: `/client/invoices/${invoice.id}` },
    }));
  }

  return created({ invoice: toInvoice(invoice) }, { ctx });
}, { permission: 'invoices.create' });

router.post('/invoices/:id/void', async (ctx) => {
  const scope = scopeFor(ctx);
  const invoice = await scope.getOrFail('invoices', ctx.params.id, { resource: 'Invoice' });
  if (invoice.amount_paid_paise > 0) {
    throw new ConflictError('This invoice has payments against it. Refund them before voiding.');
  }

  const body = await ctx.body();
  const input = validate(body, { reason: { type: 'text', required: true, max: 1000 } });

  await scope.update('invoices', invoice.id, { status: 'void', notes: input.reason });

  await audit(ctx, {
    action: 'billing.invoice_voided', category: 'billing', severity: 'notice',
    entityType: 'invoice', entityId: invoice.id, entityLabel: invoice.invoice_no,
    oldValue: { status: invoice.status }, newValue: { status: 'void', reason: input.reason },
  });

  const updated = await scope.first('invoices', { id: invoice.id });
  return ok({ invoice: toInvoice(updated) }, { ctx });
}, { permission: 'invoices.void' });

/** A real PDF of the invoice. */
router.get('/invoices/:id/pdf', async (ctx) => {
  const scope = scopeFor(ctx);
  const invoice = await getVisibleInvoice(ctx, scope, ctx.params.id);
  const items = await scope.all('invoice_items', { invoice_id: invoice.id }, { order: 'sort_order ASC' });
  const payments = await scope.all('payments', { invoice_id: invoice.id }, { order: 'created_at ASC' });
  const branding = await scope.first('white_label_settings', { tenant_id: ctx.tenantId });

  const brand = branding?.enabled && branding.product_name
    ? branding.product_name : (ctx.tenant?.name || ctx.env.APP_NAME || 'Meet Millions Finance CRM');

  const doc = new PdfDocument({ title: `Invoice ${invoice.invoice_no}`, subject: invoice.billing_name ?? '' });
  doc.header({
    brand,
    title: `Invoice ${invoice.invoice_no}`,
    subtitle: invoice.billing_name ?? '',
    right: [
      { label: 'Status', value: String(invoice.status).replace(/_/g, ' ').toUpperCase() },
      { label: 'Amount due', value: formatINR(invoice.amount_due_paise) },
    ],
  });

  doc.eyebrow('Billing');
  doc.keyValues([
    ['Billed to', invoice.billing_name ?? '—'],
    ['Invoice date', invoice.issue_date.slice(0, 10)],
    ['GSTIN', invoice.billing_gstin ?? '—'],
    ['Due date', invoice.due_date.slice(0, 10)],
    ['Email', invoice.billing_email ?? '—'],
    ['Place of supply', invoice.place_of_supply ?? '—'],
  ]);

  doc.heading('Items');
  doc.table([
    { label: 'Description', key: 'description', width: 0.40 },
    { label: 'HSN/SAC', key: 'hsn', width: 0.12 },
    { label: 'Qty', key: 'qty', width: 0.08, align: 'right' },
    { label: 'Rate', key: 'rate', width: 0.14, align: 'right' },
    { label: 'Tax', key: 'tax', width: 0.12, align: 'right' },
    { label: 'Amount', key: 'amount', width: 0.14, align: 'right' },
  ], items.map(i => ({
    description: i.description,
    hsn: i.hsn_sac ?? '—',
    qty: String(i.quantity),
    rate: formatINR(i.unit_price_paise),
    tax: `${i.tax_rate_pct}%`,
    amount: formatINR(i.amount_paise),
  })));

  const totals = [
    ['Subtotal', formatINR(invoice.subtotal_paise)],
  ];
  if (invoice.discount_paise > 0) totals.push(['Discount', `- ${formatINR(invoice.discount_paise)}`]);
  if (invoice.cgst_paise > 0) totals.push(['CGST', formatINR(invoice.cgst_paise)]);
  if (invoice.sgst_paise > 0) totals.push(['SGST', formatINR(invoice.sgst_paise)]);
  if (invoice.igst_paise > 0) totals.push(['IGST', formatINR(invoice.igst_paise)]);
  totals.push(['Total', formatINR(invoice.total_paise), true]);
  if (invoice.amount_paid_paise > 0) {
    totals.push(['Paid', formatINR(invoice.amount_paid_paise)]);
    totals.push(['Amount due', formatINR(invoice.amount_due_paise), true]);
  }
  doc.totals(totals);

  if (payments.length) {
    doc.heading('Payments received');
    doc.table([
      { label: 'Receipt', key: 'receipt', width: 0.22 },
      { label: 'Date', key: 'date', width: 0.20 },
      { label: 'Method', key: 'method', width: 0.20 },
      { label: 'Gateway', key: 'gateway', width: 0.18 },
      { label: 'Amount', key: 'amount', width: 0.20, align: 'right' },
    ], payments.filter(p => p.status === 'success').map(p => ({
      receipt: p.receipt_no ?? p.reference_no,
      date: (p.paid_at ?? p.created_at).slice(0, 10),
      method: String(p.method ?? '—').replace(/_/g, ' '),
      gateway: p.gateway,
      amount: formatINR(p.amount_paise),
    })));
  }

  if (invoice.notes) { doc.heading('Notes'); doc.paragraph(invoice.notes); }
  if (invoice.terms) { doc.eyebrow('Terms'); doc.paragraph(invoice.terms, { size: 8, colour: '#6B7CA0' }); }

  doc.footer(`${brand} · Invoice ${invoice.invoice_no}`);

  return fileResponse(doc.render(), {
    contentType: 'application/pdf',
    fileName: `${invoice.invoice_no}.pdf`,
    download: ctx.qBool('download', true),
  });
}, { anyPermission: ['invoices.view', 'invoices.view.own'] });

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
router.get('/payments', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('payments', 'p');
  if (!ctx.has('payments.view') && ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) where.add('1 = 0'); else where.inIf('p.client_id', ids);
  }
  where.eqIf('p.status', ctx.q('status'));
  where.eqIf('p.gateway', ctx.q('gateway'));
  where.eqIf('p.client_id', ctx.q('clientId'));
  where.eqIf('p.invoice_id', ctx.q('invoiceId'));
  where.searchIf(['p.reference_no', 'p.gateway_payment_id', 'p.receipt_no'], ctx.q('q'));
  where.betweenIf('p.created_at', ctx.q('from'), ctx.q('to'));

  const { rows, total } = await scope.paginate('payments', where, {
    columns: 'p.*, i.invoice_no, c.display_name AS client_name',
    joins: `LEFT JOIN invoices i ON i.id = p.invoice_id
            LEFT JOIN clients c ON c.id = p.client_id`,
    alias: 'p',
    orderBy: `p.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'amount_paise', 'status'], 'created_at')}`,
    page, pageSize,
  });

  return paginated(rows.map(toPayment), { page, pageSize, total }, ctx);
}, { permission: 'payments.view' });

/** Start a gateway payment against an invoice. */
router.post('/payments/checkout', async (ctx) => {
  await assertFeature(ctx, 'payment_gateway');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    invoiceId: { type: 'id', required: true },
    gateway: { type: 'enum', values: ['razorpay', 'stripe', 'cashfree', 'phonepe'] },
    amountPaise: { type: 'paise', min: 100 },
    returnUrl: { type: 'string', max: 500 },
  });

  const invoice = await getVisibleInvoice(ctx, scope, input.invoiceId);
  if (['paid', 'void'].includes(invoice.status)) {
    throw new ConflictError(`Invoice ${invoice.invoice_no} is already ${invoice.status}.`);
  }

  const amount = input.amountPaise ?? invoice.amount_due_paise;
  if (amount <= 0) throw new BadRequestError('There is nothing left to pay on this invoice.');
  if (amount > invoice.amount_due_paise) {
    throw new BadRequestError(`That is more than the ${formatINR(invoice.amount_due_paise)} outstanding.`);
  }

  const provider = input.gateway
    ? paymentProvider(input.gateway, ctx.env)
    : firstConfiguredProvider(ctx.env);

  if (!provider) {
    throw new IntegrationError('Payment gateway',
      'No payment gateway is connected. Add credentials in Settings → Integrations.',
      { configured: false });
  }
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name,
      `${provider.name} is not connected. Missing: ${provider.missingKeys().join(', ')}.`,
      { configured: false, details: { missingKeys: provider.missingKeys() } });
  }

  const referenceNo = await nextPaymentReference(scope);
  const client = invoice.client_id ? await scope.first('clients', { id: invoice.client_id }) : null;

  const order = await provider.createOrder({
    amountPaise: amount,
    currency: invoice.currency ?? 'INR',
    receipt: referenceNo,
    notes: { invoiceId: invoice.id, invoiceNo: invoice.invoice_no, tenantId: ctx.tenantId },
    customer: {
      id: client?.id,
      name: invoice.billing_name ?? client?.display_name,
      email: invoice.billing_email ?? client?.primary_contact_email,
      phone: client?.primary_contact_phone,
    },
    returnUrl: input.returnUrl ?? `${ctx.env.APP_URL || ''}/client/invoices/${invoice.id}`,
    callbackUrl: `${ctx.env.APP_URL || ''}/webhooks/payments/${provider.key}`,
  });

  if (!order.ok) {
    // The gateway refused. Record the attempt; do not pretend it worked.
    const failed = await scope.insert('payments', {
      id: ID.payment(),
      invoice_id: invoice.id,
      client_id: invoice.client_id,
      reference_no: referenceNo,
      gateway: provider.key,
      amount_paise: amount,
      currency: invoice.currency ?? 'INR',
      status: 'failed',
      failure_code: order.error?.code ?? 'order_failed',
      failure_reason: order.error?.message ?? 'The gateway did not create an order.',
      initiated_by: ctx.userId,
    });

    await audit(ctx, {
      action: 'payments.failed', category: 'payments',
      entityType: 'payment', entityId: failed.id, entityLabel: referenceNo,
      result: 'failure',
      newValue: { gateway: provider.key, reason: order.error?.message },
    });

    throw new IntegrationError(provider.name, order.error?.message ?? 'The payment could not be started.',
      { configured: provider.isConfigured() });
  }

  const payment = await scope.insert('payments', {
    id: ID.payment(),
    invoice_id: invoice.id,
    client_id: invoice.client_id,
    reference_no: referenceNo,
    gateway: provider.key,
    amount_paise: amount,
    currency: invoice.currency ?? 'INR',
    status: 'created',
    gateway_order_id: order.data.orderId,
    idempotency_key: `${ctx.tenantId}:${invoice.id}:${referenceNo}`,
    initiated_by: ctx.userId,
  });

  await scope.insert('payment_transactions', {
    id: ID.transaction(),
    payment_id: payment.id,
    kind: 'order_created',
    status: 'created',
    amount_paise: amount,
    gateway_reference: order.data.orderId,
    response_json: JSON.stringify(order.data),
  });

  await audit(ctx, {
    action: 'payments.initiated', category: 'payments',
    entityType: 'payment', entityId: payment.id, entityLabel: referenceNo,
    newValue: { gateway: provider.key, amountPaise: amount, invoiceNo: invoice.invoice_no },
  });

  return created({
    payment: toPayment(payment),
    checkout: order.data.checkout,
    invoice: { id: invoice.id, invoiceNo: invoice.invoice_no, amountDuePaise: invoice.amount_due_paise },
  }, { ctx });
}, { permission: 'payments.pay' });

/** Confirm a payment the browser has completed. Signature-verified. */
router.post('/payments/:id/verify', async (ctx) => {
  const scope = scopeFor(ctx);
  const payment = await scope.getOrFail('payments', ctx.params.id, { resource: 'Payment' });

  if (payment.status === 'success') {
    return ok({ payment: toPayment(payment), alreadyVerified: true }, { ctx });
  }

  const body = await ctx.body();
  const input = validate(body, {
    gatewayPaymentId: { type: 'string', max: 120 },
    signature: { type: 'string', max: 256 },
  });

  const provider = paymentProvider(payment.gateway, ctx.env);
  if (!provider) throw new BadRequestError(`Unknown gateway: ${payment.gateway}`);

  const result = await provider.verifyPayment({
    orderId: payment.gateway_order_id,
    paymentId: input.gatewayPaymentId,
    signature: input.signature,
  });

  await scope.insert('payment_transactions', {
    id: ID.transaction(),
    payment_id: payment.id,
    kind: 'verify',
    status: result.ok ? 'success' : 'failed',
    amount_paise: payment.amount_paise,
    gateway_reference: input.gatewayPaymentId,
    response_json: JSON.stringify(result.ok ? result.data : result.error),
    error_code: result.ok ? null : result.error?.code,
    error_message: result.ok ? null : result.error?.message,
  });

  if (!result.ok) {
    await scope.update('payments', payment.id, {
      status: 'failed',
      failure_code: result.error?.code ?? 'verification_failed',
      failure_reason: result.error?.message ?? 'Verification failed.',
      retry_count: (payment.retry_count ?? 0) + 1,
    });

    await audit(ctx, {
      action: 'payments.failed', category: 'payments', severity: 'warning', result: 'failure',
      entityType: 'payment', entityId: payment.id, entityLabel: payment.reference_no,
      newValue: { reason: result.error?.message, code: result.error?.code },
    });

    const updated = await scope.first('payments', { id: payment.id });
    return ok({ payment: toPayment(updated), verified: false, error: result.error }, { ctx, status: 200 });
  }

  const settled = await settlePayment(ctx, scope, payment, {
    gatewayPaymentId: result.data.paymentId,
    signature: input.signature,
    method: result.data.method,
  });

  return ok({ payment: toPayment(settled.payment), invoice: toInvoice(settled.invoice), verified: true }, { ctx });
}, { permission: 'payments.pay' });

/** Record an offline payment — cash, cheque or a direct bank transfer. */
router.post('/payments/record', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    invoiceId: { type: 'id', required: true },
    amountPaise: { type: 'paise', required: true, min: 1 },
    method: { type: 'enum', required: true, values: ['bank_transfer', 'cash', 'cheque', 'upi'] },
    reference: { type: 'string', max: 120 },
    paidAt: { type: 'date' },
    notes: { type: 'text', max: 1000 },
  });

  const invoice = await scope.getOrFail('invoices', input.invoiceId, { resource: 'Invoice' });
  if (invoice.status === 'void') throw new ConflictError('That invoice has been voided.');
  if (input.amountPaise > invoice.amount_due_paise) {
    throw new BadRequestError(`That is more than the ${formatINR(invoice.amount_due_paise)} outstanding.`);
  }

  const referenceNo = await nextPaymentReference(scope);
  const payment = await scope.insert('payments', {
    id: ID.payment(),
    invoice_id: invoice.id,
    client_id: invoice.client_id,
    reference_no: referenceNo,
    gateway: 'offline',
    method: input.method,
    amount_paise: input.amountPaise,
    currency: invoice.currency ?? 'INR',
    status: 'created',
    gateway_payment_id: input.reference,
    notes_json: input.notes ? JSON.stringify({ notes: input.notes }) : null,
    initiated_by: ctx.userId,
  });

  const settled = await settlePayment(ctx, scope, payment, {
    gatewayPaymentId: input.reference ?? referenceNo,
    method: input.method,
    paidAt: input.paidAt,
    offline: true,
  });

  return created({ payment: toPayment(settled.payment), invoice: toInvoice(settled.invoice) }, { ctx });
}, { permission: 'payments.record' });

router.post('/payments/:id/refund', async (ctx) => {
  const scope = scopeFor(ctx);
  const payment = await scope.getOrFail('payments', ctx.params.id, { resource: 'Payment' });
  if (payment.status !== 'success') throw new ConflictError('Only a successful payment can be refunded.');

  const body = await ctx.body();
  const input = validate(body, {
    amountPaise: { type: 'paise', min: 1 },
    reason: { type: 'text', required: true, max: 1000 },
  });

  const refundable = payment.amount_paise - (payment.refunded_paise ?? 0);
  const amount = input.amountPaise ?? refundable;
  if (amount > refundable) {
    throw new BadRequestError(`Only ${formatINR(refundable)} is left to refund on this payment.`);
  }

  let providerResult = { ok: true, data: { refundId: null } };
  if (payment.gateway !== 'offline' && payment.gateway !== 'manual') {
    const provider = paymentProvider(payment.gateway, ctx.env);
    providerResult = await provider.refund({
      paymentId: payment.gateway_payment_id,
      amountPaise: amount,
      notes: { reason: input.reason },
    });
    if (!providerResult.ok) {
      throw new IntegrationError(provider.name,
        providerResult.error?.message ?? 'The refund was not accepted by the gateway.');
    }
  }

  const refundedTotal = (payment.refunded_paise ?? 0) + amount;
  await scope.update('payments', payment.id, {
    refunded_paise: refundedTotal,
    status: refundedTotal >= payment.amount_paise ? 'refunded' : 'partially_refunded',
  });

  await scope.insert('payment_transactions', {
    id: ID.transaction(),
    payment_id: payment.id,
    kind: 'refund',
    status: 'success',
    amount_paise: amount,
    gateway_reference: providerResult.data?.refundId ?? null,
    response_json: JSON.stringify({ reason: input.reason, ...providerResult.data }),
  });

  // Put the amount back on the invoice.
  if (payment.invoice_id) {
    const invoice = await scope.first('invoices', { id: payment.invoice_id });
    if (invoice) {
      const paid = Math.max(0, (invoice.amount_paid_paise ?? 0) - amount);
      await scope.update('invoices', invoice.id, {
        amount_paid_paise: paid,
        amount_due_paise: invoice.total_paise - paid,
        status: paid === 0 ? 'issued' : 'partially_paid',
        paid_at: null,
      });
    }
  }

  await audit(ctx, {
    action: 'payments.refunded', category: 'payments', severity: 'notice',
    entityType: 'payment', entityId: payment.id, entityLabel: payment.reference_no,
    newValue: { amountPaise: amount, reason: input.reason, refundId: providerResult.data?.refundId ?? null },
  });

  const updated = await scope.first('payments', { id: payment.id });
  return ok({ payment: toPayment(updated), refundedPaise: amount }, { ctx });
}, { permission: 'payments.refund', stepUp: false });

/** A receipt PDF for a settled payment. */
router.get('/payments/:id/receipt', async (ctx) => {
  const scope = scopeFor(ctx);
  const payment = await scope.getOrFail('payments', ctx.params.id, { resource: 'Payment' });
  if (payment.status !== 'success') throw new ConflictError('A receipt is only issued for a settled payment.');

  const invoice = payment.invoice_id ? await scope.first('invoices', { id: payment.invoice_id }) : null;
  const brand = ctx.tenant?.name || ctx.env.APP_NAME || 'Meet Millions Finance CRM';

  const doc = new PdfDocument({ title: `Receipt ${payment.receipt_no ?? payment.reference_no}` });
  doc.header({
    brand,
    title: `Receipt ${payment.receipt_no ?? payment.reference_no}`,
    subtitle: invoice?.billing_name ?? '',
    right: [{ label: 'Amount', value: formatINR(payment.amount_paise) }],
  });
  doc.eyebrow('Payment details');
  doc.keyValues([
    ['Received from', invoice?.billing_name ?? '—'],
    ['Paid on', (payment.paid_at ?? payment.created_at).slice(0, 10)],
    ['Against invoice', invoice?.invoice_no ?? '—'],
    ['Method', String(payment.method ?? '—').replace(/_/g, ' ')],
    ['Gateway', payment.gateway],
    ['Gateway reference', payment.gateway_payment_id ?? '—'],
  ]);
  doc.totals([['Amount received', formatINR(payment.amount_paise), true]]);
  doc.paragraph('This is a computer-generated receipt and does not require a signature.',
    { size: 8, colour: '#6B7CA0' });
  doc.footer(`${brand} · Receipt ${payment.receipt_no ?? payment.reference_no}`);

  return fileResponse(doc.render(), {
    contentType: 'application/pdf',
    fileName: `${payment.receipt_no ?? payment.reference_no}.pdf`,
    download: true,
  });
}, { permission: 'payments.view' });

/** Which gateways are connected — the Gateway Settings screen. */
router.get('/gateways', async (ctx) => {
  return ok(describePaymentProviders(ctx.env), { ctx });
}, { anyPermission: ['billing.view', 'integrations.view'] });

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build an invoice with GST split correctly for intra vs inter-state. */
export async function createInvoice(ctx, scope, {
  direction, kind, clientId = null, companyId = null, filingPeriodId = null, subscriptionId = null,
  items, dueInDays = 15, notes = null, terms = null, status = 'issued',
  billingName = null, billingEmail = null, billingGstin = null, billingAddress = null,
  placeOfSupply = null,
}) {
  const invoiceNo = await nextInvoiceNumber(scope);
  const supplierState = ctx.tenant?.state_code ?? '33';
  const interState = placeOfSupply ? String(placeOfSupply) !== String(supplierState) : false;

  let subtotal = 0, discount = 0, cgst = 0, sgst = 0, igst = 0;
  const prepared = items.map((item, index) => {
    const gross = Math.round((item.unitPricePaise ?? 0) * (item.quantity ?? 1));
    const itemDiscount = item.discountPaise ?? 0;
    const net = Math.max(0, gross - itemDiscount);
    const tax = pctOfPaise(net, item.taxRatePct ?? 18);

    subtotal += net;
    discount += itemDiscount;
    if (interState) igst += tax;
    else {
      const half = pctOfPaise(net, (item.taxRatePct ?? 18) / 2);
      cgst += half;
      sgst += tax - half;
    }

    return {
      id: ID.invoiceItem(),
      description: item.description,
      hsn_sac: item.hsnSac ?? null,
      quantity: item.quantity ?? 1,
      unit_price_paise: item.unitPricePaise ?? 0,
      discount_paise: itemDiscount,
      tax_rate_pct: item.taxRatePct ?? 18,
      tax_paise: tax,
      amount_paise: net + tax,
      source_type: item.sourceType ?? null,
      source_id: item.sourceId ?? null,
      sort_order: index * 10,
    };
  });

  const taxTotal = cgst + sgst + igst;
  const total = subtotal + taxTotal;

  const invoice = await scope.insert('invoices', {
    id: ID.invoice(),
    client_id: clientId,
    company_id: companyId,
    subscription_id: subscriptionId,
    filing_period_id: filingPeriodId,
    invoice_no: invoiceNo,
    direction,
    kind,
    status,
    currency: 'INR',
    subtotal_paise: subtotal,
    discount_paise: discount,
    tax_paise: taxTotal,
    cgst_paise: cgst,
    sgst_paise: sgst,
    igst_paise: igst,
    total_paise: total,
    amount_paid_paise: 0,
    amount_due_paise: total,
    issue_date: nowIso(),
    due_date: addDays(dueInDays),
    notes,
    terms,
    billing_name: billingName,
    billing_email: billingEmail,
    billing_gstin: billingGstin,
    billing_address: billingAddress,
    place_of_supply: placeOfSupply,
    created_by: ctx.userId,
  });

  for (const item of prepared) {
    await scope.insert('invoice_items', { ...item, invoice_id: invoice.id });
  }

  return invoice;
}

/** Mark a payment successful and apply it to its invoice. */
export async function settlePayment(ctx, scope, payment, {
  gatewayPaymentId, signature = null, method = null, paidAt = null, offline = false,
}) {
  const settledAt = paidAt ?? nowIso();
  const receiptNo = await nextReceiptNumber(scope);

  await scope.update('payments', payment.id, {
    status: 'success',
    gateway_payment_id: gatewayPaymentId ?? payment.gateway_payment_id,
    gateway_signature: signature,
    method: method ?? payment.method,
    receipt_no: receiptNo,
    paid_at: settledAt,
    failure_code: null,
    failure_reason: null,
  });

  await scope.insert('payment_transactions', {
    id: ID.transaction(),
    payment_id: payment.id,
    kind: offline ? 'capture' : 'capture',
    status: 'success',
    amount_paise: payment.amount_paise,
    gateway_reference: gatewayPaymentId,
    response_json: JSON.stringify({ offline, method, settledAt }),
  });

  let invoice = null;
  if (payment.invoice_id) {
    invoice = await scope.first('invoices', { id: payment.invoice_id });
    if (invoice) {
      const paid = (invoice.amount_paid_paise ?? 0) + payment.amount_paise;
      const due = Math.max(0, invoice.total_paise - paid);
      await scope.update('invoices', invoice.id, {
        amount_paid_paise: paid,
        amount_due_paise: due,
        status: due === 0 ? 'paid' : 'partially_paid',
        paid_at: due === 0 ? settledAt : null,
      });
      invoice = await scope.first('invoices', { id: invoice.id });

      // A fully paid filing invoice advances the filing period.
      if (due === 0 && invoice.filing_period_id) {
        const period = await scope.first('filing_periods', { id: invoice.filing_period_id });
        if (period && ['signed_off', 'approved', 'client_review'].includes(period.status)) {
          await scope.update('filing_periods', period.id, { status: 'paid' });
        }
      }
    }
  }

  await audit(ctx, {
    action: 'payments.succeeded', category: 'payments',
    entityType: 'payment', entityId: payment.id, entityLabel: payment.reference_no,
    newValue: {
      amountPaise: payment.amount_paise, gateway: payment.gateway,
      method, receiptNo, invoiceNo: invoice?.invoice_no ?? null,
    },
  });

  if (payment.client_id) {
    await recordActivity(ctx, {
      clientId: payment.client_id,
      verb: 'paid', entityType: 'payment', entityId: payment.id,
      summary: `Payment of ${formatINR(payment.amount_paise)} received`,
      visibility: 'client', icon: 'check-circle',
    });

    const contacts = await scope.raw(
      `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [payment.client_id]);
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'payment.successful',
      userIds: contacts.map(c => c.id),
      toEmail: contacts.length ? null : invoice?.billing_email,
      clientId: payment.client_id,
      entityType: 'payment', entityId: payment.id,
      variables: {
        clientName: invoice?.billing_name ?? '',
        amount: formatINR(payment.amount_paise),
        invoiceNo: invoice?.invoice_no ?? '',
        receiptNo,
        paidAt: settledAt.slice(0, 10),
        method: String(method ?? '').replace(/_/g, ' '),
        link: `${ctx.env.APP_URL || ''}/client/payments`,
      },
      link: { path: '/client/payments' },
    }));
  }

  const updated = await scope.first('payments', { id: payment.id });
  return { payment: updated, invoice };
}

async function nextInvoiceNumber(scope) {
  const year = new Date().getUTCFullYear();
  const count = await scope.rawCount(
    'SELECT COUNT(*) FROM invoices WHERE tenant_id = ? AND invoice_no LIKE ?',
    [scope.tenantId, `INV-${year}-%`]);
  return formatReference('INV', year, count + 1);
}

async function nextPaymentReference(scope) {
  const year = new Date().getUTCFullYear();
  const count = await scope.rawCount(
    'SELECT COUNT(*) FROM payments WHERE tenant_id = ? AND reference_no LIKE ?',
    [scope.tenantId, `PAY-${year}-%`]);
  return formatReference('PAY', year, count + 1);
}

async function nextReceiptNumber(scope) {
  const year = new Date().getUTCFullYear();
  const count = await scope.rawCount(
    'SELECT COUNT(*) FROM payments WHERE tenant_id = ? AND receipt_no IS NOT NULL AND receipt_no LIKE ?',
    [scope.tenantId, `RCP-${year}-%`]);
  return formatReference('RCP', year, count + 1);
}

async function applyInvoiceVisibility(ctx, where) {
  if (ctx.has('invoices.view')) return true;
  if (ctx.has('invoices.view.own') || ctx.isClient) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.length) { where.add('1 = 0'); return false; }
    where.inIf('i.client_id', ids);
    where.add("i.status != 'draft'");
    return true;
  }
  throw new ForbiddenError('You do not have permission to view invoices.');
}

async function getVisibleInvoice(ctx, scope, invoiceId) {
  const invoice = await scope.first('invoices', { id: invoiceId });
  if (!invoice) throw new NotFoundError('Invoice');
  if (!ctx.has('invoices.view')) {
    const db = new Db(ctx.env.DB);
    const ids = await loadClientIdsForUser(db, ctx.userId, ctx.tenantId);
    if (!ids.includes(invoice.client_id) || invoice.status === 'draft') throw new NotFoundError('Invoice');
  }
  return invoice;
}

function toInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    invoiceNo: row.invoice_no,
    direction: row.direction,
    kind: row.kind,
    status: row.status,
    clientId: row.client_id,
    clientName: row.client_name ?? row.billing_name ?? null,
    clientCode: row.client_code ?? null,
    filingPeriodId: row.filing_period_id,
    currency: row.currency,
    subtotalPaise: row.subtotal_paise,
    discountPaise: row.discount_paise,
    taxPaise: row.tax_paise,
    cgstPaise: row.cgst_paise,
    sgstPaise: row.sgst_paise,
    igstPaise: row.igst_paise,
    totalPaise: row.total_paise,
    amountPaidPaise: row.amount_paid_paise,
    amountDuePaise: row.amount_due_paise,
    totalFormatted: formatINR(row.total_paise),
    dueFormatted: formatINR(row.amount_due_paise),
    issueDate: row.issue_date,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    overdue: ['issued', 'sent', 'partially_paid'].includes(row.status) && row.due_date < nowIso(),
    daysToDue: row.due_date ? daysBetween(nowIso(), row.due_date) : null,
    notes: row.notes,
    terms: row.terms,
    billingName: row.billing_name,
    billingEmail: row.billing_email,
    billingGstin: row.billing_gstin,
    placeOfSupply: row.place_of_supply,
    reminderCount: row.reminder_count,
    createdAt: row.created_at,
  };
}

function toPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    referenceNo: row.reference_no,
    receiptNo: row.receipt_no,
    invoiceId: row.invoice_id,
    invoiceNo: row.invoice_no ?? null,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    gateway: row.gateway,
    method: row.method,
    amountPaise: row.amount_paise,
    amountFormatted: formatINR(row.amount_paise),
    currency: row.currency,
    status: row.status,
    gatewayOrderId: row.gateway_order_id,
    gatewayPaymentId: row.gateway_payment_id,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    refundedPaise: row.refunded_paise,
    retryCount: row.retry_count,
    paidAt: row.paid_at,
    createdAt: row.created_at,
  };
}

export { router as billingRouter, toInvoice, toPayment, nextPaymentReference };
