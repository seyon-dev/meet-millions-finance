/**
 * Feature gating.
 *
 * A capability is unlocked by (a) the subscription plan, (b) an active add-on
 * subscription, or (c) an explicit tenant feature flag. The same resolution
 * runs on the server for enforcement and is shipped to the client so the UI
 * can show a locked state instead of a dead button — but the client copy is a
 * convenience only. Every gated route re-checks here.
 */

import { Db } from '../db/client.js';
import { FeatureLockedError, LimitExceededError } from '../http/errors.js';
import { monthKey, nowIso } from '../utils/time.js';

/**
 * Capabilities and where they come from.
 * `plans` lists the plan keys that include the feature outright.
 * `addOn` names the marketplace module that also unlocks it.
 */
export const FEATURES = {
  // --- Core, from the plan comparison table in the proposal -----------------
  document_upload:      { name: 'Document uploads',            plans: ['basic', 'standard', 'pro', 'enterprise'] },
  unlimited_uploads:    { name: 'Unlimited uploads',           plans: ['standard', 'pro', 'enterprise'] },
  gst_reports:          { name: 'GST / TDS reports',           plans: ['standard', 'pro', 'enterprise'] },
  payment_tracking:     { name: 'Payment tracking',            plans: ['standard', 'pro', 'enterprise'] },
  manager_approval:     { name: 'Manager approval flow',       plans: ['standard', 'pro', 'enterprise'] },
  ocr_ai:               { name: 'OCR AI document reading',     plans: ['pro', 'enterprise'], addOn: 'ai_ocr_engine' },
  whatsapp_integration: { name: 'WhatsApp integration',        plans: ['pro', 'enterprise'], addOn: 'whatsapp_business_api' },
  api_access:           { name: 'API access',                  plans: ['pro', 'enterprise'], addOn: 'api_marketplace' },
  advanced_reports:     { name: 'Advanced reports',            plans: ['pro', 'enterprise'], addOn: 'advanced_analytics' },
  audit_logs:           { name: 'Audit logs',                  plans: ['pro', 'enterprise'], addOn: 'audit_logs_advanced' },
  white_label:          { name: 'White label',                 plans: ['pro', 'enterprise'], addOn: 'white_label_branding' },
  priority_support:     { name: 'Priority support',            plans: ['pro', 'enterprise'] },
  chat_support:         { name: 'Email + chat support',        plans: ['standard', 'pro', 'enterprise'] },

  // --- Add-on driven --------------------------------------------------------
  email_automation:     { name: 'Email automation',            plans: [], addOn: 'email_automation' },
  sms_automation:       { name: 'SMS automation',              plans: [], addOn: 'sms_automation' },
  voice_notes:          { name: 'Voice notes',                 plans: [], addOn: 'voice_notes_to_crm' },
  meta_lead_ads:        { name: 'Meta Lead Ads',               plans: [], addOn: 'meta_lead_ads' },
  google_sheets:        { name: 'Google Sheets sync',          plans: [], addOn: 'google_sheets' },
  google_forms:         { name: 'Google Forms capture',        plans: [], addOn: 'google_forms' },
  website_forms:        { name: 'Website contact forms',       plans: [], addOn: 'website_contact_form' },
  ai_doc_verification:  { name: 'AI document verification',    plans: [], addOn: 'ai_document_verification' },
  ai_tax_assistant:     { name: 'AI GST & Tax assistant',      plans: [], addOn: 'ai_gst_tax_assistant' },
  ai_business_insights: { name: 'AI business insights',        plans: [], addOn: 'ai_business_insights' },
  payment_gateway:      { name: 'Payment gateway',             plans: [], addOn: 'payment_gateway' },
  esign:                { name: 'e-Sign',                      plans: [], addOn: 'esign' },
  google_drive:         { name: 'Google Drive sync',           plans: [], addOn: 'google_drive' },
  dropbox:              { name: 'Dropbox sync',                plans: [], addOn: 'dropbox' },
  onedrive:             { name: 'OneDrive / SharePoint sync',  plans: [], addOn: 'onedrive' },
  mobile_app:           { name: 'Mobile app',                  plans: [], addOn: 'mobile_app' },
  client_portal:        { name: 'Client self-service portal',  plans: ['standard', 'pro', 'enterprise'], addOn: 'client_self_service_portal' },
  gps_attendance:       { name: 'Employee GPS attendance',     plans: [], addOn: 'employee_gps_attendance' },
  calendar_sync:        { name: 'Calendar integration',        plans: [], addOn: 'calendar_integration' },
  multi_branch:         { name: 'Multi-branch management',     plans: [], addOn: 'multi_branch_management' },
  franchise:            { name: 'Franchise management',        plans: [], addOn: 'franchise_management' },
  multi_company:        { name: 'Multi-company management',    plans: ['pro', 'enterprise'], addOn: 'multi_company_management' },
  enterprise_security:  { name: 'Enterprise security',         plans: [], addOn: 'enterprise_security' },
  cloud_telephony:      { name: 'Cloud telephony',             plans: [], addOn: 'cloud_telephony' },
  call_recording:       { name: 'Call recording',              plans: [], addOn: 'cloud_telephony' },
  call_ai:              { name: 'AI call summary & sentiment', plans: [], addOn: 'cloud_telephony' },
};

export const FEATURE_KEYS = Object.keys(FEATURES);

/** Plan limits. -1 is unlimited. Mirrors the proposal's pricing table. */
export const PLAN_LIMIT_METRICS = ['users', 'companies', 'storage_bytes', 'uploads'];

/**
 * Resolve everything a tenant is entitled to, in one pass. Cached on the
 * request context so a handler that checks several features pays once.
 */
export async function getEntitlements(ctx) {
  if (ctx._entitlements) return ctx._entitlements;

  const db = new Db(ctx.env.DB);
  const tenantId = ctx.tenantId;

  if (!tenantId) {
    // Platform Super Admin: nothing is gated.
    const all = { planKey: 'platform', plan: null, features: new Set(FEATURE_KEYS),
      addOns: new Set(), limits: unlimitedLimits(), usage: {}, subscription: null, unlimited: true };
    ctx._entitlements = all;
    return all;
  }

  const subscription = await db.one(
    `SELECT s.*, p.key AS plan_key, p.name AS plan_name, p.max_users, p.max_companies,
            p.storage_gb, p.max_uploads_month, p.support_level
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.tenant_id = ? AND s.status IN ('trialing','active','past_due')
      ORDER BY s.created_at DESC LIMIT 1`, [tenantId]);

  const planKey = subscription?.plan_key ?? 'basic';

  const features = new Set();
  for (const [key, def] of Object.entries(FEATURES)) {
    if (def.plans.includes(planKey)) features.add(key);
  }

  // Explicit plan_features rows can add capabilities beyond the static map.
  if (subscription?.plan_id) {
    const rows = await db.many(
      'SELECT feature_key, enabled FROM plan_features WHERE plan_id = ?', [subscription.plan_id]);
    for (const r of rows) {
      if (r.enabled) features.add(r.feature_key); else features.delete(r.feature_key);
    }
  }

  // Active add-ons unlock their own capabilities.
  const addOnRows = await db.many(
    `SELECT a.key, a.feature_keys_json FROM add_on_subscriptions s
       JOIN add_ons a ON a.id = s.add_on_id
      WHERE s.tenant_id = ? AND s.status IN ('active','trialing')`, [tenantId]);
  const addOns = new Set(addOnRows.map(r => r.key));
  for (const row of addOnRows) {
    for (const [key, def] of Object.entries(FEATURES)) {
      if (def.addOn === row.key) features.add(key);
    }
    for (const key of safeJson(row.feature_keys_json, [])) features.add(key);
  }

  // Tenant feature flags win over everything — the emergency override.
  const flags = await db.many(
    'SELECT feature_key, enabled, expires_at FROM feature_flags WHERE tenant_id = ? OR tenant_id IS NULL',
    [tenantId]);
  for (const f of flags) {
    if (f.expires_at && f.expires_at < nowIso()) continue;
    if (f.enabled) features.add(f.feature_key); else features.delete(f.feature_key);
  }

  const limits = subscription ? {
    users: subscription.max_users,
    companies: subscription.max_companies,
    storage_bytes: subscription.storage_gb < 0 ? -1 : subscription.storage_gb * 1024 * 1024 * 1024,
    uploads: subscription.max_uploads_month,
  } : { users: 1, companies: 1, storage_bytes: 5 * 1024 * 1024 * 1024, uploads: 50 };

  const usageRows = await db.many(
    `SELECT metric, period_key, value FROM subscription_usage
      WHERE tenant_id = ? AND period_key IN (?, 'current')`, [tenantId, monthKey()]);
  const usage = {};
  for (const r of usageRows) usage[r.metric] = Number(r.value) || 0;

  const entitlements = {
    planKey,
    plan: subscription ? {
      key: subscription.plan_key, name: subscription.plan_name,
      supportLevel: subscription.support_level, status: subscription.status,
      billingCycle: subscription.billing_cycle,
      currentPeriodEnd: subscription.current_period_end,
      trialEndsAt: subscription.trial_ends_at,
    } : null,
    subscription,
    features,
    addOns,
    limits,
    usage,
    unlimited: false,
  };
  ctx._entitlements = entitlements;
  return entitlements;
}

function unlimitedLimits() {
  return { users: -1, companies: -1, storage_bytes: -1, uploads: -1 };
}

export async function hasFeature(ctx, key) {
  const ent = await getEntitlements(ctx);
  return ent.features.has(key);
}

/** Throw a 402 naming the plan or add-on that would unlock the feature. */
export async function assertFeature(ctx, key) {
  const ent = await getEntitlements(ctx);
  if (ent.features.has(key)) return;
  const def = FEATURES[key];
  throw new FeatureLockedError(key, {
    requiredPlan: def?.plans?.[0] ?? null,
    requiredAddOn: def?.addOn ?? null,
    message: def
      ? `${def.name} is not included in your current plan.`
      : 'That feature is not available on your current plan.',
  });
}

/** Current value of a metered limit. */
export async function getUsage(ctx, metric) {
  const ent = await getEntitlements(ctx);
  return ent.usage[metric] ?? 0;
}

/**
 * Check a limit before performing the action that would exceed it.
 * `increment` is how much the pending action will add.
 */
export async function assertWithinLimit(ctx, metric, increment = 1, { currentOverride } = {}) {
  const ent = await getEntitlements(ctx);
  const limit = ent.limits[metric];
  if (limit === undefined || limit < 0) return;   // -1 / unknown = unlimited

  const current = currentOverride ?? (await liveUsage(ctx, metric));
  if (current + increment > limit) {
    throw new LimitExceededError(metric, limit, current,
      limitMessage(metric, limit));
  }
}

function limitMessage(metric, limit) {
  switch (metric) {
    case 'users': return `Your plan includes ${limit} user${limit === 1 ? '' : 's'}. Upgrade to add more.`;
    case 'companies': return `Your plan includes ${limit} compan${limit === 1 ? 'y' : 'ies'}. Upgrade to add more.`;
    case 'storage_bytes': return `You have used all ${Math.round(limit / 1024 / 1024 / 1024)}GB of storage on your plan.`;
    case 'uploads': return `Your plan allows ${limit} uploads a month. Upgrade for unlimited uploads.`;
    default: return `You have reached your plan limit for ${metric}.`;
  }
}

/** Counted live for absolute gauges; read from the counter for monthly ones. */
export async function liveUsage(ctx, metric) {
  const db = new Db(ctx.env.DB);
  const tenantId = ctx.tenantId;
  switch (metric) {
    case 'users':
      return db.count(
        `SELECT COUNT(*) FROM users WHERE tenant_id = ? AND deleted_at IS NULL
           AND status IN ('active','invited')`, [tenantId]);
    case 'companies':
      return db.count(
        `SELECT COUNT(*) FROM companies WHERE tenant_id = ? AND deleted_at IS NULL
           AND status != 'archived'`, [tenantId]);
    case 'storage_bytes':
      return db.count(
        'SELECT COALESCE(SUM(size_bytes), 0) FROM document_versions WHERE tenant_id = ?', [tenantId]);
    case 'uploads': {
      const from = `${monthKey()}-01T00:00:00.000Z`;
      return db.count(
        'SELECT COUNT(*) FROM document_versions WHERE tenant_id = ? AND created_at >= ?', [tenantId, from]);
    }
    default:
      return getUsage(ctx, metric);
  }
}

/** Increment a rolling counter (SMS sent, API calls, call minutes). */
export async function bumpUsage(ctx, metric, amount = 1, period = monthKey()) {
  const db = new Db(ctx.env.DB);
  await db.run(
    `INSERT INTO subscription_usage (id, tenant_id, metric, period_key, value, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, metric, period_key)
     DO UPDATE SET value = value + excluded.value, updated_at = excluded.updated_at`,
    [`usg_${ctx.tenantId}_${metric}_${period}`, ctx.tenantId, metric, period, amount, nowIso()]);
}

/** The entitlement payload the SPA receives at bootstrap. */
export async function entitlementsPayload(ctx) {
  const ent = await getEntitlements(ctx);
  const live = {};
  for (const metric of PLAN_LIMIT_METRICS) {
    if (ent.limits[metric] !== undefined && ent.limits[metric] >= 0) {
      live[metric] = await liveUsage(ctx, metric);
    }
  }
  return {
    plan: ent.plan,
    planKey: ent.planKey,
    features: [...ent.features].sort(),
    addOns: [...ent.addOns].sort(),
    limits: ent.limits,
    usage: { ...ent.usage, ...live },
    catalogue: Object.fromEntries(
      Object.entries(FEATURES).map(([k, v]) => [k, { name: v.name, plans: v.plans, addOn: v.addOn ?? null }])),
  };
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
