/**
 * Password hashing — PBKDF2-SHA256, the strongest KDF available in the Workers
 * runtime. The iteration count is stored inside the hash so it can be raised
 * later and old hashes still verify (and are transparently re-hashed on the
 * next successful sign-in).
 */

import { toBase64Url, fromBase64Url, randomBytes, timingSafeEqual, textEncoder } from './crypto.js';

export const PBKDF2_ITERATIONS = 210_000;   // OWASP guidance for PBKDF2-SHA256
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

async function derive(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', textEncoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, KEY_LENGTH_BITS);
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const iterations = Number(iterStr);
  if (!Number.isInteger(iterations) || iterations < 1000) return false;
  try {
    const candidate = await derive(password, fromBase64Url(saltB64), iterations);
    return timingSafeEqual(candidate, fromBase64Url(hashB64));
  } catch {
    return false;
  }
}

/** True when a stored hash uses fewer iterations than we now require. */
export function needsRehash(stored, target = PBKDF2_ITERATIONS) {
  const iterations = Number(String(stored || '').split('$')[1]);
  return !Number.isInteger(iterations) || iterations < target;
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwerty123',
  'welcome1', 'admin@123', 'letmein1', 'iloveyou', 'abc12345', 'changeme',
  'passw0rd', 'finance123', 'company123',
]);

/**
 * A temporary password for an invited user or a newly created portal login.
 *
 * Built from crypto.getRandomValues, never Math.random: a temporary password
 * that a weak PRNG can be made to reproduce is a way into someone's account,
 * however short its life. Ambiguous glyphs are left out because these get read
 * aloud and typed by hand, and the shape always satisfies the default policy.
 */
const PASSWORD_ALPHABET = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',   // no I or O
  lower: 'abcdefghijkmnopqrstuvwxyz', // no l
  digit: '23456789',                   // no 0 or 1
  symbol: '!@#$%&*?-+',
};

export function generateTemporaryPassword(length = 16) {
  const all = Object.values(PASSWORD_ALPHABET).join('');
  // One character from each class first, so the result always passes policy,
  // then fill the rest and shuffle so the classes are not in a fixed order.
  const chars = Object.values(PASSWORD_ALPHABET).map(set => pickFrom(set));
  while (chars.length < Math.max(12, length)) chars.push(pickFrom(all));

  // Fisher-Yates with unbiased random indices.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function pickFrom(set) { return set[randomBelow(set.length)]; }

/** Rejection sampling — modulo alone would skew towards the lower indices. */
function randomBelow(limit) {
  const max = Math.floor(0xFFFFFFFF / limit) * limit;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n < max) return n % limit;
  }
}

/**
 * Policy check. Returns `{ ok, errors[], score }`. The policy itself is a
 * tenant setting (security_policies), so the caller passes the limits in.
 */
export function checkPasswordPolicy(password, policy = {}) {
  const {
    minLength = 10,
    requireMixed = true,
    forbidCommon = true,
    identity = [],
  } = policy;

  const errors = [];
  const value = String(password ?? '');

  if (value.length < minLength) errors.push(`Use at least ${minLength} characters.`);
  if (value.length > 256) errors.push('Use at most 256 characters.');
  if (requireMixed) {
    if (!/[a-z]/.test(value)) errors.push('Include a lowercase letter.');
    if (!/[A-Z]/.test(value)) errors.push('Include an uppercase letter.');
    if (!/[0-9]/.test(value)) errors.push('Include a number.');
  }
  if (forbidCommon && COMMON.has(value.toLowerCase())) {
    errors.push('That password is too common — choose something less predictable.');
  }
  for (const part of identity) {
    const p = String(part || '').split('@')[0];
    if (p.length >= 4 && value.toLowerCase().includes(p.toLowerCase())) {
      errors.push('Do not reuse your name or email address in the password.');
      break;
    }
  }

  let score = 0;
  if (value.length >= minLength) score++;
  if (value.length >= 14) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  return { ok: errors.length === 0, errors, score: Math.min(score, 5) };
}
