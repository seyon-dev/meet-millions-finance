/**
 * Apply the MySQL schema. The implementation; scripts/migrate-mysql.mjs is the
 * command-line front for it, and server.js calls it when AUTO_MIGRATE is on.
 *
 * One implementation rather than two, because a migration that behaves
 * differently depending on how it was invoked is the kind of difference nobody
 * finds until production.
 *
 * Never drops, truncates or deletes. What it decides to do is decided by
 * planMigration in src/db/migration-plan.js, which is pure and covered by the
 * test suite — the branches that refuse must not be met for the first time
 * against a live database.
 */

import mysql from 'mysql2/promise';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { poolConfigFromEnv } from '../src/db/mysql.js';
import { planMigration } from '../src/db/migration-plan.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const BASELINE = resolve(root, 'database/mysql-schema.sql');
const BASELINE_NAME = 'mysql-schema.sql';
const INCREMENTAL_DIR = resolve(root, 'database/mysql');
const SOURCE_MIGRATIONS = resolve(root, 'database/migrations');

const sqlFiles = (dir) => (existsSync(dir)
  ? readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  : []);

/**
 * @param {object} options
 * @param {boolean} options.dryRun  report without changing anything
 * @param {function} options.log    where progress goes
 * @returns {Promise<{ok: boolean, message: string, applied: string[], plan: object|null}>}
 */
export async function runMigration({ dryRun = false, log = () => {} } = {}) {
  if (!existsSync(BASELINE)) {
    return { ok: false, applied: [], plan: null,
      message: `${BASELINE} is missing. Run: node scripts/mysql-schema.mjs` };
  }

  let config;
  try {
    config = { ...poolConfigFromEnv(), multipleStatements: true };
  } catch (err) {
    return { ok: false, applied: [], plan: null, message: err.message };
  }

  const baselineSql = readFileSync(BASELINE, 'utf8');
  const covered = [...baselineSql.matchAll(/^-- COVERS: (\S+\.sql)$/gm)].map(m => m[1]);

  let conn;
  try {
    conn = await mysql.createConnection(config);
  } catch (err) {
    return {
      ok: false, applied: [], plan: null,
      message: `Could not connect to ${config.database}@${config.host}:${config.port} — ${err.message}. `
        + 'Check DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD.',
    };
  }

  const applied = [];

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(191) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [recorded] = await conn.query('SELECT name FROM schema_migrations');
    const [tableRows] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [config.database]);

    const plan = planMigration({
      applied: new Set(recorded.map(r => r.name)),
      // schema_migrations itself is not application data.
      tableCount: Math.max(0, Number(tableRows[0]?.n ?? 0) - 1),
      covered,
      sourceMigrations: sqlFiles(SOURCE_MIGRATIONS),
      incrementals: sqlFiles(INCREMENTAL_DIR),
      baselineName: BASELINE_NAME,
    });

    if (plan.action === 'refuse' && plan.reason === 'migrations_without_a_route') {
      return {
        ok: false, applied, plan,
        message: `${plan.unhandled.length} migration(s) cannot reach this database: `
          + `${plan.unhandled.join(', ')}. The baseline predates them and is already applied. `
          + 'Add the matching file to database/mysql/ — see its README.',
      };
    }

    if (plan.action === 'refuse' && plan.reason === 'database_not_empty') {
      return {
        ok: false, applied, plan,
        message: `${config.database} already contains ${plan.tableCount} table(s) with no record `
          + 'of this schema. Refusing to apply it over an existing database. Point DB_NAME at an '
          + 'empty database, or drop its tables if it holds nothing.',
      };
    }

    if (plan.action === 'up_to_date') {
      return { ok: true, applied, plan, message: 'Already up to date; nothing to do.' };
    }

    if (dryRun) {
      const pending = [
        ...(plan.applyBaseline ? [`${BASELINE_NAME} (baseline, ${covered.length} migrations)`] : []),
        ...plan.pending,
      ];
      return { ok: true, applied, plan, message: `Pending: ${pending.join(', ')}. Nothing was changed.` };
    }

    if (plan.applyBaseline) {
      log(`Applying ${BASELINE_NAME} to ${config.database}@${config.host}…`);
      await conn.query(baselineSql);
      for (const name of plan.record) {
        await conn.query(
          'INSERT IGNORE INTO schema_migrations (name, applied_at) VALUES (?, NOW())', [name]);
      }
      applied.push(BASELINE_NAME);
    }

    for (const file of plan.pending) {
      log(`Applying ${file}…`);
      await conn.query(readFileSync(join(INCREMENTAL_DIR, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW())', [file]);
      applied.push(file);
    }

    const [after] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
      [config.database]);

    return {
      ok: true, applied, plan,
      message: `Applied ${applied.length} migration(s); ${Number(after[0]?.n ?? 0) - 1} tables.`,
    };
  } catch (err) {
    return {
      ok: false, applied, plan: null,
      message: `${err.message}. Nothing was dropped — re-running is safe once the cause is fixed.`,
    };
  } finally {
    await conn.end().catch(() => {});
  }
}
