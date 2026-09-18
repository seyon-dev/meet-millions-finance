/**
 * Analytics: the custom report builder, saved dashboards and scheduled
 * exports (add-ons 4 and 26).
 *
 * The builder does not take SQL. It takes a dataset name, a set of fields and
 * a set of filters, all of which are looked up in a declared catalogue before
 * a query is built — so a user can ask for anything the catalogue allows, and
 * nothing it does not. The alternative, accepting expressions and sanitising
 * them, is how a reporting screen becomes a way to read another tenant's data.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated, fileResponse } from '../http/response.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate, escapeCsv } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, dayKey, addDays, monthKey, periodBounds, recentMonthKeys } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { REPORT_TYPES } from '../services/reporting.js';

const router = createRouter();

/**
 * The datasets the builder can query, and the only columns it will read.
 *
 * Every entry names a real table, a tenant column and an explicit field list.
 * Nothing outside this map can be selected, filtered or grouped, which is what
 * keeps a user-built report inside their own organisation.
 */
const DATASETS = {
  clients: {
    label: 'Clients',
    table: 'clients',
    alias: 'c',
    joins: 'LEFT JOIN companies co ON co.id = c.company_id',
    where: 'c.deleted_at IS NULL',
    fields: {
      display_name: { label: 'Client', column: 'c.display_name', type: 'text' },
      client_code: { label: 'Code', column: 'c.client_code', type: 'text' },
      status: { label: 'Status', column: 'c.status', type: 'enum' },
      onboarding_status: { label: 'Onboarding', column: 'c.onboarding_status', type: 'enum' },
      health_score: { label: 'Health score', column: 'c.health_score', type: 'number' },
      gstin: { label: 'GSTIN', column: 'co.gstin', type: 'text' },
      state_code: { label: 'State', column: 'co.state_code', type: 'text' },
      created_at: { label: 'Onboarded', column: 'c.created_at', type: 'date' },
    },
  },
  documents: {
    label: 'Documents',
    table: 'documents',
    alias: 'd',
    joins: `LEFT JOIN clients c ON c.id = d.client_id
            LEFT JOIN document_types dt ON dt.id = d.document_type_id
            LEFT JOIN users u ON u.id = d.verified_by`,
    where: 'd.deleted_at IS NULL',
    fields: {
      title: { label: 'Document', column: 'd.title', type: 'text' },
      client_name: { label: 'Client', column: 'c.display_name', type: 'text' },
      type_name: { label: 'Type', column: 'dt.name', type: 'text' },
      status: { label: 'Status', column: 'd.status', type: 'enum' },
      period_key: { label: 'Period', column: 'd.period_key', type: 'text' },
      verified_by_name: { label: 'Verified by', column: 'u.full_name', type: 'text' },
      verified_at: { label: 'Verified', column: 'd.verified_at', type: 'date' },
      created_at: { label: 'Uploaded', column: 'd.created_at', type: 'date' },
    },
  },
  invoices: {
    label: 'Invoices',
    table: 'invoices',
    alias: 'i',
    joins: 'LEFT JOIN clients c ON c.id = i.client_id',
    where: '1 = 1',
    fields: {
      invoice_no: { label: 'Invoice', column: 'i.invoice_no', type: 'text' },
      client_name: { label: 'Client', column: 'c.display_name', type: 'text' },
      status: { label: 'Status', column: 'i.status', type: 'enum' },
      total_paise: { label: 'Total', column: 'i.total_paise', type: 'money' },
      amount_paid_paise: { label: 'Paid', column: 'i.amount_paid_paise', type: 'money' },
      amount_due_paise: { label: 'Outstanding', column: 'i.amount_due_paise', type: 'money' },
      issue_date: { label: 'Issued', column: 'i.issue_date', type: 'date' },
      due_date: { label: 'Due', column: 'i.due_date', type: 'date' },
    },
  },
  tax: {
    label: 'Tax computations',
    table: 'tax_computations',
    alias: 't',
    joins: 'LEFT JOIN clients c ON c.id = t.client_id',
    where: '1 = 1',
    fields: {
      client_name: { label: 'Client', column: 'c.display_name', type: 'text' },
      period_key: { label: 'Period', column: 't.period_key', type: 'text' },
      status: { label: 'Status', column: 't.status', type: 'enum' },
      taxable_value_paise: { label: 'Taxable value', column: 't.taxable_value_paise', type: 'money' },
      total_tax_paise: { label: 'Total tax', column: 't.total_tax_paise', type: 'money' },
      itc_total_paise: { label: 'ITC', column: 't.itc_total_paise', type: 'money' },
      net_payable_paise: { label: 'Net payable', column: 't.net_payable_paise', type: 'money' },
    },
  },
  calls: {
    label: 'Calls',
    table: 'call_records',
    alias: 'cr',
    joins: `LEFT JOIN clients c ON c.id = cr.client_id
            LEFT JOIN users u ON u.id = cr.agent_id`,
    where: '1 = 1',
    fields: {
      agent_name: { label: 'Agent', column: 'u.full_name', type: 'text' },
      client_name: { label: 'Client', column: 'c.display_name', type: 'text' },
      direction: { label: 'Direction', column: 'cr.direction', type: 'enum' },
      status: { label: 'Status', column: 'cr.status', type: 'enum' },
      duration_seconds: { label: 'Duration (s)', column: 'cr.duration_seconds', type: 'number' },
      disposition_key: { label: 'Disposition', column: 'cr.disposition_key', type: 'enum' },
      created_at: { label: 'When', column: 'cr.created_at', type: 'date' },
    },
  },
  leads: {
    label: 'Leads',
    table: 'leads',
    alias: 'l',
    joins: 'LEFT JOIN users u ON u.id = l.assigned_to',
    where: '1 = 1',
    fields: {
      full_name: { label: 'Lead', column: 'l.full_name', type: 'text' },
      company_name: { label: 'Company', column: 'l.company_name', type: 'text' },
      source: { label: 'Source', column: 'l.source', type: 'enum' },
      status: { label: 'Status', column: 'l.status', type: 'enum' },
      score: { label: 'Score', column: 'l.score', type: 'number' },
      owner_name: { label: 'Owner', column: 'u.full_name', type: 'text' },
      created_at: { label: 'Captured', column: 'l.created_at', type: 'date' },
    },
  },
};

const OPERATORS = {
  eq: { label: 'is', sql: '= ?' },
  ne: { label: 'is not', sql: '!= ?' },
  gt: { label: 'is more than', sql: '> ?' },
  lt: { label: 'is less than', sql: '< ?' },
  gte: { label: 'is at least', sql: '>= ?' },
  lte: { label: 'is at most', sql: '<= ?' },
  contains: { label: 'contains', sql: 'LIKE ?', wrap: (v) => `%${v}%` },
  starts: { label: 'starts with', sql: 'LIKE ?', wrap: (v) => `${v}%` },
  is_null: { label: 'is empty', sql: 'IS NULL', noValue: true },
  not_null: { label: 'is not empty', sql: 'IS NOT NULL', noValue: true },
};

const AGGREGATES = {
  count: { label: 'Count', sql: (col) => `COUNT(${col})` },
  sum: { label: 'Sum', sql: (col) => `SUM(${col})` },
  avg: { label: 'Average', sql: (col) => `AVG(${col})` },
  min: { label: 'Minimum', sql: (col) => `MIN(${col})` },
  max: { label: 'Maximum', sql: (col) => `MAX(${col})` },
};

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
router.get('/datasets', async (ctx) => ok({
  datasets: Object.entries(DATASETS).map(([key, def]) => ({
    key,
    label: def.label,
    fields: Object.entries(def.fields).map(([fieldKey, f]) => ({
      key: fieldKey, label: f.label, type: f.type,
    })),
  })),
  operators: Object.entries(OPERATORS).map(([key, o]) => ({
    key, label: o.label, needsValue: !o.noValue,
  })),
  aggregates: Object.entries(AGGREGATES).map(([key, a]) => ({ key, label: a.label })),
  reportTypes: REPORT_TYPES,
}, { ctx }), { permission: 'analytics.view' });

// ---------------------------------------------------------------------------
// Run a query
// ---------------------------------------------------------------------------
router.post('/query', async (ctx) => {
  await assertFeature(ctx, 'advanced_reports');
  const body = await ctx.body();
  const input = validate(body, {
    dataset: { type: 'string', required: true, max: 40 },
    fields: { type: 'array', required: true, max: 20, of: { type: 'string', max: 40 } },
    filters: { type: 'array', max: 20 },
    groupBy: { type: 'string', max: 40 },
    aggregate: { type: 'json' },
    orderBy: { type: 'string', max: 40 },
    orderDir: { type: 'enum', values: ['asc', 'desc'], default: 'desc' },
    limit: { type: 'int', min: 1, max: 5000, default: 500 },
    format: { type: 'enum', values: ['json', 'csv'], default: 'json' },
  });

  const built = buildQuery(ctx, input);
  const rows = await new Db(ctx.env.DB).many(built.sql, built.params);

  if (input.format === 'csv') {
    const header = built.columns.map(c => c.label);
    const lines = [header.map(escapeCsv).join(',')];
    for (const row of rows) {
      lines.push(built.columns.map(c => escapeCsv(formatValue(row[c.key], c.type))).join(','));
    }
    await audit(ctx, {
      action: 'data.exported', category: 'data',
      entityType: 'analytics_query', entityId: input.dataset,
      newValue: { dataset: input.dataset, rows: rows.length, fields: input.fields },
    });
    return fileResponse('﻿' + lines.join('\r\n'), {
      contentType: 'text/csv; charset=utf-8',
      fileName: `${input.dataset}-${dayKey()}.csv`,
      download: true,
    });
  }

  return ok({
    dataset: input.dataset,
    columns: built.columns,
    rows: rows.map(row => {
      const out = {};
      for (const c of built.columns) {
        out[c.key] = row[c.key];
        if (c.type === 'money') out[`${c.key}_label`] = formatINR(row[c.key] ?? 0);
      }
      return out;
    }),
    rowCount: rows.length,
    truncated: rows.length >= input.limit,
    // Returned so a user can see exactly what was asked of the database.
    explain: built.explain,
  }, { ctx });
}, { permission: 'analytics.build' });

// ---------------------------------------------------------------------------
// Saved dashboards
// ---------------------------------------------------------------------------
router.get('/dashboards', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.raw(
    `SELECT d.*, u.full_name AS owner_name FROM custom_dashboards d
       LEFT JOIN users u ON u.id = d.user_id
      WHERE d.tenant_id = ? AND (d.user_id = ? OR d.is_shared = 1)
      ORDER BY d.name`, [ctx.tenantId, ctx.userId]);

  return ok({
    dashboards: rows.map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      widgets: safeJson(d.widgets_json, []),
      isShared: !!d.is_shared,
      isMine: d.user_id === ctx.userId,
      ownerName: d.owner_name,
      updatedAt: d.updated_at,
    })),
  }, { ctx });
}, { permission: 'analytics.view' });

router.post('/dashboards', async (ctx) => {
  await assertFeature(ctx, 'advanced_reports');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    description: { type: 'text', max: 500 },
    widgets: { type: 'array', required: true, max: 20 },
    isShared: { type: 'boolean', default: false },
  });

  // Each widget carries a query, and each query is validated now rather than
  // when somebody opens the dashboard and gets an error instead of a chart.
  for (const [i, widget] of input.widgets.entries()) {
    if (!widget?.query) continue;
    try {
      buildQuery(ctx, widget.query);
    } catch (err) {
      throw new BadRequestError(`Widget ${i + 1} ("${widget.title ?? 'untitled'}") is not valid: ${err.message}`);
    }
  }

  const dashboard = await scope.insert('custom_dashboards', {
    id: ID.dashboard(),
    user_id: ctx.userId,
    name: input.name,
    description: input.description ?? null,
    widgets_json: JSON.stringify(input.widgets),
    is_shared: input.isShared ? 1 : 0,
  });

  return created({ dashboard: { id: dashboard.id, name: dashboard.name } }, { ctx });
}, { permission: 'analytics.build' });

router.delete('/dashboards/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const dashboard = await scope.getOrFail('custom_dashboards', ctx.params.id, { resource: 'Dashboard' });
  if (dashboard.user_id !== ctx.userId && !ctx.has('settings.manage')) {
    throw new NotFoundError('Dashboard');
  }
  await scope.delete('custom_dashboards', dashboard.id);
  return ok({ id: dashboard.id, removed: true }, { ctx });
}, { permission: 'analytics.build' });

// ---------------------------------------------------------------------------
// Scheduled exports
// ---------------------------------------------------------------------------
router.get('/schedules', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.all('scheduled_reports', {}, { limit: 50 });
  return ok({
    schedules: rows.map(s => ({
      id: s.id,
      name: s.name,
      reportType: s.report_type,
      format: s.format,
      frequency: s.frequency,
      dayOfWeek: s.day_of_week,
      dayOfMonth: s.day_of_month,
      hourUtc: s.hour_utc,
      recipients: safeJson(s.recipients_json, []),
      isActive: !!s.is_active,
      lastRunAt: s.last_run_at,
      lastRunStatus: s.last_run_status,
      nextRunAt: s.next_run_at,
      runCount: s.run_count,
    })),
    reportTypes: REPORT_TYPES,
  }, { ctx });
}, { permission: 'reports.schedule' });

router.post('/schedules', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    reportType: { type: 'string', required: true, max: 40 },
    filters: { type: 'json' },
    format: { type: 'enum', values: ['csv', 'pdf'], default: 'pdf' },
    frequency: { type: 'enum', required: true, values: ['daily', 'weekly', 'monthly'] },
    dayOfWeek: { type: 'int', min: 0, max: 6 },
    dayOfMonth: { type: 'int', min: 1, max: 28 },
    hourUtc: { type: 'int', min: 0, max: 23, default: 3 },
    recipients: { type: 'array', required: true, max: 20, of: { type: 'email' } },
  });

  if (!REPORT_TYPES.some(t => t.key === input.reportType)) {
    throw new BadRequestError(`Unknown report type: ${input.reportType}.`);
  }
  if (input.frequency === 'weekly' && (input.dayOfWeek === null || input.dayOfWeek === undefined)) {
    throw new BadRequestError('A weekly schedule needs a day of the week.');
  }
  if (input.frequency === 'monthly' && !input.dayOfMonth) {
    throw new BadRequestError('A monthly schedule needs a day of the month (1–28).');
  }
  if (!input.recipients.length) throw new BadRequestError('Add at least one recipient.');

  const schedule = await scope.insert('scheduled_reports', {
    id: ID.schedule(),
    name: input.name,
    report_type: input.reportType,
    filters_json: JSON.stringify(input.filters ?? {}),
    format: input.format,
    frequency: input.frequency,
    day_of_week: input.dayOfWeek ?? null,
    day_of_month: input.dayOfMonth ?? null,
    hour_utc: input.hourUtc,
    recipients_json: JSON.stringify(input.recipients),
    is_active: 1,
    run_count: 0,
    next_run_at: nextRunAt(input),
    created_by: ctx.userId,
  });

  await audit(ctx, {
    action: 'reports.scheduled', category: 'reports',
    entityType: 'scheduled_report', entityId: schedule.id, entityLabel: input.name,
    newValue: { reportType: input.reportType, frequency: input.frequency, recipients: input.recipients.length },
  });

  return created({ schedule }, { ctx });
}, { permission: 'reports.schedule' });

router.delete('/schedules/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const schedule = await scope.getOrFail('scheduled_reports', ctx.params.id, { resource: 'Schedule' });
  await scope.delete('scheduled_reports', schedule.id);
  return ok({ id: schedule.id, removed: true }, { ctx });
}, { permission: 'reports.schedule' });

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------
router.get('/trends', async (ctx) => {
  const scope = scopeFor(ctx);
  const months = recentMonthKeys(Math.min(ctx.qInt('months', 6), 24));

  const series = [];
  for (const m of months) {
    const b = periodBounds('monthly', m);
    const row = await scope.rawOne(
      `SELECT
         (SELECT COUNT(*) FROM documents WHERE tenant_id = ? AND deleted_at IS NULL
            AND created_at BETWEEN ? AND ?) AS documents,
         (SELECT COUNT(*) FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
            AND created_at BETWEEN ? AND ?) AS new_clients,
         (SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE tenant_id = ?
            AND status = 'success' AND created_at BETWEEN ? AND ?) AS collected,
         (SELECT COUNT(*) FROM reports WHERE tenant_id = ? AND created_at BETWEEN ? AND ?) AS reports`,
      [ctx.tenantId, b.start, b.end, ctx.tenantId, b.start, b.end,
        ctx.tenantId, b.start, b.end, ctx.tenantId, b.start, b.end]);

    series.push({
      periodKey: m,
      documents: Number(row?.documents) || 0,
      newClients: Number(row?.new_clients) || 0,
      collectedPaise: Number(row?.collected) || 0,
      reports: Number(row?.reports) || 0,
    });
  }

  return ok({
    months,
    series,
    // Simple period-on-period change, stated as such — not a projection.
    change: changeSummary(series),
  }, { ctx });
}, { permission: 'analytics.view' });

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Turn a validated request into SQL.
 *
 * Every identifier comes from the catalogue above; nothing from the request
 * reaches the SQL string. Values are always bound. The tenant filter is added
 * last and unconditionally, so no combination of inputs can remove it.
 */
function buildQuery(ctx, input) {
  const dataset = DATASETS[input.dataset];
  if (!dataset) {
    throw new BadRequestError(`Unknown dataset "${input.dataset}". Available: ${Object.keys(DATASETS).join(', ')}.`);
  }

  const fields = (input.fields ?? []).map((key) => {
    const field = dataset.fields[key];
    if (!field) {
      throw new BadRequestError(
        `"${key}" is not a field on ${dataset.label}. Available: ${Object.keys(dataset.fields).join(', ')}.`);
    }
    return { key, ...field };
  });
  if (!fields.length) throw new BadRequestError('Choose at least one field.');

  const params = [];
  const conditions = [`${dataset.alias}.tenant_id = ?`];
  params.push(ctx.tenantId);
  if (dataset.where) conditions.push(dataset.where);

  for (const filter of input.filters ?? []) {
    const field = dataset.fields[filter?.field];
    const operator = OPERATORS[filter?.operator];
    if (!field) throw new BadRequestError(`Cannot filter on "${filter?.field}".`);
    if (!operator) {
      throw new BadRequestError(`Unknown operator "${filter?.operator}". Available: ${Object.keys(OPERATORS).join(', ')}.`);
    }
    conditions.push(`${field.column} ${operator.sql}`);
    if (!operator.noValue) {
      params.push(operator.wrap ? operator.wrap(filter.value) : filter.value);
    }
  }

  let select;
  let groupBy = '';
  let columns;

  if (input.groupBy) {
    const groupField = dataset.fields[input.groupBy];
    if (!groupField) throw new BadRequestError(`Cannot group by "${input.groupBy}".`);

    const aggKey = input.aggregate?.function ?? 'count';
    const aggregate = AGGREGATES[aggKey];
    if (!aggregate) throw new BadRequestError(`Unknown aggregate "${aggKey}".`);

    const aggField = input.aggregate?.field ? dataset.fields[input.aggregate.field] : null;
    if (input.aggregate?.field && !aggField) {
      throw new BadRequestError(`Cannot aggregate "${input.aggregate.field}".`);
    }

    select = `${groupField.column} AS ${input.groupBy}, ${aggregate.sql(aggField?.column ?? '*')} AS value`;
    groupBy = `GROUP BY ${groupField.column}`;
    columns = [
      { key: input.groupBy, label: groupField.label, type: groupField.type },
      {
        key: 'value',
        label: `${aggregate.label}${aggField ? ` of ${aggField.label}` : ''}`,
        type: aggField?.type === 'money' && aggKey !== 'count' ? 'money' : 'number',
      },
    ];
  } else {
    select = fields.map(f => `${f.column} AS ${f.key}`).join(', ');
    columns = fields.map(f => ({ key: f.key, label: f.label, type: f.type }));
  }

  let orderClause = '';
  if (input.orderBy) {
    const orderField = input.groupBy
      ? (input.orderBy === 'value' ? { column: 'value' } : dataset.fields[input.orderBy])
      : dataset.fields[input.orderBy];
    if (!orderField) throw new BadRequestError(`Cannot sort by "${input.orderBy}".`);
    orderClause = `ORDER BY ${orderField.column} ${input.orderDir === 'asc' ? 'ASC' : 'DESC'}`;
  } else if (input.groupBy) {
    orderClause = 'ORDER BY value DESC';
  }

  const limit = Math.min(input.limit ?? 500, 5000);
  const sql = `SELECT ${select}
       FROM ${dataset.table} ${dataset.alias}
       ${dataset.joins ?? ''}
      WHERE ${conditions.join(' AND ')}
      ${groupBy} ${orderClause} LIMIT ${limit}`;

  return {
    sql,
    params,
    columns,
    explain: {
      dataset: dataset.label,
      fields: columns.map(c => c.label),
      filterCount: (input.filters ?? []).length,
      groupedBy: input.groupBy ? dataset.fields[input.groupBy].label : null,
      limit,
      // Stated so a reader can see the scoping is not optional.
      scopedTo: 'your organisation only',
    },
  };
}

function nextRunAt(input) {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), input.hourUtc, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  if (input.frequency === 'weekly') {
    while (next.getUTCDay() !== input.dayOfWeek) next.setUTCDate(next.getUTCDate() + 1);
  }
  if (input.frequency === 'monthly') {
    while (next.getUTCDate() !== input.dayOfMonth) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

function changeSummary(series) {
  if (series.length < 2) return null;
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  return {
    comparing: { from: previous.periodKey, to: current.periodKey },
    documentsPct: pct(current.documents, previous.documents),
    newClientsPct: pct(current.newClients, previous.newClients),
    collectedPct: pct(current.collectedPaise, previous.collectedPaise),
  };
}

function formatValue(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'money') return formatINR(value);
  return value;
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as analyticsRouter, DATASETS };
