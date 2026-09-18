import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { planMigration } from '../src/db/migration-plan.js';

/**
 * What a migration run decides to do.
 *
 * These exist because the branches that matter are the ones that refuse, and
 * a refusal discovered for the first time against a live production database
 * during a deployment is the worst place to find it.
 *
 * The plan is pure, so every case below is exercised without a MySQL server.
 * What it cannot prove is that MySQL accepts the SQL — see the final tests,
 * which check the schema is at least constructive and self-consistent.
 */
describe('Migration planning', () => {
  const BASE = 'mysql-schema.sql';
  const covered = ['0001_a.sql', '0002_b.sql'];

  const plan = (over = {}) => planMigration({
    applied: new Set(),
    tableCount: 0,
    covered,
    sourceMigrations: [...covered],
    incrementals: [],
    baselineName: BASE,
    ...over,
  });

  // -- Fresh database -------------------------------------------------------

  test('an empty database gets the baseline, and every migration in it recorded', () => {
    const p = plan();
    assert.equal(p.action, 'apply');
    assert.equal(p.applyBaseline, true);
    assert.deepEqual(p.record, [BASE, '0001_a.sql', '0002_b.sql'],
      'the baseline stands in for what it contains, or a later run cannot tell what is present');
    assert.equal(p.safe, true);
  });

  // -- Idempotence ----------------------------------------------------------

  test('running again changes nothing', () => {
    const applied = new Set([BASE, ...covered]);
    const p = plan({ applied, tableCount: 116 });
    assert.equal(p.action, 'up_to_date');
    assert.equal(p.applyBaseline, false);
    assert.deepEqual(p.pending, []);
  });

  test('a third and fourth run are equally quiet', () => {
    const applied = new Set([BASE, ...covered]);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(plan({ applied, tableCount: 116 }).action, 'up_to_date');
    }
  });

  // -- Incremental ----------------------------------------------------------

  test('only migrations not yet applied are run', () => {
    const p = plan({
      applied: new Set([BASE, ...covered, '0013_first.sql']),
      tableCount: 117,
      sourceMigrations: [...covered, '0013_first.sql', '0014_second.sql'],
      incrementals: ['0013_first.sql', '0014_second.sql'],
    });
    assert.equal(p.action, 'apply');
    assert.equal(p.applyBaseline, false, 'the baseline is never re-applied');
    assert.deepEqual(p.pending, ['0014_second.sql'], 'only the one that has not run');
  });

  test('incrementals are applied in filename order', () => {
    const p = plan({
      applied: new Set([BASE, ...covered]),
      tableCount: 116,
      sourceMigrations: [...covered, '0015_c.sql', '0013_a.sql', '0014_b.sql'],
      incrementals: ['0015_c.sql', '0013_a.sql', '0014_b.sql'].sort(),
    });
    assert.deepEqual(p.pending, ['0013_a.sql', '0014_b.sql', '0015_c.sql']);
  });

  // -- The failure the first implementation could not see -------------------

  test('a migration with no route to an existing database is refused, not skipped', () => {
    // Somebody adds database/migrations/0013_*.sql and regenerates nothing.
    // The old implementation recorded only one name, found it applied, and
    // exited 0 — so the table was never created and the application failed
    // against a schema that looked applied.
    const p = plan({
      applied: new Set([BASE, ...covered]),
      tableCount: 116,
      sourceMigrations: [...covered, '0013_new_table.sql'],
      incrementals: [],
    });
    assert.equal(p.action, 'refuse');
    assert.equal(p.reason, 'migrations_without_a_route');
    assert.deepEqual(p.unhandled, ['0013_new_table.sql']);
    assert.equal(p.safe, false);
  });

  test('the same migration is accepted once it has an incremental file', () => {
    const p = plan({
      applied: new Set([BASE, ...covered]),
      tableCount: 116,
      sourceMigrations: [...covered, '0013_new_table.sql'],
      incrementals: ['0013_new_table.sql'],
    });
    assert.equal(p.action, 'apply');
    assert.deepEqual(p.pending, ['0013_new_table.sql']);
  });

  test('a fresh database is not blocked by a migration the baseline will carry', () => {
    // Nothing applied yet: the baseline is about to bring everything, so an
    // uncovered migration is not a problem to report.
    const p = plan({
      applied: new Set(),
      tableCount: 0,
      sourceMigrations: [...covered, '0013_new.sql'],
      incrementals: [],
    });
    assert.equal(p.action, 'apply');
    assert.equal(p.applyBaseline, true);
  });

  // -- Not writing over somebody's data -------------------------------------

  test('a database with tables but no record is refused', () => {
    const p = plan({ applied: new Set(), tableCount: 40 });
    assert.equal(p.action, 'refuse');
    assert.equal(p.reason, 'database_not_empty');
    assert.equal(p.applyBaseline, false, 'nothing is applied');
    assert.equal(p.safe, false);
  });

  test('schema_migrations alone does not count as an existing database', () => {
    // The runner subtracts it before asking; this is the boundary that matters.
    const p = plan({ applied: new Set(), tableCount: 0 });
    assert.equal(p.action, 'apply');
  });

  // -- The schema itself ----------------------------------------------------

  test('the baseline is constructive only — nothing it runs destroys data', () => {
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const statements = sql.split(/;\s*\n/)
      .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
      .filter(Boolean);

    const destructive = statements.filter(s =>
      /^\s*(DROP|TRUNCATE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE\s+\S+\s+DROP)\b/i.test(s));

    assert.deepEqual(destructive, [],
      'a migration that can run unattended during a deploy must never destroy anything');

    const kinds = new Set(statements.map(s => s.split(/\s+/).slice(0, 2).join(' ').toUpperCase()));
    for (const kind of kinds) {
      assert.match(kind, /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE|SET FOREIGN_KEY_CHECKS|SET NAMES)$/,
        `unexpected statement kind in the baseline: ${kind}`);
    }
  });

  test('the baseline records which migrations it covers', () => {
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const listed = [...sql.matchAll(/^-- COVERS: (\S+\.sql)$/gm)].map(m => m[1]);
    const onDisk = readdirSync('database/migrations').filter(f => f.endsWith('.sql')).sort();

    assert.deepEqual(listed, onDisk,
      'if these drift, a migration is either skipped or wrongly reported as pending');
  });

  test('every incremental file has a source migration behind it', () => {
    if (!existsSync('database/mysql')) return;
    const incrementals = readdirSync('database/mysql').filter(f => f.endsWith('.sql'));
    const sources = readdirSync('database/migrations').filter(f => f.endsWith('.sql'));
    for (const file of incrementals) {
      assert.ok(sources.some(s => s.slice(0, 4) === file.slice(0, 4)),
        `${file} has no matching migration in database/migrations — the tests run `
        + 'against those, so SQL that exists only here is never exercised');
    }
  });

  test('incremental migrations are additive only', () => {
    if (!existsSync('database/mysql')) return;
    for (const file of readdirSync('database/mysql').filter(f => f.endsWith('.sql'))) {
      const sql = readFileSync(join('database/mysql', file), 'utf8');
      assert.doesNotMatch(sql, /^\s*(DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/im,
        `${file} destroys data; migrations run unattended during a deploy`);
    }
  });
});
