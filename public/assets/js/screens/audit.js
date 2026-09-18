/**
 * The audit trail.
 *
 * Every consequential action, hash-chained so that an edit or a deletion
 * anywhere breaks every link after it. The verification result is shown with
 * its own limitation stated: a hash chain proves nothing was altered or
 * removed from the middle, and cannot prove nothing was removed from the end.
 *
 * Nothing on this screen can change a record. There is no edit and no delete,
 * not even for a Super Admin.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, avatar, emptyState, errorState,
  notify, notifyError, modal, banner, lockedState,
} from '../core/ui.js';
import { dataTable, selectFilter } from '../components/table.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function auditScreen({ query }) {
  setBreadcrumbs([{ label: 'Audit trail' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const verifyHost = el('div');

  let filters = {};

  const table = dataTable({
    searchPlaceholder: 'Search by action, actor or record…',
    defaultSort: 'created_at',
    pageSize: 50,
    onRowClick: (row) => openEntry(row),
    filters: (apply, active) => [
      selectFilter({
        label: 'Category',
        options: Object.entries(filters.categories ?? {}).map(([value, label]) => ({ value, label })),
        value: active.category ?? '',
        onChange: v => apply('category', v),
      }),
      selectFilter({
        label: 'Severity',
        options: ['info', 'notice', 'warning', 'critical'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.severity ?? '',
        onChange: v => apply('severity', v),
      }),
      selectFilter({
        label: 'Outcome',
        options: ['success', 'failure', 'denied'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.result ?? '',
        onChange: v => apply('result', v),
      }),
    ],
    toolbar: () => (session.can('audit.export')
      ? [button('Export CSV', {
          variant: 'ghost', icon: 'download',
          onClick: () => api.download('/audit/export/csv', { fileName: 'audit-trail.csv' })
            .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
            .catch(notifyError),
        })]
      : []),
    load: async (params) => {
      const { data, meta } = await api.get('/audit', {
        entityType: query.get('entityType') ?? undefined,
        entityId: query.get('entityId') ?? undefined,
        ...params,
      });
      filters = meta.filters ?? filters;
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'action',
        label: 'What happened',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-list__icon', { class: severityTone(row.severity) },
            icon(severityIcon(row), { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium', { text: fmt.action(row.action) }),
            el('span.mm-muted.mm-text-xs', {
              text: [row.entity?.type ? fmt.label(row.entity.type) : null, row.entity?.label]
                .filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'actor',
        label: 'Who',
        render: row => (row.actor?.name
          ? el('div.mm-row.mm-gap-2.mm-center',
              avatar(row.actor.name, { size: 'xs' }),
              el('div.mm-stack',
                el('span.mm-text-sm', { text: row.actor.name }),
                el('span.mm-muted.mm-text-xs', { text: fmt.label(row.actor.role ?? row.actor.type) })))
          : el('span.mm-muted.mm-text-xs', { text: 'The system' })),
      },
      {
        key: 'category',
        label: 'Category',
        hideOnMobile: true,
        render: row => pill(row.category, 'neutral'),
      },
      {
        key: 'result',
        label: 'Outcome',
        align: 'center',
        render: row => (row.result === 'success'
          ? icon('check', { size: 'sm', className: 'mm-c-success', title: 'Succeeded' })
          : pill(row.result, row.result === 'denied' ? 'warning' : 'danger')),
      },
      { key: 'ip', label: 'From', hideOnMobile: true, render: row => (row.ip ? el('span.mm-mono.mm-text-xs', { text: row.ip }) : null) },
      { key: 'createdAt', label: 'When', format: 'datetime' },
    ],
    empty: {
      title: 'Nothing recorded yet',
      message: 'Every consequential action is written here as it happens.',
      icon: 'scroll-text',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Entries', value: fmt.number(summary.total ?? 0), icon: 'scroll-text' }),
      stat({
        label: 'Critical',
        value: fmt.number(summary.critical ?? 0),
        icon: 'alert',
        tone: (summary.critical ?? 0) > 0 ? 'danger' : null,
      }),
      stat({
        label: 'Refused',
        value: fmt.number(summary.denied ?? 0),
        icon: 'lock',
        caption: 'Actions somebody was not permitted',
      }),
      stat({
        label: 'Covers',
        value: summary.earliest ? fmt.date(summary.earliest) : '—',
        caption: summary.latest ? `to ${fmt.date(summary.latest)}` : null,
        icon: 'calendar',
      })));
  }

  page.append(
    pageHead({
      title: 'Audit trail',
      subtitle: 'Hash-chained, append-only, and not editable by anybody.',
      actions: button('Verify the chain', { variant: 'primary', icon: 'shield', onClick: () => verify(verifyHost) }),
    }),
    verifyHost,
    tileHost,
    card({ body: table.node, flush: true }));

  return page;
}

function severityTone(severity) {
  return {
    critical: 'mm-c-danger', warning: 'mm-c-warning', notice: 'mm-c-brand',
  }[severity] ?? 'mm-muted';
}

function severityIcon(row) {
  if (row.result === 'denied') return 'lock';
  if (row.result === 'failure') return 'x-circle';
  return {
    critical: 'alert', warning: 'alert', notice: 'info',
  }[row.severity] ?? 'check-circle';
}

/**
 * Verify the chain.
 *
 * Reports what it checked, where it first diverges if it does, and — stated
 * rather than implied — the one thing a hash chain cannot tell you.
 */
async function verify(host) {
  render(host, card({
    body: el('div.mm-row.mm-gap-3.mm-center',
      el('span.mm-spinner'),
      el('span', { text: 'Re-deriving the chain from the stored rows…' })),
  }));

  try {
    const { data } = await api.get('/audit/verify');

    render(host, card({
      className: data.valid ? '' : 'mm-card--danger',
      title: data.valid ? 'The chain holds' : 'The chain is broken',
      actions: pill(data.valid ? 'Intact' : 'Broken', data.valid ? 'success' : 'danger'),
      body: frag(
        el('p.mm-prose', {
          text: data.valid
            ? `${fmt.plural(data.checked, 'entry', 'entries')} checked, sequence ${fmt.number(data.firstSequence)} to ${fmt.number(data.lastSequence)}. Every entry's hash matches the one before it.`
            : `The chain first diverges at sequence ${fmt.number(data.brokenAt)}. ${data.reason ?? ''}`,
        }),

        data.explanation ? el('p.mm-muted.mm-text-sm.mm-mt-2', { text: data.explanation }) : null,

        // The honest caveat, always shown — including when the chain holds.
        data.limitation
          ? banner({ text: data.limitation, tone: 'info', icon: 'info' })
          : null,

        el('p.mm-muted.mm-text-xs.mm-mt-3', { text: `Checked ${fmt.dateTime(data.checkedAt)}.` })),
    }));

    if (data.valid) notify.success('The chain verifies.');
    else notify.error(`Broken at sequence ${data.brokenAt}.`, { title: 'The audit trail has been altered' });
  } catch (err) {
    render(host, errorState(err, { onRetry: () => verify(host) }));
  }
}

/** One entry, in full, including what changed. */
async function openEntry(entry) {
  let full = entry;
  try {
    ({ data: full } = await api.get(`/audit/${entry.id}`));
    full = full.entry ?? full;
  } catch {
    // The row from the list is enough to show; a failed fetch of the detail
    // should not stop somebody reading what they clicked on.
  }

  await modal({
    title: fmt.action(full.action),
    description: [full.entity?.type ? fmt.label(full.entity.type) : null, full.entity?.label]
      .filter(Boolean).join(' · ') || null,
    size: 'lg',
    body: ({ close }) => frag(
      el('div.mm-kvgrid',
        kv('When', fmt.dateTime(full.createdAt)),
        kv('Sequence', full.sequence, { mono: true }),
        kv('Who', full.actor?.name ?? 'The system'),
        kv('Their role', full.actor?.role ? fmt.label(full.actor.role) : null),
        kv('Category', fmt.label(full.category)),
        kv('Severity', fmt.label(full.severity)),
        kv('Outcome', fmt.label(full.result)),
        kv('From', full.ip, { mono: true }),
        kv('Request', full.requestId, { mono: true }),
        kv('Kept until', full.retainUntil ? fmt.date(full.retainUntil) : null)),

      full.oldValue || full.newValue
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'What changed' }),
            el('div.mm-grid.mm-grid-2.mm-gap-3',
              el('div',
                el('p.mm-muted.mm-text-xs', { text: 'Before' }),
                el('pre.mm-code', { text: format(full.oldValue) })),
              el('div',
                el('p.mm-muted.mm-text-xs', { text: 'After' }),
                el('pre.mm-code', { text: format(full.newValue) }))))
        : null,

      full.metadata
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Context' }),
            el('pre.mm-code', { text: format(full.metadata) }))
        : null,

      el('h3.mm-label.mm-mt-4', { text: 'Chain' }),
      el('div.mm-kvgrid',
        kv('This entry', short(full.hash), { mono: true }),
        kv('The one before', short(full.prevHash), { mono: true })),
      el('p.mm-muted.mm-text-xs.mm-mt-2', {
        text: 'The hash covers every stored field of this entry plus the previous entry’s hash, so changing any of them breaks every link that follows.',
      }),

      el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
        full.entity?.id
          ? el('a.mm-btn.mm-btn--ghost', {
              href: entityHref(full.entity),
              text: 'Open the record',
              onClick: () => close(null),
            })
          : null,
        el('button.mm-btn.mm-btn--primary', { type: 'button', text: 'Close', onClick: () => close(null) }))),
  });
}

function format(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function short(hash) {
  if (!hash) return '— (the first entry)';
  return `${String(hash).slice(0, 24)}…`;
}

function entityHref(entity) {
  return {
    client: `/clients/${entity.id}`,
    document: `/documents/${entity.id}`,
    query: `/queries/${entity.id}`,
    report: `/reports/${entity.id}`,
    invoice: `/billing/invoices/${entity.id}`,
    user: `/settings/users/${entity.id}`,
    call: `/calls/${entity.id}`,
  }[entity.type] ?? '#';
}
