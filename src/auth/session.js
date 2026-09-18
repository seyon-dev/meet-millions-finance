/**
 * Session management.
 *
 * A session token is `<sessionId>.<random>.<hmac>`. The server stores only the
 * SHA-256 of the whole token, so the sessions table is useless to an attacker
 * who reads it. The HMAC lets an obviously forged token be rejected without a
 * database round trip.
 */

import {
  randomToken, sha256Hex, hmacSha256Hex, timingSafeEqual,
} from './crypto.js';
import { ID } from '../utils/id.js';
import { nowIso, addHours, addMinutes, isPast } from '../utils/time.js';
import { AuthRequiredError } from '../http/errors.js';

export const DEFAULT_SESSION_HOURS = 12;

function authSecret(env) {
  const secret = env?.AUTH_SECRET;
  if (!secret || secret.length < 16 || secret.startsWith('replace-with-')) {
    throw new AuthRequiredError(
      'Authentication is not configured on this deployment.', 'auth_not_configured');
  }
  return secret;
}

/** Mint a token and persist its hash. Returns { token, session }. */
export async function createSession(env, db, {
  userId, tenantId, ip, userAgent, deviceId = null,
  activeCompanyId = null, twofaSatisfied = false, ttlHours = DEFAULT_SESSION_HOURS,
}) {
  const secret = authSecret(env);
  const sessionId = ID.session();
  const nonce = randomToken(32);
  const signature = await hmacSha256Hex(secret, `${sessionId}.${nonce}`);
  const token = `${sessionId}.${nonce}.${signature.slice(0, 32)}`;
  const tokenHash = await sha256Hex(token);
  const ts = nowIso();

  const session = {
    id: sessionId,
    user_id: userId,
    tenant_id: tenantId ?? null,
    token_hash: tokenHash,
    device_id: deviceId,
    ip: ip ?? null,
    user_agent: (userAgent ?? '').slice(0, 400),
    active_company_id: activeCompanyId,
    twofa_satisfied: twofaSatisfied ? 1 : 0,
    step_up_at: twofaSatisfied ? ts : null,
    created_at: ts,
    last_seen_at: ts,
    expires_at: addHours(ttlHours),
    revoked_at: null,
    revoked_reason: null,
  };

  await db.insert('sessions', session);
  return { token, session };
}

/** Cheap structural + signature check before touching the database. */
export async function isWellFormed(env, token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [sessionId, nonce, sig] = parts;
  if (!sessionId.startsWith('ses_') || nonce.length < 20 || sig.length !== 32) return false;
  try {
    const expected = (await hmacSha256Hex(authSecret(env), `${sessionId}.${nonce}`)).slice(0, 32);
    return timingSafeEqual(expected, sig);
  } catch {
    return false;
  }
}

/**
 * Resolve a bearer token to a live session row, or null. Expiry, revocation
 * and idle timeout are all enforced here rather than by each caller.
 */
export async function resolveSession(env, db, token, { idleTimeoutMinutes = 0 } = {}) {
  if (!(await isWellFormed(env, token))) return null;

  const tokenHash = await sha256Hex(token);
  const session = await db.findOne('sessions', { token_hash: tokenHash });
  if (!session) return null;
  if (session.revoked_at) return null;
  if (isPast(session.expires_at)) return null;

  if (idleTimeoutMinutes > 0) {
    const idleDeadline = addMinutes(idleTimeoutMinutes, new Date(session.last_seen_at));
    if (isPast(idleDeadline)) {
      await revokeSession(db, session.id, 'idle_timeout');
      return null;
    }
  }
  return session;
}

/** Bump last_seen_at at most once a minute — avoids a write on every request. */
export async function touchSession(db, session) {
  const last = new Date(session.last_seen_at).getTime();
  if (Date.now() - last < 60_000) return;
  await db.update('sessions', { id: session.id }, { last_seen_at: nowIso() });
}

export async function markTwoFactorSatisfied(db, sessionId) {
  const ts = nowIso();
  await db.update('sessions', { id: sessionId }, { twofa_satisfied: 1, step_up_at: ts });
}

export async function setActiveCompany(db, sessionId, companyId) {
  await db.update('sessions', { id: sessionId }, { active_company_id: companyId });
}

export async function revokeSession(db, sessionId, reason = 'signed_out') {
  await db.update('sessions', { id: sessionId },
    { revoked_at: nowIso(), revoked_reason: reason });
}

/** Sign a user out everywhere — used on password change and by security admins. */
export async function revokeAllUserSessions(db, userId, { exceptSessionId = null, reason = 'revoked' } = {}) {
  const params = [nowIso(), reason, userId];
  let sql = 'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL';
  if (exceptSessionId) { sql += ' AND id != ?'; params.push(exceptSessionId); }
  const meta = await db.run(sql, params);
  return meta?.changes ?? 0;
}

export async function listUserSessions(db, userId) {
  return db.many(
    `SELECT id, ip, user_agent, device_id, created_at, last_seen_at, expires_at, revoked_at, revoked_reason
       FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100`, [userId]);
}

/**
 * Step-up verification: a sensitive action requires the second factor to have
 * been satisfied recently, not merely at sign-in.
 */
export function isStepUpFresh(session, maxAgeMinutes = 15) {
  if (!session?.step_up_at) return false;
  return !isPast(addMinutes(maxAgeMinutes, new Date(session.step_up_at)));
}

export async function purgeExpiredSessions(db, olderThanIso) {
  const meta = await db.run(
    'DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
    [nowIso(), olderThanIso]);
  return meta?.changes ?? 0;
}
