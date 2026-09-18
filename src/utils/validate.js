/**
 * Input validation. Every request body passes through here before it reaches
 * a query; nothing is interpolated into SQL anywhere in this codebase.
 */

import { ValidationError } from '../http/errors.js';

// ---- Indian statutory identifier formats -----------------------------------
// GSTIN: 2-digit state code, 10-char PAN, entity number, 'Z', checksum char.
export const GSTIN_RE = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const E164_RE = /^\+[1-9]\d{7,14}$/;

const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const CSV_INJECTION_RE = new RegExp('^[=+\\-@\\t\\r]');

/** GSTIN checksum — the 15th character is a mod-36 check over the first 14. */
export function isValidGstinChecksum(gstin) {
  if (!GSTIN_RE.test(gstin)) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(gstin[i]);
    if (v < 0) return false;
    const factor = i % 2 === 0 ? 1 : 2;
    const product = v * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === gstin[14];
}

export function isGstin(v) { return typeof v === 'string' && isValidGstinChecksum(v.toUpperCase()); }
export function isPan(v) { return typeof v === 'string' && PAN_RE.test(v.toUpperCase()); }
export function isTan(v) { return typeof v === 'string' && TAN_RE.test(v.toUpperCase()); }
export function isEmail(v) { return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v); }

/** The first two GSTIN digits are the state code — drives intra vs inter-state. */
export function gstinStateCode(gstin) {
  return typeof gstin === 'string' && gstin.length >= 2 ? gstin.slice(0, 2) : null;
}
/** GSTIN characters 3-12 are the holder's PAN. */
export function gstinPan(gstin) {
  return typeof gstin === 'string' && gstin.length >= 12 ? gstin.slice(2, 12) : null;
}

/** Normalise an Indian mobile number to E.164, defaulting to +91. */
export function toE164(input, defaultCc = '91') {
  if (!input) return null;
  let s = String(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) return E164_RE.test(s) ? s : null;
  s = s.replace(/^0+/, '');
  if (s.length === 10) s = defaultCc + s;
  const out = '+' + s;
  return E164_RE.test(out) ? out : null;
}

// ---- Text hygiene -----------------------------------------------------------

/** Trim, strip control characters, enforce a maximum length. */
export function cleanText(v, max = 5000) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(CONTROL_CHARS_RE, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Make an uploaded filename safe to store and to echo back into HTML.
 * Path separators, traversal and leading dots are all removed.
 */
export function sanitizeFilename(name, fallback = 'file') {
  if (!name) return fallback;
  const base = String(name).split(/[\\/]/).pop() || fallback;
  const cleaned = base
    .replace(CONTROL_CHARS_RE, '')
    .replace(/[^A-Za-z0-9._ \-()[\]]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .trim();
  const safe = cleaned.length ? cleaned : fallback;
  return safe.length > 180 ? safe.slice(0, 120) + '_' + safe.slice(-50) : safe;
}

export function fileExtension(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// ---- Schema-style validation ------------------------------------------------

/**
 * A tiny declarative validator. Returns a cleaned object or throws a
 * ValidationError carrying per-field messages the UI renders inline.
 *
 *   validate(body, {
 *     email: { type: 'email', required: true },
 *     seats: { type: 'int', min: 1, max: 500, default: 1 },
 *     role:  { type: 'enum', values: ['admin','client'] },
 *   })
 */
export function validate(input, schema) {
  const source = input && typeof input === 'object' ? input : {};
  const out = {};
  const errors = {};

  for (const [field, rule] of Object.entries(schema)) {
    const value = source[field];
    const present = value !== undefined && value !== null && value !== '';

    if (!present) {
      if (rule.required) { errors[field] = rule.message || `${label(field)} is required.`; continue; }
      if (rule.default !== undefined) out[field] = rule.default;
      else if (rule.nullable !== false) out[field] = null;
      continue;
    }

    try {
      out[field] = coerce(field, value, rule);
    } catch (err) {
      errors[field] = rule.message || err.message;
    }
  }

  if (Object.keys(errors).length) {
    throw new ValidationError('Please correct the highlighted fields.', errors);
  }
  return out;
}

function label(field) {
  return field.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
}

function coerce(field, value, rule) {
  const name = rule.label || label(field);
  switch (rule.type) {
    case 'string': {
      const s = cleanText(value, rule.max ?? 5000);
      if (rule.min && s.length < rule.min) throw new Error(`${name} must be at least ${rule.min} characters.`);
      if (rule.max && s.length > rule.max) throw new Error(`${name} must be at most ${rule.max} characters.`);
      if (rule.pattern && !rule.pattern.test(s)) throw new Error(`${name} is not in the expected format.`);
      return s;
    }
    case 'text': return cleanText(value, rule.max ?? 20000);
    case 'email': {
      const s = String(value).trim().toLowerCase();
      if (!isEmail(s)) throw new Error(`${name} must be a valid email address.`);
      return s;
    }
    case 'phone': {
      const s = toE164(value, rule.defaultCc);
      if (!s) throw new Error(`${name} must be a valid phone number.`);
      return s;
    }
    case 'gstin': {
      const s = String(value).trim().toUpperCase();
      if (!isGstin(s)) throw new Error(`${name} must be a valid 15-character GSTIN.`);
      return s;
    }
    case 'pan': {
      const s = String(value).trim().toUpperCase();
      if (!isPan(s)) throw new Error(`${name} must be a valid 10-character PAN.`);
      return s;
    }
    case 'tan': {
      const s = String(value).trim().toUpperCase();
      if (!isTan(s)) throw new Error(`${name} must be a valid 10-character TAN.`);
      return s;
    }
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number.`);
      if (rule.min !== undefined && n < rule.min) throw new Error(`${name} must be at least ${rule.min}.`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`${name} must be at most ${rule.max}.`);
      return n;
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
      if (rule.min !== undefined && n < rule.min) throw new Error(`${name} must be at least ${rule.min}.`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`${name} must be at most ${rule.max}.`);
      return n;
    }
    case 'paise': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${name} must be an amount.`);
      const p = Math.round(n);
      if (rule.min !== undefined && p < rule.min) throw new Error(`${name} is below the minimum allowed.`);
      if (rule.max !== undefined && p > rule.max) throw new Error(`${name} is above the maximum allowed.`);
      return p;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return true;
      if (['false', '0', 'no', 'off'].includes(s)) return false;
      throw new Error(`${name} must be true or false.`);
    }
    case 'enum': {
      const s = String(value);
      if (!rule.values.includes(s)) throw new Error(`${name} must be one of: ${rule.values.join(', ')}.`);
      return s;
    }
    case 'date': {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) throw new Error(`${name} must be a valid date.`);
      return d.toISOString();
    }
    case 'id': {
      const s = String(value).trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Error(`${name} is not a valid identifier.`);
      return s;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new Error(`${name} must be a list.`);
      if (rule.max && value.length > rule.max) throw new Error(`${name} may contain at most ${rule.max} items.`);
      if (rule.of) return value.map((v, i) => coerce(`${field}[${i}]`, v, rule.of));
      return value;
    }
    case 'json': {
      if (typeof value === 'object') return value;
      try { return JSON.parse(String(value)); }
      catch { throw new Error(`${name} must be valid JSON.`); }
    }
    default:
      return value;
  }
}

/** Escape a string for safe interpolation into HTML (used by PDF/email HTML). */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape a value for a CSV cell, neutralising spreadsheet formula injection. */
export function escapeCsv(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (CSV_INJECTION_RE.test(s)) s = "'" + s;
  if (/["\n\r,]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
