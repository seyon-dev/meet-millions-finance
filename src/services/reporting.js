/**
 * Report generation and export.
 *
 * Every report type named in the proposal is built here from stored data —
 * GST summary, monthly tax, quarterly, yearly, TDS, revenue, expenses,
 * outstanding payments, client reports, audit reports and team performance.
 *
 * A report is a snapshot: its totals and rows are serialised into the row at
 * generation time, so a report approved in August still shows August's figures
 * even if a record is later corrected. Exports (CSV and PDF) render that
 * snapshot, never a fresh query.
 */

import { ID, formatReference } from '../utils/id.js';
import { nowIso, periodBounds, monthKey, quarterKey, financialYearKey, recentMonthKeys, dayKey } from '../utils/time.js';
import { formatINR, formatINRCompact, toRupees } from '../utils/money.js';
import { escapeCsv } from '../utils/validate.js';
import { PdfDocument } from './pdf.js';
import { summariseGst, summariseTds, periodTotals } from './tax-engine.js';
import { BadRequestError, NotFoundError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { TenantScope } from '../db/tenancy.js';

export const REPORT_TYPES = [
  { key: 'gst_summary',          name: 'GST Summary',          scope: 'client', needs: ['tax.view'] },
  { key: 'monthly_tax',          name: 'Monthly Tax',          scope: 'client', needs: ['tax.view'] },
  { key: 'quarterly',            name: 'Quarterly',            scope: 'client', needs: ['tax.view'] },
  { key: 'yearly',               name: 'Yearly',               scope: 'client', needs: ['tax.view'] },
  { key: 'tds_summary',          name: 'TDS Summary',          scope: 'client', needs: ['tax.view'] },
  { key: 'revenue',              name: 'Revenue',              scope: 'tenant', needs: ['billing.view'] },
  { key: 'expenses',             name: 'Expenses',             scope: 'client', needs: ['tax.view'] },
  { key: 'outstanding_payments', name: 'Outstanding Payments', scope: 'tenant', needs: ['payments.view'] },
  { key: 'client_report',        name: 'Client Report',        scope: 'client', needs: ['clients.view'] },
  { key: 'audit_report',         name: 'Audit Report',         scope: 'tenant', needs: ['audit.view'] },
  { key: 'team_performance',     name: 'Team Performance',     scope: 'tenant', needs: ['analytics.view'] },
  { key: 'call_report',          name: 'Call Report',          scope: 'tenant', needs: ['calls.analytics'] },
  { key: 'analytics',            name: 'Analytics',            scope: 'tenant', needs: ['analytics.view'] },
];

export const REPORT_TYPE_MAP = new Map(REPORT_TYPES.map(t => [t.key, t]));

/** Sequential per-tenant reference, e.g. RPT-2026-000012. */
export async function nextReportReference(scope) {
  const year = new Date().getUTCFullYear();
  const count = await scope.rawCount(
    'SELECT COUNT(*) FROM reports WHERE tenant_id = ? AND reference_no LIKE ?',
    [scope.tenantId, `RPT-${year}-%`]);
  return formatReference('RPT', year, count + 1);
}

/**
 * Build and persist a report.
 * @returns {{report, sections}} the stored row plus the rendered sections
 */
export async function generateReport(ctx, scope, {
  type, clientId = null, filingPeriodId = null, periodType = 'monthly', periodKey = monthKey(),
  from = null, to = null, title = null, filters = {},
}) {
  const definition = REPORT_TYPE_MAP.get(type);
  if (!definition) throw new BadRequestError(`Unknown report type: ${type}`);
  if (definition.scope === 'client' && !clientId) {
    throw new BadRequestError(`A ${definition.name} report needs a client.`);
  }

  const builder = BUILDERS[type];
  const built = await builder(scope, {
    clientId, filingPeriodId, periodType, periodKey, from, to, filters, ctx,
  });

  const referenceNo = await nextReportReference(scope);
  const bounds = from && to ? { start: from, end: to } : periodBounds(periodType, periodKey);

  const report = await scope.insert('reports', {
    id: ID.report(),
    company_id: built.companyId ?? null,
    client_id: clientId,
    filing_period_id: filingPeriodId,
    computation_id: built.computationId ?? null,
    reference_no: referenceNo,
    type,
    title: title || built.title || `${definition.name} — ${periodKey}`,
    period_type: periodType,
    period_key: periodKey,
    period_start: bounds.start,
    period_end: bounds.end,
    status: 'draft',
    totals_json: JSON.stringify(built.totals ?? {}),
    payload_json: JSON.stringify({ sections: built.sections ?? [], meta: built.meta ?? {} }),
    filters_json: JSON.stringify(filters),
    narrative: built.narrative ?? null,
    ai_generated: 0,
    generated_by: ctx.userId,
    generated_at: nowIso(),
  });

  // Persist the headline figures as queryable rows, for cross-report analytics.
  for (const [index, item] of (built.items ?? []).entries()) {
    await scope.insert('report_items', {
      id: ID.reportItem(),
      report_id: report.id,
      section: item.section,
      label: item.label,
      value_paise: item.valuePaise ?? null,
      value_text: item.valueText ?? null,
      value_number: item.valueNumber ?? null,
      unit: item.unit ?? null,
      sort_order: index * 10,
      meta_json: item.meta ? JSON.stringify(item.meta) : null,
    });
  }

  return { report, sections: built.sections ?? [], totals: built.totals ?? {} };
}

// ---------------------------------------------------------------------------
// Builders — one per report type
// ---------------------------------------------------------------------------

const BUILDERS = {
  async gst_summary(scope, { clientId, filingPeriodId, periodType, periodKey }) {
    const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
    const company = await scope.first('companies', { id: client.company_id });

    const computation = await scope.rawOne(
      `SELECT * FROM tax_computations
        WHERE tenant_id = ? AND client_id = ? AND regime = 'gst'
          AND ${filingPeriodId ? 'filing_period_id = ?' : 'period_key = ?'}
          AND status != 'superseded' ORDER BY created_at DESC LIMIT 1`,
      [scope.tenantId, clientId, filingPeriodId ?? periodKey]);

    if (!computation) {
      throw new NotFoundError('Computation',
        `No GST computation exists for ${periodKey}. Run the calculation first.`);
    }

    const lines = await scope.raw(
      `SELECT * FROM gst_records WHERE tenant_id = ? AND computation_id = ?
        ORDER BY direction, invoice_date`, [scope.tenantId, computation.id]);
    const summary = summariseGst(lines);

    const outward = lines.filter(l => l.direction === 'outward');
    const inward = lines.filter(l => l.direction === 'inward');

    return {
      title: `GST Summary — ${periodKey}`,
      companyId: company?.id,
      computationId: computation.id,
      totals: {
        taxableValuePaise: summary.taxableValuePaise,
        cgstPaise: summary.cgstPaise,
        sgstPaise: summary.sgstPaise,
        igstPaise: summary.igstPaise,
        cessPaise: summary.cessPaise,
        totalTaxPaise: summary.totalTaxPaise,
        itcTotalPaise: summary.itcTotalPaise,
        netPayablePaise: summary.netPayablePaise,
        creditCarriedForwardPaise: summary.creditCarriedForwardPaise,
      },
      meta: {
        client: client.display_name,
        gstin: company?.gstin ?? null,
        stateCode: company?.state_code ?? null,
        sourceDocumentCount: computation.source_document_count,
        engineVersion: computation.engine_version,
        computedAt: computation.computed_at,
        warnings: safeJson(computation.warnings_json, []),
      },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Total taxable value', value: formatINR(summary.taxableValuePaise) },
            { label: 'CGST', value: formatINR(summary.cgstPaise) },
            { label: 'SGST', value: formatINR(summary.sgstPaise) },
            { label: 'IGST', value: formatINR(summary.igstPaise) },
            { label: 'Net payable', value: formatINR(summary.netPayablePaise), highlight: true },
          ],
        },
        {
          key: 'rate_wise', title: 'Rate-wise breakdown', kind: 'table',
          columns: [
            { label: 'Rate', key: 'rate', width: 0.16 },
            { label: 'Invoices', key: 'count', width: 0.16, align: 'right' },
            { label: 'Taxable value', key: 'taxable', width: 0.24, align: 'right' },
            { label: 'CGST', key: 'cgst', width: 0.15, align: 'right' },
            { label: 'SGST', key: 'sgst', width: 0.15, align: 'right' },
            { label: 'IGST', key: 'igst', width: 0.14, align: 'right' },
          ],
          rows: summary.byRate.map(g => ({
            rate: `${g.ratePct}%`,
            count: String(g.count),
            taxable: formatINR(g.taxableValuePaise),
            cgst: formatINR(g.cgstPaise),
            sgst: formatINR(g.sgstPaise),
            igst: formatINR(g.igstPaise),
          })),
        },
        {
          key: 'outward', title: `Outward supplies (${outward.length})`, kind: 'table',
          columns: [
            { label: 'Invoice', key: 'invoice', width: 0.18 },
            { label: 'Date', key: 'date', width: 0.13 },
            { label: 'Counterparty', key: 'party', width: 0.27 },
            { label: 'Supply', key: 'supply', width: 0.12 },
            { label: 'Taxable', key: 'taxable', width: 0.15, align: 'right' },
            { label: 'Tax', key: 'tax', width: 0.15, align: 'right' },
          ],
          rows: outward.map(l => ({
            invoice: l.invoice_no ?? '—',
            date: l.invoice_date ? l.invoice_date.slice(0, 10) : '—',
            party: l.counterparty_name ?? l.counterparty_gstin ?? '—',
            supply: l.supply_type,
            taxable: formatINR(l.taxable_value_paise),
            tax: formatINR((l.cgst_paise ?? 0) + (l.sgst_paise ?? 0) + (l.igst_paise ?? 0) + (l.cess_paise ?? 0)),
          })),
        },
        {
          key: 'inward', title: `Inward supplies / input credit (${inward.length})`, kind: 'table',
          columns: [
            { label: 'Invoice', key: 'invoice', width: 0.18 },
            { label: 'Date', key: 'date', width: 0.13 },
            { label: 'Supplier', key: 'party', width: 0.27 },
            { label: 'ITC', key: 'eligible', width: 0.12 },
            { label: 'Taxable', key: 'taxable', width: 0.15, align: 'right' },
            { label: 'Credit', key: 'tax', width: 0.15, align: 'right' },
          ],
          rows: inward.map(l => ({
            invoice: l.invoice_no ?? '—',
            date: l.invoice_date ? l.invoice_date.slice(0, 10) : '—',
            party: l.counterparty_name ?? l.counterparty_gstin ?? '—',
            eligible: l.itc_eligible ? 'Eligible' : 'Blocked',
            taxable: formatINR(l.taxable_value_paise),
            tax: formatINR((l.cgst_paise ?? 0) + (l.sgst_paise ?? 0) + (l.igst_paise ?? 0)),
          })),
        },
        {
          key: 'totals', title: 'Tax position', kind: 'totals',
          rows: [
            ['Total output tax', formatINR(summary.totalTaxPaise)],
            ['Input tax credit', formatINR(summary.itcTotalPaise)],
            ['Net payable', formatINR(summary.netPayablePaise), true],
            ...(summary.creditCarriedForwardPaise > 0
              ? [['Credit carried forward', formatINR(summary.creditCarriedForwardPaise)]] : []),
          ],
        },
      ],
      items: [
        { section: 'summary', label: 'Taxable value', valuePaise: summary.taxableValuePaise },
        { section: 'summary', label: 'CGST', valuePaise: summary.cgstPaise },
        { section: 'summary', label: 'SGST', valuePaise: summary.sgstPaise },
        { section: 'summary', label: 'IGST', valuePaise: summary.igstPaise },
        { section: 'summary', label: 'Cess', valuePaise: summary.cessPaise },
        { section: 'summary', label: 'Input tax credit', valuePaise: summary.itcTotalPaise },
        { section: 'summary', label: 'Net payable', valuePaise: summary.netPayablePaise },
      ],
    };
  },

  async monthly_tax(scope, args) { return BUILDERS.gst_summary(scope, { ...args, periodType: 'monthly' }); },

  async quarterly(scope, { clientId, periodKey, ...rest }) {
    const key = periodKey.includes('Q') ? periodKey : quarterKey();
    return periodRollup(scope, { clientId, periodType: 'quarterly', periodKey: key, label: 'Quarterly', ...rest });
  },

  async yearly(scope, { clientId, periodKey, ...rest }) {
    const key = /^\d{4}-\d{2}$/.test(periodKey) && !periodKey.includes('Q')
      ? financialYearKey() : (periodKey || financialYearKey());
    return periodRollup(scope, { clientId, periodType: 'yearly', periodKey: key, label: 'Yearly', ...rest });
  },

  async tds_summary(scope, { clientId, filingPeriodId, periodKey }) {
    const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
    const computation = await scope.rawOne(
      `SELECT * FROM tax_computations
        WHERE tenant_id = ? AND client_id = ? AND regime = 'tds'
          AND ${filingPeriodId ? 'filing_period_id = ?' : 'period_key = ?'}
          AND status != 'superseded' ORDER BY created_at DESC LIMIT 1`,
      [scope.tenantId, clientId, filingPeriodId ?? periodKey]);

    if (!computation) {
      throw new NotFoundError('Computation',
        `No TDS computation exists for ${periodKey}. Run the calculation first.`);
    }

    const lines = await scope.raw(
      'SELECT * FROM tds_records WHERE tenant_id = ? AND computation_id = ? ORDER BY payment_date',
      [scope.tenantId, computation.id]);
    const summary = summariseTds(lines);

    return {
      title: `TDS Summary — ${periodKey}`,
      companyId: client.company_id,
      computationId: computation.id,
      totals: {
        basePaise: summary.basePaise,
        deductedPaise: summary.deductedPaise,
        depositedPaise: summary.depositedPaise,
        outstandingPaise: summary.outstandingPaise,
      },
      meta: { client: client.display_name, deducteeCount: summary.deducteeCount },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Payments', value: formatINR(summary.basePaise) },
            { label: 'TDS deducted', value: formatINR(summary.deductedPaise) },
            { label: 'Deposited', value: formatINR(summary.depositedPaise) },
            { label: 'Outstanding', value: formatINR(summary.outstandingPaise), highlight: summary.outstandingPaise > 0 },
          ],
        },
        {
          key: 'sections', title: 'Section-wise', kind: 'table',
          columns: [
            { label: 'Section', key: 'section', width: 0.18 },
            { label: 'Deductions', key: 'count', width: 0.16, align: 'right' },
            { label: 'Payments', key: 'base', width: 0.22, align: 'right' },
            { label: 'Deducted', key: 'deducted', width: 0.22, align: 'right' },
            { label: 'Deposited', key: 'deposited', width: 0.22, align: 'right' },
          ],
          rows: summary.bySection.map(s => ({
            section: s.sectionCode,
            count: String(s.count),
            base: formatINR(s.basePaise),
            deducted: formatINR(s.deductedPaise),
            deposited: formatINR(s.depositedPaise),
          })),
        },
        {
          key: 'deductions', title: `Deductions (${lines.length})`, kind: 'table',
          columns: [
            { label: 'Deductee', key: 'name', width: 0.26 },
            { label: 'PAN', key: 'pan', width: 0.16 },
            { label: 'Section', key: 'section', width: 0.12 },
            { label: 'Date', key: 'date', width: 0.13 },
            { label: 'Amount', key: 'amount', width: 0.16, align: 'right' },
            { label: 'TDS', key: 'tds', width: 0.17, align: 'right' },
          ],
          rows: lines.map(l => ({
            name: l.deductee_name ?? '—',
            pan: l.deductee_pan ?? 'Not on file',
            section: l.section_code,
            date: l.payment_date ? l.payment_date.slice(0, 10) : '—',
            amount: formatINR(l.amount_paise),
            tds: `${formatINR(l.tds_paise)} (${l.rate_pct}%)`,
          })),
        },
      ],
      items: [
        { section: 'summary', label: 'Payments', valuePaise: summary.basePaise },
        { section: 'summary', label: 'TDS deducted', valuePaise: summary.deductedPaise },
        { section: 'summary', label: 'Deposited', valuePaise: summary.depositedPaise },
        { section: 'summary', label: 'Outstanding', valuePaise: summary.outstandingPaise },
      ],
    };
  },

  async revenue(scope, { periodKey, from, to }) {
    const bounds = from && to ? { start: from, end: to } : periodBounds('monthly', periodKey);

    const invoices = await scope.raw(
      `SELECT i.*, c.display_name AS client_name FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.tenant_id = ? AND i.direction = 'tenant_to_client'
          AND i.issue_date >= ? AND i.issue_date <= ? AND i.status != 'void'
        ORDER BY i.issue_date DESC`, [scope.tenantId, bounds.start, bounds.end]);

    const billed = invoices.reduce((s, i) => s + (i.total_paise ?? 0), 0);
    const collected = invoices.reduce((s, i) => s + (i.amount_paid_paise ?? 0), 0);
    const outstanding = invoices.reduce((s, i) => s + (i.amount_due_paise ?? 0), 0);

    const months = recentMonthKeys(6, new Date(bounds.end));
    const trend = [];
    for (const m of months) {
      const b = periodBounds('monthly', m);
      const row = await scope.rawOne(
        `SELECT COALESCE(SUM(total_paise),0) AS billed, COALESCE(SUM(amount_paid_paise),0) AS collected
           FROM invoices WHERE tenant_id = ? AND direction = 'tenant_to_client'
             AND issue_date >= ? AND issue_date <= ? AND status != 'void'`,
        [scope.tenantId, b.start, b.end]);
      trend.push({
        periodKey: m,
        billedPaise: Number(row?.billed) || 0,
        collectedPaise: Number(row?.collected) || 0,
      });
    }

    return {
      title: `Revenue — ${periodKey}`,
      totals: { billedPaise: billed, collectedPaise: collected, outstandingPaise: outstanding, invoiceCount: invoices.length },
      meta: { trend },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Billed', value: formatINR(billed) },
            { label: 'Collected', value: formatINR(collected), highlight: true },
            { label: 'Outstanding', value: formatINR(outstanding) },
            { label: 'Invoices', value: String(invoices.length) },
          ],
        },
        {
          key: 'trend', title: 'Six-month trend', kind: 'chart',
          chart: { type: 'bar', series: trend.map(t => ({ label: t.periodKey, value: toRupees(t.billedPaise) })) },
          columns: [
            { label: 'Period', key: 'period', width: 0.34 },
            { label: 'Billed', key: 'billed', width: 0.33, align: 'right' },
            { label: 'Collected', key: 'collected', width: 0.33, align: 'right' },
          ],
          rows: trend.map(t => ({
            period: t.periodKey, billed: formatINR(t.billedPaise), collected: formatINR(t.collectedPaise),
          })),
        },
        {
          key: 'invoices', title: `Invoices (${invoices.length})`, kind: 'table',
          columns: [
            { label: 'Invoice', key: 'no', width: 0.18 },
            { label: 'Client', key: 'client', width: 0.28 },
            { label: 'Issued', key: 'issued', width: 0.14 },
            { label: 'Status', key: 'status', width: 0.14 },
            { label: 'Total', key: 'total', width: 0.13, align: 'right' },
            { label: 'Paid', key: 'paid', width: 0.13, align: 'right' },
          ],
          rows: invoices.map(i => ({
            no: i.invoice_no, client: i.client_name ?? i.billing_name ?? '—',
            issued: i.issue_date.slice(0, 10), status: i.status,
            total: formatINR(i.total_paise), paid: formatINR(i.amount_paid_paise),
          })),
        },
      ],
      items: [
        { section: 'summary', label: 'Billed', valuePaise: billed },
        { section: 'summary', label: 'Collected', valuePaise: collected },
        { section: 'summary', label: 'Outstanding', valuePaise: outstanding },
      ],
    };
  },

  async expenses(scope, { clientId, periodKey }) {
    const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
    const rows = await scope.raw(
      `SELECT g.*, d.title AS document_title FROM gst_records g
         LEFT JOIN documents d ON d.id = g.document_id
         JOIN tax_computations tc ON tc.id = g.computation_id
        WHERE g.tenant_id = ? AND g.client_id = ? AND g.direction = 'inward'
          AND tc.period_key = ? ORDER BY g.invoice_date DESC`,
      [scope.tenantId, clientId, periodKey]);

    const total = rows.reduce((s, r) => s + (r.taxable_value_paise ?? 0), 0);
    const tax = rows.reduce((s, r) => s + (r.cgst_paise ?? 0) + (r.sgst_paise ?? 0) + (r.igst_paise ?? 0), 0);

    return {
      title: `Expenses — ${periodKey}`,
      companyId: client.company_id,
      totals: { expensePaise: total, taxPaise: tax, count: rows.length },
      meta: { client: client.display_name },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Total expenses', value: formatINR(total), highlight: true },
            { label: 'Tax component', value: formatINR(tax) },
            { label: 'Entries', value: String(rows.length) },
          ],
        },
        {
          key: 'entries', title: 'Expense entries', kind: 'table',
          columns: [
            { label: 'Date', key: 'date', width: 0.14 },
            { label: 'Supplier', key: 'party', width: 0.28 },
            { label: 'Document', key: 'doc', width: 0.28 },
            { label: 'Taxable', key: 'taxable', width: 0.15, align: 'right' },
            { label: 'Tax', key: 'tax', width: 0.15, align: 'right' },
          ],
          rows: rows.map(r => ({
            date: r.invoice_date ? r.invoice_date.slice(0, 10) : '—',
            party: r.counterparty_name ?? '—',
            doc: r.document_title ?? '—',
            taxable: formatINR(r.taxable_value_paise),
            tax: formatINR((r.cgst_paise ?? 0) + (r.sgst_paise ?? 0) + (r.igst_paise ?? 0)),
          })),
        },
      ],
      items: [{ section: 'summary', label: 'Total expenses', valuePaise: total }],
    };
  },

  async outstanding_payments(scope) {
    const rows = await scope.raw(
      `SELECT i.*, c.display_name AS client_name FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.tenant_id = ? AND i.status IN ('issued','sent','partially_paid','overdue')
        ORDER BY i.due_date ASC`, [scope.tenantId]);

    const total = rows.reduce((s, r) => s + (r.amount_due_paise ?? 0), 0);
    const overdue = rows.filter(r => r.due_date < nowIso());
    const overdueTotal = overdue.reduce((s, r) => s + (r.amount_due_paise ?? 0), 0);

    return {
      title: 'Outstanding Payments',
      totals: { outstandingPaise: total, overduePaise: overdueTotal, count: rows.length, overdueCount: overdue.length },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Total outstanding', value: formatINR(total), highlight: true },
            { label: 'Overdue', value: formatINR(overdueTotal) },
            { label: 'Open invoices', value: String(rows.length) },
            { label: 'Overdue invoices', value: String(overdue.length) },
          ],
        },
        {
          key: 'invoices', title: 'Open invoices', kind: 'table',
          columns: [
            { label: 'Invoice', key: 'no', width: 0.18 },
            { label: 'Client', key: 'client', width: 0.30 },
            { label: 'Due', key: 'due', width: 0.16 },
            { label: 'Status', key: 'status', width: 0.16 },
            { label: 'Amount due', key: 'due_amt', width: 0.20, align: 'right' },
          ],
          rows: rows.map(r => ({
            no: r.invoice_no,
            client: r.client_name ?? r.billing_name ?? '—',
            due: r.due_date.slice(0, 10),
            status: r.due_date < nowIso() ? 'Overdue' : r.status,
            due_amt: formatINR(r.amount_due_paise),
          })),
        },
      ],
      items: [
        { section: 'summary', label: 'Total outstanding', valuePaise: total },
        { section: 'summary', label: 'Overdue', valuePaise: overdueTotal },
      ],
    };
  },

  async client_report(scope, { clientId, periodKey }) {
    const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
    const company = await scope.first('companies', { id: client.company_id });

    const periods = await scope.raw(
      `SELECT * FROM filing_periods WHERE tenant_id = ? AND client_id = ?
        ORDER BY period_key DESC LIMIT 12`, [scope.tenantId, clientId]);
    const documents = await scope.rawOne(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('verified','approved','archived') THEN 1 ELSE 0 END) AS verified
         FROM documents WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL`,
      [scope.tenantId, clientId]);
    const invoices = await scope.rawOne(
      `SELECT COALESCE(SUM(total_paise),0) AS billed, COALESCE(SUM(amount_paid_paise),0) AS paid,
              COALESCE(SUM(amount_due_paise),0) AS due
         FROM invoices WHERE tenant_id = ? AND client_id = ?`, [scope.tenantId, clientId]);
    const queries = await scope.rawOne(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
         FROM queries WHERE tenant_id = ? AND client_id = ?`, [scope.tenantId, clientId]);

    return {
      title: `Client Report — ${client.display_name}`,
      companyId: company?.id,
      totals: {
        documents: Number(documents?.total) || 0,
        verified: Number(documents?.verified) || 0,
        billedPaise: Number(invoices?.billed) || 0,
        paidPaise: Number(invoices?.paid) || 0,
        duePaise: Number(invoices?.due) || 0,
      },
      meta: { client: client.display_name, gstin: company?.gstin, clientCode: client.client_code },
      sections: [
        {
          key: 'summary', title: 'Overview', kind: 'tiles',
          tiles: [
            { label: 'Documents', value: String(Number(documents?.total) || 0) },
            { label: 'Verified', value: String(Number(documents?.verified) || 0) },
            { label: 'Billed', value: formatINR(Number(invoices?.billed) || 0) },
            { label: 'Outstanding', value: formatINR(Number(invoices?.due) || 0), highlight: (Number(invoices?.due) || 0) > 0 },
          ],
        },
        {
          key: 'periods', title: 'Filing history', kind: 'table',
          columns: [
            { label: 'Period', key: 'period', width: 0.18 },
            { label: 'Status', key: 'status', width: 0.20 },
            { label: 'Due', key: 'due', width: 0.18 },
            { label: 'Expected', key: 'expected', width: 0.14, align: 'right' },
            { label: 'Received', key: 'received', width: 0.15, align: 'right' },
            { label: 'Verified', key: 'verified', width: 0.15, align: 'right' },
          ],
          rows: periods.map(p => ({
            period: p.period_key, status: p.status,
            due: p.due_date ? p.due_date.slice(0, 10) : '—',
            expected: String(p.documents_expected), received: String(p.documents_received),
            verified: String(p.documents_verified),
          })),
        },
      ],
      items: [
        { section: 'summary', label: 'Documents', valueNumber: Number(documents?.total) || 0 },
        { section: 'summary', label: 'Billed', valuePaise: Number(invoices?.billed) || 0 },
        { section: 'summary', label: 'Outstanding', valuePaise: Number(invoices?.due) || 0 },
        { section: 'summary', label: 'Queries resolved', valueNumber: Number(queries?.resolved) || 0 },
      ],
    };
  },

  async audit_report(scope, { from, to, periodKey, filters }) {
    const bounds = from && to ? { start: from, end: to } : periodBounds('monthly', periodKey);
    const params = [scope.tenantId, bounds.start, bounds.end];
    let extra = '';
    if (filters?.action) { extra += ' AND action = ?'; params.push(filters.action); }
    if (filters?.actorId) { extra += ' AND actor_id = ?'; params.push(filters.actorId); }

    const rows = await scope.raw(
      `SELECT * FROM audit_logs
        WHERE tenant_id = ? AND created_at >= ? AND created_at <= ? ${extra}
        ORDER BY sequence ASC LIMIT 5000`, params);

    const byAction = new Map();
    for (const r of rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);

    const { verifyChain } = await import('./audit.js');
    const integrity = await verifyChain(scope.db, scope.tenantId);

    return {
      title: `Audit Report — ${periodKey}`,
      totals: { entries: rows.length, integrityValid: integrity.valid, checked: integrity.checked },
      meta: { integrity },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Entries in period', value: String(rows.length) },
            { label: 'Distinct actions', value: String(byAction.size) },
            { label: 'Chain integrity', value: integrity.valid ? 'Verified' : 'BROKEN', highlight: !integrity.valid },
            { label: 'Entries checked', value: String(integrity.checked) },
          ],
        },
        {
          key: 'actions', title: 'Actions', kind: 'table',
          columns: [
            { label: 'Action', key: 'action', width: 0.6 },
            { label: 'Count', key: 'count', width: 0.4, align: 'right' },
          ],
          rows: [...byAction.entries()].sort((a, b) => b[1] - a[1])
            .map(([action, count]) => ({ action, count: String(count) })),
        },
        {
          key: 'entries', title: 'Entries', kind: 'table',
          columns: [
            { label: 'When', key: 'when', width: 0.18 },
            { label: 'Actor', key: 'actor', width: 0.20 },
            { label: 'Action', key: 'action', width: 0.22 },
            { label: 'Entity', key: 'entity', width: 0.25 },
            { label: 'Result', key: 'result', width: 0.15 },
          ],
          rows: rows.slice(0, 2000).map(r => ({
            when: r.created_at.slice(0, 19).replace('T', ' '),
            actor: r.actor_name ?? r.actor_type,
            action: r.action,
            entity: r.entity_label ?? r.entity_type ?? '—',
            result: r.result,
          })),
        },
      ],
      items: [
        { section: 'summary', label: 'Entries', valueNumber: rows.length },
        { section: 'summary', label: 'Integrity', valueText: integrity.valid ? 'verified' : 'broken' },
      ],
    };
  },

  async team_performance(scope, { periodKey, from, to }) {
    const bounds = from && to ? { start: from, end: to } : periodBounds('monthly', periodKey);

    const rows = await scope.raw(
      `SELECT u.id, u.full_name,
              COUNT(vr.id) AS decisions,
              SUM(CASE WHEN vr.decision = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN vr.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN vr.decision = 'query_raised' THEN 1 ELSE 0 END) AS queried,
              SUM(CASE WHEN vr.sla_met = 1 THEN 1 ELSE 0 END) AS sla_met,
              SUM(CASE WHEN vr.sla_met IS NOT NULL THEN 1 ELSE 0 END) AS sla_measured,
              AVG(vr.time_spent_seconds) AS avg_seconds
         FROM users u
         LEFT JOIN verification_records vr
           ON vr.verifier_id = u.id AND vr.created_at >= ? AND vr.created_at <= ?
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
        GROUP BY u.id, u.full_name
        HAVING decisions > 0
        ORDER BY decisions DESC`, [bounds.start, bounds.end, scope.tenantId]);

    const totalDecisions = rows.reduce((s, r) => s + Number(r.decisions), 0);

    return {
      title: `Team Performance — ${periodKey}`,
      totals: { executives: rows.length, decisions: totalDecisions },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Executives active', value: String(rows.length) },
            { label: 'Decisions', value: String(totalDecisions), highlight: true },
            {
              label: 'SLA compliance',
              value: (() => {
                const measured = rows.reduce((s, r) => s + Number(r.sla_measured ?? 0), 0);
                const met = rows.reduce((s, r) => s + Number(r.sla_met ?? 0), 0);
                return measured ? `${Math.round((met / measured) * 100)}%` : '—';
              })(),
            },
          ],
        },
        {
          key: 'executives', title: 'By executive', kind: 'table',
          columns: [
            { label: 'Executive', key: 'name', width: 0.28 },
            { label: 'Decisions', key: 'decisions', width: 0.14, align: 'right' },
            { label: 'Approved', key: 'approved', width: 0.14, align: 'right' },
            { label: 'Rejected', key: 'rejected', width: 0.14, align: 'right' },
            { label: 'Queries', key: 'queried', width: 0.14, align: 'right' },
            { label: 'SLA', key: 'sla', width: 0.16, align: 'right' },
          ],
          rows: rows.map(r => ({
            name: r.full_name,
            decisions: String(r.decisions),
            approved: String(r.approved ?? 0),
            rejected: String(r.rejected ?? 0),
            queried: String(r.queried ?? 0),
            sla: Number(r.sla_measured) ? `${Math.round((Number(r.sla_met) / Number(r.sla_measured)) * 100)}%` : '—',
          })),
        },
      ],
      items: rows.map(r => ({
        section: 'executives', label: r.full_name, valueNumber: Number(r.decisions),
        meta: { approved: Number(r.approved ?? 0), rejected: Number(r.rejected ?? 0) },
      })),
    };
  },

  async call_report(scope, { periodKey, from, to }) {
    const bounds = from && to ? { start: from, end: to } : periodBounds('monthly', periodKey);
    const rows = await scope.raw(
      `SELECT u.full_name, m.* FROM call_metrics_daily m
         LEFT JOIN users u ON u.id = m.agent_id
        WHERE m.tenant_id = ? AND m.day >= ? AND m.day <= ?
        ORDER BY m.day DESC`, [scope.tenantId, bounds.start.slice(0, 10), bounds.end.slice(0, 10)]);

    const byAgent = new Map();
    for (const r of rows) {
      const key = r.agent_id ?? 'unassigned';
      if (!byAgent.has(key)) {
        byAgent.set(key, { name: r.full_name ?? 'Unassigned', total: 0, missed: 0, duration: 0, positive: 0 });
      }
      const a = byAgent.get(key);
      a.total += Number(r.total_calls) || 0;
      a.missed += Number(r.missed_calls) || 0;
      a.duration += Number(r.total_duration_sec) || 0;
      a.positive += Number(r.positive_count) || 0;
    }

    const totals = [...byAgent.values()].reduce((acc, a) => ({
      total: acc.total + a.total, missed: acc.missed + a.missed,
      duration: acc.duration + a.duration, positive: acc.positive + a.positive,
    }), { total: 0, missed: 0, duration: 0, positive: 0 });

    return {
      title: `Call Report — ${periodKey}`,
      totals: {
        calls: totals.total, missed: totals.missed,
        totalDurationSeconds: totals.duration,
        avgDurationSeconds: totals.total ? Math.round(totals.duration / totals.total) : 0,
      },
      sections: [
        {
          key: 'summary', title: 'Summary', kind: 'tiles',
          tiles: [
            { label: 'Total calls', value: String(totals.total), highlight: true },
            { label: 'Missed', value: String(totals.missed) },
            { label: 'Avg duration', value: formatDuration(totals.total ? totals.duration / totals.total : 0) },
            { label: 'Positive sentiment', value: totals.total ? `${Math.round((totals.positive / totals.total) * 100)}%` : '—' },
          ],
        },
        {
          key: 'agents', title: 'By executive', kind: 'table',
          columns: [
            { label: 'Executive', key: 'name', width: 0.34 },
            { label: 'Calls', key: 'calls', width: 0.16, align: 'right' },
            { label: 'Missed', key: 'missed', width: 0.16, align: 'right' },
            { label: 'Talk time', key: 'duration', width: 0.17, align: 'right' },
            { label: 'Positive', key: 'positive', width: 0.17, align: 'right' },
          ],
          rows: [...byAgent.values()].sort((a, b) => b.total - a.total).map(a => ({
            name: a.name, calls: String(a.total), missed: String(a.missed),
            duration: formatDuration(a.duration),
            positive: a.total ? `${Math.round((a.positive / a.total) * 100)}%` : '—',
          })),
        },
      ],
      items: [{ section: 'summary', label: 'Total calls', valueNumber: totals.total }],
    };
  },

  async analytics(scope, { periodKey }) {
    const bounds = periodBounds('monthly', periodKey);
    const row = await scope.rawOne(
      `SELECT
         (SELECT COUNT(*) FROM clients WHERE tenant_id = ?1 AND deleted_at IS NULL) AS clients,
         (SELECT COUNT(*) FROM documents WHERE tenant_id = ?1 AND deleted_at IS NULL AND created_at BETWEEN ?2 AND ?3) AS documents,
         (SELECT COUNT(*) FROM queries WHERE tenant_id = ?1 AND created_at BETWEEN ?2 AND ?3) AS queries,
         (SELECT COUNT(*) FROM reports WHERE tenant_id = ?1 AND created_at BETWEEN ?2 AND ?3) AS reports,
         (SELECT COALESCE(SUM(amount_paise),0) FROM payments WHERE tenant_id = ?1 AND status = 'success' AND created_at BETWEEN ?2 AND ?3) AS collected`,
      [scope.tenantId, bounds.start, bounds.end]);

    return {
      title: `Analytics — ${periodKey}`,
      totals: {
        clients: Number(row?.clients) || 0,
        documents: Number(row?.documents) || 0,
        queries: Number(row?.queries) || 0,
        reports: Number(row?.reports) || 0,
        collectedPaise: Number(row?.collected) || 0,
      },
      sections: [{
        key: 'summary', title: 'Summary', kind: 'tiles',
        tiles: [
          { label: 'Clients', value: String(Number(row?.clients) || 0) },
          { label: 'Documents', value: String(Number(row?.documents) || 0) },
          { label: 'Queries', value: String(Number(row?.queries) || 0) },
          { label: 'Collected', value: formatINR(Number(row?.collected) || 0), highlight: true },
        ],
      }],
      items: [
        { section: 'summary', label: 'Clients', valueNumber: Number(row?.clients) || 0 },
        { section: 'summary', label: 'Collected', valuePaise: Number(row?.collected) || 0 },
      ],
    };
  },
};

/** Quarterly and yearly roll-ups share one shape. */
async function periodRollup(scope, { clientId, periodType, periodKey, label }) {
  const client = await scope.getOrFail('clients', clientId, { resource: 'Client' });
  const bounds = periodBounds(periodType, periodKey);

  const computations = await scope.raw(
    `SELECT * FROM tax_computations
      WHERE tenant_id = ? AND client_id = ? AND status != 'superseded'
        AND period_start >= ? AND period_end <= ?
      ORDER BY period_key`,
    [scope.tenantId, clientId, bounds.start, bounds.end]);

  const gst = computations.filter(c => c.regime === 'gst');
  const tds = computations.filter(c => c.regime === 'tds');
  const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] ?? 0), 0);

  const totals = {
    taxableValuePaise: sum(gst, 'taxable_value_paise'),
    cgstPaise: sum(gst, 'cgst_paise'),
    sgstPaise: sum(gst, 'sgst_paise'),
    igstPaise: sum(gst, 'igst_paise'),
    totalTaxPaise: sum(gst, 'total_tax_paise'),
    itcTotalPaise: sum(gst, 'itc_total_paise'),
    netPayablePaise: sum(gst, 'net_payable_paise'),
    tdsDeductedPaise: sum(tds, 'tds_deducted_paise'),
  };

  return {
    title: `${label} Report — ${periodKey}`,
    companyId: client.company_id,
    totals,
    meta: { client: client.display_name, periodsIncluded: gst.length },
    sections: [
      {
        key: 'summary', title: 'Summary', kind: 'tiles',
        tiles: [
          { label: 'Taxable value', value: formatINR(totals.taxableValuePaise) },
          { label: 'Output tax', value: formatINR(totals.totalTaxPaise) },
          { label: 'Input credit', value: formatINR(totals.itcTotalPaise) },
          { label: 'Net payable', value: formatINR(totals.netPayablePaise), highlight: true },
          { label: 'TDS deducted', value: formatINR(totals.tdsDeductedPaise) },
        ],
      },
      {
        key: 'periods', title: 'Period breakdown', kind: 'table',
        columns: [
          { label: 'Period', key: 'period', width: 0.16 },
          { label: 'Taxable', key: 'taxable', width: 0.21, align: 'right' },
          { label: 'Output tax', key: 'tax', width: 0.21, align: 'right' },
          { label: 'ITC', key: 'itc', width: 0.21, align: 'right' },
          { label: 'Net payable', key: 'net', width: 0.21, align: 'right' },
        ],
        rows: gst.map(c => ({
          period: c.period_key,
          taxable: formatINR(c.taxable_value_paise),
          tax: formatINR(c.total_tax_paise),
          itc: formatINR(c.itc_total_paise),
          net: formatINR(c.net_payable_paise),
        })),
      },
    ],
    items: Object.entries(totals).map(([label, value]) => ({
      section: 'summary', label, valuePaise: value,
    })),
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** CSV of every table section, with the summary as a header block. */
export function reportToCsv(report, sections) {
  const lines = [];
  lines.push(['Report', report.title].map(escapeCsv).join(','));
  lines.push(['Reference', report.reference_no].map(escapeCsv).join(','));
  lines.push(['Period', report.period_key ?? ''].map(escapeCsv).join(','));
  lines.push(['Generated', report.generated_at ?? report.created_at].map(escapeCsv).join(','));
  lines.push(['Status', report.status].map(escapeCsv).join(','));
  lines.push('');

  for (const section of sections) {
    lines.push(escapeCsv(section.title));
    if (section.kind === 'tiles') {
      for (const tile of section.tiles ?? []) {
        lines.push([tile.label, tile.value].map(escapeCsv).join(','));
      }
    } else if (section.kind === 'totals') {
      for (const row of section.rows ?? []) {
        lines.push([row[0], row[1]].map(escapeCsv).join(','));
      }
    } else if (section.columns?.length) {
      lines.push(section.columns.map(c => escapeCsv(c.label)).join(','));
      for (const row of section.rows ?? []) {
        lines.push(section.columns.map(c => escapeCsv(row[c.key])).join(','));
      }
    }
    lines.push('');
  }

  // A BOM so Excel opens the Indian rupee text correctly.
  return '﻿' + lines.join('\r\n');
}

/** A print-quality PDF of the stored snapshot. */
export function reportToPdf(report, sections, { brand = 'Meet Millions Finance CRM', meta = {} } = {}) {
  const doc = new PdfDocument({
    title: report.title,
    subject: `${report.reference_no} · ${report.period_key ?? ''}`,
  });

  doc.header({
    brand,
    title: report.title,
    subtitle: [meta.client, meta.gstin ? `GSTIN ${meta.gstin}` : null].filter(Boolean).join(' · '),
    right: [
      { label: 'Reference', value: report.reference_no },
      { label: 'Status', value: String(report.status).replace(/_/g, ' ').toUpperCase() },
    ],
  });

  const details = [
    ['Period', report.period_key ?? '—'],
    ['Period type', report.period_type ?? '—'],
    ['Generated', (report.generated_at ?? report.created_at ?? '').slice(0, 19).replace('T', ' ')],
  ];
  if (meta.sourceDocumentCount !== undefined) {
    details.push(['Source documents', String(meta.sourceDocumentCount)]);
  }
  if (report.approved_at) details.push(['Approved', report.approved_at.slice(0, 10)]);
  doc.eyebrow('Report details');
  doc.keyValues(details);

  for (const section of sections) {
    if (section.kind === 'tiles') {
      doc.eyebrow(section.title);
      doc.tiles(section.tiles ?? []);
    } else if (section.kind === 'totals') {
      doc.heading(section.title);
      doc.totals(section.rows ?? []);
    } else if (section.columns?.length) {
      doc.heading(section.title);
      if (!section.rows?.length) doc.paragraph('No entries in this section.', { colour: '#6B7CA0' });
      else doc.table(section.columns, section.rows);
    }
  }

  if (report.narrative) {
    doc.heading('Summary');
    doc.paragraph(report.narrative);
  }

  for (const warning of meta.warnings ?? []) {
    doc.note(warning.message);
  }

  doc.footer(`${brand} · ${report.reference_no} · Generated ${dayKey()}`);
  return doc.render();
}

/** Run a scheduled export and mark the schedule. Called by the daily cron. */
export async function runScheduledExport(env, schedule) {
  const db = new Db(env.DB);
  const scope = new TenantScope(db, schedule.tenant_id);
  const filters = safeJson(schedule.filters_json, {});

  const ctx = { env, tenantId: schedule.tenant_id, userId: schedule.created_by, user: null };

  const { report, sections } = await generateReport(ctx, scope, {
    type: schedule.report_type,
    clientId: filters.clientId ?? null,
    periodType: filters.periodType ?? 'monthly',
    periodKey: filters.periodKey ?? monthKey(),
    filters,
  });

  const recipients = safeJson(schedule.recipients_json, []);
  const { dispatchNotification } = await import('./notifications.js');

  for (const email of recipients) {
    await dispatchNotification(ctx, {
      triggerKey: 'report.generated',
      tenantId: schedule.tenant_id,
      toEmail: email,
      channels: ['email'],
      entityType: 'report', entityId: report.id,
      variables: {
        reportTitle: report.title,
        period: report.period_key,
        link: `${env.APP_URL || ''}/reports/${report.id}`,
      },
    });
  }

  await scope.update('scheduled_reports', schedule.id, {
    last_run_at: nowIso(),
    last_run_status: 'success',
    run_count: (schedule.run_count ?? 0) + 1,
    next_run_at: computeNextRun(schedule),
  });

  return { reportId: report.id, recipients: recipients.length };
}

function computeNextRun(schedule) {
  const now = new Date();
  const hour = schedule.hour_utc ?? 3;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  switch (schedule.frequency) {
    case 'daily': next.setUTCDate(next.getUTCDate() + 1); break;
    case 'weekly': next.setUTCDate(next.getUTCDate() + 7); break;
    case 'quarterly': next.setUTCMonth(next.getUTCMonth() + 3); break;
    case 'monthly':
    default: next.setUTCMonth(next.getUTCMonth() + 1); break;
  }
  return next.toISOString();
}

function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function safeJson(v, fallback) {
  try { return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}

export { formatDuration, BUILDERS };
