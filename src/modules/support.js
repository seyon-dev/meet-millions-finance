/**
 * The support desk (add-on 20).
 *
 * A client raises a ticket, staff answer it, and an SLA clock runs from the
 * moment it is raised. Two details matter for trust: a client sees their own
 * tickets and nobody else's, and an internal note stays internal — visibility
 * is enforced on the query, not by filtering after the fact.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addHours, secondsBetween } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { dispatchNotification } from '../services/notifications.js';
import { loadClientIdsForUser } from '../auth/identity.js';

const router = createRouter();

const CATEGORIES = ['technical', 'billing', 'document', 'tax', 'account', 'feature_request', 'other'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'waiting_client', 'resolved', 'closed'];

/** Response-time targets by priority, in hours. */
const SLA_HOURS = { urgent: 2, high: 8, normal: 24, low: 72 };

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('support_tickets', 't');
  await applyVisibility(ctx, where);

  where.eqIf('t.status', ctx.q('status'));
  where.eqIf('t.category', ctx.q('category'));
  where.eqIf('t.priority', ctx.q('priority'));
  where.eqIf('t.assigned_to', ctx.q('assignedTo'));
  where.eqIf('t.client_id', ctx.q('clientId'));
  if (ctx.qBool('mine')) where.add('t.assigned_to = ?', ctx.userId);
  if (ctx.qBool('openOnly')) where.inIf('t.status', ['open', 'in_progress', 'waiting_client']);
  if (ctx.qBool('breachedOnly')) where.add('t.sla_breached = 1');
  where.searchIf(['t.subject', 't.ticket_no', 't.description'], ctx.q('q'));

  const { rows, total } = await scope.paginate('support_tickets', where, {
    columns: `t.*, c.display_name AS client_name, u.full_name AS assignee_name,
              r.full_name AS raised_by_name`,
    joins: `LEFT JOIN clients c ON c.id = t.client_id
            LEFT JOIN users u ON u.id = t.assigned_to
            LEFT JOIN users r ON r.id = t.raised_by`,
    alias: 't',
    orderBy: `t.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'priority', 'status'], 'created_at')}`,
    page, pageSize,
  });

  const counts = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status = 'waiting_client' THEN 1 ELSE 0 END) AS waiting,
            SUM(CASE WHEN sla_breached = 1 AND status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) AS breached,
            SUM(CASE WHEN assigned_to IS NULL AND status = 'open' THEN 1 ELSE 0 END) AS unassigned
       FROM support_tickets WHERE tenant_id = ?`, [ctx.tenantId]);

  return paginated(rows.map(toTicket), {
    page, pageSize, total,
    summary: {
      total: Number(counts?.total) || 0,
      open: Number(counts?.open) || 0,
      waitingOnClient: Number(counts?.waiting) || 0,
      slaBreached: Number(counts?.breached) || 0,
      unassigned: Number(counts?.unassigned) || 0,
    },
    categories: CATEGORIES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    slaHours: SLA_HOURS,
  }, ctx);
}, { anyPermission: ['support.view', 'support.view.own'] });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const ticket = await getVisibleTicket(ctx, scope, ctx.params.id);

  const internalAllowed = ctx.has('support.view') && !ctx.isClient;
  const messages = await scope.raw(
    `SELECT * FROM ticket_messages
      WHERE tenant_id = ? AND ticket_id = ? ${internalAllowed ? '' : "AND visibility = 'public'"}
      ORDER BY created_at ASC LIMIT 300`,
    [ctx.tenantId, ticket.id]);

  return ok({
    ticket: toTicket(ticket),
    messages: messages.map(m => ({
      id: m.id,
      authorId: m.author_id,
      authorName: m.author_name,
      authorKind: m.author_kind,
      body: m.body,
      visibility: m.visibility,
      attachments: safeJson(m.attachments_json, []),
      createdAt: m.created_at,
    })),
    // Said explicitly so a client is never misled about what staff can see.
    internalNotesHidden: !internalAllowed,
  }, { ctx });
}, { anyPermission: ['support.view', 'support.view.own'] });

router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    subject: { type: 'string', required: true, max: 200 },
    description: { type: 'text', required: true, max: 8000 },
    category: { type: 'enum', values: CATEGORIES, default: 'other' },
    priority: { type: 'enum', values: PRIORITIES, default: 'normal' },
    clientId: { type: 'id' },
  });

  // A client raising a ticket is raising it about themselves, whatever the
  // request body claims.
  let clientId = input.clientId ?? null;
  if (ctx.isClient) {
    const ids = await loadClientIdsForUser(new Db(ctx.env.DB), ctx.userId, ctx.tenantId);
    clientId = ids[0] ?? null;
  }

  const client = clientId ? await scope.first('clients', { id: clientId }) : null;
  const ticketNo = await nextTicketNumber(scope);
  const priority = ctx.isClient && input.priority === 'urgent' ? 'high' : input.priority;

  const ticket = await scope.insert('support_tickets', {
    id: ID.ticket(),
    ticket_no: ticketNo,
    client_id: clientId,
    company_id: client?.company_id ?? null,
    subject: input.subject,
    description: input.description,
    category: input.category,
    priority,
    status: 'open',
    raised_by: ctx.userId,
    channel: ctx.isClient ? 'portal' : 'internal',
    sla_due_at: addHours(SLA_HOURS[priority] ?? 24),
    sla_breached: 0,
    reopen_count: 0,
    message_count: 1,
  });

  await scope.insert('ticket_messages', {
    id: ID.ticketMessage(),
    ticket_id: ticket.id,
    author_id: ctx.userId,
    author_name: ctx.user.full_name,
    author_kind: ctx.isClient ? 'client' : 'staff',
    body: input.description,
    visibility: 'public',
  });

  await audit(ctx, {
    action: 'settings.updated', category: 'general',
    entityType: 'support_ticket', entityId: ticket.id, entityLabel: ticketNo,
    newValue: { subject: input.subject, category: input.category, priority },
  });

  await dispatchNotification(ctx, {
    triggerKey: 'ticket.created',
    clientId,
    variables: { ticketNo, subject: input.subject, priority },
    link: { path: `/support/${ticket.id}` },
  });

  return created({
    ticket: toTicket(ticket),
    slaDueAt: ticket.sla_due_at,
    priorityAdjusted: priority !== input.priority
      ? 'Urgent is reserved for staff; this ticket was raised as high priority.'
      : null,
  }, { ctx });
}, { permission: 'support.create' });

router.post('/:id/reply', async (ctx) => {
  const scope = scopeFor(ctx);
  const ticket = await getVisibleTicket(ctx, scope, ctx.params.id);
  if (ticket.status === 'closed') {
    throw new ConflictError('That ticket is closed. Reopen it to add a reply.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    body: { type: 'text', required: true, max: 8000 },
    internal: { type: 'boolean', default: false },
  });

  // Only staff may write an internal note, and a client's reply can never be
  // internal whatever the request says.
  const internal = input.internal && !ctx.isClient && ctx.has('support.view');

  await scope.insert('ticket_messages', {
    id: ID.ticketMessage(),
    ticket_id: ticket.id,
    author_id: ctx.userId,
    author_name: ctx.user.full_name,
    author_kind: ctx.isClient ? 'client' : 'staff',
    body: input.body,
    visibility: internal ? 'internal' : 'public',
  });

  const patch = { message_count: (ticket.message_count ?? 0) + 1 };

  // The first staff reply stops the response clock. Internal notes do not
  // count: the client has not heard anything.
  if (!internal && !ctx.isClient && !ticket.first_response_at) {
    patch.first_response_at = nowIso();
    patch.sla_breached = ticket.sla_due_at && ticket.sla_due_at < nowIso() ? 1 : 0;
  }
  if (!internal) {
    patch.status = ctx.isClient ? 'open' : 'waiting_client';
  }

  await scope.update('support_tickets', ticket.id, patch);

  if (!internal) {
    await dispatchNotification(ctx, {
      triggerKey: 'ticket.replied',
      clientId: ticket.client_id,
      userId: ctx.isClient ? ticket.assigned_to : null,
      variables: { ticketNo: ticket.ticket_no, subject: ticket.subject },
      link: { path: `/support/${ticket.id}` },
    });
  }

  const fresh = await scope.first('support_tickets', { id: ticket.id });
  return created({ ticket: toTicket(fresh), internal }, { ctx });
}, { permission: 'support.reply' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const ticket = await scope.getOrFail('support_tickets', ctx.params.id, { resource: 'Ticket' });

  const body = await ctx.body();
  const input = validate(body, {
    status: { type: 'enum', values: STATUSES },
    priority: { type: 'enum', values: PRIORITIES },
    category: { type: 'enum', values: CATEGORIES },
    assignedTo: { type: 'id' },
    resolution: { type: 'text', max: 2000 },
  });

  const patch = {};
  if (input.priority) {
    patch.priority = input.priority;
    // Re-basing the clock on a priority change, but only while the first
    // response is still outstanding.
    if (!ticket.first_response_at) patch.sla_due_at = addHours(SLA_HOURS[input.priority] ?? 24);
  }
  if (input.category) patch.category = input.category;
  if (input.assignedTo) patch.assigned_to = input.assignedTo;

  if (input.status) {
    patch.status = input.status;
    if (input.status === 'resolved') {
      if (!input.resolution) {
        throw new BadRequestError('Say how the ticket was resolved before marking it resolved.');
      }
      patch.resolved_at = nowIso();
      patch.resolution = input.resolution;
    }
    if (input.status === 'closed') patch.closed_at = nowIso();
    if (input.status === 'open' && ['resolved', 'closed'].includes(ticket.status)) {
      patch.reopen_count = (ticket.reopen_count ?? 0) + 1;
      patch.resolved_at = null;
      patch.closed_at = null;
    }
  }
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await scope.update('support_tickets', ticket.id, patch);
  await audit(ctx, {
    action: 'settings.updated', category: 'general',
    entityType: 'support_ticket', entityId: ticket.id, entityLabel: ticket.ticket_no,
    oldValue: { status: ticket.status, priority: ticket.priority },
    newValue: patch,
  });

  return ok({ ticket: toTicket(await scope.first('support_tickets', { id: ticket.id })) }, { ctx });
}, { permission: 'support.manage' });

/** The client's own rating of how their ticket was handled. */
router.post('/:id/rate', async (ctx) => {
  const scope = scopeFor(ctx);
  const ticket = await getVisibleTicket(ctx, scope, ctx.params.id);
  if (!['resolved', 'closed'].includes(ticket.status)) {
    throw new ConflictError('You can rate a ticket once it has been resolved.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    rating: { type: 'int', required: true, min: 1, max: 5 },
    comment: { type: 'text', max: 1000 },
  });

  await scope.update('support_tickets', ticket.id, { satisfaction_rating: input.rating });
  if (input.comment) {
    await scope.insert('ticket_messages', {
      id: ID.ticketMessage(),
      ticket_id: ticket.id,
      author_id: ctx.userId,
      author_name: ctx.user.full_name,
      author_kind: ctx.isClient ? 'client' : 'staff',
      body: input.comment,
      visibility: 'public',
    });
  }

  return ok({ rating: input.rating }, { ctx });
}, { auth: true });

/** Desk performance — response times and satisfaction, from real tickets. */
router.get('/stats/overview', async (ctx) => {
  const scope = scopeFor(ctx);

  const totals = await scope.rawOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) AS resolved,
            SUM(CASE WHEN sla_breached = 1 THEN 1 ELSE 0 END) AS breached,
            AVG(satisfaction_rating) AS avg_rating,
            COUNT(satisfaction_rating) AS rated
       FROM support_tickets WHERE tenant_id = ?`, [ctx.tenantId]);

  const responded = await scope.raw(
    `SELECT created_at, first_response_at, resolved_at FROM support_tickets
      WHERE tenant_id = ? AND first_response_at IS NOT NULL LIMIT 1000`, [ctx.tenantId]);

  const responseMinutes = responded
    .map(t => Math.round(secondsBetween(t.created_at, t.first_response_at) / 60))
    .filter(n => Number.isFinite(n) && n >= 0);
  const resolveMinutes = responded
    .filter(t => t.resolved_at)
    .map(t => Math.round(secondsBetween(t.created_at, t.resolved_at) / 60))
    .filter(n => Number.isFinite(n) && n >= 0);

  const byCategory = await scope.raw(
    'SELECT category, COUNT(*) AS n FROM support_tickets WHERE tenant_id = ? GROUP BY category ORDER BY n DESC',
    [ctx.tenantId]);

  const byAgent = await scope.raw(
    `SELECT u.id, u.full_name, COUNT(t.id) AS handled,
            AVG(t.satisfaction_rating) AS avg_rating,
            SUM(CASE WHEN t.sla_breached = 1 THEN 1 ELSE 0 END) AS breached
       FROM support_tickets t JOIN users u ON u.id = t.assigned_to
      WHERE t.tenant_id = ? GROUP BY u.id ORDER BY handled DESC LIMIT 15`, [ctx.tenantId]);

  return ok({
    totals: {
      total: Number(totals?.total) || 0,
      resolved: Number(totals?.resolved) || 0,
      slaBreached: Number(totals?.breached) || 0,
      // Null rather than a made-up number when nobody has rated anything.
      averageRating: totals?.rated ? Math.round(Number(totals.avg_rating) * 10) / 10 : null,
      ratedTickets: Number(totals?.rated) || 0,
    },
    responseTime: summarise(responseMinutes),
    resolutionTime: summarise(resolveMinutes),
    byCategory: byCategory.map(c => ({ category: c.category, count: Number(c.n) })),
    byAgent: byAgent.map(a => ({
      userId: a.id,
      name: a.full_name,
      handled: Number(a.handled),
      averageRating: a.avg_rating ? Math.round(Number(a.avg_rating) * 10) / 10 : null,
      slaBreached: Number(a.breached) || 0,
    })),
  }, { ctx });
}, { permission: 'support.view' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function applyVisibility(ctx, where) {
  if (ctx.has('support.view') && !ctx.isClient) return;

  if (ctx.isClient || ctx.has('support.view.own')) {
    const ids = await loadClientIdsForUser(new Db(ctx.env.DB), ctx.userId, ctx.tenantId);
    if (ctx.isClient) {
      if (!ids.length) { where.add('1 = 0'); return; }
      where.inIf('t.client_id', ids);
      return;
    }
    where.add('(t.raised_by = ? OR t.assigned_to = ?)', ctx.userId, ctx.userId);
    return;
  }
  throw new ForbiddenError('You do not have permission to view support tickets.');
}

async function getVisibleTicket(ctx, scope, id) {
  const ticket = await scope.first('support_tickets', { id });
  if (!ticket) throw new NotFoundError('Ticket');

  if (ctx.has('support.view') && !ctx.isClient) return ticket;

  if (ctx.isClient) {
    const ids = await loadClientIdsForUser(new Db(ctx.env.DB), ctx.userId, ctx.tenantId);
    // 404 rather than 403: a client should not be able to confirm that
    // another organisation's ticket number exists.
    if (!ids.includes(ticket.client_id)) throw new NotFoundError('Ticket');
    return ticket;
  }
  if (ticket.raised_by === ctx.userId || ticket.assigned_to === ctx.userId) return ticket;
  throw new NotFoundError('Ticket');
}

async function nextTicketNumber(scope) {
  const row = await scope.rawOne(
    'SELECT ticket_no FROM support_tickets WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [scope.tenantId]);
  const last = Number(String(row?.ticket_no ?? '').split('-').pop()) || 0;
  return `TKT-${String(last + 1).padStart(5, '0')}`;
}

function summarise(values) {
  if (!values.length) return { count: 0, medianMinutes: null, averageMinutes: null, label: null };
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const average = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return {
    count: sorted.length,
    medianMinutes: median,
    averageMinutes: average,
    label: humaniseMinutes(median),
  };
}

function humaniseMinutes(minutes) {
  if (minutes === null || minutes === undefined) return null;
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / (60 * 24))} d`;
}

function toTicket(t) {
  return {
    id: t.id,
    ticketNo: t.ticket_no,
    subject: t.subject,
    description: t.description,
    category: t.category,
    priority: t.priority,
    status: t.status,
    clientId: t.client_id,
    clientName: t.client_name ?? null,
    raisedBy: t.raised_by,
    raisedByName: t.raised_by_name ?? null,
    assignedTo: t.assigned_to,
    assigneeName: t.assignee_name ?? null,
    channel: t.channel,
    slaDueAt: t.sla_due_at,
    slaBreached: !!t.sla_breached,
    firstResponseAt: t.first_response_at,
    resolvedAt: t.resolved_at,
    closedAt: t.closed_at,
    resolution: t.resolution,
    satisfactionRating: t.satisfaction_rating,
    reopenCount: t.reopen_count,
    messageCount: t.message_count,
    createdAt: t.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as supportRouter };
