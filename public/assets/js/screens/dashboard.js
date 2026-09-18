/**
 * The staff dashboard.
 *
 * One screen for five roles: the API assembles the right dashboard for whoever
 * is asking, and this renders whichever sections came back. That keeps the
 * decision about what a role should see on the server, where it is also
 * enforced, rather than duplicated in a client-side switch.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, stat, statusPill, emptyState, errorState, skeletonTiles, button, pill,
} from '../core/ui.js';
import { barChart, lineChart, donutChart, legend, rankBars } from '../components/charts.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function dashboardScreen() {
  const page = el('div.mm-page');
  render(page, skeletonTiles(4), el('div.mm-skeleton.mm-skeleton--chart'));

  try {
    const { data } = await api.get('/dashboard');
    setBreadcrumbs([{ label: data.title ?? 'Dashboard' }]);
    render(page, ...build(data));
  } catch (err) {
    render(page, errorState(err, { onRetry: () => window.location.reload() }));
  }
  return page;
}

function build(data) {
  const state = session.session();

  return [
    pageHead({
      title: data.title ?? 'Dashboard',
      subtitle: greeting(state.user?.fullName),
      actions: frag(
        button('Refresh', {
          variant: 'ghost', icon: 'refresh', onClick: () => window.location.reload(),
        }),
        // A platform Super Admin holds every permission and has no organisation
        // to create a client in; offering the button would offer a request that
        // cannot succeed. Theirs is a new organisation instead.
        session.isPlatformOnly()
          ? button('New organisation', {
              variant: 'primary', icon: 'building', href: '/platform/organisations?new=1',
            })
          : session.can('clients.create')
            ? button('New client', { variant: 'primary', icon: 'user-plus', href: '/clients?new=1' })
            : null),
    }),

    tiles(data.tiles),
    data.secondary?.length ? tiles(data.secondary) : null,

    // Only the sections this role's dashboard actually returned.
    data.workflow?.length ? workflowStrip(data.workflow) : null,
    data.queue?.length ? queueCard(data.queue) : null,
    data.teamLoad?.length ? teamCard(data.teamLoad) : null,
    data.filingPeriods?.length ? filingPeriodsCard(data.filingPeriods) : null,
    chartsRow(data.charts),
    data.deadlines?.length ? deadlinesCard(data.deadlines) : null,
    data.recentActivity?.length ? activityCard(data.recentActivity) : null,
    data.eventsByCategory?.length ? auditCard(data) : null,
    data.planDistribution?.length ? platformCard(data) : null,
    data.note ? el('p.mm-muted.mm-text-sm', { text: data.note }) : null,
  ].filter(Boolean);
}

function greeting(name) {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name.split(' ')[0]}.` : part;
}

function tiles(list) {
  if (!list?.length) return null;
  return el('div.mm-grid.mm-grid-4.mm-gap-4',
    ...list.map(tile => stat({
      label: tile.label,
      value: tile.value,
      caption: tile.caption,
      tone: tile.tone === 'default' ? null : tile.tone,
      icon: tile.icon,
      href: tile.route,
    })));
}

/**
 * The ten workflow stages from the proposal, with how much sits in each.
 *
 * Rendered as a strip rather than a funnel: these are stages work passes
 * through, not a conversion funnel, and a funnel shape would imply loss.
 */
function workflowStrip(stages) {
  const total = stages.reduce((n, s) => n + (s.count ?? 0), 0);

  return card({
    title: 'Where the work is',
    subtitle: total
      ? `${fmt.plural(total, 'filing period')} across the ten stages of the month`
      : 'No filing periods are open yet.',
    flush: true,
    body: el('ol.mm-steps.mm-steps--strip',
      ...stages.map(stage => el('li.mm-step', {
        class: stage.count > 0 ? 'is-active' : '',
        title: stage.detail ?? '',
      },
        el('span.mm-step__marker', { text: String(stage.no) }),
        el('span.mm-step__label', { text: stage.label }),
        el('span.mm-step__count', {
          class: stage.count ? 'mm-c-brand' : 'mm-muted',
          text: String(stage.count ?? 0),
        }),
        el('span.mm-step__line', { 'aria-hidden': 'true' })))),
  });
}

function queueCard(queue) {
  return card({
    title: 'Your queue',
    subtitle: 'Oldest deadline first',
    actions: button('Open verification', { variant: 'ghost', size: 'sm', href: '/verification' }),
    flush: true,
    body: el('ul.mm-list',
      ...queue.map(item => el('li.mm-list__row',
        el('a.mm-list__main', { href: `/verification/${item.id}` },
          el('span.mm-fw-medium', { text: item.title }),
          el('span.mm-muted.mm-text-xs', {
            text: [item.clientName, item.typeName].filter(Boolean).join(' · '),
          })),
        statusPill(item.status),
        item.slaDueAt
          ? el('span.mm-text-xs', {
              class: item.overdue ? 'mm-c-danger' : 'mm-muted',
              title: fmt.dateTime(item.slaDueAt),
              text: item.overdue ? 'Past SLA' : fmt.relative(item.slaDueAt),
            })
          : null))),
  });
}

function teamCard(team) {
  return card({
    title: 'Team load',
    subtitle: 'Open queue, and what each person cleared this week',
    body: rankBars({
      rows: team.map(member => ({
        label: member.name,
        value: member.queue,
        valueLabel: `${member.queue} open · ${member.verifiedLast7Days} done`,
        tone: member.pastSla > 0 ? 'danger' : undefined,
      })),
      emptyMessage: 'Nothing is assigned yet.',
    }),
  });
}

function filingPeriodsCard(periods) {
  return card({
    title: 'Filing periods',
    subtitle: 'Everything not yet filed, by due date',
    flush: true,
    body: el('ul.mm-list',
      ...periods.map(period => el('li.mm-list__row',
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: period.clientName ?? period.label }),
          el('span.mm-muted.mm-text-xs', {
            text: `${fmt.label(period.label)} · ${period.verified}/${period.expected} verified`,
          })),
        el('span.mm-progress.mm-progress--sm', { style: { width: '96px' } },
          el('span.mm-progress__bar', {
            class: period.readyPct === 100 ? 'mm-progress__bar--success' : '',
            style: { width: `${period.readyPct ?? 0}%` },
          })),
        statusPill(period.status),
        el('span.mm-text-xs', {
          class: period.overdue ? 'mm-c-danger' : 'mm-muted',
          text: fmt.date(period.dueDate),
        })))),
  });
}

function chartsRow(charts) {
  if (!charts) return null;
  const cards = [];

  if (charts.revenue) {
    cards.push(card({
      title: 'Collections',
      subtitle: 'Payments received, by month',
      body: barChart({
        series: charts.revenue.series.map(p => ({ label: shortMonth(p.periodKey), value: p.valuePaise })),
        unit: 'paise',
        emptyMessage: 'No payments have been recorded yet.',
      }),
    }));
  }

  if (charts.documentsByStatus) {
    const series = charts.documentsByStatus.series ?? [];
    cards.push(card({
      title: 'Documents by status',
      body: el('div.mm-row.mm-gap-5.mm-wrap',
        donutChart({ series, size: 176, emptyMessage: 'No documents yet.' }),
        legend(series)),
    }));
  }

  if (charts.uploadsByDay || charts.verificationThroughput || charts.myThroughput) {
    const source = charts.uploadsByDay ?? charts.verificationThroughput ?? charts.myThroughput;
    cards.push(card({
      title: charts.uploadsByDay ? 'Uploads' : 'Verified per day',
      subtitle: 'Last two weeks',
      body: lineChart({
        series: source.series.map(p => ({ label: p.label.slice(5), value: p.value })),
        emptyMessage: 'Nothing recorded in this period.',
      }),
    }));
  }

  if (!cards.length) return null;
  return el('div.mm-grid.mm-grid-2.mm-gap-4', ...cards);
}

function deadlinesCard(deadlines) {
  return card({
    title: 'Coming up',
    subtitle: 'Statutory due dates, derived from the filing periods themselves',
    flush: true,
    body: el('ul.mm-list',
      ...deadlines.map(deadline => el('li.mm-list__row',
        el('span.mm-list__icon', { class: deadline.overdue ? 'mm-c-danger' : 'mm-c-warning' },
          icon('calendar', { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: deadline.clientName ?? 'Filing' }),
          el('span.mm-muted.mm-text-xs', { text: fmt.label(deadline.label) })),
        statusPill(deadline.status),
        el('span.mm-text-xs.mm-nowrap', {
          class: deadline.overdue ? 'mm-c-danger' : deadline.daysRemaining <= 3 ? 'mm-c-warning' : 'mm-muted',
          text: deadline.overdue
            ? `${Math.abs(deadline.daysRemaining)} days overdue`
            : `${deadline.daysRemaining} days left`,
        })))),
  });
}

function activityCard(activity) {
  return card({
    title: 'Recent activity',
    flush: true,
    body: el('ol.mm-timeline',
      ...activity.map(entry => el('li.mm-timeline__item',
        el('span.mm-timeline__dot', { class: `mm-timeline__dot--${toneForVerb(entry.verb)}` }),
        el('div.mm-timeline__content',
          el('p.mm-timeline__title', { text: entry.summary }),
          el('p.mm-timeline__meta', {
            text: [entry.client_name, entry.actor_name, fmt.relative(entry.created_at)]
              .filter(Boolean).join(' · '),
          }))))),
  });
}

function auditCard(data) {
  return card({
    title: 'Audit activity',
    subtitle: 'Last thirty days, by category',
    body: rankBars({
      rows: data.eventsByCategory.map(c => ({ label: fmt.label(c.category), value: c.count })),
      emptyMessage: 'No audit events recorded yet.',
    }),
  });
}

function platformCard(data) {
  return el('div.mm-grid.mm-grid-2.mm-gap-4',
    card({
      title: 'Plan distribution',
      body: rankBars({
        rows: data.planDistribution.map(p => ({ label: p.name, value: p.tenants })),
        emptyMessage: 'No organisations yet.',
      }),
    }),
    card({
      title: 'Most-used add-ons',
      body: rankBars({
        rows: (data.topAddOns ?? []).map(a => ({ label: a.name, value: a.subscriptions })),
        emptyMessage: 'No add-ons are active yet.',
      }),
    }));
}

function toneForVerb(verb) {
  if (['verified', 'approved', 'created', 'paid'].includes(verb)) return 'success';
  if (['rejected', 'deleted'].includes(verb)) return 'danger';
  if (['queried', 'noted'].includes(verb)) return 'warning';
  return 'brand';
}

function shortMonth(periodKey) {
  const [year, month] = String(periodKey ?? '').split('-');
  if (!month) return periodKey ?? '';
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-IN', { month: 'short' });
}
