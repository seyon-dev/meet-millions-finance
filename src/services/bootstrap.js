/**
 * Platform bootstrap — the system-owned rows every deployment needs:
 * permissions, the seven system roles, plans, the add-on catalogue, document
 * types, default notification templates and the default tax rules.
 *
 * It is idempotent (INSERT OR IGNORE plus targeted updates), so it can run on
 * every deploy and after every migration without duplicating anything.
 */

import { platformScope } from '../db/tenancy.js';
import { Db } from '../db/client.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { PERMISSIONS } from '../permissions/catalog.js';
import { ROLE_DEFINITIONS, permissionsForRole } from '../permissions/roles.js';
import { PLANS } from '../data/plans.js';
import { ADDONS, CLOUD_CALLING_MODULE } from '../data/addons.js';
import { DOCUMENT_TYPES } from '../data/document-types.js';
import { DEFAULT_TEMPLATES } from '../data/notification-triggers.js';
import { ALL_TAX_RULES } from '../data/tax-rules.js';
import { hashPassword } from '../auth/password.js';

/**
 * The version of the seeded catalogue.
 *
 * Bump it when permissions, roles, plans, add-ons, document types, templates or
 * tax rules change, so a deployed Worker re-seeds them on its next request
 * instead of waiting for somebody to remember.
 */
export const BOOTSTRAP_VERSION = '1';

/**
 * Memo of the databases already known to be seeded.
 *
 * Keyed on the D1 binding rather than held as a bare flag: a single process can
 * hold more than one database — the test suite builds a fresh one per case —
 * and a module-level boolean would tell the second one it had already been
 * seeded. A WeakSet also lets the entry go when the binding does.
 *
 * Where the runtime hands out the same binding object across an isolate's
 * requests this costs one read per isolate. Where it does not, the fallback is
 * a single-row lookup on a unique index per request, which is cheap enough not
 * to warrant a less correct cache.
 */
const settled = new WeakSet();

/**
 * Run the bootstrap once, lazily, on a live deployment.
 *
 * A Worker has no deploy hook: nothing runs between `wrangler deploy` and the
 * first request. Without this, a fresh deployment has no permissions, no roles,
 * no plans and no way in — every screen would 403 and nobody could sign in to
 * fix it.
 *
 * The marker row doubles as the lock. `INSERT OR IGNORE` against the unique
 * index on platform settings means exactly one caller writes it; everything the
 * bootstrap does is idempotent anyway, so a concurrent second run is wasteful
 * rather than wrong.
 */
export async function ensureBootstrapped(env) {
  if (settled.has(env.DB)) return { ran: false, reason: 'already_done_in_isolate' };

  const db = new Db(env.DB);
  const marker = await db.one(
    "SELECT value_json FROM settings WHERE tenant_id IS NULL AND namespace = 'platform' AND key = 'bootstrap_version'");

  if (marker?.value_json === JSON.stringify(BOOTSTRAP_VERSION)) {
    settled.add(env.DB);
    return { ran: false, reason: 'current' };
  }

  const report = await bootstrapPlatform(env);
  const ts = nowIso();

  if (marker) {
    // Written directly rather than through db.update, because the row is
    // identified by `tenant_id IS NULL` and a `= ?` comparison never matches a
    // NULL — it would silently update nothing, or an organisation's own
    // setting that happened to share the namespace and key.
    await db.run(
      `UPDATE settings SET value_json = ?, updated_at = ?
        WHERE tenant_id IS NULL AND namespace = 'platform' AND key = 'bootstrap_version'`,
      [JSON.stringify(BOOTSTRAP_VERSION), ts]);
  } else {
    await db.insertOrIgnore('settings', {
      id: ID.setting(),
      tenant_id: null,
      namespace: 'platform',
      key: 'bootstrap_version',
      value_json: JSON.stringify(BOOTSTRAP_VERSION),
      value_type: 'string',
      description: 'The catalogue version this deployment has seeded.',
      updated_at: ts,
    });
  }

  settled.add(env.DB);
  return { ran: true, report };
}

export async function bootstrapPlatform(env, { verbose = false } = {}) {
  const db = new Db(env.DB);
  const ts = nowIso();
  const report = {};

  report.permissions = await seedPermissions(db);
  report.roles = await seedSystemRoles(db, ts);
  report.plans = await seedPlans(db, ts);
  report.addOns = await seedAddOns(db, ts);
  report.documentTypes = await seedDocumentTypes(db, ts);
  report.templates = await seedNotificationTemplates(db, ts);
  report.taxRules = await seedTaxRules(db, ts);
  report.platformOwner = await seedPlatformOwner(db, env, ts);

  if (verbose) console.log('bootstrap complete', report);
  return report;
}

// ---------------------------------------------------------------------------

/**
 * The first platform Super Admin.
 *
 * Without one, the platform screens exist and nobody can reach them. It is
 * created only from environment variables, only when both are present, and
 * only when no Super Admin exists yet — so a deployment that sets them once
 * gets an owner, and every later boot leaves that account alone.
 *
 * There is deliberately no default password. A product that ships with one
 * ships with a way in for everybody who has read its documentation.
 */
async function seedPlatformOwner(db, env, ts) {
  const email = (env.PLATFORM_OWNER_EMAIL ?? '').trim().toLowerCase();
  const password = env.PLATFORM_OWNER_PASSWORD ?? '';

  if (!email || !password) return { created: false, reason: 'not_configured' };

  const role = await db.one("SELECT id FROM roles WHERE key = 'super_admin' AND tenant_id IS NULL");
  if (!role) return { created: false, reason: 'role_missing' };

  const existing = await db.one(
    `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.tenant_id IS NULL AND ur.role_id = ? LIMIT 1`, [role.id]);
  if (existing) return { created: false, reason: 'already_exists' };

  if (password.length < 12) {
    // Refusing is the right answer: a weak password on the account that can
    // reach every organisation is not a thing to accept quietly.
    console.warn('PLATFORM_OWNER_PASSWORD is shorter than 12 characters; no owner was created.');
    return { created: false, reason: 'password_too_weak' };
  }

  const userId = ID.user();
  await db.insert('users', {
    id: userId,
    tenant_id: null,
    email,
    password_hash: await hashPassword(password),
    full_name: env.PLATFORM_OWNER_NAME ?? 'Platform Owner',
    job_title: 'Platform Owner',
    status: 'active',
    theme: 'dark',
    // Set once from the environment, so it is changed at the first sign-in
    // rather than living on in whatever configured it.
    must_change_password: 1,
    created_at: ts,
    updated_at: ts,
  });
  await db.insert('user_roles', {
    user_id: userId, role_id: role.id, assigned_by: null, assigned_at: ts,
  });

  return { created: true, email };
}

async function seedPermissions(db) {
  let written = 0;
  for (const p of PERMISSIONS) {
    const inserted = await db.insertOrIgnore('permissions', {
      key: p.key, resource: p.resource, action: p.action,
      name: p.name, description: p.description, category: p.category,
    });
    if (inserted) written++;
    else {
      // Keep wording current when the catalogue is edited.
      await db.update('permissions', { key: p.key },
        { name: p.name, description: p.description, category: p.category });
    }
  }
  return { total: PERMISSIONS.length, inserted: written };
}

async function seedSystemRoles(db, ts) {
  let inserted = 0;
  for (const role of ROLE_DEFINITIONS) {
    const existing = await db.one(
      'SELECT id FROM roles WHERE key = ? AND tenant_id IS NULL', [role.key]);

    let roleId = existing?.id;
    if (!roleId) {
      roleId = ID.role();
      await db.insert('roles', {
        id: roleId, tenant_id: null, key: role.key, name: role.name,
        description: role.description, level: role.level, is_system: 1,
        created_at: ts, updated_at: ts,
      });
      inserted++;
    } else {
      await db.update('roles', { id: roleId },
        { name: role.name, description: role.description, level: role.level, updated_at: ts });
    }

    // Refresh the grant so a catalogue change reaches existing deployments.
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
    const keys = role.permissions.includes('*') ? ['*'] : permissionsForRole(role.key);
    if (!keys.includes('*')) {
      const batch = keys.map(key => ([
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_key, granted) VALUES (?, ?, 1)',
        [roleId, key],
      ]));
      if (batch.length) await db.batch(batch);
    }
  }
  return { total: ROLE_DEFINITIONS.length, inserted };
}

async function seedPlans(db, ts) {
  let inserted = 0;
  for (const plan of PLANS) {
    const existing = await db.one('SELECT id FROM plans WHERE key = ?', [plan.key]);
    const row = {
      key: plan.key,
      name: plan.name,
      tagline: plan.tagline,
      monthly_price_paise: plan.monthlyPaise,
      yearly_price_paise: plan.yearlyPaise,
      currency: 'INR',
      max_users: plan.maxUsers,
      max_companies: plan.maxCompanies,
      storage_gb: plan.storageGb,
      max_uploads_month: plan.maxUploadsMonth,
      support_level: plan.supportLevel,
      is_public: plan.isPublic === false ? 0 : 1,
      is_popular: plan.isPopular ? 1 : 0,
      sort_order: plan.sortOrder,
      trial_days: plan.trialDays,
      updated_at: ts,
    };

    let planId = existing?.id;
    if (!planId) {
      planId = ID.plan();
      await db.insert('plans', { id: planId, ...row, created_at: ts });
      inserted++;
    } else {
      await db.update('plans', { id: planId }, row);
    }

    for (const [featureKey, enabled] of Object.entries(plan.features)) {
      await db.run(
        `INSERT INTO plan_features (plan_id, feature_key, enabled, label, sort_order)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (plan_id, feature_key) DO UPDATE SET enabled = excluded.enabled`,
        [planId, featureKey, enabled ? 1 : 0, featureKey, 100]);
    }
  }
  return { total: PLANS.length, inserted };
}

async function seedAddOns(db, ts) {
  let inserted = 0;
  const all = [...ADDONS, CLOUD_CALLING_MODULE];
  for (const a of all) {
    const row = {
      key: a.key,
      number: a.number,
      name: a.name,
      category: a.category,
      category_no: a.categoryNo,
      description: a.description,
      business_benefit: a.businessBenefit,
      workflow: a.workflow,
      features_json: JSON.stringify(a.features),
      ui_screens_json: JSON.stringify(a.uiScreens ?? []),
      user_roles_json: JSON.stringify(a.userRoles ?? []),
      apis_required_json: JSON.stringify(a.apisRequired ?? []),
      provider_keys_json: JSON.stringify(a.providerKeys ?? []),
      best_plan: a.bestPlan,
      best_plan_keys_json: JSON.stringify(a.bestPlanKeys ?? []),
      monthly_price_paise: a.monthlyPaise,
      setup_fee_paise: a.setupPaise,
      feature_keys_json: JSON.stringify(a.featureKeys ?? []),
      icon: a.icon,
      accent: a.accent,
      requires_credentials: a.requiresCredentials === false ? 0 : 1,
      is_available: 1,
      updated_at: ts,
    };
    const existing = await db.one('SELECT id FROM add_ons WHERE key = ?', [a.key]);
    if (existing) {
      await db.update('add_ons', { id: existing.id }, row);
    } else {
      await db.insert('add_ons', { id: ID.addOn(), ...row, created_at: ts });
      inserted++;
    }
  }
  return { total: all.length, inserted };
}

async function seedDocumentTypes(db, ts) {
  let inserted = 0;
  for (const t of DOCUMENT_TYPES) {
    const row = {
      key: t.key,
      name: t.name,
      category: t.category,
      description: t.description,
      periodicity: t.periodicity,
      is_required: t.required ? 1 : 0,
      ocr_profile: t.ocr,
      sort_order: t.sort,
      is_active: 1,
      updated_at: ts,
    };
    const existing = await db.one(
      'SELECT id FROM document_types WHERE key = ? AND tenant_id IS NULL', [t.key]);
    if (existing) await db.update('document_types', { id: existing.id }, row);
    else {
      await db.insert('document_types', { id: ID.docType(), tenant_id: null, ...row, created_at: ts });
      inserted++;
    }
  }
  return { total: DOCUMENT_TYPES.length, inserted };
}

async function seedNotificationTemplates(db, ts) {
  let inserted = 0;
  for (const [triggerKey, channel, subject, body] of DEFAULT_TEMPLATES) {
    const existing = await db.one(
      'SELECT id FROM notification_templates WHERE trigger_key = ? AND channel = ? AND tenant_id IS NULL',
      [triggerKey, channel]);
    const row = {
      trigger_key: triggerKey,
      channel,
      name: `${triggerKey} (${channel})`,
      subject,
      body,
      is_active: 1,
      updated_at: ts,
    };
    if (existing) await db.update('notification_templates', { id: existing.id }, row);
    else {
      await db.insert('notification_templates', { id: ID.template(), tenant_id: null, ...row, created_at: ts });
      inserted++;
    }
  }
  return { total: DEFAULT_TEMPLATES.length, inserted };
}

async function seedTaxRules(db, ts) {
  let inserted = 0;
  for (const rule of ALL_TAX_RULES) {
    const existing = await db.one(
      'SELECT id FROM tax_rules WHERE regime = ? AND code = ? AND tenant_id IS NULL AND effective_from = ?',
      [rule.regime, rule.code, rule.effective_from]);
    if (existing) continue;
    await db.insert('tax_rules', {
      id: ID.taxRule(),
      tenant_id: null,
      regime: rule.regime,
      code: rule.code,
      name: rule.name,
      description: rule.source_note ?? null,
      hsn_sac: rule.hsn_sac ?? null,
      section_code: rule.section_code ?? null,
      rate_pct: rule.rate_pct,
      cgst_pct: rule.cgst_pct ?? 0,
      sgst_pct: rule.sgst_pct ?? 0,
      igst_pct: rule.igst_pct ?? 0,
      cess_pct: rule.cess_pct ?? 0,
      threshold_paise: rule.threshold_paise ?? 0,
      payee_type: rule.payee_type ?? null,
      effective_from: rule.effective_from,
      effective_to: rule.effective_to ?? null,
      is_verified: rule.is_verified ?? 1,
      source_note: rule.source_note ?? null,
      created_at: ts,
      updated_at: ts,
    });
    inserted++;
  }
  return { total: ALL_TAX_RULES.length, inserted };
}

/** Resolve a system role id by key — used by provisioning and user invites. */
export async function systemRoleId(db, key) {
  const row = await db.one('SELECT id FROM roles WHERE key = ? AND tenant_id IS NULL', [key]);
  return row?.id ?? null;
}

export async function planIdByKey(db, key) {
  const row = await db.one('SELECT id FROM plans WHERE key = ?', [key]);
  return row?.id ?? null;
}

export { platformScope };
