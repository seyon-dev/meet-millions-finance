/**
 * Security policy enforcement: IP allow-listing, device fingerprinting,
 * login anomaly detection and account lockout.
 */

import { ID } from '../utils/id.js';
import { nowIso, addMinutes, isPast } from '../utils/time.js';
import { sha256Hex } from '../auth/crypto.js';
import { Db } from '../db/client.js';

export const DEFAULT_POLICY = {
  enforce_2fa: 0,
  enforce_2fa_roles: null,
  ip_allowlist_enabled: 0,
  session_ttl_hours: 12,
  idle_timeout_minutes: 60,
  password_min_length: 10,
  password_require_mixed: 1,
  password_expiry_days: 0,
  max_failed_logins: 5,
  lockout_minutes: 15,
  device_approval: 0,
  anomaly_alerts: 1,
  step_up_for_sensitive: 0,
};

export async function getSecurityPolicy(db, tenantId) {
  if (!tenantId) return { ...DEFAULT_POLICY };
  const row = await db.findOne('security_policies', { tenant_id: tenantId });
  return row ? { ...DEFAULT_POLICY, ...row } : { ...DEFAULT_POLICY };
}

/**
 * IPv4/IPv6 CIDR membership. Written out rather than pulled from a package so
 * there is no dependency in the authentication path.
 */
export function ipInCidr(ip, cidr) {
  if (!ip || !cidr) return false;
  if (!cidr.includes('/')) return ip === cidr;
  const [range, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0) return false;

  if (range.includes(':') || ip.includes(':')) {
    if (!range.includes(':') || !ip.includes(':')) return false;
    const a = expandIpv6(ip), b = expandIpv6(range);
    if (!a || !b || bits > 128) return false;
    const full = bits >> 3, rem = bits & 7;
    for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
    if (rem) {
      const mask = (0xff << (8 - rem)) & 0xff;
      if ((a[full] & mask) !== (b[full] & mask)) return false;
    }
    return true;
  }

  if (bits > 32) return false;
  const toInt = s => {
    const p = s.split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
      const v = Number(part);
      if (!Number.isInteger(v) || v < 0 || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  };
  const a = toInt(ip), b = toInt(range);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function expandIpv6(addr) {
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 1 && head.length !== 8) return null;
  if (fill < 0) return null;
  const groups = parts.length === 2
    ? [...head, ...Array(fill).fill('0'), ...tail]
    : head;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

/** True when the request's IP is permitted for the tenant. */
export async function isIpAllowed(ctx) {
  if (!ctx.tenantId) return true;
  const db = new Db(ctx.env.DB);
  const policy = ctx.securityPolicy ?? await getSecurityPolicy(db, ctx.tenantId);
  if (!policy.ip_allowlist_enabled) return true;

  const entries = await db.many(
    'SELECT cidr FROM ip_allowlist WHERE tenant_id = ?', [ctx.tenantId]);
  if (!entries.length) return true;  // an empty list is not a lockout
  return entries.some(e => ipInCidr(ctx.ip, e.cidr));
}

/**
 * TOTP replay protection: remember the last accepted time-step per user and
 * refuse any code at or before it. A code is valid for a few steps either
 * side of "now", so without this a shoulder-surfed or intercepted code could
 * be replayed inside that window. The rate_limits table already exists and
 * fits the shape (a keyed counter with an expiry), so no migration is needed;
 * the row expires long after the acceptance window has passed.
 *
 * Returns true when the step is fresh and now recorded, false on a replay.
 * The INSERT-then-conditional-UPDATE keeps two concurrent attempts with the
 * same code from both passing: only one UPDATE can move the counter forward.
 */
export async function consumeTotpStep(db, userId, offset, { at = Date.now(), period = 30 } = {}) {
  const step = Math.floor(at / 1000 / period) + offset;
  const id = `totp:${userId}`;
  await db.run(
    'INSERT OR IGNORE INTO rate_limits (id, scope, window_start, count, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, 'totp', nowIso(), -1, addMinutes(15)]);
  const meta = await db.run(
    'UPDATE rate_limits SET count = ?, window_start = ?, expires_at = ? WHERE id = ? AND count < ?',
    [step, nowIso(), addMinutes(15), id, step]);
  return !!meta?.changes;
}

/** A stable-per-browser fingerprint; deliberately coarse, never a tracking id. */
export async function deviceFingerprint({ userAgent, ip, extra = '' }) {
  const ua = String(userAgent || '');
  const platform = /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS/i.test(ua) ? 'macOS'
    : /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad/i.test(ua) ? 'iOS'
    : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
  const browser = /Edg\//i.test(ua) ? 'Edge'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) && !/Chrome/i.test(ua) ? 'Safari'
    : /Firefox\//i.test(ua) ? 'Firefox' : 'Browser';
  const subnet = String(ip || '').split('.').slice(0, 3).join('.');
  return {
    fingerprint: await sha256Hex(`${platform}|${browser}|${subnet}|${extra}`),
    platform, browser,
  };
}

/** Register or refresh a device, reporting whether it is newly seen. */
export async function upsertDevice(db, { userId, tenantId, userAgent, ip }) {
  const { fingerprint, platform, browser } = await deviceFingerprint({ userAgent, ip });
  const existing = await db.one(
    'SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?', [userId, fingerprint]);

  if (existing) {
    await db.update('devices', { id: existing.id }, { last_seen_at: nowIso(), last_ip: ip });
    return { device: existing, isNew: false, blocked: !!existing.blocked };
  }

  const device = {
    id: ID.device(),
    user_id: userId,
    tenant_id: tenantId,
    fingerprint,
    label: `${browser} on ${platform}`,
    platform,
    browser,
    last_ip: ip,
    trusted: 0,
    blocked: 0,
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
  };
  await db.insert('devices', device);
  return { device, isNew: true, blocked: false };
}

/** Write a login attempt to the security log. */
export async function recordLoginEvent(db, { tenantId, userId, email, result, ip, userAgent, deviceId, anomaly }) {
  await db.insert('login_events', {
    id: ID.event(),
    tenant_id: tenantId ?? null,
    user_id: userId ?? null,
    email: email ?? null,
    result,
    ip: ip ?? null,
    user_agent: (userAgent || '').slice(0, 400),
    device_id: deviceId ?? null,
    anomaly: anomaly ?? null,
    created_at: nowIso(),
  });
}

/** Count a failed attempt, locking the account once the policy limit is hit. */
export async function registerFailedLogin(db, user, policy) {
  const count = (user.failed_login_count ?? 0) + 1;
  const patch = { failed_login_count: count, updated_at: nowIso() };
  if (count >= (policy.max_failed_logins || 5)) {
    patch.locked_until = addMinutes(policy.lockout_minutes || 15);
    patch.failed_login_count = 0;
  }
  await db.update('users', { id: user.id }, patch);
  return { locked: !!patch.locked_until, lockedUntil: patch.locked_until ?? null };
}

export async function clearFailedLogins(db, userId, ip) {
  await db.update('users', { id: userId }, {
    failed_login_count: 0, locked_until: null,
    last_login_at: nowIso(), last_login_ip: ip, updated_at: nowIso(),
  });
}

export function isLockedOut(user) {
  return !!user.locked_until && !isPast(user.locked_until);
}

/** Should this sign-in trigger an anomaly alert? */
export async function detectAnomaly(db, user, { isNewDevice, ip }) {
  if (isNewDevice) return 'new_device';
  if (user.last_login_ip && user.last_login_ip !== ip) {
    const sameSubnet =
      String(user.last_login_ip).split('.').slice(0, 2).join('.') ===
      String(ip).split('.').slice(0, 2).join('.');
    if (!sameSubnet) return 'new_ip';
  }
  return null;
}
