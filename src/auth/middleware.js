/**
 * Request middleware: authentication, then authorisation.
 *
 * Route options declare their requirements declaratively:
 *   { auth: false }                       — public
 *   { permission: 'documents.verify' }    — needs that permission
 *   { anyPermission: ['a','b'] }          — needs at least one
 *   { feature: 'ocr_ai' }                 — needs a plan/add-on capability
 *   { role: 'super_admin' }               — platform-only
 *   { stepUp: true }                      — recent 2FA required
 */

import { AuthRequiredError, ForbiddenError, TwoFactorRequiredError } from '../http/errors.js';
import { Db } from '../db/client.js';
import {
  resolveSession, touchSession, isStepUpFresh,
} from './session.js';
import { loadIdentity } from './identity.js';
import { verifyApiKey } from './apikey.js';
import { assertFeature } from '../services/features.js';
import { isIpAllowed } from '../services/security.js';

function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // Cookie fallback keeps the SPA working without storing the token in JS.
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)mm_session=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Populates ctx.session / user / roles / permissions when credentials are
 * present. Does not itself reject anonymous requests — `authorize` does that,
 * so a route can opt out with { auth: false }.
 */
export async function authenticate(ctx) {
  const db = new Db(ctx.env.DB);

  // API-key auth (API Marketplace add-on) takes precedence when present.
  const apiKeyHeader = ctx.request.headers.get('x-api-key');
  if (apiKeyHeader) {
    const resolved = await verifyApiKey(db, apiKeyHeader, ctx.ip);
    if (resolved) {
      ctx.apiKey = resolved.apiKey;
      ctx.tenantId = resolved.apiKey.tenant_id;
      ctx.permissions = resolved.permissions;
      ctx.roles = [{ key: 'api', name: 'API client', level: 40 }];
      ctx.tenant = resolved.tenant;
      return;
    }
    throw new AuthRequiredError('That API key is not valid.', 'invalid_api_key');
  }

  const token = bearerToken(ctx.request);
  if (!token) return;

  const session = await resolveSession(ctx.env, db, token, {
    idleTimeoutMinutes: Number(ctx.env.IDLE_TIMEOUT_MINUTES || 0),
  });
  if (!session) return;

  const identity = await loadIdentity(db, session.user_id);

  ctx.session = session;
  ctx.user = identity.user;
  ctx.tenant = identity.tenant;
  ctx.tenantId = identity.user.tenant_id;
  ctx.roles = identity.roles;
  ctx.permissions = identity.permissions;
  ctx.memberships = identity.memberships;
  ctx.companyScope = identity.companyScope;
  ctx.activeCompanyId =
    session.active_company_id && (!identity.companyScope || identity.companyScope.includes(session.active_company_id))
      ? session.active_company_id
      : identity.defaultCompanyId;

  ctx.defer(touchSession(db, session));
}

/** Enforce a route's declared requirements. Throws, or returns nothing. */
export async function authorize(ctx, route) {
  const opts = route?.options ?? ctx.routeOptions ?? {};
  if (opts.auth === false) return;

  if (!ctx.user && !ctx.apiKey) {
    throw new AuthRequiredError('Sign in to continue.');
  }

  // Password-change lockout: nothing but the change-password call is allowed.
  if (ctx.user?.must_change_password && !opts.allowPasswordChange) {
    throw new ForbiddenError('You must set a new password before continuing.');
  }

  // Sessions that have not completed 2FA may only finish the challenge.
  if (ctx.session && !ctx.session.twofa_satisfied && ctx.user?.twofa_enabled && !opts.allowPending2fa) {
    throw new TwoFactorRequiredError('Finish two-factor verification to continue.');
  }

  if (opts.stepUp && ctx.session && !isStepUpFresh(ctx.session, opts.stepUpMinutes ?? 15)) {
    throw new TwoFactorRequiredError('Confirm your identity to perform this action.', { stepUp: true });
  }

  // Tenant IP allow-listing (Enterprise Security add-on).
  if (ctx.tenantId && !opts.skipIpCheck) {
    const allowed = await isIpAllowed(ctx);
    if (!allowed) throw new ForbiddenError('Your network is not permitted to access this organisation.');
  }

  if (opts.role) {
    const needed = Array.isArray(opts.role) ? opts.role : [opts.role];
    if (!needed.some(r => ctx.hasRole(r))) {
      throw new ForbiddenError('This area is restricted to a different role.');
    }
  }

  if (opts.permission && !ctx.has(opts.permission)) {
    throw new ForbiddenError(
      'You do not have permission to do that.', { required: opts.permission });
  }

  if (opts.anyPermission?.length && !opts.anyPermission.some(p => ctx.has(p))) {
    throw new ForbiddenError(
      'You do not have permission to do that.', { requiredAny: opts.anyPermission });
  }

  if (opts.allPermissions?.length) {
    const missing = opts.allPermissions.filter(p => !ctx.has(p));
    if (missing.length) {
      throw new ForbiddenError('You do not have permission to do that.', { missing });
    }
  }

  // Plan / add-on gating — a 402 with the upgrade path, never a silent 403.
  if (opts.feature) await assertFeature(ctx, opts.feature);
}

/** Imperative guards, for checks a route can only make after loading data. */
export function requirePermission(ctx, permission, message) {
  if (!ctx.has(permission)) {
    throw new ForbiddenError(message || 'You do not have permission to do that.', { required: permission });
  }
}

export function requireAnyPermission(ctx, permissions, message) {
  if (!permissions.some(p => ctx.has(p))) {
    throw new ForbiddenError(message || 'You do not have permission to do that.', { requiredAny: permissions });
  }
}
