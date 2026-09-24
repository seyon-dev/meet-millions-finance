/**
 * SQLite → MySQL translation.
 *
 * The case that brought a deployment down: `key` is an ordinary identifier in
 * SQLite and a reserved word in MySQL. The schema generator quoted it in the
 * DDL, so the column existed; nothing quoted it in a *query*, so every
 * statement reading one went out as `... AND key = ?` and MySQL answered 1064.
 *
 * The whole test suite runs on SQLite, which accepts that SQL happily — so no
 * test could see it. These assert on the translated string instead, which is
 * exactly what the MySQL server receives.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toMysql, quoteReservedIdentifiers, RESERVED, SCHEMA_RESERVED } from '../src/db/dialect.js';

describe('reserved identifiers', () => {
  test('quotes the statement GET /ready runs, which used to be a 1064', () => {
    // Verbatim from ensureBootstrapped in src/services/bootstrap.js.
    const sql = "SELECT value_json FROM settings WHERE tenant_id IS NULL "
      + "AND namespace = 'platform' AND key = 'bootstrap_version'";
    assert.match(toMysql(sql), /AND `key` = 'bootstrap_version'/);
  });

  test('quotes a column list built by the Db helpers', () => {
    const sql = 'INSERT INTO permissions (key, resource, action) VALUES (?, ?, ?)';
    assert.match(toMysql(sql), /\(`key`, resource, action\)/);
  });

  test('quotes `trigger` too', () => {
    assert.match(toMysql('SELECT * FROM automations WHERE trigger = ?'), /WHERE `trigger` = \?/);
  });

  test('leaves a string literal that happens to read like one alone', () => {
    const out = toMysql("SELECT * FROM settings WHERE namespace = 'key' AND key = ?");
    assert.match(out, /namespace = 'key'/, 'the value is not an identifier');
    assert.match(out, /AND `key` = \?/, 'the column is');
  });

  test('does not double-quote one that is already quoted', () => {
    assert.equal(toMysql('SELECT `key` FROM plans'), 'SELECT `key` FROM plans');
  });

  test('converts a double-quoted identifier rather than quoting it twice', () => {
    assert.equal(toMysql('SELECT "key" FROM plans'), 'SELECT `key` FROM plans');
  });

  test('leaves KEY alone where it is syntax, not a column', () => {
    // toMysql builds this itself from ON CONFLICT; quoting it would be a
    // syntax error, which is why the quoting runs before that rewrite.
    const sql = 'INSERT INTO plans (key, name) VALUES (?, ?) '
      + 'ON CONFLICT (key) DO UPDATE SET name = excluded.name';
    const out = toMysql(sql);
    assert.match(out, /ON DUPLICATE KEY UPDATE/, 'the clause survives intact');
    assert.doesNotMatch(out, /ON DUPLICATE `KEY`/, 'and KEY there is not an identifier');
    assert.match(out, /\(`key`, name\)/, 'while the column still gets quoted');
  });

  test('leaves a word inside a comment alone', () => {
    const out = quoteReservedIdentifiers('SELECT id FROM plans -- the key column\n');
    assert.match(out, /-- the key column/);
  });

  test('a qualified column is still quoted', () => {
    assert.match(toMysql('SELECT p.key FROM plans p'), /p\.`key`/);
  });

  test('quotes nothing that is not reserved', () => {
    const sql = 'SELECT id, name, tenant_id FROM clients WHERE status = ?';
    assert.equal(toMysql(sql), sql);
  });
});

describe('SCHEMA_RESERVED tracks the schema', () => {
  /**
   * The guard against the next one.
   *
   * SCHEMA_RESERVED is a short list because only two of this schema's columns
   * are reserved words. Add a column called `rank`, `system` or `groups` and
   * the generator will quote it in the DDL while queries against it go out
   * bare — the same failure, on a different column. This reads the generated
   * schema and fails here rather than on a server nobody can reproduce.
   */
  test('every reserved identifier in mysql-schema.sql is in the set', () => {
    const schema = readFileSync('database/mysql-schema.sql', 'utf8');

    const quoted = new Set();
    for (const m of schema.matchAll(/`([a-zA-Z_]\w*)`/g)) quoted.add(m[1].toLowerCase());

    const reservedInSchema = [...quoted].filter(name => RESERVED.has(name)).sort();
    const missing = reservedInSchema.filter(name => !SCHEMA_RESERVED.has(name));

    assert.deepEqual(missing, [],
      `add these to SCHEMA_RESERVED in src/db/dialect.js, or queries against them will fail on MySQL: ${missing.join(', ')}`);
  });

  test('the set carries nothing the schema does not use', () => {
    const schema = readFileSync('database/mysql-schema.sql', 'utf8');
    for (const name of SCHEMA_RESERVED) {
      assert.ok(schema.includes(`\`${name}\``),
        `${name} is in SCHEMA_RESERVED but no column in the schema is called that`);
    }
  });
});

describe('SQLite constructs MySQL has no equivalent for', () => {
  test('PRAGMA table_info becomes an information_schema query', () => {
    const out = toMysql('PRAGMA table_info(branches)');
    assert.doesNotMatch(out, /PRAGMA/i, 'MySQL has no PRAGMA at all');
    assert.match(out, /information_schema\.columns/i);
    assert.match(out, /table_name = 'branches'/);
  });

  test('it keeps the column alias the caller reads', () => {
    // Db.columnsOf reads row.name, which is what SQLite's PRAGMA returns.
    assert.match(toMysql('PRAGMA table_info(users)'), /column_name AS name/i);
  });

  test('it scopes to the current database, not every schema on the server', () => {
    assert.match(toMysql('PRAGMA table_info(users)'), /table_schema = DATABASE\(\)/i);
  });

  test('a backquoted table name works too', () => {
    assert.match(toMysql('PRAGMA table_info(`users`)'), /table_name = 'users'/);
  });
});
