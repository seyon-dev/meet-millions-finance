/**
 * Approvals.
 *
 * A manager's inbox. Each row carries enough of the report — client, period,
 * the headline figure — to be decided without opening it, because an approval
 * queue that forces a round trip per item is an approval queue that stays full.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as router from '../core/router.js';
import * as session from '../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, emptyState, errorState, skeletonTiles,
  notify, notifyError, promptText,
} from '../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../components/table.js';
import { rankBars } from '../components/charts.js';
import { setBreadcrumbs } from '../layout/shell.js';

const TABS = [
  { key: 'pending', label: 'Waiting on you', status: 'pending', mine: true },
  { key: 'all_pending', label: 'All pending', status: 'pending', mine: false },
  { key: 'approved', label: 'Approved', status: 'approved', mine: false },
  { key: 'rejected', label: 'Rejected', status: 'rejected', mine: false },
];

export default async function approvalsScreen({ query }) {
  setBreadcrumbs([{ label: 'Approvals' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');
  const sideHost = el('div');

  let activeTab = query.get('tab') ?? 'pending';

  render(tileHost, skeletonTiles(4));
  loadStats(tileHost, sideHost);

  const table = dataTable({
    search: false,
    defaultSort: 'requested_at',
    defaultDir: 'asc',
    onRowClick: (row) => (row.entityType === 'report' ? router.go(`/reports/${row.entityId}`) : null),
    filters: (apply, active) => [
      selectFilter({
        label: 'Stage',
        options: ['manager', 'partner', 'client'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.stage ?? '',
        onChange: v => apply('stage', v),
      }),
    ],
    load: async (params) => {
      const tab = TABS.find(t => t.key === activeTab);
      const { data, meta } = await api.get('/approvals', {
        status: tab?.status,
        mine: tab?.mine ? 'true' : undefined,
        ...params,
      });
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'report',
        label: 'What needs deciding',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.report?.title ?? `${fmt.label(row.entityType)} ${row.entityId.slice(-6)}` }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.report?.referenceNo, row.report?.clientName, fmt.period(row.report?.periodKey)]
              .filter(Boolean).join(' · '),
          })),
      },
      {
        key: 'figure',
        label: 'Headline figure',
        align: 'right',
        hideOnMobile: true,
        render: row => headlineFigure(row.report?.totals),
      },
      {
        key: 'stage',
        label: 'Stage',
        align: 'center',
        hideOnMobile: true,
        render: row => pill(row.stage, 'neutral'),
      },
      {
        key: 'requestedByName',
        label: 'Requested by',
        hideOnMobile: true,
        render: row => el('div.mm-stack',
          el('span.mm-text-sm', { text: row.requestedByName ?? '—' }),
          el('span.mm-muted.mm-text-xs', { text: fmt.relative(row.requestedAt) })),
      },
      {
        key: 'waitingSeconds',
        label: 'Waiting',
        render: row => (row.waitingSeconds === null
          ? statusPill(row.status)
          : el('span.mm-text-sm', {
              class: row.waitingSeconds > 172800 ? 'mm-c-warning' : '',
              text: fmt.duration(row.waitingSeconds),
            })),
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        render: row => (row.status === 'pending' && session.can('approvals.decide')
          ? el('div.mm-row.mm-gap-1.mm-end',
              button('Approve', {
                variant: 'primary', size: 'sm',
                onClick: () => decide(row, 'approve', table),
              }),
              button('Reject', {
                variant: 'ghost', size: 'sm',
                onClick: () => decide(row, 'reject', table),
              }))
          : null),
      },
    ],
    empty: {
      title: activeTab === 'pending' ? 'Nothing is waiting on you' : 'Nothing in this view',
      message: activeTab === 'pending'
        ? 'Reports submitted for your approval appear here.'
        : 'Try another tab.',
      icon: 'check-circle',
    },
  });

  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: TABS.map(t => ({ key: t.key, label: t.label, count: null })),
      active: activeTab,
      onChange: (key) => {
        activeTab = key;
        router.setQuery({ tab: key === 'pending' ? null : key });
        table.state.page = 1;
        table.refresh();
        paintTabs();
      },
    }));
  }

  paintTabs();

  page.append(
    pageHead({
      title: 'Approvals',
      subtitle: 'Reports submitted for a decision, oldest first.',
    }),
    tileHost,
    tabHost,
    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      card({ body: table.node, flush: true }),
      sideHost));

  return page;
}

/**
 * The one number that matters for the report type.
 *
 * Shown so a manager can sanity-check without opening the report; a figure
 * that looks wrong is exactly when they will open it.
 */
function headlineFigure(totals) {
  if (!totals || typeof totals !== 'object') return null;
  const candidates = [
    ['netPayablePaise', 'Net payable'],
    ['tdsDeductedPaise', 'TDS'],
    ['collectedPaise', 'Collected'],
    ['outstandingPaise', 'Outstanding'],
    ['totalPaise', 'Total'],
  ];
  const found = candidates.find(([key]) => typeof totals[key] === 'number');
  if (!found) return null;

  return el('div.mm-stack.mm-align-right',
    el('span.mm-numeric.mm-fw-medium', { text: fmt.money(totals[found[0]]) }),
    el('span.mm-muted.mm-text-xs', { text: found[1] }));
}

async function loadStats(tileHost, sideHost) {
  try {
    const { data } = await api.get('/approvals/stats');

    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({
        label: 'Awaiting approval',
        value: fmt.number(data.awaitingApproval),
        icon: 'stamp',
        tone: data.awaitingApproval > 0 ? 'warning' : null,
      }),
      stat({ label: 'Approved this month', value: fmt.number(data.approvedMtd), icon: 'check-circle', tone: 'success' }),
      stat({ label: 'Reports waiting', value: fmt.number(data.reportsAwaiting), icon: 'report' }),
      stat({
        label: 'Collected this month',
        value: data.revenueMtdFormatted ?? fmt.money(data.revenueMtdPaise),
        icon: 'rupee',
        caption: fmt.period(data.periodKey),
      })));

    render(sideHost, el('div.mm-stack.mm-gap-4',
      card({
        title: 'Executive performance',
        subtitle: 'Verified this month',
        body: rankBars({
          rows: (data.executivePerformance ?? []).map(person => ({
            label: person.name,
            value: person.verified ?? person.documents ?? 0,
            valueLabel: [
              person.verified !== undefined ? `${person.verified} verified` : null,
              person.pastSla ? `${person.pastSla} past SLA` : null,
            ].filter(Boolean).join(' · ') || undefined,
            tone: person.pastSla > 0 ? 'warning' : undefined,
          })),
          emptyMessage: 'Nobody has verified anything this month yet.',
        }),
      }),
      (data.pendingReports ?? []).length
        ? card({
            title: 'Reports waiting on you',
            flush: true,
            body: el('ul.mm-list',
              ...data.pendingReports.map(report => el('li.mm-list__row',
                el('a.mm-list__main', { href: `/reports/${report.id}` },
                  el('span.mm-fw-medium', { text: report.title }),
                  el('span.mm-muted.mm-text-xs', {
                    text: [report.clientName, fmt.relative(report.submittedAt ?? report.createdAt)]
                      .filter(Boolean).join(' · '),
                  })),
                icon('chevron-right', { size: 'sm', className: 'mm-muted' })))),
          })
        : null));
  } catch (err) {
    render(tileHost, errorState(err));
  }
}

async function decide(approval, decision, table) {
  const comment = await promptText({
    title: decision === 'approve' ? 'Approve this report' : 'Reject this report',
    message: decision === 'approve'
      ? `${approval.report?.title ?? 'It'} moves on to the next stage.`
      : 'It goes back to its author with your reason.',
    label: decision === 'approve' ? 'Note (optional)' : 'Why is it being rejected?',
    required: decision === 'reject',
    confirmLabel: decision === 'approve' ? 'Approve' : 'Reject',
    tone: decision === 'approve' ? 'primary' : 'danger',
  });
  if (comment === null) return;

  try {
    await api.post(`/approvals/${approval.id}/decide`, { decision, comment: comment || undefined });
    notify.success(decision === 'approve' ? 'Approved.' : 'Rejected.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
