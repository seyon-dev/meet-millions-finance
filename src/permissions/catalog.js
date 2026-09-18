/**
 * The permission catalogue.
 *
 * Permissions are `resource.action` strings. They are the only thing the API
 * checks — never a role name — so a tenant can build custom roles without the
 * backend needing to learn about them.
 */

/** @type {{key:string,name:string,category:string,description:string}[]} */
export const PERMISSIONS = [
  // ---- Platform (Super Admin territory) ----
  p('platform.manage',        'Manage the platform',          'Platform', 'Full control of every tenant, plan and platform setting.'),
  p('platform.analytics',     'Platform analytics',           'Platform', 'See revenue, MRR and usage across all tenants.'),
  p('platform.logs.view',     'View system logs',             'Platform', 'Read the platform operational log.'),
  p('tenants.view',           'View organisations',           'Platform', 'List and open tenant organisations.'),
  p('tenants.create',         'Create organisations',         'Platform', 'Onboard a new organisation.'),
  p('tenants.update',         'Update organisations',         'Platform', 'Edit an organisation’s profile and status.'),
  p('tenants.suspend',        'Suspend organisations',        'Platform', 'Suspend or reactivate an organisation.'),
  p('franchises.view',        'View franchises',              'Platform', 'See the franchise network.'),
  p('franchises.manage',      'Manage franchises',            'Platform', 'Onboard franchises and set revenue share.'),
  p('plans.manage',           'Manage subscription plans',    'Platform', 'Create and price subscription plans.'),

  // ---- Companies & branches ----
  p('companies.view',         'View companies',               'Companies', 'See company records in the organisation.'),
  p('companies.create',       'Create companies',             'Companies', 'Add a company / GSTIN.'),
  p('companies.update',       'Update companies',             'Companies', 'Edit company profile, GSTIN, PAN and TAN.'),
  p('companies.delete',       'Archive companies',            'Companies', 'Archive a company record.'),
  p('companies.switch',       'Switch company',               'Companies', 'Use the multi-company switcher.'),
  p('branches.view',          'View branches',                'Branches',  'See branch list and performance.'),
  p('branches.manage',        'Manage branches',              'Branches',  'Create branches and map users and clients.'),

  // ---- Users, roles, permissions ----
  p('users.view',             'View users',                   'Users', 'See the user directory.'),
  p('users.create',           'Invite users',                 'Users', 'Invite a colleague and assign a role.'),
  p('users.update',           'Update users',                 'Users', 'Edit a user profile or status.'),
  p('users.delete',           'Deactivate users',             'Users', 'Deactivate a user account.'),
  p('users.impersonate',      'Impersonate users',            'Users', 'Open a support session as another user.'),
  p('roles.view',             'View roles',                   'Users', 'See roles and their permissions.'),
  p('roles.manage',           'Manage roles',                 'Users', 'Create roles and change permission grants.'),

  // ---- Clients ----
  p('clients.view',           'View clients',                 'Clients', 'See the client list and client files.'),
  p('clients.view.assigned',  'View assigned clients',        'Clients', 'See only clients assigned to you.'),
  p('clients.view.own',       'View own client record',       'Clients', 'A client seeing their own record.'),
  p('clients.create',         'Create clients',               'Clients', 'Onboard a new client.'),
  p('clients.update',         'Update clients',               'Clients', 'Edit client details and settings.'),
  p('clients.delete',         'Archive clients',              'Clients', 'Archive a client record.'),
  p('clients.assign',         'Assign clients',               'Clients', 'Assign executives and managers to clients.'),

  // ---- Documents ----
  p('documents.view',         'View documents',               'Documents', 'Open documents and their version history.'),
  p('documents.view.own',     'View own documents',           'Documents', 'A client seeing documents they uploaded.'),
  p('documents.upload',       'Upload documents',             'Documents', 'Upload files, including bulk ZIP uploads.'),
  p('documents.replace',      'Replace documents',            'Documents', 'Upload a corrected version of a document.'),
  p('documents.delete',       'Delete documents',             'Documents', 'Remove a document that is not locked.'),
  p('documents.download',     'Download documents',           'Documents', 'Download the stored file.'),
  p('documents.comment',      'Comment on documents',         'Documents', 'Add a shared comment to a document.'),
  p('documents.note.internal','Add internal notes',           'Documents', 'Add notes only the internal team can see.'),
  p('documents.verify',       'Verify documents',             'Documents', 'Approve, reject or request changes.'),
  p('documents.lock',         'Lock documents',               'Documents', 'Lock a verified document against edits.'),
  p('documents.archive',      'Archive documents',            'Documents', 'Move a filing package to the archive.'),
  p('documents.assign',       'Assign documents',             'Documents', 'Route a document to an executive.'),

  // ---- Queries ----
  p('queries.view',           'View queries',                 'Queries', 'See query threads.'),
  p('queries.view.own',       'View own queries',             'Queries', 'A client seeing queries raised to them.'),
  p('queries.create',         'Raise queries',                'Queries', 'Raise a query against a document.'),
  p('queries.reply',          'Reply to queries',             'Queries', 'Post a reply on a query thread.'),
  p('queries.resolve',        'Resolve queries',              'Queries', 'Mark a query resolved.'),

  // ---- Tax ----
  p('tax.view',               'View tax computations',        'Tax', 'Open GST and TDS computations.'),
  p('tax.calculate',          'Run tax calculations',         'Tax', 'Compute GST and TDS from verified documents.'),
  p('tax.edit',               'Edit tax records',             'Tax', 'Correct individual GST/TDS lines.'),
  p('tax.finalise',           'Finalise computations',        'Tax', 'Lock a computation as final.'),
  p('tax.rules.manage',       'Manage tax rules',             'Tax', 'Add or amend tax rates and thresholds.'),
  p('tax.reconcile',          'Reconcile ledgers',            'Tax', 'Reconcile statements against computed records.'),

  // ---- Reports ----
  p('reports.view',           'View reports',                 'Reports', 'Open generated reports.'),
  p('reports.view.own',       'View own reports',             'Reports', 'A client seeing reports about their filings.'),
  p('reports.create',         'Generate reports',             'Reports', 'Generate a report from computed data.'),
  p('reports.submit',         'Submit for approval',          'Reports', 'Send a report to a manager for approval.'),
  p('reports.approve',        'Approve reports',              'Reports', 'Approve or reject a submitted report.'),
  p('reports.signoff',        'Sign off reports',             'Reports', 'Client sign-off before filing.'),
  p('reports.export',         'Export reports',               'Reports', 'Download a report as CSV or PDF.'),
  p('reports.schedule',       'Schedule reports',             'Reports', 'Configure scheduled report exports.'),

  // ---- Tasks & approvals ----
  p('tasks.view',             'View tasks',                   'Tasks', 'See the task board.'),
  p('tasks.manage',           'Manage tasks',                 'Tasks', 'Create, assign and close tasks.'),
  p('approvals.view',         'View approvals',               'Approvals', 'See the approval queue.'),
  p('approvals.decide',       'Decide approvals',             'Approvals', 'Approve or reject queued items.'),

  // ---- Billing ----
  p('billing.view',           'View billing',                 'Billing', 'See subscription, invoices and payments.'),
  p('billing.manage',         'Manage billing',               'Billing', 'Change plan, seats and billing details.'),
  p('invoices.view',          'View invoices',                'Billing', 'Open invoices.'),
  p('invoices.view.own',      'View own invoices',            'Billing', 'A client seeing their own invoices.'),
  p('invoices.create',        'Create invoices',              'Billing', 'Raise an invoice to a client.'),
  p('invoices.void',          'Void invoices',                'Billing', 'Void or credit-note an invoice.'),
  p('payments.view',          'View payments',                'Billing', 'See the payment ledger.'),
  p('payments.pay',           'Make payments',                'Billing', 'Pay an invoice through the gateway.'),
  p('payments.record',        'Record payments',              'Billing', 'Record an offline payment.'),
  p('payments.refund',        'Refund payments',              'Billing', 'Issue a refund.'),
  p('subscriptions.manage',   'Manage subscription',          'Billing', 'Upgrade, downgrade or cancel the plan.'),

  // ---- Add-ons ----
  p('addons.view',            'View add-on marketplace',      'Add-ons', 'Browse available add-on modules.'),
  p('addons.activate',        'Activate add-ons',             'Add-ons', 'Turn an add-on on or off.'),
  p('addons.configure',       'Configure add-ons',            'Add-ons', 'Change an add-on’s settings.'),

  // ---- Communication ----
  p('notifications.view',     'View notifications',           'Communication', 'See the notification centre.'),
  p('notifications.manage',   'Manage notification settings', 'Communication', 'Change channels, templates and triggers.'),
  p('messaging.view',         'View conversations',           'Communication', 'Open the WhatsApp/SMS inbox.'),
  p('messaging.send',         'Send messages',                'Communication', 'Send a message to a client.'),
  p('messaging.broadcast',    'Send broadcasts',              'Communication', 'Run a broadcast campaign.'),
  p('messaging.templates',    'Manage templates',             'Communication', 'Create and submit message templates.'),
  p('automation.manage',      'Manage automation rules',      'Communication', 'Create trigger-based automation.'),
  p('voicenotes.create',      'Record voice notes',           'Communication', 'Attach a voice note to a record.'),

  // ---- Support ----
  p('support.view',           'View tickets',                 'Support', 'See the support queue.'),
  p('support.view.own',       'View own tickets',             'Support', 'A client seeing their own tickets.'),
  p('support.create',         'Raise tickets',                'Support', 'Open a support ticket.'),
  p('support.reply',          'Reply to tickets',             'Support', 'Reply on a ticket thread.'),
  p('support.manage',         'Manage tickets',               'Support', 'Assign, prioritise and close tickets.'),

  // ---- Calling ----
  p('calls.view',             'View call history',            'Calling', 'See call logs and the call timeline.'),
  p('calls.view.own',         'View own calls',               'Calling', 'See only your own calls.'),
  p('calls.place',            'Place calls',                  'Calling', 'Use click-to-call and the dial pad.'),
  p('calls.receive',          'Receive calls',                'Calling', 'Answer inbound calls in the CRM.'),
  p('calls.transfer',         'Transfer calls',               'Calling', 'Transfer or conference a live call.'),
  p('calls.record',           'Control recording',            'Calling', 'Start or stop recording on a call.'),
  p('calls.recordings.listen','Listen to recordings',         'Calling', 'Play a call recording inside the CRM.'),
  p('calls.recordings.download','Download recordings',        'Calling', 'Download a call recording file.'),
  p('calls.notes',            'Add call notes',               'Calling', 'Write notes and set a disposition.'),
  p('calls.analytics',        'View call analytics',          'Calling', 'See calling dashboards and leaderboards.'),
  p('calls.configure',        'Configure telephony',          'Calling', 'Set the provider, IVR and recording policy.'),

  // ---- Leads ----
  p('leads.view',             'View leads',                   'Leads', 'Open the lead inbox.'),
  p('leads.manage',           'Manage leads',                 'Leads', 'Assign, merge and convert leads.'),
  p('campaigns.view',         'View campaigns',               'Leads', 'See campaign performance.'),

  // ---- AI ----
  p('ai.ocr',                 'Use OCR extraction',           'AI', 'Run OCR and review extracted fields.'),
  p('ai.verify',              'Use AI pre-screening',         'AI', 'See AI document verification results.'),
  p('ai.assistant',           'Use the tax assistant',        'AI', 'Ask the GST/TDS assistant questions.'),
  p('ai.insights',            'View business insights',       'AI', 'Read the AI insight feed.'),

  // ---- Attendance ----
  p('attendance.self',        'Record own attendance',        'Field ops', 'Check in and out with GPS.'),
  p('attendance.view',        'View attendance',              'Field ops', 'See attendance and travel reports.'),
  p('attendance.manage',      'Manage attendance',            'Field ops', 'Correct attendance records.'),

  // ---- Calendar ----
  p('calendar.view',          'View the calendar',            'Calendar', 'See deadlines, meetings and reminders.'),
  p('calendar.manage',        'Manage calendar events',       'Calendar', 'Create and edit events, and sync a provider.'),

  // ---- e-Sign ----
  p('esign.view',             'View signature requests',      'e-Sign', 'See who has signed and who has not.'),
  p('esign.send',             'Send for signature',           'e-Sign', 'Send a document or report for e-signature.'),

  // ---- Analytics ----
  p('analytics.view',         'View analytics',               'Analytics', 'Open analytics dashboards.'),
  p('analytics.build',        'Build custom reports',         'Analytics', 'Use the custom report builder.'),

  // ---- Audit & security ----
  p('audit.view',             'View audit logs',              'Audit', 'Read the tenant audit trail.'),
  p('audit.export',           'Export audit logs',            'Audit', 'Export a compliance report.'),
  p('security.view',          'View security settings',       'Security', 'See the security policy and devices.'),
  p('security.manage',        'Manage security policy',       'Security', 'Change 2FA, IP allow-list and sessions.'),
  p('sessions.revoke',        'Revoke sessions',              'Security', 'Sign another user out of a device.'),

  // ---- Settings & platform config ----
  p('settings.view',          'View settings',                'Settings', 'Open the settings area.'),
  p('settings.manage',        'Manage settings',              'Settings', 'Change organisation-wide settings.'),
  p('integrations.view',      'View integrations',            'Settings', 'See integration connection status.'),
  p('integrations.manage',    'Manage integrations',          'Settings', 'Connect and configure integrations.'),
  p('api.view',               'View API keys',                'Settings', 'See API keys and usage.'),
  p('api.manage',             'Manage API keys',              'Settings', 'Create and revoke API keys.'),
  p('whitelabel.manage',      'Manage branding',              'Settings', 'Change logo, colours and custom domain.'),
  p('storage.manage',         'Manage storage',               'Settings', 'Configure cloud storage sync.'),
  p('backup.view',            'View backups',                 'Settings', 'See the backup history.'),
  p('backup.manage',          'Run backups and restores',     'Settings', 'Trigger a backup or restore.'),

  // ---- Client self-service ----
  p('profile.manage',         'Manage own profile',           'Profile', 'Edit your own profile and password.'),
  p('portal.access',          'Access the client portal',     'Profile', 'Sign in to the client portal.'),
];

function p(key, name, category, description) {
  const [resource, ...rest] = key.split('.');
  return { key, name, category, description, resource, action: rest.join('.') };
}

export const PERMISSION_KEYS = PERMISSIONS.map(x => x.key);
export const PERMISSION_MAP = new Map(PERMISSIONS.map(x => [x.key, x]));

export function isKnownPermission(key) { return PERMISSION_MAP.has(key); }

export function permissionsByCategory() {
  const groups = new Map();
  for (const perm of PERMISSIONS) {
    if (!groups.has(perm.category)) groups.set(perm.category, []);
    groups.get(perm.category).push(perm);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}
