/**
 * The API client.
 *
 * Every response comes back in the same envelope, so this unwraps it once and
 * throws a typed error otherwise. Screens then handle four situations by name
 * rather than by inspecting status codes:
 *
 *   AuthError        — the session is gone; the shell signs out
 *   FeatureLocked    — a plan or add-on gate, with what would unlock it
 *   NotConfigured    — a vendor has no credentials on this deployment
 *   ValidationError  — per-field messages a form can attach to its inputs
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status, code, details, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? null;
    this.requestId = requestId ?? null;
  }
}

export class AuthError extends ApiError {
  constructor(message, meta) { super(message, meta); this.name = 'AuthError'; }
}

export class TwoFactorRequired extends ApiError {
  constructor(message, meta) { super(message, meta); this.name = 'TwoFactorRequired'; }
}

export class FeatureLocked extends ApiError {
  constructor(message, meta) {
    super(message, meta);
    this.name = 'FeatureLocked';
    this.featureKey = meta?.details?.featureKey ?? null;
    this.requiredPlan = meta?.details?.requiredPlan ?? null;
    this.requiredAddOn = meta?.details?.requiredAddOn ?? null;
  }
}

export class NotConfigured extends ApiError {
  constructor(message, meta) {
    super(message, meta);
    this.name = 'NotConfigured';
    this.provider = meta?.details?.provider ?? null;
    this.missingKeys = meta?.details?.missingKeys ?? [];
  }
}

export class ValidationError extends ApiError {
  constructor(message, meta) {
    super(message, meta);
    this.name = 'ValidationError';
    /** @type {Record<string,string>} field → message */
    this.fields = meta?.details ?? {};
  }
}

let token = null;
let onUnauthenticated = null;

export function setToken(value) {
  token = value || null;
  if (value) localStorage.setItem('mm.token', value);
  else localStorage.removeItem('mm.token');
}

export function getToken() {
  if (token === null) token = localStorage.getItem('mm.token');
  return token;
}

/** The shell registers here so any 401 anywhere lands on the sign-in screen. */
export function onSessionLost(handler) { onUnauthenticated = handler; }

/**
 * Issue a request.
 *
 * `body` may be a plain object (sent as JSON) or FormData (sent as-is, so the
 * browser sets its own multipart boundary).
 */
export async function request(path, {
  method = 'GET', body = null, query = null, signal = null, raw = false,
} = {}) {
  const url = new URL(path.startsWith('http') ? path : BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length) url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {};
  const auth = getToken();
  if (auth) headers.Authorization = `Bearer ${auth}`;

  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, { method, headers, body: payload, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    // A failed fetch is the network, not the API. Saying so saves someone
    // hunting for a server fault that is not there.
    throw new ApiError('Could not reach the server. Check your connection and try again.', {
      status: 0, code: 'network_error',
    });
  }

  if (raw) {
    if (!response.ok) await throwFromResponse(response);
    return response;
  }

  const text = await response.text();
  let envelope = null;
  try { envelope = text ? JSON.parse(text) : null; } catch { envelope = null; }

  if (!response.ok || envelope?.success === false) {
    throw fromEnvelope(response.status, envelope);
  }
  return { data: envelope?.data ?? null, meta: envelope?.meta ?? {} };
}

async function throwFromResponse(response) {
  let envelope = null;
  try { envelope = await response.json(); } catch { envelope = null; }
  throw fromEnvelope(response.status, envelope);
}

function fromEnvelope(status, envelope) {
  const error = envelope?.error ?? {};
  const meta = {
    status,
    code: error.code ?? 'error',
    details: error.details ?? null,
    requestId: envelope?.meta?.requestId ?? null,
  };
  const message = error.message ?? defaultMessage(status);

  if (status === 401) {
    const err = new AuthError(message, meta);
    if (onUnauthenticated) onUnauthenticated(err);
    return err;
  }
  if (meta.code === 'twofa_required') return new TwoFactorRequired(message, meta);
  if (meta.code === 'feature_locked') return new FeatureLocked(message, meta);
  if (meta.code === 'integration_not_configured') return new NotConfigured(message, meta);
  if (status === 422 || meta.code === 'validation_failed') return new ValidationError(message, meta);
  return new ApiError(message, meta);
}

function defaultMessage(status) {
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That could not be found.';
  if (status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'That request could not be completed.';
}

export const api = {
  get: (path, query, options) => request(path, { ...options, query }),
  post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
  patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
  delete: (path, options) => request(path, { ...options, method: 'DELETE' }),
  raw: (path, options) => request(path, { ...options, raw: true }),

  /**
   * Upload with real progress.
   *
   * `fetch` cannot report how much of a request body has gone out, so this one
   * call uses XMLHttpRequest. A progress bar that is guessed is worse than no
   * progress bar, and a client uploading a 40MB scan over a phone connection
   * is exactly who needs a real one.
   */
  upload(path, formData, { onProgress = null, signal = null } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + path);

      const auth = getToken();
      if (auth) xhr.setRequestHeader('Authorization', `Bearer ${auth}`);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total, e.loaded, e.total);
      });

      xhr.addEventListener('load', () => {
        let envelope = null;
        try { envelope = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch { envelope = null; }
        if (xhr.status >= 200 && xhr.status < 300 && envelope?.success !== false) {
          resolve({ data: envelope?.data ?? null, meta: envelope?.meta ?? {} });
        } else {
          reject(fromEnvelope(xhr.status, envelope));
        }
      });

      xhr.addEventListener('error', () => reject(new ApiError(
        'The upload could not reach the server. Check your connection and try again.',
        { status: 0, code: 'network_error' })));

      xhr.addEventListener('abort', () => {
        const err = new Error('Upload cancelled.');
        err.name = 'AbortError';
        reject(err);
      });

      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(formData);
    });
  },

  /**
   * Download a file the caller is authorised for.
   *
   * The bytes come back through fetch with the session header attached — a
   * plain link would arrive without it, because the browser does not send our
   * Authorization header on a navigation.
   */
  async download(path, { fileName = null, query = null } = {}) {
    const response = await request(path, { query, raw: true });
    const blob = await response.blob();

    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const name = fileName ?? match?.[1] ?? path.split('/').pop();

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Revoked on the next tick: revoking immediately cancels the download in
    // some browsers before it has started.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { fileName: name, sizeBytes: blob.size };
  },
};
