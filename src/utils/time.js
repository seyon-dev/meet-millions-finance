/**
 * Time helpers. Every stored timestamp is ISO-8601 UTC with milliseconds so
 * that string comparison equals chronological comparison in SQL.
 */

export function nowIso() {
  return new Date().toISOString();
}

export function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function addSeconds(seconds, from = new Date()) {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}
export function addMinutes(minutes, from = new Date()) {
  return addSeconds(minutes * 60, from);
}
export function addHours(hours, from = new Date()) {
  return addSeconds(hours * 3600, from);
}
export function addDays(days, from = new Date()) {
  return addSeconds(days * 86400, from);
}
export function addMonths(months, from = new Date()) {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Clamp 31 Jan + 1 month to 28/29 Feb rather than rolling into March.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}

export function isPast(iso) {
  return !!iso && new Date(iso).getTime() < Date.now();
}
export function isFuture(iso) {
  return !!iso && new Date(iso).getTime() > Date.now();
}

/** YYYY-MM-DD in UTC. */
export function dayKey(value = new Date()) {
  return toIso(value).slice(0, 10);
}
/** YYYY-MM in UTC. */
export function monthKey(value = new Date()) {
  return toIso(value).slice(0, 7);
}
/** YYYY-Qn — calendar quarters. */
export function quarterKey(value = new Date()) {
  const d = new Date(toIso(value));
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
/** Indian financial year label for a date, e.g. 2026-27 (Apr–Mar). */
export function financialYearKey(value = new Date()) {
  const d = new Date(toIso(value));
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Inclusive [start, end] ISO bounds for a period key. */
export function periodBounds(periodType, periodKey) {
  if (periodType === 'monthly') {
    const [y, m] = periodKey.split('-').map(Number);
    const start = Date.UTC(y, m - 1, 1);
    const end = Date.UTC(y, m, 0, 23, 59, 59, 999);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }
  if (periodType === 'quarterly') {
    const [y, q] = periodKey.split('-Q').map(Number);
    const startMonth = (q - 1) * 3;
    const start = Date.UTC(y, startMonth, 1);
    const end = Date.UTC(y, startMonth + 3, 0, 23, 59, 59, 999);
    return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }
  // yearly: financial year 2026-27 runs 1 Apr 2026 – 31 Mar 2027
  const startYear = Number(periodKey.split('-')[0]);
  return {
    start: new Date(Date.UTC(startYear, 3, 1)).toISOString(),
    end: new Date(Date.UTC(startYear + 1, 2, 31, 23, 59, 59, 999)).toISOString(),
  };
}

/**
 * Statutory GST due date for a monthly period: GSTR-3B is due on the 20th of
 * the following month. Stored per-period so a tenant can override it.
 */
export function gstDueDate(periodType, periodKey) {
  const { end } = periodBounds(periodType, periodKey);
  const d = new Date(end);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 20, 23, 59, 59)).toISOString();
}

/** The previous N month keys, newest last — for trend charts. */
export function recentMonthKeys(count, from = new Date()) {
  const out = [];
  const d = new Date(toIso(from));
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function secondsBetween(a, b) {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
}
