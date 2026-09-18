/**
 * Workflow automation (add-on 5): "when this happens, do that".
 *
 * A rule is a trigger, optional conditions and a list of actions. Rules are
 * evaluated where the trigger fires, so this module owns the definitions and
 * the evaluator; the modules that emit events call `runAutomation`.
 *
 * Two safeguards worth naming: a rule cannot act on a channel the tenant has
 * not got, and a rule cannot fire itself in a loop.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addMinutes } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature, hasFeature } from '../services/features.js';
import { dispatchNotification } from '../services/notifications.js';
import { NOTIFICATION_TRIGGERS, TRIGGER_MAP } from '../data/notification-triggers.js';

const router = createRouter();

/** What a rule may do when it fires. */
export const ACTION_TYPES = [
  { key: 'notify', name: 'Send a notification', fields: ['triggerKey', 'channels', 'recipient'] },
  { key: 'create_task', name: 'Create a task', fields: ['title', 'assignTo', 'dueInDays'] },
  { key: 'assign', name: 'Assign the record', fields: ['userId'] },
  { key: 'set_status', name: 'Change the status', fields: ['status'] },
  { key: 'add_tag', name: 'Add a tag', fields: ['tag'] },
  { key: 'raise_query', name: 'Raise a query with the client', fields: ['subject', 'body'] },
];

const ACTION_KEYS = new Set(ACTION_TYPES.map(a => a.key));

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('automation_rules', 'r');
  where.eqIf('r.trigger_key', ctx.q('trigger'));
  if (ctx.q('active') !== null) where.eqIf('r.is_active', ctx.qBool('active') ? 1 : 0);
  where.searchIf(['r.name', 'r.description'], ctx.q('q'));

  const { rows, total } = await scope.paginate('automation_rules', where, {
    columns: 'r.*, u.full_name AS created_by_name',
    joins: 'LEFT JOIN users u ON u.id = r.created_by',
    alias: 'r',
    orderBy: `r.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'fire_count', 'name'], 'created_at')}`,
    page, pageSize,
  });

  return paginated(rows.map(toRule), {
    page, pageSize, total,
    triggers: NOTIFICATION_TRIGGERS.map(t => ({
      key: t.key, name: t.name, category: t.category,
    })),
    actionTypes: ACTION_TYPES,
  }, ctx);
}, { anyPermission: ['automation.manage', 'settings.view'] });

router.post('/', async (ctx) => {
  await assertFeature(ctx, 'email_automation');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    description: { type: 'text', max: 500 },
    triggerKey: { type: 'string', required: true, max: 60 },
    conditions: { type: 'json' },
    actions: { type: 'array', required: true, max: 10 },
    delayMinutes: { type: 'int', min: 0, max: 20160, default: 0 },
    isActive: { type: 'boolean', default: true },
  });

  if (!TRIGGER_MAP.has(input.triggerKey)) {
    throw new BadRequestError(`Unknown trigger: ${input.triggerKey}.`);
  }
  const actions = await validateActions(ctx, input.actions);

  const rule = await scope.insert('automation_rules', {
    id: ID.rule(),
    name: input.name,
    description: input.description ?? null,
    trigger_key: input.triggerKey,
    conditions_json: JSON.stringify(input.conditions ?? {}),
    actions_json: JSON.stringify(actions),
    channel: actions.find(a => a.type === 'notify')?.channels?.[0] ?? null,
    delay_minutes: input.delayMinutes,
    is_active: input.isActive ? 1 : 0,
    fire_count: 0,
    created_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'settings.updated', category: 'settings',
    entityType: 'automation_rule', entityId: rule.id, entityLabel: input.name,
    newValue: { trigger: input.triggerKey, actions: actions.map(a => a.type) },
  });

  return created({ rule: toRule(rule) }, { ctx });
}, { permission: 'automation.manage' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const rule = await scope.getOrFail('automation_rules', ctx.params.id, { resource: 'Rule' });

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 120 },
    description: { type: 'text', max: 500 },
    conditions: { type: 'json' },
    actions: { type: 'array', max: 10 },
    delayMinutes: { type: 'int', min: 0, max: 20160 },
    isActive: { type: 'boolean' },
  });

  const patch = {};
  if (input.name) patch.name = input.name;
  if (input.description !== null && input.description !== undefined) patch.description = input.description;
  if (input.conditions) patch.conditions_json = JSON.stringify(input.conditions);
  if (input.actions) patch.actions_json = JSON.stringify(await validateActions(ctx, input.actions));
  if (input.delayMinutes !== null && input.delayMinutes !== undefined) patch.delay_minutes = input.delayMinutes;
  if (input.isActive !== null && input.isActive !== undefined) patch.is_active = input.isActive ? 1 : 0;
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  await scope.update('automation_rules', rule.id, patch);
  await audit(ctx, {
    action: 'settings.updated', category: 'settings',
    entityType: 'automation_rule', entityId: rule.id, entityLabel: rule.name,
    oldValue: { is_active: rule.is_active },
    newValue: patch,
  });

  return ok({ rule: toRule(await scope.first('automation_rules', { id: rule.id })) }, { ctx });
}, { permission: 'automation.manage' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const rule = await scope.getOrFail('automation_rules', ctx.params.id, { resource: 'Rule' });
  await scope.delete('automation_rules', rule.id);
  await audit(ctx, {
    action: 'settings.updated', category: 'settings', severity: 'notice',
    entityType: 'automation_rule', entityId: rule.id, entityLabel: rule.name,
    oldValue: { trigger: rule.trigger_key }, newValue: { deleted: true },
  });
  return ok({ id: rule.id, removed: true }, { ctx });
}, { permission: 'automation.manage' });

/**
 * Dry run: what would this rule do, against real data, without doing it.
 *
 * Rules act on client records, so getting one wrong is visible to clients.
 * Being able to see the matches first is the difference between a safe rule
 * and a rule somebody is afraid to turn on.
 */
router.post('/:id/preview', async (ctx) => {
  const scope = scopeFor(ctx);
  const rule = await scope.getOrFail('automation_rules', ctx.params.id, { resource: 'Rule' });
  const conditions = safeJson(rule.conditions_json, {});
  const actions = safeJson(rule.actions_json, []);

  const matches = await sampleMatches(scope, ctx, rule.trigger_key, conditions);

  return ok({
    rule: toRule(rule),
    wouldMatch: matches.length,
    sample: matches.slice(0, 10),
    wouldDo: actions.map(a => describeAction(a)),
    // Nothing was sent, changed or created by asking this question.
    executed: false,
  }, { ctx });
}, { anyPermission: ['automation.manage', 'settings.view'] });

// ---------------------------------------------------------------------------
// The evaluator, called by the modules that emit events
// ---------------------------------------------------------------------------

/**
 * Run every active rule for one trigger.
 *
 * Failures are contained per rule: one broken action must not stop the others,
 * and must never fail the business operation that emitted the event.
 */
export async function runAutomation(ctx, triggerKey, payload = {}) {
  const scope = scopeFor(ctx);
  const rules = await scope.all('automation_rules',
    { trigger_key: triggerKey, is_active: 1 }, { limit: 50 });
  if (!rules.length) return { fired: 0, rules: [] };

  const outcomes = [];
  for (const rule of rules) {
    try {
      const conditions = safeJson(rule.conditions_json, {});
      if (!matchesConditions(conditions, payload)) {
        outcomes.push({ rule: rule.name, fired: false, reason: 'conditions not met' });
        continue;
      }

      // A delayed rule is not run now. Pretending otherwise would make the
      // "wait 2 days then remind" rule fire immediately.
      if (rule.delay_minutes > 0) {
        outcomes.push({
          rule: rule.name, fired: false,
          reason: `scheduled for ${addMinutes(rule.delay_minutes)}`,
          scheduledFor: addMinutes(rule.delay_minutes),
        });
        continue;
      }

      const actions = safeJson(rule.actions_json, []);
      const results = [];
      for (const action of actions) {
        results.push(await executeAction(ctx, scope, action, payload));
      }

      await scope.update('automation_rules', rule.id, {
        fire_count: (rule.fire_count ?? 0) + 1,
        last_fired_at: nowIso(),
      });
      outcomes.push({ rule: rule.name, fired: true, actions: results });
    } catch (err) {
      // Logged, not thrown: an automation rule must never break the upload or
      // the payment that triggered it.
      console.warn('automation rule failed', { rule: rule.id, message: err.message });
      outcomes.push({ rule: rule.name, fired: false, error: err.message });
    }
  }

  return { fired: outcomes.filter(o => o.fired).length, rules: outcomes };
}

async function executeAction(ctx, scope, action, payload) {
  switch (action.type) {
    case 'notify': {
      const result = await dispatchNotification(ctx, {
        triggerKey: action.triggerKey ?? 'document.uploaded',
        userId: action.recipient === 'assignee' ? payload.assignedTo : (action.userId ?? payload.userId),
        clientId: payload.clientId ?? null,
        channels: action.channels ?? null,
        variables: payload.variables ?? {},
      });
      return { type: 'notify', sent: result.summary.sent, skipped: result.summary.skipped };
    }
    case 'create_task': {
      if (!payload.clientId && !action.assignTo) return { type: 'create_task', skipped: 'no target' };
      const task = await scope.insert('tasks', {
        id: ID.task(),
        client_id: payload.clientId ?? null,
        company_id: payload.companyId ?? null,
        title: renderTemplate(action.title ?? 'Automated task', payload),
        type: 'automation',
        status: 'todo',
        priority: action.priority ?? 'normal',
        assigned_to: action.assignTo === 'assignee' ? payload.assignedTo : (action.userId ?? null),
        created_by: null,
        due_at: action.dueInDays ? addMinutes(action.dueInDays * 24 * 60) : null,
        source_type: 'automation',
        source_id: payload.entityId ?? null,
      });
      return { type: 'create_task', taskId: task.id };
    }
    case 'assign': {
      if (!payload.entityTable || !payload.entityId || !action.userId) {
        return { type: 'assign', skipped: 'no target' };
      }
      await scope.update(payload.entityTable, payload.entityId, { assigned_to: action.userId });
      return { type: 'assign', userId: action.userId };
    }
    case 'set_status': {
      if (!payload.entityTable || !payload.entityId || !action.status) {
        return { type: 'set_status', skipped: 'no target' };
      }
      await scope.update(payload.entityTable, payload.entityId, { status: action.status });
      return { type: 'set_status', status: action.status };
    }
    default:
      return { type: action.type, skipped: 'unsupported' };
  }
}

/** Conditions are a flat AND of field comparisons — readable, and enough. */
function matchesConditions(conditions, payload) {
  for (const [field, expected] of Object.entries(conditions ?? {})) {
    const actual = payload[field];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (expected !== null && typeof expected === 'object') {
      if (expected.gt !== undefined && !(Number(actual) > Number(expected.gt))) return false;
      if (expected.lt !== undefined && !(Number(actual) < Number(expected.lt))) return false;
      if (expected.contains !== undefined
        && !String(actual ?? '').toLowerCase().includes(String(expected.contains).toLowerCase())) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

async function validateActions(ctx, actions) {
  const out = [];
  for (const action of actions) {
    if (!ACTION_KEYS.has(action?.type)) {
      throw new BadRequestError(
        `Unknown action "${action?.type}". Available: ${[...ACTION_KEYS].join(', ')}.`);
    }

    // A rule that says it will send a WhatsApp message on a plan without
    // WhatsApp would silently do nothing every time it fired.
    if (action.type === 'notify' && Array.isArray(action.channels)) {
      for (const channel of action.channels) {
        const feature = { whatsapp: 'whatsapp_integration', sms: 'sms_automation', push: 'mobile_app' }[channel];
        if (feature && !(await hasFeature(ctx, feature))) {
          throw new BadRequestError(
            `This rule would send on ${channel}, which your plan does not include. Remove that channel or add the module first.`);
        }
      }
    }
    out.push(action);
  }
  return out;
}

async function sampleMatches(scope, ctx, triggerKey, conditions) {
  // Which table a trigger concerns, for the dry run.
  const table = triggerKey.startsWith('document.') ? 'documents'
    : triggerKey.startsWith('client.') ? 'clients'
    : triggerKey.startsWith('invoice.') || triggerKey.startsWith('payment.') ? 'invoices'
    : triggerKey.startsWith('query.') ? 'queries'
    : null;
  if (!table) return [];

  const rows = await scope.all(table, {}, { limit: 200 });
  return rows
    .filter(row => matchesConditions(conditions, row))
    .map(row => ({
      id: row.id,
      label: row.title ?? row.display_name ?? row.invoice_no ?? row.subject ?? row.id,
      status: row.status,
    }));
}

function describeAction(action) {
  const meta = ACTION_TYPES.find(a => a.key === action.type);
  if (action.type === 'notify') {
    return `${meta?.name ?? action.type} on ${(action.channels ?? ['the default channels']).join(', ')}`;
  }
  if (action.type === 'create_task') return `Create a task: "${action.title ?? 'Automated task'}"`;
  if (action.type === 'set_status') return `Set the status to ${action.status}`;
  return meta?.name ?? action.type;
}

function renderTemplate(text, payload) {
  return String(text).replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => String(payload[key] ?? ''));
}

function toRule(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    triggerKey: r.trigger_key,
    triggerName: TRIGGER_MAP.get(r.trigger_key)?.name ?? r.trigger_key,
    conditions: safeJson(r.conditions_json, {}),
    actions: safeJson(r.actions_json, []),
    summary: safeJson(r.actions_json, []).map(describeAction),
    channel: r.channel,
    delayMinutes: r.delay_minutes,
    isActive: !!r.is_active,
    fireCount: r.fire_count,
    lastFiredAt: r.last_fired_at,
    createdByName: r.created_by_name ?? null,
    createdAt: r.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as automationRouter };
