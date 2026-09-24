/**
 * Notification triggers and their default templates.
 *
 * The proposal's Automation Layer names: Automatic Email, WhatsApp Alerts,
 * SMS Alerts, Due Date Reminder, GST Reminder, Monthly Reminder, Subscription
 * Reminder and Payment Reminder. Everything below implements that layer plus
 * the workflow events the CRM raises along the way.
 *
 * Placeholders use {{name}} and are substituted by `services/notifications.js`.
 */

export const NOTIFICATION_TRIGGERS = [
  // ---- Account & security --------------------------------------------------
  { key: 'account.registered',        name: 'Account created',            category: 'Account',  audience: 'user',   defaultChannels: ['email', 'in_app'] },
  { key: 'account.invited',           name: 'User invited',               category: 'Account',  audience: 'user',   defaultChannels: ['email'] },
  { key: 'account.password_reset',    name: 'Password reset requested',   category: 'Account',  audience: 'user',   defaultChannels: ['email'] },
  { key: 'account.password_changed',  name: 'Password changed',           category: 'Account',  audience: 'user',   defaultChannels: ['email', 'in_app'] },
  { key: 'security.login_anomaly',    name: 'Unusual sign-in detected',   category: 'Security', audience: 'user',   defaultChannels: ['email', 'in_app'] },
  { key: 'security.2fa_enabled',      name: 'Two-factor enabled',         category: 'Security', audience: 'user',   defaultChannels: ['email'] },

  // ---- Documents & verification -------------------------------------------
  { key: 'document.uploaded',         name: 'Document uploaded',          category: 'Documents', audience: 'team',   defaultChannels: ['in_app'] },
  { key: 'document.verified',         name: 'Document verified',          category: 'Documents', audience: 'client', defaultChannels: ['email', 'in_app', 'whatsapp'] },
  { key: 'document.rejected',         name: 'Document rejected',          category: 'Documents', audience: 'client', defaultChannels: ['email', 'in_app', 'whatsapp'] },
  { key: 'document.changes_requested',name: 'Changes requested',          category: 'Documents', audience: 'client', defaultChannels: ['email', 'in_app'] },

  // ---- Queries -------------------------------------------------------------
  { key: 'query.raised',              name: 'Query raised',               category: 'Queries',  audience: 'client', defaultChannels: ['email', 'in_app', 'whatsapp', 'sms'] },
  { key: 'query.client_replied',      name: 'Client replied to query',    category: 'Queries',  audience: 'team',   defaultChannels: ['in_app', 'email'] },
  { key: 'query.resolved',            name: 'Query resolved',             category: 'Queries',  audience: 'client', defaultChannels: ['email', 'in_app'] },

  // ---- Reports & approvals -------------------------------------------------
  { key: 'report.generated',          name: 'Report generated',           category: 'Reports',  audience: 'team',   defaultChannels: ['in_app'] },
  { key: 'report.submitted',          name: 'Report submitted for approval', category: 'Reports', audience: 'manager', defaultChannels: ['in_app', 'email'] },
  { key: 'report.approved',           name: 'Manager approved report',    category: 'Reports',  audience: 'client', defaultChannels: ['email', 'in_app', 'whatsapp'] },
  { key: 'report.rejected',           name: 'Manager rejected report',    category: 'Reports',  audience: 'team',   defaultChannels: ['in_app', 'email'] },
  { key: 'report.signed_off',         name: 'Client signed off report',   category: 'Reports',  audience: 'team',   defaultChannels: ['in_app', 'email'] },
  { key: 'filing.archived',           name: 'Filing archived',            category: 'Reports',  audience: 'client', defaultChannels: ['email', 'in_app'] },

  // ---- Payments & billing --------------------------------------------------
  { key: 'payment.due',               name: 'Payment due',                category: 'Billing',  audience: 'client', defaultChannels: ['email', 'sms', 'whatsapp', 'in_app'] },
  { key: 'payment.reminder',          name: 'Payment reminder',           category: 'Billing',  audience: 'client', defaultChannels: ['email', 'sms', 'whatsapp'] },
  { key: 'payment.overdue',           name: 'Payment overdue',            category: 'Billing',  audience: 'client', defaultChannels: ['email', 'sms', 'whatsapp', 'in_app'] },
  { key: 'payment.successful',        name: 'Payment successful',         category: 'Billing',  audience: 'client', defaultChannels: ['email', 'in_app', 'whatsapp'] },
  { key: 'payment.failed',            name: 'Payment failed',             category: 'Billing',  audience: 'client', defaultChannels: ['email', 'in_app'] },
  { key: 'invoice.issued',            name: 'Invoice issued',             category: 'Billing',  audience: 'client', defaultChannels: ['email', 'in_app'] },
  { key: 'subscription.renewal',      name: 'Subscription renewal due',   category: 'Billing',  audience: 'admin',  defaultChannels: ['email', 'in_app'] },
  { key: 'subscription.expired',      name: 'Subscription expired',       category: 'Billing',  audience: 'admin',  defaultChannels: ['email', 'in_app'] },

  // ---- Statutory reminders (the proposal's Automation Layer) ---------------
  { key: 'gst.due_date',              name: 'GST due date reminder',      category: 'Reminders', audience: 'client', defaultChannels: ['email', 'sms', 'whatsapp', 'in_app'] },
  { key: 'reminder.monthly',          name: 'Monthly document reminder',  category: 'Reminders', audience: 'client', defaultChannels: ['email', 'whatsapp'] },
  { key: 'reminder.due_date',         name: 'Filing due date reminder',   category: 'Reminders', audience: 'client', defaultChannels: ['email', 'sms', 'in_app'] },
  { key: 'reminder.documents_pending',name: 'Documents still pending',    category: 'Reminders', audience: 'client', defaultChannels: ['email', 'whatsapp'] },

  // ---- Support & calling ---------------------------------------------------
  { key: 'ticket.created',            name: 'Support ticket created',     category: 'Support',  audience: 'team',   defaultChannels: ['in_app', 'email'] },
  { key: 'ticket.replied',            name: 'Support ticket updated',     category: 'Support',  audience: 'client', defaultChannels: ['email', 'in_app'] },
  { key: 'ticket.resolved',           name: 'Support ticket resolved',    category: 'Support',  audience: 'client', defaultChannels: ['email', 'in_app'] },
  { key: 'call.missed',               name: 'Missed call',                category: 'Calling',  audience: 'team',   defaultChannels: ['in_app'] },
  { key: 'call.follow_up',            name: 'Call follow-up due',         category: 'Calling',  audience: 'team',   defaultChannels: ['in_app', 'email'] },

  // ---- Leads & tasks -------------------------------------------------------
  { key: 'lead.assigned',             name: 'Lead assigned to you',       category: 'Leads',    audience: 'team',   defaultChannels: ['in_app', 'email'] },
  { key: 'task.assigned',             name: 'Task assigned to you',       category: 'Tasks',    audience: 'team',   defaultChannels: ['in_app'] },
  { key: 'task.due',                  name: 'Task due',                   category: 'Tasks',    audience: 'team',   defaultChannels: ['in_app', 'email'] },

  // ---- Insights ------------------------------------------------------------
  { key: 'insights.weekly_digest',    name: 'Weekly insight digest',      category: 'Insights', audience: 'manager', defaultChannels: ['email', 'in_app'] },
];

export const TRIGGER_MAP = new Map(NOTIFICATION_TRIGGERS.map(t => [t.key, t]));

/**
 * Default templates. Email bodies are plain text with placeholders; the
 * dispatcher wraps them in the branded HTML shell. WhatsApp bodies map to an
 * approved template name at the provider — a message is only sent when that
 * template has been approved, never as free text outside the 24-hour window.
 */
export const DEFAULT_TEMPLATES = [
  ['account.registered', 'email', 'Welcome to {{appName}}',
    'Hello {{name}},\n\nYour organisation "{{organisation}}" is set up on {{appName}}.\n\nNext steps:\n1. Turn on two-factor authentication\n2. Complete your company profile (GSTIN, PAN, TAN)\n3. Invite your team\n\n{{appUrl}}'],
  ['account.invited', 'email', 'You have been invited to {{organisation}}',
    // The flow sends a temporary password and a sign-in link — there is no
    // separate acceptance page. The old text promised an {{inviteUrl}} no
    // caller supplied, and unknown placeholders render as empty, so the
    // invitation went out with a blank where its link should have been.
    'Hello {{name}},\n\n{{inviterName}} has invited you to join {{organisation}} on {{appName}} as {{roleName}}.\n\nSign in at {{loginUrl}} with this email address and the temporary password below. You will be asked to choose your own password straight away.\n\nTemporary password: {{temporaryPassword}}\n\nIf you were not expecting this invitation, you can ignore this email.'],
  ['account.password_reset', 'email', 'Reset your {{appName}} password',
    'Hello {{name}},\n\nUse the link below to set a new password. It expires in {{expiresIn}}.\n\n{{resetUrl}}\n\nIf you did not request this, you can safely ignore this email — your password has not changed.'],
  ['security.login_anomaly', 'email', 'New sign-in to your {{appName}} account',
    'Hello,\n\nWe noticed a sign-in from a device or location we have not seen before.\n\nDevice: {{device}}\nIP address: {{ip}}\nTime: {{time}}\n\nIf this was you, no action is needed. If not, change your password immediately and review your active sessions.'],

  ['document.verified', 'email', '{{documentTitle}} has been verified',
    'Hello {{clientName}},\n\n{{documentTitle}} for {{period}} has been verified by {{executiveName}}.\n\nFiling status: {{filingStatus}}\n\nView it here: {{link}}'],
  ['document.verified', 'whatsapp', null,
    'Hi {{clientName}}, your {{documentTitle}} for {{period}} has been verified. Filing status: {{filingStatus}}.'],
  ['document.rejected', 'email', 'Action needed on {{documentTitle}}',
    'Hello {{clientName}},\n\n{{documentTitle}} for {{period}} could not be accepted.\n\nReason: {{reason}}\n\nPlease upload a corrected file: {{link}}'],

  ['query.raised', 'email', 'Query raised on your {{period}} filing',
    'Hello {{clientName}},\n\n{{executiveName}} has raised a query on your {{period}} filing.\n\nQuery {{reference}}: {{subject}}\n\n{{body}}\n\nReply and upload the corrected document here: {{link}}'],
  ['query.raised', 'whatsapp', null,
    'Hi {{clientName}}, we need one clarification on your {{period}} filing — query {{reference}}: {{subject}}. Reply here or open {{link}}.'],
  ['query.raised', 'sms', null,
    '{{appName}}: Query {{reference}} raised on your {{period}} filing. Please respond: {{link}}'],
  ['query.client_replied', 'email', 'Client replied to query {{reference}}',
    '{{clientName}} has replied to query {{reference}} ({{subject}}).\n\n{{body}}\n\nOpen the thread: {{link}}'],

  ['report.approved', 'email', 'Your {{period}} report is ready for review',
    'Hello {{clientName}},\n\nYour {{reportTitle}} for {{period}} has been approved by {{managerName}} and is ready for your review and sign-off.\n\nTotal tax payable: {{totalTax}}\n\nReview and sign off: {{link}}'],
  ['report.approved', 'whatsapp', null,
    'Hi {{clientName}}, your {{reportTitle}} for {{period}} is approved and ready for sign-off. Net payable {{totalTax}}. Review: {{link}}'],
  ['report.submitted', 'email', 'Report awaiting your approval',
    '{{executiveName}} has submitted {{reportTitle}} for {{clientName}} ({{period}}).\n\nTotal tax: {{totalTax}}\n\nReview and approve: {{link}}'],

  ['payment.due', 'email', 'Invoice {{invoiceNo}} is due on {{dueDate}}',
    'Hello {{clientName}},\n\nInvoice {{invoiceNo}} for {{amount}} is due on {{dueDate}}.\n\nPay securely: {{payUrl}}'],
  ['payment.due', 'sms', null,
    '{{appName}}: Invoice {{invoiceNo}} for {{amount}} is due on {{dueDate}}. Pay: {{payUrl}}'],
  ['payment.due', 'whatsapp', null,
    'Hi {{clientName}}, invoice {{invoiceNo}} for {{amount}} is due on {{dueDate}}. Pay securely: {{payUrl}}'],
  ['payment.overdue', 'email', 'Invoice {{invoiceNo}} is overdue',
    'Hello {{clientName}},\n\nInvoice {{invoiceNo}} for {{amount}} was due on {{dueDate}} and is now {{daysOverdue}} days overdue.\n\nPay now: {{payUrl}}'],
  ['payment.successful', 'email', 'Payment received — receipt {{receiptNo}}',
    'Hello {{clientName}},\n\nWe have received your payment of {{amount}} against invoice {{invoiceNo}}.\n\nReceipt: {{receiptNo}}\nPaid on: {{paidAt}}\nMethod: {{method}}\n\nDownload the receipt: {{link}}'],
  ['payment.failed', 'email', 'Payment could not be completed',
    'Hello {{clientName}},\n\nYour payment of {{amount}} against invoice {{invoiceNo}} did not go through.\n\nReason: {{reason}}\n\nTry again: {{payUrl}}'],
  ['invoice.issued', 'email', 'Invoice {{invoiceNo}} from {{organisation}}',
    'Hello {{clientName}},\n\nInvoice {{invoiceNo}} for {{amount}} has been issued and is due on {{dueDate}}.\n\nView and pay: {{link}}'],

  ['gst.due_date', 'email', 'GST filing for {{period}} is due on {{dueDate}}',
    'Hello {{clientName}},\n\nYour GST filing for {{period}} is due on {{dueDate}} — {{daysLeft}} days from now.\n\nOutstanding documents: {{pendingCount}}\n\nUpload them here: {{link}}'],
  ['gst.due_date', 'sms', null,
    '{{appName}}: GST filing for {{period}} is due on {{dueDate}}. {{pendingCount}} documents still pending.'],
  ['gst.due_date', 'whatsapp', null,
    'Hi {{clientName}}, your GST filing for {{period}} is due on {{dueDate}} ({{daysLeft}} days left). {{pendingCount}} documents pending. Upload: {{link}}'],
  ['reminder.monthly', 'email', 'Time to upload your {{period}} documents',
    'Hello {{clientName}},\n\nA new filing period ({{period}}) has opened. Please upload this month\'s bills, statements and invoices.\n\nChecklist: {{link}}'],
  ['reminder.documents_pending', 'whatsapp', null,
    'Hi {{clientName}}, {{pendingCount}} documents are still pending for {{period}}: {{pendingList}}. Upload: {{link}}'],

  ['subscription.renewal', 'email', 'Your {{planName}} plan renews on {{renewalDate}}',
    'Hello {{name}},\n\nYour {{planName}} subscription renews on {{renewalDate}} for {{amount}}.\n\nManage your subscription: {{link}}'],

  ['ticket.created', 'email', 'Support ticket {{ticketNo}} raised',
    '{{clientName}} has raised ticket {{ticketNo}}: {{subject}}\n\nPriority: {{priority}}\n\nOpen it: {{link}}'],
  ['ticket.replied', 'email', 'Update on ticket {{ticketNo}}',
    'Hello {{clientName}},\n\nThere is a new reply on your support ticket {{ticketNo}} ({{subject}}).\n\n{{body}}\n\nView the ticket: {{link}}'],

  ['insights.weekly_digest', 'email', 'Your weekly insight digest',
    'Hello {{name}},\n\nHere is what changed at {{organisation}} this week:\n\n{{digest}}\n\nOpen the dashboard: {{link}}'],
];

/** In-app notifications are generated from a compact title/body pair. */
export const IN_APP_DEFAULTS = {
  'document.uploaded':          { title: '{{clientName}} uploaded {{documentTitle}}', severity: 'info', icon: 'upload' },
  'document.verified':          { title: '{{documentTitle}} verified', severity: 'success', icon: 'check-circle' },
  'document.rejected':          { title: '{{documentTitle}} rejected', severity: 'danger', icon: 'x-circle' },
  'document.changes_requested': { title: 'Changes requested on {{documentTitle}}', severity: 'warning', icon: 'edit' },
  'query.raised':               { title: 'Query {{reference}}: {{subject}}', severity: 'warning', icon: 'help-circle' },
  'query.client_replied':       { title: '{{clientName}} replied to {{reference}}', severity: 'info', icon: 'message-circle' },
  'query.resolved':             { title: 'Query {{reference}} resolved', severity: 'success', icon: 'check-circle' },
  'report.generated':           { title: '{{reportTitle}} generated', severity: 'info', icon: 'file-text' },
  'report.submitted':           { title: '{{reportTitle}} awaiting your approval', severity: 'warning', icon: 'clipboard-check' },
  'report.approved':            { title: '{{reportTitle}} approved', severity: 'success', icon: 'check-circle' },
  'report.rejected':            { title: '{{reportTitle}} sent back', severity: 'danger', icon: 'x-circle' },
  'report.signed_off':          { title: '{{clientName}} signed off {{reportTitle}}', severity: 'success', icon: 'pen-tool' },
  'filing.archived':            { title: '{{period}} filing archived', severity: 'success', icon: 'archive' },
  'payment.due':                { title: 'Invoice {{invoiceNo}} due {{dueDate}}', severity: 'warning', icon: 'credit-card' },
  'payment.overdue':            { title: 'Invoice {{invoiceNo}} is overdue', severity: 'danger', icon: 'alert-triangle' },
  'payment.successful':         { title: 'Payment received: {{amount}}', severity: 'success', icon: 'check-circle' },
  'payment.failed':             { title: 'Payment failed for {{invoiceNo}}', severity: 'danger', icon: 'alert-triangle' },
  'invoice.issued':             { title: 'Invoice {{invoiceNo}} issued', severity: 'info', icon: 'receipt' },
  'subscription.renewal':       { title: '{{planName}} renews {{renewalDate}}', severity: 'info', icon: 'refresh' },
  'subscription.expired':       { title: 'Subscription expired', severity: 'danger', icon: 'alert-triangle' },
  'gst.due_date':               { title: 'GST for {{period}} due {{dueDate}}', severity: 'warning', icon: 'calendar' },
  'reminder.monthly':           { title: 'Upload your {{period}} documents', severity: 'info', icon: 'calendar' },
  'reminder.due_date':          { title: '{{period}} filing due {{dueDate}}', severity: 'warning', icon: 'clock' },
  'reminder.documents_pending': { title: '{{pendingCount}} documents pending for {{period}}', severity: 'warning', icon: 'inbox' },
  'ticket.created':             { title: 'Ticket {{ticketNo}}: {{subject}}', severity: 'info', icon: 'life-buoy' },
  'ticket.replied':             { title: 'Reply on ticket {{ticketNo}}', severity: 'info', icon: 'message-circle' },
  'ticket.resolved':            { title: 'Ticket {{ticketNo}} resolved', severity: 'success', icon: 'check-circle' },
  'call.missed':                { title: 'Missed call from {{from}}', severity: 'warning', icon: 'phone-missed' },
  'call.follow_up':             { title: 'Follow-up due: {{clientName}}', severity: 'info', icon: 'phone' },
  'lead.assigned':              { title: 'New lead assigned: {{leadName}}', severity: 'info', icon: 'user-plus' },
  'task.assigned':              { title: 'Task assigned: {{taskTitle}}', severity: 'info', icon: 'check-square' },
  'task.due':                   { title: 'Task due: {{taskTitle}}', severity: 'warning', icon: 'clock' },
  'security.login_anomaly':     { title: 'New sign-in from {{device}}', severity: 'warning', icon: 'shield' },
  'account.registered':         { title: 'Welcome to {{appName}}', severity: 'success', icon: 'sparkles' },
  'account.password_changed':   { title: 'Your password was changed', severity: 'info', icon: 'key' },
  'insights.weekly_digest':     { title: 'Your weekly insight digest is ready', severity: 'info', icon: 'lightbulb' },
};

/** The channels the proposal's Notification Settings screen toggles. */
export const NOTIFICATION_CHANNELS = [
  { key: 'email',    name: 'Email Alerts',      icon: 'mail',           addOn: null },
  { key: 'whatsapp', name: 'WhatsApp Alerts',   icon: 'message-circle', addOn: 'whatsapp_business_api' },
  { key: 'sms',      name: 'SMS Alerts',        icon: 'smartphone',     addOn: 'sms_automation' },
  { key: 'in_app',   name: 'In-App Alerts',     icon: 'bell',           addOn: null },
  { key: 'push',     name: 'Push Notifications',icon: 'bell-ring',      addOn: 'mobile_app' },
];
