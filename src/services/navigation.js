/**
 * Role-aware navigation.
 *
 * The proposal specifies a distinct navigation set per role, and the dashboard
 * mock-ups show them in a particular order. That structure is defined here
 * once and used by both the sidebar and the mobile tab bar.
 *
 * An item the user's plan does not include is not hidden — it is returned with
 * `locked: true` and the reason, so the UI can show it with a lock and route
 * to the upgrade path instead of pretending the feature does not exist. An
 * item the user's *role* cannot access is omitted entirely.
 */

import { getEntitlements, FEATURES } from './features.js';

/**
 * Every navigation item in the product.
 *  - `permission` / `anyPermission`: role gate (omit ⇒ omit the item)
 *  - `feature`: plan/add-on gate (locked, not hidden)
 *  - `roles`: restrict to specific roles even if the permission is held
 *  - `badge`: a live counter key resolved by the client
 */
const NAV = {
  // ---- Platform (Super Admin) ---------------------------------------------
  platform: {
    label: 'Platform',
    items: [
      { key: 'platform_dashboard', label: 'Dashboard',      path: '/admin/dashboard',       icon: 'layout-dashboard', permission: 'platform.analytics' },
      { key: 'organisations',      label: 'Organisations',  path: '/platform/organisations', icon: 'building',        permission: 'tenants.view' },
      { key: 'franchises',         label: 'Franchises',     path: '/platform/franchises',    icon: 'network',         permission: 'franchises.view', feature: 'franchise' },
      { key: 'plans',              label: 'Plans & Pricing',path: '/platform/plans',         icon: 'tag',             permission: 'plans.manage' },
      // The revenue screen and its route existed from the start with nothing
      // linking to them, so the only way to reach it was to type the URL.
      { key: 'platform_revenue',   label: 'Revenue',        path: '/platform/revenue',       icon: 'trending-up',     permission: 'platform.analytics' },
      { key: 'system_logs',        label: 'System Logs',    path: '/platform/logs',          icon: 'terminal',        permission: 'platform.logs.view' },
    ],
  },

  // ---- Admin --------------------------------------------------------------
  workspace: {
    label: 'Workspace',
    items: [
      { key: 'dashboard',      label: 'Dashboard',        path: '/admin/dashboard',    icon: 'layout-dashboard', anyPermission: ['platform.analytics', 'analytics.view'], roles: ['super_admin', 'admin'] },
      { key: 'companies',      label: 'Companies',        path: '/companies',          icon: 'building-2',       permission: 'companies.view' },
      { key: 'users_roles',    label: 'Users & Roles',    path: '/settings/users',     icon: 'users',            permission: 'users.view' },
      { key: 'subscriptions',  label: 'Subscriptions',    path: '/billing/subscription', icon: 'refresh-cw',     permission: 'billing.view' },
      { key: 'payments',       label: 'Payments',         path: '/billing/payments',   icon: 'credit-card',      permission: 'payments.view' },
      { key: 'analytics',      label: 'Analytics',        path: '/analytics',          icon: 'bar-chart',        permission: 'analytics.view' },
      { key: 'audit_logs',     label: 'Audit Logs',       path: '/audit',              icon: 'scroll-text',      permission: 'audit.view', feature: 'audit_logs' },
      { key: 'backup',         label: 'Backup & Restore', path: '/settings/backup',    icon: 'database',         permission: 'backup.view' },
    ],
  },

  // ---- Finance team -------------------------------------------------------
  finance: {
    label: 'Finance',
    items: [
      { key: 'finance_dashboard', label: 'Dashboard',        path: '/finance/dashboard',   icon: 'layout-dashboard', anyPermission: ['documents.verify', 'tax.calculate'], roles: ['finance_executive', 'accountant'] },
      { key: 'clients',           label: 'Clients',          path: '/clients',             icon: 'users-round',      anyPermission: ['clients.view', 'clients.view.assigned'] },
      { key: 'verification',      label: 'Verification Queue', path: '/verification',      icon: 'clipboard-check',  permission: 'documents.verify', badge: 'pendingVerification' },
      { key: 'tax',               label: 'Tax Calculation',  path: '/tax',                 icon: 'calculator',       permission: 'tax.view' },
      { key: 'reconciliation',    label: 'Reconciliation',   path: '/tax/reconciliation',  icon: 'git-compare',      permission: 'tax.reconcile' },
      { key: 'tasks',             label: 'Tasks',            path: '/tasks',               icon: 'check-square',     permission: 'tasks.view', badge: 'openTasks' },
      { key: 'reports',           label: 'Reports',          path: '/reports',             icon: 'file-text',        anyPermission: ['reports.view', 'reports.view.own'] },
      { key: 'activity',          label: 'Activity Log',     path: '/activity',            icon: 'activity',         anyPermission: ['clients.view', 'clients.view.assigned'] },
    ],
  },

  // ---- Manager ------------------------------------------------------------
  manager: {
    label: 'Management',
    items: [
      { key: 'manager_dashboard', label: 'Dashboard',   path: '/manager/dashboard', icon: 'layout-dashboard', permission: 'approvals.view', roles: ['finance_manager'] },
      { key: 'approvals',         label: 'Approvals',   path: '/approvals',         icon: 'clipboard-check',  permission: 'approvals.view', badge: 'pendingApprovals' },
      { key: 'team',              label: 'Team',        path: '/team',              icon: 'users',            permission: 'users.view', roles: ['finance_manager', 'admin', 'super_admin'] },
      { key: 'performance',       label: 'Performance', path: '/team/performance',  icon: 'trending-up',      permission: 'analytics.view', roles: ['finance_manager', 'admin', 'super_admin'] },
      // /reports/revenue was never a route — the SPA read it as report id
      // "revenue" and showed a not-found. The payments ledger is the revenue
      // view that exists, and it matches this item's billing.view permission.
      { key: 'revenue',           label: 'Revenue',     path: '/billing/payments',  icon: 'indian-rupee',     permission: 'billing.view', roles: ['finance_manager', 'admin', 'super_admin'] },
    ],
  },

  // ---- Client portal ------------------------------------------------------
  client: {
    label: 'My account',
    items: [
      { key: 'client_dashboard', label: 'Dashboard',        path: '/client/dashboard',   icon: 'layout-dashboard', permission: 'portal.access' },
      { key: 'upload',           label: 'Upload Documents', path: '/client/upload',      icon: 'upload-cloud',     permission: 'documents.upload' },
      { key: 'filing_status',    label: 'Filing Status',    path: '/client/filings',     icon: 'activity',         permission: 'portal.access' },
      { key: 'client_queries',   label: 'Queries',          path: '/client/queries',     icon: 'help-circle',      permission: 'queries.view.own', badge: 'openQueries' },
      { key: 'client_reports',   label: 'Reports',          path: '/client/reports',     icon: 'file-text',        permission: 'reports.view.own' },
      { key: 'client_payments',  label: 'Payments',         path: '/client/payments',    icon: 'credit-card',      permission: 'payments.view' },
      { key: 'client_invoices',  label: 'Invoices',         path: '/client/invoices',    icon: 'receipt',          permission: 'invoices.view.own' },
      { key: 'client_support',   label: 'Support Tickets',  path: '/support',            icon: 'life-buoy',        anyPermission: ['support.view.own', 'support.view'] },
    ],
  },

  // ---- Auditor ------------------------------------------------------------
  auditor: {
    label: 'Audit',
    items: [
      { key: 'auditor_dashboard', label: 'Dashboard',          path: '/auditor/dashboard', icon: 'layout-dashboard', permission: 'audit.view', roles: ['auditor'] },
      { key: 'verified_docs',     label: 'Verified Documents', path: '/documents?status=verified', icon: 'file-check', permission: 'documents.view', roles: ['auditor'] },
      { key: 'auditor_logs',      label: 'Audit Logs',         path: '/audit',             icon: 'scroll-text',      permission: 'audit.view', roles: ['auditor'] },
      { key: 'auditor_reports',   label: 'Reports',            path: '/reports',           icon: 'file-text',        permission: 'reports.view', roles: ['auditor'] },
    ],
  },

  // ---- Communication ------------------------------------------------------
  communication: {
    label: 'Communication',
    items: [
      { key: 'calls',        label: 'Calls',        path: '/calls',            icon: 'phone',          anyPermission: ['calls.view', 'calls.view.own'], feature: 'cloud_telephony' },
      { key: 'inbox',        label: 'Chat Inbox',   path: '/messaging/inbox',  icon: 'message-circle', permission: 'messaging.view', feature: 'whatsapp_integration', badge: 'unreadChats' },
      { key: 'automation',   label: 'Automation',   path: '/automation',       icon: 'zap',            permission: 'automation.manage', feature: 'email_automation' },
      { key: 'leads',        label: 'Leads',        path: '/leads',            icon: 'magnet',         permission: 'leads.view', feature: 'meta_lead_ads', badge: 'newLeads' },
      { key: 'voice_notes',  label: 'Voice Notes',  path: '/voice-notes',      icon: 'mic',            permission: 'voicenotes.create', feature: 'voice_notes' },
      { key: 'calendar',     label: 'Calendar',     path: '/calendar',         icon: 'calendar',       permission: 'tasks.view', feature: 'calendar_sync' },
      { key: 'support',      label: 'Support',      path: '/support',          icon: 'life-buoy',      permission: 'support.view', badge: 'openTickets' },
    ],
  },

  // ---- Intelligence -------------------------------------------------------
  intelligence: {
    label: 'Intelligence',
    items: [
      { key: 'ai_assistant', label: 'Tax Assistant', path: '/ai/assistant',     icon: 'sparkles',  permission: 'ai.assistant', feature: 'ai_tax_assistant' },
      { key: 'ai_insights',  label: 'Insights',      path: '/ai/insights',      icon: 'lightbulb', permission: 'ai.insights',  feature: 'ai_business_insights' },
      { key: 'ai_ocr',       label: 'OCR Review',    path: '/ai/ocr',           icon: 'scan-text', permission: 'ai.ocr',       feature: 'ocr_ai', badge: 'ocrPending' },
      { key: 'report_builder', label: 'Report Builder', path: '/analytics/builder', icon: 'bar-chart-3', permission: 'analytics.build', feature: 'advanced_reports' },
    ],
  },

  // ---- Field ops ----------------------------------------------------------
  field: {
    label: 'Field operations',
    items: [
      { key: 'attendance', label: 'Attendance', path: '/attendance', icon: 'map-pin', anyPermission: ['attendance.self', 'attendance.view'], feature: 'gps_attendance' },
    ],
  },

  // ---- Marketplace & settings --------------------------------------------
  configure: {
    label: 'Configure',
    items: [
      { key: 'marketplace',  label: 'Add-On Marketplace', path: '/marketplace',           icon: 'grid-3x3',  permission: 'addons.view' },
      { key: 'integrations', label: 'Integrations',       path: '/settings/integrations', icon: 'plug',      permission: 'integrations.view' },
      { key: 'branding',     label: 'White Label',        path: '/settings/branding',     icon: 'palette',   permission: 'whitelabel.manage', feature: 'white_label' },
      { key: 'branches',     label: 'Branches',           path: '/settings/branches',     icon: 'building',  permission: 'branches.view', feature: 'multi_branch' },
      { key: 'api',          label: 'API Keys',           path: '/settings/api',          icon: 'key',       permission: 'api.view', feature: 'api_access' },
      { key: 'security',     label: 'Security',           path: '/settings/security',     icon: 'shield',    permission: 'security.view' },
      { key: 'settings',     label: 'Settings',           path: '/settings',              icon: 'settings',  permission: 'settings.view' },
    ],
  },
};

/** The order groups appear in, per primary role. */
const GROUP_ORDER = {
  super_admin:      ['platform', 'workspace', 'finance', 'communication', 'intelligence', 'field', 'configure'],
  admin:            ['workspace', 'finance', 'manager', 'communication', 'intelligence', 'field', 'configure'],
  finance_manager:  ['manager', 'finance', 'communication', 'intelligence', 'field', 'configure'],
  finance_executive:['finance', 'communication', 'intelligence', 'field', 'configure'],
  accountant:       ['finance', 'communication', 'intelligence', 'configure'],
  auditor:          ['auditor', 'configure'],
  client:           ['client', 'communication', 'configure'],
};

/** Bottom tab bar on phones — at most five, the most-used per role. */
const MOBILE_TABS = {
  super_admin:       ['platform_dashboard', 'organisations', 'analytics', 'marketplace', 'settings'],
  admin:             ['dashboard', 'clients', 'verification', 'reports', 'settings'],
  finance_manager:   ['manager_dashboard', 'approvals', 'clients', 'reports', 'team'],
  finance_executive: ['finance_dashboard', 'verification', 'clients', 'tasks', 'calls'],
  accountant:        ['finance_dashboard', 'clients', 'tax', 'reports', 'tasks'],
  auditor:           ['auditor_dashboard', 'verified_docs', 'auditor_logs', 'auditor_reports'],
  client:            ['client_dashboard', 'upload', 'filing_status', 'client_payments', 'client_support'],
};

function primaryRole(roleKeys) {
  const order = ['super_admin', 'admin', 'finance_manager', 'finance_executive', 'accountant', 'auditor', 'client'];
  return order.find(r => roleKeys.includes(r)) ?? 'client';
}

function itemAllowed(ctx, item, role) {
  if (item.roles && !item.roles.some(r => ctx.hasRole(r))) return false;
  if (item.permission && !ctx.has(item.permission)) return false;
  if (item.anyPermission && !item.anyPermission.some(p => ctx.has(p))) return false;
  return true;
}

/**
 * Build the navigation for the signed-in user.
 * @returns {{groups: object[], mobileTabs: object[], primaryRole: string}}
 */
export async function navigationFor(ctx, entitlementsPayloadMaybe = null) {
  const entitlements = entitlementsPayloadMaybe
    ? { features: new Set(entitlementsPayloadMaybe.features) }
    : await getEntitlements(ctx);

  const role = primaryRole(ctx.roleKeys ?? []);

  /**
   * A platform Super Admin belongs to no organisation, and every screen outside
   * the platform group works inside one. Offering them Clients, Verification or
   * Tax would be offering a screen that cannot load — permissions say yes, the
   * absence of a tenant says no, and the tenant is what decides here.
   *
   * A Super Admin who does belong to an organisation, or who is impersonating
   * inside one, keeps the full navigation.
   */
  const groupKeys = !ctx.tenantId
    ? ['platform']
    : (GROUP_ORDER[role] ?? GROUP_ORDER.client);
  const byKey = new Map();

  const groups = [];
  for (const groupKey of groupKeys) {
    const group = NAV[groupKey];
    if (!group) continue;

    const items = [];
    for (const item of group.items) {
      if (!itemAllowed(ctx, item, role)) continue;

      const locked = !!item.feature && !entitlements.features.has(item.feature);
      const def = item.feature ? FEATURES[item.feature] : null;

      const entry = {
        key: item.key,
        label: item.label,
        path: item.path,
        icon: item.icon,
        badge: item.badge ?? null,
        locked,
        lock: locked ? {
          feature: item.feature,
          featureName: def?.name ?? item.label,
          requiredPlan: def?.plans?.[0] ?? null,
          requiredAddOn: def?.addOn ?? null,
          upgradePath: def?.addOn ? `/marketplace?addon=${def.addOn}` : '/billing/subscription',
        } : null,
      };
      items.push(entry);
      byKey.set(item.key, entry);
    }

    if (items.length) groups.push({ key: groupKey, label: group.label, items });
  }

  const tabKeys = MOBILE_TABS[role] ?? MOBILE_TABS.client;
  const mobileTabs = tabKeys.map(k => byKey.get(k)).filter(Boolean).slice(0, 5);

  return { primaryRole: role, groups, mobileTabs };
}

/** Flat list of every route a role could reach — used by the router guard. */
export function allNavItems() {
  return Object.values(NAV).flatMap(g => g.items);
}

export { NAV, GROUP_ORDER, MOBILE_TABS, primaryRole };
