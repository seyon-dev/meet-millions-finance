/**
 * The client portal's home screen.
 *
 * A client is not a CRM user: they have one question — "what do you still need
 * from me?" — and this screen answers it before anything else. The month's
 * checklist comes first, the open questions second, and everything else is
 * below the fold.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, statusPill, emptyState, errorState, skeletonTiles, button, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function clientDashboardScreen() {
  const page = el('div.mm-page');
  render(page, skeletonTiles(4));

  try {
    const { data } = await api.get('/dashboard');
    setBreadcrumbs([{ label: data.title ?? 'Your filings' }]);
    render(page, ...build(data));
  } catch (err) {
    render(page, errorState(err, { onRetry: () => window.location.reload() }));
  }
  return page;
}

function build(data) {
  const name = session.session().user?.fullName?.split(' ')[0];

  if (data.empty) {
    return [
      pageHead({ title: data.title ?? 'Your filings' }),
      emptyState({
        title: 'Your account is not linked to a company yet',
        message: data.message,
        icon: 'building',
      }),
    ];
  }

  return [
    pageHead({
      title: data.title ?? 'Your filings',
      subtitle: name ? `Hello ${name}. Here is where this month stands.` : null,
      actions: button('Upload documents', {
        variant: 'primary', icon: 'upload', href: '/client/upload',
      }),
    }),

    data.pendingChecklist?.length
      ? banner({
          text: `${fmt.plural(data.pendingChecklist.length, 'item')} still to send. Uploading them is what moves the month forward.`,
          tone: 'warning',
          icon: 'upload',
          action: { label: 'Upload now', href: '/client/upload' },
        })
      : null,

    tiles(data),
    data.currentPeriod ? currentPeriodCard(data.currentPeriod) : null,

    el('div.mm-grid.mm-grid-2.mm-gap-4',
      checklistCard(data.pendingChecklist ?? []),
      queriesCard(data.openQueries ?? [])),

    data.periods?.length ? periodsCard(data.periods) : null,
  ].filter(Boolean);
}

function tiles(data) {
  const list = [...(data.tiles ?? [])];
  if (data.outstandingPaise) {
    list.push({
      label: 'Outstanding',
      value: data.outstandingLabel ?? fmt.money(data.outstandingPaise),
      icon: 'rupee',
      tone: 'warning',
      route: '/client/invoices',
      caption: 'Invoices awaiting payment',
    });
  }
  if (!list.length) return null;

  return el('div.mm-grid.mm-grid-4.mm-gap-4',
    ...list.map(tile => stat({
      label: tile.label,
      value: tile.value,
      caption: tile.caption,
      icon: tile.icon,
      tone: tile.tone === 'default' ? null : tile.tone,
      href: tile.route,
    })));
}

/**
 * This month, as a progress bar and the ten stages beneath it.
 *
 * The stage strip is the same one the firm's own staff see. A client watching
 * their return move from "collecting" to "filed" is a client who does not
 * telephone to ask where it has got to.
 */
function currentPeriodCard(period) {
  const due = fmt.untilDays(period.dueDate);

  return card({
    title: `${fmt.period(period.label)} — ${fmt.label(period.status)}`,
    subtitle: period.dueDate
      ? `Due ${fmt.date(period.dueDate)}${due ? ` · ${due.label}` : ''}`
      : null,
    actions: statusPill(period.status),
    body: frag(
      el('div.mm-row.mm-gap-3.mm-center',
        el('span.mm-progress',
          el('span.mm-progress__bar', {
            class: period.progressPct === 100 ? 'mm-progress__bar--success' : '',
            style: { width: `${period.progressPct ?? 0}%` },
          })),
        el('span.mm-numeric.mm-fw-medium.mm-nowrap', {
          text: `${period.verified}/${period.expected}`,
        })),
      el('p.mm-muted.mm-text-sm.mm-mt-2', {
        text: period.expected
          ? `${period.verified} of ${period.expected} documents verified.`
          : 'No document checklist has been set for this period yet.',
      }),
      period.stages?.length
        ? el('ol.mm-steps.mm-steps--strip.mm-mt-4',
            ...period.stages.map(stage => el('li.mm-step', {
              class: stage.state === 'done' ? 'is-done' : stage.state === 'current' ? 'is-active' : '',
              title: stage.detail ?? '',
            },
              el('span.mm-step__marker', stage.state === 'done'
                ? icon('check', { size: 'sm' })
                : el('span', { text: String(stage.no) })),
              el('span.mm-step__label', { text: stage.label }),
              el('span.mm-step__line', { 'aria-hidden': 'true' }))))
        : null),
  });
}

function checklistCard(items) {
  return card({
    title: 'Still needed from you',
    subtitle: items.length ? 'Upload these and your accountant takes it from there.' : null,
    actions: items.length
      ? button('Upload', { variant: 'ghost', size: 'sm', icon: 'upload', href: '/client/upload' })
      : null,
    flush: true,
    body: items.length
      ? el('ul.mm-list',
          ...items.map(item => el('li.mm-list__row',
            el('span.mm-list__icon', { class: toneClass(item.status) },
              icon(item.status === 'rejected' ? 'alert' : 'file', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: item.label }),
              el('span.mm-muted.mm-text-xs', {
                text: [fmt.period(item.period), item.required ? 'Required' : 'Optional']
                  .filter(Boolean).join(' · '),
              })),
            statusPill(item.status),
            item.dueDate
              ? el('span.mm-text-xs.mm-nowrap.mm-muted', { text: fmt.date(item.dueDate) })
              : null)))
      : emptyState({
          title: 'Nothing outstanding',
          message: 'Everything asked for this month has been sent. We will let you know if anything else is needed.',
          icon: 'check-circle',
          inline: true,
        }),
  });
}

function queriesCard(queries) {
  return card({
    title: 'Questions about your documents',
    subtitle: queries.length ? 'Answering these unblocks your filing.' : null,
    actions: queries.length
      ? button('All questions', { variant: 'ghost', size: 'sm', href: '/client/queries' })
      : null,
    flush: true,
    body: queries.length
      ? el('ul.mm-list',
          ...queries.map(query => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/queries/${query.id}` },
              el('span.mm-fw-medium', { text: query.subject }),
              el('span.mm-muted.mm-text-xs', { text: fmt.relative(query.created_at) })),
            query.priority === 'high' || query.priority === 'urgent'
              ? statusPill(query.priority)
              : null,
            icon('chevron-right', { size: 'sm', className: 'mm-muted' }))))
      : emptyState({
          title: 'No open questions',
          message: 'Your accountant has not asked for anything further.',
          icon: 'message-circle',
          inline: true,
        }),
  });
}

function periodsCard(periods) {
  return card({
    title: 'Your filing history',
    flush: true,
    body: el('ul.mm-list',
      ...periods.map(period => el('li.mm-list__row',
        el('a.mm-list__main', { href: `/client/filings?period=${encodeURIComponent(period.label)}` },
          el('span.mm-fw-medium', { text: fmt.period(period.label) }),
          period.dueDate
            ? el('span.mm-muted.mm-text-xs', { text: `Due ${fmt.date(period.dueDate)}` })
            : null),
        statusPill(period.status)))),
  });
}

function toneClass(status) {
  if (status === 'rejected') return 'mm-c-danger';
  if (status === 'query_raised') return 'mm-c-warning';
  return 'mm-muted';
}
