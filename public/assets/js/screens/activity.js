/**
 * The activity log.
 *
 * What happened, in order, as a feed. This is the business record — uploads,
 * verifications, questions, approvals — and deliberately not the audit trail,
 * which lives at /audit, is hash-chained and is a different thing. The
 * difference is stated on the screen so nobody reaches for the wrong one.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import {
  pageHead, card, button, pill, avatar, emptyState, errorState, skeletonTable, banner,
} from '../core/ui.js';
import { selectFilter } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function activityScreen({ query }) {
  setBreadcrumbs([{ label: 'Activity' }]);

  const page = el('div.mm-page');
  const feedHost = el('div');
  const filterHost = el('div');

  const state = {
    clientId: query.get('clientId') ?? null,
    verb: query.get('verb') ?? null,
    page: 1,
    rows: [],
    meta: {},
  };

  const clients = session.can('clients.view') || session.can('clients.view.assigned')
    ? await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
    : [];

  async function load({ append = false } = {}) {
    if (!append) render(feedHost, skeletonTable(8, 2));
    try {
      const { data, meta } = await api.get('/activity', {
        clientId: state.clientId ?? undefined,
        verb: state.verb ?? undefined,
        page: state.page,
        pageSize: 50,
      });
      state.rows = append ? [...state.rows, ...(data ?? [])] : (data ?? []);
      state.meta = meta;
      paintFilters();
      paintFeed();
    } catch (err) {
      render(feedHost, errorState(err, { onRetry: () => load() }));
    }
  }

  function paintFilters() {
    render(filterHost, el('div.mm-row.mm-gap-2.mm-wrap',
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: state.clientId ?? '',
            onChange: (v) => {
              state.clientId = v;
              state.page = 1;
              router.setQuery({ clientId: v });
              load();
            },
          })
        : null,
      (state.meta.verbs ?? []).length
        ? selectFilter({
            label: 'Action',
            options: state.meta.verbs.map(v => ({ value: v.verb, label: `${fmt.label(v.verb)} (${v.count})` })),
            value: state.verb ?? '',
            onChange: (v) => {
              state.verb = v;
              state.page = 1;
              router.setQuery({ verb: v });
              load();
            },
          })
        : null));
  }

  function paintFeed() {
    if (!state.rows.length) {
      render(feedHost, emptyState({
        title: 'Nothing recorded yet',
        message: state.clientId || state.verb
          ? 'Nothing matches these filters. Clear them to see everything.'
          : 'Activity appears here as documents are uploaded, verified and filed.',
        icon: 'activity',
      }));
      return;
    }

    const groups = groupByDay(state.rows);
    const pagination = state.meta.pagination ?? {};

    render(feedHost,
      ...groups.map(([day, entries]) => el('section.mm-feed-day',
        el('h2.mm-feed-day__label', { text: day }),
        el('ol.mm-timeline',
          ...entries.map(entry => entryNode(entry))))),

      pagination.hasNext
        ? el('div.mm-row.mm-center.mm-mt-4',
            button(`Load more (${fmt.number(pagination.total - state.rows.length)} older)`, {
              variant: 'outline',
              onClick: () => { state.page += 1; load({ append: true }); },
            }))
        : el('p.mm-muted.mm-text-sm.mm-center.mm-mt-4', {
            text: `That is all ${fmt.plural(state.rows.length, 'entry', 'entries')}.`,
          }));
  }

  function entryNode(entry) {
    const body = el('div.mm-timeline__content',
      el('p.mm-timeline__title', { text: entry.summary }),
      el('p.mm-timeline__meta',
        entry.actorName
          ? el('span.mm-row.mm-gap-1.mm-center',
              avatar(entry.actorName, { size: 'xs' }),
              el('span', { text: entry.actorName }))
          : el('span', { text: 'The system' }),
        el('span', { text: '·' }),
        entry.clientName
          ? el('a.mm-link', { href: `/clients/${entry.clientId}`, text: entry.clientName })
          : null,
        entry.clientName ? el('span', { text: '·' }) : null,
        el('span', { title: fmt.dateTime(entry.createdAt), text: fmt.relative(entry.createdAt) }),
        entry.visibility === 'client' ? pill('Client saw this', 'info') : null));

    return el('li.mm-timeline__item',
      el('span.mm-timeline__dot', { class: `mm-timeline__dot--${entry.tone}` }),
      entry.path ? el('a.mm-timeline__link', { href: entry.path }, body) : body);
  }

  page.append(
    pageHead({
      title: 'Activity',
      subtitle: 'What happened across the practice, newest first.',
      actions: session.can('audit.view')
        ? button('Audit trail', { variant: 'ghost', icon: 'shield', href: '/audit' })
        : null,
    }),

    session.can('audit.view')
      ? banner({
          text: 'This is the working record of what people did. The audit trail is the tamper-evident one, and it is what an auditor should be shown.',
          tone: 'info',
          icon: 'info',
          action: { label: 'Open the audit trail', href: '/audit' },
        })
      : null,

    card({ body: filterHost }),
    feedHost);

  await load();
  return page;
}

/** Group a feed by calendar day, so the reader has landmarks. */
function groupByDay(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = new Date(row.createdAt);
    const key = Number.isNaN(date.getTime()) ? 'Unknown' : dayLabel(date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()];
}

function dayLabel(date) {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
}
