/**
 * AI Business Insights.
 *
 * The deterministic analysis runs for everyone: churn risk, revenue trend,
 * workload forecast and anomaly detection are computed from stored data with
 * plain arithmetic, so the insight feed is useful with no vendor connected.
 * When Claude is configured, it turns those findings into the plain-language
 * weekly digest the addendum describes — but the numbers always come from the
 * database, never from the model.
 */

import { Db } from '../db/client.js';
import { TenantScope } from '../db/tenancy.js';
import { ID } from '../utils/id.js';
import { nowIso, monthKey, recentMonthKeys, periodBounds, daysBetween, addDays } from '../utils/time.js';
import { formatINR, formatINRCompact } from '../utils/money.js';
import { ClaudeProvider } from '../integrations/ai.js';
import { syntheticCtx } from './scheduler.js';

/** Compute the insight set for one tenant. Pure analysis, no model needed. */
export async function computeInsights(scope) {
  const insights = [];
  const month = monthKey();
  const bounds = periodBounds('monthly', month);

  // ---- Revenue trend -------------------------------------------------------
  const months = recentMonthKeys(4);
  const revenue = [];
  for (const m of months) {
    const b = periodBounds('monthly', m);
    const row = await scope.rawOne(
      `SELECT COALESCE(SUM(amount_paise),0) AS collected FROM payments
        WHERE tenant_id = ? AND status = 'success' AND created_at BETWEEN ? AND ?`,
      [scope.tenantId, b.start, b.end]);
    revenue.push({ periodKey: m, collectedPaise: Number(row?.collected) || 0 });
  }

  if (revenue.length >= 3) {
    const recent = revenue.slice(-3);
    const first = recent[0].collectedPaise;
    const last = recent[2].collectedPaise;
    if (first > 0) {
      const changePct = Math.round(((last - first) / first) * 100);
      if (Math.abs(changePct) >= 15) {
        insights.push({
          kind: 'revenue_forecast',
          severity: changePct > 0 ? 'success' : 'warning',
          title: changePct > 0
            ? `Collections are up ${changePct}% over three months`
            : `Collections are down ${Math.abs(changePct)}% over three months`,
          body: `Collected revenue moved from ${formatINR(first)} in ${recent[0].periodKey} to ${formatINR(last)} in ${recent[2].periodKey}.`,
          metrics: { changePct, series: recent },
          confidence: 0.9,
        });
      }
    }
  }

  // ---- Churn / at-risk clients --------------------------------------------
  const atRisk = await scope.raw(
    `SELECT c.id, c.display_name, c.status,
            MAX(d.created_at) AS last_upload,
            (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id
               AND i.status IN ('overdue')) AS overdue_invoices
       FROM clients c
       LEFT JOIN documents d ON d.client_id = c.id AND d.deleted_at IS NULL
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status = 'active'
      GROUP BY c.id, c.display_name, c.status`, [scope.tenantId]);

  for (const client of atRisk) {
    const daysSinceUpload = client.last_upload ? daysBetween(client.last_upload, nowIso()) : null;
    const overdue = Number(client.overdue_invoices) || 0;

    // A simple, explainable score — the reason is always shown to the user.
    let score = 0;
    const reasons = [];
    if (daysSinceUpload === null) { score += 40; reasons.push('has never uploaded a document'); }
    else if (daysSinceUpload > 60) { score += 40; reasons.push(`has not uploaded anything for ${daysSinceUpload} days`); }
    else if (daysSinceUpload > 35) { score += 20; reasons.push(`last uploaded ${daysSinceUpload} days ago`); }
    if (overdue > 0) { score += 30 * Math.min(overdue, 2); reasons.push(`has ${overdue} overdue invoice${overdue === 1 ? '' : 's'}`); }

    if (score >= 40) {
      insights.push({
        kind: 'churn_risk',
        severity: score >= 70 ? 'danger' : 'warning',
        title: `${client.display_name} may be at risk`,
        body: `${client.display_name} ${reasons.join(' and ')}.`,
        entityType: 'client',
        entityId: client.id,
        metrics: { score: Math.min(score, 100), daysSinceUpload, overdueInvoices: overdue },
        confidence: 0.75,
      });
      await scope.update('clients', client.id, { health_score: Math.max(0, 100 - Math.min(score, 100)) });
    } else {
      await scope.update('clients', client.id, { health_score: Math.max(0, 100 - score) });
    }
  }

  // ---- Workload forecast ---------------------------------------------------
  const workload = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE tenant_id = ?1 AND deleted_at IS NULL
          AND status IN ('submitted','under_review')) AS pending,
       (SELECT COUNT(DISTINCT u.id) FROM users u
          JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
         WHERE u.tenant_id = ?1 AND u.status = 'active'
           AND r.key IN ('finance_executive','accountant')) AS executives,
       (SELECT COUNT(*) FROM filing_periods WHERE tenant_id = ?1
          AND due_date BETWEEN ?2 AND ?3 AND status NOT IN ('filed','archived')) AS due_soon`,
    [scope.tenantId, nowIso(), addDays(7)]);

  const pending = Number(workload?.pending) || 0;
  const executives = Number(workload?.executives) || 0;
  const dueSoon = Number(workload?.due_soon) || 0;

  if (pending > 0 && executives > 0) {
    const perExecutive = Math.round(pending / executives);
    if (perExecutive > 25) {
      insights.push({
        kind: 'workload_forecast',
        severity: perExecutive > 50 ? 'danger' : 'warning',
        title: `Verification backlog is ${perExecutive} documents per executive`,
        body: `${pending} documents are waiting across ${executives} executive${executives === 1 ? '' : 's'}. ${dueSoon} filing${dueSoon === 1 ? '' : 's'} fall due in the next seven days.`,
        metrics: { pending, executives, perExecutive, dueSoon },
        confidence: 0.95,
      });
    }
  }

  if (dueSoon > 0) {
    insights.push({
      kind: 'anomaly',
      severity: 'warning',
      title: `${dueSoon} filing${dueSoon === 1 ? '' : 's'} due within a week`,
      body: 'Check that the documents for each of these periods are in and verified.',
      metrics: { dueSoon },
      confidence: 1,
    });
  }

  // ---- SLA anomaly ---------------------------------------------------------
  const sla = await scope.rawOne(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN sla_met = 1 THEN 1 ELSE 0 END) AS met
       FROM verification_records
      WHERE tenant_id = ? AND created_at >= ? AND decision IN ('approved','rejected')`,
    [scope.tenantId, addDays(-30)]);

  const slaTotal = Number(sla?.total) || 0;
  const slaMet = Number(sla?.met) || 0;
  if (slaTotal >= 10) {
    const pct = Math.round((slaMet / slaTotal) * 100);
    if (pct < 85) {
      insights.push({
        kind: 'anomaly',
        severity: pct < 70 ? 'danger' : 'warning',
        title: `SLA compliance has fallen to ${pct}%`,
        body: `${slaTotal - slaMet} of ${slaTotal} verification decisions in the last 30 days missed their SLA.`,
        metrics: { compliancePct: pct, total: slaTotal, met: slaMet },
        confidence: 1,
      });
    }
  }

  // ---- Opportunity: unbilled verified work --------------------------------
  const unbilled = await scope.rawOne(
    `SELECT COUNT(*) AS n FROM filing_periods fp
      WHERE fp.tenant_id = ? AND fp.status IN ('signed_off','approved')
        AND NOT EXISTS (
          SELECT 1 FROM invoices i WHERE i.filing_period_id = fp.id AND i.status != 'void')`,
    [scope.tenantId]);
  const unbilledCount = Number(unbilled?.n) || 0;
  if (unbilledCount > 0) {
    insights.push({
      kind: 'opportunity',
      severity: 'info',
      title: `${unbilledCount} completed filing${unbilledCount === 1 ? '' : 's'} not yet invoiced`,
      body: 'These filings have been signed off but no invoice has been raised against them.',
      metrics: { unbilledCount },
      confidence: 1,
    });
  }

  return insights;
}

/** Persist a computed insight set, replacing the previous run's cards. */
export async function storeInsights(scope, insights, { periodKey = monthKey() } = {}) {
  await scope.db.run(
    `DELETE FROM ai_insights WHERE tenant_id = ? AND period_key = ? AND kind != 'digest'`,
    [scope.tenantId, periodKey]);

  const stored = [];
  for (const insight of insights) {
    stored.push(await scope.insert('ai_insights', {
      id: ID.insight(),
      kind: insight.kind,
      title: insight.title,
      body: insight.body,
      severity: insight.severity,
      entity_type: insight.entityType ?? null,
      entity_id: insight.entityId ?? null,
      metrics_json: insight.metrics ? JSON.stringify(insight.metrics) : null,
      confidence: insight.confidence ?? null,
      period_key: periodKey,
      generated_by: 'rules',
      model: null,
    }));
  }
  return stored;
}

/** The nightly job across every active tenant. */
export async function generateInsightsForAllTenants(env) {
  const db = new Db(env.DB);
  const tenants = await db.many(
    `SELECT id FROM tenants WHERE status IN ('active','trial') AND deleted_at IS NULL LIMIT 500`);

  let totalInsights = 0;
  for (const tenant of tenants) {
    const scope = new TenantScope(db, tenant.id);

    // Only for tenants that have the add-on; others keep a clean feed.
    const hasAddOn = await db.one(
      `SELECT 1 AS ok FROM add_on_subscriptions s JOIN add_ons a ON a.id = s.add_on_id
        WHERE s.tenant_id = ? AND a.key = 'ai_business_insights' AND s.status IN ('active','trialing')`,
      [tenant.id]);
    if (!hasAddOn) continue;

    const insights = await computeInsights(scope);
    await storeInsights(scope, insights);
    totalInsights += insights.length;
  }

  return { tenants: tenants.length, insights: totalInsights };
}

/**
 * The weekly digest. The findings are computed; Claude only writes the prose.
 * With no model configured the digest is assembled from the findings directly,
 * so the email still goes out.
 */
export async function buildDigest(ctx, scope) {
  const insights = await computeInsights(scope);
  const claude = new ClaudeProvider(ctx.env);

  const findings = insights.map(i => `- [${i.severity}] ${i.title}: ${i.body}`).join('\n');

  if (!insights.length) {
    return {
      text: 'Nothing needs your attention this week — no at-risk clients, no SLA slippage and no overdue filings.',
      generatedBy: 'rules',
      insights,
    };
  }

  if (!claude.isConfigured()) {
    return {
      text: `This week's findings:\n\n${findings}`,
      generatedBy: 'rules',
      insights,
    };
  }

  const result = await claude.complete({
    system: [
      'You write a short weekly digest for the leadership of an Indian accounting firm.',
      'You are given findings that were computed from the firm\'s own data. Summarise them in three or four sentences.',
      'Do not invent numbers, clients or trends beyond the findings. Lead with what needs action.',
    ].join(' '),
    messages: [{ role: 'user', content: `Findings:\n${findings}` }],
    maxTokens: 500,
    temperature: 0.3,
  });

  return {
    text: result.ok ? result.data.text : `This week's findings:\n\n${findings}`,
    generatedBy: result.ok ? 'llm' : 'rules',
    model: result.ok ? result.data.model : null,
    insights,
  };
}

/** Send the weekly digest to every tenant that has the add-on. */
export async function sendWeeklyDigests(env) {
  const db = new Db(env.DB);
  const { dispatchNotification } = await import('./notifications.js');

  const tenants = await db.many(
    `SELECT t.id, t.name FROM tenants t
       JOIN add_on_subscriptions s ON s.tenant_id = t.id
       JOIN add_ons a ON a.id = s.add_on_id
      WHERE t.status = 'active' AND a.key = 'ai_business_insights'
        AND s.status IN ('active','trialing') LIMIT 300`);

  let sent = 0;
  for (const tenant of tenants) {
    const scope = new TenantScope(db, tenant.id);
    const ctx = syntheticCtx(env, tenant.id);
    const digest = await buildDigest(ctx, scope);

    await scope.insert('ai_insights', {
      id: ID.insight(),
      kind: 'digest',
      title: 'Weekly insight digest',
      body: digest.text,
      severity: 'info',
      period_key: monthKey(),
      generated_by: digest.generatedBy,
      model: digest.model ?? null,
      confidence: null,
    });

    const recipients = await db.many(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
        WHERE u.tenant_id = ? AND u.status = 'active'
          AND r.key IN ('admin','super_admin','finance_manager')`, [tenant.id]);

    await dispatchNotification(ctx, {
      triggerKey: 'insights.weekly_digest',
      tenantId: tenant.id,
      userIds: recipients.map(r => r.id),
      variables: {
        name: tenant.name,
        organisation: tenant.name,
        digest: digest.text,
        link: `${env.APP_URL || ''}/ai/insights`,
      },
      link: { path: '/ai/insights' },
    });
    sent++;
  }

  return { tenants: tenants.length, digestsSent: sent };
}

export { formatINRCompact };
