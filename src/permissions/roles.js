/**
 * The seven system roles from the proposal, and exactly what each one can do.
 *
 * `level` orders the roles for "can this user manage that user" checks: a user
 * may only assign or edit roles at or below their own level.
 */

import { PERMISSION_KEYS } from './catalog.js';

export const ROLE_KEYS = [
  'super_admin', 'admin', 'finance_manager', 'finance_executive',
  'accountant', 'client', 'auditor',
];

const FINANCE_EXECUTIVE = [
  'companies.view', 'companies.switch',
  'clients.view.assigned', 'clients.view', 'clients.update',
  'documents.view', 'documents.upload', 'documents.replace', 'documents.download',
  'documents.comment', 'documents.note.internal', 'documents.verify', 'documents.lock',
  'documents.archive',
  'queries.view', 'queries.create', 'queries.reply', 'queries.resolve',
  'tax.view', 'tax.calculate', 'tax.edit',
  'reports.view', 'reports.create', 'reports.submit', 'reports.export',
  'tasks.view', 'tasks.manage',
  'notifications.view',
  'messaging.view', 'messaging.send',
  'voicenotes.create',
  'support.view', 'support.create', 'support.reply',
  'calls.view.own', 'calls.view', 'calls.place', 'calls.receive', 'calls.transfer',
  'calls.record', 'calls.recordings.listen', 'calls.notes',
  'leads.view', 'leads.manage',
  'ai.ocr', 'ai.verify', 'ai.assistant',
  'attendance.self',
  'analytics.view',
  'profile.manage',
];

const ACCOUNTANT = [
  'companies.view', 'companies.switch',
  'clients.view',
  'documents.view', 'documents.download', 'documents.comment', 'documents.note.internal',
  'queries.view', 'queries.reply',
  'tax.view', 'tax.calculate', 'tax.edit', 'tax.reconcile',
  'reports.view', 'reports.create', 'reports.submit', 'reports.export',
  'tasks.view', 'tasks.manage',
  'notifications.view',
  'voicenotes.create',
  'support.view', 'support.create', 'support.reply',
  'calls.view.own', 'calls.place', 'calls.notes',
  'ai.ocr', 'ai.assistant',
  'analytics.view',
  'invoices.view', 'payments.view', 'payments.record',
  'profile.manage',
];

const FINANCE_MANAGER = [
  ...FINANCE_EXECUTIVE,
  'clients.create', 'clients.assign', 'clients.delete',
  'documents.assign', 'documents.delete',
  'tax.finalise', 'tax.reconcile',
  'reports.approve', 'reports.schedule',
  'approvals.view', 'approvals.decide',
  'users.view',
  'branches.view',
  'billing.view', 'invoices.view', 'invoices.create', 'payments.view', 'payments.record',
  'messaging.broadcast', 'messaging.templates', 'automation.manage',
  'support.manage',
  'calls.analytics',
  'campaigns.view',
  'ai.insights',
  'attendance.view',
  'analytics.build',
  'audit.view',
  'settings.view',
  'notifications.manage',
  'addons.view',
];

const ADMIN = [
  ...FINANCE_MANAGER,
  'companies.create', 'companies.update', 'companies.delete',
  'branches.manage',
  'users.create', 'users.update', 'users.delete',
  'roles.view', 'roles.manage',
  'tax.rules.manage',
  'billing.manage', 'subscriptions.manage', 'invoices.void',
  'payments.pay', 'payments.refund',
  'addons.activate', 'addons.configure',
  'audit.export',
  'security.view', 'security.manage', 'sessions.revoke',
  'settings.manage',
  'integrations.view', 'integrations.manage',
  'api.view', 'api.manage',
  'whitelabel.manage',
  'storage.manage',
  'backup.view', 'backup.manage',
  'attendance.manage',
  'calls.configure', 'calls.recordings.download',
  'calendar.view', 'calendar.manage',
  'esign.view', 'esign.send',
  // Deliberately NOT platform.logs.view: system_logs is platform-wide and
  // carries other organisations' request paths, error messages and stack
  // traces. An organisation's own administrator belongs in its audit trail,
  // not in the platform's operational log.
];

/**
 * The client portal role.
 *
 * Scoped to one client's own records and nothing about the firm that serves
 * them. Several permissions are deliberately absent, because each of them is
 * organisation-wide rather than client-scoped:
 *
 *   settings.view          — the firm's settings and its security policy
 *   notifications.manage   — the firm's templates, and every message it has
 *                            sent to every one of its clients
 *   messaging.view         — the firm's whole WhatsApp inbox
 *   subscriptions.manage   — the firm's own plan with the platform
 *   companies.update       — any company in the firm, not just their own
 *
 * A client's own notification feed and preferences are reached through
 * endpoints scoped to their user id, which need no permission at all.
 */
const CLIENT = [
  'portal.access', 'profile.manage',
  'clients.view.own',
  'companies.view', 'companies.switch',
  'documents.view.own', 'documents.upload', 'documents.replace', 'documents.download',
  'documents.delete', 'documents.comment',
  'queries.view.own', 'queries.reply',
  'reports.view.own', 'reports.signoff', 'reports.export',
  'invoices.view.own', 'payments.view', 'payments.pay',
  'support.view.own', 'support.create', 'support.reply',
  'notifications.view',
  'voicenotes.create',
  'calls.view.own',
];

const AUDITOR = [
  'companies.view', 'companies.switch',
  'clients.view',
  'documents.view', 'documents.download',
  'queries.view',
  'tax.view',
  'reports.view', 'reports.export',
  'approvals.view',
  'invoices.view', 'payments.view',
  'calls.view', 'calls.recordings.listen',
  'audit.view', 'audit.export',
  'security.view',
  'analytics.view',
  'ai.verify',
  'attendance.view',
  'notifications.view',
  'settings.view',
  'profile.manage',
];

/**
 * Super Admin holds every permission. The wildcard is stored rather than an
 * expanded list so a newly added permission is covered without a migration.
 */
export const ROLE_DEFINITIONS = [
  {
    key: 'super_admin', name: 'Super Admin', level: 100,
    description: 'Full platform control — organisations, plans, billing and system configuration.',
    accessLevel: 'Full',
    permissions: ['*'],
    landing: '/admin/dashboard',
  },
  {
    key: 'admin', name: 'Admin', level: 80,
    description: 'User and role management, subscriptions, reports, integrations and backups.',
    accessLevel: 'High',
    permissions: unique(ADMIN),
    landing: '/admin/dashboard',
  },
  {
    key: 'finance_manager', name: 'Finance Manager', level: 65,
    description: 'Approves reports, assigns executives and monitors team performance.',
    accessLevel: 'High',
    permissions: unique(FINANCE_MANAGER),
    landing: '/manager/dashboard',
  },
  {
    key: 'finance_executive', name: 'Finance Executive', level: 50,
    description: 'Verifies documents, raises queries and prepares tax calculations.',
    accessLevel: 'Standard',
    permissions: unique(FINANCE_EXECUTIVE),
    landing: '/finance/dashboard',
  },
  {
    key: 'accountant', name: 'Accountant', level: 45,
    description: 'Supports tax computation and reconciles ledgers and statements.',
    accessLevel: 'Standard',
    permissions: unique(ACCOUNTANT),
    landing: '/finance/dashboard',
  },
  {
    key: 'client', name: 'Client', level: 20,
    description: 'Uploads documents, tracks filing status, reviews reports and pays invoices.',
    accessLevel: 'Scoped',
    permissions: unique(CLIENT),
    landing: '/client/dashboard',
  },
  {
    key: 'auditor', name: 'Auditor', level: 30,
    description: 'Read-only access to verified documents, reports and audit logs.',
    accessLevel: 'Read-Only',
    permissions: unique(AUDITOR),
    landing: '/auditor/dashboard',
  },
];

export const ROLE_MAP = new Map(ROLE_DEFINITIONS.map(r => [r.key, r]));

function unique(list) { return [...new Set(list)]; }

/** Expand a role's grant, resolving the Super Admin wildcard. */
export function permissionsForRole(key) {
  const role = ROLE_MAP.get(key);
  if (!role) return [];
  return role.permissions.includes('*') ? [...PERMISSION_KEYS] : role.permissions;
}

/** The union of several roles' permissions — a user may hold more than one. */
export function permissionsForRoles(keys) {
  const set = new Set();
  for (const key of keys) {
    const role = ROLE_MAP.get(key);
    if (!role) continue;
    if (role.permissions.includes('*')) { set.add('*'); continue; }
    for (const p of role.permissions) set.add(p);
  }
  return set;
}

export function roleLevel(key) { return ROLE_MAP.get(key)?.level ?? 0; }
export function highestLevel(keys) { return Math.max(0, ...keys.map(roleLevel)); }

/** Where a user lands after signing in, decided by their strongest role. */
export function landingPathFor(roleKeys) {
  const best = [...roleKeys].sort((a, b) => roleLevel(b) - roleLevel(a))[0];
  return ROLE_MAP.get(best)?.landing ?? '/client/dashboard';
}

/** A role may only manage roles strictly below its own level. */
export function canManageRole(actorRoleKeys, targetRoleKey) {
  if (actorRoleKeys.includes('super_admin')) return true;
  return highestLevel(actorRoleKeys) > roleLevel(targetRoleKey);
}

/** Roles that are read-only by design; the UI hides write affordances for them. */
export const READ_ONLY_ROLES = new Set(['auditor']);
