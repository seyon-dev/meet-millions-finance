/**
 * One tax computation.
 *
 * The figures first, then every line that produced them. An accountant does
 * not trust a total they cannot take apart, so the lines are here rather than
 * behind a link, and the rate-wise and section-wise breakdowns are shown the
 * way a return asks for them.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, banner, skeletonTable,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function taxDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(8, 5));

  async function load() {
    try {
      const { data } = await api.get(`/tax/computations/${params.id}`);
      setBreadcrumbs([
        { label: 'Tax', href: `/tax?regime=${data.computation.regime}` },
        { label: `${data.client?.display_name ?? ''} ${fmt.period(data.computation.periodKey)}`.trim() },
      ]);
      render(page, ...build(data, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, reload) {
  const { computation: c, client, company, period, lines, summary, reports, warnings } = data;
  const gst = c.regime === 'gst';

  return [
    pageHead({
      title: `${gst ? 'GST' : 'TDS'} — ${fmt.period(c.periodKey)}`,
      subtitle: [client?.display_name, company?.gstin, `computed ${fmt.dateTime(c.computedAt)}`]
        .filter(Boolean).join(' · '),
      actions: frag(
        statusPill(c.status),
        session.can('reports.create')
          ? button('Produce a report', {
              variant: 'ghost', icon: 'report',
              href: `/reports?computationId=${c.id}&clientId=${c.clientId}`,
            })
          : null,
        c.status === 'draft' && session.can('tax.calculate')
          ? button('Finalise', { variant: 'primary', icon: 'stamp', onClick: () => finalise(c, reload) })
          : null),
    }),

    c.status === 'superseded'
      ? banner({
          text: 'These figures were replaced by a later run. They are kept for the record, not for filing.',
          tone: 'warning',
          icon: 'clock',
        })
      : null,

    warnings?.length ? warningsBanner(warnings) : null,

    gst ? gstFigures(c, summary) : tdsFigures(c, summary),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      gst ? gstLinesCard(lines ?? []) : tdsLinesCard(lines ?? []),
      el('div.mm-stack.mm-gap-4',
        contextCard(c, client, company, period),
        gst ? rateCard(summary) : sectionCard(summary),
        reportsCard(reports ?? []))),
  ].filter(Boolean);
}

function warningsBanner(warnings) {
  return card({
    title: `${fmt.plural(warnings.length, 'warning')} from this computation`,
    className: 'mm-card--warning',
    flush: true,
    body: el('ul.mm-flags',
      ...warnings.map(warning => el('li.mm-flags__item',
        icon('alert', { size: 'sm' }),
        el('span', { text: typeof warning === 'string' ? warning : (warning.message ?? JSON.stringify(warning)) })))),
  });
}

/**
 * The GST figures.
 *
 * Laid out the way the return reads: outward tax, less input credit, equals
 * what is payable. CGST and SGST are shown separately from IGST because the
 * split is the whole point of place-of-supply.
 */
function gstFigures(c, summary) {
  const interState = (c.igstPaise ?? 0) > 0;

  return card({
    title: 'The figures',
    subtitle: interState
      ? 'Inter-state supply — IGST applies.'
      : 'Intra-state supply — CGST and SGST each take half the rate.',
    body: frag(
      el('div.mm-figures',
        figure('Taxable value', c.taxableValuePaise, { large: true }),
        interState
          ? figure('IGST', c.igstPaise)
          : frag(figure('CGST', c.cgstPaise), figure('SGST', c.sgstPaise)),
        (c.cessPaise ?? 0) > 0 ? figure('Cess', c.cessPaise) : null,
        figure('Total tax', c.totalTaxPaise, { emphasis: true })),

      el('div.mm-figures.mm-figures--net.mm-mt-4',
        figure('Input tax credit', c.itcTotalPaise, { tone: 'success', prefix: '−' }),
        figure('Net payable', c.netPayablePaise, { large: true, emphasis: true }),
        (summary?.creditCarriedForwardPaise ?? 0) > 0
          ? figure('Credit carried forward', summary.creditCarriedForwardPaise, { tone: 'success' })
          : null),

      el('p.mm-muted.mm-text-xs.mm-mt-3', {
        text: `From ${fmt.plural(summary?.outwardCount ?? 0, 'outward line')} and ${fmt.plural(summary?.inwardCount ?? 0, 'inward line')} across ${fmt.plural(c.sourceDocumentCount ?? 0, 'verified document')}. Engine ${c.engineVersion}.`,
      })),
  });
}

function tdsFigures(c, summary) {
  const outstanding = Math.max(0, (c.tdsDeductedPaise ?? 0) - (c.tdsDepositedPaise ?? 0));
  return card({
    title: 'The figures',
    subtitle: 'Deducted at source, and what has reached the department.',
    body: frag(
      el('div.mm-figures',
        figure('Payments covered', c.tdsBasePaise, { large: true }),
        figure('TDS deducted', c.tdsDeductedPaise, { emphasis: true }),
        figure('Deposited', c.tdsDepositedPaise, { tone: 'success' }),
        figure('Outstanding', outstanding, { tone: outstanding > 0 ? 'danger' : null, emphasis: true })),
      el('p.mm-muted.mm-text-xs.mm-mt-3', {
        text: `${fmt.plural(summary?.lineCount ?? 0, 'deduction')} across ${fmt.plural(summary?.deducteeCount ?? 0, 'deductee')}.`,
      })),
  });
}

function figure(label, paise, { large = false, emphasis = false, tone = null, prefix = '' } = {}) {
  return el('div.mm-figure', {
    class: [large ? 'mm-figure--lg' : '', emphasis ? 'mm-figure--emphasis' : '', tone ? `mm-figure--${tone}` : '']
      .filter(Boolean).join(' '),
  },
    el('span.mm-figure__label', { text: label }),
    el('span.mm-figure__value.mm-numeric', { text: `${prefix}${fmt.money(paise ?? 0)}` }));
}

function gstLinesCard(lines) {
  const outward = lines.filter(l => l.direction === 'outward');
  const inward = lines.filter(l => l.direction === 'inward');

  return card({
    title: 'The lines behind the figures',
    subtitle: `${fmt.plural(outward.length, 'outward invoice')}, ${fmt.plural(inward.length, 'inward invoice')}`,
    flush: true,
    body: lines.length
      ? frag(
          linesTable('Outward supplies', outward),
          linesTable('Inward supplies', inward, { itc: true }))
      : emptyState({
          title: 'No lines were recorded',
          message: 'A computation with no lines means no verified document carried GST data for this period.',
          icon: 'list',
          inline: true,
        }),
  });
}

function linesTable(title, rows, { itc = false } = {}) {
  if (!rows.length) return null;

  return frag(
    el('h3.mm-subhead', { text: title }),
    el('div.mm-table-wrap',
      el('table.mm-table.mm-table--compact',
        el('thead',
          el('tr',
            el('th', { text: 'Invoice' }),
            el('th', { text: 'Party' }),
            el('th.mm-align-right', { text: 'Taxable' }),
            el('th.mm-align-right.mm-hide-sm', { text: 'Rate' }),
            el('th.mm-align-right', { text: 'Tax' }),
            itc ? el('th.mm-align-center.mm-hide-sm', { text: 'ITC' }) : null)),
        el('tbody',
          ...rows.map(row => el('tr',
            el('td',
              el('div.mm-stack',
                el('span.mm-fw-medium', { text: row.invoice_no ?? '—' }),
                el('span.mm-muted.mm-text-xs', { text: fmt.date(row.invoice_date) }))),
            el('td',
              el('div.mm-stack',
                el('span', { text: row.party_name ?? '—' }),
                row.party_gstin
                  ? el('span.mm-mono.mm-muted.mm-text-xs', { text: row.party_gstin })
                  : null)),
            el('td.mm-align-right.mm-numeric', { text: fmt.money(row.taxable_value_paise) }),
            el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: `${row.rate_pct ?? 0}%` }),
            el('td.mm-align-right.mm-numeric', {
              text: fmt.money((row.cgst_paise ?? 0) + (row.sgst_paise ?? 0) + (row.igst_paise ?? 0) + (row.cess_paise ?? 0)),
            }),
            itc
              ? el('td.mm-align-center.mm-hide-sm',
                  row.itc_eligible ? pill('Eligible', 'success') : pill('Blocked', 'neutral'))
              : null)))))); 
}

function tdsLinesCard(lines) {
  return card({
    title: 'Deductions',
    subtitle: fmt.plural(lines.length, 'deduction'),
    flush: true,
    body: lines.length
      ? el('div.mm-table-wrap',
          el('table.mm-table.mm-table--compact',
            el('thead',
              el('tr',
                el('th', { text: 'Deductee' }),
                el('th.mm-hide-sm', { text: 'Section' }),
                el('th.mm-align-right', { text: 'Payment' }),
                el('th.mm-align-right.mm-hide-sm', { text: 'Rate' }),
                el('th.mm-align-right', { text: 'TDS' }),
                el('th.mm-align-right.mm-hide-sm', { text: 'Deposited' }))),
            el('tbody',
              ...lines.map(row => el('tr',
                el('td',
                  el('div.mm-stack',
                    el('span.mm-fw-medium', { text: row.deductee_name ?? '—' }),
                    row.deductee_pan
                      ? el('span.mm-mono.mm-muted.mm-text-xs', { text: row.deductee_pan })
                      : el('span.mm-c-warning.mm-text-xs', { text: 'No PAN — higher rate applies' }))),
                el('td.mm-hide-sm', { text: row.section_code ?? '—' }),
                el('td.mm-align-right.mm-numeric', { text: fmt.money(row.amount_paise) }),
                el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: `${row.rate_pct ?? 0}%` }),
                el('td.mm-align-right.mm-numeric', { text: fmt.money(row.tds_paise) }),
                el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: fmt.money(row.deposited_paise) }))))))
      : emptyState({ title: 'No deductions recorded for this period', icon: 'list', inline: true }),
  });
}

function rateCard(summary) {
  const rows = summary?.byRate ?? [];
  return card({
    title: 'Rate-wise',
    subtitle: 'As the return asks for it',
    flush: true,
    body: rows.length
      ? el('div.mm-table-wrap',
          el('table.mm-table.mm-table--compact',
            el('thead', el('tr',
              el('th', { text: 'Rate' }),
              el('th.mm-align-right', { text: 'Taxable' }),
              el('th.mm-align-right', { text: 'Tax' }))),
            el('tbody',
              ...rows.map(row => el('tr',
                el('td', { text: `${row.ratePct}%` }),
                el('td.mm-align-right.mm-numeric', { text: fmt.moneyShort(row.taxableValuePaise) }),
                el('td.mm-align-right.mm-numeric', {
                  text: fmt.moneyShort(row.cgstPaise + row.sgstPaise + row.igstPaise + row.cessPaise),
                }))))))
      : emptyState({ title: 'Nothing to break down', icon: 'chart', inline: true }),
  });
}

function sectionCard(summary) {
  const rows = summary?.bySection ?? [];
  return card({
    title: 'Section-wise',
    flush: true,
    body: rows.length
      ? el('div.mm-table-wrap',
          el('table.mm-table.mm-table--compact',
            el('thead', el('tr',
              el('th', { text: 'Section' }),
              el('th.mm-align-right', { text: 'Base' }),
              el('th.mm-align-right', { text: 'TDS' }))),
            el('tbody',
              ...rows.map(row => el('tr',
                el('td', { text: row.sectionCode }),
                el('td.mm-align-right.mm-numeric', { text: fmt.moneyShort(row.basePaise) }),
                el('td.mm-align-right.mm-numeric', { text: fmt.moneyShort(row.deductedPaise) }))))))
      : emptyState({ title: 'Nothing to break down', icon: 'chart', inline: true }),
  });
}

function contextCard(c, client, company, period) {
  return card({
    title: 'Context',
    body: el('div.mm-kvgrid',
      kv('Client', client?.display_name),
      kv('GSTIN', company?.gstin, { mono: true }),
      kv('State', company?.state_code, { mono: true }),
      kv('Period', fmt.period(c.periodKey)),
      kv('Period type', fmt.label(c.periodType)),
      kv('Filing status', period?.status ? fmt.label(period.status) : null),
      kv('Documents used', c.sourceDocumentCount),
      kv('Lines', c.lineCount),
      kv('Computed', fmt.dateTime(c.computedAt)),
      kv('Engine', c.engineVersion, { mono: true })),
  });
}

function reportsCard(reports) {
  return card({
    title: 'Reports from this computation',
    flush: true,
    body: reports.length
      ? el('ul.mm-list',
          ...reports.map(report => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/reports/${report.id}` },
              el('span.mm-fw-medium', { text: report.title ?? fmt.label(report.report_type) }),
              el('span.mm-muted.mm-text-xs', { text: fmt.relative(report.created_at) })),
            statusPill(report.status))))
      : emptyState({ title: 'No report produced yet', icon: 'report', inline: true }),
  });
}

/**
 * Finalise.
 *
 * Deliberately a confirmation with consequences spelled out: a finalised
 * computation is what a return is filed from, and re-running after that
 * supersedes rather than edits.
 */
async function finalise(c, reload) {
  const answer = await confirm({
    title: 'Finalise this computation?',
    message: 'It becomes the figure of record for this period, and the filing moves forward.',
    detail: 'Re-running afterwards creates a new computation and marks this one superseded. Nothing is deleted.',
    confirmLabel: 'Finalise',
  });
  if (!answer) return;

  try {
    await api.post(`/tax/computations/${c.id}/finalise`, {});
    notify.success('Finalised.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
