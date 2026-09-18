/**
 * One report.
 *
 * Rendered from the sections the server produced, so the screen and the PDF
 * are the same document — a report that reads differently on screen than in
 * the file somebody signs is a report nobody can rely on.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import {
  pageHead, card, kv, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, promptText, banner, skeletonTable,
} from '../../core/ui.js';
import { barChart, lineChart, donutChart, legend } from '../../components/charts.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function reportDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(8, 4));

  async function load() {
    try {
      const { data } = await api.get(`/reports/${params.id}`);
      setBreadcrumbs([
        { label: 'Reports', href: '/reports' },
        { label: data.report.referenceNo ?? data.report.title },
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
  const { report, sections, meta, approvals, client, company, permissions } = data;

  return [
    pageHead({
      title: report.title,
      subtitle: [report.referenceNo, client?.display_name, fmt.period(report.periodKey)]
        .filter(Boolean).join(' · '),
      actions: frag(
        statusPill(report.status),
        permissions?.canExport
          ? button('Download PDF', {
              variant: 'ghost', icon: 'download',
              onClick: () => api.download(`/reports/${report.id}/export`, { query: { format: 'pdf' } })
                .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
                .catch(notifyError),
            })
          : null,
        permissions?.canExport
          ? button('CSV', {
              variant: 'ghost', icon: 'download',
              onClick: () => api.download(`/reports/${report.id}/export`, { query: { format: 'csv' } })
                .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
                .catch(notifyError),
            })
          : null,
        permissions?.canRegenerate
          ? button('Regenerate', { variant: 'ghost', icon: 'refresh', onClick: () => regenerate(report, reload) })
          : null,
        permissions?.canSubmit
          ? button('Submit for approval', { variant: 'primary', icon: 'arrow-right', onClick: () => submit(report, reload) })
          : null,
        permissions?.canApprove
          ? frag(
              button('Approve', { variant: 'primary', icon: 'check', onClick: () => decide(report, 'approve', reload) }),
              button('Reject', { variant: 'danger', icon: 'x', onClick: () => decide(report, 'reject', reload) }))
          : null,
        permissions?.canSignOff
          ? frag(
              button('Ask for a correction', {
                variant: 'ghost', icon: 'edit', onClick: () => signOff(report, false, reload),
              }),
              button('Sign off', {
                variant: 'primary', icon: 'stamp', onClick: () => signOff(report, true, reload),
              }))
          : null),
    }),

    report.status === 'rejected' && report.rejectedReason
      ? banner({ text: `Rejected: ${report.rejectedReason}`, tone: 'danger', icon: 'x-circle' })
      : null,

    report.clientSignedOffAt
      ? banner({
          text: `Signed off by the client on ${fmt.dateTime(report.clientSignedOffAt)}.`,
          tone: 'success',
          icon: 'check-circle',
        })
      : null,

    report.narrative ? narrativeCard(report) : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        ...(sections ?? []).map(section => sectionCard(section)),
        (sections ?? []).length
          ? null
          : emptyState({
              title: 'This report has no sections',
              message: 'It was produced with no data in the period it covers.',
              icon: 'report',
            })),

      el('div.mm-stack.mm-gap-4',
        aboutCard(report, meta, client, company),
        approvalsCard(approvals ?? []))),
  ].filter(Boolean);
}

/** The written summary, marked as machine-written where it is. */
function narrativeCard(report) {
  return card({
    title: 'Summary',
    subtitle: report.aiGenerated ? 'Written from the figures. Read it before sending it on.' : null,
    className: report.aiGenerated ? 'mm-card--ai' : '',
    body: frag(
      report.aiGenerated
        ? el('div.mm-row.mm-gap-2.mm-center.mm-mb-3', icon('sparkle', { size: 'sm' }), pill('AI written', 'violet'))
        : null,
      ...String(report.narrative).split(/\n{2,}/).map(paragraph => el('p.mm-prose', { text: paragraph }))),
  });
}

/**
 * One section, rendered by its declared kind.
 *
 * The server says what a section is — tiles, a table, totals or a chart — and
 * this renders that. Anything unrecognised is shown as its own data rather
 * than silently dropped.
 */
function sectionCard(section) {
  return card({
    title: section.title,
    flush: section.kind === 'table',
    body: {
      tiles: () => tilesSection(section),
      table: () => tableSection(section),
      totals: () => totalsSection(section),
      chart: () => chartSection(section),
    }[section.kind]?.() ?? unknownSection(section),
  });
}

function tilesSection(section) {
  return el('div.mm-figures',
    ...(section.tiles ?? []).map(tile => el('div.mm-figure', {
      class: tile.highlight ? 'mm-figure--emphasis mm-figure--lg' : '',
    },
      el('span.mm-figure__label', { text: tile.label }),
      el('span.mm-figure__value.mm-numeric', { text: String(tile.value) }))));
}

function tableSection(section) {
  const columns = section.columns ?? [];
  const rows = section.rows ?? [];

  if (!rows.length) {
    return emptyState({ title: 'Nothing in this section', icon: 'list', inline: true });
  }

  return el('div.mm-table-wrap',
    el('table.mm-table.mm-table--compact',
      el('thead',
        el('tr', ...columns.map(column => el('th', {
          class: column.align === 'right' ? 'mm-align-right' : '',
          text: column.label,
        })))),
      el('tbody',
        ...rows.map(row => el('tr',
          ...columns.map(column => el('td', {
            class: [
              column.align === 'right' ? 'mm-align-right mm-numeric' : '',
            ].filter(Boolean).join(' '),
            text: String(row[column.key] ?? '—'),
          })))))));
}

function totalsSection(section) {
  return el('ul.mm-totals',
    ...(section.rows ?? []).map(([label, value, emphasis]) => el('li.mm-totals__row', {
      class: emphasis ? 'is-emphasis' : '',
    },
      el('span', { text: label }),
      el('span.mm-numeric', { text: String(value) }))));
}

function chartSection(section) {
  const chart = section.chart ?? {};
  const series = chart.series ?? [];

  const drawn = chart.type === 'donut'
    ? el('div.mm-row.mm-gap-5.mm-wrap', donutChart({ series, size: 176 }), legend(series))
    : chart.type === 'line'
      ? lineChart({ series })
      : barChart({ series });

  // The same numbers as a table beneath the picture: a chart is not readable
  // by a screen reader, and an accountant will want the figures anyway.
  return frag(drawn, section.rows?.length ? tableSection(section) : null);
}

function unknownSection(section) {
  return el('pre.mm-code', { text: JSON.stringify(section, null, 2) });
}

function aboutCard(report, meta, client, company) {
  return card({
    title: 'About this report',
    body: el('div.mm-kvgrid',
      kv('Reference', report.referenceNo, { mono: true }),
      kv('Type', fmt.label(report.type)),
      kv('Client', client?.display_name ?? 'Firm-wide'),
      kv('GSTIN', company?.gstin ?? meta?.gstin, { mono: true }),
      kv('Period', fmt.period(report.periodKey)),
      kv('Covers', report.periodStart ? `${fmt.date(report.periodStart)} – ${fmt.date(report.periodEnd)}` : null),
      kv('Produced by', report.generatedByName),
      kv('Produced', fmt.dateTime(report.generatedAt)),
      kv('Submitted', report.submittedAt ? fmt.dateTime(report.submittedAt) : null),
      kv('Approved by', report.approvedByName),
      kv('Approved', report.approvedAt ? fmt.dateTime(report.approvedAt) : null),
      kv('Documents used', meta?.sourceDocumentCount),
      kv('Engine', meta?.engineVersion, { mono: true })),
  });
}

function approvalsCard(approvals) {
  return card({
    title: 'Approval trail',
    flush: true,
    body: approvals.length
      ? el('ol.mm-timeline',
          ...approvals.map(approval => el('li.mm-timeline__item',
            el('span.mm-timeline__dot', {
              class: `mm-timeline__dot--${approval.status === 'approved' ? 'success' : approval.status === 'rejected' ? 'danger' : 'warning'}`,
            }),
            el('div.mm-timeline__content',
              el('p.mm-timeline__title', {
                text: `${fmt.label(approval.status)}${approval.decided_by_name ? ` — ${approval.decided_by_name}` : ''}`,
              }),
              approval.notes ? el('p.mm-text-sm', { text: approval.notes }) : null,
              el('p.mm-timeline__meta', {
                text: [
                  approval.requested_by_name ? `Requested by ${approval.requested_by_name}` : null,
                  fmt.dateTime(approval.decided_at ?? approval.created_at),
                ].filter(Boolean).join(' · '),
              })))))
      : emptyState({
          title: 'Not submitted for approval yet',
          message: 'Once submitted, every decision on it is recorded here.',
          icon: 'stamp',
          inline: true,
        }),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function submit(report, reload) {
  const note = await promptText({
    title: 'Submit for approval',
    message: 'The approver is notified and the report becomes read-only until they decide.',
    label: 'Note for the approver',
    placeholder: 'Figures agree with the GSTR-2B for the month.',
    required: false,
    confirmLabel: 'Submit',
  });
  if (note === null) return;

  try {
    await api.post(`/reports/${report.id}/submit`, { note: note || undefined });
    notify.success('Submitted for approval.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function decide(report, decision, reload) {
  const note = await promptText({
    title: decision === 'approve' ? 'Approve this report' : 'Reject this report',
    message: decision === 'approve'
      ? 'It moves to the client for sign-off.'
      : 'It returns to its author, with your reason.',
    label: decision === 'approve' ? 'Note (optional)' : 'Why is it being rejected?',
    required: decision === 'reject',
    confirmLabel: decision === 'approve' ? 'Approve' : 'Reject',
    tone: decision === 'approve' ? 'primary' : 'danger',
  });
  if (note === null) return;

  try {
    await api.post(`/reports/${report.id}/decision`, { decision, comment: note || undefined });
    notify.success(decision === 'approve' ? 'Approved.' : 'Rejected, and the author has been told.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

/**
 * The client's sign-off.
 *
 * Both answers are here, because a sign-off screen that only offers "accept"
 * is not asking a question. Declining requires a reason, which the server also
 * insists on — it is what the firm needs in order to correct anything.
 */
async function signOff(report, accepted, reload) {
  let comment = null;

  if (accepted) {
    const answer = await confirm({
      title: 'Sign off on this report',
      message: 'This records your acceptance of the figures, with the time and who did it.',
      detail: 'Your accountant is told, and the filing moves forward.',
      confirmLabel: 'Sign off',
    });
    if (!answer) return;
  } else {
    comment = await promptText({
      title: 'Ask for a correction',
      message: 'The report goes back to your accountant with what you say here.',
      label: 'What looks wrong?',
      placeholder: 'The March sales figure does not include the two credit notes.',
      confirmLabel: 'Send it back',
      tone: 'danger',
    });
    if (!comment) return;
  }

  try {
    await api.post(`/reports/${report.id}/sign-off`, { accepted, comment: comment || undefined });
    notify.success(accepted ? 'Signed off.' : 'Sent back for correction.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function regenerate(report, reload) {
  const answer = await confirm({
    title: 'Regenerate this report?',
    message: 'It is rebuilt from the current figures. Anything that has changed since it was produced will change here.',
    confirmLabel: 'Regenerate',
  });
  if (!answer) return;

  try {
    await api.post('/reports', {
      type: report.type,
      clientId: report.clientId ?? undefined,
      periodKey: report.periodKey,
      title: report.title,
    });
    notify.success('Regenerated.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
