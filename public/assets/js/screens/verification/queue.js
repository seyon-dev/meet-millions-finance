/**
 * The verification queue.
 *
 * The screen a finance executive lives in. Tabs are the five states from the
 * proposal, ordered oldest-SLA-first, and the row opens the workspace rather
 * than a detail page — because the point of this screen is to leave it.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, skeletonTiles,
  notify, notifyError, confirm, promptText,
} from '../../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function verificationQueueScreen({ query }) {
  setBreadcrumbs([{ label: 'Verification' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');

  let activeTab = query.get('tab') ?? 'pending';
  let tabs = [];

  render(tileHost, skeletonTiles(4));
  loadStats(tileHost);

  const table = dataTable({
    searchPlaceholder: 'Search by document, client or type…',
    defaultSort: 'sla_due_at',
    defaultDir: 'asc',
    selectable: session.can('documents.verify'),
    pageSize: 25,
    onRowClick: (row) => router.go(`/verification/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'SLA',
        options: [
          { value: 'breached', label: 'Past SLA' },
          { value: 'today', label: 'Due today' },
        ],
        value: active.sla ?? '',
        onChange: v => apply('sla', v),
      }),
      selectFilter({
        label: 'Priority',
        options: ['urgent', 'high', 'normal', 'low'].map(p => ({ value: p, label: fmt.label(p) })),
        value: active.priority ?? '',
        onChange: v => apply('priority', v),
      }),
      selectFilter({
        label: 'Assigned',
        options: [{ value: session.session().user?.id ?? 'me', label: 'To me' }],
        value: active.assignedTo ?? '',
        allLabel: 'Anyone',
        onChange: v => apply('assignedTo', v),
      }),
    ],
    toolbar: ({ refresh }) => [
      button('Refresh', { variant: 'ghost', icon: 'refresh', onClick: refresh }),
    ],
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
      const { data, meta } = await api.get('/verification/queue', { tab: activeTab, ...params });
      tabs = meta.tabs ?? tabs;
      paintTabs();
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'title',
        label: 'Document',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-filechip', { class: `mm-filechip--${row.typeCategory ?? 'other'}` },
            icon('file', { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.title }),
            el('span.mm-muted.mm-text-xs', {
              text: [row.typeName, fmt.period(row.periodKey)].filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'clientName',
        label: 'Client',
        render: row => (row.clientName
          ? el('div.mm-stack',
              el('span', { text: row.clientName }),
              el('span.mm-muted.mm-text-xs', { text: row.clientCode ?? '' }))
          : null),
      },
      {
        key: 'priority',
        label: 'Priority',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.priority && row.priority !== 'normal'
          ? pill(row.priority, row.priority === 'urgent' ? 'danger' : 'warning')
          : el('span.mm-muted', { text: '—' })),
      },
      {
        key: 'slaDueAt',
        label: 'SLA',
        render: row => (row.slaDueAt
          ? el('div.mm-stack',
              el('span.mm-text-xs', {
                class: row.slaBreached ? 'mm-c-danger mm-fw-medium' : 'mm-muted',
                text: row.slaBreached ? 'Past SLA' : (fmt.untilDays(row.slaDueAt)?.label ?? fmt.date(row.slaDueAt)),
              }),
              el('span.mm-muted.mm-text-xs', { text: fmt.dateTime(row.slaDueAt) }))
          : null),
      },
      {
        key: 'assigneeName',
        label: 'Assigned',
        hideOnMobile: true,
        render: row => (row.assigneeName
          ? el('span.mm-text-sm', { text: row.assigneeName })
          : el('span.mm-muted.mm-text-xs', { text: 'Unassigned' })),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
      { key: 'submittedAt', label: 'Waiting', format: 'relative', hideOnMobile: true },
    ],
    empty: {
      title: 'This queue is clear',
      message: 'Nothing is waiting in this state. Try another tab.',
      icon: 'check-circle',
    },
  });

  function paintTabs() {
    if (!tabs.length) return;
    render(tabHost, tabStrip({
      tabs: tabs.map(tab => ({ key: tab.key, label: tab.label, count: tab.count })),
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ tab: key === 'pending' ? null : key });
        table.state.page = 1;
        table.clearSelection();
        table.refresh();
      },
    }));
  }

  page.append(
    pageHead({
      title: 'Verification',
      subtitle: 'Everything waiting on a decision, oldest SLA first.',
      actions: button('All documents', { variant: 'ghost', icon: 'files', href: '/documents' }),
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

async function loadStats(host) {
  try {
    const { data } = await api.get('/verification/stats');
    render(host, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Pending review', value: fmt.number(data.pendingReview), icon: 'inbox' }),
      stat({ label: 'Under review', value: fmt.number(data.underReview), icon: 'clock' }),
      stat({
        label: 'Past SLA',
        value: fmt.number(data.slaBreached),
        icon: 'alert',
        tone: data.slaBreached > 0 ? 'danger' : null,
        caption: data.slaCompliancePct !== null
          ? `${fmt.percent(data.slaCompliancePct)} met over ${fmt.plural(data.slaSampleSize, 'decision')}`
          : 'No decisions recorded yet',
      }),
      stat({ label: 'Verified today', value: fmt.number(data.verifiedToday), icon: 'check-circle', tone: 'success' })));
  } catch {
    // The tiles are a summary of what the table already shows; if they fail,
    // the queue itself is still perfectly usable, so this stays quiet.
    render(host);
  }
}

async function bulkDecide(ids, decision, { clear, refresh }) {
  let notes = null;

  if (decision === 'reject') {
    notes = await promptText({
      title: `Reject ${fmt.plural(ids.length, 'document')}?`,
      message: 'Every client is told, with the reason you give here.',
      label: 'Reason',
      placeholder: 'The uploaded scan is unreadable — please send a clearer copy.',
      confirmLabel: 'Reject them',
      tone: 'danger',
    });
    if (!notes) return;
  } else {
    const answer = await confirm({
      title: `Verify ${fmt.plural(ids.length, 'document')}?`,
      message: 'They move to verified and each filing period is recalculated.',
      confirmLabel: 'Verify them',
    });
    if (!answer) return;
  }

  try {
    const { data } = await api.post('/verification/bulk', { documentIds: ids, decision, notes });
    if (data?.updated?.length) {
      notify.success(`${fmt.plural(data.updated.length, 'document')} ${decision === 'approve' ? 'verified' : 'rejected'}.`);
    }
    if (data?.skipped?.length) {
      notify.warning(`${fmt.plural(data.skipped.length, 'document')} unchanged — ${data.skipped[0].reason}`, {
        title: 'Some were skipped',
      });
    }
    clear();
    refresh();
  } catch (err) {
    notifyError(err);
  }
}
