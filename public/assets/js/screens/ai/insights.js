/**
 * Business insights.
 *
 * Observations drawn from the organisation's own figures. Every one carries
 * the numbers it was drawn from, so a reader can check the claim rather than
 * take it on faith — an insight you cannot verify is a rumour.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, pill, emptyState, errorState, skeletonTiles,
  notify, notifyError, banner, lockedState,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function insightsScreen() {
  setBreadcrumbs([{ label: 'Business insights' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(3));

  async function load() {
    try {
      const [{ data }, { data: status }] = await Promise.all([
        api.get('/ai/insights'),
        api.get('/ai/status').catch(() => ({ data: { capabilities: [] } })),
      ]);
      render(page, ...build(data, status, load));
    } catch (err) {
      if (err.name === 'FeatureLocked') {
        render(page,
          pageHead({ title: 'Business insights' }),
          lockedState({
            featureName: 'Business insights',
            requiredAddOn: 'ai_business_insights',
            message: 'Weekly observations about revenue, workload, client churn and anomalies, drawn from your own records.',
          }));
        return;
      }
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, status, reload) {
  const insights = data.insights ?? [];
  const open = insights.filter(i => !i.acknowledged);
  const capability = (status.capabilities ?? []).find(c => c.key === 'insights' || c.key === 'llm');

  return [
    pageHead({
      title: 'Business insights',
      subtitle: 'What your own figures suggest, refreshed weekly.',
      actions: session.can('ai.insights')
        ? button('Refresh now', { variant: 'primary', icon: 'refresh-cw', onClick: () => refresh(reload) })
        : null,
    }),

    capability && !capability.configured
      ? banner({
          text: `${capability.provider} is not connected${capability.missingKeys?.length ? ` — ${capability.missingKeys.join(', ')} not set` : ''}, so no new insights can be generated. Anything below was generated earlier.`,
          tone: 'warning',
          icon: 'plug',
          action: session.can('integrations.manage')
            ? { label: 'Open integrations', href: '/settings/integrations' }
            : null,
        })
      : null,

    insights.length
      ? el('div.mm-grid.mm-grid-4.mm-gap-4',
          stat({ label: 'Observations', value: fmt.number(insights.length), icon: 'lightbulb' }),
          stat({
            label: 'Unread',
            value: fmt.number(open.length),
            icon: 'bell',
            tone: open.length ? 'warning' : null,
          }),
          stat({
            label: 'Needing attention',
            value: fmt.number(insights.filter(i => i.severity === 'critical' || i.severity === 'warning').length),
            icon: 'alert',
          }),
          stat({
            label: 'Most recent',
            value: fmt.relative(insights[0]?.createdAt),
            icon: 'clock',
          }))
      : null,

    insights.length
      ? el('div.mm-stack.mm-gap-3',
          ...insights.map(insight => insightCard(insight, reload)))
      : emptyState({
          title: 'No insights yet',
          message: capability?.configured
            ? 'They are generated weekly from your filings, revenue and workload. Refresh to generate them now.'
            : 'Connect a language model provider and these will be generated from your own figures.',
          icon: 'lightbulb',
          action: session.can('ai.insights') && capability?.configured
            ? { label: 'Refresh now', onClick: () => refresh(reload) }
            : null,
        }),
  ].filter(Boolean);
}

function insightCard(insight, reload) {
  const tone = { critical: 'danger', warning: 'warning', positive: 'success' }[insight.severity] ?? 'info';

  return card({
    className: `mm-card--ai${insight.acknowledged ? ' is-read' : ''}`,
    title: insight.title,
    subtitle: [
      fmt.label(insight.kind),
      insight.periodKey ? fmt.period(insight.periodKey) : null,
      fmt.relative(insight.createdAt),
    ].filter(Boolean).join(' · '),
    actions: frag(
      pill(insight.severity, tone),
      insight.confidence
        ? el('span.mm-muted.mm-text-xs', { text: `${Math.round(insight.confidence * 100)}% confidence` })
        : null,
      insight.acknowledged
        ? pill('Read', 'neutral')
        : (session.can('ai.insights')
            ? button('Mark read', {
                variant: 'ghost', size: 'sm',
                onClick: () => acknowledge(insight, reload),
              })
            : null)),
    body: frag(
      el('p.mm-prose', { text: insight.body }),

      insight.metrics
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'The figures behind it' }),
            el('div.mm-kvgrid',
              ...Object.entries(insight.metrics).map(([key, value]) =>
                kv(fmt.label(key), formatMetric(key, value)))))
        : null,

      insight.entityId
        ? el('div.mm-mt-3',
            el('a.mm-link', { href: entityHref(insight), text: 'Open the record this is about' }))
        : null,

      el('p.mm-muted.mm-text-xs.mm-mt-3', {
        text: 'Generated from your own records. Check the figures before acting on them.',
      })),
  });
}

function formatMetric(key, value) {
  if (value === null || value === undefined) return '—';
  if (/paise$/i.test(key)) return fmt.money(value);
  if (/pct$|percent/i.test(key)) return fmt.percent(value, { decimals: 1 });
  if (typeof value === 'number') return fmt.number(value);
  return String(value);
}

function entityHref(insight) {
  return {
    client: `/clients/${insight.entityId}`,
    document: `/documents/${insight.entityId}`,
    invoice: `/billing/invoices/${insight.entityId}`,
    report: `/reports/${insight.entityId}`,
    computation: `/tax/${insight.entityId}`,
  }[insight.entityType] ?? '#';
}

async function refresh(reload) {
  try {
    const { data } = await api.post('/ai/insights/refresh', {});
    notify.success(data?.generated
      ? `${fmt.plural(data.generated, 'insight')} generated.`
      : 'Nothing new was found in this period.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function acknowledge(insight, reload) {
  try {
    await api.post(`/ai/insights/${insight.id}/acknowledge`, {});
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
