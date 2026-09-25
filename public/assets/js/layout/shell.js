/**
 * The application shell: sidebar, topbar, company switcher, notification
 * centre, command palette host and the mobile tab bar.
 *
 * Built once and kept. Navigation swaps only the outlet's contents, so the
 * sidebar does not flicker, scroll position in the navigation survives, and
 * an open drawer is not torn down by a route change.
 */

import { el, render, frag, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { api } from '../core/api.js';
import * as session from '../core/session.js';
import * as router from '../core/router.js';
import { avatar, iconButton, notify, notifyError, banner } from '../core/ui.js';
import * as fmt from '../core/format.js';
import { openCommandPalette } from './command-palette.js';
import { mountCallWidget, unmountCallWidget } from './call-widget.js';
import { openNotifications } from './notifications.js';

let shell = null;
let outlet = null;
let navHost = null;
let unreadBadge = null;

export function mountShell(root) {
  const state = session.session();

  outlet = el('div#mm-main', { tabindex: '-1' });
  navHost = el('nav.mm-sidebar__nav', { 'aria-label': 'Main' });

  const sidebar = buildSidebar(state);
  const topbar = buildTopbar(state);
  const scrim = el('div.mm-sidebar__scrim', { onClick: closeDrawer });

  shell = el('div.mm-shell', { 'data-sidebar': railPreference(), 'data-drawer': 'closed' },
    scrim,
    sidebar,
    el('div.mm-shell__main',
      supportBanner(state),
      topbar,
      demoBanner(state),
      outlet,
      buildMobileNav(state)));

  render(root, shell);
  router.mount(outlet);
  paintNav();
  refreshUnread();
  refreshBadges();

  // A ringing phone has to be answerable from whatever screen somebody is on,
  // so the call widget lives beside the shell rather than inside /calls. It
  // mounts itself only when the person can see calls and the plan has
  // telephony, and polls nothing otherwise.
  mountCallWidget();

  // The shell rebuilds its navigation when entitlements change — activating an
  // add-on should light up its screen without a reload.
  session.subscribe(() => { paintNav(); mountCallWidget(); });
  document.addEventListener('mm:navigated', () => {
    paintNav();
    closeDrawer();
    refreshBadges();
  });

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')
      || document.activeElement?.isContentEditable;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openCommandPalette();
    } else if (e.key === '/' && !typing) {
      e.preventDefault();
      openCommandPalette();
    }
  });

  // The badge is polled rather than pushed: a Worker has no persistent
  // connection, and a minute's latency on a bell count costs nothing.
  setInterval(() => { refreshUnread(); refreshBadges(); }, 60000);

  return { outlet, refreshUnread };
}

/**
 * Sidebar state.
 *
 * The stylesheet reads two attributes on the shell: data-sidebar for the
 * collapsed rail on desktop, data-drawer for the off-canvas panel on mobile.
 * Keeping both in one place means the two never contradict each other.
 */
function railPreference() {
  try { return localStorage.getItem('mm.rail') === '1' ? 'collapsed' : 'expanded'; } catch { return 'expanded'; }
}

function toggleRail() {
  const next = shell.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed';
  shell.dataset.sidebar = next;
  try { localStorage.setItem('mm.rail', next === 'collapsed' ? '1' : '0'); } catch { /* private mode */ }
}

function toggleDrawer() {
  const open = shell.dataset.drawer === 'open';
  shell.dataset.drawer = open ? 'closed' : 'open';
  document.querySelector('.mm-topbar__menu')?.setAttribute('aria-expanded', String(!open));
}

function closeDrawer() {
  if (!shell) return;
  shell.dataset.drawer = 'closed';
  document.querySelector('.mm-topbar__menu')?.setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
function buildSidebar(state) {
  return el('aside.mm-sidebar', { 'aria-label': 'Sidebar' },
    el('div.mm-sidebar__brand',
      el('a.mm-brand-mark', { href: session.landingPath(), 'aria-label': 'Home' },
        brandMark(state)),
      el('div.mm-brand-text',
        el('span.mm-brand-text__name', {
          text: state.branding?.productName ?? 'Meet Millions',
        }),
        el('span.mm-brand-text__sub', { text: state.tenant?.name ?? 'Finance CRM' })),
      el('button.mm-sidebar__collapse', {
        type: 'button',
        'aria-label': 'Collapse sidebar',
        onClick: toggleRail,
      }, icon('chevron-left', { size: 'sm' }))),

    companySwitcher(state),
    navHost,
    sidebarFooter(state));
}

function brandMark(state) {
  if (state.branding?.enabled && state.branding.logoKey) {
    return el('img', {
      src: `/files/assets/logo/${state.tenant?.id}`,
      alt: state.branding.productName ?? 'Logo',
      class: 'mm-brand-mark__img',
    });
  }
  return el('span', { text: 'MM' });
}

/**
 * The company switcher.
 *
 * Shown to everyone who has more than one company, and shown *locked* rather
 * than hidden when the plan does not include switching — so the capability is
 * discoverable instead of invisible.
 */
function companySwitcher(state) {
  if (!state.companies?.length) return null;
  const active = state.companies.find(c => c.id === state.activeCompanyId) ?? state.companies[0];
  const canSwitch = state.companies.length > 1
    && session.can('companies.switch')
    && session.hasFeature('multi_company');

  return el('div.mm-sidebar__scope',
    el('button.mm-scope-switch', {
      type: 'button',
      disabled: !canSwitch && state.companies.length > 1 ? false : state.companies.length <= 1,
      title: canSwitch ? 'Switch company' : 'Multi-company switching is a Pro feature',
      onClick: () => (canSwitch ? openCompanySwitcher(state) : explainLockedSwitcher()),
    },
      el('div.mm-scope-switch__main',
        el('span.mm-scope-switch__name', { text: active?.name ?? 'No company' }),
        el('span.mm-scope-switch__meta', {
          text: active?.gstin ?? `${state.companies.length} ${state.companies.length === 1 ? 'company' : 'companies'}`,
        })),
      state.companies.length > 1
        ? (canSwitch ? icon('chevron-down', { size: 'sm' }) : icon('lock', { size: 'sm' }))
        : null));
}

function explainLockedSwitcher() {
  notify.warning('Switching between companies is included from the Pro plan upward.', {
    title: 'Multi-company',
    action: { label: 'Compare plans', onClick: () => router.go('/billing/subscription') },
  });
}

async function openCompanySwitcher(state) {
  const { modal } = await import('../core/ui.js');
  await modal({
    title: 'Switch company',
    description: 'Everything in the CRM is scoped to the company you choose.',
    size: 'sm',
    body: ({ close }) => el('ul.mm-menu',
      ...state.companies.map(company => el('li',
        el('button.mm-menu__item', {
          type: 'button',
          class: company.id === state.activeCompanyId ? 'is-active' : '',
          onClick: async () => {
            try {
              await api.post('/companies/switch', { companyId: company.id });
              close(company.id);
              // A full reload is right here: every open screen is scoped to
              // the old company and would otherwise show mixed data.
              window.location.reload();
            } catch (err) {
              notifyError(err);
              close(null);
            }
          },
        },
          el('div',
            el('span.mm-fw-medium', { text: company.name }),
            company.gstin ? el('span.mm-muted.mm-text-xs.mm-block', { text: company.gstin }) : null),
          company.id === state.activeCompanyId ? icon('check', { size: 'sm' }) : null)))),
  });
}

function sidebarFooter(state) {
  return el('div.mm-sidebar__footer',
    el('button.mm-usermenu-btn', {
      type: 'button',
      'aria-label': 'Account menu',
      onClick: (e) => openUserMenu(e.currentTarget),
    },
      avatar(state.user?.fullName, { size: 'sm' }),
      el('div.mm-usermenu-btn__text',
        el('span.mm-usermenu-btn__name', { text: state.user?.fullName ?? 'Account' }),
        el('span.mm-usermenu-btn__role', {
          text: fmt.label(state.roles?.[0]?.name ?? state.roles?.[0]?.key ?? ''),
        })),
      icon('chevron-up', { size: 'sm' })));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
/**
 * Live counters for the sidebar.
 *
 * The navigation names a counter key per item ("pendingVerification"); the
 * server resolves those keys to numbers. Until they arrive no badge is shown
 * — printing the key itself would put the word "pendingVerification" in the
 * sidebar, which is what happens if this map is missing.
 */
let badges = {};

function paintNav() {
  const state = session.session();
  const groups = state.navigation?.groups ?? [];
  const here = window.location.pathname;

  render(navHost, ...groups.map(group => el('div.mm-nav-group',
    el('p.mm-nav-group__label', { text: group.label }),
    ...group.items.map(item => navItem(item, here)))));
}

/** Poll the counters. A failure leaves the previous numbers in place. */
export async function refreshBadges() {
  if (!session.isSignedIn()) return;
  try {
    const { data } = await api.get('/dashboard/badges');
    badges = data?.badges ?? {};
    paintNav();
    paintMobileBadges();
  } catch {
    // A badge is a convenience. If the count cannot be fetched the navigation
    // still works, and a stale number is better than an error nobody asked for.
  }
}

function navItem(item, here) {
  const active = here === item.path
    || (item.path !== '/' && here.startsWith(item.path.split('?')[0]) && item.path.split('?')[0].length > 1);

  return el('a.mm-nav-item', {
    href: item.path,
    class: [active ? 'is-active' : '', item.locked ? 'is-locked' : ''].filter(Boolean).join(' '),
    'aria-current': active ? 'page' : null,
    title: item.locked ? `${item.lock?.featureName ?? item.label} is not in your plan` : item.label,
  },
    el('span.mm-nav-item__icon', icon(item.icon ?? 'grid')),
    el('span.mm-nav-item__label', { text: item.label }),
    item.locked
      ? el('span.mm-nav-item__lock', icon('lock', { size: 'sm' }))
      : badgeNode(item.badge));
}

/** A count, or nothing. Zero is nothing — a badge reading "0" is noise. */
function badgeNode(key) {
  if (!key) return null;
  const count = badges[key];
  if (!count) return null;
  return el('span.mm-nav-item__badge', { text: count > 99 ? '99+' : String(count) });
}

function buildMobileNav(state) {
  const tabs = state.navigation?.mobileTabs ?? [];
  if (!tabs.length) return null;

  return el('nav.mm-mobilenav', { 'aria-label': 'Primary' },
    ...tabs.map(tab => el('a.mm-mobilenav__item', {
      href: tab.path,
      class: window.location.pathname === tab.path ? 'is-active' : '',
    },
      icon(tab.icon ?? 'grid'),
      el('span.mm-mobilenav__label', { text: tab.label }),
      tab.badge ? el('span.mm-mobilenav__badge.mm-nav-item__badge', { 'data-badge': tab.badge }) : null)),
    el('button.mm-mobilenav__item', {
      type: 'button',
      'aria-label': 'More',
      onClick: toggleDrawer,
    }, icon('menu'), el('span', { text: 'More' })));
}

function paintMobileBadges() {
  for (const node of document.querySelectorAll('.mm-mobilenav__badge')) {
    const count = badges[node.dataset.badge];
    node.hidden = !count;
    node.textContent = count ? (count > 99 ? '99+' : String(count)) : '';
  }
}

// ---------------------------------------------------------------------------
// Topbar
// ---------------------------------------------------------------------------
function buildTopbar(state) {
  unreadBadge = el('span.mm-iconbtn__badge', { hidden: true });

  return el('header.mm-topbar',
    el('button.mm-iconbtn.mm-topbar__menu', {
      type: 'button',
      'aria-label': 'Open navigation',
      'aria-expanded': 'false',
      onClick: toggleDrawer,
    }, icon('menu')),

    el('nav.mm-topbar__crumbs#mm-crumbs', { 'aria-label': 'Breadcrumb' }),
    el('span.mm-topbar__spacer'),

    el('button.mm-searchbtn', {
      type: 'button',
      onClick: () => openCommandPalette(),
      'aria-label': 'Search',
    },
      icon('search', { size: 'sm' }),
      el('span', { text: 'Search' }),
      el('kbd.mm-kbd', { text: navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl K' })),

    el('div.mm-topbar__actions',
      el('button.mm-iconbtn', {
        type: 'button',
        'aria-label': 'Notifications',
        onClick: () => openNotifications({ onRead: refreshUnread }),
      }, icon('bell'), unreadBadge),

      el('button.mm-iconbtn', {
        type: 'button',
        'aria-label': 'Switch theme',
        onClick: cycleTheme,
      }, icon(document.documentElement.getAttribute('data-theme') === 'light' ? 'moon' : 'sun')),

      el('button.mm-usermenu-btn.mm-topbar__user', {
        type: 'button',
        'aria-label': 'Account menu',
        onClick: (e) => openUserMenu(e.currentTarget),
      }, avatar(state.user?.fullName, { size: 'sm' }))));
}

function cycleTheme(e) {
  // Cycle the stored PREFERENCE (dark -> light -> system), not the resolved
  // attribute — the attribute is always set, so it can never say "system".
  let current = 'system';
  try { current = localStorage.getItem('mm.theme') ?? 'system'; } catch { /* resolved icon still cycles */ }
  const next = current === 'dark' ? 'light' : current === 'light' ? 'system' : 'dark';
  session.setTheme(next);

  const button = e.currentTarget;
  const resolved = document.documentElement.getAttribute('data-theme');
  render(button, icon(resolved === 'light' ? 'moon' : 'sun'));
  notify.info(`Theme: ${next === 'system' ? 'matching your system' : next}`, { timeout: 1800 });
}

/** Update the bell badge from the server's own count. */
export async function refreshUnread() {
  if (!session.isSignedIn() || !unreadBadge) return;
  try {
    const { data } = await api.get('/notifications/unread-count');
    const count = data?.unread ?? 0;
    unreadBadge.hidden = count === 0;
    unreadBadge.textContent = count > 99 ? '99+' : String(count);
    unreadBadge.classList.toggle('is-urgent', (data?.urgent ?? 0) > 0);
  } catch {
    // A failed badge poll is not worth a message; the count simply stays.
  }
}

// ---------------------------------------------------------------------------
// Account menu
// ---------------------------------------------------------------------------
let openMenu = null;

function openUserMenu(anchor) {
  if (openMenu) { closeMenu(); return; }
  const state = session.session();

  const menu = el('div.mm-menu.mm-menu--float', { role: 'menu' },
    el('div.mm-menu__label',
      el('span.mm-fw-medium.mm-block', { text: state.user?.fullName ?? '' }),
      el('span.mm-muted.mm-text-xs', { text: state.user?.email ?? '' })),
    el('a.mm-menu__item', { href: '/settings/profile', role: 'menuitem' },
      icon('user', { size: 'sm' }), el('span', { text: 'Your profile' })),
    el('a.mm-menu__item', { href: '/settings/security', role: 'menuitem' },
      icon('shield', { size: 'sm' }), el('span', { text: 'Security' })),
    session.can('settings.view')
      ? el('a.mm-menu__item', { href: '/settings', role: 'menuitem' },
          icon('settings', { size: 'sm' }), el('span', { text: 'Settings' }))
      : null,
    el('div.mm-menu__sep'),
    el('button.mm-menu__item.mm-menu__item--danger', {
      type: 'button', role: 'menuitem',
      onClick: async () => {
        closeMenu();
        // Stop polling before the session goes, or the widget keeps asking
        // with a token that no longer works.
        unmountCallWidget();
        await session.signOut();
        router.go('/login', { replace: true });
      },
    }, icon('logout', { size: 'sm' }), el('span', { text: 'Sign out' })));

  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 260))}px`;
  // Opened upward when the anchor sits low, which the sidebar's always does.
  if (rect.top > window.innerHeight / 2) menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
  else menu.style.top = `${rect.bottom + 8}px`;

  document.body.append(menu);
  openMenu = menu;
  setTimeout(() => document.addEventListener('click', onOutside, { once: true }), 0);
  document.addEventListener('keydown', onEscape);
}

function onOutside() { closeMenu(); }
function onEscape(e) { if (e.key === 'Escape') closeMenu(); }

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('keydown', onEscape);
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------
/**
 * The support-access banner. Unmissable by design: whenever the platform
 * administrator is inside another organisation, every page says whose
 * account this is, who is really signed in, what the session may do, when it
 * dies, and how to leave. It must never be confusable with a normal sign-in.
 */
function supportBanner(state) {
  const access = state.supportAccess;
  if (!access) return null;

  const remaining = el('span.mm-support-banner__timer');
  const paintRemaining = () => {
    const ms = new Date(access.expiresAt).getTime() - Date.now();
    if (ms <= 0) {
      remaining.textContent = 'expired';
      exitSupportAccess({ silent: true });
      return;
    }
    const mins = Math.ceil(ms / 60000);
    remaining.textContent = mins >= 2 ? `expires in ${mins} minutes` : 'expires in under a minute';
  };
  paintRemaining();
  const timer = setInterval(paintRemaining, 30_000);

  const host = el('div.mm-support-banner', { role: 'alert' },
    el('div.mm-support-banner__body',
      el('span.mm-support-banner__flag', icon('shield'), ' Support access'),
      el('span.mm-support-banner__org',
        `${access.mode === 'view' ? 'Viewing' : 'Acting in'} ${access.organisation ?? 'an organisation'}`,
        access.organisationStatus && access.organisationStatus !== 'active'
          ? el('span.mm-support-banner__status', ` — ${access.organisationStatus}`) : null),
      el('span.mm-support-banner__meta',
        `${access.mode === 'view' ? 'View-only' : 'Support mode'} · signed in as ${access.by ?? 'the platform'} · `,
        remaining)),
    el('button.mm-btn.mm-btn--sm.mm-support-banner__exit', {
      type: 'button', text: 'Exit organisation',
      onClick: () => { clearInterval(timer); exitSupportAccess(); },
    }));
  document.addEventListener('mm:teardown', () => clearInterval(timer), { once: true });
  return host;
}

/**
 * Leave a support session: end it server-side so the token is dead, then
 * return to the untouched platform session. If the stash is gone (another
 * tab exited first, storage cleared), the ordinary sign-out path catches us.
 */
async function exitSupportAccess({ silent = false } = {}) {
  try { await api.post('/auth/support/exit'); } catch { /* already expired or revoked — fine */ }

  let platformToken = null;
  try {
    platformToken = localStorage.getItem('mm.platformToken');
    localStorage.removeItem('mm.platformToken');
  } catch { /* blocked storage */ }

  const { setToken } = await import('../core/api.js');
  if (platformToken) {
    setToken(platformToken);
    if (!silent) notify.success('Support session ended. You are back on the platform.');
    window.location.href = '/platform/organisations';
  } else {
    setToken(null);
    window.location.href = '/login';
  }
}

function demoBanner(state) {
  if (!state.tenant?.isDemo) return null;
  return el('div.mm-shell__banner',
    banner({
      text: 'This is a demonstration organisation. Its clients, documents and figures are invented, and nothing here is real data.',
      tone: 'demo',
      icon: 'info',
    }));
}

/** Set the breadcrumb trail. Screens call this as they render. */
export function setBreadcrumbs(trail) {
  const host = document.getElementById('mm-crumbs');
  if (!host) return;

  render(host, ...trail.flatMap((crumb, i) => [
    i > 0 ? el('span.mm-crumb-sep', { 'aria-hidden': 'true', text: '/' }) : null,
    crumb.href && i < trail.length - 1
      ? el('a.mm-crumb', { href: crumb.href, text: crumb.label })
      : el('span.mm-crumb', { 'aria-current': 'page', text: crumb.label }),
  ]).filter(Boolean));
}

export function shellOutlet() { return outlet; }
