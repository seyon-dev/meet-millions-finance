/**
 * A small pattern router.
 *
 * Routes are declared as `router.get('/api/clients/:id', handler)`. Patterns
 * are compiled once at module load into a regex plus a parameter name list,
 * so dispatch is a linear scan of pre-compiled matchers — fast enough for the
 * few hundred routes this API exposes, and with no dependency to audit.
 */

import { NotFoundError } from './errors.js';

function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    })
    .replace(/\*$/, '(.*)');
  if (pattern.endsWith('*')) names.push('wildcard');
  return { regex: new RegExp(`^${source}$`), names, rank: rankOf(pattern) };
}

/**
 * Specificity ranking.
 *
 * Dispatch is a linear scan, so without a ranking the *declaration order*
 * decides whether `/api/calls/voicemails` reaches its own handler or is
 * swallowed by `/api/calls/:id`. That is a trap: it makes a correct route
 * silently unreachable because of where it happens to sit in a file, and
 * across two dozen modules nobody can hold that ordering in their head.
 *
 * So each route gets a rank built from its segments — literal beats
 * parameter beats wildcard, compared left to right — and the scan walks the
 * ranked list. Equal ranks keep declaration order, because Array#sort is
 * stable, so genuinely ambiguous routes still behave as written.
 */
function rankOf(pattern) {
  const segments = pattern.split('/').filter(Boolean);
  // Leading segment count keeps ranks of different depths from interleaving,
  // then each segment contributes one digit of precedence.
  const digits = segments.map((seg) => {
    if (seg === '*' || seg.endsWith('*')) return 0;
    if (seg.startsWith(':')) return 1;
    return 2;
  });
  return { depth: segments.length, digits };
}

function compareRank(a, b) {
  // Deeper patterns are not inherently better; only per-segment precedence
  // matters, and only where both patterns have a segment to compare.
  const len = Math.min(a.digits.length, b.digits.length);
  for (let i = 0; i < len; i += 1) {
    if (a.digits[i] !== b.digits[i]) return b.digits[i] - a.digits[i];
  }
  return 0;
}

export class Router {
  constructor() {
    /** @type {{method:string, pattern:string, regex:RegExp, names:string[], handler:Function, options:object}[]} */
    this.routes = [];
    this.ranked = null;
    this.middlewares = [];
  }

  /** Middleware runs in registration order before any handler. */
  use(fn) { this.middlewares.push(fn); return this; }

  add(method, pattern, handler, options = {}) {
    const { regex, names, rank } = compile(pattern);
    this.routes.push({ method, pattern, regex, names, rank, handler, options });
    this.ranked = null;
    return this;
  }

  /** Routes in dispatch order: most specific first, stable within a rank. */
  orderedRoutes() {
    if (!this.ranked) {
      this.ranked = [...this.routes].sort((a, b) => compareRank(a.rank, b.rank));
    }
    return this.ranked;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /**
   * Mount another router's routes under a prefix.
   *
   * A child route declared as '/' becomes the prefix itself, so both
   * `/api/clients` and `/api/clients/` reach the collection handler — a
   * trailing slash should never be the difference between 200 and 404.
   */
  mount(prefix, router) {
    const base = prefix.replace(/\/+$/, '');
    for (const r of router.routes) {
      if (r.pattern === '/' || r.pattern === '') {
        this.add(r.method, base, r.handler, r.options);
        this.add(r.method, `${base}/`, r.handler, r.options);
      } else {
        this.add(r.method, base + r.pattern, r.handler, r.options);
      }
    }
    return this;
  }

  /** Find a matching route, or report which methods the path does allow. */
  match(method, pathname) {
    const allowed = new Set();
    for (const route of this.orderedRoutes()) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      if (route.method !== method) { allowed.add(route.method); continue; }
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = safeDecode(m[i + 1]);
      });
      return { route, params };
    }
    return allowed.size ? { allowed: [...allowed] } : null;
  }

  /**
   * Dispatch. `ctx` is the per-request context; handlers receive it and
   * return a Response. Errors bubble to the caller, which renders them
   * through `fail()`.
   */
  async handle(ctx) {
    const found = this.match(ctx.method, ctx.pathname);
    if (!found || !found.route) {
      if (found?.allowed) {
        const err = new NotFoundError('Route');
        err.status = 405;
        err.code = 'method_not_allowed';
        err.message = `That endpoint does not accept ${ctx.method}. Allowed: ${found.allowed.join(', ')}.`;
        throw err;
      }
      throw new NotFoundError('Endpoint', `No API endpoint matches ${ctx.method} ${ctx.pathname}.`);
    }

    ctx.params = found.params;
    ctx.route = found.route.pattern;
    ctx.routeOptions = found.route.options;

    for (const mw of this.middlewares) {
      const result = await mw(ctx, found.route);
      if (result instanceof Response) return result;
    }
    return found.route.handler(ctx);
  }
}

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

export function createRouter() { return new Router(); }
