/**
 * Analytics.
 *
 * The practice's own trend lines — documents, clients, collections, reports —
 * over the last twelve months, with the change against the previous month
 * stated rather than left to be inferred from a chart.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, emptyState, errorState, skeletonTiles, lockedState,
} from '../../core/ui.js';
import { barChart, lineChart, rankBars } from '../../components/charts.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function analyticsScreen() {
  setBreadcrumbs([{ label: 'Analytics' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4), el('div.mm-skeleton.mm-skeleton--chart'));

  try {
    const { data } = await api.get('/analytics/trends');
    render(page, ...build(data));
  } catch (err) {
    if (err.name === 'FeatureLocked') {
      render(page,
        pageHead({ title: 'Analytics' }),
        lockedState({
          featureName: 'Advanced analytics',
          requiredAddOn: 'advanced_analytics_dashboard',
          message: 'Trends across revenue, filings, team productivity and client health, with a report builder.',
        }));
      return page;
    }
    render(page, errorState(err, { onRetry: () => window.location.reload() }));
  }

  return page;
}

function build(data) {
  const series = data.series ?? [];
  const latest = series[series.length - 1];
  const change = data.change ?? {};

  return [
    pageHead({
      title: 'Analytics',
      subtitle: series.length
        ? `${fmt.period(series[0].periodKey)} to ${fmt.period(latest.periodKey)}`
        : null,
      actions: session.can('analytics.build')
        ? button('Build a report', { variant: 'primary', icon: 'terminal', href: '/analytics/builder' })
        : null,
    }),

    series.length
      ? frag(
          el('div.mm-grid.mm-grid-4.mm-gap-4',
            stat({
              label: 'Documents this month',
              value: fmt.number(latest.documents),
              delta: round(change.documentsPct),
              caption: `vs ${fmt.label(change.comparing?.from ?? '')}`,
              icon: 'files',
            }),
            stat({
              label: 'New clients',
              value: fmt.number(latest.newClients),
              delta: round(change.newClientsPct),
              icon: 'user-plus',
            }),
            stat({
              label: 'Collected',
              value: fmt.moneyShort(latest.collectedPaise),
              delta: round(change.collectedPct),
              icon: 'rupee',
            }),
            stat({
              label: 'Reports produced',
              value: fmt.number(latest.reports),
              icon: 'report',
            })),

          el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
            card({
              title: 'Collections',
              subtitle: 'Payments received, by month',
              body: barChart({
                series: series.map(s => ({ label: shortMonth(s.periodKey), value: s.collectedPaise })),
                unit: 'paise',
                emptyMessage: 'No payments have been recorded yet.',
              }),
            }),
            card({
              title: 'Documents handled',
              subtitle: 'Uploaded, by month',
              body: lineChart({
                series: series.map(s => ({ label: shortMonth(s.periodKey), value: s.documents })),
                emptyMessage: 'No documents yet.',
              }),
            })),

          el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
            card({
              title: 'New clients',
              body: barChart({
                series: series.map(s => ({ label: shortMonth(s.periodKey), value: s.newClients })),
                emptyMessage: 'No clients have been added in this window.',
              }),
            }),
            card({
              title: 'Busiest months',
              subtitle: 'By documents handled',
              body: rankBars({
                rows: [...series]
                  .sort((a, b) => b.documents - a.documents)
                  .slice(0, 6)
                  .map(s => ({ label: fmt.period(s.periodKey), value: s.documents })),
                emptyMessage: 'Nothing to rank yet.',
              }),
            })),

          card({
            title: 'Month by month',
            className: 'mm-mt-4',
            flush: true,
            body: el('div.mm-table-wrap',
              el('table.mm-table.mm-table--compact',
                el('thead', el('tr',
                  el('th', { text: 'Month' }),
                  el('th.mm-align-right', { text: 'Documents' }),
                  el('th.mm-align-right', { text: 'New clients' }),
                  el('th.mm-align-right', { text: 'Reports' }),
                  el('th.mm-align-right', { text: 'Collected' }))),
                el('tbody',
                  ...[...series].reverse().map(row => el('tr',
                    el('td', { text: fmt.period(row.periodKey) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.number(row.documents) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.number(row.newClients) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.number(row.reports) }),
                    el('td.mm-align-right.mm-numeric', { text: fmt.money(row.collectedPaise) })))))),
          }))
      : emptyState({
          title: 'Not enough history yet',
          message: 'Trends appear once the practice has a month or two of activity behind it.',
          icon: 'bar-chart',
        }),
  ].filter(Boolean);
}

function round(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value);
}

function shortMonth(periodKey) {
  const [year, month] = String(periodKey ?? '').split('-');
  if (!month) return periodKey ?? '';
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-IN', { month: 'short' });
}
