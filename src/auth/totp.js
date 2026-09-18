/**
 * TOTP (RFC 6238) — two-factor authentication, built in-house as the
 * Integration Stack addendum specifies. No per-OTP vendor cost, and it works
 * with Google Authenticator, Authy, 1Password and every other standard app.
 */

import { randomBytes, timingSafeEqual, toBase64Url, sha256Hex } from './crypto.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step to tolerate clock skew. */
export const TOTP_WINDOW = 1;

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret.');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh 160-bit secret, base32 encoded for the authenticator app. */
export function generateTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

async function hotp(secretBytes, counter, digits = TOTP_DIGITS) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const key = await crypto.subtle.importKey(
    'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));

  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

/** The code for a given moment — used by tests and by enrolment previews. */
export async function generateTotp(secret, at = Date.now(), { period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {}) {
  const counter = Math.floor(at / 1000 / period);
  return hotp(base32Decode(secret), counter, digits);
}

/**
 * Verify a submitted code against the window. Returns the matching step offset
 * (so a caller can store it and reject replays) or null.
 */
export async function verifyTotp(secret, token, { at = Date.now(), window = TOTP_WINDOW, period = TOTP_PERIOD_SECONDS, digits = TOTP_DIGITS } = {}) {
  const candidate = String(token ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) return null;

  const bytes = base32Decode(secret);
  const counter = Math.floor(at / 1000 / period);
  for (let offset = -window; offset <= window; offset++) {
    const expected = await hotp(bytes, counter + offset, digits);
    if (timingSafeEqual(expected, candidate)) return offset;
  }
  return null;
}

/** The otpauth:// URI an authenticator app scans as a QR code. */
export function totpUri(secret, { issuer = 'Meet Millions Finance CRM', account }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Ten single-use recovery codes. Only their hashes are stored, so a database
 * leak does not hand an attacker a working second factor.
 */
export async function generateBackupCodes(count = 10) {
  const plain = [];
  const hashed = [];
  for (let i = 0; i < count; i++) {
    const code = toBase64Url(randomBytes(12)).replace(/[-_]/g, '').slice(0, 10).toUpperCase();
    const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
    plain.push(formatted);
    hashed.push(await sha256Hex(formatted));
  }
  return { plain, hashed };
}

/** Consume a backup code, returning the remaining hashes when it matches. */
export async function consumeBackupCode(code, hashedCodes) {
  const candidate = String(code ?? '').trim().toUpperCase();
  if (!candidate) return null;
  const hash = await sha256Hex(candidate);
  const idx = hashedCodes.indexOf(hash);
  if (idx === -1) return null;
  const remaining = hashedCodes.slice();
  remaining.splice(idx, 1);
  return remaining;
}
