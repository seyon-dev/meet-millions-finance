/**
 * The automation rule engine.
 *
 * This lives in services/ rather than in the route module because the thing
 * that has to run it is the event lifecycle, not an HTTP request. It was in
 * modules/automation.js next to the CRUD routes, exported, documented as
 * "the modules that emit events call runAutomation" — and called by nothing.
 * Rules could be written, listed and previewed; none of them had ever fired.
 *
 * Where the events are
 * --------------------
 * Every business event in this system already announces itself exactly once,
 * by calling `dispatchNotification` with a trigger key — 36 call sites sharing
 * the same vocabulary automation rules are written against (both read
 * NOTIFICATION_TRIGGERS). So the engine hangs off that single point rather
 * than off 36 separate ones. Wiring each call site by hand would mean the
 * next event somebody adds silently has no automation, which is the failure
 * this is fixing.
 *
 * Automation runs BEFORE the notification's own early returns, because a rule
 * must fire on the event itself — not only when the event also happened to
 * have somebody to notify.
 *
 * Re-entrancy
 * -----------
 * A rule's `notify` action dispatches a notification, which would run the
 * rules again, which would notify again. `dispatchNotification` therefore
 * takes `runRules`, and the notify action passes false. An explicit argument
 * rather than hidden depth-tracking, so the loop is visible in the code.
 *
 * Nothing here may throw into its caller. An automation rule that breaks must
 * not fail the upload, the payment or the verification that triggered it.
 */

import { Db } from '../db/client.js';
import { scopeFor, TenantScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso, addMinutes } from '../utils/time.js';
import { logSystemEvent } from './logging.js';

/**
 * The task types the schema allows.
 *
 * Mirrored from the CHECK on tasks.type in migration 0003. A rule may pick one;
 * anything else falls back to follow_up rather than failing the rule.
 */
const TASK_TYPES = ['general', 'verification', 'follow_up', 'call_follow_up',
  'collection', 'filing', 'reconciliation', 'onboarding', 'support'];

/** How many times a delayed job is retried before it is left alone. */
const MAX_ATTEMPTS = 3;

/**
 * Evaluate every active rule for a trigger.
 *
 * Returns a summary; never throws. `entity` identifies what the event was
 * about, which is what makes a delayed job de-duplicable: the same document
 * uploaded twice by a double-click must not queue the same reminder twice.
 */
export async function runAutomation(ctx, triggerKey, payload = {}) {
  try {
    if (!ctx?.tenantId) return { fired: 0, rules: [] };

    const scope = scopeFor(ctx);
    const rules = await scope.all('automation_rules',
      { trigger_key: triggerKey, is_active: 1 }, { limit: 50 });
    if (!rules.length) return { fired: 0, rules: [] };

    const outcomes = [];
    for (const rule of rules) {
      outcomes.push(await runOneRule(ctx, scope, rule, triggerKey, payload));
    }
    return { fired: outcomes.filter(o => o.fired).length, rules: outcomes };
  } catch (err) {
    // Reaching here means the engine itself failed, not a rule. Still contained.
    await safeLog(ctx?.env, {
      level: 'error', source: 'automation', event: 'engine_failed',
      message: err?.message ?? 'automation engine failed', stack: err?.stack,
      tenantId: ctx?.tenantId ?? null, context: { triggerKey },
    });
    return { fired: 0, rules: [], error: err?.message ?? 'automation engine failed' };
  }
}

async function runOneRule(ctx, scope, rule, triggerKey, payload) {
  const record = async (status, extra = {}) => {
    try {
      await scope.insert('automation_runs', {
        id: ID.automationRun(),
        rule_id: rule.id,
        trigger_key: triggerKey,
        status,
        reason: extra.reason ?? null,
        actions_json: extra.actions ? JSON.stringify(extra.actions) : null,
        error: extra.error ?? null,
        entity_type: payload.entityType ?? payload.entityTable ?? null,
        entity_id: payload.entityId ?? null,
      });
    } catch { /* the run log must never be the thing that breaks automation */ }
  };

  try {
    const conditions = safeJson(rule.conditions_json, {});
    if (!matchesConditions(conditions, payload)) {
      await record('skipped', { reason: 'conditions not met' });
      return { rule: rule.name, ruleId: rule.id, fired: false, reason: 'conditions not met' };
    }

    // A delayed rule becomes a queued job. Previously this branch returned a
    // "scheduled for ..." string and persisted nothing at all, so the rule
    // never ran and nobody could see that it had not.
    if (rule.delay_minutes > 0) {
      const runAfter = addMinutes(rule.delay_minutes);
      const queued = await queueJob(scope, rule, triggerKey, payload, runAfter);
      await record(queued ? 'queued' : 'skipped', {
        reason: queued ? `queued for ${runAfter}` : 'already queued for this entity',
      });
      return {
        rule: rule.name, ruleId: rule.id, fired: false,
        reason: queued ? `queued for ${runAfter}` : 'already queued for this entity',
        scheduledFor: runAfter,
      };
    }

    const results = await executeActions(ctx, scope, safeJson(rule.actions_json, []), payload);
    await bumpFired(scope, rule);
    await record('fired', { actions: results });
    return { rule: rule.name, ruleId: rule.id, fired: true, actions: results };
  } catch (err) {
    await record('failed', { error: err?.message ?? 'unknown error' });
    await safeLog(ctx?.env, {
      level: 'error', source: 'automation', event: 'rule_failed',
      message: `Automation rule "${rule.name}" failed: ${err?.message ?? 'unknown error'}`,
      stack: err?.stack, tenantId: rule.tenant_id,
      context: { ruleId: rule.id, triggerKey },
    });
    return { rule: rule.name, ruleId: rule.id, fired: false, error: err?.message };
  }
}

/**
 * Queue a delayed rule.
 *
 * Returns false when an identical job is already pending — the unique index on
 * (rule_id, dedupe_key) is what actually enforces it, so two concurrent
 * requests cannot both win.
 */
async function queueJob(scope, rule, triggerKey, payload, runAfter) {
  const dedupe = payload.entityId
    ? `${triggerKey}:${payload.entityType ?? payload.entityTable ?? 'entity'}:${payload.entityId}`
    : null;

  try {
    await scope.insert('automation_jobs', {
      id: ID.automationJob(),
      rule_id: rule.id,
      trigger_key: triggerKey,
      payload_json: JSON.stringify(payload ?? {}),
      run_after: runAfter,
      status: 'pending',
      attempts: 0,
      dedupe_key: dedupe,
    });
    return true;
  } catch (err) {
    // A unique-index collision is the de-duplication working, not a fault.
    if (/UNIQUE|constraint/i.test(err?.message ?? '')) return false;
    throw err;
  }
}

async function bumpFired(scope, rule) {
  await scope.update('automation_rules', rule.id, {
    fire_count: (rule.fire_count ?? 0) + 1,
    last_fired_at: nowIso(),
  });
}

async function executeActions(ctx, scope, actions, payload) {
  const results = [];
  for (const action of actions) results.push(await executeAction(ctx, scope, action, payload));
  return results;
}

export async function executeAction(ctx, scope, action, payload) {
  switch (action.type) {
    case 'notify': {
      // Imported here rather than at the top: notifications.js imports this
      // module to run the rules, and a static import both ways is a cycle.
      const { dispatchNotification } = await import('./notifications.js');
      const result = await dispatchNotification(ctx, {
        triggerKey: action.triggerKey ?? 'document.uploaded',
        userId: action.recipient === 'assignee' ? payload.assignedTo : (action.userId ?? payload.userId),
        clientId: payload.clientId ?? null,
        channels: action.channels ?? null,
        variables: payload.variables ?? {},
        // The guard. Without it a notify action re-enters the engine.
        runRules: false,
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
        // `tasks.type` is a CHECK'd list of what a task IS, and 'automation'
        // is not on it — writing that was a constraint violation every time,
        // which is why this action had never once created a task. Where the
        // task came FROM is source_type, below.
        type: TASK_TYPES.includes(action.taskType) ? action.taskType : 'follow_up',
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

/**
 * Run every automation job that is due.
 *
 * Called from the 15-minute scheduler, so `delay_minutes` is honoured to
 * within that window. A job is claimed by moving it to 'running' before the
 * actions run, so a second scheduler pass cannot pick up the same one.
 */
export async function runDueAutomationJobs(env, { limit = 100 } = {}) {
  const db = new Db(env.DB);
  const due = await db.many(
    `SELECT * FROM automation_jobs
      WHERE status = 'pending' AND run_after <= ?
      ORDER BY run_after LIMIT ?`, [nowIso(), limit]);

  let ran = 0;
  let failed = 0;

  for (const job of due) {
    // Claim it. The WHERE on status is what makes this safe against a second
    // pass that started before this one finished.
    const claimed = await db.run(
      `UPDATE automation_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'pending'`, [nowIso(), job.id]);
    if (!claimed?.meta?.changes && claimed?.changes !== 1 && claimed !== true) {
      // Different D1 shims report differently; re-read rather than guess.
      const now = await db.one('SELECT status FROM automation_jobs WHERE id = ?', [job.id]);
      if (now?.status !== 'running') continue;
    }

    const rule = await db.one('SELECT * FROM automation_rules WHERE id = ?', [job.rule_id]);
    const scope = new TenantScope(db, job.tenant_id);
    const payload = safeJson(job.payload_json, {});
    // A synthetic context: a scheduled job has no request and no signed-in
    // user, but the actions need the tenant and the environment.
    const jobCtx = { env, tenantId: job.tenant_id, userId: null };

    if (!rule || !rule.is_active) {
      await db.run(
        `UPDATE automation_jobs SET status = 'cancelled', last_error = ?, updated_at = ?
          WHERE id = ?`,
        [rule ? 'rule is no longer active' : 'rule no longer exists', nowIso(), job.id]);
      continue;
    }

    try {
      const results = await executeActions(jobCtx, scope, safeJson(rule.actions_json, []), payload);
      await bumpFired(scope, rule);
      await db.run(`UPDATE automation_jobs SET status = 'done', updated_at = ? WHERE id = ?`,
        [nowIso(), job.id]);
      await scope.insert('automation_runs', {
        id: ID.automationRun(),
        rule_id: rule.id,
        trigger_key: job.trigger_key,
        status: 'fired',
        reason: 'delayed job',
        actions_json: JSON.stringify(results),
        entity_type: payload.entityType ?? payload.entityTable ?? null,
        entity_id: payload.entityId ?? null,
      });
      ran += 1;
    } catch (err) {
      failed += 1;
      const exhausted = (job.attempts ?? 0) + 1 >= MAX_ATTEMPTS;
      await db.run(
        `UPDATE automation_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [exhausted ? 'failed' : 'pending', err?.message ?? 'unknown error', nowIso(), job.id]);
      await scope.insert('automation_runs', {
        id: ID.automationRun(),
        rule_id: rule.id,
        trigger_key: job.trigger_key,
        status: 'failed',
        reason: exhausted ? 'gave up after retries' : 'will retry',
        error: err?.message ?? 'unknown error',
        entity_type: payload.entityType ?? payload.entityTable ?? null,
        entity_id: payload.entityId ?? null,
      }).catch(() => {});
      await safeLog(env, {
        level: exhausted ? 'error' : 'warn', source: 'automation', event: 'job_failed',
        message: `Automation job for rule "${rule.name}" failed: ${err?.message}`,
        tenantId: job.tenant_id, context: { jobId: job.id, attempts: (job.attempts ?? 0) + 1 },
      });
    }
  }

  return { due: due.length, ran, failed };
}

/** Conditions are a flat AND of field comparisons — readable, and enough. */
export function matchesConditions(conditions, payload) {
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

export function renderTemplate(text, payload) {
  return String(text ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g,
    (_, key) => String(payload?.variables?.[key] ?? payload?.[key] ?? ''));
}

export function safeJson(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

async function safeLog(env, entry) {
  if (!env) return;
  try { await logSystemEvent(env, entry); } catch { /* logging must not throw */ }
}
