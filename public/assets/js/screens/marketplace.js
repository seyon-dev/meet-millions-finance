/**
 * The add-on marketplace.
 *
 * Thirty modules, grouped by what they do. Each card says what it costs, what
 * it needs, and — crucially — whether the credentials it depends on are
 * actually present on this deployment. An add-on that is "active" but has no
 * API key does nothing, and saying so here is the difference between a
 * product and a brochure.
 */

import { el, frag, render } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as fmt from '../core/format.js';
import * as session from '../core/session.js';
import {
  pageHead, card, stat, button, statusPill, pill, emptyState, errorState,
  notify, notifyError, confirm, modal, banner, skeletonTiles,
} from '../core/ui.js';
import { setBreadcrumbs } from '../layout/shell.js';

export default async function marketplaceScreen({ query }) {
  setBreadcrumbs([{ label: 'Add-ons' }]);

  const page = el('div.mm-page');
  render(page, skeletonTiles(4));

  async function load() {
    try {
      const { data } = await api.get('/addons');
      render(page, ...build(data, load, query));
      // A link like /marketplace?addon=whatsapp_business_api opens that one.
      const wanted = query.get('addon');
      if (wanted) {
        const addOn = data.addOns.find(a => a.key === wanted);
        if (addOn) queueMicrotask(() => openAddOn(addOn, load));
      }
    } catch (err) {
      render(page, errorState(err, { onRetry: load }));
    }
  }

  await load();
  return page;
}

function build(data, reload, query) {
  const { addOns, categories, bundles, summary } = data;
  const canManage = session.can('addons.activate');

  // Categories carry their own key and number; an add-on names the number.
  // Matching on the display name would break the moment a category is renamed.
  const activeCategory = query.get('category');
  const activeNo = (categories ?? []).find(c => c.key === activeCategory)?.no ?? null;
  const shown = activeNo === null ? addOns : addOns.filter(a => a.categoryNo === activeNo);

  return [
    pageHead({
      title: 'Add-ons',
      // The calling system is catalogued alongside the add-ons but is not one
      // of the thirty, so the count and the card total do not disagree.
      subtitle: [
        `${summary.total} add-on modules`,
        addOns.some(a => a.isSystemModule) ? 'plus the built-in cloud calling system' : null,
        `${summary.active} active`,
        `${summary.monthlySpendFormatted} a month`,
      ].filter(Boolean).join(' · '),
      actions: button('Your subscription', { variant: 'ghost', icon: 'credit-card', href: '/billing/subscription' }),
    }),

    el('div.mm-grid.mm-grid-4.mm-gap-4',
      stat({ label: 'Available', value: fmt.number(summary.total), icon: 'package' }),
      stat({ label: 'Active', value: fmt.number(summary.active), icon: 'check-circle', tone: 'success' }),
      stat({ label: 'Monthly spend', value: summary.monthlySpendFormatted, icon: 'rupee' }),
      stat({ label: 'Your plan', value: fmt.label(summary.planKey), icon: 'grid', href: '/billing/subscription' })),

    bundles?.length ? bundlesCard(bundles, canManage, reload) : null,

    categoryStrip(categories ?? [], activeCategory),

    el('div.mm-addon-grid',
      ...shown.map(addOn => addOnCard(addOn, reload))),

    shown.length
      ? null
      : emptyState({ title: 'No add-ons in this category', icon: 'package' }),
  ].filter(Boolean);
}

function categoryStrip(categories, active) {
  return el('div.mm-tabs.mm-tabs--scroll',
    el('a.mm-tab', {
      href: '/marketplace',
      class: active ? '' : 'is-active',
    }, el('span', { text: 'Everything' })),
    ...categories.map(category => el('a.mm-tab', {
      href: `/marketplace?category=${encodeURIComponent(category.key)}`,
      class: category.key === active ? 'is-active' : '',
    },
      el('span', { text: category.name }),
      el('span.mm-tab__count', { text: `${category.activeCount}/${category.count}` }))));
}

/**
 * One add-on.
 *
 * The status line is the honest bit: active, inactive, or active-but-not-
 * connected. The third is the one that matters, and it names the keys that
 * are missing rather than saying "configuration required".
 */
function addOnCard(addOn, reload) {
  const connected = addOn.connectionStatus === 'connected' || addOn.connectionStatus === 'self_hosted';
  const needsKeys = addOn.isActive && addOn.requiresCredentials && !addOn.credentialsReady;

  return el('article.mm-card.mm-addon', {
    class: [addOn.isActive ? 'is-active' : '', needsKeys ? 'is-incomplete' : ''].filter(Boolean).join(' '),
    tabindex: '0',
    role: 'button',
    'aria-label': `${addOn.name} — see details`,
    onClick: () => openAddOn(addOn, reload),
    onKeydown: (e) => { if (e.key === 'Enter') openAddOn(addOn, reload); },
  },
    el('header.mm-addon__top',
      el('span.mm-addon__icon', {
        class: addOn.accent ? `mm-addon__icon--${addOn.accent}` : '',
      }, icon(addOn.icon ?? 'package')),
      el('div',
        el('h3.mm-addon__name', { text: addOn.name }),
        el('p.mm-addon__cat', { text: `#${addOn.number} · ${addOn.category}` })),
      el('span.mm-grow'),
      addOn.isActive ? pill('Active', 'success') : null),

    el('p.mm-addon__desc', { text: addOn.description }),

    el('ul.mm-ticklist.mm-addon__ticks',
      ...(addOn.features ?? []).slice(0, 3).map(feature => el('li',
        icon('check', { size: 'sm' }),
        el('span', { text: feature })))),

    el('div.mm-addon__price',
      el('span.mm-addon__price-v', { text: addOn.monthlyFormatted }),
      el('span.mm-addon__price-p', { text: '/month' }),
      addOn.setupPaise
        ? el('span.mm-addon__price-p', { text: `· ${addOn.setupFormatted} setup` })
        : null),

    el('footer.mm-addon__foot',
      needsKeys
        ? pill('Needs credentials', 'warning')
        : (addOn.isActive
            ? pill(connected ? 'Connected' : 'Not connected', connected ? 'success' : 'neutral')
            : el('span.mm-muted.mm-text-xs', { text: fmt.label(addOn.bestPlan) })),
      el('span.mm-grow'),
      el('span.mm-addon__cta', { text: 'See details →' })));
}

/** The full record for one add-on, and the activate/deactivate action. */
async function openAddOn(addOn, reload) {
  const canManage = session.can('addons.activate');

  const result = await modal({
    title: addOn.name,
    description: `${addOn.category} · Add-on #${addOn.number}`,
    size: 'lg',
    body: ({ close }) => frag(
      addOn.isActive && addOn.requiresCredentials && !addOn.credentialsReady
        ? banner({
            text: `This add-on is active but ${addOn.missingCredentials.join(', ')} ${addOn.missingCredentials.length === 1 ? 'is' : 'are'} not set on this deployment, so it cannot do anything yet.`,
            tone: 'warning',
            icon: 'key',
            action: session.can('integrations.manage')
              ? { label: 'Open integrations', href: '/settings/integrations' }
              : null,
          })
        : null,

      el('p.mm-prose', { text: addOn.description }),

      addOn.businessBenefit
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Why a practice buys it' }),
            el('p.mm-prose', { text: addOn.businessBenefit }))
        : null,

      addOn.workflow
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'How it works' }),
            el('p.mm-prose.mm-mono.mm-text-sm', { text: addOn.workflow }))
        : null,

      el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
        listBlock('What you get', addOn.features ?? [], 'check'),
        listBlock('Screens it adds', addOn.uiScreens ?? [], 'layout-dashboard')),

      el('div.mm-grid.mm-grid-2.mm-gap-4.mm-mt-4',
        listBlock('Who can use it', (addOn.userRoles ?? []).map(fmt.label), 'users'),
        listBlock('What it connects to', addOn.apisRequired ?? [], 'plug')),

      addOn.providerKeys?.length
        ? frag(
            el('h3.mm-label.mm-mt-4', { text: 'Credentials it needs' }),
            el('ul.mm-keylist',
              ...addOn.providerKeys.map(key => el('li',
                el('code.mm-mono', { text: key }),
                addOn.missingCredentials?.includes(key)
                  ? pill('Missing', 'warning')
                  : pill('Set', 'success')))),
            el('p.mm-muted.mm-text-xs.mm-mt-2', {
              text: 'Credentials are environment variables on the Worker. They are never stored in this interface and never leave the server.',
            }))
        : null,

      el('div.mm-row.mm-gap-3.mm-center.mm-mt-5',
        el('div',
          el('p.mm-fw-medium', { text: `${addOn.monthlyFormatted} a month` }),
          addOn.setupPaise
            ? el('p.mm-muted.mm-text-xs', { text: `${addOn.setupFormatted} one-off setup fee` })
            : null,
          el('p.mm-muted.mm-text-xs', { text: `Recommended on ${addOn.bestPlan}` })),
        el('span.mm-grow'),
        el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Close', onClick: () => close(null) }),
        canManage
          ? el('button.mm-btn', {
              class: addOn.isActive ? 'mm-btn--danger' : 'mm-btn--primary',
              type: 'button',
              text: addOn.isActive ? 'Turn it off' : 'Activate',
              onClick: () => close({ action: addOn.isActive ? 'deactivate' : 'activate' }),
            })
          : null)),
  });

  if (!result) return;
  if (result.action === 'activate') await activate(addOn, reload);
  else await deactivate(addOn, reload);
}

function listBlock(title, items, iconName) {
  if (!items.length) return null;
  return el('div',
    el('h3.mm-label', { text: title }),
    el('ul.mm-ticklist',
      ...items.map(item => el('li',
        icon(iconName, { size: 'sm' }),
        el('span', { text: item })))));
}

async function activate(addOn, reload) {
  if (addOn.setupPaise) {
    const answer = await confirm({
      title: `Activate ${addOn.name}?`,
      message: `${addOn.monthlyFormatted} a month, plus a one-off setup fee of ${addOn.setupFormatted}.`,
      detail: addOn.requiresCredentials
        ? `It also needs ${addOn.providerKeys.join(', ')} to be set on the server before it can do anything.`
        : null,
      confirmLabel: 'Activate',
    });
    if (!answer) return;
  }

  try {
    const { data } = await api.post(`/addons/${addOn.key}/activate`, {
      billingCycle: 'monthly',
      acknowledgeSetupFee: true,
    });
    notify.success(`${addOn.name} is on.`);

    if (data?.missingCredentials?.length) {
      notify.warning(
        `It needs ${data.missingCredentials.join(', ')} before it can do anything.`,
        {
          title: 'Not connected yet',
          action: { label: 'Open integrations', onClick: () => { window.location.href = '/settings/integrations'; } },
        });
    }

    // Entitlements changed: the sidebar and every gate must be re-read.
    await session.load();
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

async function deactivate(addOn, reload) {
  const answer = await confirm({
    title: `Turn off ${addOn.name}?`,
    message: 'Its screens close and it stops billing at the end of the current period.',
    detail: 'Nothing it produced is deleted. Turning it back on restores access to all of it.',
    confirmLabel: 'Turn it off',
    tone: 'danger',
  });
  if (!answer) return;

  try {
    await api.post(`/addons/${addOn.key}/deactivate`, {});
    notify.success(`${addOn.name} is off.`);
    await session.load();
    await reload();
  } catch (err) {
    notifyError(err);
  }
}

function bundlesCard(bundles, canManage, reload) {
  return card({
    title: 'Bundles',
    subtitle: 'The add-ons a practice on each plan usually takes, priced together.',
    body: el('div.mm-grid.mm-grid-4.mm-gap-4',
      ...bundles.map(bundle => el('article.mm-bundle', {
        class: bundle.recommended ? 'is-recommended' : '',
      },
        bundle.recommended ? el('span.mm-bundle__flag', { text: 'For your plan' }) : null,
        el('h3.mm-bundle__name', { text: bundle.label }),
        el('p.mm-bundle__price', { text: `${bundle.monthlyFormatted}/month` }),
        bundle.setupPaise
          ? el('p.mm-muted.mm-text-xs', { text: `${bundle.setupFormatted} setup` })
          : null,
        el('p.mm-muted.mm-text-xs', { text: fmt.plural(bundle.addOnKeys.length, 'add-on') }),
        canManage
          ? button('Activate the bundle', {
              variant: bundle.recommended ? 'primary' : 'outline',
              size: 'sm',
              onClick: () => activateBundle(bundle, reload),
            })
          : null))),
  });
}

async function activateBundle(bundle, reload) {
  const answer = await confirm({
    title: `Activate the ${bundle.label} bundle?`,
    message: `${fmt.plural(bundle.addOnKeys.length, 'add-on')} at ${bundle.monthlyFormatted} a month${bundle.setupPaise ? `, plus ${bundle.setupFormatted} in setup fees` : ''}.`,
    detail: 'Any that need credentials will say so once they are on.',
    confirmLabel: 'Activate them',
  });
  if (!answer) return;

  try {
    const { data } = await api.post(`/addons/bundles/${bundle.plan}`, { acknowledgeSetupFee: true });
    notify.success(`${fmt.plural(data?.activated?.length ?? bundle.addOnKeys.length, 'add-on')} activated.`);
    if (data?.missingCredentials?.length) {
      notify.warning(`Some still need credentials: ${data.missingCredentials.slice(0, 4).join(', ')}.`, {
        title: 'Not fully connected',
      });
    }
    await session.load();
    await reload();
  } catch (err) {
    notifyError(err);
  }
}
