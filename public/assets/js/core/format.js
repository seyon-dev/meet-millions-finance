/**
 * Formatting.
 *
 * Indian conventions throughout: the lakh/crore grouping, rupees, and dates
 * written the way an Indian accountant writes them. Money arrives from the API
 * as integer paise and is only ever divided here, at the edge — never in
 * arithmetic.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0,
});
const NUMBER = new Intl.NumberFormat('en-IN');

/** Paise → "₹1,23,456.78". */
export function money(paise, { whole = false } = {}) {
  const value = Number(paise ?? 0) / 100;
  return (whole ? INR_WHOLE : INR).format(value);
}

/**
 * Paise → "₹1.23 Cr", "₹4.5 L", "₹12,300".
 *
 * Lakh and crore, not million and billion: a figure read by an Indian firm
 * should be grouped the way they would say it aloud.
 */
export function moneyShort(paise) {
  const rupees = Number(paise ?? 0) / 100;
  const abs = Math.abs(rupees);
  if (abs >= 1e7) return `₹${trim(rupees / 1e7)} Cr`;
  if (abs >= 1e5) return `₹${trim(rupees / 1e5)} L`;
  if (abs >= 1e3) return INR_WHOLE.format(rupees);
  return INR_WHOLE.format(rupees);
}

function trim(value) {
  return Number(value.toFixed(2)).toString();
}

export function number(value) {
  return NUMBER.format(Number(value ?? 0));
}

export function percent(value, { decimals = 0 } = {}) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toFixed(decimals)}%`;
}

/** "18 Sep 2026". */
export function date(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "18 Sep 2026, 3:42 pm". */
export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${date(value)}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
}

/**
 * "just now", "4 min ago", "yesterday", then an absolute date.
 *
 * Relative time is only helpful while it is short. Past a week, "3 weeks ago"
 * is worse than the date it happened.
 */
export function relative(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);

  if (abs < 45) return future ? 'in a moment' : 'just now';
  if (abs < 3600) return phrase(Math.round(abs / 60), 'min', future);
  if (abs < 86400) return phrase(Math.round(abs / 3600), 'hour', future);
  if (abs < 172800) return future ? 'tomorrow' : 'yesterday';
  if (abs < 604800) return phrase(Math.round(abs / 86400), 'day', future);
  return date(value);
}

function phrase(n, unit, future) {
  const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return future ? `in ${label}` : `${label} ago`;
}

/** Days until a date, as a phrase a deadline strip can show. */
export function untilDays(value) {
  if (!value) return null;
  const target = new Date(value.length === 10 ? `${value}T00:00:00Z` : value).getTime();
  if (Number.isNaN(target)) return null;
  const days = Math.ceil((target - Date.now()) / 86400000);
  if (days < 0) return { days, label: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`, tone: 'danger' };
  if (days === 0) return { days, label: 'due today', tone: 'warning' };
  if (days === 1) return { days, label: 'due tomorrow', tone: 'warning' };
  if (days <= 3) return { days, label: `${days} days left`, tone: 'warning' };
  return { days, label: `${days} days left`, tone: 'default' };
}

/** Seconds → "4m 12s", for call durations. */
export function duration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds ?? 0)));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Minutes → "7h 30m", for worked time. */
export function minutes(value) {
  const total = Math.max(0, Math.round(Number(value ?? 0)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function bytes(value) {
  const n = Number(value ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "gst_invoice" → "GST invoice"; "under_review" → "Under review". */
export function label(value) {
  if (!value) return '—';
  const words = String(value).replace(/[_-]+/g, ' ').trim();
  const cased = words.charAt(0).toUpperCase() + words.slice(1);
  // Acronyms an Indian accountant reads in capitals.
  return cased.replace(/\b(gst|tds|pan|tan|itc|hsn|sac|cgst|sgst|igst|kyc|api|ocr|ai|sla|ivr|dsc|upi|emi|mrr|cin)\b/gi,
    m => m.toUpperCase());
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Mask a phone number for a screen somebody else might be looking at. */
export function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 6) return value ?? '—';
  return `${digits.slice(0, 2)}•••••${digits.slice(-3)}`;
}

/** Plural without a library: plural(3, 'document') → "3 documents". */
export function plural(count, singular, pluralForm = null) {
  const n = Number(count ?? 0);
  return `${number(n)} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
