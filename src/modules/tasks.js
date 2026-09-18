/**
 * Tasks — the internal work board, including the follow-ups the calling module
 * creates automatically after a call.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { NotFoundError } from '../http/errors.js';
import { safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { auditAsync } from '../services/audit.js';
import { dispatchNotification } from '../services/notifications.js';

const router = createRouter();
const COLUMNS = ['todo', 'in_progress', 'blocked', 'review', 'done'];

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination({ defaultSize: 50 });

  const where = scope.where('tasks', 't');
  if (ctx.qBool('mine', false)) where.add('t.assigned_to = ?', ctx.userId);
  where.eqIf('t.assigned_to', ctx.q('assignedTo'));
  where.eqIf('t.client_id', ctx.q('clientId'));
  where.eqIf('t.type', ctx.q('type'));
  where.eqIf('t.priority', ctx.q('priority'));
  const statuses = ctx.qList('status');
  if (statuses.length) where.inIf('t.status', statuses);
  else where.eqIf('t.status', ctx.q('status'));
  if (ctx.qBool('openOnly', false)) where.inIf('t.status', ['todo', 'in_progress', 'blocked', 'review']);
  if (ctx.qBool('overdue', false)) where.add("t.due_at < ? AND t.status NOT IN ('done','cancelled')", nowIso());
  where.searchIf(['t.title', 't.description'], ctx.q('q'));

  const { rows, total } = await scope.paginate('tasks', where, {
    columns: `t.*, u.full_name AS assignee_name, c.display_name AS client_name`,
    joins: `LEFT JOIN users u ON u.id = t.assigned_to
            LEFT JOIN clients c ON c.id = t.client_id`,
    alias: 't',
    orderBy: `t.${safeOrder(ctx.q('sort', 'due_at'), ctx.q('dir', 'asc'), ['due_at', 'created_at', 'priority', 'status'], 'due_at')}`,
    page, pageSize,
  });

  const counts = await scope.raw(
    `SELECT status, COUNT(*) AS n FROM tasks WHERE tenant_id = ?
       ${ctx.qBool('mine', false) ? 'AND assigned_to = ?' : ''} GROUP BY status`,
    ctx.qBool('mine', false) ? [ctx.tenantId, ctx.userId] : [ctx.tenantId]);
  const byStatus = Object.fromEntries(counts.map(c => [c.status, Number(c.n)]));

  return paginated(rows.map(toTask), {
    page, pageSize, total,
    board: COLUMNS.map(key => ({ key, label: label(key), count: byStatus[key] ?? 0 })),
  }, ctx);
}, { permission: 'tasks.view' });

router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    title: { type: 'string', required: true, min: 2, max: 200 },
    description: { type: 'text', max: 4000 },
    type: { type: 'enum', values: ['general', 'verification', 'follow_up', 'call_follow_up', 'collection', 'filing', 'reconciliation', 'onboarding', 'support'], default: 'general' },
    priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    assignedTo: { type: 'id' },
    clientId: { type: 'id' },
    filingPeriodId: { type: 'id' },
    dueAt: { type: 'date' },
    reminderAt: { type: 'date' },
    sourceType: { type: 'string', max: 30 },
    sourceId: { type: 'id' },
  });

  let companyId = null;
  if (input.clientId) {
    const client = await scope.first('clients', { id: input.clientId }, 'id, company_id');
    if (!client) throw new NotFoundError('Client');
    companyId = client.company_id;
  }

  const task = await scope.insert('tasks', {
    id: ID.task(),
    company_id: companyId,
    client_id: input.clientId,
    filing_period_id: input.filingPeriodId,
    title: input.title,
    description: input.description,
    type: input.type,
    status: 'todo',
    priority: input.priority,
    assigned_to: input.assignedTo ?? ctx.userId,
    created_by: ctx.userId,
    due_at: input.dueAt,
    reminder_at: input.reminderAt,
    source_type: input.sourceType,
    source_id: input.sourceId,
  });

  auditAsync(ctx, {
    action: 'settings.changed', category: 'general',
    entityType: 'task', entityId: task.id, entityLabel: input.title,
    newValue: { type: input.type, assignedTo: task.assigned_to, priority: input.priority },
  });

  if (task.assigned_to && task.assigned_to !== ctx.userId) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'task.assigned',
      userId: task.assigned_to,
      clientId: input.clientId,
      entityType: 'task', entityId: task.id,
      variables: { taskTitle: input.title, dueDate: input.dueAt?.slice(0, 10) ?? '' },
      link: { path: `/tasks/${task.id}` },
    }));
  }

  return created(toTask(task), { ctx });
}, { permission: 'tasks.manage' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const task = await scope.getOrFail('tasks', ctx.params.id, { resource: 'Task' });

  const body = await ctx.body();
  const input = validate(body, {
    title: { type: 'string', min: 2, max: 200 },
    description: { type: 'text', max: 4000 },
    status: { type: 'enum', values: ['todo', 'in_progress', 'blocked', 'review', 'done', 'cancelled'] },
    priority: { type: 'enum', values: ['low', 'normal', 'high', 'urgent'] },
    assignedTo: { type: 'id' },
    dueAt: { type: 'date' },
    reminderAt: { type: 'date' },
  });

  const patch = {};
  if (input.title !== null) patch.title = input.title;
  if (input.description !== null) patch.description = input.description;
  if (input.priority !== null) patch.priority = input.priority;
  if (input.assignedTo !== null) patch.assigned_to = input.assignedTo;
  if (input.dueAt !== null) patch.due_at = input.dueAt;
  if (input.reminderAt !== null) patch.reminder_at = input.reminderAt;
  if (input.status !== null) {
    patch.status = input.status;
    patch.completed_at = input.status === 'done' ? nowIso() : null;
  }

  await scope.update('tasks', task.id, patch);

  if (input.assignedTo && input.assignedTo !== task.assigned_to) {
    ctx.defer(dispatchNotification(ctx, {
      triggerKey: 'task.assigned',
      userId: input.assignedTo,
      clientId: task.client_id,
      entityType: 'task', entityId: task.id,
      variables: { taskTitle: patch.title ?? task.title },
      link: { path: `/tasks/${task.id}` },
    }));
  }

  const updated = await scope.first('tasks', { id: task.id });
  return ok(toTask(updated), { ctx });
}, { permission: 'tasks.manage' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const task = await scope.getOrFail('tasks', ctx.params.id, { resource: 'Task' });
  await scope.update('tasks', task.id, { status: 'cancelled' });
  return ok({ cancelled: true, id: task.id }, { ctx });
}, { permission: 'tasks.manage' });

function toTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    priority: row.priority,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name ?? null,
    clientId: row.client_id,
    clientName: row.client_name ?? null,
    filingPeriodId: row.filing_period_id,
    dueAt: row.due_at,
    reminderAt: row.reminder_at,
    completedAt: row.completed_at,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    overdue: !!row.due_at && row.due_at < nowIso() && !['done', 'cancelled'].includes(row.status),
  };
}

function label(key) {
  return { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', review: 'Review', done: 'Done' }[key] ?? key;
}

export { router as tasksRouter, toTask };
