/**
 * The router.
 *
 * Real URLs, not hashes: /clients/cl_123 is a link somebody can send to a
 * colleague, and the Worker serves index.html for any path it does not itself
 * handle. Navigation is intercepted at the document level, so ordinary <a>
 * elements work everywhere without each screen remembering to wire them.
 */

const routes = [];
let notFound = null;
let beforeEach = null;
let current = null;

/** register('/clients/:id', loader) — loader is dynamic, so screens code-split. */
export function register(pattern, loader, options = {}) {
  routes.push({ pattern, loader, options, ...compile(pattern) });
}

export function setNotFound(loader) { notFound = loader; }

/** A guard run before every navigation. Returning a path redirects. */
export function setGuard(fn) { beforeEach = fn; }

function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => { names.push(name); return '([^/]+)'; })
    .replace(/\*$/, '(.*)');
  if (pattern.endsWith('*')) names.push('rest');
  return { regex: new RegExp(`^${source}/?$`), names };
}

function match(pathname) {
  // Most specific first, so /clients/new is not swallowed by /clients/:id.
  const ranked = [...routes].sort((a, b) => rank(b.pattern) - rank(a.pattern));
  for (const route of ranked) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route, params };
  }
  return null;
}

function rank(pattern) {
  return pattern.split('/').filter(Boolean)
    .reduce((score, seg) => score * 10 + (seg.startsWith(':') ? 1 : seg === '*' ? 0 : 2), 0);
}

export function currentRoute() { return current; }

export function path() { return window.location.pathname; }

export function query() { return new URLSearchParams(window.location.search); }

/** Navigate. `replace` avoids stacking history entries on a redirect. */
export function go(to, { replace = false, state = null } = {}) {
  const url = new URL(to, window.location.origin);
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    return resolve();
  }
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
  return resolve();
}

/** Change one query parameter without losing the rest or the scroll position. */
export function setQuery(updates, { replace = true } = {}) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  return resolve();
}

let outlet = null;
let token = 0;

export function mount(node) { outlet = node; }

/**
 * Resolve the current URL into the outlet.
 *
 * Each run takes a ticket. A slow screen that finishes after the user has
 * already navigated away discards its own result rather than painting over
 * whatever they are now looking at.
 */
export async function resolve() {
  const ticket = ++token;
  const pathname = window.location.pathname;

  if (beforeEach) {
    const redirect = await beforeEach(pathname);
    if (redirect && redirect !== pathname) return go(redirect, { replace: true });
  }

  const found = match(pathname);
  current = found
    ? { pattern: found.route.pattern, params: found.params, options: found.route.options, pathname }
    : { pattern: null, params: {}, options: {}, pathname };

  const loader = found?.route.loader ?? notFound;
  if (!loader || !outlet) return;

  try {
    const view = await loader({ params: current.params, query: query(), pathname });
    if (ticket !== token) return;              // superseded
    if (view instanceof Node) outlet.replaceChildren(view);
  } catch (err) {
    if (ticket !== token) return;
    // Rendering the failure is the screen's job where it can; anything that
    // escapes lands here so the outlet is never left blank.
    const { renderRouteError } = await import('../layout/error-view.js');
    outlet.replaceChildren(renderRouteError(err));
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
  document.dispatchEvent(new CustomEvent('mm:navigated', { detail: current }));
}

/**
 * Start listening.
 *
 * One delegated click handler covers every link in the application. Modified
 * clicks, new tabs, downloads and external links are all left to the browser,
 * which is what people expect of a link.
 */
export function start() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const anchor = e.target.closest('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.dataset.native === 'true') return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    // /files and /webhooks are served by the Worker, not by this router.
    if (url.pathname.startsWith('/files/') || url.pathname.startsWith('/webhooks/')) return;

    e.preventDefault();
    go(url.pathname + url.search);
  });

  window.addEventListener('popstate', () => resolve());
  return resolve();
}
