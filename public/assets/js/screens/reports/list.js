/**
 * Reports.
 *
 * A report here is a produced artefact with an approval state, not a live
 * query — which is why the list shows where each one has got to, and the
 * "produce" action asks what and for whom rather than opening a builder.
 */

import { el, frag, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, notify, notifyError, modal, lockedState,
} from '../../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const TABS = [
  { key: 'all', label: 'All', status: null },
  { key: 'draft', label: 'Draft', status: 'draft' },
  { key: 'pending_approval', label: 'Awaiting approval', status: 'pending_approval' },
  { key: 'client_review', label: 'With the client', status: 'client_review' },
  { key: 'approved', label: 'Approved', status: 'approved' },
];

export default async function reportsScreen({ query }) {
  const forClient = session.isClient();
  setBreadcrumbs([{ label: 'Reports' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');

  let activeTab = query.get('tab') ?? 'all';

  const [types, clients] = await Promise.all([
    api.get('/reports/types').then(r => r.data ?? []).catch(() => []),
    !forClient && (session.can('clients.view') || session.can('clients.view.assigned'))
      ? api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
      : Promise.resolve([]),
  ]);

  const table = dataTable({
    searchPlaceholder: 'Search by title or reference…',
    defaultSort: 'created_at',
    onRowClick: (row) => router.go(`/reports/${row.id}`),
    filters: (apply, active) => [
      types.length
        ? selectFilter({
            label: 'Type',
            options: types.map(t => ({ value: t.key, label: t.name })),
            value: active.type ?? '',
            onChange: v => apply('type', v),
          })
        : null,
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: active.clientId ?? '',
            onChange: v => apply('clientId', v),
          })
        : null,
    ].filter(Boolean),
    toolbar: ({ refresh }) => (session.can('reports.create')
      ? [button('Produce a report', {
          variant: 'primary', icon: 'report',
          onClick: () => produce(types, clients, refresh, query),
        })]
      : []),
    load: async (params) => {
      const tab = TABS.find(t => t.key === activeTab);
      const { data, meta } = await api.get('/reports', {
        status: tab?.status ?? undefined,
        clientId: query.get('clientId') ?? undefined,
        ...params,
      });
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'title',
        label: 'Report',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.title }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.referenceNo, fmt.label(row.type)].filter(Boolean).join(' · '),
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
              : el('span.mm-muted.mm-text-xs', { text: 'Firm-wide' })),
          },
      { key: 'periodKey', label: 'Period', format: 'label', hideOnMobile: true },
      {
        key: 'aiGenerated',
        label: '',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.aiGenerated ? pill('AI narrative', 'violet') : null),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      { key: 'generatedAt', label: 'Produced', sortable: true, format: 'relative' },
    ].filter(Boolean),
    empty: {
      title: 'No reports yet',
      message: forClient
        ? 'Reports your accountant shares with you appear here.'
        : 'Produce one from a finalised computation, or for the whole practice.',
      icon: 'report',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Draft', value: fmt.number(summary.draft ?? 0), icon: 'edit' }),
      stat({
        label: 'Awaiting approval',
        value: fmt.number(summary.pending_approval ?? 0),
        icon: 'clock',
        tone: (summary.pending_approval ?? 0) > 0 ? 'warning' : null,
      }),
      stat({ label: 'With the client', value: fmt.number(summary.client_review ?? 0), icon: 'users' }),
      stat({ label: 'Approved', value: fmt.number(summary.approved ?? 0), icon: 'check-circle', tone: 'success' })));
  }

  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: TABS.map(t => ({ key: t.key, label: t.label, count: null })),
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ tab: key === 'all' ? null : key });
        table.state.page = 1;
        table.refresh();
        paintTabs();
      },
    }));
  }

  paintTabs();

  page.append(
    pageHead({
      title: 'Reports',
      subtitle: forClient
        ? 'What your accountant has produced for you.'
        : 'Produced, reviewed, approved — and signed off by the client.',
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

/**
 * Produce a report.
 *
 * Types the caller is not permitted to generate are shown disabled with the
 * reason, rather than hidden — somebody who cannot produce a TDS return should
 * still know the product makes one.
 */
async function produce(types, clients, refresh, query) {
  const payload = await modal({
    title: 'Produce a report',
    description: 'Built from the figures already computed for the period you choose.',
    size: 'lg',
    body: ({ close }) => {
      const typeSelect = el('select.mm-select',
        ...types.map(type => el('option', {
          value: type.key,
          disabled: !type.available,
          text: type.available ? type.name : `${type.name} — needs ${type.needs.join(', ')}`,
        })));

      const clientSelect = el('select.mm-select',
        el('option', { value: '', text: 'Whole practice' }),
        ...clients.map(c => el('option', {
          value: c.id, text: c.displayName, selected: c.id === query.get('clientId'),
        })));

      const periodSelect = el('select.mm-select',
        ...recentPeriods().map(p => el('option', { value: p, text: fmt.label(p) })));

      const titleInput = el('input.mm-input', { placeholder: 'Leave blank for the standard title' });
      const narrative = el('input.mm-checkbox', { type: 'checkbox' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const chosen = types.find(t => t.key === typeSelect.value);
          if (!chosen?.available) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'You do not have permission to produce that report.',
            }));
            return;
          }
          if (chosen.scope === 'client' && !clientSelect.value) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: `A ${chosen.name} report is per client — choose one.`,
            }));
            return;
          }
          close({
            type: typeSelect.value,
            clientId: clientSelect.value || undefined,
            periodKey: periodSelect.value,
            title: titleInput.value.trim() || undefined,
            includeAiNarrative: narrative.checked,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Report' }), typeSelect),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), clientSelect),
          el('div.mm-field', el('label.mm-field__label', { text: 'Period' }), periodSelect)),
        el('div.mm-field', el('label.mm-field__label', { text: 'Title' }), titleInput),
        el('label.mm-switch.mm-mt-2',
          narrative,
          el('span.mm-switch__text',
            el('span', { text: 'Add a written summary' }),
            el('span.mm-muted.mm-text-xs.mm-block', {
              text: 'Generated from the figures. Needs the AI insights add-on and its credentials; without them the report is produced without it.',
            }))),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-5',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Produce it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/reports', payload);
    const id = data.report?.id;
    notify.success('Report produced.', {
      action: id ? { label: 'Open it', onClick: () => router.go(`/reports/${id}`) } : null,
    });
    refresh();
  } catch (err) {
    notifyError(err);
  }
}

function recentPeriods() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
