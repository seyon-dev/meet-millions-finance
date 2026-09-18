/**
 * Every document, filtered.
 *
 * The one screen a practice searches from, so the filters are the ones people
 * actually ask by: whose is it, what kind, which month, and what state is it
 * in. All four live in the URL.
 */

import { el, frag } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import * as fmt from '../../core/format.js';
import {
  pageHead, card, button, statusPill, notify, notifyError, confirm, promptText,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const STATUSES = [
  'pending', 'submitted', 'under_review', 'query_raised',
  'verified', 'rejected', 'approved', 'archived',
];

export default async function documentsScreen({ query }) {
  setBreadcrumbs([{ label: 'Documents' }]);

  const page = el('div.mm-page');

  // Loaded once for the filter dropdowns rather than per keystroke.
  const [types, clients] = await Promise.all([
    api.get('/documents/types/list').then(r => r.data ?? []).catch(() => []),
    session.can('clients.view') || session.can('clients.view.assigned')
      ? api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
      : Promise.resolve([]),
  ]);

  const table = dataTable({
    searchPlaceholder: 'Search by title, client or file name…',
    defaultSort: 'created_at',
    selectable: session.can('documents.verify'),
    onRowClick: (row) => router.go(`/documents/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Status',
        options: STATUSES.map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      types.length
        ? selectFilter({
            label: 'Type',
            options: types.map(t => ({ value: t.id, label: t.name })),
            value: active.typeId ?? '',
            onChange: v => apply('typeId', v),
          })
        : null,
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: active.clientId ?? query.get('clientId') ?? '',
            onChange: v => apply('clientId', v),
          })
        : null,
      selectFilter({
        label: 'Period',
        options: recentPeriods().map(p => ({ value: p, label: fmt.label(p) })),
        value: active.periodKey ?? '',
        onChange: v => apply('periodKey', v),
      }),
    ].filter(Boolean),
    toolbar: ({ refresh }) => [
      button('Refresh', { variant: 'ghost', icon: 'refresh', onClick: refresh }),
      session.can('documents.upload')
        ? button('Upload', { variant: 'primary', icon: 'upload', href: '/client/upload' })
        : null,
    ].filter(Boolean),
    bulkActions: (ids, { clear, refresh }) => [
      button(`Verify ${ids.length}`, {
        variant: 'primary', size: 'sm', icon: 'check',
        onClick: () => bulkDecide(ids, 'approve', { clear, refresh }),
      }),
      button('Reject', {
        variant: 'danger', size: 'sm', icon: 'x',
        onClick: () => bulkDecide(ids, 'reject', { clear, refresh }),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/documents', {
        clientId: query.get('clientId') ?? undefined,
        ...params,
      });
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'title',
        label: 'Document',
        primary: true,
        sortable: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-filechip', { class: `mm-filechip--${row.typeCategory ?? 'other'}` },
            icon('file', { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.title }),
            el('span.mm-muted.mm-text-xs', {
              text: [row.typeName, row.versionCount > 1 ? `v${row.versionCount}` : null]
                .filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'clientName',
        label: 'Client',
        hideOnMobile: true,
        render: row => (row.clientName
          ? el('a.mm-link', { href: `/clients/${row.clientId}`, text: row.clientName })
          : null),
      },
      { key: 'periodKey', label: 'Period', hideOnMobile: true, format: 'label' },
      {
        key: 'slaDueAt',
        label: 'SLA',
        hideOnMobile: true,
        render: row => slaCell(row),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      {
        key: 'createdAt',
        label: 'Uploaded',
        sortable: true,
        format: 'relative',
      },
    ],
    empty: {
      title: 'No documents yet',
      message: 'Documents appear here as soon as a client uploads them, or you add them for a client.',
      icon: 'files',
    },
  });

  page.append(
    pageHead({
      title: 'Documents',
      subtitle: 'Everything uploaded, in every state, across every client you can see.',
      actions: session.can('documents.verify')
        ? button('Verification queue', { variant: 'primary', icon: 'file-check', href: '/verification' })
        : null,
    }),
    card({ body: table.node, flush: true }));

  return page;
}

function slaCell(row) {
  if (!row.slaDueAt) return null;
  const settled = ['verified', 'approved', 'archived', 'rejected'].includes(row.status);
  if (settled) return el('span.mm-muted.mm-text-xs', { text: '—' });

  const until = fmt.untilDays(row.slaDueAt);
  return el('span.mm-text-xs', {
    class: until?.tone === 'danger' ? 'mm-c-danger' : until?.tone === 'warning' ? 'mm-c-warning' : 'mm-muted',
    title: fmt.dateTime(row.slaDueAt),
    text: until?.label ?? fmt.date(row.slaDueAt),
  });
}

/** The last twelve months, as period keys. */
function recentPeriods() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Verify or reject several documents at once.
 *
 * A rejection needs a reason — the same reason for all of them, which is why
 * it is asked for once rather than per document.
 */
async function bulkDecide(ids, decision, { clear, refresh }) {
  let notes = null;

  if (decision === 'reject') {
    notes = await promptText({
      title: `Reject ${fmt.plural(ids.length, 'document')}?`,
      message: 'Each client is told, with the reason you give. The same reason is recorded against every one of them.',
      label: 'Why are these being rejected?',
      placeholder: 'The GSTIN on the purchase invoices does not match the registration on file.',
      confirmLabel: 'Reject them',
      tone: 'danger',
    });
    if (!notes) return;
  } else {
    const answer = await confirm({
      title: `Verify ${fmt.plural(ids.length, 'document')}?`,
      message: 'They move to verified and their filing periods are recalculated.',
      confirmLabel: 'Verify them',
    });
    if (!answer) return;
  }

  try {
    const { data } = await api.post('/verification/bulk', { documentIds: ids, decision, notes });
    const updated = data?.updated?.length ?? 0;
    const skipped = data?.skipped ?? [];

    if (updated) {
      notify.success(`${fmt.plural(updated, 'document')} ${decision === 'approve' ? 'verified' : 'rejected'}.`);
    }
    if (skipped.length) {
      // Named rather than counted: "3 skipped" sends somebody hunting for
      // which three, and the reason is already known here.
      notify.warning(`${fmt.plural(skipped.length, 'document')} unchanged — ${skipped[0].reason}`, {
        title: 'Some were skipped',
      });
    }
    clear();
    refresh();
  } catch (err) {
    notifyError(err);
  }
}
