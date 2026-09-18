/**
 * Meet Millions Finance CRM — Cloudflare Worker entry point.
 *
 * Responsibilities, in order:
 *   1. Serve the SPA's static assets (handled by the ASSETS binding, which
 *      Wrangler runs first for everything except /api, /webhooks and /files).
 *   2. Authenticate the request, authorise it against the route's declared
 *      requirements, and dispatch.
 *   3. Render every outcome — success or failure — through one response shape.
 *   4. Run scheduled work on the cron triggers.
 */

import { RequestContext } from './http/context.js';
import { ok, fail, json, SECURITY_HEADERS } from './http/response.js';
import { AppError, NotFoundError } from './http/errors.js';
import { createRouter } from './http/router.js';
import { authenticate, authorize } from './auth/middleware.js';
import { registerRoutes } from './routes.js';
import { ensureBootstrapped, BOOTSTRAP_VERSION } from './services/bootstrap.js';
import { runScheduled } from './services/scheduler.js';
import { logSystemEvent } from './services/logging.js';
import { applyRateLimit } from './services/ratelimit.js';

// The router is built once per isolate, not per request.
const router = createRouter();
router.use(async (ctx, route) => {
  await applyRateLimit(ctx, route);
  await authenticate(ctx);
  await authorize(ctx, route);
});
registerRoutes(router);

const WORKER_PATHS = ['/api/', '/webhooks/', '/files/'];
function isWorkerPath(pathname) {
  return WORKER_PATHS.some(p => pathname.startsWith(p))
    || pathname === '/api' || pathname === '/health' || pathname === '/ready';
}

export default {
  async fetch(request, env, executionCtx) {
    const ctx = new RequestContext(request, env, executionCtx);

    // Static assets and SPA routes fall through to the ASSETS binding.
    if (!isWorkerPath(ctx.pathname)) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Static assets are not configured on this deployment.', { status: 500 });
    }

    if (ctx.method === 'OPTIONS') return preflight(request, env);

    // Liveness. Deliberately answers without touching the database, so it stays
    // truthful about the Worker when D1 is the thing that is broken.
    if (ctx.pathname === '/health') {
      return json({
        success: true,
        data: { status: 'ok', app: env.APP_NAME ?? 'Meet Millions Finance CRM', env: env.APP_ENV ?? 'unknown' },
        error: null,
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // A Worker has no deploy hook: nothing runs between `wrangler deploy` and
    // the first request. The catalogue every request is authorised against —
    // permissions, roles, plans, the add-on list — is therefore seeded here,
    // once per isolate, before the router is entered.
    const bootstrap = await ensureBootstrapped(env);

    // Readiness, for a deploy pipeline: says whether this deployment has its
    // catalogue, and seeds it if not.
    if (ctx.pathname === '/ready') {
      return json({
        success: true,
        data: {
          status: 'ready',
          seededNow: bootstrap.ran,
          catalogueVersion: BOOTSTRAP_VERSION,
          // Present only on the request that did the seeding.
          platformOwner: bootstrap.report?.platformOwner ?? null,
        },
        error: null,
        meta: { timestamp: new Date().toISOString() },
      });
    }

    try {
      const response = await router.handle(ctx);
      return withCors(response, request, env);
    } catch (err) {
      const isApp = err instanceof AppError;
      const status = isApp ? err.status : 500;
      if (status >= 500) {
        // A typed, exposed error is a decision the application made on
        // purpose — "this provider has no credentials", say. Recording it as
        // `unhandled` with a stack trace would bury the genuine crashes it is
        // meant to surface, so those are logged as the warnings they are.
        const expected = isApp && err.expose;
        if (expected) {
          console.warn('handled', {
            requestId: ctx.requestId, path: ctx.pathname, method: ctx.method,
            code: err.code, status, message: err.message,
          });
        } else {
          console.error('unhandled', {
            requestId: ctx.requestId, path: ctx.pathname, method: ctx.method,
            message: err?.message, stack: err?.stack,
          });
        }
        ctx.defer(logSystemEvent(env, {
          level: expected ? 'warn' : 'error', source: 'worker', event: 'request_failed',
          message: err?.message ?? 'Unknown error',
          tenantId: ctx.tenantId, requestId: ctx.requestId,
          path: ctx.pathname, statusCode: status, durationMs: ctx.durationMs,
          stack: expected ? null : err?.stack,
        }));
      }
      return withCors(fail(err, ctx), request, env);
    }
  },

  /** Cron triggers: reminders, digests, retention, sync, rollups. */
  async scheduled(event, env, executionCtx) {
    executionCtx.waitUntil(
      ensureBootstrapped(env).then(() => runScheduled(event, env)));
  },
};

/**
 * CORS. Same-origin by default — the SPA is served by this Worker — but an
 * explicit allow-list supports the white-label custom-domain case and the
 * public API.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const configured = String(env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (configured.includes('*')) return origin;
  if (configured.includes(origin)) return origin;
  try {
    if (env.APP_URL && new URL(env.APP_URL).origin === origin) return origin;
  } catch { /* APP_URL misconfigured — fall through to deny */ }
  return null;
}

function preflight(request, env) {
  const origin = allowedOrigin(request, env);
  const headers = { ...SECURITY_HEADERS, 'Access-Control-Max-Age': '86400' };
  if (origin) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Requested-With, X-Company-Id',
      Vary: 'Origin',
    });
  }
  return new Response(null, { status: 204, headers });
}

function withCors(response, request, env) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

export { router, NotFoundError, ok };
