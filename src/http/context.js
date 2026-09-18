/**
 * Per-request context. Built once at the edge of the Worker and threaded
 * through middleware and handlers, so a handler never touches `env` or the
 * raw Request directly for anything it needs repeatedly.
 */

import { newId } from '../utils/id.js';
import { BadRequestError, PayloadTooLargeError } from './errors.js';

const MAX_JSON_BYTES = 1_000_000; // 1 MB — JSON bodies are metadata, not files

export class RequestContext {
  constructor(request, env, executionCtx) {
    this.request = request;
    this.env = env;
    this.executionCtx = executionCtx;

    const url = new URL(request.url);
    this.url = url;
    this.pathname = url.pathname;
    this.query = url.searchParams;
    this.method = request.method.toUpperCase();
    this.requestId = request.headers.get('cf-ray') || newId('req');
    this.startedAt = Date.now();

    this.ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '0.0.0.0';
    this.userAgent = request.headers.get('user-agent') || '';
    this.country = request.headers.get('cf-ipcountry') || null;

    // Populated by middleware.
    this.session = null;
    this.user = null;
    this.tenantId = null;
    this.tenant = null;
    this.roles = [];
    this.permissions = new Set();
    this.activeCompanyId = null;
    this.companyScope = null;    // null = all companies in tenant; else string[]
    this.apiKey = null;
    this.params = {};
    this.route = null;
    this.routeOptions = {};
    this._body = undefined;
    this._deferred = [];
  }

  get db() { return this.env.DB; }
  get storage() { return this.env.DOCS; }
  get cache() { return this.env.CACHE; }

  /** Parsed and size-capped JSON body. Cached per request. */
  async body() {
    if (this._body !== undefined) return this._body;
    const type = this.request.headers.get('content-type') || '';
    if (!type.includes('application/json')) { this._body = {}; return this._body; }

    const declared = Number(this.request.headers.get('content-length') || 0);
    if (declared > MAX_JSON_BYTES) throw new PayloadTooLargeError(MAX_JSON_BYTES, 'That request body is too large.');

    const text = await this.request.text();
    if (text.length > MAX_JSON_BYTES) throw new PayloadTooLargeError(MAX_JSON_BYTES, 'That request body is too large.');
    if (!text.trim()) { this._body = {}; return this._body; }

    try {
      const parsed = JSON.parse(text);
      this._body = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new BadRequestError('The request body is not valid JSON.');
    }
    return this._body;
  }

  async formData() { return this.request.formData(); }

  /** Query-string helpers with sane coercion. */
  q(name, fallback = null) {
    const v = this.query.get(name);
    return v === null || v === '' ? fallback : v;
  }
  qInt(name, fallback = 0) {
    const raw = this.query.get(name);
    // An absent or blank parameter must fall back, not coerce to 0 —
    // otherwise `?page=` silently becomes page 0 and pageSize becomes 1.
    if (raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }
  qBool(name, fallback = false) {
    const v = this.query.get(name);
    if (v === null) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  }
  qList(name) {
    const v = this.query.get(name);
    return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
  }

  /** Standard pagination from ?page= & ?pageSize=, capped to protect D1. */
  pagination({ defaultSize = 25, maxSize = 200 } = {}) {
    const page = Math.max(1, this.qInt('page', 1));
    const pageSize = Math.min(maxSize, Math.max(1, this.qInt('pageSize', defaultSize)));
    return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
  }

  /** Queue work to run after the response is sent (audit writes, webhooks). */
  defer(promiseOrFn) {
    const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    this._deferred.push(p);
    if (this.executionCtx?.waitUntil) this.executionCtx.waitUntil(p.catch(() => {}));
    return p;
  }

  /** Await all deferred work — used by tests, where there is no waitUntil. */
  async flush() {
    const pending = this._deferred.splice(0);
    await Promise.allSettled(pending);
  }

  has(permission) { return this.permissions.has(permission) || this.permissions.has('*'); }
  hasRole(key) { return this.roles.some(r => r.key === key); }
  get roleKeys() { return this.roles.map(r => r.key); }
  get isSuperAdmin() { return this.hasRole('super_admin'); }
  get isClient() { return this.hasRole('client'); }
  get userId() { return this.user?.id ?? null; }
  get durationMs() { return Date.now() - this.startedAt; }
}
