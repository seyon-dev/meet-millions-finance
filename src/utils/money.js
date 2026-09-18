/**
 * Money handling.
 *
 * Every amount in the system is an integer number of paise. Floating point
 * rupees are never persisted and never summed — a tax ledger that drifts by
 * a paisa per row is a tax ledger nobody can reconcile.
 */

export const PAISE_PER_RUPEE = 100;

/** Rupees (number or numeric string) → integer paise, half-up. */
export function toPaise(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') return 0;
  const n = typeof rupees === 'string' ? Number(rupees.replace(/[,\s₹]/g, '')) : Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * PAISE_PER_RUPEE);
}

/** Integer paise → rupees as a Number. For display only, never for maths. */
export function toRupees(paise) {
  return (Number(paise) || 0) / PAISE_PER_RUPEE;
}

/**
 * Percentage of a paise amount, rounded half-up to the nearest paise.
 * This is the single rounding point in the tax engine.
 */
export function pctOfPaise(paise, pct) {
  const base = Number(paise) || 0;
  const rate = Number(pct) || 0;
  return Math.round((base * rate) / 100);
}

export function sumPaise(values) {
  let total = 0;
  for (const v of values) total += Number(v) || 0;
  return total;
}

/** Indian digit grouping: 1,23,45,678 — not 12,345,678. */
export function formatIndianDigits(value) {
  const n = Math.abs(Math.trunc(value));
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

/** "₹18,45,600.50" */
export function formatINR(paise, { decimals = 2, symbol = true } = {}) {
  const value = toRupees(paise);
  const negative = value < 0;
  const whole = Math.trunc(Math.abs(value));
  const frac = Math.round((Math.abs(value) - whole) * 100);
  let out = formatIndianDigits(whole);
  if (decimals > 0) out += '.' + String(frac).padStart(2, '0');
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${out}`;
}

/** Compact Indian notation for dashboard tiles: ₹18.4L, ₹2.1Cr. */
export function formatINRCompact(paise) {
  const v = toRupees(paise);
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs / 1e7 >= 100 ? 0 : 2).replace(/\.00$/, '')}Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs / 1e5 >= 100 ? 0 : 1).replace(/\.0$/, '')}L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(abs / 1e3 >= 100 ? 0 : 1).replace(/\.0$/, '')}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/**
 * Split a total into equal parts without losing paise: the remainder is
 * distributed one paisa at a time across the leading parts.
 */
export function splitPaise(total, parts) {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}
