/**
 * Tenant provisioning — everything a new organisation needs to be usable the
 * moment its first user lands on the dashboard: the tenant row, a head-office
 * branch, the first company (GSTIN/PAN/TAN), the owner user with a role, a
 * Basic subscription, a security policy, default call dispositions and the
 * notification preferences the proposal's automation layer expects.
 *
 * It runs as one unit: if any step fails the caller sees the error rather than
 * a half-built organisation.
 */

import { Db } from '../db/client.js';
import { TenantScope, platformScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays, addMonths, monthKey } from '../utils/time.js';
import { systemRoleId, planIdByKey } from './bootstrap.js';
import { DEFAULT_MONTHLY_CHECKLIST } from '../data/document-types.js';
import { NOTIFICATION_TRIGGERS } from '../data/notification-triggers.js';

/** Dispositions every tenant starts with; editable under Settings → Calling. */
export const DEFAULT_DISPOSITIONS = [
  { key: 'connected',        label: 'Connected',           outcome: 'positive', followUp: 0, colour: '#22C55E', sort: 10 },
  { key: 'resolved',         label: 'Resolved',            outcome: 'positive', followUp: 0, colour: '#16A34A', sort: 20 },
  { key: 'follow_up',        label: 'Follow-up Required',  outcome: 'neutral',  followUp: 1, colour: '#F59E0B', sort: 30 },
  { key: 'documents_promised', label: 'Documents Promised', outcome: 'positive', followUp: 1, colour: '#2F6BFF', sort: 40 },
  { key: 'callback',         label: 'Callback Requested',  outcome: 'neutral',  followUp: 1, colour: '#22D3EE', sort: 50 },
  { key: 'no_answer',        label: 'No Answer',           outcome: 'neutral',  followUp: 1, colour: '#7386AA', sort: 60 },
  { key: 'wrong_number',     label: 'Wrong Number',        outcome: 'negative', followUp: 0, colour: '#EF4444', sort: 70 },
  { key: 'not_interested',   label: 'Not Interested',      outcome: 'negative', followUp: 0, colour: '#DC2626', sort: 80 },
  { key: 'payment_promised', label: 'Payment Promised',    outcome: 'positive', followUp: 1, colour: '#8B5CF6', sort: 90 },
];

/**
 * Create an organisation and its first user.
 *
 * @param {object} ctx  request context (for env)
 * @param {object} input
 * @returns {{tenant, company, branch, user, roleKey, subscription}}
 */
export async function provisionTenant(ctx, {
  organisationName, ownerName, ownerEmail, ownerPhone, passwordHash,
  companyName, gstin, pan, tan, stateCode = '33',
  accountType = 'firm', planKey = 'basic', isDemo = false, franchiseId = null,
}) {
  const db = new Db(ctx.env.DB);
  const ts = nowIso();

  const tenantId = ID.tenant();
  const slug = await uniqueSlug(db, organisationName);

  const tenant = {
    id: tenantId,
    name: organisationName,
    slug,
    legal_name: organisationName,
    email: ownerEmail,
    phone: ownerPhone ?? null,
    state_code: stateCode,
    country: 'IN',
    gstin: gstin ?? null,
    pan: pan ?? null,
    tan: tan ?? null,
    status: 'active',
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    franchise_id: franchiseId,
    is_demo: isDemo ? 1 : 0,
    onboarding_step: gstin ? 'complete' : 'company_profile',
    created_at: ts,
    updated_at: ts,
  };
  await db.insert('tenants', tenant);

  const scope = new TenantScope(db, tenantId);

  // Head office branch — multi-branch is an add-on, but every tenant has one
  // branch from day one so reports and GPS geofencing have somewhere to hang.
  const branch = await scope.insert('branches', {
    id: ID.branch(),
    name: 'Head Office',
    code: 'HO',
    is_head_office: 1,
    state_code: stateCode,
    email: ownerEmail,
    phone: ownerPhone ?? null,
    status: 'active',
  });

  const company = await scope.insert('companies', {
    id: ID.company(),
    branch_id: branch.id,
    name: companyName || organisationName,
    legal_name: companyName || organisationName,
    entity_type: 'private_limited',
    gstin: gstin ?? null,
    pan: pan ?? null,
    tan: tan ?? null,
    email: ownerEmail,
    phone: ownerPhone ?? null,
    state_code: stateCode,
    country: 'IN',
    financial_year_start: '04-01',
    gst_registration_type: 'regular',
    gst_filing_frequency: 'monthly',
    status: 'active',
    is_demo: isDemo ? 1 : 0,
  });

  // A firm signing up gets Admin; a direct client signing up gets Client.
  const roleKey = accountType === 'client' ? 'client' : 'admin';
  const roleId = await systemRoleId(db, roleKey);

  const user = await scope.insert('users', {
    id: ID.user(),
    email: ownerEmail,
    password_hash: passwordHash,
    full_name: ownerName,
    phone: ownerPhone ?? null,
    job_title: accountType === 'client' ? 'Owner' : 'Administrator',
    branch_id: branch.id,
    status: 'active',
    email_verified_at: null,
    twofa_enabled: 0,
    must_change_password: 0,
    locale: 'en-IN',
    timezone: 'Asia/Kolkata',
    theme: 'dark',
    is_demo: isDemo ? 1 : 0,
  });

  await db.insert('user_roles', {
    user_id: user.id, role_id: roleId, assigned_by: user.id, assigned_at: ts,
  });

  // A client-role owner is confined to their own company; staff see the whole
  // tenant, so they get no membership rows at all.
  if (roleKey === 'client') {
    await db.insert('user_companies', {
      user_id: user.id, company_id: company.id, relationship: 'owner',
      is_default: 1, created_at: ts,
    });
  }

  const planId = await planIdByKey(db, planKey);
  const subscription = await scope.insert('subscriptions', {
    id: ID.subscription(),
    plan_id: planId,
    status: planKey === 'basic' ? 'active' : 'trialing',
    billing_cycle: 'monthly',
    seats: 1,
    unit_price_paise: 0,
    current_period_start: ts,
    current_period_end: addMonths(1),
    trial_ends_at: planKey === 'basic' ? null : addDays(14),
    auto_renew: 1,
    cancel_at_period_end: 0,
  });

  await scope.insert('security_policies', {
    tenant_id: tenantId,
    enforce_2fa: 0,
    session_ttl_hours: 12,
    idle_timeout_minutes: 60,
    password_min_length: 10,
    password_require_mixed: 1,
    max_failed_logins: 5,
    lockout_minutes: 15,
    anomaly_alerts: 1,
    updated_by: user.id,
    updated_at: ts,
  });

  await scope.insert('white_label_settings', {
    tenant_id: tenantId,
    enabled: 0,
    product_name: 'Meet Millions Finance CRM',
    domain_status: 'not_configured',
    ssl_status: 'none',
    updated_at: ts,
  });

  await scope.insert('telephony_settings', {
    tenant_id: tenantId,
    provider: 'exotel',
    status: 'not_connected',
    recording_mode: 'automatic',
    recording_retention_days: 365,
    transcription_enabled: 0,
    ai_summary_enabled: 0,
    sentiment_enabled: 0,
    auto_create_task: 1,
    auto_log_activity: 1,
    voicemail_enabled: 1,
    updated_at: ts,
  });

  for (const d of DEFAULT_DISPOSITIONS) {
    await scope.insert('call_dispositions', {
      id: ID.disposition(),
      key: d.key, label: d.label, outcome: d.outcome,
      requires_follow_up: d.followUp, colour: d.colour, sort_order: d.sort, is_active: 1,
    });
  }

  // Tenant-wide notification defaults, one row per trigger.
  for (const trigger of NOTIFICATION_TRIGGERS) {
    await scope.insert('notification_preferences', {
      id: ID.template(),
      user_id: null,
      trigger_key: trigger.key,
      email_enabled: trigger.defaultChannels.includes('email') ? 1 : 0,
      sms_enabled: trigger.defaultChannels.includes('sms') ? 1 : 0,
      whatsapp_enabled: trigger.defaultChannels.includes('whatsapp') ? 1 : 0,
      in_app_enabled: trigger.defaultChannels.includes('in_app') ? 1 : 0,
      push_enabled: trigger.defaultChannels.includes('push') ? 1 : 0,
      updated_at: ts,
    });
  }

  await seedUsageCounters(scope, tenantId, ts);

  return { tenant, branch, company, user, roleKey, subscription, scope };
}

async function seedUsageCounters(scope, tenantId, ts) {
  const metrics = [
    ['users', 'current', 1],
    ['companies', 'current', 1],
    ['storage_bytes', 'current', 0],
    ['uploads', monthKey(), 0],
  ];
  for (const [metric, period, value] of metrics) {
    await scope.insert('subscription_usage', {
      id: `usg_${tenantId}_${metric}_${period}`,
      metric, period_key: period, value, updated_at: ts,
    });
  }
}

async function uniqueSlug(db, name) {
  const base = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'org';

  for (let attempt = 0; attempt < 40; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await db.one('SELECT id FROM tenants WHERE slug = ?', [candidate]);
    if (!clash) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Create a client record together with its company and portal login.
 * Used by client onboarding, lead conversion and the demo seed.
 */
export async function provisionClient(scope, db, {
  displayName, companyName, gstin, pan, tan, stateCode = '33', entityType = 'private_limited',
  contactName, contactEmail, contactPhone, passwordHash = null,
  assignedExecutiveId = null, assignedManagerId = null, branchId = null,
  source = 'manual', createdBy = null, isDemo = false, sla = 48,
}) {
  const ts = nowIso();

  const company = await scope.insert('companies', {
    id: ID.company(),
    branch_id: branchId,
    name: companyName || displayName,
    legal_name: companyName || displayName,
    entity_type: entityType,
    gstin: gstin ?? null,
    pan: pan ?? null,
    tan: tan ?? null,
    email: contactEmail ?? null,
    phone: contactPhone ?? null,
    state_code: stateCode,
    country: 'IN',
    financial_year_start: '04-01',
    gst_registration_type: 'regular',
    gst_filing_frequency: 'monthly',
    status: 'active',
    is_demo: isDemo ? 1 : 0,
  });

  const clientCode = await nextClientCode(scope);
  const client = await scope.insert('clients', {
    id: ID.client(),
    company_id: company.id,
    branch_id: branchId,
    client_code: clientCode,
    display_name: displayName,
    primary_contact_name: contactName ?? null,
    primary_contact_email: contactEmail ?? null,
    primary_contact_phone: contactPhone ?? null,
    assigned_executive_id: assignedExecutiveId,
    assigned_manager_id: assignedManagerId,
    onboarding_status: gstin ? 'documents' : 'profile',
    status: 'active',
    source,
    sla_hours: sla,
    billing_day: 1,
    is_demo: isDemo ? 1 : 0,
  });

  // A portal login is created only when a password was supplied; otherwise the
  // client is invited later and the contact stands alone.
  let portalUser = null;
  if (passwordHash && contactEmail) {
    const existing = await db.one(
      'SELECT id FROM users WHERE tenant_id = ? AND email = ?', [scope.tenantId, contactEmail]);
    if (!existing) {
      portalUser = await scope.insert('users', {
        id: ID.user(),
        email: contactEmail,
        password_hash: passwordHash,
        full_name: contactName || displayName,
        phone: contactPhone ?? null,
        job_title: 'Client',
        branch_id: branchId,
        status: 'active',
        theme: 'dark',
        is_demo: isDemo ? 1 : 0,
      });
      const clientRoleId = await systemRoleId(db, 'client');
      await db.insert('user_roles', {
        user_id: portalUser.id, role_id: clientRoleId,
        assigned_by: createdBy, assigned_at: ts,
      });
      await db.insert('user_companies', {
        user_id: portalUser.id, company_id: company.id,
        relationship: 'owner', is_default: 1, created_at: ts,
      });
    } else {
      portalUser = existing;
    }
  }

  const contact = await scope.insert('client_contacts', {
    id: ID.contact(),
    client_id: client.id,
    user_id: portalUser?.id ?? null,
    name: contactName || displayName,
    email: contactEmail ?? null,
    phone: contactPhone ?? null,
    designation: 'Primary contact',
    is_primary: 1,
    whatsapp_opt_in: contactPhone ? 1 : 0,
  });

  return { client, company, contact, portalUser };
}

async function nextClientCode(scope) {
  const row = await scope.rawOne(
    'SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ?', [scope.tenantId]);
  const n = (Number(row?.n) || 0) + 1;
  return `CL-${String(n).padStart(4, '0')}`;
}

/**
 * Open a filing period for a client and lay out its document checklist.
 * Called on client onboarding and by the monthly cron.
 */
export async function openFilingPeriod(scope, db, {
  clientId, companyId, periodType = 'monthly', periodKey, dueDate = null,
  checklistKeys = DEFAULT_MONTHLY_CHECKLIST,
}) {
  const { periodBounds, gstDueDate } = await import('../utils/time.js');
  const bounds = periodBounds(periodType, periodKey);

  const existing = await scope.rawOne(
    `SELECT * FROM filing_periods WHERE client_id = ? AND period_type = ? AND period_key = ?`,
    [clientId, periodType, periodKey]);
  if (existing) return { period: existing, created: false, checklist: [] };

  const period = await scope.insert('filing_periods', {
    id: ID.period(),
    company_id: companyId,
    client_id: clientId,
    period_type: periodType,
    period_key: periodKey,
    period_start: bounds.start,
    period_end: bounds.end,
    due_date: dueDate ?? gstDueDate(periodType, periodKey),
    status: 'collecting',
    documents_expected: checklistKeys.length,
    documents_received: 0,
    documents_verified: 0,
  });

  const types = await db.many(
    `SELECT id, key, name, sort_order FROM document_types
      WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = 1
        AND key IN (${checklistKeys.map(() => '?').join(',')})`,
    [scope.tenantId, ...checklistKeys]);

  const checklist = [];
  for (const t of types) {
    checklist.push(await scope.insert('checklist_items', {
      id: ID.checklist(),
      filing_period_id: period.id,
      document_type_id: t.id,
      label: `${t.name} — ${periodKey}`,
      is_required: 1,
      status: 'pending',
      sort_order: t.sort_order,
    }));
  }

  return { period, created: true, checklist };
}

export { platformScope };
