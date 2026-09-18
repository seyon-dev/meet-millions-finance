/**
 * Apply the MySQL schema, and record what has been applied.
 *
 * Non-destructive by design: it creates what is missing and never drops
 * anything. Running it twice is a no-op, so it is safe to put in a deploy
 * step where nobody is watching the output.
 *
 *   npm run migrate            # apply anything not yet applied
 *   npm run migrate -- --check # report without changing anything
 */

import mysql from 'mysql2/promise';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { poolConfigFromEnv } from '../src/db/mysql.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const SCHEMA = resolve(root, 'database/mysql-schema.sql');
const check = process.argv.includes('--check');

if (!existsSync(SCHEMA)) {
  console.error(`\n  ${SCHEMA} is missing. Run: node scripts/mysql-schema.mjs\n`);
  process.exit(1);
}

let config;
try {
  config = { ...poolConfigFromEnv(), multipleStatements: true };
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const conn = await mysql.createConnection(config);

try {
  // Where applied migrations are recorded. Named to match what wrangler used,
  // so a database moved between the two is recognisable either way.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       VARCHAR(191) PRIMARY KEY,
      applied_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [rows] = await conn.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map(r => r.name));

  const [tables] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
    [config.database]);
  const tableCount = Number(tables[0]?.n ?? 0);

  if (applied.has('mysql-schema.sql')) {
    console.log(`  Schema already applied. ${tableCount} tables present.`);
    process.exit(0);
  }

  // A database that already has tables but no record of them: refuse rather
  // than run a schema over the top of somebody's data.
  if (tableCount > 1) {
    console.error(
      `\n  ${config.database} already contains ${tableCount} tables but has no migration record.\n`
      + '  Refusing to apply the schema over an existing database.\n\n'
      + '  If this database is genuinely empty of application data, drop its tables\n'
      + '  and run this again. If it is not, point DB_NAME at a new database.\n');
    process.exit(1);
  }

  if (check) {
    console.log(`  Not applied. ${tableCount} table(s) present; the schema would create the rest.`);
    process.exit(0);
  }

  console.log(`  Applying database/mysql-schema.sql to ${config.database}@${config.host} …`);
  await conn.query(readFileSync(SCHEMA, 'utf8'));
  await conn.query('INSERT INTO schema_migrations (name, applied_at) VALUES (?, NOW())',
    ['mysql-schema.sql']);

  const [after] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?',
    [config.database]);
  console.log(`  Done. ${Number(after[0]?.n ?? 0)} tables.`);
} catch (err) {
  console.error(`\n  Migration failed: ${err.message}\n`);
  process.exit(1);
} finally {
  await conn.end();
}
