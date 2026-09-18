/**
 * Route registry.
 *
 * Every module exports a Router of its own; this file mounts them under their
 * API prefix. Keeping the mounting in one place means the full API surface is
 * readable at a glance, and a route cannot be shipped without appearing here.
 */

import { authRouter } from './modules/auth.js';
import { clientsRouter } from './modules/clients.js';
import { documentsRouter } from './modules/documents.js';
import { verificationRouter } from './modules/verification.js';
import { queriesRouter } from './modules/queries.js';
import { taxRouter } from './modules/tax.js';
import { reportsRouter } from './modules/reports.js';
import { approvalsRouter } from './modules/approvals.js';
import { tasksRouter } from './modules/tasks.js';
import { billingRouter } from './modules/billing.js';
import { addonsRouter } from './modules/addons.js';
import { callsRouter } from './modules/calls.js';
import { usersRouter } from './modules/users.js';
import { companiesRouter } from './modules/companies.js';
import { branchesRouter } from './modules/branches.js';
import { settingsRouter } from './modules/settings.js';
import { dashboardsRouter } from './modules/dashboards.js';
import { filesRouter } from './modules/files.js';
import { webhooksRouter } from './modules/webhooks.js';
import { auditRouter } from './modules/audit.js';
import { notificationsRouter } from './modules/notifications.js';
import { searchRouter } from './modules/search.js';
import { integrationsRouter } from './modules/integrations.js';
import { platformRouter } from './modules/platform.js';
import { leadsRouter } from './modules/leads.js';
import { messagingRouter } from './modules/messaging.js';
import { automationRouter } from './modules/automation.js';
import { supportRouter } from './modules/support.js';
import { fieldOpsRouter } from './modules/fieldops.js';
import { workspaceRouter } from './modules/workspace.js';
import { aiRouter } from './modules/ai.js';
import { analyticsRouter } from './modules/analytics.js';

export function registerRoutes(router) {
  router.mount('/api/auth', authRouter);
  router.mount('/api/clients', clientsRouter);
  router.mount('/api/documents', documentsRouter);
  router.mount('/api/verification', verificationRouter);
  router.mount('/api/queries', queriesRouter);
  router.mount('/api/tax', taxRouter);
  router.mount('/api/reports', reportsRouter);
  router.mount('/api/approvals', approvalsRouter);
  router.mount('/api/tasks', tasksRouter);
  router.mount('/api/billing', billingRouter);
  router.mount('/api/addons', addonsRouter);
  router.mount('/api/calls', callsRouter);
  router.mount('/api/users', usersRouter);
  router.mount('/api/companies', companiesRouter);
  router.mount('/api/branches', branchesRouter);
  router.mount('/api/settings', settingsRouter);
  router.mount('/api/dashboard', dashboardsRouter);
  router.mount('/api/audit', auditRouter);
  router.mount('/api/notifications', notificationsRouter);
  router.mount('/api/search', searchRouter);
  router.mount('/api/integrations', integrationsRouter);
  router.mount('/api/platform', platformRouter);
  router.mount('/api/leads', leadsRouter);
  router.mount('/api/messaging', messagingRouter);
  router.mount('/api/automation', automationRouter);
  router.mount('/api/support', supportRouter);
  router.mount('/api/attendance', fieldOpsRouter);
  router.mount('/api/ai', aiRouter);
  router.mount('/api/analytics', analyticsRouter);

  // Calendar, e-sign, API keys, branding and backups share one module; they
  // are mounted at their own paths so the API surface reads by capability.
  router.mount('/api', workspaceRouter);

  // Outside /api: binary responses linked directly from the page, and inbound
  // webhooks whose authentication is a signature rather than a session.
  router.mount('/files', filesRouter);
  router.mount('/webhooks', webhooksRouter);
  return router;
}
