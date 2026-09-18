/**
 * Questions raised on documents.
 *
 * The same screen serves the firm and the client portal; the API narrows what
 * each can see, and the copy leans on "questions" rather than "queries"
 * because that is the word a client understands.
 */

import { el, frag } from '../../core/dom.js';
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
  { key: 'open', label: 'Open', statuses: 'open,awaiting_client,client_responded,under_review' },
  { key: 'awaiting_client', label: 'Waiting on client', statuses: 'awaiting_client' },
  { key: 'client_responded', label: 'Client replied', statuses: 'client_responded' },
  { key: 'resolved', label: 'Resolved', statuses: 'resolved' },
  { key: 'all', label: 'Everything', statuses: null },
];

export default async function queriesScreen({ query }) {
  const forClient = session.isClient();
  setBreadcrumbs([{ label: forClient ? 'Questions' : 'Queries' }]);

  const page = el('div.mm-page');
  const tabHost = el('div');
  const tileHost = el('div');

  let activeTab = query.get('tab') ?? 'open';

  const clients = !forClient && (session.can('clients.view') || session.can('clients.view.assigned'))
    ? await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
    : [];

  const table = dataTable({
    searchPlaceholder: 'Search by subject, reference or client…',
    defaultSort: 'created_at',
    onRowClick: (row) => router.go(`/queries/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Priority',
        options: ['urgent', 'high', 'normal', 'low'].map(p => ({ value: p, label: fmt.label(p) })),
        value: active.priority ?? '',
        onChange: v => apply('priority', v),
      }),
      selectFilter({
        label: 'Category',
        options: ['document', 'data', 'clarification', 'missing', 'mismatch', 'other']
          .map(c => ({ value: c, label: fmt.label(c) })),
        value: active.category ?? '',
        onChange: v => apply('category', v),
      }),
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: active.clientId ?? '',
            onChange: v => apply('clientId', v),
          })
        : null,
    ].filter(Boolean),
    load: async (params) => {
      const tab = TABS.find(t => t.key === activeTab);
      const { data, meta } = await api.get('/queries', {
        status: tab?.statuses ?? undefined,
        ...params,
      });
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'subject',
        label: 'Question',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.subject }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.referenceNo, row.documentTitle, fmt.label(row.category)]
              .filter(Boolean).join(' · '),
          })),
      },
      forClient
        ? null
        : {
            key: 'clientName',
            label: 'Client',
            hideOnMobile: true,
            render: row => (row.clientName
              ? el('a.mm-link', { href: `/clients/${row.clientId}`, text: row.clientName })
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
        key: 'replyCount',
        label: 'Replies',
        align: 'center',
        hideOnMobile: true,
        render: row => el('span.mm-numeric', { text: String(row.replyCount ?? 0) }),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      { key: 'updatedAt', label: 'Last activity', sortable: true, format: 'relative' },
    ].filter(Boolean),
    empty: {
      title: forClient ? 'No questions for you' : 'No queries in this view',
      message: forClient
        ? 'When your accountant needs something clarified, it appears here.'
        : 'Raise a question from the verification workspace when a document needs clarifying.',
      icon: 'message-circle',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    tileHost.replaceChildren(el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Open', value: fmt.number(summary.open ?? 0), icon: 'message-circle' }),
      stat({
        label: 'Waiting on client',
        value: fmt.number(summary.awaitingClient ?? 0),
        icon: 'clock',
        tone: (summary.awaitingClient ?? 0) > 0 ? 'warning' : null,
      }),
      stat({
        label: 'Client replied',
        value: fmt.number(summary.clientResponded ?? 0),
        icon: 'inbox',
        caption: 'Needs your attention',
      }),
      stat({ label: 'Resolved', value: fmt.number(summary.resolved ?? 0), icon: 'check-circle', tone: 'success' })));
  }

  function paintTabs() {
    tabHost.replaceChildren(tabStrip({
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
      title: forClient ? 'Questions about your documents' : 'Queries',
      subtitle: forClient
        ? 'Answering these is what unblocks your filing.'
        : 'Everything raised with a client and not yet settled.',
      actions: !forClient && session.can('queries.create')
        ? button('Raise a query', { variant: 'primary', icon: 'plus', onClick: () => raiseQuery(clients, table) })
        : null,
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

/** Raise a question outside the verification workspace. */
async function raiseQuery(clients, table) {
  const payload = await modal({
    title: 'Raise a query',
    description: 'The client is notified and can reply from their portal.',
    body: ({ close }) => {
      const client = el('select.mm-select', { required: true },
        el('option', { value: '', text: 'Choose a client' }),
        ...clients.map(c => el('option', { value: c.id, text: c.displayName })));
      const subject = el('input.mm-input', { placeholder: 'Bank statement for March is missing' });
      const body = el('textarea.mm-input.mm-textarea', {
        rows: '4', placeholder: 'Say exactly what you need and why.',
      });
      const category = el('select.mm-select',
        ...['clarification', 'document', 'data', 'missing', 'mismatch', 'other']
          .map(c => el('option', { value: c, text: fmt.label(c) })));
      const priority = el('select.mm-select',
        ...['low', 'normal', 'high', 'urgent'].map(p => el('option', {
          value: p, selected: p === 'normal', text: fmt.label(p),
        })));
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!client.value || !subject.value.trim() || !body.value.trim()) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Choose a client, and give the question a subject and a description.',
            }));
            return;
          }
          close({
            clientId: client.value,
            subject: subject.value.trim(),
            body: body.value.trim(),
            category: category.value,
            priority: priority.value,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), client),
        el('div.mm-field', el('label.mm-field__label', { text: 'Subject' }), subject),
        el('div.mm-field', el('label.mm-field__label', { text: 'What do you need?' }), body),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Category' }), category),
          el('div.mm-field', el('label.mm-field__label', { text: 'Priority' }), priority)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Send it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/queries', payload);
    notify.success(`${data.query.referenceNo} raised.`, {
      action: { label: 'Open it', onClick: () => router.go(`/queries/${data.query.id}`) },
    });
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
