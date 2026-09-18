/**
 * Tax computations.
 *
 * GST and TDS in one list because a practice thinks in periods, not regimes:
 * "what has September produced" is one question, and splitting it across two
 * screens makes it two.
 */

import { el, frag, render } from '../../core/dom.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as router from '../../core/router.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, skeletonTiles,
  notify, notifyError, modal, errorState,
} from '../../core/ui.js';
import { dataTable, selectFilter, tabStrip } from '../../components/table.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function taxScreen({ query }) {
  setBreadcrumbs([{ label: 'Tax' }]);

  const page = el('div.mm-page');
  const tileHost = el('div');
  const tabHost = el('div');

  let regime = query.get('regime') ?? 'gst';

  render(tileHost, skeletonTiles(4));
  loadSummary(tileHost, regime);

  const clients = session.can('clients.view') || session.can('clients.view.assigned')
    ? await api.get('/clients', { pageSize: 200 }).then(r => r.data ?? []).catch(() => [])
    : [];

  const table = dataTable({
    searchPlaceholder: 'Search by client or period…',
    defaultSort: 'created_at',
    onRowClick: (row) => router.go(`/tax/${row.id}`),
    filters: (apply, active) => [
      selectFilter({
        label: 'Status',
        options: ['draft', 'final', 'filed', 'superseded'].map(s => ({ value: s, label: fmt.label(s) })),
        value: active.status ?? '',
        onChange: v => apply('status', v),
      }),
      selectFilter({
        label: 'Period',
        options: recentPeriods().map(p => ({ value: p, label: fmt.label(p) })),
        value: active.periodKey ?? '',
        onChange: v => apply('periodKey', v),
      }),
      clients.length
        ? selectFilter({
            label: 'Client',
            options: clients.map(c => ({ value: c.id, label: c.displayName })),
            value: active.clientId ?? '',
            onChange: v => apply('clientId', v),
          })
        : null,
    ].filter(Boolean),
    toolbar: ({ refresh }) => [
      button('Reconciliation', { variant: 'ghost', icon: 'compass', href: '/tax/reconciliation' }),
      session.can('tax.calculate')
        ? button('Run a computation', {
            variant: 'primary', icon: 'calculator',
            onClick: () => runComputation(clients, refresh),
          })
        : null,
    ].filter(Boolean),
    load: async (params) => {
      const { data, meta } = await api.get('/tax/computations', { regime, ...params });
      return { rows: data ?? [], meta };
    },
    columns: [
      {
        key: 'clientName',
        label: 'Client',
        primary: true,
        render: row => el('div.mm-stack',
          el('span.mm-fw-medium', { text: row.clientName ?? '—' }),
          el('span.mm-muted.mm-text-xs', {
            text: [row.clientCode, fmt.label(row.periodKey)].filter(Boolean).join(' · '),
          })),
      },
      {
        key: 'taxableValuePaise',
        label: 'Taxable value',
        align: 'right',
        render: row => el('span.mm-numeric', { text: fmt.money(row.taxableValuePaise) }),
      },
      regime === 'gst'
        ? {
            key: 'totalTaxPaise',
            label: 'Tax',
            align: 'right',
            hideOnMobile: true,
            render: row => el('div.mm-stack.mm-align-right',
              el('span.mm-numeric', { text: fmt.money(row.totalTaxPaise) }),
              el('span.mm-muted.mm-text-xs', {
                text: row.igstPaise > 0
                  ? `IGST ${fmt.moneyShort(row.igstPaise)}`
                  : `CGST+SGST ${fmt.moneyShort(row.cgstPaise + row.sgstPaise)}`,
              })),
          }
        : {
            key: 'tdsDeductedPaise',
            label: 'TDS deducted',
            align: 'right',
            hideOnMobile: true,
            render: row => el('span.mm-numeric', { text: fmt.money(row.tdsDeductedPaise) }),
          },
      regime === 'gst'
        ? {
            key: 'itcTotalPaise',
            label: 'ITC',
            align: 'right',
            hideOnMobile: true,
            render: row => el('span.mm-numeric', { text: fmt.money(row.itcTotalPaise) }),
          }
        : {
            key: 'tdsDepositedPaise',
            label: 'Deposited',
            align: 'right',
            hideOnMobile: true,
            render: row => el('span.mm-numeric', { text: fmt.money(row.tdsDepositedPaise) }),
          },
      {
        key: 'netPayablePaise',
        label: regime === 'gst' ? 'Net payable' : 'Outstanding',
        align: 'right',
        render: row => el('span.mm-numeric.mm-fw-medium', {
          text: fmt.money(regime === 'gst'
            ? row.netPayablePaise
            : Math.max(0, row.tdsDeductedPaise - row.tdsDepositedPaise)),
        }),
      },
      {
        key: 'warnings',
        label: '',
        align: 'center',
        hideOnMobile: true,
        render: row => (row.warnings?.length
          ? pill(`${row.warnings.length}`, 'warning')
          : null),
      },
      { key: 'status', label: 'Status', render: row => statusPill(row.status) },
    ].filter(Boolean),
    empty: {
      title: `No ${regime.toUpperCase()} computations yet`,
      message: 'Run one for a filing period once its documents are verified.',
      icon: 'calculator',
    },
  });

  function paintTabs() {
    render(tabHost, tabStrip({
      tabs: [
        { key: 'gst', label: 'GST', count: null },
        { key: 'tds', label: 'TDS', count: null },
      ],
      active: regime,
      onChange: (key) => {
        // The columns differ between the regimes, so this is a navigation
        // rather than a refresh — the table is rebuilt from the new URL.
        router.go(`/tax?regime=${key}`);
      },
    }));
  }

  paintTabs();

  page.append(
    pageHead({
      title: 'Tax',
      subtitle: regime === 'gst'
        ? 'GST computed from verified documents, with input credit netted off.'
        : 'TDS deducted and deposited, section by section.',
    }),
    tileHost,
    tabHost,
    card({ body: table.node, flush: true }));

  return page;
}

async function loadSummary(host, regime) {
  try {
    const { data } = await api.get('/tax/summary');
    const block = data[regime] ?? {};

    render(host, el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({
        label: 'Taxable value',
        value: fmt.moneyShort(block.taxableValuePaise ?? 0),
        caption: `${fmt.label(data.periodKey)} · ${fmt.plural(block.computations ?? 0, 'computation')}`,
        icon: 'rupee',
      }),
      regime === 'gst'
        ? stat({ label: 'Tax', value: fmt.moneyShort(block.totalTaxPaise ?? 0), icon: 'calculator' })
        : stat({ label: 'Deducted', value: fmt.moneyShort(block.tdsDeductedPaise ?? 0), icon: 'calculator' }),
      regime === 'gst'
        ? stat({ label: 'Input credit', value: fmt.moneyShort(block.itcTotalPaise ?? 0), icon: 'trending-down' })
        : stat({ label: 'Deposited', value: fmt.moneyShort(block.tdsDepositedPaise ?? 0), icon: 'check-circle' }),
      stat({
        label: regime === 'gst' ? 'Net payable' : 'Outstanding',
        value: fmt.moneyShort(regime === 'gst'
          ? (block.netPayablePaise ?? 0)
          : Math.max(0, (block.tdsDeductedPaise ?? 0) - (block.tdsDepositedPaise ?? 0))),
        tone: 'warning',
        icon: 'stamp',
      })));
  } catch (err) {
    render(host, errorState(err));
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

/**
 * Run a computation.
 *
 * The period list is fetched for the chosen client rather than typed, because
 * a computation against a period that does not exist is a confusing error and
 * an avoidable one.
 */
async function runComputation(clients, refresh) {
  const payload = await modal({
    title: 'Run a computation',
    description: 'Only verified documents are included. Re-running replaces the previous figures and keeps the old ones as superseded.',
    body: ({ close }) => {
      const clientSelect = el('select.mm-select',
        el('option', { value: '', text: 'Choose a client' }),
        ...clients.map(c => el('option', { value: c.id, text: c.displayName })));

      const periodSelect = el('select.mm-select', { disabled: true },
        el('option', { value: '', text: 'Choose a client first' }));

      const regimeSelect = el('select.mm-select',
        el('option', { value: 'gst', text: 'GST' }),
        el('option', { value: 'tds', text: 'TDS' }));

      const errorHost = el('div');

      clientSelect.addEventListener('change', async () => {
        periodSelect.disabled = true;
        render(periodSelect, el('option', { value: '', text: 'Loading…' }));
        if (!clientSelect.value) return;
        try {
          const { data } = await api.get(`/clients/${clientSelect.value}/periods`);
          render(periodSelect, ...(data ?? []).map(p => el('option', {
            value: p.id,
            text: `${fmt.label(p.period_key)} — ${fmt.label(p.status)}`,
          })));
          periodSelect.disabled = !(data ?? []).length;
          if (!(data ?? []).length) {
            render(periodSelect, el('option', { value: '', text: 'No filing periods for this client' }));
          }
        } catch (err) {
          render(periodSelect, el('option', { value: '', text: 'Could not load periods' }));
          errorHost.replaceChildren(el('p.mm-field__error', { role: 'alert', text: err.message }));
        }
      });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          if (!clientSelect.value || !periodSelect.value) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: 'Choose both a client and a filing period.',
            }));
            return;
          }
          close({
            clientId: clientSelect.value,
            filingPeriodId: periodSelect.value,
            regime: regimeSelect.value,
          });
        },
      },
        errorHost,
        el('div.mm-field', el('label.mm-field__label', { text: 'Client' }), clientSelect),
        el('div.mm-field', el('label.mm-field__label', { text: 'Filing period' }), periodSelect),
        el('div.mm-field', el('label.mm-field__label', { text: 'Regime' }), regimeSelect),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Run it' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/tax/computations/run', payload);
    const id = data.computation?.id ?? data.id;
    notify.success('Computed.', {
      action: id ? { label: 'Open it', onClick: () => router.go(`/tax/${id}`) } : null,
    });
    refresh();
  } catch (err) {
    notifyError(err);
  }
}
