/**
 * The session: who is signed in, what they may do, what their plan includes.
 *
 * Loaded once from /api/auth/me and held here. Permission checks in the
 * interface read from this — which decides what is *shown*. What is *allowed*
 * is decided by the server on every request, and these two are deliberately
 * separate: hiding a button is a courtesy, not a control.
 */

import { api, setToken, getToken } from './api.js';

const state = {
  user: null,
  tenant: null,
  roles: [],
  permissions: new Set(),
  features: new Set(),
  addOns: new Set(),
  limits: {},
  usage: {},
  plan: null,
  navigation: null,
  companies: [],
  activeCompanyId: null,
  branding: null,
  landing: null,
  unreadNotifications: 0,
  demoMode: false,
  loaded: false,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
  document.dispatchEvent(new CustomEvent('mm:session', { detail: state }));
}

export function session() { return state; }
export function isSignedIn() { return !!state.user; }

/** Does the signed-in user hold this permission? */
export function can(permission) {
  if (!permission) return true;
  return state.permissions.has('*') || state.permissions.has(permission);
}

export function canAny(...permissions) {
  return permissions.flat().some(p => can(p));
}

export function hasRole(key) {
  return state.roles.some(r => r.key === key);
}

export function isClient() { return hasRole('client'); }
export function isSuperAdmin() { return hasRole('super_admin'); }

/**
 * True when this account belongs to no organisation — the platform Super
 * Admin. Everything outside the platform screens works inside a tenant, so
 * this, not the role, is what decides whether such a control can work at all.
 */
export function isPlatformOnly() { return !!state.user && !state.tenant; }

/** Is a plan or add-on feature unlocked? */
export function hasFeature(key) { return state.features.has(key); }

/** The current usage of a metered limit, for the meters on the billing screen. */
export function usageOf(metric) {
  const limit = state.limits?.[metric];
  const used = state.usage?.[metric] ?? 0;
  return {
    used,
    limit: limit ?? null,
    unlimited: limit === -1 || limit === null || limit === undefined,
    pct: limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
  };
}

/** Load, or reload, the signed-in user. Returns null when not signed in. */
export async function load() {
  if (!getToken()) {
    reset();
    return null;
  }

  try {
    const { data } = await api.get('/auth/me');
    apply(data);
    return state;
  } catch (err) {
    // A 401 here means the stored token is stale — clear it rather than
    // leaving the application in a half-signed-in state.
    if (err.name === 'AuthError') reset();
    else throw err;
    return null;
  }
}

export function apply(payload) {
  state.user = payload.user ?? null;
  state.tenant = payload.tenant ?? null;
  state.roles = payload.roles ?? [];
  state.permissions = new Set(payload.permissions ?? []);
  state.features = new Set(payload.entitlements?.features ?? payload.features ?? []);
  state.addOns = new Set(payload.entitlements?.addOns ?? payload.addOns ?? []);
  state.limits = payload.entitlements?.limits ?? payload.limits ?? {};
  state.usage = payload.entitlements?.usage ?? payload.usage ?? {};
  state.plan = payload.entitlements?.plan ?? payload.plan ?? null;
  state.navigation = payload.navigation ?? null;
  state.companies = payload.companies ?? [];
  state.activeCompanyId = payload.activeCompanyId ?? null;
  state.branding = payload.branding ?? null;
  state.landing = payload.landing ?? null;
  state.unreadNotifications = payload.unreadNotifications ?? 0;
  state.demoMode = !!payload.demoMode;
  state.loaded = true;
  applyBranding(state.branding);
  emit();
  return state;
}

export function reset() {
  setToken(null);
  state.user = null;
  state.tenant = null;
  state.roles = [];
  state.permissions = new Set();
  state.features = new Set();
  state.addOns = new Set();
  state.limits = {};
  state.usage = {};
  state.plan = null;
  state.navigation = null;
  state.companies = [];
  state.activeCompanyId = null;
  state.landing = null;
  state.unreadNotifications = 0;
  state.loaded = false;
  emit();
}

/**
 * Complete a sign-in.
 *
 * Always re-reads /auth/me rather than trusting the login response. The two
 * have different shapes — the login reply is about the *attempt*, and carries
 * no roles, navigation or entitlements — and taking it as the session is how
 * an administrator ends up on the client portal's landing page.
 */
export async function signIn(token) {
  setToken(token);
  await load();
  return state;
}

export async function signOut({ everywhere = false } = {}) {
  try {
    await api.post('/auth/logout', everywhere ? { everywhere: true } : {});
  } catch {
    // Signing out locally must work even if the request fails — otherwise a
    // network problem leaves somebody stuck in a session they want to end.
  }
  reset();
}

/**
 * Where this user's own home screen is.
 *
 * Roles land in different places, and sending everyone to the same dashboard
 * would mean most people arrive at a screen they cannot read.
 */
export function landingPath() {
  // The server already decided this from the same role table it enforces with.
  if (state.landing) return state.landing;
  if (isSuperAdmin()) return '/admin/dashboard';
  if (hasRole('admin')) return '/admin/dashboard';
  if (hasRole('finance_manager')) return '/manager/dashboard';
  if (hasRole('finance_executive')) return '/finance/dashboard';
  if (hasRole('accountant')) return '/finance/dashboard';
  if (hasRole('auditor')) return '/auditor/dashboard';
  return '/client/dashboard';
}

// ---------------------------------------------------------------------------
// Theme and white-label branding
// ---------------------------------------------------------------------------

/**
 * Apply the tenant's own colours.
 *
 * Only the two brand tokens are overridden. Everything else in the palette —
 * surfaces, text, status colours — stays as designed, because a tenant picking
 * a pale accent should not be able to make their own staff's text unreadable.
 */
export function applyBranding(branding) {
  const root = document.documentElement;
  root.style.removeProperty('--mm-brand');
  root.style.removeProperty('--mm-accent');

  if (!branding?.enabled) {
    document.title = 'Meet Millions Finance CRM';
    return;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(branding.primaryColour ?? '')) {
    root.style.setProperty('--mm-brand', branding.primaryColour);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(branding.accentColour ?? '')) {
    root.style.setProperty('--mm-accent', branding.accentColour);
  }
  if (branding.productName) document.title = branding.productName;
}

const THEME_KEY = 'mm.theme';

export function theme() {
  return localStorage.getItem(THEME_KEY) ?? state.user?.theme ?? 'dark';
}

/**
 * Set the theme.
 *
 * 'system' removes the attribute entirely so the media query in the stylesheet
 * takes over, rather than this guessing and then being wrong when the user
 * changes their OS setting while the tab is open.
 */
export function setTheme(value) {
  const root = document.documentElement;
  if (value === 'system') {
    root.removeAttribute('data-theme');
    localStorage.removeItem(THEME_KEY);
  } else {
    root.setAttribute('data-theme', value);
    localStorage.setItem(THEME_KEY, value);
  }
  document.dispatchEvent(new CustomEvent('mm:theme', { detail: value }));
}

export function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored) document.documentElement.setAttribute('data-theme', stored);
}
