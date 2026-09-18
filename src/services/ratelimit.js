/**
 * Rate limiting.
 *
 * KV is the fast path (eventually consistent, but good enough to blunt a
 * flood); the D1 table is the durable record used for per-API-key quotas that
 * must be accurate. Auth endpoints are limited hardest, because that is where
 * credential stuffing lands.
 */

import { RateLimitError } from '../http/errors.js';
import { Db } from '../db/client.js';
import { nowIso, addSeconds } from '../utils/time.js';

/** windowSeconds → max requests, per bucket key. */
export const RATE_LIMITS = {
  'auth.login':        { windowSeconds: 300, max: 10 },
  'auth.register':     { windowSeconds: 3600, max: 5 },
  'auth.forgot':       { windowSeconds: 3600, max: 5 },
  'auth.twofa':        { windowSeconds: 300, max: 10 },
  'documents.upload':  { windowSeconds: 60, max: 60 },
  'webhook':           { windowSeconds: 60, max: 600 },
  'api':               { windowSeconds: 60, max: 120 },
  'default':           { windowSeconds: 60, max: 300 },
};

function bucketFor(ctx, route) {
  const explicit = route?.options?.rateLimit;
  if (explicit === false) return null;
  if (typeof explicit === 'string') return explicit;
  if (ctx.pathname.startsWith('/webhooks/')) return 'webhook';
  if (ctx.apiKey) return 'api';
  return 'default';
}

function identityFor(ctx) {
  if (ctx.apiKey) return `key:${ctx.apiKey.id}`;
  if (ctx.user) return `user:${ctx.user.id}`;
  return `ip:${ctx.ip}`;
}

export async function applyRateLimit(ctx, route) {
  const bucket = bucketFor(ctx, route);
  if (!bucket) return;

  const config = RATE_LIMITS[bucket] ?? RATE_LIMITS.default;
  const perKeyMax = ctx.apiKey?.rate_limit_per_min ?? config.max;
  const window = Math.floor(Date.now() / 1000 / config.windowSeconds);
  const key = `rl:${bucket}:${identityFor(ctx)}:${window}`;

  // Prefer KV; if it is unavailable, fall back to the durable table so the
  // limit still applies rather than silently disappearing.
  if (ctx.env.CACHE) {
    try {
      const current = Number(await ctx.env.CACHE.get(key)) || 0;
      if (current >= perKeyMax) {
        throw new RateLimitError(config.windowSeconds);
      }
      await ctx.env.CACHE.put(key, String(current + 1), { expirationTtl: config.windowSeconds + 10 });
      return;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      // fall through to D1
    }
  }

  const db = new Db(ctx.env.DB);
  const row = await db.findOne('rate_limits', { id: key });
  if (row && Number(row.count) >= perKeyMax) throw new RateLimitError(config.windowSeconds);

  if (row) {
    await db.run('UPDATE rate_limits SET count = count + 1 WHERE id = ?', [key]);
  } else {
    await db.run(
      `INSERT OR IGNORE INTO rate_limits (id, scope, window_start, count, expires_at)
       VALUES (?, ?, ?, 1, ?)`,
      [key, bucket, nowIso(), addSeconds(config.windowSeconds + 10)]);
  }
}

/** Used by auth handlers to spend an attempt even when the route is public. */
export async function consumeAttempt(ctx, bucket, identity) {
  const config = RATE_LIMITS[bucket] ?? RATE_LIMITS.default;
  const window = Math.floor(Date.now() / 1000 / config.windowSeconds);
  const key = `rl:${bucket}:${identity}:${window}`;

  if (ctx.env.CACHE) {
    const current = Number(await ctx.env.CACHE.get(key)) || 0;
    if (current >= config.max) throw new RateLimitError(config.windowSeconds);
    await ctx.env.CACHE.put(key, String(current + 1), { expirationTtl: config.windowSeconds + 10 });
    return;
  }

  const db = new Db(ctx.env.DB);
  const row = await db.findOne('rate_limits', { id: key });
  if (row && Number(row.count) >= config.max) throw new RateLimitError(config.windowSeconds);
  if (row) await db.run('UPDATE rate_limits SET count = count + 1 WHERE id = ?', [key]);
  else await db.run(
    `INSERT OR IGNORE INTO rate_limits (id, scope, window_start, count, expires_at) VALUES (?, ?, ?, 1, ?)`,
    [key, bucket, nowIso(), addSeconds(config.windowSeconds + 10)]);
}

export async function purgeRateLimits(db) {
  const meta = await db.run('DELETE FROM rate_limits WHERE expires_at < ?', [nowIso()]);
  return meta?.changes ?? 0;
}
