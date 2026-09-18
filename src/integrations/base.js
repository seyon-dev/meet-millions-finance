/**
 * The integration contract.
 *
 * Every third-party vendor in the product sits behind one of these. The rules
 * are the same for all of them:
 *
 *   - A provider declares the environment keys it needs. If any are missing,
 *     `isConfigured()` is false and every call returns `not_configured`
 *     rather than throwing or, worse, pretending to have succeeded.
 *   - A provider never reports success it did not get from the vendor. There
 *     is no simulated send, no fake payment, no invented transcript.
 *   - `test()` performs a real, cheap round trip so the Integrations screen
 *     can show a genuine connection state.
 *
 * The result shape is uniform so callers do not branch per vendor:
 *   { ok, status, providerId?, data?, error?, raw? }
 */

import { IntegrationError, NotConfiguredError } from '../http/errors.js';

export const RESULT_STATUS = {
  SENT: 'sent',
  QUEUED: 'queued',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  NOT_CONFIGURED: 'not_configured',
  OK: 'ok',
};

export class Provider {
  /**
   * @param {object} options
   * @param {string} options.key      stable provider key, e.g. 'ses'
   * @param {string} options.name     display name
   * @param {string} options.category email | sms | whatsapp | payments | ...
   * @param {string[]} options.requiredKeys env variables that must be present
   * @param {object} options.env
   */
  constructor({ key, name, category, requiredKeys = [], optionalKeys = [], env = {}, docsUrl = null }) {
    this.key = key;
    this.name = name;
    this.category = category;
    this.requiredKeys = requiredKeys;
    this.optionalKeys = optionalKeys;
    this.env = env;
    this.docsUrl = docsUrl;
  }

  /** Which required keys are absent or still placeholders. */
  missingKeys() {
    return this.requiredKeys.filter(k => {
      const v = this.env?.[k];
      return !v || String(v).trim() === '' || String(v).startsWith('replace-with-');
    });
  }

  isConfigured() { return this.missingKeys().length === 0; }

  /** The row the Integrations screen renders. */
  describe() {
    const missing = this.missingKeys();
    return {
      key: this.key,
      name: this.name,
      category: this.category,
      configured: missing.length === 0,
      status: missing.length === 0 ? 'connected' : 'not_connected',
      requiredKeys: this.requiredKeys,
      optionalKeys: this.optionalKeys,
      missingKeys: missing,
      docsUrl: this.docsUrl,
    };
  }

  /** Throw a typed 503 when a caller reaches a provider with no credentials. */
  assertConfigured() {
    const missing = this.missingKeys();
    if (missing.length) throw new NotConfiguredError(this.name, missing);
  }

  notConfigured(action = 'complete that action') {
    return {
      ok: false,
      status: RESULT_STATUS.NOT_CONFIGURED,
      error: {
        code: 'not_configured',
        message: `${this.name} is not connected, so we could not ${action}. Add ${this.missingKeys().join(', ')} in Settings → Integrations.`,
        missingKeys: this.missingKeys(),
      },
    };
  }

  failure(message, { code = 'provider_error', raw = null, retryable = false } = {}) {
    return { ok: false, status: RESULT_STATUS.FAILED, error: { code, message, retryable }, raw };
  }

  success(data = {}, { status = RESULT_STATUS.OK, providerId = null, raw = null } = {}) {
    return { ok: true, status, providerId, data, raw };
  }

  /**
   * A fetch wrapper with a timeout and uniform error translation. Workers
   * abort a hung upstream rather than holding the request open.
   */
  async request(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, expectJson = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed = null;
      if (expectJson && text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      }

      if (!response.ok) {
        return {
          ok: false,
          httpStatus: response.status,
          body: parsed ?? text,
          error: extractError(parsed) || `${this.name} returned HTTP ${response.status}.`,
        };
      }
      return { ok: true, httpStatus: response.status, body: parsed ?? text };
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      return {
        ok: false,
        httpStatus: 0,
        body: null,
        error: aborted
          ? `${this.name} did not respond within ${Math.round(timeoutMs / 1000)}s.`
          : `Could not reach ${this.name}: ${err?.message ?? 'network error'}.`,
        aborted,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Subclasses override: a cheap real call proving the credentials work. */
  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    return this.failure(`${this.name} has not implemented a connection test.`, { code: 'not_implemented' });
  }
}

function extractError(body) {
  if (!body || typeof body !== 'object') return null;
  return body.error?.message
    || body.error_description
    || body.message
    || (typeof body.error === 'string' ? body.error : null)
    || body.errors?.[0]?.message
    || null;
}

/** Helper for providers that authenticate with HTTP Basic. */
export function basicAuth(user, pass) {
  return 'Basic ' + btoa(`${user}:${pass}`);
}

export { IntegrationError, NotConfiguredError };
