/**
 * The single API response contract: { success, data, error, meta }.
 * Every route returns through here, so clients never have to special-case
 * a differently-shaped payload.
 */

import { AppError } from './errors.js';
import { BASE_SECURITY_HEADERS, apiCsp } from './security.js';

// A JSON body should be able to load nothing at all, so API responses carry
// the most restrictive policy there is alongside the shared headers.
const SECURITY_HEADERS = {
  ...BASE_SECURITY_HEADERS,
  'Content-Security-Policy': apiCsp(),
};

function baseMeta(ctx) {
  return {
    requestId: ctx?.requestId ?? null,
    timestamp: new Date().toISOString(),
  };
}

export function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

export function ok(data = null, { meta = {}, status = 200, ctx, headers } = {}) {
  return json({ success: true, data, error: null, meta: { ...baseMeta(ctx), ...meta } }, { status, headers });
}

export function created(data, opts = {}) {
  return ok(data, { ...opts, status: 201 });
}

export function noContent(ctx) {
  return ok(null, { status: 200, ctx });
}

/**
 * A paginated list. `meta.pagination` is identical across every list endpoint
 * so the table component can be written once.
 */
export function paginated(items, { page = 1, pageSize = 25, total = 0, ...extra } = {}, ctx) {
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  return ok(items, {
    ctx,
    meta: {
      pagination: {
        page, pageSize, total, totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
      ...extra,
    },
  });
}

/**
 * Error responses. Only `expose`d messages survive; everything else becomes a
 * generic sentence plus the request id, which is enough to find the log line.
 */
export function fail(error, ctx) {
  const isApp = error instanceof AppError;
  const status = isApp ? error.status : 500;
  const code = isApp ? error.code : 'internal_error';
  const expose = isApp && error.expose;

  const message = expose
    ? error.message
    : 'Something went wrong on our side. Please try again, or contact support with the request id.';

  const headers = {};
  if (code === 'rate_limited' && error.details?.retryAfterSeconds) {
    headers['Retry-After'] = String(error.details.retryAfterSeconds);
  }

  return json({
    success: false,
    data: null,
    error: {
      code,
      message,
      details: expose ? error.details ?? null : null,
    },
    meta: baseMeta(ctx),
  }, { status, headers });
}

/** A file/stream response with the shared security headers applied. */
export function fileResponse(body, { contentType, fileName, download = false, cacheSeconds = 0, extraHeaders = {} } = {}) {
  const headers = {
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}` : 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  };
  if (fileName) {
    // RFC 5987 encoding keeps non-ASCII filenames intact across browsers.
    const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    headers['Content-Disposition'] =
      `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }
  return new Response(body, { status: 200, headers });
}

export { SECURITY_HEADERS };
