/**
 * Scheduled work, driven by the Worker's cron triggers.
 *
 * Three cadences are configured in wrangler.jsonc:
 *   every 15 minutes  — due reminders, retries, call metric rollups
 *   daily at 03:00    — retention purges, monthly period opening, backups,
 *                       nightly AI insight generation, scheduled exports
 *   weekly Monday 09:00 — the weekly insight digest
 *
 * Each job is independent and failure-isolated: one job throwing never stops
 * the rest of the run, and every outcome is written to system_logs.
 */

import { Db } from '../db/client.js';
import { platformScope } from '../db/tenancy.js';
import { nowIso, addDays, monthKey, dayKey, daysBetween, recentMonthKeys } from '../utils/time.js';
import { logSystemEvent } from './logging.js';
import { purgeExpiredAuditLogs, anchorChain } from './audit.js';
import { runDueAutomationJobs } from './automation.js';
import { purgeExpiredSessions } from '../auth/session.js';
import { purgeRateLimits } from './ratelimit.js';
import { purgeSystemLogs } from './logging.js';

export async function runScheduled(event, env) {
  const cron = event?.cron ?? '';
  const started = Date.now();
  const results = {};

  const jobs = selectJobs(cron);
  for (const [name, job] of jobs) {
    try {
      results[name] = await job(env);
    } catch (err) {
      results[name] = { error: err?.message ?? String(err) };
      await logSystemEvent(env, {
        level: 'error', source: 'cron', event: `job_failed:${name}`,
        message: err?.message ?? 'Unknown error', stack: err?.stack, context: { cron },
      });
    }
  }

  await logSystemEvent(env, {
    level: 'info', source: 'cron', event: 'run_complete',
    message: `Cron ${cron || 'manual'} finished`,
    durationMs: Date.now() - started,
    context: { cron, results },
  });

  return results;
}

function selectJobs(cron) {
  const frequent = [
    // Delayed automation runs on the frequent pass: a rule that says
    // "in 30 minutes" cannot wait for the nightly run.
    ['automationJobs', runDueAutomationJobs],
    ['dueReminders', sendDueReminders],
    ['overdueInvoices', flagOverdueInvoices],
    ['slaBreaches', flagSlaBreaches],
    ['callMetrics', rollUpCallMetrics],
    ['taskReminders', sendTaskReminders],
  ];
  const daily = [
    ['openFilingPeriods', openMonthlyFilingPeriods],
    ['subscriptionRenewals', flagSubscriptionRenewals],
    ['retention', runRetention],
    ['anchorAuditChains', anchorAuditChains],
    ['scheduledReports', runScheduledReports],
    ['nightlyInsights', generateNightlyInsights],
    ['storageSync', retryStorageSync],
  ];
  const weekly = [
    ['weeklyDigest', sendWeeklyDigest],
  ];

  if (cron.startsWith('*/15')) return frequent;
  if (cron === '0 3 * * *') return daily;
  if (cron === '0 9 * * 1') return weekly;
  return [...frequent, ...daily, ...weekly];
}

// ---------------------------------------------------------------------------
// Reminder jobs — the proposal's Automation Layer
// ---------------------------------------------------------------------------

/**
 * GST due-date, filing due-date and pending-document reminders.
 * A reminder is sent at 7, 3 and 1 days before the due date, once each.
 */
async function sendDueReminders(env) {
  const db = new Db(env.DB);
  const { dispatchNotification } = await import('./notifications.js');

  const periods = await db.many(
    `SELECT fp.*, c.display_name, c.primary_contact_email, c.primary_contact_phone,
            cmp.name AS company_name
       FROM filing_periods fp
       JOIN clients c ON c.id = fp.client_id
       JOIN companies cmp ON cmp.id = fp.company_id
      WHERE fp.due_date IS NOT NULL
        AND fp.status NOT IN ('filed','archived','signed_off','paid')
        AND fp.due_date > ?
        AND fp.due_date <= ?
      LIMIT 500`,
    [nowIso(), addDays(8)]);

  let sent = 0;
  for (const period of periods) {
    const daysLeft = daysBetween(nowIso(), period.due_date);
    if (![7, 3, 1, 0].includes(daysLeft)) continue;

    const contacts = await db.many(
      `SELECT u.id FROM client_contacts cc
         JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [period.client_id]);

    const pending = await db.count(
      `SELECT COUNT(*) FROM checklist_items
        WHERE filing_period_id = ? AND status IN ('pending','query_raised','rejected')`,
      [period.id]);

    const ctx = syntheticCtx(env, period.tenant_id);
    await dispatchNotification(ctx, {
      triggerKey: 'gst.due_date',
      tenantId: period.tenant_id,
      userIds: contacts.map(c => c.id),
      toEmail: contacts.length ? null : period.primary_contact_email,
      toPhone: contacts.length ? null : period.primary_contact_phone,
      clientId: period.client_id,
      entityType: 'filing_period',
      entityId: period.id,
      variables: {
        clientName: period.display_name,
        period: period.period_key,
        dueDate: period.due_date.slice(0, 10),
        daysLeft,
        pendingCount: pending,
        link: `${env.APP_URL || ''}/client/filings/${period.id}`,
      },
      link: { path: `/client/filings/${period.id}` },
    });
    sent++;
  }
  return { periodsChecked: periods.length, remindersSent: sent };
}

async function flagOverdueInvoices(env) {
  const db = new Db(env.DB);
  const { dispatchNotification } = await import('./notifications.js');
  const { formatINR } = await import('../utils/money.js');

  const overdue = await db.many(
    `SELECT i.*, c.display_name, c.id AS cid
       FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.status IN ('issued','sent','partially_paid')
        AND i.due_date < ? LIMIT 300`, [nowIso()]);

  let updated = 0, notified = 0;
  for (const invoice of overdue) {
    await db.update('invoices', { id: invoice.id }, { status: 'overdue', updated_at: nowIso() });
    updated++;

    // One reminder a day at most, and at most five in total.
    const lastSent = invoice.last_reminder_at ? daysBetween(invoice.last_reminder_at, nowIso()) : 99;
    if (lastSent < 1 || (invoice.reminder_count ?? 0) >= 5) continue;

    const contacts = invoice.client_id
      ? await db.many(
          `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
            WHERE cc.client_id = ? AND u.status = 'active'`, [invoice.client_id])
      : [];

    const ctx = syntheticCtx(env, invoice.tenant_id);
    await dispatchNotification(ctx, {
      triggerKey: 'payment.overdue',
      tenantId: invoice.tenant_id,
      userIds: contacts.map(c => c.id),
      toEmail: contacts.length ? null : invoice.billing_email,
      clientId: invoice.client_id,
      entityType: 'invoice',
      entityId: invoice.id,
      variables: {
        clientName: invoice.display_name ?? invoice.billing_name ?? 'there',
        invoiceNo: invoice.invoice_no,
        amount: formatINR(invoice.amount_due_paise),
        dueDate: invoice.due_date.slice(0, 10),
        daysOverdue: daysBetween(invoice.due_date, nowIso()),
        payUrl: `${env.APP_URL || ''}/client/invoices/${invoice.id}`,
      },
      link: { path: `/client/invoices/${invoice.id}` },
    });
    await db.update('invoices', { id: invoice.id }, {
      reminder_count: (invoice.reminder_count ?? 0) + 1, last_reminder_at: nowIso(),
    });
    notified++;
  }
  return { markedOverdue: updated, remindersSent: notified };
}

/** Documents past their SLA get escalated to the assigned manager. */
async function flagSlaBreaches(env) {
  const db = new Db(env.DB);
  const breached = await db.many(
    `SELECT d.id, d.tenant_id, d.title, d.assigned_to, d.client_id
       FROM documents d
      WHERE d.sla_due_at IS NOT NULL AND d.sla_due_at < ?
        AND d.status IN ('submitted','under_review')
        AND d.priority != 'urgent' AND d.deleted_at IS NULL
      LIMIT 200`, [nowIso()]);

  for (const doc of breached) {
    await db.update('documents', { id: doc.id }, { priority: 'urgent', updated_at: nowIso() });
  }
  return { escalated: breached.length };
}

async function sendTaskReminders(env) {
  const db = new Db(env.DB);
  const { dispatchNotification } = await import('./notifications.js');

  const due = await db.many(
    `SELECT * FROM tasks
      WHERE status IN ('todo','in_progress') AND assigned_to IS NOT NULL
        AND reminder_at IS NOT NULL AND reminder_at <= ? LIMIT 200`, [nowIso()]);

  for (const task of due) {
    const ctx = syntheticCtx(env, task.tenant_id);
    await dispatchNotification(ctx, {
      triggerKey: 'task.due',
      tenantId: task.tenant_id,
      userId: task.assigned_to,
      clientId: task.client_id,
      entityType: 'task',
      entityId: task.id,
      variables: { taskTitle: task.title, dueDate: task.due_at?.slice(0, 10) ?? '' },
      link: { path: `/tasks/${task.id}` },
    });
    await db.update('tasks', { id: task.id }, { reminder_at: null });
  }
  return { remindersSent: due.length };
}

// ---------------------------------------------------------------------------
// Daily jobs
// ---------------------------------------------------------------------------

/** Open the new month's filing period for every active client. */
async function openMonthlyFilingPeriods(env) {
  const db = new Db(env.DB);
  const { openFilingPeriod } = await import('./provisioning.js');
  const { TenantScope } = await import('../db/tenancy.js');
  const { dispatchNotification } = await import('./notifications.js');

  // Only on the first three days of a month, so a missed run still catches up.
  const dayOfMonth = new Date().getUTCDate();
  if (dayOfMonth > 3) return { skipped: true, reason: 'not the start of a month' };

  const period = monthKey();
  const clients = await db.many(
    `SELECT c.id, c.tenant_id, c.company_id, c.display_name
       FROM clients c
      WHERE c.status = 'active' AND c.deleted_at IS NULL LIMIT 1000`);

  let created = 0;
  for (const client of clients) {
    const scope = new TenantScope(db, client.tenant_id);
    const result = await openFilingPeriod(scope, db, {
      clientId: client.id, companyId: client.company_id, periodKey: period,
    });
    if (!result.created) continue;
    created++;

    const contacts = await db.many(
      `SELECT u.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id
        WHERE cc.client_id = ? AND u.status = 'active'`, [client.id]);

    const ctx = syntheticCtx(env, client.tenant_id);
    await dispatchNotification(ctx, {
      triggerKey: 'reminder.monthly',
      tenantId: client.tenant_id,
      userIds: contacts.map(c => c.id),
      clientId: client.id,
      entityType: 'filing_period',
      entityId: result.period.id,
      variables: {
        clientName: client.display_name,
        period,
        link: `${env.APP_URL || ''}/client/upload`,
      },
      link: { path: '/client/upload' },
    });
  }
  return { period, clientsChecked: clients.length, periodsCreated: created };
}

async function flagSubscriptionRenewals(env) {
  const db = new Db(env.DB);
  const { dispatchNotification } = await import('./notifications.js');
  const { formatINR } = await import('../utils/money.js');

  const soon = await db.many(
    `SELECT s.*, p.name AS plan_name, p.monthly_price_paise, p.yearly_price_paise, t.name AS tenant_name
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.status IN ('active','trialing') AND s.auto_renew = 1
        AND s.current_period_end > ? AND s.current_period_end <= ? LIMIT 300`,
    [nowIso(), addDays(7)]);

  let notified = 0, expired = 0;
  for (const sub of soon) {
    const days = daysBetween(nowIso(), sub.current_period_end);
    if (![7, 3, 1].includes(days)) continue;

    const admins = await db.many(
      `SELECT u.id FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE u.tenant_id = ? AND r.key IN ('admin','super_admin') AND u.status = 'active'`,
      [sub.tenant_id]);

    const ctx = syntheticCtx(env, sub.tenant_id);
    await dispatchNotification(ctx, {
      triggerKey: 'subscription.renewal',
      tenantId: sub.tenant_id,
      userIds: admins.map(a => a.id),
      entityType: 'subscription',
      entityId: sub.id,
      variables: {
        name: sub.tenant_name,
        planName: sub.plan_name,
        renewalDate: sub.current_period_end.slice(0, 10),
        amount: formatINR(sub.billing_cycle === 'yearly' ? sub.yearly_price_paise : sub.monthly_price_paise),
        link: `${env.APP_URL || ''}/billing/subscription`,
      },
      link: { path: '/billing/subscription' },
    });
    notified++;
  }

  const lapsed = await db.many(
    `SELECT id, tenant_id FROM subscriptions
      WHERE status IN ('active','trialing') AND current_period_end < ? AND auto_renew = 0 LIMIT 200`,
    [nowIso()]);
  for (const sub of lapsed) {
    await db.update('subscriptions', { id: sub.id }, { status: 'expired', updated_at: nowIso() });
    expired++;
  }

  return { notified, expired };
}

/** Retention: audit logs, sessions, rate limits, system logs, recordings. */
async function runRetention(env) {
  const db = new Db(env.DB);
  const auditPurged = await purgeExpiredAuditLogs(db);
  const sessionsPurged = await purgeExpiredSessions(db, addDays(-30));
  const rateLimitsPurged = await purgeRateLimits(db);
  const logsPurged = await purgeSystemLogs(db, addDays(-90));

  const recordings = await db.many(
    `SELECT id, storage_key FROM call_recordings
      WHERE retention_until IS NOT NULL AND retention_until < ? AND status = 'available' LIMIT 200`,
    [nowIso()]);
  for (const rec of recordings) {
    if (rec.storage_key && env.DOCS) {
      try { await env.DOCS.delete(rec.storage_key); } catch { /* object already gone */ }
    }
    await db.update('call_recordings', { id: rec.id }, { status: 'deleted', storage_key: null, updated_at: nowIso() });
  }

  return { auditPurged, sessionsPurged, rateLimitsPurged, logsPurged, recordingsExpired: recordings.length };
}

/**
 * Anchor every tenant's audit chain, and the platform's.
 *
 * Deliberately ordered AFTER retention in the daily run: retention purges
 * expired entries, and anchoring a chain before that purge would record a head
 * the purge then invalidates.
 *
 * A tenant whose chain has shrunk is not anchored — the refusal is the signal.
 * It is logged at error level, because entries disappearing from an audit trail
 * is exactly the thing somebody needs to be told about.
 */
async function anchorAuditChains(env) {
  const db = new Db(env.DB);
  const tenants = await db.many('SELECT id FROM tenants WHERE deleted_at IS NULL');

  let anchored = 0;
  const shrank = [];

  // null covers the platform's own chain, which has no tenant.
  for (const tenantId of [null, ...tenants.map(t => t.id)]) {
    const result = await anchorChain(db, tenantId);
    if (result.anchored) { anchored += 1; continue; }
    if (result.reason === 'chain_shrank') {
      shrank.push({ tenantId, ...result });
      await logSystemEvent(env, {
        level: 'error', source: 'cron', event: 'audit_chain_shrank',
        message: `Audit chain for ${tenantId ?? 'the platform'} is shorter than its last anchor: `
          + `${result.previousSequence} → ${result.currentSequence}. Entries have been removed from the end.`,
        tenantId,
        context: result,
      });
    }
  }

  return { anchored, shrank: shrank.length, tenants: tenants.length + 1 };
}

async function runScheduledReports(env) {
  const db = new Db(env.DB);
  const due = await db.many(
    `SELECT * FROM scheduled_reports WHERE is_active = 1 AND (next_run_at IS NULL OR next_run_at <= ?) LIMIT 100`,
    [nowIso()]);

  const { runScheduledExport } = await import('./reporting.js');
  let ran = 0;
  for (const schedule of due) {
    try {
      await runScheduledExport(env, schedule);
      ran++;
    } catch (err) {
      await db.update('scheduled_reports', { id: schedule.id }, {
        last_run_at: nowIso(), last_run_status: `failed: ${err.message}`.slice(0, 200),
      });
    }
  }
  return { due: due.length, ran };
}

async function generateNightlyInsights(env) {
  const { generateInsightsForAllTenants } = await import('./insights.js');
  return generateInsightsForAllTenants(env);
}

async function retryStorageSync(env) {
  const db = new Db(env.DB);
  const pending = await db.count(
    `SELECT COUNT(*) FROM storage_sync_items WHERE status IN ('pending','failed')`);
  const { retryPendingSyncs } = await import('./cloud-sync.js');
  const result = await retryPendingSyncs(env);
  return { pending, ...result };
}

async function rollUpCallMetrics(env) {
  const db = new Db(env.DB);
  const day = dayKey();
  const rows = await db.many(
    `SELECT cr.tenant_id, cr.agent_id,
            COUNT(*) AS total,
            SUM(CASE WHEN cr.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
            SUM(CASE WHEN cr.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
            SUM(CASE WHEN cr.status = 'missed' THEN 1 ELSE 0 END) AS missed,
            SUM(CASE WHEN cr.answered = 1 THEN 1 ELSE 0 END) AS answered,
            COALESCE(SUM(cr.duration_seconds), 0) AS total_duration,
            SUM(CASE WHEN ca.sentiment = 'positive' THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN ca.sentiment = 'neutral' THEN 1 ELSE 0 END) AS neutral,
            SUM(CASE WHEN ca.sentiment = 'negative' THEN 1 ELSE 0 END) AS negative,
            SUM(CASE WHEN cr.follow_up_task_id IS NOT NULL THEN 1 ELSE 0 END) AS follow_ups
       FROM call_records cr
       LEFT JOIN call_ai_analysis ca ON ca.call_id = cr.id
      WHERE substr(cr.created_at, 1, 10) = ?
      GROUP BY cr.tenant_id, cr.agent_id`, [day]);

  for (const r of rows) {
    const total = Number(r.total) || 0;
    const duration = Number(r.total_duration) || 0;
    await db.run(
      `INSERT INTO call_metrics_daily
         (id, tenant_id, agent_id, day, total_calls, inbound_calls, outbound_calls, missed_calls,
          answered_calls, total_duration_sec, avg_duration_sec, positive_count, neutral_count,
          negative_count, follow_ups_created, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id, agent_id, day) DO UPDATE SET
         total_calls = excluded.total_calls, inbound_calls = excluded.inbound_calls,
         outbound_calls = excluded.outbound_calls, missed_calls = excluded.missed_calls,
         answered_calls = excluded.answered_calls, total_duration_sec = excluded.total_duration_sec,
         avg_duration_sec = excluded.avg_duration_sec, positive_count = excluded.positive_count,
         neutral_count = excluded.neutral_count, negative_count = excluded.negative_count,
         follow_ups_created = excluded.follow_ups_created, updated_at = excluded.updated_at`,
      [`mtr_${r.tenant_id}_${r.agent_id ?? 'none'}_${day}`, r.tenant_id, r.agent_id, day,
       total, Number(r.inbound) || 0, Number(r.outbound) || 0, Number(r.missed) || 0,
       Number(r.answered) || 0, duration, total ? Math.round(duration / total) : 0,
       Number(r.positive) || 0, Number(r.neutral) || 0, Number(r.negative) || 0,
       Number(r.follow_ups) || 0, nowIso()]);
  }
  return { day, agentsRolledUp: rows.length };
}

async function sendWeeklyDigest(env) {
  const { sendWeeklyDigests } = await import('./insights.js');
  return sendWeeklyDigests(env);
}

// ---------------------------------------------------------------------------

/**
 * A minimal context for jobs that call request-oriented services. It carries
 * only what those services read: env, tenant id and a no-op defer.
 */
export function syntheticCtx(env, tenantId = null) {
  return {
    env,
    tenantId,
    userId: null,
    user: null,
    tenant: null,
    roleKeys: ['system'],
    ip: 'cron',
    userAgent: 'meet-millions-cron/1.0',
    requestId: `cron_${Date.now().toString(36)}`,
    session: null,
    apiKey: null,
    permissions: new Set(['*']),
    has: () => true,
    hasRole: () => false,
    defer: (p) => (typeof p === 'function' ? p() : p),
  };
}

export { platformScope, recentMonthKeys };
