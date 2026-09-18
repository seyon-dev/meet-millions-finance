/**
 * Team performance.
 *
 * Measured from the work itself — documents verified, SLA met, queries
 * resolved — rather than from a target somebody typed in. Where a figure has
 * too small a sample to mean anything, it says so instead of showing a
 * percentage that will be over-read.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, stat, button, emptyState, errorState, skeletonTiles, pill,
} from '../../core/ui.js';
import { rankBars, barChart } from '../../components/charts.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function performanceScreen() {
  setBreadcrumbs([{ label: 'Team', href: '/team' }, { label: 'Performance' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4));

  try {
    const [approvals, branches, attendance] = await Promise.all([
      api.get('/approvals/stats').then(r => r.data).catch(() => null),
      session.can('branches.view')
        ? api.get('/branches/performance').then(r => r.data).catch(() => null)
        : Promise.resolve(null),
      session.can('attendance.view')
        ? api.get('/attendance/summary').then(r => r.data).catch(() => null)
        : Promise.resolve(null),
    ]);
    render(page, ...build(approvals, branches, attendance));
  } catch (err) {
    render(page, errorState(err, { onRetry: () => window.location.reload() }));
  }

  return page;
}

function build(approvals, branches, attendance) {
  const people = approvals?.executivePerformance ?? [];

  return [
    pageHead({
      title: 'Team performance',
      subtitle: approvals?.periodKey ? `${fmt.label(approvals.periodKey)}, measured from the work itself` : null,
      actions: button('Back to the team', { variant: 'ghost', icon: 'users', href: '/team' }),
    }),

    approvals
      ? el('div.mm-grid.mm-grid-4.mm-gap-4',
          stat({ label: 'Executives', value: fmt.number(approvals.teamExecutives), icon: 'users' }),
          stat({
            label: 'Awaiting approval',
            value: fmt.number(approvals.awaitingApproval),
            icon: 'stamp',
            tone: approvals.awaitingApproval ? 'warning' : null,
          }),
          stat({ label: 'Approved this month', value: fmt.number(approvals.approvedMtd), icon: 'check-circle', tone: 'success' }),
          stat({
            label: 'Collected this month',
            value: approvals.revenueMtdFormatted ?? fmt.money(approvals.revenueMtdPaise),
            icon: 'rupee',
          }))
      : null,

    people.length
      ? el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
          card({
            title: 'Documents verified',
            subtitle: 'This month, per person',
            body: rankBars({
              rows: people.map(person => ({
                label: person.name,
                value: person.verified ?? 0,
                valueLabel: `${person.verified ?? 0} verified`,
              })),
              emptyMessage: 'Nobody has verified anything this month.',
            }),
          }),
          card({
            title: 'Open queue',
            subtitle: 'What each person still has waiting',
            body: rankBars({
              rows: people.map(person => ({
                label: person.name,
                value: person.queue ?? person.pending ?? 0,
                tone: person.pastSla > 0 ? 'danger' : undefined,
                valueLabel: person.pastSla
                  ? `${person.queue ?? 0} open · ${person.pastSla} past SLA`
                  : `${person.queue ?? 0} open`,
              })),
              emptyMessage: 'Every queue is clear.',
            }),
          }))
      : null,

    people.length ? peopleTable(people) : null,

    branches?.branches?.length > 1 ? branchesCard(branches) : null,
    attendance?.staff?.length ? attendanceCard(attendance) : null,

    approvals || branches || attendance
      ? null
      : emptyState({
          title: 'Nothing to measure yet',
          message: 'Performance figures appear once the practice has verified documents and approved reports.',
          icon: 'bar-chart',
        }),
  ].filter(Boolean);
}

/**
 * The numbers as a table, beside the charts.
 *
 * An SLA percentage over three decisions is noise, so a small sample is
 * labelled rather than printed as though it were a rate.
 */
function peopleTable(people) {
  return card({
    title: 'Person by person',
    className: 'mm-mt-4',
    flush: true,
    body: el('div.mm-table-wrap',
      el('table.mm-table.mm-table--compact',
        el('thead', el('tr',
          el('th', { text: 'Person' }),
          el('th.mm-align-right', { text: 'Verified' }),
          el('th.mm-align-right', { text: 'Open queue' }),
          el('th.mm-align-right.mm-hide-sm', { text: 'Past SLA' }),
          el('th.mm-align-right.mm-hide-sm', { text: 'SLA met' }),
          el('th.mm-align-right.mm-hide-sm', { text: 'Clients' }))),
        el('tbody',
          ...people.map(person => el('tr',
            el('td', { text: person.name }),
            el('td.mm-align-right.mm-numeric', { text: fmt.number(person.verified ?? 0) }),
            el('td.mm-align-right.mm-numeric', { text: fmt.number(person.queue ?? 0) }),
            el('td.mm-align-right.mm-hide-sm.mm-numeric', {
              class: person.pastSla ? 'mm-c-danger' : '',
              text: fmt.number(person.pastSla ?? 0),
            }),
            el('td.mm-align-right.mm-hide-sm', slaCell(person)),
            el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: fmt.number(person.clients ?? 0) })))))),
  });
}

function slaCell(person) {
  const sample = person.slaSampleSize ?? person.decisions ?? 0;
  if (!sample) return el('span.mm-muted.mm-text-xs', { text: 'No decisions' });
  if (sample < 5) {
    return el('span.mm-muted.mm-text-xs', {
      title: `${sample} decisions is too few for a meaningful rate.`,
      text: `${sample} decisions`,
    });
  }
  const pct = person.slaCompliancePct ?? null;
  if (pct === null) return el('span.mm-muted', { text: '—' });
  return el('span.mm-numeric', {
    class: pct >= 95 ? 'mm-c-success' : pct >= 80 ? '' : 'mm-c-warning',
    text: fmt.percent(pct),
  });
}

function branchesCard(data) {
  return card({
    title: 'By branch',
    subtitle: `${fmt.date(data.period.from)} – ${fmt.date(data.period.to)}`,
    className: 'mm-mt-4',
    flush: true,
    body: el('div.mm-table-wrap',
      el('table.mm-table.mm-table--compact',
        el('thead', el('tr',
          el('th', { text: 'Branch' }),
          el('th.mm-align-right', { text: 'Staff' }),
          el('th.mm-align-right', { text: 'Clients' }),
          el('th.mm-align-right', { text: 'Documents' }),
          el('th.mm-align-right.mm-hide-sm', { text: 'Per person' }),
          el('th.mm-align-right.mm-hide-sm', { text: 'Verified' }),
          el('th.mm-align-right', { text: 'Collected' }))),
        el('tbody',
          ...data.branches.map(branch => el('tr',
            el('td',
              el('div.mm-stack',
                el('span.mm-fw-medium', { text: branch.name }),
                el('span.mm-muted.mm-text-xs', { text: [branch.code, branch.city].filter(Boolean).join(' · ') }))),
            el('td.mm-align-right.mm-numeric', { text: fmt.number(branch.staff) }),
            el('td.mm-align-right.mm-numeric', { text: fmt.number(branch.clients) }),
            el('td.mm-align-right.mm-numeric', { text: fmt.number(branch.documents) }),
            el('td.mm-align-right.mm-hide-sm.mm-numeric', { text: fmt.number(branch.documentsPerStaff) }),
            el('td.mm-align-right.mm-hide-sm', {
              text: branch.verificationRatePct === null ? '—' : fmt.percent(branch.verificationRatePct),
            }),
            el('td.mm-align-right.mm-numeric', { text: fmt.moneyShort(branch.revenuePaise) })))))),
  });
}

function attendanceCard(data) {
  return card({
    title: 'Hours worked',
    subtitle: `${fmt.date(data.period.from)} – ${fmt.date(data.period.to)}`,
    className: 'mm-mt-4',
    body: rankBars({
      rows: data.staff.map(person => ({
        label: person.name,
        value: person.workedMinutes ?? 0,
        valueLabel: `${person.workedLabel ?? fmt.minutes(person.workedMinutes)} over ${fmt.plural(person.daysPresent, 'day')}`,
      })),
      emptyMessage: 'Nobody has checked in during this period.',
    }),
  });
}
