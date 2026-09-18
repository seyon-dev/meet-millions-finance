/**
 * Cryptographic primitives, all on Web Crypto so the same code runs in
 * Workers and in Node's test runner. No third-party crypto dependency.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- encoding helpers --------------------------------------------------------

export function toBase64Url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
  return out;
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** A URL-safe random token, e.g. for session bearer tokens and reset links. */
export function randomToken(bytes = 32) { return toBase64Url(randomBytes(bytes)); }

/** A numeric code of `digits` length, uniformly distributed. */
export function randomNumericCode(digits = 6) {
  const max = 10 ** digits;
  const buf = new Uint32Array(1);
  // Reject values in the biased tail so each code is equally likely.
  const limit = Math.floor(0xFFFFFFFF / max) * max;
  let v;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return String(v % max).padStart(digits, '0');
}

// ---- hashing -----------------------------------------------------------------

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function hmacSha256Hex(secret, message) {
  return toHex(await hmacSha256(secret, message));
}

/** Constant-time comparison — never leak how much of a secret matched. */
export function timingSafeEqual(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : a;
  const y = typeof b === 'string' ? enc.encode(b) : b;
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- symmetric encryption (AES-256-GCM) --------------------------------------

async function aesKey(secret) {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a string at rest — TOTP seeds, OAuth refresh tokens, tenant-supplied
 * provider keys. Output is `v1.<iv>.<ciphertext>`, both base64url.
 */
export async function encryptString(plaintext, secret) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = await aesKey(secret);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(plaintext)));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

export async function decryptString(payload, secret) {
  if (!payload) return null;
  const parts = String(payload).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const key = await aesKey(secret);
    const iv = fromBase64Url(parts[1]);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromBase64Url(parts[2]));
    return dec.decode(pt);
  } catch {
    return null; // wrong key or tampered payload — indistinguishable by design
  }
}

export { enc as textEncoder, dec as textDecoder };
