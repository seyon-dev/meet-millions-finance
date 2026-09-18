/**
 * A filing period, rendered.
 *
 * The same panel serves the client portal and the staff client record: both
 * are asking "what is in this month and what is missing", and building it
 * twice is how the two views drift apart.
 */

import { el, frag } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as fmt from '../core/format.js';
import { card, statusPill, emptyState, button, kv } from '../core/ui.js';

/**
 * The ten-stage strip from the proposal.
 * `stages` comes from the server's own `buildStageProgress`.
 */
export function stageStrip(stages) {
  if (!stages?.length) return null;
  return el('ol.mm-steps.mm-steps--strip',
    ...stages.map(stage => el('li.mm-step', {
      class: stage.state === 'done' ? 'is-done' : stage.state === 'current' ? 'is-active' : '',
      title: stage.detail ?? stage.label,
    },
      el('span.mm-step__marker', stage.state === 'done'
        ? icon('check', { size: 'sm' })
        : el('span', { text: String(stage.no) })),
      el('span.mm-step__label', { text: stage.label }),
      el('span.mm-step__line', { 'aria-hidden': 'true' }))));
}

/** Header: which month, what state, how far along, when it is due. */
export function periodHeader(period, { stages = null } = {}) {
  const expected = Number(period.documents_expected) || 0;
  const verified = Number(period.documents_verified) || 0;
  const received = Number(period.documents_received) || 0;
  const pct = expected ? Math.round((verified / expected) * 100) : 0;
  const due = fmt.untilDays(period.due_date);

  return card({
    title: fmt.label(period.period_key),
    subtitle: period.due_date ? `Due ${fmt.date(period.due_date)}` : 'No due date set',
    actions: frag(
      statusPill(period.status),
      due ? el('span.mm-pill', { class: `mm-pill--${due.tone}`, text: due.label }) : null),
    body: frag(
      el('div.mm-row.mm-gap-3.mm-center',
        el('span.mm-progress',
          el('span.mm-progress__bar', {
            class: pct === 100 ? 'mm-progress__bar--success' : '',
            style: { width: `${pct}%` },
          })),
        el('span.mm-numeric.mm-fw-medium.mm-nowrap', { text: `${verified}/${expected}` })),
      el('div.mm-kvgrid.mm-mt-4',
        kv('Expected', expected || '—'),
        kv('Received', received || '—'),
        kv('Verified', verified || '—'),
        kv('Period', fmt.label(period.period_type ?? 'monthly'))),
      stages ? el('div.mm-mt-5', stageStrip(stages)) : null),
  });
}

/**
 * The checklist.
 *
 * Every row says what it is, whether it has arrived, and — when it has — links
 * to the document itself, so "is my purchase register in?" is one glance
 * rather than a search.
 */
export function checklistCard(items, { onUpload = null, uploadHref = null } = {}) {
  return card({
    title: 'Document checklist',
    subtitle: items.length
      ? `${items.filter(i => i.status === 'received' || i.status === 'verified').length} of ${items.length} in`
      : null,
    actions: uploadHref
      ? button('Upload', { variant: 'ghost', size: 'sm', icon: 'upload', href: uploadHref })
      : (onUpload ? button('Upload', { variant: 'ghost', size: 'sm', icon: 'upload', onClick: onUpload }) : null),
    flush: true,
    body: items.length
      ? el('ul.mm-list',
          ...items.map(item => el('li.mm-list__row',
            el('span.mm-list__icon', { class: checklistTone(item.status) },
              icon(checklistIcon(item.status), { size: 'sm' })),
            el('div.mm-list__main',
              item.doc_id
                ? el('a.mm-fw-medium', { href: `/documents/${item.doc_id}`, text: item.label ?? item.type_name })
                : el('span.mm-fw-medium', { text: item.label ?? item.type_name }),
              el('span.mm-muted.mm-text-xs', {
                text: [item.type_name, item.is_required ? 'Required' : 'Optional'].filter(Boolean).join(' · '),
              })),
            statusPill(item.document_status ?? item.status))))
      : emptyState({
          title: 'No checklist for this period',
          message: 'A checklist is created from the document types this client files.',
          icon: 'list',
          inline: true,
        }),
  });
}

/** Documents actually in the period, newest first. */
export function periodDocumentsCard(documents, { title = 'Documents in this period' } = {}) {
  return card({
    title,
    subtitle: documents.length ? fmt.plural(documents.length, 'document') : null,
    flush: true,
    body: documents.length
      ? el('ul.mm-list',
          ...documents.map(doc => el('li.mm-list__row',
            el('span.mm-list__icon.mm-muted', icon('file', { size: 'sm' })),
            el('a.mm-list__main', { href: `/documents/${doc.id}` },
              el('span.mm-fw-medium', { text: doc.title }),
              el('span.mm-muted.mm-text-xs', {
                text: [doc.type_name, fmt.relative(doc.created_at)].filter(Boolean).join(' · '),
              })),
            statusPill(doc.status))))
      : emptyState({
          title: 'Nothing uploaded for this period yet',
          icon: 'file',
          inline: true,
        }),
  });
}

/** Queries raised against the period. */
export function periodQueriesCard(queries) {
  return card({
    title: 'Questions raised',
    flush: true,
    body: queries.length
      ? el('ul.mm-list',
          ...queries.map(query => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/queries/${query.id}` },
              el('span.mm-fw-medium', { text: query.subject }),
              el('span.mm-muted.mm-text-xs', {
                text: [query.reference_no, fmt.relative(query.created_at)].filter(Boolean).join(' · '),
              })),
            statusPill(query.status))))
      : emptyState({ title: 'No questions on this period', icon: 'message-circle', inline: true }),
  });
}

/** Reports produced for the period. */
export function periodReportsCard(reports) {
  return card({
    title: 'Reports',
    flush: true,
    body: reports.length
      ? el('ul.mm-list',
          ...reports.map(report => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/reports/${report.id}` },
              el('span.mm-fw-medium', { text: report.title ?? fmt.label(report.report_type) }),
              el('span.mm-muted.mm-text-xs', { text: fmt.relative(report.created_at) })),
            statusPill(report.status))))
      : emptyState({ title: 'No report has been produced yet', icon: 'report', inline: true }),
  });
}

function checklistIcon(status) {
  if (status === 'verified' || status === 'received') return 'check-circle';
  if (status === 'rejected') return 'x-circle';
  if (status === 'query_raised') return 'message-circle';
  return 'file';
}

function checklistTone(status) {
  if (status === 'verified' || status === 'received') return 'mm-c-success';
  if (status === 'rejected') return 'mm-c-danger';
  if (status === 'query_raised') return 'mm-c-warning';
  return 'mm-muted';
}
