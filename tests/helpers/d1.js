/**
 * A D1-compatible adapter over node:sqlite.
 *
 * The Worker code is written against the D1 binding API and never imports
 * this file. Tests build a real SQLite database from the same migration SQL
 * that ships to production, so what the suite exercises is the production
 * schema and the production queries — not a mock of them.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

class D1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new D1Statement(this.db, this.sql, params.map(coerce));
  }

  _stmt() { return this.db.prepare(this.sql); }

  async all() {
    const results = this._stmt().all(...this.params);
    return { results, success: true, meta: { rows_read: results.length, changes: 0, duration: 0 } };
  }

  async first(column) {
    const row = this._stmt().get(...this.params);
    if (row === undefined || row === null) return null;
    return column ? row[column] ?? null : row;
  }

  async run() {
    const info = this._stmt().run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        rows_written: Number(info.changes ?? 0),
        duration: 0,
      },
    };
  }

  async raw() {
    const rows = this._stmt().all(...this.params);
    return rows.map(r => Object.values(r));
  }
}

/** node:sqlite accepts null/number/string/bigint/buffer only. */
function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return JSON.stringify(v);
  return v;
}

export class D1Shim {
  constructor(sqlite) { this.sqlite = sqlite; }

  prepare(sql) { return new D1Statement(this.sqlite, sql); }

  async batch(statements) {
    // D1 batches are atomic; mirror that so tests catch partial-write bugs.
    this.sqlite.exec('BEGIN');
    try {
      const out = [];
      for (const st of statements) {
        out.push(/^\s*(select|with|pragma)/i.test(st.sql) ? await st.all() : await st.run());
      }
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() { this.sqlite.close(); }
}

/** An in-memory database with every migration applied, in order. */
export function createTestD1({ migrationsDir = 'database/migrations' } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) sqlite.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
  return new D1Shim(sqlite);
}

/** An in-memory R2 bucket with the subset of the API the Worker uses. */
export class R2Shim {
  constructor() { this.objects = new Map(); }

  async put(key, value, options = {}) {
    const body = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
      : typeof value === 'string' ? new TextEncoder().encode(value)
      : new Uint8Array(await new Response(value).arrayBuffer());
    const record = {
      key, body,
      size: body.byteLength,
      etag: `etag-${body.byteLength}-${key.length}`,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata ?? {},
      customMetadata: options.customMetadata ?? {},
    };
    this.objects.set(key, record);
    return { key, size: record.size, etag: record.etag, uploaded: record.uploaded };
  }

  async get(key) {
    const rec = this.objects.get(key);
    if (!rec) return null;
    const body = rec.body;
    return {
      key: rec.key, size: rec.size, etag: rec.etag, uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata, customMetadata: rec.customMetadata,
      body: new Blob([body]).stream(),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => new TextDecoder().decode(body),
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      writeHttpMetadata: () => {},
    };
  }

  async head(key) {
    const rec = this.objects.get(key);
    if (!rec) return null;
    return { key: rec.key, size: rec.size, etag: rec.etag, uploaded: rec.uploaded,
             httpMetadata: rec.httpMetadata, customMetadata: rec.customMetadata };
  }

  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const objects = [...this.objects.values()]
      .filter(o => o.key.startsWith(prefix))
      .slice(0, limit)
      .map(o => ({ key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
}

/** An in-memory KV namespace. */
export class KVShim {
  constructor() { this.store = new Map(); }
  async get(key, type = 'text') {
    const rec = this.store.get(key);
    if (!rec) return null;
    if (rec.expires && rec.expires < Date.now()) { this.store.delete(key); return null; }
    return type === 'json' ? JSON.parse(rec.value) : rec.value;
  }
  async put(key, value, options = {}) {
    this.store.set(key, {
      value: typeof value === 'string' ? value : JSON.stringify(value),
      expires: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
    });
  }
  async delete(key) { this.store.delete(key); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}
