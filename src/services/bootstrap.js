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

  if (verbose) console.log('bootstrap complete', report);
  return report;
}

// ---------------------------------------------------------------------------

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
