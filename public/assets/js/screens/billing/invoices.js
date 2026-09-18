/**
 * Invoices.
 *
 * Two directions live here: what the practice bills its clients, and what the
 * platform bills the practice. They are filtered rather than split, because
 * "what is outstanding" is one question and a finance person asks it once.
 */

import { el, frag, render } from '../../core/dom.js';
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
  { key: 'all', label: 'All', status: null },
  { key: 'outstanding', label: 'Outstanding', status: 'issued,sent,partially_paid,overdue' },
  { key: 'overdue', label: 'Overdue', status: 'overdue' },
  { key: 'paid', label: 'Paid', status: 'paid' },
  { key: 'draft', label: 'Draft', status: 'draft' },
];

export default async function invoicesScreen({ query }) {
  const forClient = session.isClient();
  setBreadcrumbs([{ label: 'Invoices' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');

  let activeTab = query.get('tab') ?? 'all';

  const clients = !forClient && (session.can('clients.view') || session.can('clients.view.assigned'))
    ? await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
    : [];

  const table = dataTable({
    searchPlaceholder: 'Search by invoice number or client…',
    defaultSort: 'issue_date',
    onRowClick: (row) => router.go(`/billing/invoices/${row.id}`),
    filters: (apply, active) => [
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: active.clientId ?? '',
            onChange: v => apply('clientId', v),
          })
        : null,
      !forClient
        ? selectFilter({
            label: 'Direction',
            options: [
              { value: 'tenant_to_client', label: 'Billed to clients' },
              { value: 'platform_to_tenant', label: 'Billed to us' },
            ],
            value: active.direction ?? '',
            onChange: v => apply('direction', v),
          })
        : null,
    ].filter(Boolean),
    toolbar: ({ refresh }) => (session.can('invoices.create')
      ? [button('New invoice', {
          variant: 'primary', icon: 'plus',
          onClick: () => createInvoice(clients, refresh),
        })]
      : []),
    load: async (params) => {
      const tab = TABS.find(t => t.key === activeTab);
      const { data, meta } = await api.get('/billing/invoices', {
        status: tab?.status ?? undefined,
        clientId: query.get('clientId') ?? undefined,
        ...params,
      });
      paintTiles(meta.summary);
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'invoiceNo',
        label: 'Invoice',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium.mm-mono', { text: row.invoiceNo }),
          el('span.mm-muted.mm-text-xs', {
            text: [fmt.label(row.kind), fmt.date(row.issueDate)].filter(Boolean).join(' · '),
          })),
      },
      forClient
        ? null
        : {
            key: 'clientName',
            label: 'Billed to',
            render: row => (row.clientName
              ? el('a.mm-link', { href: `/clients/${row.clientId}`, text: row.clientName })
              : el('span.mm-muted.mm-text-xs', { text: row.billingName ?? 'The practice' })),
          },
      {
        key: 'totalPaise',
        label: 'Total',
        align: 'right',
        render: row => el('span.mm-numeric', { text: row.totalFormatted ?? fmt.money(row.totalPaise) }),
      },
      {
        key: 'amountDuePaise',
        label: 'Due',
        align: 'right',
        render: row => el('span.mm-numeric', {
          class: row.amountDuePaise > 0 ? 'mm-fw-medium' : 'mm-muted',
          text: row.dueFormatted ?? fmt.money(row.amountDuePaise),
        }),
      },
      {
        key: 'dueDate',
        label: 'Due date',
        hideOnMobile: true,
        render: row => (row.dueDate
          ? el('span.mm-text-sm', {
              class: row.overdue ? 'mm-c-danger' : 'mm-muted',
              text: row.overdue ? `${fmt.date(row.dueDate)} — overdue` : fmt.date(row.dueDate),
            })
          : null),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
    ].filter(Boolean),
    empty: {
      title: 'No invoices',
      message: forClient
        ? 'Invoices from your accountant appear here.'
        : 'Raise one for a client, or wait for the platform to bill this practice.',
      icon: 'receipt',
    },
  });

  function paintTiles(summary) {
    if (!summary) return;
    render(tileHost, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Billed', value: fmt.moneyShort(summary.billedPaise ?? 0), icon: 'receipt' }),
      stat({ label: 'Collected', value: fmt.moneyShort(summary.collectedPaise ?? 0), icon: 'check-circle', tone: 'success' }),
      stat({
        label: 'Outstanding',
        value: fmt.moneyShort(summary.outstandingPaise ?? 0),
        icon: 'clock',
        tone: (summary.outstandingPaise ?? 0) > 0 ? 'warning' : null,
      }),
      stat({
        label: 'Overdue',
        value: fmt.moneyShort(summary.overduePaise ?? 0),
        icon: 'alert',
        tone: (summary.overduePaise ?? 0) > 0 ? 'danger' : null,
      })));
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
      title: 'Invoices',
      subtitle: forClient ? 'What you have been billed, and what is outstanding.' : 'Raised, sent, paid and overdue.',
      actions: button('Payments', { variant: 'ghost', icon: 'rupee', href: '/billing/payments' }),
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

/**
 * Raise an invoice.
 *
 * Line items are edited in place with a running total, so the figure being
 * agreed to is visible while it is being built rather than after it is saved.
 */
async function createInvoice(clients, refresh) {
  const payload = await modal({
    title: 'New invoice',
    size: 'lg',
    body: ({ close }) => {
      const clientSelect = el('select.mm-select',
        el('option', { value: '', text: 'Choose a client' }),
        ...clients.map(c => el('option', { value: c.id, text: c.displayName })));

      // The API takes payment terms in days and dates the invoice itself, so
      // that is what is asked for — a date picker here would be a field the
      // server then ignores.
      const dueInDays = el('select.mm-select',
        ...[0, 7, 15, 30, 45, 60].map(days => el('option', {
          value: String(days),
          selected: days === 15,
          text: days === 0 ? 'Due on receipt' : `Net ${days} days`,
        })));
      const notes = el('textarea.mm-input.mm-textarea', { rows: '2', placeholder: 'Anything to appear on the invoice' });

      const itemsHost = el('div.mm-stack.mm-gap-2');
      const totalNode = el('span.mm-numeric.mm-fw-medium', { text: fmt.money(0) });
      const errorHost = el('div');
      let items = [{ description: '', quantity: 1, unitPaise: 0, taxRatePct: 18 }];

      const recalculate = () => {
        const subtotal = items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitPaise), 0);
        const tax = items.reduce(
          (sum, i) => sum + Math.round((i.quantity * i.unitPaise * (i.taxRatePct ?? 0)) / 100), 0);
        totalNode.textContent = fmt.money(subtotal + tax);
      };

      const paintItems = () => {
        render(itemsHost, ...items.map((item, index) => el('div.mm-row.mm-gap-2.mm-wrap',
          el('input.mm-input', {
            placeholder: 'GST return filing — September',
            value: item.description,
            style: { flex: '3 1 200px' },
            onInput: (e) => { item.description = e.target.value; },
          }),
          el('input.mm-input', {
            type: 'number', min: '0.01', step: '0.01', value: String(item.quantity),
            'aria-label': 'Quantity',
            style: { flex: '0 0 84px' },
            onInput: (e) => { item.quantity = Number(e.target.value) || 0; recalculate(); },
          }),
          el('input.mm-input', {
            type: 'number', min: '0', step: '0.01', placeholder: 'Rate',
            'aria-label': 'Rate in rupees',
            style: { flex: '0 0 120px' },
            onInput: (e) => { item.unitPaise = Math.round((Number(e.target.value) || 0) * 100); recalculate(); },
          }),
          el('select.mm-select', {
            'aria-label': 'Tax rate',
            style: { flex: '0 0 96px' },
            onChange: (e) => { item.taxRatePct = Number(e.target.value); recalculate(); },
          },
            ...[0, 5, 12, 18, 28].map(rate => el('option', {
              value: String(rate), selected: rate === item.taxRatePct, text: `${rate}%`,
            }))),
          items.length > 1
            ? el('button.mm-iconbtn', {
                type: 'button', 'aria-label': 'Remove this line',
                onClick: () => { items = items.filter((_, i) => i !== index); paintItems(); recalculate(); },
              }, el('span', { text: '×' }))
            : null)));
      };

      paintItems();

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const usable = items.filter(i => i.description.trim() && i.unitPaise > 0);
          if (!clientSelect.value) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Choose a client.' }));
            return;
          }
          if (!usable.length) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Add at least one line with a description and a rate.',
            }));
            return;
          }
          close({
            clientId: clientSelect.value,
            dueInDays: Number(dueInDays.value),
            notes: notes.value.trim() || undefined,
            items: usable.map(i => ({
              description: i.description.trim(),
              quantity: i.quantity,
              unitPricePaise: i.unitPaise,
              taxRatePct: i.taxRatePct,
            })),
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), clientSelect),
        el('div.mm-field', el('label.mm-field__label', { text: 'Payment terms' }), dueInDays),

        el('h3.mm-label.mm-mt-4', { text: 'Lines' }),
        itemsHost,
        el('div.mm-row.mm-gap-3.mm-center.mm-mt-2',
          el('button.mm-btn.mm-btn--ghost.mm-btn--sm', {
            type: 'button', text: 'Add a line',
            onClick: () => { items.push({ description: '', quantity: 1, unitPaise: 0, taxRatePct: 18 }); paintItems(); },
          }),
          el('span.mm-grow'),
          el('span.mm-muted.mm-text-sm', { text: 'Total' }),
          totalNode),

        el('div.mm-field.mm-mt-4', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Raise it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/billing/invoices', payload);
    notify.success(`${data.invoice?.invoiceNo ?? 'Invoice'} raised.`, {
      action: data.invoice?.id
        ? { label: 'Open it', onClick: () => router.go(`/billing/invoices/${data.invoice.id}`) }
        : null,
    });
    refresh();
  } catch (err) {
    notifyError(err);
  }
}
