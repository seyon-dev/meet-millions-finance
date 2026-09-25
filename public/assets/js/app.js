/**
 * Application entry point.
 *
 * Boots in one pass: restore the theme, load the session, decide whether this
 * is the signed-out or signed-in shell, register routes, and resolve the URL
 * the person actually asked for — so a bookmarked deep link lands where it
 * should rather than bouncing through a dashboard first.
 */

import { el, render } from './core/dom.js';
import * as router from './core/router.js';
import * as session from './core/session.js';
import { api, onSessionLost, onStepUpRequired, setToken } from './core/api.js';
import { notify, promptText } from './core/ui.js';

const PUBLIC_PATHS = new Set([
  // No '/accept-invite': nothing registers that route and no email carries
  // that link — invitations send a temporary password and point at /login.
  '/', '/login', '/register', '/forgot-password', '/reset-password', '/verify-2fa',
  // The platform owner's unlisted entrance. Linked from nowhere on the site;
  // the server refuses organisation accounts on it and refuses the platform
  // account everywhere else, so the URL is a convenience, never the lock.
  '/platform-access',
]);

const root = document.getElementById('mm-app');
let shellMounted = false;

boot();

async function boot() {
  session.initTheme();

  // A 401 from anywhere lands here: clear the session and send the person to
  // sign in, remembering where they were so they return to it.
  onSessionLost(() => {
    if (!session.isSignedIn()) return;

    // A support-access session that expires or is revoked must never dump
    // the administrator at the login page: their own platform session was
    // never touched, so put them back on it.
    let platformToken = null;
    try { platformToken = localStorage.getItem('mm.platformToken'); } catch { /* blocked storage */ }
    if (platformToken) {
      try { localStorage.removeItem('mm.platformToken'); } catch { /* ignore */ }
      setToken(platformToken);
      window.location.href = '/platform/organisations';
      return;
    }

    session.reset();
    const here = window.location.pathname + window.location.search;
    notify.warning('Your session has ended. Please sign in again.');
    router.go(`/login?next=${encodeURIComponent(here)}`, { replace: true });
  });

  // A sensitive action can ask for a fresh identity check ("step-up"). One
  // shared prompt satisfies it, and the request that hit the wall replays.
  onStepUpRequired(async () => {
    const enrolled = !!session.session().user?.twoFactorEnabled;
    const value = await promptText({
      title: 'Confirm it is you',
      message: enrolled
        ? 'This action needs a fresh check. Enter the 6-digit code from your authenticator app.'
        : 'This action needs a fresh check. Enter your password to continue.',
      label: enrolled ? 'Authentication code' : 'Password',
      confirmLabel: 'Confirm',
      multiline: false,
      inputType: enrolled ? 'text' : 'password',
      maxlength: enrolled ? 10 : 256,
    });
    if (!value) return false;
    try {
      await api.post('/auth/2fa/step-up', enrolled ? { code: value } : { password: value });
      return true;
    } catch (err) {
      notify.error(err?.message || 'That could not be verified.');
      return false;
    }
  });

  try {
    await session.load();
  } catch (err) {
    // A failure here is the network or the server, not the credentials. Say
    // so, and let the sign-in screen carry the retry.
    console.error('session load failed', err);
  }

  registerRoutes();
  router.setGuard(guard);

  if (session.isSignedIn()) await mountAppShell();
  else mountAuthShell();

  await router.start();
}

/**
 * The navigation guard.
 *
 * Only decides *where* somebody goes. What they may do once there is decided
 * by the server on every request — this is convenience, not security.
 */
async function guard(pathname) {
  const signedIn = session.isSignedIn();

  if (!signedIn && !PUBLIC_PATHS.has(pathname)) {
    const next = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + window.location.search)}`;
    return `/login${next}`;
  }
  // Somebody with a session has no business on the signed-out screens, `/`
  // included: they get their own dashboard. A visitor without one falls
  // through to the landing page — a practice deciding whether to open an
  // account should not be met by a password box.
  if (signedIn && PUBLIC_PATHS.has(pathname)) {
    return session.landingPath();
  }

  // A password the administrator forced a change on: nothing else opens until
  // it is changed, or the account stays reachable with a password somebody
  // else has seen.
  if (signedIn && session.session().user?.mustChangePassword && pathname !== '/settings/password') {
    return '/settings/password';
  }

  // The platform owner belongs to no organisation, so an organisation screen
  // (clients, documents, a firm's settings…) has nothing to show them and the
  // server answers 403. Keep them on their own screens and say how the
  // organisation's workspace is actually reached.
  if (signedIn && session.isPlatformOnly() && !PLATFORM_OWNER_PATHS.test(pathname)) {
    notify.info('Organisation screens open through Organisations \u2192 Support access.', { timeout: 4000 });
    return '/admin/dashboard';
  }
  return null;
}

/** Where a platform owner — who belongs to no organisation — may go. */
const PLATFORM_OWNER_PATHS = /^\/(admin\/dashboard|platform(\/.*)?|settings|settings\/(profile|password|security)|notifications)$/;

async function mountAppShell() {
  if (shellMounted) return;
  const { mountShell } = await import('./layout/shell.js');
  mountShell(root);
  shellMounted = true;
}

function mountAuthShell() {
  shellMounted = false;
  const outlet = el('div.mm-auth-outlet');
  render(root, outlet);
  router.mount(outlet);
}

/** Called after sign-in, to swap the auth shell for the application shell. */
export async function enterApp() {
  root.replaceChildren();
  shellMounted = false;
  await mountAppShell();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function registerRoutes() {
  const screen = (path) => () => import(path);

  // -- Public -------------------------------------------------------------
  route('/login', () => import('./screens/auth/login.js'));
  route('/platform-access', () => import('./screens/auth/platform-login.js'));
  route('/register', () => import('./screens/auth/register.js'));
  route('/forgot-password', () => import('./screens/auth/forgot-password.js'));
  route('/reset-password', () => import('./screens/auth/reset-password.js'));
  route('/verify-2fa', () => import('./screens/auth/verify-2fa.js'));

  // -- Dashboards ---------------------------------------------------------
  route('/admin/dashboard', () => import('./screens/dashboard.js'));
  route('/manager/dashboard', () => import('./screens/dashboard.js'));
  route('/finance/dashboard', () => import('./screens/dashboard.js'));
  route('/auditor/dashboard', () => import('./screens/dashboard.js'));
  route('/client/dashboard', () => import('./screens/client/dashboard.js'));

  // -- Clients ------------------------------------------------------------
  route('/clients', () => import('./screens/clients/list.js'));
  route('/clients/:id', () => import('./screens/clients/detail.js'));

  // -- Documents and verification ----------------------------------------
  route('/documents', () => import('./screens/documents/list.js'));
  route('/documents/:id', () => import('./screens/documents/detail.js'));
  route('/verification', () => import('./screens/verification/queue.js'));
  route('/verification/:id', () => import('./screens/verification/workspace.js'));
  route('/queries', () => import('./screens/queries/list.js'));
  route('/queries/:id', () => import('./screens/queries/thread.js'));

  // -- Tax and reports ----------------------------------------------------
  route('/tax', () => import('./screens/tax/list.js'));
  route('/tax/:id', () => import('./screens/tax/detail.js'));
  route('/tax/reconciliation', () => import('./screens/tax/reconciliation.js'));
  route('/reports', () => import('./screens/reports/list.js'));
  route('/reports/:id', () => import('./screens/reports/detail.js'));
  route('/approvals', () => import('./screens/approvals.js'));
  route('/tasks', () => import('./screens/tasks.js'));
  route('/activity', () => import('./screens/activity.js'));

  // -- Billing ------------------------------------------------------------
  route('/billing/subscription', () => import('./screens/billing/subscription.js'));
  route('/billing/invoices', () => import('./screens/billing/invoices.js'));
  route('/billing/invoices/:id', () => import('./screens/billing/invoice-detail.js'));
  route('/billing/payments', () => import('./screens/billing/payments.js'));
  route('/marketplace', () => import('./screens/marketplace.js'));

  // -- Calling ------------------------------------------------------------
  route('/calls', () => import('./screens/calls/index.js'));
  route('/calls/:id', () => import('./screens/calls/detail.js'));

  // -- Communication ------------------------------------------------------
  route('/messaging/inbox', () => import('./screens/messaging/inbox.js'));
  route('/automation', () => import('./screens/automation.js'));
  route('/leads', () => import('./screens/leads.js'));
  route('/voice-notes', () => import('./screens/voice-notes.js'));
  route('/support', () => import('./screens/support/list.js'));
  route('/support/:id', () => import('./screens/support/detail.js'));
  route('/calendar', () => import('./screens/calendar.js'));

  // -- AI and analytics ---------------------------------------------------
  route('/ai/assistant', () => import('./screens/ai/assistant.js'));
  route('/ai/insights', () => import('./screens/ai/insights.js'));
  route('/ai/ocr', () => import('./screens/ai/ocr.js'));
  route('/analytics', () => import('./screens/analytics/overview.js'));
  route('/analytics/builder', () => import('./screens/analytics/builder.js'));
  route('/attendance', () => import('./screens/attendance.js'));

  // -- Team and organisation ---------------------------------------------
  route('/team', () => import('./screens/team/list.js'));
  route('/team/performance', () => import('./screens/team/performance.js'));
  route('/companies', () => import('./screens/companies.js'));
  route('/settings/users', () => import('./screens/team/list.js'));
  route('/settings/users/:id', () => import('./screens/team/detail.js'));

  // -- Settings -----------------------------------------------------------
  route('/settings', () => import('./screens/settings/index.js'));
  route('/settings/profile', () => import('./screens/settings/profile.js'));
  route('/settings/password', () => import('./screens/settings/password.js'));
  route('/settings/security', () => import('./screens/settings/security.js'));
  route('/settings/notifications', () => import('./screens/settings/notifications.js'));
  route('/settings/integrations', () => import('./screens/settings/integrations.js'));
  route('/settings/branding', () => import('./screens/settings/branding.js'));
  route('/settings/branches', () => import('./screens/settings/branches.js'));
  route('/settings/api', () => import('./screens/settings/api-keys.js'));
  route('/settings/backup', () => import('./screens/settings/backup.js'));
  route('/audit', () => import('./screens/audit.js'));

  // -- Client portal ------------------------------------------------------
  route('/client/upload', () => import('./screens/client/upload.js'));
  route('/client/filings', () => import('./screens/client/filings.js'));
  route('/client/queries', () => import('./screens/queries/list.js'));
  route('/client/reports', () => import('./screens/reports/list.js'));
  route('/client/payments', () => import('./screens/billing/payments.js'));
  route('/client/invoices', () => import('./screens/billing/invoices.js'));

  // -- Public ------------------------------------------------------------
  route('/', () => import('./screens/landing.js'));

  // -- Platform (Super Admin) --------------------------------------------
  route('/platform/organisations', () => import('./screens/platform/tenants.js'));
  route('/platform/organisations/:id', () => import('./screens/platform/tenant-detail.js'));
  route('/platform/franchises', () => import('./screens/platform/franchises.js'));
  route('/platform/plans', () => import('./screens/platform/plans.js'));
  route('/platform/revenue', () => import('./screens/platform/revenue.js'));
  route('/platform/logs', () => import('./screens/platform/logs.js'));

  router.setNotFound(async () => {
    const { renderNotFound } = await import('./layout/error-view.js');
    return renderNotFound();
  });
}

/**
 * Register one route.
 *
 * The screen module's default export is called with the route context; every
 * screen is a plain async function returning a DOM node, so there is nothing
 * to learn beyond that one contract.
 */
function route(pattern, loader) {
  router.register(pattern, async (context) => {
    const module = await loader();
    const view = module.default ?? module.render;
    if (typeof view !== 'function') {
      throw new Error(`Screen for ${pattern} has no default export.`);
    }
    return view(context);
  });
}
