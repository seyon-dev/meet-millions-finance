/**
 * Resumable incremental migrations.
 *
 * MySQL has no transactional DDL: a file that dies halfway leaves whatever it
 * already did, and the runner only records a file after the whole thing
 * succeeds. Before this, the retry re-ran the file from the top, the first
 * statement failed on its own earlier success, and the database was stuck
 * between two recorded states with no way forward but hand surgery.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { splitSqlStatements, statementAlreadyApplied } from '../scripts/migrate-runner.mjs';

describe('splitSqlStatements', () => {
  test('splits on semicolons and drops comments', () => {
    const parts = splitSqlStatements(`
      -- restore the defaults
      ALTER TABLE a MODIFY COLUMN x VARCHAR(255) NOT NULL DEFAULT 'p';
      DROP INDEX i ON a;
    `);
    assert.equal(parts.length, 2);
    assert.match(parts[0], /^ALTER TABLE a/);
    assert.match(parts[1], /^DROP INDEX i/);
  });

  test('a semicolon inside a literal does not split', () => {
    const parts = splitSqlStatements("UPDATE t SET note = 'a;b' WHERE id = 1;");
    assert.equal(parts.length, 1);
    assert.match(parts[0], /'a;b'/);
  });

  test('a doubled quote stays inside its literal', () => {
    const parts = splitSqlStatements("INSERT INTO t (n) VALUES ('it''s;fine'); DELETE FROM t;");
    assert.equal(parts.length, 2);
  });
});

describe('statementAlreadyApplied', () => {
  const err = (errno) => ({ errno });

  test('duplicate column on an ADD means the ADD already ran', () => {
    assert.equal(statementAlreadyApplied(err(1060), 'ALTER TABLE t ADD COLUMN x INT'), true);
  });

  test('duplicate key on a CREATE INDEX means the index exists', () => {
    assert.equal(statementAlreadyApplied(err(1061), 'CREATE UNIQUE INDEX i ON t (a)'), true);
  });

  test('cannot-drop on a DROP means the drop already ran', () => {
    assert.equal(statementAlreadyApplied(err(1091), 'DROP INDEX i ON t'), true);
    assert.equal(statementAlreadyApplied(err(1091), 'ALTER TABLE t DROP COLUMN c'), true);
  });

  test('an existing table on a CREATE TABLE means the create already ran', () => {
    assert.equal(statementAlreadyApplied(err(1050), "CREATE TABLE users (id VARCHAR(64))"), true);
    assert.equal(statementAlreadyApplied(err(1050), 'DROP TABLE users'), false,
      'the tolerance is for re-running a create, never for a drop');
  });

  test('the same errors on other statement shapes stay fatal', () => {
    assert.equal(statementAlreadyApplied(err(1060), 'CREATE UNIQUE INDEX i ON t (a)'), false);
    assert.equal(statementAlreadyApplied(err(1091), 'CREATE UNIQUE INDEX i ON t (a)'), false);
  });

  test('a genuine failure is never tolerated', () => {
    assert.equal(statementAlreadyApplied(err(1064), 'ALTER TABLE t ADD COLUMN x INT'), false);
    assert.equal(statementAlreadyApplied(err(1054), 'ALTER TABLE t RENAME COLUMN a TO b'), false,
      'a RENAME re-run is only skipped after the information_schema probe, not on errno alone');
  });
});
