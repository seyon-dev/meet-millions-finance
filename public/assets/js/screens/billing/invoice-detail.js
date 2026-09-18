/**
 * One invoice.
 *
 * Reads like the document it is: who it is for, what it is for, what it comes
 * to, and what is still owed. Paying it is the primary action when anything
 * is outstanding, and recording an offline payment sits beside it because in
 * practice most of them arrive by bank transfer.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, modal, promptText, banner, skeletonTable,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function invoiceDetailScreen({ params }) {
  const page = el('div.mm-page');
  render(page, skeletonTable(6, 4));

  async function load() {
    try {
      const { data } = await api.get(`/billing/invoices/${params.id}`);
      setBreadcrumbs([
        { label: 'Invoices', href: '/billing/invoices' },
        { label: data.invoice.invoiceNo },
      ]);
      render(page, ...build(data, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, reload) {
  const { invoice, items, payments, client, gateways } = data;
  const outstanding = invoice.amountDuePaise > 0 && !['void', 'paid'].includes(invoice.status);

  return [
    pageHead({
      title: invoice.invoiceNo,
      subtitle: [client?.display_name ?? invoice.billingName, fmt.label(invoice.kind), `issued ${fmt.date(invoice.issueDate)}`]
        .filter(Boolean).join(' · '),
      actions: frag(
        statusPill(invoice.status),
        button('Download', {
          variant: 'ghost', icon: 'download',
          onClick: () => api.download(`/billing/invoices/${invoice.id}/pdf`)
            .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
            .catch(notifyError),
        }),
        outstanding && session.can('payments.record')
          ? button('Record a payment', {
              variant: 'ghost', icon: 'rupee',
              onClick: () => recordPayment(invoice, reload),
            })
          : null,
        outstanding && gateways?.length
          ? button('Pay now', { variant: 'primary', icon: 'credit-card', onClick: () => payNow(invoice, gateways, reload) })
          : null,
        invoice.status !== 'void' && invoice.amountPaidPaise === 0 && session.can('invoices.void')
          ? button('Void', { variant: 'ghost', icon: 'x', onClick: () => voidInvoice(invoice, reload) })
          : null),
    }),

    invoice.overdue
      ? banner({
          text: `Overdue — it was due ${fmt.date(invoice.dueDate)}, ${fmt.plural(Math.abs(invoice.daysToDue ?? 0), 'day')} ago.`,
          tone: 'danger',
          icon: 'alert',
        })
      : null,

    outstanding && !gateways?.length && session.can('payments.record')
      ? banner({
          text: 'No payment gateway is connected, so this cannot be paid online. Record the payment here once it arrives by bank transfer.',
          tone: 'info',
          icon: 'info',
          action: session.can('integrations.manage')
            ? { label: 'Connect one', href: '/settings/integrations' }
            : null,
        })
      : null,

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        linesCard(invoice, items ?? []),
        paymentsCard(payments ?? [])),

      el('div.mm-stack.mm-gap-4',
        summaryCard(invoice),
        billedToCard(invoice, client))),
  ].filter(Boolean);
}

function linesCard(invoice, items) {
  const interState = (invoice.igstPaise ?? 0) > 0;

  return card({
    title: 'What this is for',
    flush: true,
    body: frag(
      el('div.mm-table-wrap',
        el('table.mm-table.mm-table--compact',
          el('thead',
            el('tr',
              el('th', { text: 'Description' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Qty' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Rate' }),
              el('th.mm-align-right.mm-hide-sm', { text: 'Tax' }),
              el('th.mm-align-right', { text: 'Amount' }))),
          el('tbody',
            ...items.map(item => el('tr',
              el('td',
                el('div.mm-stack',
                  el('span', { text: item.description }),
                  item.hsn_sac
                    ? el('span.mm-muted.mm-text-xs.mm-mono', { text: `HSN/SAC ${item.hsn_sac}` })
                    : null)),
              el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: String(item.quantity ?? 1) }),
              el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: fmt.money(item.unit_price_paise) }),
              el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: `${item.tax_rate_pct ?? 0}%` }),
              el('td.mm-align-right.mm-numeric', { text: fmt.money(item.line_total_paise ?? item.total_paise ?? 0) })))))),

      el('ul.mm-totals',
        el('li.mm-totals__row',
          el('span', { text: 'Subtotal' }),
          el('span.mm-numeric', { text: fmt.money(invoice.subtotalPaise) })),
        invoice.discountPaise
          ? el('li.mm-totals__row',
              el('span', { text: 'Discount' }),
              el('span.mm-numeric', { text: `− ${fmt.money(invoice.discountPaise)}` }))
          : null,
        interState
          ? el('li.mm-totals__row',
              el('span', { text: 'IGST' }),
              el('span.mm-numeric', { text: fmt.money(invoice.igstPaise) }))
          : frag(
              el('li.mm-totals__row',
                el('span', { text: 'CGST' }),
                el('span.mm-numeric', { text: fmt.money(invoice.cgstPaise) })),
              el('li.mm-totals__row',
                el('span', { text: 'SGST' }),
                el('span.mm-numeric', { text: fmt.money(invoice.sgstPaise) }))),
        el('li.mm-totals__row.is-emphasis',
          el('span', { text: 'Total' }),
          el('span.mm-numeric', { text: invoice.totalFormatted ?? fmt.money(invoice.totalPaise) })),
        invoice.amountPaidPaise
          ? el('li.mm-totals__row',
              el('span', { text: 'Paid' }),
              el('span.mm-numeric', { text: `− ${fmt.money(invoice.amountPaidPaise)}` }))
          : null,
        el('li.mm-totals__row.is-emphasis',
          el('span', { text: 'Outstanding' }),
          el('span.mm-numeric', { text: invoice.dueFormatted ?? fmt.money(invoice.amountDuePaise) }))),

      invoice.notes ? el('p.mm-muted.mm-text-sm.mm-mt-4', { text: invoice.notes }) : null,
      invoice.terms ? el('p.mm-muted.mm-text-xs.mm-mt-2', { text: invoice.terms }) : null),
  });
}

function paymentsCard(payments) {
  return card({
    title: 'Payments against this invoice',
    flush: true,
    body: payments.length
      ? el('ul.mm-list',
          ...payments.map(payment => el('li.mm-list__row',
            el('span.mm-list__icon', { class: payment.status === 'success' ? 'mm-c-success' : 'mm-muted' },
              icon(payment.status === 'success' ? 'check-circle' : 'clock', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: payment.amountFormatted ?? fmt.money(payment.amountPaise) }),
              el('span.mm-muted.mm-text-xs', {
                text: [
                  fmt.label(payment.method),
                  payment.gateway !== 'offline' ? fmt.vendor(payment.gateway) : null,
                  payment.receiptNo,
                  fmt.dateTime(payment.paidAt ?? payment.createdAt),
                ].filter(Boolean).join(' · '),
              }),
              payment.failureReason
                ? el('span.mm-c-danger.mm-text-xs', { text: payment.failureReason })
                : null),
            statusPill(payment.status),
            payment.status === 'success'
              ? button('Receipt', {
                  variant: 'ghost', size: 'sm',
                  onClick: () => api.download(`/billing/payments/${payment.id}/receipt`)
                    .then(({ fileName }) => notify.success(`Downloaded ${fileName}`))
                    .catch(notifyError),
                })
              : null)))
      : emptyState({ title: 'Nothing paid yet', icon: 'rupee', inline: true }),
  });
}

function summaryCard(invoice) {
  return card({
    title: 'Summary',
    body: el('div.mm-kvgrid',
      kv('Invoice number', invoice.invoiceNo, { mono: true }),
      kv('Kind', fmt.label(invoice.kind)),
      kv('Issued', fmt.date(invoice.issueDate)),
      kv('Due', fmt.date(invoice.dueDate)),
      kv('Paid on', invoice.paidAt ? fmt.dateTime(invoice.paidAt) : null),
      kv('Place of supply', invoice.placeOfSupply, { mono: true }),
      kv('Currency', invoice.currency),
      kv('Reminders sent', invoice.reminderCount || null)),
  });
}

function billedToCard(invoice, client) {
  return card({
    title: 'Billed to',
    body: el('div.mm-kvgrid',
      kv('Name', invoice.billingName ?? client?.display_name),
      kv('Email', invoice.billingEmail ?? client?.primary_contact_email),
      kv('GSTIN', invoice.billingGstin, { mono: true }),
      kv('Client code', client?.client_code, { mono: true })),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Start a gateway checkout.
 *
 * The order is created server-side and the gateway's own page takes over; no
 * card details ever touch this application.
 */
async function payNow(invoice, gateways, reload) {
  const gateway = gateways.length === 1
    ? gateways[0].key
    : await modal({
        title: 'How would you like to pay?',
        size: 'sm',
        body: ({ close }) => el('ul.mm-menu',
          ...gateways.map(g => el('li',
            el('button.mm-menu__item', {
              type: 'button',
              onClick: () => close(g.key),
            },
              el('div',
                el('span.mm-fw-medium', { text: g.name }),
                el('span.mm-muted.mm-text-xs.mm-block', { text: (g.methods ?? []).join(' · ') })))))),
      });
  if (!gateway) return;

  try {
    const { data } = await api.post('/billing/payments/checkout', {
      invoiceId: invoice.id,
      gateway,
      returnUrl: `${window.location.origin}/billing/invoices/${invoice.id}`,
    });

    const { runCheckout } = await import('../../core/checkout.js');
    const outcome = await runCheckout({
      payment: data.payment,
      checkout: data.checkout,
      invoice: data.invoice,
      returnUrl: `${window.location.origin}/billing/invoices/${invoice.id}`,
    });

    if (outcome.status === 'paid') {
      notify.success(outcome.message);
      await reload();
    } else if (outcome.status === 'failed') {
      notify.error(outcome.message);
      await reload();
    } else if (outcome.status === 'cancelled') {
      notify.info(outcome.message);
    } else {
      // Deliberately not "paid": the gateway has the money but our own
      // confirmation has not landed. The webhook settles it.
      notify.info(outcome.message, { title: 'Awaiting confirmation' });
      await reload();
    }
  } catch (err) {
    notifyError(err);
  }
}

async function recordPayment(invoice, reload) {
  const payload = await modal({
    title: 'Record a payment',
    description: `${invoice.dueFormatted ?? fmt.money(invoice.amountDuePaise)} is outstanding on ${invoice.invoiceNo}.`,
    body: ({ close }) => {
      const amount = el('input.mm-input', {
        type: 'number', min: '0.01', step: '0.01',
        value: String((invoice.amountDuePaise ?? 0) / 100),
      });
      const method = el('select.mm-select',
        ...['bank_transfer', 'upi', 'cheque', 'cash'].map(m => el('option', {
          value: m, text: fmt.label(m),
        })));
      const reference = el('input.mm-input', { placeholder: 'UTR / cheque number' });
      const paidAt = el('input.mm-input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
      const notes = el('textarea.mm-input.mm-textarea', { rows: '2' });
      const errorHost = el('div');

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          const paise = Math.round((Number(amount.value) || 0) * 100);
          if (paise <= 0) {
            errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: 'Enter the amount received.' }));
            return;
          }
          if (paise > invoice.amountDuePaise) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert',
              text: `That is more than the ${fmt.money(invoice.amountDuePaise)} outstanding.`,
            }));
            return;
          }
          close({
            invoiceId: invoice.id,
            amountPaise: paise,
            method: method.value,
            reference: reference.value.trim() || undefined,
            paidAt: paidAt.value || undefined,
            notes: notes.value.trim() || undefined,
          });
        },
      },
        errorHost,
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Amount (₹)' }), amount),
          el('div.mm-field', el('label.mm-field__label', { text: 'Method' }), method)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Reference' }), reference),
          el('div.mm-field', el('label.mm-field__label', { text: 'Received on' }), paidAt)),
        el('div.mm-field', el('label.mm-field__label', { text: 'Notes' }), notes),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Record it' })));
    },
  });
  if (!payload) return;

  try {
    await api.post('/billing/payments/record', payload);
    notify.success('Payment recorded.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function voidInvoice(invoice, reload) {
  const reason = await promptText({
    title: `Void ${invoice.invoiceNo}?`,
    message: 'The invoice stays on the record, marked void. Nothing is deleted.',
    label: 'Why is it being voided?',
    placeholder: 'Raised against the wrong client.',
    confirmLabel: 'Void it',
    tone: 'danger',
  });
  if (!reason) return;

  try {
    await api.post(`/billing/invoices/${invoice.id}/void`, { reason });
    notify.success('Voided.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
