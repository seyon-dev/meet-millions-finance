/**
 * Payments.
 *
 * Every receipt and every attempt, including the ones that failed — a payment
 * screen that only lists successes is where "the client says they paid"
 * arguments start.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, notify, notifyError, promptText, banner,
} from '../../core/ui.js';
import { dataTable, selectFilter } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function paymentsScreen({ query }) {
  const forClient = session.isClient();
  setBreadcrumbs([{ label: 'Payments' }]);

  const page = el('div.mm-page');
  const noticeHost = el('div');

  // Which gateways a firm has connected is staff information, and the endpoint
  // is gated on `billing.view` / `integrations.view` accordingly. A client
  // holds neither, so asking for it here 403'd on every visit to
  // /client/payments — and the answer was never shown to them anyway: the
  // banner below is staff-only and the gateway filter needs the same data.
  const gateways = forClient
    ? []
    : await api.get('/billing/gateways').then(r => r.data ?? []).catch(() => []);
  const connected = gateways.filter(g => g.configured);

  if (!connected.length && !forClient) {
    render(noticeHost, banner({
      text: `No payment gateway is connected, so nothing can be collected online. ${gateways.length} are supported — ${gateways.slice(0, 3).map(g => g.name).join(', ')} and others.`,
      tone: 'info',
      icon: 'credit-card',
      action: session.can('integrations.manage')
        ? { label: 'Connect one', href: '/settings/integrations' }
        : null,
    }));
  }

  const table = dataTable({
    searchPlaceholder: 'Search by reference, receipt or client…',
    defaultSort: 'created_at',
    filters: (apply, active) => [
      selectFilter({
        label: 'Status',
        options: ['success', 'pending', 'failed', 'refunded'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      selectFilter({
        label: 'Method',
        // Exactly the values the column allows. 'card' and 'netbanking' were
        // offered and match nothing — the schema says credit_card, debit_card
        // and net_banking.
        options: ['upi', 'credit_card', 'debit_card', 'net_banking', 'wallet',
          'emi', 'bank_transfer', 'cash', 'cheque']
          .map(m => ({ value: m, label: fmt.label(m) })),
        value: active.method ?? '',
        onChange: v => apply('method', v),
      }),
      connected.length
        ? selectFilter({
            label: 'Gateway',
            options: [...connected.map(g => ({ value: g.key, label: g.name })), { value: 'offline', label: 'Offline' }],
            value: active.gateway ?? '',
            onChange: v => apply('gateway', v),
          })
        : null,
    ].filter(Boolean),
    load: async (params) => {
      const { data, meta } = await api.get('/billing/payments', {
        clientId: query.get('clientId') ?? undefined,
        ...params,
      });
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'referenceNo',
        label: 'Payment',
        primary: true,
        render: row => el('div.mm-row.mm-gap-3',
          el('span.mm-list__icon', { class: toneFor(row.status) },
            icon(iconFor(row.status), { size: 'sm' })),
          el('div.mm-stack',
            el('span.mm-fw-medium.mm-mono', { text: row.referenceNo }),
            el('span.mm-muted.mm-text-xs', {
              text: [fmt.label(row.method), row.gateway !== 'offline' ? fmt.vendor(row.gateway) : 'Offline']
                .filter(Boolean).join(' · '),
            }))),
      },
      {
        key: 'invoiceNo',
        label: 'Invoice',
        hideOnMobile: true,
        render: row => (row.invoiceId
          ? el('a.mm-link.mm-mono.mm-text-sm', { href: `/billing/invoices/${row.invoiceId}`, text: row.invoiceNo })
          : null),
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
        key: 'amountPaise',
        label: 'Amount',
        align: 'right',
        render: row => el('div.mm-stack.mm-align-right',
          el('span.mm-numeric.mm-fw-medium', { text: row.amountFormatted ?? fmt.money(row.amountPaise) }),
          row.refundedPaise
            ? el('span.mm-c-warning.mm-text-xs', { text: `${fmt.money(row.refundedPaise)} refunded` })
            : null),
      },
      {
        key: 'status',
        label: 'Status',
        render: row => el('div.mm-stack',
          statusPill(row.status),
          row.failureReason
            ? el('span.mm-c-danger.mm-text-xs', { text: row.failureReason })
            : null),
      },
      { key: 'paidAt', label: 'When', format: 'relative' },
      {
        key: 'actions',
        label: '',
        align: 'right',
        render: row => (row.status === 'success'
          ? el('div.mm-row.mm-gap-1.mm-end',
              button('Receipt', {
                variant: 'ghost', size: 'sm',
                onClick: () => api.download(`/billing/payments/${row.id}/receipt`)
                  .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
                  .catch(notifyError),
              }),
              session.can('payments.refund') && row.amountPaise > (row.refundedPaise ?? 0)
                ? button('Refund', { variant: 'ghost', size: 'sm', onClick: () => refund(row, table) })
                : null)
          : null),
      },
    ].filter(Boolean),
    empty: {
      title: 'No payments recorded',
      message: forClient
        ? 'Payments you make appear here with their receipts.'
        : 'Collected payments and recorded bank transfers both appear here.',
      icon: 'rupee',
    },
  });

  page.append(
    pageHead({
      title: 'Payments',
      subtitle: forClient ? 'What you have paid, with receipts.' : 'Every attempt, successful or not.',
      actions: button('Invoices', { variant: 'ghost', icon: 'receipt', href: '/billing/invoices' }),
    }),
    noticeHost,
    card({ body: table.node, flush: true }));

  return page;
}

function toneFor(status) {
  return { success: 'mm-c-success', failed: 'mm-c-danger', refunded: 'mm-c-warning' }[status] ?? 'mm-muted';
}

function iconFor(status) {
  return { success: 'check-circle', failed: 'x-circle', refunded: 'refresh-cw' }[status] ?? 'clock';
}

async function refund(payment, table) {
  const reason = await promptText({
    title: `Refund ${payment.amountFormatted ?? fmt.money(payment.amountPaise)}?`,
    message: 'The refund is requested from the gateway. It reaches the payer on their own timescale, not ours.',
    label: 'Why is it being refunded?',
    placeholder: 'Billed twice for September.',
    confirmLabel: 'Refund it',
    tone: 'danger',
  });
  if (!reason) return;

  try {
    const { data } = await api.post(`/billing/payments/${payment.id}/refund`, { reason });
    notify.success(data?.message ?? 'Refund requested.');
    table.refresh();
  } catch (err) {
    notifyError(err);
  }
}
