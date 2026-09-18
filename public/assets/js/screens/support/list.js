/**
 * Support tickets.
 *
 * A firm's clients raise these, and a firm's own staff answer them. SLA is the
 * organising idea: the queue is ordered by what is closest to breaching, and a
 * breached ticket is marked rather than left to be noticed.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, notify, notifyError, modal,
} from '../../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const TABS = [
  { key: 'open', label: 'Open', status: 'open,in_progress,waiting_internal,reopened' },
  { key: 'waiting_customer', label: 'Waiting on the client', status: 'waiting_customer' },
  { key: 'resolved', label: 'Resolved', status: 'resolved,closed' },
  { key: 'all', label: 'Everything', status: null },
];

export default async function supportScreen({ query }) {
  const forClient = session.isClient();
  setBreadcrumbs([{ label: 'Support' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');

  let activeTab = query.get('tab') ?? 'open';
  let filters = {};

  const table = dataTable({
    searchPlaceholder: 'Search by subject, ticket number or client…',
    defaultSort: 'created_at',
    onRowClick: (row) => router.go(`/support/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Category',
        options: (filters.categories ?? []).map(c => ({ value: c, label: fmt.label(c) })),
        value: active.category ?? '',
        onChange: v => apply('category', v),
      }),
      selectFilter({
        label: 'Priority',
        options: (filters.priorities ?? []).map(p => ({ value: p, label: fmt.label(p) })),
        value: active.priority ?? '',
        onChange: v => apply('priority', v),
      }),
      !forClient
        ? selectFilter({
            label: 'Assigned',
            options: [
              { value: session.session().user?.id ?? '', label: 'To me' },
              { value: 'unassigned', label: 'Nobody' },
            ],
            value: active.assignedTo ?? '',
            allLabel: 'Anyone',
            onChange: v => apply('assignedTo', v),
          })
        : null,
    ].filter(Boolean),
    load: async (params) => {
      const tab = TABS.find(t => t.key === activeTab);
      const { data, meta } = await api.get('/support', { status: tab?.status ?? undefined, ...params });
      filters = {
        categories: meta.categories ?? filters.categories,
        priorities: meta.priorities ?? filters.priorities,
      };
      paintTiles(meta.summary, meta.slaHours);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'subject',
        label: 'Ticket',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.subject }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.ticketNo, fmt.label(row.category), row.channel ? fmt.label(row.channel) : null]
              .filter(Boolean).join(' · '),
          })),
      },
      forClient
        ? null
        : {
            key: 'clientName',
            label: 'Raised by',
            hideOnMobile: true,
            render: row => el('div.mm-stack',
              el('span.mm-text-sm', { text: row.raisedByName ?? '—' }),
              row.clientName
                ? el('a.mm-muted.mm-text-xs', { href: `/clients/${row.clientId}`, text: row.clientName })
                : null),
          },
      {
        key: 'priority',
        label: 'Priority',
        align: 'center',
        render: row => (row.priority && row.priority !== 'normal'
          ? pill(row.priority, row.priority === 'urgent' ? 'danger' : 'warning')
          : el('span.mm-muted', { text: '—' })),
      },
      {
        key: 'slaDueAt',
        label: 'SLA',
        render: row => slaCell(row),
      },
      forClient
        ? null
        : {
            key: 'assigneeName',
            label: 'Owner',
            hideOnMobile: true,
            render: row => (row.assigneeName
              ? el('span.mm-text-sm', { text: row.assigneeName })
              : el('span.mm-c-warning.mm-text-xs', { text: 'Unassigned' })),
          },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      { key: 'createdAt', label: 'Raised', format: 'relative' },
    ].filter(Boolean),
    empty: {
      title: activeTab === 'open' ? 'Nothing open' : 'Nothing in this view',
      message: forClient
        ? 'Raise a ticket if something is not working or you need help.'
        : 'Tickets your clients raise from their portal appear here.',
      icon: 'life-buoy',
    },
  });

  function paintTiles(summary, slaHours) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Open', value: fmt.number(summary.open ?? 0), icon: 'life-buoy' }),
      stat({
        label: 'Waiting on the client',
        value: fmt.number(summary.waitingOnClient ?? 0),
        icon: 'clock',
      }),
      stat({
        label: 'Past SLA',
        value: fmt.number(summary.slaBreached ?? 0),
        icon: 'alert',
        tone: (summary.slaBreached ?? 0) > 0 ? 'danger' : null,
        caption: slaHours ? `Urgent: ${slaHours.urgent}h · Normal: ${slaHours.normal}h` : null,
      }),
      stat({
        label: 'Unassigned',
        value: fmt.number(summary.unassigned ?? 0),
        icon: 'user-plus',
        tone: (summary.unassigned ?? 0) > 0 ? 'warning' : null,
      })));
  }

  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: TABS.map(t => ({ key: t.key, label: t.label, count: null })),
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ tab: key === 'open' ? null : key });
        table.state.page = 1;
        table.refresh();
        paintTabs();
      },
    }));
  }

  paintTabs();

  page.append(
    pageHead({
      title: 'Support',
      subtitle: forClient
        ? 'Ask us anything — we answer inside the SLA on your plan.'
        : 'What your clients need help with, ordered by what is closest to breaching.',
      actions: frag(
        !forClient && session.can('support.view')
          ? button('Performance', { variant: 'ghost', icon: 'bar-chart', onClick: () => openStats() })
          : null,
        session.can('support.create')
          ? button('Raise a ticket', { variant: 'primary', icon: 'plus', onClick: () => raise(table) })
          : null),
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

function slaCell(row) {
  if (['resolved', 'closed'].includes(row.status)) {
    return el('span.mm-muted.mm-text-xs', {
      text: row.resolvedAt ? `Resolved ${fmt.relative(row.resolvedAt)}` : '—',
    });
  }
  if (row.slaBreached) return pill('Breached', 'danger');
  if (!row.slaDueAt) return el('span.mm-muted', { text: '—' });

  const until = fmt.untilDays(row.slaDueAt);
  return el('span.mm-text-xs', {
    class: until?.tone === 'warning' ? 'mm-c-warning' : 'mm-muted',
    title: fmt.dateTime(row.slaDueAt),
    text: until?.label ?? fmt.date(row.slaDueAt),
  });
}

async function raise(table) {
  const clients = session.isClient()
    ? []
    : await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => []);

  const payload = await modal({
    title: 'Raise a ticket',
    body: ({ close }) => {
      const subject = el('input.mm-input', { placeholder: 'Cannot upload a large scanned ledger' });
      const description = el('textarea.mm-input.mm-textarea', {
        rows: '5', placeholder: 'What were you doing, what happened, and what did you expect?',
      });
      const category = el('select.mm-select',
        ...['technical', 'billing', 'document', 'filing', 'account', 'feature_request', 'bug', 'general', 'other']
          .map(c => el('option', { value: c, selected: c === 'technical', text: fmt.label(c) })));
      const priority = el('select.mm-select',
        ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
          value: p, selected: p === 'normal', text: fmt.label(p),
        })));
      const client = clients.length
        ? el('select.mm-select',
            el('option', { value: '', text: 'Not about a client' }),
            ...clients.map(c => el('option', { value: c.id, text: c.displayName })))
        : null;
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!subject.value.trim() || !description.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'A ticket needs a subject and a description.',
            }));
            return;
          }
          close({
            subject: subject.value.trim(),
            description: description.value.trim(),
            category: category.value,
            priority: priority.value,
            clientId: client?.value || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Subject' }), subject),
        el('div.mm-field', el('label.mm-field__label', { text: 'What is happening?' }), description),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Category' }), category),
          el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority)),
        client ? el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), client) : null,
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Raise it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/support', payload);
    notify.success(`${data.ticket?.ticketNo ?? 'Ticket'} raised.`, {
      action: data.ticket?.id
        ? { label: 'Open it', onClick: () => router.go(`/support/${data.ticket.id}`) }
        : null,
    });
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}

/** How support is actually performing, from the tickets themselves. */
async function openStats() {
  try {
    const { data } = await api.get('/support/stats/overview');
    const { rankBars } = await import('../../components/charts.js');

    await modal({
      title: 'Support performance',
      description: 'Measured from the tickets themselves, not from a target.',
      size: 'lg',
      body: ({ close }) => frag(
        el('div.mm-grid.mm-grid-4.mm-gap-3',
          stat({ label: 'Tickets', value: fmt.number(data.totals.total), icon: 'life-buoy' }),
          stat({ label: 'Resolved', value: fmt.number(data.totals.resolved), icon: 'check-circle', tone: 'success' }),
          stat({
            label: 'Past SLA',
            value: fmt.number(data.totals.slaBreached),
            icon: 'alert',
            tone: data.totals.slaBreached ? 'danger' : null,
          }),
          stat({
            label: 'Rating',
            value: data.totals.averageRating ? `${data.totals.averageRating.toFixed(1)}/5` : '—',
            caption: `${fmt.plural(data.totals.ratedTickets, 'rating')}`,
            icon: 'check',
          })),

        el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
          el('div',
            el('h3.mm-label', { text: 'First response' }),
            el('p.mm-figure__value', { text: data.responseTime.label ?? 'No data yet' }),
            el('p.mm-muted.mm-text-xs', {
              text: data.responseTime.count
                ? `Median across ${fmt.plural(data.responseTime.count, 'ticket')}`
                : 'Nothing has been replied to yet.',
            })),
          el('div',
            el('h3.mm-label', { text: 'Time to resolve' }),
            el('p.mm-figure__value', { text: data.resolutionTime.label ?? 'No data yet' }),
            el('p.mm-muted.mm-text-xs', {
              text: data.resolutionTime.count
                ? `Median across ${fmt.plural(data.resolutionTime.count, 'ticket')}`
                : 'Nothing has been resolved yet.',
            }))),

        el('h3.mm-label.mm-mt-4', { text: 'By category' }),
        rankBars({
          rows: (data.byCategory ?? []).map(c => ({ label: fmt.label(c.category), value: c.count })),
          emptyMessage: 'No tickets yet.',
        }),

        el('h3.mm-label.mm-mt-4', { text: 'By person' }),
        rankBars({
          rows: (data.byAgent ?? []).map(a => ({
            label: a.name,
            value: a.resolved ?? a.count ?? 0,
            valueLabel: a.resolved !== undefined ? `${a.resolved} resolved` : undefined,
          })),
          emptyMessage: 'Nobody has been assigned a ticket yet.',
        }),

        el('div.mm-row.mm-end.mm-mt-4',
          el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
    });
  } catch (err) {
    notifyError(err);
  }
}
