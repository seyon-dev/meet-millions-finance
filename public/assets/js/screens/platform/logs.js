/**
 * System logs.
 *
 * Errors, warnings and slow requests from across the platform. Stack traces
 * are shown here and nowhere else: this whole module needs a platform
 * permission, and a stack trace inside a tenant's own interface would leak the
 * shape of everybody else's data.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState,
  notify, notifyError, modal,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function logsScreen({ query }) {
  setBreadcrumbs([{ label: 'Platform' }, { label: 'System logs' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');

  const table = dataTable({
    searchPlaceholder: 'Search the message or the path…',
    defaultSort: 'created_at',
    pageSize: 50,
    onRowClick: (row) => openLog(row),
    filters: (apply, active) => [
      selectFilter({
        label: 'Level',
        options: ['error', 'warn', 'info', 'debug'].map(l => ({ value: l, label: fmt.label(l) })),
        value: active.level ?? '',
        onChange: v => apply('level', v),
      }),
      selectFilter({
        label: 'Source',
        options: ['worker', 'cron', 'webhook', 'integration', 'queue']
          .map(s => ({ value: s, label: fmt.label(s) })),
        value: active.source ?? '',
        onChange: v => apply('source', v),
      }),
    ],
    load: async (params) => {
      const { data, meta } = await api.get('/platform/logs', {
        tenantId: query.get('tenantId') ?? undefined,
        ...params,
      });
      paintTiles(meta.last7Days);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'message',
        label: 'What happened',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-list__icon', { class: levelTone(row.level) },
            icon(levelIcon(row.level), { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: row.message }),
            el('span.mm-muted.mm-text-xs.mm-mono', {
              text: [row.event, row.path].filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'statusCode',
        label: 'Status',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.statusCode
          ? pill(String(row.statusCode), row.statusCode >= 500 ? 'danger' : row.statusCode >= 400 ? 'warning' : 'neutral')
          : null),
      },
      {
        key: 'durationMs',
        label: 'Took',
        align: 'right',
        hideOnMobile: true,
        render: row => (row.durationMs
          ? el('span.mm-numeric', {
              class: row.durationMs > 2000 ? 'mm-c-warning' : '',
              text: `${fmt.number(row.durationMs)}ms`,
            })
          : null),
      },
      {
        key: 'source',
        label: 'Source',
        hideOnMobile: true,
        render: row => pill(row.source, 'neutral'),
      },
      {
        key: 'tenantId',
        label: 'Organisation',
        hideOnMobile: true,
        render: row => (row.tenantId
          ? el('span.mm-mono.mm-text-xs', { text: row.tenantId.slice(-8) })
          : el('span.mm-muted.mm-text-xs', { text: 'Platform' })),
      },
      { key: 'createdAt', label: 'When', format: 'datetime' },
    ],
    empty: {
      title: 'Nothing logged',
      message: 'Errors, warnings and slow requests appear here as they happen.',
      icon: 'terminal',
    },
  });

  function paintTiles(last7Days) {
    if (!last7Days) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({
        label: 'Errors this week',
        value: fmt.number(last7Days.error ?? 0),
        icon: 'x-circle',
        tone: (last7Days.error ?? 0) > 0 ? 'danger' : 'success',
      }),
      stat({
        label: 'Warnings',
        value: fmt.number(last7Days.warn ?? 0),
        icon: 'alert',
        tone: (last7Days.warn ?? 0) > 0 ? 'warning' : null,
      }),
      stat({ label: 'Info', value: fmt.number(last7Days.info ?? 0), icon: 'info' }),
      stat({ label: 'Debug', value: fmt.number(last7Days.debug ?? 0), icon: 'terminal' })));
  }

  page.append(
    pageHead({
      title: 'System logs',
      subtitle: 'Across the whole platform, for the last seven days and beyond.',
    }),
    tileHost,
    card({ body: table.node, flush: true }));

  return page;
}

function levelTone(level) {
  return { error: 'mm-c-danger', warn: 'mm-c-warning', info: 'mm-c-brand' }[level] ?? 'mm-muted';
}

function levelIcon(level) {
  return { error: 'x-circle', warn: 'alert', info: 'info' }[level] ?? 'terminal';
}

async function openLog(log) {
  await modal({
    title: log.message,
    description: [fmt.label(log.level), log.source, log.event].filter(Boolean).join(' · '),
    size: 'lg',
    body: ({ close }) => frag(
      el('div.mm-kvgrid',
        kv('When', fmt.dateTime(log.createdAt)),
        kv('Level', fmt.label(log.level)),
        kv('Source', fmt.label(log.source)),
        kv('Path', log.path, { mono: true }),
        kv('Status', log.statusCode),
        kv('Took', log.durationMs ? `${fmt.number(log.durationMs)}ms` : null),
        kv('Organisation', log.tenantId, { mono: true }),
        kv('Request', log.requestId, { mono: true })),

      log.context
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Context' }),
            el('pre.mm-code', { text: JSON.stringify(log.context, null, 2) }))
        : null,

      log.stack
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Stack' }),
            el('pre.mm-code', { text: log.stack }))
        : null,

      el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
        log.requestId
          ? el('button.mm-btn.mm-btn--ghost', {
              type: 'button', text: 'Copy the request id',
              onClick: () => { navigator.clipboard?.writeText(log.requestId); notify.success('Copied.'); },
            })
          : null,
        log.tenantId
          ? el('a.mm-btn.mm-btn--ghost', {
              href: `/platform/organisations?q=${encodeURIComponent(log.tenantId)}`,
              text: 'Find the organisation',
              onClick: () => close(null),
            })
          : null,
        el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
  });
}
