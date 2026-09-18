/**
 * A D1-compatible database binding backed by MySQL.
 *
 * The application talks to `env.DB` through the D1 binding API in exactly one
 * place — `new Db(ctx.env.DB)` in src/db/client.js, 123 identical call sites —
 * and nowhere else. So moving off Cloudflare does not mean touching the
 * application: it means providing that same interface over a different engine.
 * This is that, over a mysql2 pool.
 *
 * The same shape already existed for tests (tests/helpers/d1.js, over
 * node:sqlite), which is the evidence the interface is genuinely swappable
 * rather than a hopeful abstraction.
 *
 * SQL written for SQLite is translated on the way through — see
 * src/db/dialect.js for what is rewritten and why nothing else is.
 */

import mysql from 'mysql2/promise';
import { toMysql } from './dialect.js';

/**
 * Configuration, read from the environment.
 *
 * Fails loudly and specifically when something required is missing: a CRM that
 * starts up and then 500s on the first request is worse than one that refuses
 * to start and says which variable is absent.
 */
export function poolConfigFromEnv(env = process.env) {
  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter(k => !env[k]);
  if (missing.length) {
    throw new Error(
      `Database configuration is incomplete: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. `
      + 'See docs/mysql.md; .env.example lists every variable.');
  }

  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT ?? 3306),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,

    // Hostinger's MySQL sits behind a connection limit that a pool will
    // happily exhaust. Ten is comfortable for a single Node process and
    // leaves room for the scheduler's own queries.
    connectionLimit: Number(env.DB_POOL_SIZE ?? 10),
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,

    // Every id, timestamp and JSON blob in this schema is text. Letting the
    // driver coerce DECIMAL or DATE into JavaScript types would change what
    // the application reads back compared with SQLite.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4',

    // Prepared statements are how the application avoids SQL injection; the
    // driver must not fall back to string interpolation.
    namedPlaceholders: false,
    multipleStatements: false,
  };
}

let pool = null;

export function getPool(env = process.env) {
  if (!pool) pool = mysql.createPool(poolConfigFromEnv(env));
  return pool;
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

/** Retried once: a pooled connection that the server closed underneath us. */
const RETRYABLE = new Set([
  'PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT',
]);

async function execute(conn, sql, params) {
  const translated = toMysql(sql);
  try {
    return await conn.execute(translated, params);
  } catch (err) {
    if (!RETRYABLE.has(err?.code)) throw err;
    // One retry. A deadlock or a dropped pooled connection is transient; a
    // second failure is real and must surface rather than loop.
    return conn.execute(translated, params);
  }
}

/**
 * One prepared statement, with D1's fluent shape.
 *
 * D1 returns `{ results, success, meta }` from all() and a bare row from
 * first(); the application depends on both, so they are reproduced exactly.
 */
class MysqlStatement {
  constructor(pool, sql, params = []) {
    this.pool = pool;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new MysqlStatement(this.pool, this.sql, params.map(coerce));
  }

  async all() {
    const [rows] = await execute(this.pool, this.sql, this.params);
    const results = Array.isArray(rows) ? rows : [];
    return { results, success: true, meta: { rows_read: results.length, changes: 0, duration: 0 } };
  }

  async first(column) {
    const [rows] = await execute(this.pool, this.sql, this.params);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row === undefined || row === null) return null;
    return column ? row[column] ?? null : row;
  }

  async run() {
    const [result] = await execute(this.pool, this.sql, this.params);
    return {
      success: true,
      meta: {
        changes: result?.affectedRows ?? 0,
        last_row_id: result?.insertId ?? 0,
        rows_written: result?.affectedRows ?? 0,
        duration: 0,
      },
    };
  }

  async raw() {
    const [rows] = await execute(this.pool, this.sql, this.params);
    return (Array.isArray(rows) ? rows : []).map(r => Object.values(r));
  }
}

/**
 * MySQL has no boolean and no undefined. SQLite accepted both; the
 * application still passes them, so they are normalised here rather than at
 * 123 call sites.
 */
function coerce(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** The binding itself — what gets handed to the application as `env.DB`. */
export class MysqlD1 {
  constructor(pool) { this.pool = pool; }

  prepare(sql) { return new MysqlStatement(this.pool, sql, []); }

  /**
   * D1's batch runs its statements in one transaction. So does this: the
   * audit chain and the tenant scope both rely on a batch being atomic.
   */
  async batch(statements) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const out = [];
      for (const stmt of statements) {
        const [result] = await execute(conn, stmt.sql, stmt.params);
        out.push(Array.isArray(result)
          ? { results: result, success: true, meta: { rows_read: result.length } }
          : { results: [], success: true, meta: { changes: result?.affectedRows ?? 0 } });
      }
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Multi-statement SQL, used by the migration runner only. */
  async exec(sql) {
    const conn = await mysql.createConnection({
      ...poolConfigFromEnv(),
      multipleStatements: true,
    });
    try {
      await conn.query(sql);
      return { count: 1, duration: 0 };
    } finally {
      await conn.end();
    }
  }
}

/** Build the binding. Called once, at startup. */
export function createMysqlBinding(env = process.env) {
  return new MysqlD1(getPool(env));
}
