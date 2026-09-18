/**
 * Plans.
 *
 * The catalogue every organisation subscribes from. Changing a plan's limits
 * does not retroactively shrink anybody: existing subscriptions keep what they
 * were granted until their next plan change, and the screen says so rather
 * than leaving it to be discovered.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  skeletonTiles, notify, notifyError, modal, banner,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

export default async function plansScreen() {
  setBreadcrumbs([{ label: 'Platform' }, { label: 'Plans' }]);

  const page = el('div.mm-page');
  const bodyHost = el('div');

  async function load() {
    render(bodyHost, skeletonTiles(4));
    try {
      const { data } = await api.get('/platform/plans');
      render(bodyHost, ...build(data, load));
    } catch (err) {
      render(bodyHost, errorState(err, { onRetry: load }));
    }
  }

  page.append(
    pageHead({
      title: 'Plans',
      subtitle: 'What every organisation on the platform subscribes from.',
    }),
    bodyHost);

  await load();
  return page;
}

function build(data, reload) {
  const plans = data.plans ?? [];
  const subscribers = plans.reduce((n, p) => n + (p.subscribers ?? 0), 0);

  return [
    banner({
      text: 'Changing a plan’s limits never shrinks an existing subscription. Organisations keep what they were granted until their next plan change.',
      tone: 'info',
      icon: 'info',
    }),

    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Plans', value: fmt.number(plans.length), icon: 'grid' }),
      stat({ label: 'Subscribers', value: fmt.number(subscribers), icon: 'building' }),
      stat({
        label: 'Monthly run rate',
        value: fmt.moneyShort(plans.reduce((n, p) => n + (p.monthly_price_paise ?? 0) * (p.subscribers ?? 0), 0)),
        icon: 'trending-up',
      }),
      stat({
        label: 'Most popular',
        value: plans.slice().sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0))[0]?.name ?? '—',
        icon: 'check-circle',
      })),

    el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
      ...plans.map(plan => planCard(plan, reload))),

    (data.comparison ?? []).length
      ? card({
          title: 'Side by side',
          className: 'mm-mt-4',
          flush: true,
          body: el('div.mm-table-wrap',
            el('table.mm-table.mm-table--compact',
              el('thead', el('tr',
                el('th', { text: '' }),
                ...plans.map(plan => el('th', { text: plan.name })))),
              el('tbody',
                ...data.comparison.map(row => el('tr',
                  el('td', { text: row.label }),
                  ...plans.map(plan => el('td', { text: String(row.values?.[plan.key] ?? '—') }))))))),
        })
      : null,
  ].filter(Boolean);
}

function planCard(plan, reload) {
  return card({
    title: plan.name,
    subtitle: plan.tagline,
    actions: frag(
      pill(`${fmt.number(plan.subscribers ?? 0)} on it`, plan.subscribers ? 'info' : 'neutral'),
      plan.is_popular ? pill('Marked popular', 'success') : null,
      session.can('plans.manage')
        ? button('Edit', { variant: 'ghost', size: 'sm', icon: 'edit', onClick: () => editPlan(plan, reload) })
        : null),
    body: frag(
      el('p.mm-plan__price',
        el('span.mm-plan__amount', { text: plan.monthlyPriceLabel ?? fmt.money(plan.monthly_price_paise) }),
        el('span.mm-plan__per', { text: '/month' })),
      plan.yearlyPriceLabel
        ? el('p.mm-muted.mm-text-xs', { text: `${plan.yearlyPriceLabel} billed yearly` })
        : null,

      el('div.mm-kvgrid.mm-mt-3',
        kv('Users', plan.max_users === -1 ? 'Unlimited' : fmt.number(plan.max_users)),
        kv('Companies', plan.max_companies === -1 ? 'Unlimited' : fmt.number(plan.max_companies)),
        kv('Storage', plan.storage_gb === -1 ? 'Unlimited' : `${plan.storage_gb} GB`),
        kv('Uploads a month', plan.max_uploads_month === -1 ? 'Unlimited' : fmt.number(plan.max_uploads_month)),
        kv('Support', fmt.label(plan.support_level)),
        kv('Trial', plan.trial_days ? `${plan.trial_days} days` : 'None')),

      (plan.features ?? []).length
        ? el('details.mm-details.mm-mt-3',
            el('summary', { text: `${fmt.plural(plan.features.length, 'feature')} included` }),
            el('div.mm-row.mm-gap-1.mm-wrap.mm-mt-2',
              ...plan.features.map(feature => pill(feature.feature_key ?? feature.key ?? feature, 'neutral'))))
        : null),
  });
}

async function editPlan(plan, reload) {
  const payload = await modal({
    title: `Edit ${plan.name}`,
    description: 'Existing subscriptions keep their current limits until their next plan change.',
    body: ({ close }) => {
      const name = el('input.mm-input', { value: plan.name });
      const tagline = el('input.mm-input', { value: plan.tagline ?? '' });
      const monthly = el('input.mm-input', {
        type: 'number', min: '0', step: '1', value: String((plan.monthly_price_paise ?? 0) / 100),
      });
      const yearly = el('input.mm-input', {
        type: 'number', min: '0', step: '1', value: String((plan.yearly_price_paise ?? 0) / 100),
      });
      const maxUsers = el('input.mm-input', { type: 'number', min: '-1', value: String(plan.max_users ?? -1) });
      const maxCompanies = el('input.mm-input', { type: 'number', min: '-1', value: String(plan.max_companies ?? -1) });
      const storageGb = el('input.mm-input', { type: 'number', min: '-1', value: String(plan.storage_gb ?? -1) });
      const uploads = el('input.mm-input', { type: 'number', min: '-1', value: String(plan.max_uploads_month ?? -1) });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            name: name.value.trim(),
            tagline: tagline.value.trim() || undefined,
            monthlyPricePaise: Math.round((Number(monthly.value) || 0) * 100),
            yearlyPricePaise: Math.round((Number(yearly.value) || 0) * 100),
            maxUsers: Number(maxUsers.value),
            maxCompanies: Number(maxCompanies.value),
            storageGb: Number(storageGb.value),
            maxUploadsMonth: Number(uploads.value),
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Name' }), name),
        el('div.mm-field', el('label.mm-field__label', { text: 'Tagline' }), tagline),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Monthly (₹)' }), monthly),
          el('div.mm-field', el('label.mm-field__label', { text: 'Yearly (₹)' }), yearly)),
        el('p.mm-field__hint', { text: 'Use −1 for “unlimited” on any of the limits below.' }),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Users' }), maxUsers),
          el('div.mm-field', el('label.mm-field__label', { text: 'Companies' }), maxCompanies)),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Storage (GB)' }), storageGb),
          el('div.mm-field', el('label.mm-field__label', { text: 'Uploads a month' }), uploads)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Save' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.patch(`/platform/plans/${plan.key}`, payload);
    notify.success('Saved.');
    if (data?.note) notify.info(data.note, { title: 'Existing subscriptions' });
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
