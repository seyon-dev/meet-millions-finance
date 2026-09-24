/**
 * D1 access layer.
 *
 * Everything goes through prepared statements with bound parameters — no SQL
 * string is ever built from user input. Identifiers (table and column names)
 * used by the helpers below are validated against a strict pattern, so a
 * caller cannot smuggle an expression in through a column name either.
 */

import { AppError, ConflictError } from '../http/errors.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a SQL identifier. Accepts a bare column (`status`) or one
 * qualified by a table alias (`d.status`), validating each part strictly so a
 * caller can join without opening a hole. Anything else is refused outright.
 */
function ident(name) {
  const parts = String(name).split('.');
  if (parts.length > 2 || !parts.every(p => IDENT_RE.test(p))) {
    throw new AppError(`Unsafe SQL identifier: ${name}`, { code: 'unsafe_identifier' });
  }
  return parts.join('.');
}

/**
 * Wrap a database failure so a unique-constraint clash becomes a 409, not a
 * 500 — whichever engine raised it.
 *
 * SQLite speaks in message text; MySQL speaks in error numbers. Matching only
 * the SQLite phrases meant that on production MySQL every duplicate, missing
 * reference and refused CHECK fell through to the generic 500 — a second
 * submit of the same form read as "something went wrong on our side" instead
 * of "that already exists".
 */
function translate(err, sql) {
  const msg = String(err?.message || err);
  const errno = Number(err?.errno ?? 0);

  if (/UNIQUE constraint failed/i.test(msg) || errno === 1062) {
    const field = /UNIQUE constraint failed:\s*([^\s)]+)/i.exec(msg)?.[1]
      ?? /for key '([^']+)'/i.exec(msg)?.[1] ?? null;
    return new ConflictError('That record already exists.', field ? { field } : null);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg) || errno === 1451 || errno === 1452) {
    return new AppError('A referenced record is missing or still in use.', {
      status: 409, code: 'foreign_key_violation', expose: true,
    });
  }
  if (/CHECK constraint failed/i.test(msg) || errno === 4025 || errno === 3819) {
    return new AppError('That value is not allowed for this field.', {
      status: 422, code: 'check_constraint', expose: true,
    });
  }
  return new AppError(`Database error: ${msg}`, { code: 'db_error', cause: err, details: { sql } });
}

export class Db {
  constructor(d1) {
    if (!d1) throw new AppError('No database binding is configured.', { code: 'db_unavailable' });
    this.d1 = d1;
  }

  prepare(sql, params = []) {
    const stmt = this.d1.prepare(sql);
    return params.length ? stmt.bind(...params) : stmt;
  }

  async many(sql, params = []) {
    try {
      const res = await this.prepare(sql, params).all();
      return res.results ?? [];
    } catch (err) { throw translate(err, sql); }
  }

  async one(sql, params = []) {
    try {
      return (await this.prepare(sql, params).first()) ?? null;
    } catch (err) { throw translate(err, sql); }
  }

  async value(sql, params = []) {
    const row = await this.one(sql, params);
    return row ? Object.values(row)[0] : null;
  }

  async run(sql, params = []) {
    try {
      const res = await this.prepare(sql, params).run();
      return res.meta ?? res;
    } catch (err) { throw translate(err, sql); }
  }

  async count(sql, params = []) {
    const n = await this.value(sql, params);
    return Number(n) || 0;
  }

  async exists(sql, params = []) {
    return (await this.one(sql, params)) !== null;
  }

  /**
   * D1 batch — a single round trip, and atomic in D1's implementation.
   * `items` is an array of [sql, params] pairs.
   */
  async batch(items) {
    if (!items.length) return [];
    try {
      return await this.d1.batch(items.map(([sql, params = []]) => this.prepare(sql, params)));
    } catch (err) { throw translate(err, items[0]?.[0]); }
  }

  // ---- Generic writers ------------------------------------------------------

  async insert(table, data) {
    const cols = Object.keys(data).filter(k => data[k] !== undefined).map(ident);
    if (!cols.length) throw new AppError('Nothing to insert.', { code: 'empty_insert' });
    const sql =
      `INSERT INTO ${ident(table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    await this.run(sql, cols.map(c => normalise(data[c])));
    return data.id ?? null;
  }

  /** Insert, or do nothing when the row already exists (idempotent seeds). */
  async insertOrIgnore(table, data) {
    const cols = Object.keys(data).filter(k => data[k] !== undefined).map(ident);
    const sql =
      `INSERT OR IGNORE INTO ${ident(table)} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const meta = await this.run(sql, cols.map(c => normalise(data[c])));
    return (meta?.changes ?? meta?.rows_written ?? 0) > 0;
  }

  /**
   * UPDATE ... WHERE <where>. `where` is an object of column → value; it is
   * required, so an accidental table-wide update is impossible.
   */
  async update(table, where, data) {
    const setCols = Object.keys(data).filter(k => data[k] !== undefined).map(ident);
    const whereCols = Object.keys(where).map(ident);
    if (!setCols.length) return 0;
    if (!whereCols.length) throw new AppError('Refusing an UPDATE with no WHERE clause.', { code: 'unsafe_update' });

    const sql =
      `UPDATE ${ident(table)} SET ${setCols.map(c => `${c} = ?`).join(', ')} ` +
      `WHERE ${whereCols.map(c => `${c} = ?`).join(' AND ')}`;
    const meta = await this.run(sql, [
      ...setCols.map(c => normalise(data[c])),
      ...whereCols.map(c => normalise(where[c])),
    ]);
    return meta?.changes ?? 0;
  }

  async deleteWhere(table, where) {
    const cols = Object.keys(where).map(ident);
    if (!cols.length) throw new AppError('Refusing a DELETE with no WHERE clause.', { code: 'unsafe_delete' });
    const sql = `DELETE FROM ${ident(table)} WHERE ${cols.map(c => `${c} = ?`).join(' AND ')}`;
    const meta = await this.run(sql, cols.map(c => normalise(where[c])));
    return meta?.changes ?? 0;
  }

  /**
   * The column names of a table, read once per isolate from the schema.
   * Cheaper and far more reliable than hand-maintained lists of which tables
   * carry created_at / updated_at.
   */
  async columnsOf(table) {
    const name = ident(table);
    if (!this._columnCache) this._columnCache = new Map();
    if (this._columnCache.has(name)) return this._columnCache.get(name);
    const rows = await this.many(`PRAGMA table_info(${name})`);
    const set = new Set(rows.map(r => r.name));
    this._columnCache.set(name, set);
    return set;
  }

  async hasColumn(table, column) {
    return (await this.columnsOf(table)).has(column);
  }

  async findOne(table, where, columns = '*') {
    const cols = Object.keys(where).map(ident);
    const sql =
      `SELECT ${columns} FROM ${ident(table)} ` +
      `WHERE ${cols.map(c => `${c} = ?`).join(' AND ')} LIMIT 1`;
    return this.one(sql, cols.map(c => normalise(where[c])));
  }
}

/** Booleans become 0/1 and plain objects become JSON before they reach SQLite. */
function normalise(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
    return JSON.stringify(v);
  }
  return v === undefined ? null : v;
}

export { normalise, ident };

/**
 * A composable WHERE builder. Conditions are only ever added with bound
 * parameters; `sql` fragments are authored in this codebase, never by a user.
 */
export class Where {
  constructor() { this.clauses = []; this.params = []; }

  add(sql, ...params) {
    if (sql) { this.clauses.push(sql); this.params.push(...params); }
    return this;
  }

  /** Adds `col = value` only when value is meaningful — the common filter case. */
  eqIf(col, value) {
    if (value !== undefined && value !== null && value !== '') this.add(`${ident(col)} = ?`, value);
    return this;
  }

  inIf(col, values) {
    if (Array.isArray(values) && values.length) {
      this.add(`${ident(col)} IN (${values.map(() => '?').join(', ')})`, ...values);
    }
    return this;
  }

  /** Case-insensitive contains across several columns (list search boxes). */
  searchIf(columns, term) {
    const q = (term || '').trim();
    if (!q) return this;
    const like = `%${q.replace(/[%_\\]/g, m => '\\' + m).toLowerCase()}%`;
    const parts = columns.map(c => `LOWER(COALESCE(${ident(c)}, '')) LIKE ? ESCAPE '\\'`);
    this.add(`(${parts.join(' OR ')})`, ...columns.map(() => like));
    return this;
  }

  betweenIf(col, from, to) {
    if (from) this.add(`${ident(col)} >= ?`, from);
    if (to) this.add(`${ident(col)} <= ?`, to);
    return this;
  }

  get sql() { return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : ''; }
  get conditions() { return this.clauses.length ? this.clauses.join(' AND ') : '1=1'; }
}

/** Only these directions ever reach an ORDER BY. */
export function safeOrder(column, direction, allowedColumns, fallback) {
  const col = allowedColumns.includes(column) ? column : fallback;
  const dir = String(direction).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${ident(col)} ${dir}`;
}
