/**
 * Reconciliation.
 *
 * Answers one question before a return is filed: is anything missing from the
 * computation that should be in it? The findings are the point — a clean
 * result is stated plainly rather than shown as an empty table, because
 * "nothing found" and "nothing checked" must not look the same.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import {
  pageHead, card, kv, button, statusPill, pill, emptyState, errorState, banner, skeletonTable,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function reconciliationScreen({ query }) {
  setBreadcrumbs([{ label: 'Tax', href: '/tax' }, { label: 'Reconciliation' }]);

  const page = el('div.mm-page');
  const resultHost = el('div.mm-stack.mm-gap-4');

  const clients = await api.get('/clients', { pageSize: 200 })
    .then(r => r.data ?? [])
    .catch(() => []);

  const clientSelect = el('select.mm-select',
    el('option', { value: '', text: 'Choose a client' }),
    ...clients.map(c => el('option', {
      value: c.id, text: c.displayName, selected: c.id === query.get('clientId'),
    })));

  const periodSelect = el('select.mm-select',
    ...recentPeriods().map(p => el('option', {
      value: p, text: fmt.period(p), selected: p === query.get('periodKey'),
    })));

  const form = el('form.mm-row.mm-gap-3.mm-wrap.mm-center', {
    novalidate: true,
    onSubmit: (e) => { e.preventDefault(); run(); },
  },
    el('div.mm-field.mm-field--inline',
      el('label.mm-field__label', { text: 'Client' }), clientSelect),
    el('div.mm-field.mm-field--inline',
      el('label.mm-field__label', { text: 'Period' }), periodSelect),
    el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Reconcile' }));

  async function run() {
    if (!clientSelect.value) {
      render(resultHost, emptyState({
        title: 'Choose a client',
        message: 'Reconciliation compares one client’s documents against their computed figures for a period.',
        icon: 'compass',
      }));
      return;
    }

    router.setQuery({ clientId: clientSelect.value, periodKey: periodSelect.value });
    render(resultHost, skeletonTable(6, 3));

    try {
      const { data } = await api.get('/tax/reconciliation', {
        clientId: clientSelect.value,
        periodKey: periodSelect.value,
      });
      render(resultHost, ...result(data));
    } catch (err) {
      render(resultHost, errorState(err, { onRetry: run }));
    }
  }

  page.append(
    pageHead({
      title: 'Reconciliation',
      subtitle: 'What the documents say, against what the computation used.',
    }),
    card({ body: form }),
    resultHost);

  if (clientSelect.value) await run();
  else {
    render(resultHost, emptyState({
      title: 'Choose a client and a period',
      message: 'Reconciliation looks for verified documents with no tax lines, and tax lines on documents nobody has verified.',
      icon: 'compass',
    }));
  }

  return page;
}

function result(data) {
  return [
    data.reconciled
      ? banner({
          text: `${data.client.displayName} reconciles for ${fmt.period(data.periodKey)} — every verified document has tax lines, and every tax line sits on a verified document.`,
          tone: 'success',
          icon: 'check-circle',
        })
      : banner({
          text: `${fmt.plural(data.findings.length, 'discrepancy', 'discrepancies')} found. Each one changes the figures if it is not settled before filing.`,
          tone: data.findings.some(f => f.severity === 'critical') ? 'danger' : 'warning',
          icon: 'alert',
        }),

    data.findings.length ? findingsCard(data.findings) : null,
    computationsCard(data.computations ?? []),
    documentsCard(data.documents ?? []),
  ].filter(Boolean);
}

function findingsCard(findings) {
  return card({
    title: 'What was found',
    flush: true,
    body: el('ul.mm-list',
      ...findings.map(finding => el('li.mm-list__row',
        el('span.mm-list__icon', { class: finding.severity === 'critical' ? 'mm-c-danger' : 'mm-c-warning' },
          icon(finding.severity === 'critical' ? 'x-circle' : 'alert', { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: finding.message }),
          el('span.mm-muted.mm-text-xs', { text: fmt.label(finding.code) })),
        finding.documentId
          ? button('Open', { variant: 'ghost', size: 'sm', href: `/documents/${finding.documentId}` })
          : null))),
  });
}

function computationsCard(computations) {
  return card({
    title: 'Computations for this period',
    flush: true,
    body: computations.length
      ? el('ul.mm-list',
          ...computations.map(c => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/tax/${c.id}` },
              el('span.mm-fw-medium', { text: `${c.regime.toUpperCase()} — ${fmt.money(c.regime === 'gst' ? c.netPayablePaise : c.tdsDeductedPaise)}` }),
              el('span.mm-muted.mm-text-xs', {
                text: `${fmt.plural(c.lineCount ?? 0, 'line')} from ${fmt.plural(c.sourceDocumentCount ?? 0, 'document')} · computed ${fmt.relative(c.computedAt)}`,
              })),
            statusPill(c.status))))
      : emptyState({
          title: 'Nothing has been computed for this period',
          message: 'Run a computation from the tax screen once the documents are verified.',
          icon: 'calculator',
          inline: true,
        }),
  });
}

function documentsCard(documents) {
  return card({
    title: 'Documents in this period',
    subtitle: `${documents.length} in total`,
    flush: true,
    body: documents.length
      ? el('div.mm-table-wrap',
          el('table.mm-table.mm-table--compact',
            el('thead', el('tr',
              el('th', { text: 'Document' }),
              el('th.mm-hide-sm', { text: 'Type' }),
              el('th.mm-align-center', { text: 'GST lines' }),
              el('th.mm-align-center.mm-hide-sm', { text: 'TDS lines' }),
              el('th', { text: 'Status' }))),
            el('tbody',
              ...documents.map(doc => el('tr',
                el('td', el('a.mm-link', { href: `/documents/${doc.id}`, text: doc.title })),
                el('td.mm-hide-sm', { text: doc.type_name ?? '—' }),
                el('td.mm-align-center.mm-numeric', { text: String(doc.gst_lines ?? 0) }),
                el('td.mm-align-center.mm-hide-sm.mm-numeric', { text: String(doc.tds_lines ?? 0) }),
                el('td', statusPill(doc.status)))))))
      : emptyState({ title: 'No documents in this period', icon: 'files', inline: true }),
  });
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
