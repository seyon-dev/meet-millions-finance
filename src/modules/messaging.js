/**
 * The WhatsApp inbox, templates and broadcasts (add-on 8, WhatsApp Business
 * API; add-on 27, Chatbot).
 *
 * Meta's rule shapes this module: outside a 24-hour window from the contact's
 * last inbound message, only an approved template may be sent. The inbox
 * reports which of the two is available on each thread rather than letting
 * someone type a reply that the provider will reject.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError, IntegrationError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate, toE164 } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addHours } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { WhatsAppProvider } from '../integrations/messaging.js';

const router = createRouter();

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
router.get('/threads', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('chat_threads', 't');
  where.eqIf('t.channel', ctx.q('channel'));
  where.eqIf('t.status', ctx.q('status'));
  where.eqIf('t.client_id', ctx.q('clientId'));
  if (ctx.qBool('mine')) where.add('t.assigned_to = ?', ctx.userId);
  if (ctx.qBool('unreadOnly')) where.add('t.unread_count > 0');
  where.searchIf(['t.display_name', 't.phone', 't.last_message_preview'], ctx.q('q'));

  const { rows, total } = await scope.paginate('chat_threads', where, {
    columns: `t.*, c.display_name AS client_name, c.client_code, u.full_name AS assignee_name`,
    joins: `LEFT JOIN clients c ON c.id = t.client_id
            LEFT JOIN users u ON u.id = t.assigned_to`,
    alias: 't',
    orderBy: `t.${safeOrder(ctx.q('sort', 'last_message_at'), ctx.q('dir', 'desc'), ['last_message_at', 'created_at', 'unread_count'], 'last_message_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) AS unread,
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN assigned_to IS NULL AND status = 'open' THEN 1 ELSE 0 END) AS unassigned
       FROM chat_threads WHERE tenant_id = ?`, [ctx.tenantId]);

  return paginated(rows.map(toThread), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      unread: Number(counts?.unread) || 0,
      open: Number(counts?.open) || 0,
      unassigned: Number(counts?.unassigned) || 0,
    },
  }, ctx);
}, { permission: 'messaging.view' });

router.get('/threads/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const thread = await scope.getOrFail('chat_threads', ctx.params.id, { resource: 'Conversation' });

  const messages = await scope.raw(
    `SELECT m.*, u.full_name AS sender_name FROM chat_messages m
       LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.tenant_id = ? AND m.thread_id = ?
      ORDER BY m.created_at ASC LIMIT 300`, [ctx.tenantId, thread.id]);

  // Reading the thread clears its unread count.
  if (thread.unread_count) await scope.update('chat_threads', thread.id, { unread_count: 0 });

  const client = thread.client_id ? await scope.first('clients', { id: thread.client_id }) : null;
  const templates = await scope.all('whatsapp_templates', { approval_status: 'approved' },
    { order: 'name ASC', limit: 100 });

  const assignee = thread.assigned_to
    ? await scope.first('users', { id: thread.assigned_to }, 'id, full_name')
    : null;

  return ok({
    // The list query joins these names; this read fetches the rows, so the
    // same fields are filled in rather than left null on a detail.
    thread: {
      ...toThread(thread),
      clientName: client?.display_name ?? null,
      clientCode: client?.client_code ?? null,
      assigneeName: assignee?.full_name ?? null,
    },
    messages: messages.map(toMessage),
    client: client ? {
      id: client.id, displayName: client.display_name, clientCode: client.client_code,
    } : null,
    window: describeWindow(thread),
    // Only approved templates, because an unapproved one is rejected by Meta
    // and the message simply never arrives.
    templates: templates.map(t => ({
      id: t.id, name: t.name, language: t.language, category: t.category,
      body: t.body_text, variables: safeJson(t.variables_json, []),
    })),
  }, { ctx });
}, { permission: 'messaging.view' });

router.post('/threads/:id/reply', async (ctx) => {
  await assertFeature(ctx, 'whatsapp_integration');
  const scope = scopeFor(ctx);
  const thread = await scope.getOrFail('chat_threads', ctx.params.id, { resource: 'Conversation' });

  const body = await ctx.body();
  const input = validate(body, {
    body: { type: 'text', max: 4000 },
    templateId: { type: 'id' },
    variables: { type: 'json' },
  });

  const window = describeWindow(thread);
  if (!input.templateId && !window.open) {
    throw new ConflictError(
      `This conversation is outside WhatsApp's ${window.hours}-hour reply window, which closed ${window.closedAt}. Send an approved template instead.`);
  }
  if (!input.templateId && !input.body) {
    throw new BadRequestError('Write a message, or choose a template.');
  }

  const provider = new WhatsAppProvider(ctx.env);
  if (!provider.isConfigured()) {
    throw new IntegrationError(provider.name,
      `WhatsApp is not connected. Missing: ${provider.missingKeys().join(', ')}.`,
      { configured: false, details: { missingKeys: provider.missingKeys() } });
  }

  let template = null;
  if (input.templateId) {
    template = await scope.getOrFail('whatsapp_templates', input.templateId, { resource: 'Template' });
    if (template.approval_status !== 'approved') {
      throw new ConflictError(
        `The template "${template.name}" is ${template.approval_status}. Meta only delivers approved templates.`);
    }
  }

  // The message is recorded before it is sent, so a provider failure leaves a
  // visible failed message rather than nothing at all.
  const messageId = ID.message();
  await scope.insert('chat_messages', {
    id: messageId,
    thread_id: thread.id,
    direction: 'outbound',
    type: template ? 'template' : 'text',
    body: input.body ?? template?.body_text ?? '',
    template_id: template?.id ?? null,
    sent_by: ctx.userId,
    is_bot: 0,
    status: 'queued',
  });

  // Meta numbers template placeholders {{1}}, {{2}}, ... so the variables are
  // sent positionally, in the order the template declares them.
  const declared = safeJson(template?.variables_json, []);
  const bodyParams = declared.map(key => String(input.variables?.[key] ?? ''));

  const result = template
    ? await provider.sendTemplate({
        to: thread.phone,
        templateName: template.provider_template_id ?? template.name,
        language: template.language ?? 'en',
        bodyParams,
      })
    : await provider.sendText({ to: thread.phone, text: input.body });

  if (!result.ok) {
    await scope.update('chat_messages', messageId, {
      status: 'failed',
      error_message: (result.error?.message ?? 'The provider rejected the message.').slice(0, 500),
    });
    throw new IntegrationError(provider.name,
      result.error?.message ?? 'The message could not be sent.', { configured: true });
  }

  await scope.update('chat_messages', messageId, {
    status: 'sent',
    provider_message_id: result.data?.messageId ?? null,
  });
  await scope.update('chat_threads', thread.id, {
    last_message_at: nowIso(),
    last_message_preview: (input.body ?? template?.body_text ?? '').slice(0, 160),
    status: 'open',
  });

  const sent = await scope.first('chat_messages', { id: messageId });
  return created({ message: toMessage(sent) }, { ctx });
}, { permission: 'messaging.send' });

router.post('/threads/:id/assign', async (ctx) => {
  const scope = scopeFor(ctx);
  const thread = await scope.getOrFail('chat_threads', ctx.params.id, { resource: 'Conversation' });
  const body = await ctx.body();
  const input = validate(body, {
    assignedTo: { type: 'id' },
    status: { type: 'enum', values: ['open', 'pending', 'resolved', 'closed'] },
  });

  const patch = {};
  if (input.assignedTo) patch.assigned_to = input.assignedTo;
  if (input.status) patch.status = input.status;
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await scope.update('chat_threads', thread.id, patch);
  return ok({ thread: toThread(await scope.first('chat_threads', { id: thread.id })) }, { ctx });
}, { permission: 'messaging.view' });

/** Start a conversation with a client who has not written first. */
router.post('/threads', async (ctx) => {
  await assertFeature(ctx, 'whatsapp_integration');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    phone: { type: 'phone', required: true },
    clientId: { type: 'id' },
    displayName: { type: 'string', max: 120 },
  });

  const phone = String(toE164(input.phone) ?? input.phone).replace(/\D/g, '');
  const existing = await scope.first('chat_threads', { channel: 'whatsapp', phone });
  if (existing) return ok({ thread: toThread(existing), existing: true }, { ctx });

  const client = input.clientId ? await scope.first('clients', { id: input.clientId }) : null;
  const thread = await scope.insert('chat_threads', {
    id: ID.thread(),
    channel: 'whatsapp',
    client_id: client?.id ?? null,
    phone,
    display_name: input.displayName ?? client?.display_name ?? phone,
    status: 'open',
    unread_count: 0,
    // No inbound message yet, so the free-form window is closed and only a
    // template may be sent. Recording that is what makes the UI honest.
    window_expires_at: null,
  });

  return created({ thread: toThread(thread), existing: false }, { ctx });
}, { permission: 'messaging.send' });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
router.get('/templates', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('whatsapp_templates', {}, { order: 'name ASC', limit: 200 });

  return ok({
    templates: rows.map(t => ({
      id: t.id,
      name: t.name,
      language: t.language,
      category: t.category,
      header: t.header_text,
      body: t.body_text,
      footer: t.footer_text,
      buttons: safeJson(t.buttons_json, []),
      variables: safeJson(t.variables_json, []),
      // Meta approves templates, not this application. The status is recorded
      // as reported, and a pending template cannot be sent.
      approvalStatus: t.approval_status,
      providerTemplateId: t.provider_template_id,
      rejectionReason: t.rejection_reason,
      updatedAt: t.updated_at,
    })),
    categories: ['utility', 'marketing', 'authentication'],
  }, { ctx });
}, { permission: 'messaging.view' });

router.post('/templates', async (ctx) => {
  await assertFeature(ctx, 'whatsapp_integration');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 80 },
    language: { type: 'string', max: 10, default: 'en' },
    category: { type: 'enum', values: ['utility', 'marketing', 'authentication'], default: 'utility' },
    header: { type: 'string', max: 200 },
    body: { type: 'text', required: true, max: 2000 },
    footer: { type: 'string', max: 120 },
    buttons: { type: 'array', max: 3 },
  });

  // Meta requires a snake_case name; rejecting here saves a round trip and a
  // rejection that arrives days later.
  if (!/^[a-z0-9_]+$/.test(input.name)) {
    throw new BadRequestError('A template name may contain only lowercase letters, numbers and underscores.');
  }
  const clash = await scope.first('whatsapp_templates', { name: input.name, language: input.language });
  if (clash) throw new ConflictError(`A ${input.language} template named "${input.name}" already exists.`);

  const variables = [...new Set(
    [...String(input.body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(m => m[1]))];

  const template = await scope.insert('whatsapp_templates', {
    id: ID.template(),
    name: input.name,
    language: input.language,
    category: input.category,
    header_text: input.header ?? null,
    body_text: input.body,
    footer_text: input.footer ?? null,
    buttons_json: input.buttons ? JSON.stringify(input.buttons) : null,
    variables_json: JSON.stringify(variables),
    // Draft until Meta says otherwise. Nothing here marks a template approved
    // on its own say-so.
    approval_status: 'draft',
  });

  await audit(ctx, {
    action: 'settings.updated', category: 'communication',
    entityType: 'whatsapp_template', entityId: template.id, entityLabel: input.name,
    newValue: { category: input.category, language: input.language },
  });

  return created({
    template,
    note: 'The template is a draft until Meta approves it. Submit it in the WhatsApp Manager, then record the approval here.',
  }, { ctx });
}, { permission: 'messaging.templates' });

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------
router.get('/broadcasts', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('broadcasts', {}, { limit: 100 });
  return ok({
    broadcasts: rows.map(b => ({
      id: b.id,
      name: b.name,
      channel: b.channel,
      status: b.status,
      recipientCount: b.recipient_count,
      sentCount: b.sent_count,
      deliveredCount: b.delivered_count,
      failedCount: b.failed_count,
      scheduledAt: b.scheduled_at,
      startedAt: b.started_at,
      completedAt: b.completed_at,
    })),
  }, { ctx });
}, { permission: 'messaging.view' });

router.post('/broadcasts', async (ctx) => {
  await assertFeature(ctx, 'whatsapp_integration');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    channel: { type: 'enum', values: ['whatsapp', 'sms', 'email'], default: 'whatsapp' },
    templateId: { type: 'id' },
    body: { type: 'text', max: 2000 },
    audience: { type: 'json', required: true },
    scheduledAt: { type: 'date' },
  });

  if (input.channel === 'whatsapp' && !input.templateId) {
    throw new BadRequestError(
      'A WhatsApp broadcast must use an approved template — free-form messages are only allowed inside a reply window.');
  }

  const recipients = await resolveAudience(scope, ctx, input.audience);
  if (!recipients.length) {
    throw new BadRequestError('That audience matches nobody, so there is nothing to send.');
  }

  const broadcast = await scope.insert('broadcasts', {
    id: ID.broadcast(),
    channel: input.channel,
    name: input.name,
    template_id: input.templateId ?? null,
    body: input.body ?? null,
    audience_json: JSON.stringify(input.audience),
    recipient_count: recipients.length,
    sent_count: 0,
    delivered_count: 0,
    failed_count: 0,
    // Queued, not sent: the scheduler delivers it. Reporting it sent here
    // would be a count of messages nobody has tried to deliver yet.
    status: input.scheduledAt ? 'scheduled' : 'queued',
    scheduled_at: input.scheduledAt ?? null,
    created_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'settings.updated', category: 'communication', severity: 'notice',
    entityType: 'broadcast', entityId: broadcast.id, entityLabel: input.name,
    newValue: { channel: input.channel, recipients: recipients.length },
  });

  return created({
    broadcast,
    recipientCount: recipients.length,
    preview: recipients.slice(0, 5).map(r => ({ name: r.display_name, to: r.to })),
  }, { ctx });
}, { permission: 'messaging.broadcast' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a free-form reply is allowed on this thread.
 *
 * Meta closes the window 24 hours after the contact's last inbound message.
 * Past that, only an approved template is delivered — so the UI needs to know
 * which composer to show, rather than finding out from a rejection.
 */
function describeWindow(thread) {
  const expires = thread.window_expires_at;
  const open = !!expires && expires > nowIso();
  return {
    open,
    hours: 24,
    expiresAt: expires,
    closedAt: expires && !open ? expires : null,
    reason: open
      ? null
      : (expires
          ? 'The contact last wrote more than 24 hours ago.'
          : 'This contact has not written to you, so no reply window has opened.'),
    allows: open ? ['text', 'template'] : ['template'],
  };
}

async function resolveAudience(scope, ctx, audience) {
  const kind = audience?.kind ?? 'clients';

  if (kind === 'clients') {
    const where = scope.where('clients', 'c');
    where.add('c.deleted_at IS NULL');
    where.eqIf('c.status', audience.status);
    where.eqIf('c.assigned_executive_id', audience.assignedTo);
    const rows = await scope.raw(
      `SELECT c.id, c.display_name, c.primary_contact_phone AS to_number, c.primary_contact_email AS to_email
         FROM clients c WHERE c.tenant_id = ?
         ${where.clauses.length ? 'AND ' + where.clauses.join(' AND ') : ''}
         LIMIT 5000`, [ctx.tenantId, ...where.params]);
    return rows
      .map(r => ({ ...r, to: audience.channel === 'email' ? r.to_email : r.to_number }))
      .filter(r => r.to);
  }

  if (kind === 'explicit') {
    return (audience.recipients ?? [])
      .filter(Boolean)
      .map(to => ({ display_name: to, to: String(to) }));
  }

  return [];
}

function toThread(t) {
  return {
    id: t.id,
    channel: t.channel,
    clientId: t.client_id,
    clientName: t.client_name ?? null,
    clientCode: t.client_code ?? null,
    phone: t.phone,
    displayName: t.display_name,
    assignedTo: t.assigned_to,
    assigneeName: t.assignee_name ?? null,
    status: t.status,
    unreadCount: t.unread_count,
    lastMessageAt: t.last_message_at,
    lastMessagePreview: t.last_message_preview,
    windowExpiresAt: t.window_expires_at,
    windowOpen: !!t.window_expires_at && t.window_expires_at > nowIso(),
    createdAt: t.created_at,
  };
}

function toMessage(m) {
  return {
    id: m.id,
    direction: m.direction,
    type: m.type,
    body: m.body,
    mediaKey: m.media_key,
    mediaName: m.media_name,
    templateId: m.template_id,
    sentBy: m.sent_by,
    senderName: m.sender_name ?? null,
    isBot: !!m.is_bot,
    status: m.status,
    error: m.error_message,
    linkedDocumentId: m.linked_document_id,
    createdAt: m.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as messagingRouter };
