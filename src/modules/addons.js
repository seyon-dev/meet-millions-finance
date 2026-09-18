/**
 * The Add-On Marketplace.
 *
 * All 30 modules from the addendum, plus the Cloud Calling system, are rows in
 * `add_ons`. Activating one writes an `add_on_subscriptions` row, which the
 * feature layer reads to unlock capabilities — no deploy, no code change.
 * Deactivating reverses it, and the core CRM keeps working either way.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addMonths, monthKey } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit } from '../services/audit.js';
import { getEntitlements, entitlementsPayload, FEATURES } from '../services/features.js';
import { createInvoice } from './billing.js';
import {
  ADDON_CATEGORIES, ADDON_BUNDLES, CALLING_FEATURE_GROUPS, TELEPHONY_PROVIDERS, getAddOn,
} from '../data/addons.js';
import { describeAllIntegrations } from '../services/integrations.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const rows = await db.many(
    'SELECT * FROM add_ons WHERE is_available = 1 ORDER BY number');
  const active = await scope.all('add_on_subscriptions', {}, { order: 'created_at DESC', limit: 100 });
  const activeByAddOn = new Map(active.map(a => [a.add_on_id, a]));

  const entitlements = await getEntitlements(ctx);
  const integrationStatus = await describeAllIntegrations(ctx);
  const byProvider = new Map(integrationStatus.map(i => [i.key, i]));

  const category = ctx.q('category');
  const search = (ctx.q('q') || '').toLowerCase();

  const addOns = rows
    .filter(r => !category || String(r.category_no) === String(category) || r.category === category)
    .filter(r => !search
      || r.name.toLowerCase().includes(search)
      || r.description.toLowerCase().includes(search)
      || safeJson(r.features_json, []).some(f => String(f).toLowerCase().includes(search)))
    .map(r => {
      const subscription = activeByAddOn.get(r.id);
      const providerKeys = safeJson(r.provider_keys_json, []);
      const requiredEnv = providerKeys.filter(k => !ctx.env[k] || String(ctx.env[k]).startsWith('replace-with-'));

      return {
        id: r.id,
        key: r.key,
        number: r.number,
        name: r.name,
        category: r.category,
        categoryNo: r.category_no,
        description: r.description,
        businessBenefit: r.business_benefit,
        workflow: r.workflow,
        features: safeJson(r.features_json, []),
        uiScreens: safeJson(r.ui_screens_json, []),
        userRoles: safeJson(r.user_roles_json, []),
        apisRequired: safeJson(r.apis_required_json, []),
        providerKeys,
        bestPlan: r.best_plan,
        bestPlanKeys: safeJson(r.best_plan_keys_json, []),
        monthlyPaise: r.monthly_price_paise,
        setupPaise: r.setup_fee_paise,
        monthlyFormatted: formatINR(r.monthly_price_paise, { decimals: 0 }),
        setupFormatted: formatINR(r.setup_fee_paise, { decimals: 0 }),
        featureKeys: safeJson(r.feature_keys_json, []),
        icon: r.icon,
        accent: r.accent,
        requiresCredentials: !!r.requires_credentials,
        // Live state
        status: subscription?.status ?? 'inactive',
        isActive: subscription?.status === 'active' || subscription?.status === 'trialing',
        activatedAt: subscription?.activated_at ?? null,
        currentPeriodEnd: subscription?.current_period_end ?? null,
        subscriptionId: subscription?.id ?? null,
        // Whether the vendor credentials this module needs are present
        credentialsReady: r.requires_credentials ? requiredEnv.length === 0 : true,
        missingCredentials: requiredEnv,
        connectionStatus: byProvider.get(providerKeyFor(r.key))?.status ?? null,
        recommendedForPlan: safeJson(r.best_plan_keys_json, []).includes(entitlements.planKey),
      };
    });

  const activeCount = addOns.filter(a => a.isActive).length;
  const monthlySpend = addOns.filter(a => a.isActive).reduce((s, a) => s + a.monthlyPaise, 0);

  return ok({
    addOns,
    categories: ADDON_CATEGORIES.map(c => ({
      ...c,
      count: rows.filter(r => r.category_no === c.no).length,
      activeCount: addOns.filter(a => a.categoryNo === c.no && a.isActive).length,
    })),
    bundles: ADDON_BUNDLES.map(b => ({
      ...b,
      monthlyFormatted: formatINR(b.monthlyPaise, { decimals: 0 }),
      setupFormatted: formatINR(b.setupPaise, { decimals: 0 }),
      recommended: b.plan === entitlements.planKey,
    })),
    summary: {
      total: rows.filter(r => r.number <= 30).length,
      active: activeCount,
      monthlySpendPaise: monthlySpend,
      monthlySpendFormatted: formatINR(monthlySpend, { decimals: 0 }),
      planKey: entitlements.planKey,
    },
  }, { ctx });
}, { permission: 'addons.view' });

router.get('/:key', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const row = await db.one('SELECT * FROM add_ons WHERE key = ?', [ctx.params.key]);
  if (!row) throw new NotFoundError('Add-on');

  const subscription = await scope.first('add_on_subscriptions', { add_on_id: row.id });
  const usage = subscription
    ? await scope.raw(
        `SELECT metric, period_key, value FROM add_on_usage
          WHERE tenant_id = ? AND add_on_id = ? AND period_key = ?`,
        [ctx.tenantId, row.id, monthKey()])
    : [];

  const providerKeys = safeJson(row.provider_keys_json, []);
  const missing = providerKeys.filter(k => !ctx.env[k] || String(ctx.env[k]).startsWith('replace-with-'));
  const definition = getAddOn(row.key);

  return ok({
    addOn: {
      id: row.id, key: row.key, number: row.number, name: row.name,
      category: row.category, categoryNo: row.category_no,
      description: row.description, businessBenefit: row.business_benefit,
      workflow: row.workflow,
      features: safeJson(row.features_json, []),
      uiScreens: safeJson(row.ui_screens_json, []),
      userRoles: safeJson(row.user_roles_json, []),
      apisRequired: safeJson(row.apis_required_json, []),
      providerKeys,
      bestPlan: row.best_plan,
      monthlyPaise: row.monthly_price_paise,
      setupPaise: row.setup_fee_paise,
      monthlyFormatted: formatINR(row.monthly_price_paise, { decimals: 0 }),
      setupFormatted: formatINR(row.setup_fee_paise, { decimals: 0 }),
      featureKeys: safeJson(row.feature_keys_json, []),
      icon: row.icon, accent: row.accent,
      route: definition?.route ?? null,
      requiresCredentials: !!row.requires_credentials,
    },
    subscription: subscription ? {
      id: subscription.id,
      status: subscription.status,
      activatedAt: subscription.activated_at,
      deactivatedAt: subscription.deactivated_at,
      billingCycle: subscription.billing_cycle,
      monthlyPaise: subscription.monthly_price_paise,
      setupFeeCharged: !!subscription.setup_fee_charged,
      currentPeriodEnd: subscription.current_period_end,
      config: safeJson(subscription.config_json, {}),
    } : null,
    usage: usage.map(u => ({ metric: u.metric, periodKey: u.period_key, value: Number(u.value) })),
    credentials: {
      ready: row.requires_credentials ? missing.length === 0 : true,
      required: providerKeys,
      missing,
      note: missing.length
        ? `Add ${missing.join(', ')} to this deployment's secrets before this module can reach its provider.`
        : null,
    },
    unlocks: safeJson(row.feature_keys_json, []).map(k => ({
      key: k, name: FEATURES[k]?.name ?? k,
    })),
    // The Cloud Calling module carries its full feature table.
    callingFeatureGroups: row.key === 'cloud_calling_system' || row.key === 'cloud_telephony'
      ? CALLING_FEATURE_GROUPS : null,
    telephonyProviders: row.key === 'cloud_calling_system' || row.key === 'cloud_telephony'
      ? TELEPHONY_PROVIDERS : null,
  }, { ctx });
}, { permission: 'addons.view' });

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
router.post('/:key/activate', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const addOn = await db.one('SELECT * FROM add_ons WHERE key = ?', [ctx.params.key]);
  if (!addOn) throw new NotFoundError('Add-on');
  if (!addOn.is_available) throw new ConflictError('That module is not available at the moment.');

  const body = await ctx.body();
  const input = validate(body, {
    billingCycle: { type: 'enum', values: ['monthly', 'yearly'], default: 'monthly' },
    config: { type: 'json' },
    acknowledgeSetupFee: { type: 'boolean', default: false },
  });

  const existing = await scope.first('add_on_subscriptions', { add_on_id: addOn.id });
  if (existing && ['active', 'trialing'].includes(existing.status)) {
    throw new ConflictError(`${addOn.name} is already active.`);
  }

  // The setup fee is charged once, ever — a reactivation does not re-charge.
  const chargeSetupFee = addOn.setup_fee_paise > 0 && !existing?.setup_fee_charged;
  if (chargeSetupFee && !input.acknowledgeSetupFee) {
    throw new ConflictError(
      `${addOn.name} carries a one-time setup fee of ${formatINR(addOn.setup_fee_paise, { decimals: 0 })}. Confirm to continue.`,
      { setupFeePaise: addOn.setup_fee_paise, monthlyPaise: addOn.monthly_price_paise });
  }

  const ts = nowIso();
  const periodEnd = input.billingCycle === 'yearly' ? addMonths(12) : addMonths(1);

  let subscription;
  if (existing) {
    await scope.update('add_on_subscriptions', existing.id, {
      status: 'active',
      activated_at: ts,
      activated_by: ctx.userId,
      deactivated_at: null,
      deactivated_by: null,
      billing_cycle: input.billingCycle,
      monthly_price_paise: addOn.monthly_price_paise,
      setup_fee_paise: addOn.setup_fee_paise,
      setup_fee_charged: chargeSetupFee ? 1 : existing.setup_fee_charged,
      current_period_start: ts,
      current_period_end: periodEnd,
      config_json: input.config ? JSON.stringify(input.config) : existing.config_json,
    });
    subscription = await scope.first('add_on_subscriptions', { id: existing.id });
  } else {
    subscription = await scope.insert('add_on_subscriptions', {
      id: ID.addOnSub(),
      add_on_id: addOn.id,
      status: 'active',
      activated_at: ts,
      activated_by: ctx.userId,
      billing_cycle: input.billingCycle,
      monthly_price_paise: addOn.monthly_price_paise,
      setup_fee_paise: addOn.setup_fee_paise,
      setup_fee_charged: chargeSetupFee ? 1 : 0,
      current_period_start: ts,
      current_period_end: periodEnd,
      config_json: input.config ? JSON.stringify(input.config) : null,
    });
  }

  // Raise the invoice for the first period plus any setup fee.
  const items = [{
    description: `${addOn.name} — ${input.billingCycle} subscription`,
    quantity: 1,
    unitPricePaise: input.billingCycle === 'yearly'
      ? addOn.monthly_price_paise * 12 : addOn.monthly_price_paise,
    taxRatePct: 18,
    sourceType: 'addon',
    sourceId: addOn.id,
  }];
  if (chargeSetupFee) {
    items.push({
      description: `${addOn.name} — one-time setup`,
      quantity: 1,
      unitPricePaise: addOn.setup_fee_paise,
      taxRatePct: 18,
      sourceType: 'addon_setup',
      sourceId: addOn.id,
    });
  }

  const invoice = await createInvoice(ctx, scope, {
    direction: 'platform_to_tenant',
    kind: 'addon',
    items,
    dueInDays: 7,
    billingName: ctx.tenant?.name,
    billingEmail: ctx.user?.email,
    billingGstin: ctx.tenant?.gstin,
  });

  await audit(ctx, {
    action: 'addons.activated', category: 'addons', severity: 'notice',
    entityType: 'add_on', entityId: addOn.id, entityLabel: addOn.name,
    newValue: {
      key: addOn.key, billingCycle: input.billingCycle,
      monthlyPaise: addOn.monthly_price_paise,
      setupFeeCharged: chargeSetupFee, invoiceNo: invoice.invoice_no,
    },
  });

  // The entitlement cache on this request is now stale.
  ctx._entitlements = null;
  const entitlements = await entitlementsPayload(ctx);

  const providerKeys = safeJson(addOn.provider_keys_json, []);
  const missing = providerKeys.filter(k => !ctx.env[k] || String(ctx.env[k]).startsWith('replace-with-'));

  return created({
    addOn: { key: addOn.key, name: addOn.name },
    subscription,
    invoice: { id: invoice.id, invoiceNo: invoice.invoice_no, totalPaise: invoice.total_paise },
    entitlements,
    unlocked: safeJson(addOn.feature_keys_json, []),
    nextStep: missing.length
      ? {
          type: 'credentials',
          message: `${addOn.name} is active. It needs ${missing.join(', ')} before it can reach its provider.`,
          missing,
        }
      : { type: 'configure', message: `${addOn.name} is active and ready to configure.` },
  }, { ctx });
}, { permission: 'addons.activate' });

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------
router.post('/:key/deactivate', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const addOn = await db.one('SELECT * FROM add_ons WHERE key = ?', [ctx.params.key]);
  if (!addOn) throw new NotFoundError('Add-on');

  const subscription = await scope.first('add_on_subscriptions', { add_on_id: addOn.id });
  if (!subscription || !['active', 'trialing'].includes(subscription.status)) {
    throw new ConflictError(`${addOn.name} is not currently active.`);
  }

  const body = await ctx.body();
  const input = validate(body, {
    immediate: { type: 'boolean', default: false },
    reason: { type: 'text', max: 1000 },
  });

  await scope.update('add_on_subscriptions', subscription.id, {
    status: input.immediate ? 'cancelled' : 'cancelled',
    deactivated_at: nowIso(),
    deactivated_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'addons.deactivated', category: 'addons', severity: 'notice',
    entityType: 'add_on', entityId: addOn.id, entityLabel: addOn.name,
    oldValue: { status: subscription.status },
    newValue: { status: 'cancelled', reason: input.reason ?? null },
  });

  ctx._entitlements = null;
  const entitlements = await entitlementsPayload(ctx);

  return ok({
    addOn: { key: addOn.key, name: addOn.name },
    deactivated: true,
    entitlements,
    // Tell the caller exactly what stopped working, rather than leaving the
    // UI to guess why a screen went away.
    locked: safeJson(addOn.feature_keys_json, []).map(k => ({ key: k, name: FEATURES[k]?.name ?? k })),
    message: `${addOn.name} has been switched off. Your data is kept, and reactivating restores access without a new setup fee.`,
  }, { ctx });
}, { permission: 'addons.activate' });

// ---------------------------------------------------------------------------
// Configure
// ---------------------------------------------------------------------------
router.patch('/:key/config', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const addOn = await db.one('SELECT * FROM add_ons WHERE key = ?', [ctx.params.key]);
  if (!addOn) throw new NotFoundError('Add-on');

  const subscription = await scope.first('add_on_subscriptions', { add_on_id: addOn.id });
  if (!subscription) throw new ConflictError(`${addOn.name} is not active.`);

  const body = await ctx.body();
  const input = validate(body, { config: { type: 'json', required: true } });

  const previous = safeJson(subscription.config_json, {});
  const merged = { ...previous, ...input.config };

  await scope.update('add_on_subscriptions', subscription.id, {
    config_json: JSON.stringify(merged),
  });

  await audit(ctx, {
    action: 'addons.configured', category: 'addons',
    entityType: 'add_on', entityId: addOn.id, entityLabel: addOn.name,
    oldValue: previous, newValue: merged,
  });

  return ok({ config: merged }, { ctx });
}, { permission: 'addons.configure' });

// ---------------------------------------------------------------------------
// Activate a whole bundle
// ---------------------------------------------------------------------------
router.post('/bundles/:plan', async (ctx) => {
  const bundle = ADDON_BUNDLES.find(b => b.plan === ctx.params.plan);
  if (!bundle) throw new NotFoundError('Bundle');

  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);

  const body = await ctx.body();
  const input = validate(body, { acknowledgeSetupFee: { type: 'boolean', default: false } });

  const rows = await db.many(
    `SELECT * FROM add_ons WHERE key IN (${bundle.addOnKeys.map(() => '?').join(',')})`,
    bundle.addOnKeys);

  const setupTotal = rows.reduce((s, r) => s + r.setup_fee_paise, 0);
  if (setupTotal > 0 && !input.acknowledgeSetupFee) {
    throw new ConflictError(
      `This bundle carries setup fees totalling ${formatINR(setupTotal, { decimals: 0 })}. Confirm to continue.`,
      { setupFeePaise: setupTotal, monthlyPaise: bundle.monthlyPaise });
  }

  const ts = nowIso();
  const activated = [];
  const skipped = [];
  const items = [];

  for (const addOn of rows) {
    const existing = await scope.first('add_on_subscriptions', { add_on_id: addOn.id });
    if (existing && ['active', 'trialing'].includes(existing.status)) {
      skipped.push({ key: addOn.key, reason: 'Already active.' });
      continue;
    }

    const chargeSetup = addOn.setup_fee_paise > 0 && !existing?.setup_fee_charged;
    if (existing) {
      await scope.update('add_on_subscriptions', existing.id, {
        status: 'active', activated_at: ts, activated_by: ctx.userId,
        deactivated_at: null, current_period_start: ts, current_period_end: addMonths(1),
        setup_fee_charged: chargeSetup ? 1 : existing.setup_fee_charged,
      });
    } else {
      await scope.insert('add_on_subscriptions', {
        id: ID.addOnSub(),
        add_on_id: addOn.id,
        status: 'active',
        activated_at: ts,
        activated_by: ctx.userId,
        billing_cycle: 'monthly',
        monthly_price_paise: addOn.monthly_price_paise,
        setup_fee_paise: addOn.setup_fee_paise,
        setup_fee_charged: chargeSetup ? 1 : 0,
        current_period_start: ts,
        current_period_end: addMonths(1),
      });
    }

    items.push({
      description: `${addOn.name} — monthly subscription`,
      quantity: 1, unitPricePaise: addOn.monthly_price_paise, taxRatePct: 18,
      sourceType: 'addon', sourceId: addOn.id,
    });
    if (chargeSetup) {
      items.push({
        description: `${addOn.name} — one-time setup`,
        quantity: 1, unitPricePaise: addOn.setup_fee_paise, taxRatePct: 18,
        sourceType: 'addon_setup', sourceId: addOn.id,
      });
    }
    activated.push({ key: addOn.key, name: addOn.name });
  }

  let invoice = null;
  if (items.length) {
    invoice = await createInvoice(ctx, scope, {
      direction: 'platform_to_tenant', kind: 'addon', items, dueInDays: 7,
      billingName: ctx.tenant?.name, billingEmail: ctx.user?.email, billingGstin: ctx.tenant?.gstin,
    });
  }

  await audit(ctx, {
    action: 'addons.activated', category: 'addons', severity: 'notice',
    entityType: 'add_on_bundle', entityId: bundle.plan, entityLabel: `${bundle.label} bundle`,
    newValue: { activated: activated.map(a => a.key), skipped: skipped.length },
  });

  ctx._entitlements = null;
  return created({
    bundle: bundle.label,
    activated,
    skipped,
    invoice: invoice ? { id: invoice.id, invoiceNo: invoice.invoice_no, totalPaise: invoice.total_paise } : null,
    entitlements: await entitlementsPayload(ctx),
  }, { ctx });
}, { permission: 'addons.activate' });

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
router.get('/:key/usage', async (ctx) => {
  const db = new Db(ctx.env.DB);
  const scope = scopeFor(ctx);
  const addOn = await db.one('SELECT id, key, name FROM add_ons WHERE key = ?', [ctx.params.key]);
  if (!addOn) throw new NotFoundError('Add-on');

  const rows = await scope.raw(
    `SELECT metric, period_key, value, updated_at FROM add_on_usage
      WHERE tenant_id = ? AND add_on_id = ? ORDER BY period_key DESC LIMIT 24`,
    [ctx.tenantId, addOn.id]);

  return ok({ addOn: { key: addOn.key, name: addOn.name }, usage: rows }, { ctx });
}, { permission: 'addons.view' });

/** Which integration provider backs a given add-on, for status display. */
function providerKeyFor(addOnKey) {
  const map = {
    whatsapp_business_api: 'whatsapp_cloud',
    email_automation: 'ses',
    sms_automation: 'msg91',
    voice_notes_to_crm: 'google_speech',
    meta_lead_ads: 'meta_leads',
    google_sheets: 'google_sheets',
    google_forms: 'google_forms',
    ai_ocr_engine: 'google_vision',
    ai_document_verification: 'google_vision',
    ai_gst_tax_assistant: 'anthropic',
    ai_business_insights: 'anthropic',
    payment_gateway: 'razorpay',
    esign: 'digio',
    google_drive: 'google_drive',
    dropbox: 'dropbox',
    onedrive: 'onedrive',
    mobile_app: 'fcm',
    calendar_integration: 'google_calendar',
    white_label_branding: 'cloudflare_dns',
    cloud_telephony: 'exotel',
    cloud_calling_system: 'exotel',
  };
  return map[addOnKey] ?? null;
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { router as addonsRouter, providerKeyFor };
