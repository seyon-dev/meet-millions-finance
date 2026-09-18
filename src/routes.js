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

  // Outside /api: binary responses linked directly from the page, and inbound
  // webhooks whose authentication is a signature rather than a session.
  router.mount('/files', filesRouter);
  router.mount('/webhooks', webhooksRouter);
  return router;
}
