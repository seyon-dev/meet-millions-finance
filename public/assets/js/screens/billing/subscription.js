/**
 * The subscription.
 *
 * What the practice is on, what it is using against its limits, and what the
 * other plans would give them. The usage meters come first: a plan screen that
 * leads with prices is a sales page, and this is a settings screen.
 */

import { el, frag, render } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { api } from '../../core/api.js';
import * as fmt from '../../core/format.js';
import * as session from '../../core/session.js';
import {
  pageHead, card, kv, stat, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, modal, promptText, banner, skeletonTiles,
} from '../../core/ui.js';
import { setBreadcrumbs } from '../../layout/shell.js';

const METRIC_LABELS = {
  users: 'Team members',
  companies: 'Companies',
  storage_bytes: 'Storage',
  uploads: 'Uploads this month',
};

export default async function subscriptionScreen() {
  setBreadcrumbs([{ label: 'Subscription' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4));

  async function load() {
    try {
      const [{ data: current }, { data: catalogue }] = await Promise.all([
        api.get('/billing/subscription'),
        api.get('/billing/plans'),
      ]);
      render(page, ...build(current, catalogue, load));
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(current, catalogue, reload) {
  const { subscription, entitlements, addOns, billing, invoices } = current;
  const canManage = session.can('subscriptions.manage');

  return [
    pageHead({
      title: 'Subscription',
      subtitle: `${subscription.planName} · ${fmt.label(subscription.billingCycle)} · ${billing.totalMonthlyFormatted} a month`,
      actions: canManage
        ? frag(
            button('Add-ons', { variant: 'ghost', icon: 'package', href: '/marketplace' }),
            subscription.cancelAtPeriodEnd
              ? null
              : button('Change plan', {
                  variant: 'primary', icon: 'arrow-up-right',
                  onClick: () => changePlan(catalogue, subscription, reload),
                }))
        : null,
    }),

    subscription.status === 'trialing'
      ? banner({
          text: `You are on a trial of ${subscription.planName}. It ends ${fmt.date(subscription.trialEndsAt)} — ${fmt.plural(Math.max(0, Math.ceil((new Date(subscription.trialEndsAt) - Date.now()) / 86400000)), 'day')} left.`,
          tone: 'info',
          icon: 'clock',
        })
      : null,

    subscription.cancelAtPeriodEnd
      ? banner({
          text: `This subscription ends on ${fmt.date(subscription.currentPeriodEnd)} and will not renew.`,
          tone: 'warning',
          icon: 'alert',
          action: canManage ? { label: 'Keep it', onClick: () => resume(reload) } : null,
        })
      : null,

    usageRow(entitlements),

    el('div.mm-grid.mm-grid-2-1.mm-gap-4',
      el('div.mm-stack.mm-gap-4',
        plansCard(catalogue, subscription, canManage, reload),
        addOnsCard(addOns ?? [], billing)),

      el('div.mm-stack.mm-gap-4',
        detailsCard(subscription, billing),
        paymentOptionsCard(catalogue.paymentOptions ?? []),
        invoicesCard(invoices ?? []),
        canManage && !subscription.cancelAtPeriodEnd ? cancelCard(reload) : null)),
  ].filter(Boolean);
}

/**
 * Usage against the plan's limits.
 *
 * An unlimited allowance says so rather than showing a meter at 0%, which
 * would read as "none used of none available".
 */
function usageRow(entitlements) {
  const metrics = Object.keys(entitlements.limits ?? {});
  if (!metrics.length) return null;

  return el('div.mm-grid.mm-grid-4.mm-gap-4',
    ...metrics.map((metric) => {
      const usage = session.usageOf(metric);
      const isBytes = metric === 'storage_bytes';
      const used = isBytes ? fmt.bytes(usage.used) : fmt.number(usage.used);
      const limit = usage.unlimited
        ? 'Unlimited'
        : isBytes ? fmt.bytes(usage.limit) : fmt.number(usage.limit);

      return card({
        className: 'mm-card--meter',
        body: frag(
          el('p.mm-stat__label', { text: METRIC_LABELS[metric] ?? fmt.label(metric) }),
          el('p.mm-stat__value', { text: used }),
          usage.unlimited
            ? el('p.mm-muted.mm-text-xs', { text: 'Unlimited on this plan' })
            : frag(
                el('span.mm-progress.mm-progress--sm.mm-mt-2',
                  el('span.mm-progress__bar', {
                    class: usage.pct >= 90 ? 'mm-progress__bar--danger' : usage.pct >= 75 ? 'mm-progress__bar--warning' : '',
                    style: { width: `${usage.pct ?? 0}%` },
                  })),
                el('p.mm-muted.mm-text-xs.mm-mt-1', { text: `of ${limit}` }))),
      });
    }));
}

function plansCard(catalogue, subscription, canManage, reload) {
  const plans = catalogue.plans ?? [];

  return card({
    title: 'Plans',
    subtitle: 'What each one includes. Changing takes effect immediately.',
    body: frag(
      el('div.mm-plans',
        ...plans.map(plan => el('article.mm-plan', {
          class: [
            plan.isCurrent ? 'is-current' : '',
            plan.isPopular ? 'is-popular' : '',
          ].filter(Boolean).join(' '),
        },
          plan.isPopular && !plan.isCurrent ? el('span.mm-plan__flag', { text: 'Most chosen' }) : null,
          plan.isCurrent ? el('span.mm-plan__flag.mm-plan__flag--current', { text: 'Your plan' }) : null,

          el('h3.mm-plan__name', { text: plan.name }),
          el('p.mm-plan__tagline', { text: plan.tagline }),
          el('p.mm-plan__price',
            el('span.mm-plan__amount', { text: plan.monthlyFormatted }),
            el('span.mm-plan__per', { text: '/month' })),
          plan.yearlyPaise
            ? el('p.mm-muted.mm-text-xs', { text: `${plan.yearlyFormatted} billed yearly` })
            : null,

          el('ul.mm-plan__limits',
            el('li', { text: plan.maxUsers === -1 ? 'Unlimited users' : fmt.plural(plan.maxUsers, 'user') }),
            el('li', { text: plan.maxCompanies === -1 ? 'Unlimited companies' : fmt.plural(plan.maxCompanies, 'company', 'companies') }),
            el('li', { text: plan.storageGb === -1 ? 'Unlimited storage' : `${plan.storageGb} GB storage` }),
            el('li', { text: plan.maxUploadsMonth === -1 ? 'Unlimited uploads' : `${fmt.number(plan.maxUploadsMonth)} uploads a month` }),
            el('li', { text: `${fmt.label(plan.supportLevel)} support` })),

          plan.isCurrent
            ? button('Current plan', { variant: 'ghost', disabled: true })
            : (canManage
                ? button(`Switch to ${plan.name}`, {
                    variant: 'outline',
                    onClick: () => changePlan(catalogue, subscription, reload, plan.key),
                  })
                : null)))),

      (catalogue.comparison ?? []).length
        ? el('details.mm-details.mm-mt-4',
            el('summary', { text: 'Compare the plans line by line' }),
            comparisonTable(catalogue))
        : null),
  });
}

function comparisonTable(catalogue) {
  const plans = catalogue.plans ?? [];
  return el('div.mm-table-wrap.mm-mt-3',
    el('table.mm-table.mm-table--compact',
      el('thead',
        el('tr',
          el('th', { text: '' }),
          ...plans.map(plan => el('th', { text: plan.name })))),
      el('tbody',
        ...catalogue.comparison.map(row => el('tr',
          el('td', { text: row.label }),
          ...plans.map(plan => el('td', { text: String(row.values?.[plan.key] ?? '—') })))))));
}

function addOnsCard(addOns, billing) {
  return card({
    title: 'Active add-ons',
    subtitle: addOns.length
      ? `${fmt.money(billing.addOnMonthlyPaise)} a month on top of the plan`
      : null,
    actions: button('Browse add-ons', { variant: 'ghost', size: 'sm', icon: 'package', href: '/marketplace' }),
    flush: true,
    body: addOns.length
      ? el('ul.mm-list',
          ...addOns.map(addOn => el('li.mm-list__row',
            el('span.mm-list__icon.mm-c-brand', icon(addOn.icon ?? 'package', { size: 'sm' })),
            el('div.mm-list__main',
              el('span.mm-fw-medium', { text: addOn.name }),
              el('span.mm-muted.mm-text-xs', {
                text: [addOn.category, addOn.activatedAt ? `since ${fmt.date(addOn.activatedAt)}` : null]
                  .filter(Boolean).join(' · '),
              })),
            el('span.mm-numeric.mm-text-sm', { text: addOn.monthlyFormatted ?? fmt.money(addOn.monthlyPaise) }),
            statusPill(addOn.status))))
      : emptyState({
          title: 'No add-ons active',
          message: 'Thirty modules are available — WhatsApp, cloud calling, OCR, e-sign and more.',
          icon: 'package',
          inline: true,
          action: { label: 'Browse them', onClick: () => { window.location.href = '/marketplace'; } },
        }),
  });
}

function detailsCard(subscription, billing) {
  return card({
    title: 'Billing',
    actions: statusPill(subscription.status),
    body: el('div.mm-kvgrid',
      kv('Plan', subscription.planName),
      kv('Cycle', fmt.label(subscription.billingCycle)),
      kv('Seats', subscription.seats),
      kv('Plan charge', fmt.money(billing.planMonthlyPaise)),
      kv('Add-ons', fmt.money(billing.addOnMonthlyPaise)),
      kv('Total a month', billing.totalMonthlyFormatted),
      kv('Period started', fmt.date(subscription.currentPeriodStart)),
      kv('Renews', subscription.cancelAtPeriodEnd ? 'Not renewing' : fmt.date(subscription.currentPeriodEnd)),
      kv('Days to renewal', subscription.daysToRenewal),
      kv('Auto-renew', subscription.autoRenew ? 'On' : 'Off')),
  });
}

/**
 * How the practice can pay.
 *
 * Taken from the catalogue rather than hard-coded, so a payment option the
 * deployment does not offer is not advertised.
 */
function paymentOptionsCard(options) {
  if (!options.length) return null;
  return card({
    title: 'Payment options',
    flush: true,
    body: el('ul.mm-list',
      ...options.map(option => el('li.mm-list__row',
        el('span.mm-list__icon.mm-muted', icon(iconForOption(option.kind), { size: 'sm' })),
        el('div.mm-list__main',
          el('span.mm-fw-medium', { text: option.label }),
          option.detail ? el('span.mm-muted.mm-text-xs', { text: option.detail }) : null),
        pill(option.kind, 'neutral')))),
  });
}

function iconForOption(kind) {
  return { cycle: 'calendar', method: 'credit-card', discount: 'tag', term: 'clock' }[kind] ?? 'rupee';
}

function invoicesCard(invoices) {
  return card({
    title: 'Platform invoices',
    actions: button('All invoices', { variant: 'ghost', size: 'sm', href: '/billing/invoices' }),
    flush: true,
    body: invoices.length
      ? el('ul.mm-list',
          ...invoices.map(invoice => el('li.mm-list__row',
            el('a.mm-list__main', { href: `/billing/invoices/${invoice.id}` },
              el('span.mm-fw-medium', { text: invoice.invoiceNo }),
              el('span.mm-muted.mm-text-xs', { text: fmt.date(invoice.issueDate) })),
            el('span.mm-numeric.mm-text-sm', { text: invoice.totalFormatted ?? fmt.money(invoice.totalPaise) }),
            statusPill(invoice.status))))
      : emptyState({ title: 'No invoices yet', icon: 'receipt', inline: true }),
  });
}

function cancelCard(reload) {
  return card({
    title: 'Cancel',
    className: 'mm-card--danger',
    body: frag(
      el('p.mm-text-sm', {
        text: 'Cancelling keeps everything working until the end of the period you have paid for. Your data is not deleted.',
      }),
      el('div.mm-row.mm-mt-3',
        button('Cancel the subscription', { variant: 'danger', onClick: () => cancel(reload) }))),
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function changePlan(catalogue, subscription, reload, preselect = null) {
  const plans = (catalogue.plans ?? []).filter(p => !p.isCurrent);
  if (!plans.length) {
    notify.info('You are already on the highest plan.');
    return;
  }

  const payload = await modal({
    title: 'Change plan',
    description: 'The new limits apply straight away. Nothing already stored is removed if the new plan is smaller.',
    body: ({ close }) => {
      const planSelect = el('select.mm-select',
        ...plans.map(plan => el('option', {
          value: plan.key,
          selected: plan.key === preselect,
          text: `${plan.name} — ${plan.monthlyFormatted}/month`,
        })));
      const cycle = el('select.mm-select',
        el('option', { value: 'monthly', selected: subscription.billingCycle === 'monthly', text: 'Monthly' }),
        el('option', { value: 'yearly', selected: subscription.billingCycle === 'yearly', text: 'Yearly' }));
      const seats = el('input.mm-input', {
        type: 'number', min: '1', value: String(subscription.seats ?? 1),
      });

      return el('form.mm-form', {
        novalidate: true,
        onSubmit: (e) => {
          e.preventDefault();
          close({
            planKey: planSelect.value,
            billingCycle: cycle.value,
            seats: Number(seats.value) || 1,
          });
        },
      },
        el('div.mm-field', el('label.mm-field__label', { text: 'Plan' }), planSelect),
        el('div.mm-grid.mm-grid-2.mm-gap-3',
          el('div.mm-field', el('label.mm-field__label', { text: 'Billing cycle' }), cycle),
          el('div.mm-field', el('label.mm-field__label', { text: 'Seats' }), seats)),
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Change plan' })));
    },
  });
  if (!payload) return;

  try {
    const { data } = await api.post('/billing/subscription/change-plan', payload);
    // The response carries { plan: {key, name}, invoice, entitlements } — the
    // old read of data.subscription.planName never existed, so the toast
    // showed the raw plan key instead of its name.
    notify.success(`Now on ${data.plan?.name ?? payload.planKey}.`);
    if (data.invoice) {
      notify.info(`Invoice ${data.invoice.invoiceNumber ?? ''} has been raised for the new plan.`.replace('  ', ' '),
        { title: 'Billing' });
    }
    // Entitlements changed, so the navigation and gates must be re-read.
    await session.load();
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function cancel(reload) {
  const reason = await promptText({
    title: 'Cancel the subscription',
    message: 'Everything keeps working until the end of the period you have paid for.',
    label: 'Why are you leaving?',
    placeholder: 'Tell us what did not work — it is read.',
    required: false,
    confirmLabel: 'Cancel it',
    tone: 'danger',
  });
  if (reason === null) return;

  const answer = await confirm({
    title: 'Are you sure?',
    message: 'The subscription will not renew. You can undo this at any time before it ends.',
    confirmLabel: 'Yes, cancel',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.post('/billing/subscription/cancel', { reason: reason || undefined, immediate: false });
    notify.success('Cancelled. It runs until the end of this period.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function resume(reload) {
  try {
    const { data } = await api.post('/billing/subscription/resume', {});
    notify.success(data?.message ?? 'Kept. It will renew as normal.');
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
