/**
 * Platform revenue.
 *
 * The run rate, what actually arrived, and where it came from. MRR is stated
 * as what it is — the current monthly run rate, annualised by multiplication —
 * rather than dressed up as a forecast.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import {
  pageHead, card, kv, stat, button, emptyState, errorState, skeletonTiles, pill,
} from '../../core/ui.js';
import { barChart, lineChart, rankBars } from '../../components/charts.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function revenueScreen() {
  setBreadcrumbs([{ label: 'Platform' }, { label: 'Revenue' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4), el('div.mm-skeleton.mm-skeleton--chart'));

  try {
    const { data } = await api.get('/platform/revenue');
    render(page, ...build(data));
  } catch (err) {
    render(page, errorState(err, { onRetry: () => window.location.reload() }));
  }

  return page;
}

function build(data) {
  const collections = data.collections ?? [];
  const latest = collections[collections.length - 1];

  return [
    pageHead({
      title: 'Revenue',
      subtitle: 'Across every organisation on the platform.',
      actions: button('Organisations', { variant: 'ghost', icon: 'building', href: '/platform/organisations' }),
    }),

    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({
        label: 'Monthly run rate',
        value: data.mrr.totalLabel ?? fmt.moneyShort(data.mrr.totalPaise),
        caption: `${fmt.moneyShort(data.mrr.planPaise)} plans · ${fmt.moneyShort(data.mrr.addOnPaise)} add-ons`,
        icon: 'trending-up',
      }),
      stat({
        label: 'Annualised',
        value: fmt.moneyShort(data.mrr.annualisedPaise),
        caption: 'The run rate × 12, not a forecast',
        icon: 'calendar',
      }),
      stat({
        label: 'Collected this month',
        value: fmt.moneyShort(latest?.collectedPaise ?? 0),
        caption: latest ? `${fmt.plural(latest.payments ?? 0, 'payment')}` : null,
        icon: 'rupee',
      }),
      stat({
        label: 'Outstanding',
        value: data.outstanding.label ?? fmt.moneyShort(data.outstanding.paise),
        caption: `${fmt.plural(data.outstanding.invoices ?? 0, 'invoice')} unpaid`,
        icon: 'clock',
        tone: data.outstanding.paise > 0 ? 'warning' : null,
      })),

    el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
      card({
        title: 'Collections',
        subtitle: 'What actually arrived, by month',
        body: barChart({
          series: collections.map(c => ({ label: shortMonth(c.periodKey), value: c.collectedPaise })),
          unit: 'paise',
          emptyMessage: 'No payments have been recorded yet.',
        }),
      }),
      card({
        title: 'Payments',
        subtitle: 'How many, by month',
        body: lineChart({
          series: collections.map(c => ({ label: shortMonth(c.periodKey), value: c.payments })),
          emptyMessage: 'No payments yet.',
        }),
      })),

    el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
      card({
        title: 'Run rate by plan',
        body: rankBars({
          rows: (data.byPlan ?? []).map(plan => ({
            label: plan.name,
            value: plan.mrrPaise,
            valueLabel: `${fmt.moneyShort(plan.mrrPaise)} from ${fmt.plural(plan.tenants, 'organisation')}`,
          })),
          unit: 'paise',
          emptyMessage: 'Nobody is subscribed yet.',
        }),
      }),
      card({
        title: 'Add-ons by revenue',
        subtitle: `${data.catalogue.addOns} in the catalogue`,
        body: rankBars({
          rows: (data.topAddOns ?? []).map(addOn => ({
            label: addOn.name,
            value: addOn.mrrPaise,
            valueLabel: `${fmt.moneyShort(addOn.mrrPaise)} from ${fmt.plural(addOn.subscriptions, 'subscription')}`,
          })),
          unit: 'paise',
          emptyMessage: 'No add-on is active anywhere yet.',
        }),
      })),

    card({
      title: 'Month by month',
      className: 'mm-mt-4',
      flush: true,
      body: collections.length
        ? el('div.mm-table-wrap',
            el('table.mm-table.mm-table--compact',
              el('thead', el('tr',
                el('th', { text: 'Month' }),
                el('th.mm-align-right', { text: 'Payments' }),
                el('th.mm-align-right', { text: 'Collected' }))),
              el('tbody',
                ...[...collections].reverse().map(row => el('tr',
                  el('td', { text: fmt.label(row.periodKey) }),
                  el('td.mm-align-right.mm-numeric', { text: fmt.number(row.payments) }),
                  el('td.mm-align-right.mm-numeric', { text: fmt.money(row.collectedPaise) }))))))
        : emptyState({ title: 'Nothing collected yet', icon: 'rupee', inline: true }),
    }),
  ].filter(Boolean);
}

function shortMonth(periodKey) {
  const [year, month] = String(periodKey ?? '').split('-');
  if (!month) return periodKey ?? '';
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'short' });
}
