import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { planMigration } from '../src/db/migration-plan.js';
import { parseExpectedSchema, compareSchema, describeDifferences } from '../src/db/schema-verify.js';

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

  test('a database with tables and no record is never written over', () => {
    // It used to be refused outright as "database_not_empty". That made the
    // documented phpMyAdmin-first workflow impossible, so it is now refused
    // only until the schema has been verified — see the adoption tests below.
    // What has not changed, and must not: the baseline DDL is never run over
    // a database that already has tables.
    const p = plan({ applied: new Set(), tableCount: 40 });
    assert.equal(p.action, 'refuse');
    assert.equal(p.reason, 'unverified_existing_schema');
    assert.equal(p.applyBaseline, false, 'nothing is applied');
    assert.equal(p.safe, false);
  });

  test('schema_migrations alone does not count as an existing database', () => {
    // The runner subtracts it before asking; this is the boundary that matters.
    const p = plan({ applied: new Set(), tableCount: 0 });
    assert.equal(p.action, 'apply');
  });

  // -- Adopting a database that was imported by hand ------------------------
  //
  // The supported workflow on managed hosting with no shell: create an empty
  // database, import database/mysql-schema.sql through phpMyAdmin, start the
  // application. The schema is then correct and complete with nothing to say
  // so. Adoption writes that record without re-running any DDL — but only
  // after establishing that the database really is the baseline.

  const schemaOf = (tables) => new Map(tables.map(([name, columns, indexes]) =>
    [name, { columns: new Set(columns), indexes: new Set(indexes ?? []) }]));

  const EXPECTED = schemaOf([
    ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
    ['documents', ['id', 'tenant_id', 'title'], ['idx_documents_tenant']],
  ]);

  // B — imported, no record, matches
  test('B: an imported database that matches the baseline is adopted, not re-run', () => {
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
      ['documents', ['id', 'tenant_id', 'title'], ['idx_documents_tenant']],
      ['schema_migrations', ['name', 'applied_at'], []],
    ]));
    assert.equal(verification.matches, true, verification.summary);

    const p = plan({ tableCount: 116, verification });
    assert.equal(p.action, 'adopt');
    assert.equal(p.applyBaseline, false, 'the DDL must not run again');
    assert.deepEqual(p.record, [BASE, '0001_a.sql', '0002_b.sql'],
      'the baseline and every migration in it are recorded');
    assert.equal(p.safe, true);
  });

  // C — imported, already recorded
  test('C: a database that has already been adopted changes nothing', () => {
    const p = plan({ applied: new Set([BASE, ...covered]), tableCount: 116 });
    assert.equal(p.action, 'up_to_date');
    assert.deepEqual(p.pending, []);
  });

  // D — partial import
  test('D: a partially imported database resumes the baseline', () => {
    // A clean subset — tables missing, everything present matching, nothing
    // extra — is our own import that died partway. It used to refuse, which
    // left a crashed import with no way forward but hand surgery; it resumes
    // now, because statement-level tolerances make re-applying safe.
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
      // documents never made it
    ]));
    assert.equal(verification.matches, false);
    assert.deepEqual(verification.missingTables, ['documents']);

    const p = plan({ tableCount: 1, verification });
    assert.equal(p.action, 'resume_baseline');
    assert.equal(p.applyBaseline, true);
    assert.equal(p.safe, true);
  });

  // E — genuine divergence
  test('E: a table with the wrong columns is named, and blocks adoption', () => {
    // Divergence in what EXISTS is a different database, never resumed over.
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'display_name'], ['idx_clients_tenant']],   // tenant_id missing
      ['documents', ['id', 'tenant_id', 'client_id'], ['idx_docs_tenant']],
    ]));
    assert.ok(verification.missingColumns.includes('clients.tenant_id'));
    assert.match(describeDifferences(verification), /tenant_id/);
    assert.equal(plan({ tableCount: 100, verification }).action, 'refuse');
  });

  // F — missing index
  test('F: a missing index is named, and blocks adoption', () => {
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
      ['documents', ['id', 'tenant_id', 'title'], []],   // index absent
    ]));
    assert.equal(verification.matches, false);
    assert.deepEqual(verification.missingIndexes, ['documents.idx_documents_tenant']);
    assert.deepEqual(verification.missingTables, [], 'the table itself is fine');
    assert.equal(plan({ tableCount: 116, verification }).action, 'refuse');
  });

  // G — incompatible: a column is absent
  test('G: a missing column blocks adoption even when every table exists', () => {
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id'], ['idx_clients_tenant']],   // display_name gone
      ['documents', ['id', 'tenant_id', 'title'], ['idx_documents_tenant']],
    ]));
    assert.equal(verification.matches, false);
    assert.deepEqual(verification.missingColumns, ['clients.display_name']);
    assert.equal(plan({ tableCount: 116, verification }).action, 'refuse');
  });

  test('a database with tables that was never verified is refused, not assumed', () => {
    // The guard against the lazy version of this: table count alone proves
    // nothing, so no verification means no adoption.
    const p = plan({ tableCount: 116, verification: null });
    assert.equal(p.action, 'refuse');
    assert.equal(p.reason, 'unverified_existing_schema');
  });

  // H — a new migration after adoption
  test('H: after adoption, a later migration runs exactly once', () => {
    // Adoption records the baseline, then 0013 arrives.
    const afterAdoption = new Set([BASE, ...covered]);
    const first = plan({
      applied: afterAdoption, tableCount: 116,
      sourceMigrations: [...covered, '0013_new.sql'],
      incrementals: ['0013_new.sql'],
    });
    assert.equal(first.action, 'apply');
    assert.equal(first.applyBaseline, false, 'the baseline is never re-applied after adoption');
    assert.deepEqual(first.pending, ['0013_new.sql']);

    // And not again on the next start.
    const second = plan({
      applied: new Set([...afterAdoption, '0013_new.sql']), tableCount: 117,
      sourceMigrations: [...covered, '0013_new.sql'],
      incrementals: ['0013_new.sql'],
    });
    assert.equal(second.action, 'up_to_date');
  });

  test('adoption also applies incrementals the imported baseline predates', () => {
    // Imported from an older baseline that did not include 0013.
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
      ['documents', ['id', 'tenant_id', 'title'], ['idx_documents_tenant']],
    ]));
    const p = plan({
      tableCount: 116, verification,
      sourceMigrations: [...covered, '0013_new.sql'],
      incrementals: ['0013_new.sql'],
    });
    assert.equal(p.action, 'adopt');
    assert.deepEqual(p.pending, ['0013_new.sql'],
      'an older import still owes the migrations since');
  });

  // I — repeated startup
  test('I: restarting repeatedly after adoption does nothing each time', () => {
    const applied = new Set([BASE, ...covered]);
    for (let i = 0; i < 5; i += 1) {
      const p = plan({ applied, tableCount: 116 });
      assert.equal(p.action, 'up_to_date');
      assert.deepEqual(p.record, [], 'nothing is written on a restart');
    }
  });

  // -- Verification is real, not a table count ------------------------------

  test('the real baseline parses into the structure adoption checks against', () => {
    const expected = parseExpectedSchema(readFileSync('database/mysql-schema.sql', 'utf8'));
    assert.equal(expected.size, 116, 'every table in the baseline');

    const indexes = [...expected.values()].reduce((n, t) => n + t.indexes.size, 0);
    const columns = [...expected.values()].reduce((n, t) => n + t.columns.size, 0);
    assert.equal(indexes, 167);
    assert.ok(columns > 1500, `expected the full column set, got ${columns}`);

    // Spot-check a table whose shape this session changed, so the parser is
    // demonstrably reading real structure rather than counting CREATEs.
    const broadcasts = expected.get('broadcasts');
    assert.ok(broadcasts.columns.has('tenant_id'));
    assert.ok(broadcasts.columns.has('scheduled_at'));
    assert.ok(broadcasts.indexes.has('idx_broadcasts_tenant'));
  });

  test('a same-sized database that is not this schema is refused', () => {
    // The failure the "116 tables, therefore fine" shortcut would wave through.
    const expected = parseExpectedSchema(readFileSync('database/mysql-schema.sql', 'utf8'));
    const impostor = new Map();
    for (let i = 0; i < 116; i += 1) {
      impostor.set(`unrelated_table_${i}`, { columns: new Set(['id']), indexes: new Set() });
    }
    const verification = compareSchema(expected, impostor);
    assert.equal(verification.matches, false);
    assert.equal(verification.missingTables.length, 116);
    assert.equal(plan({ tableCount: 116, verification }).action, 'refuse');
  });

  test('extra tables are reported but do not block adoption', () => {
    const verification = compareSchema(EXPECTED, schemaOf([
      ['clients', ['id', 'tenant_id', 'display_name'], ['idx_clients_tenant']],
      ['documents', ['id', 'tenant_id', 'title'], ['idx_documents_tenant']],
      ['some_host_tool_table', ['id'], []],
    ]));
    assert.equal(verification.matches, true, 'an extra table is not a mismatch');
    assert.deepEqual(verification.extraTables, ['some_host_tool_table']);
    assert.equal(plan({ tableCount: 117, verification }).action, 'adopt');
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

  test('no index name is declared twice on the same table', () => {
    // MySQL requires an index name to be unique within its table. A duplicate
    // is #1061 at import time, part-way through, leaving a half-created
    // database that then has to be dropped by hand.
    //
    // This happened: migration 0012 rebuilds `broadcasts` — SQLite cannot
    // alter a CHECK constraint, so the table is dropped and recreated — and
    // recreates idx_broadcasts_tenant. SQLite dropped the original index with
    // the table; the generator, which flattens every migration into one file,
    // kept both and emitted them.
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const declared = [...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)\s*\(/gm)]
      .map(m => ({ name: m[1], table: m[2] }));

    assert.ok(declared.length > 100, `expected the full index set, found ${declared.length}`);

    const seen = new Map();
    const duplicates = [];
    for (const idx of declared) {
      const key = `${idx.table}.${idx.name}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) === 2) duplicates.push(key);
    }

    assert.deepEqual(duplicates, [],
      'a duplicate index name fails the import with #1061 half way through');
  });

  test('every index points at a table the schema creates', () => {
    // An index on a table that a later migration dropped is #1146, and is the
    // same oversight as the duplicate above seen from the other side.
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const tables = new Set([...sql.matchAll(/^CREATE TABLE (\w+)/gm)].map(m => m[1]));
    const orphans = [...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)\s*\(/gm)]
      .filter(m => !tables.has(m[2]))
      .map(m => `${m[1]} ON ${m[2]}`);

    assert.deepEqual(orphans, [], 'an index on a table that does not exist fails the import');
  });

  test('an index rebuilt by a later migration keeps the later definition', () => {
    // Not just "exactly once" — the surviving one must be the current shape.
    // 0005 indexed (tenant_id, status); 0012 rebuilt the table and indexed
    // (tenant_id, status, created_at). The newer one is the correct final state.
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const line = sql.split('\n').find(l => l.includes('idx_broadcasts_tenant'));
    assert.ok(line, 'the index must still exist — the fix must not have removed it');
    assert.match(line, /created_at/,
      'the surviving definition must be the one the last migration created');
  });

  test('the baseline records which migrations it covers', () => {
    const sql = readFileSync('database/mysql-schema.sql', 'utf8');
    const listed = [...sql.matchAll(/^-- COVERS: (\S+\.sql)$/gm)].map(m => m[1]);
    const onDisk = readdirSync('database/migrations').filter(f => f.endsWith('.sql')).sort();

    assert.deepEqual(listed, onDisk,
      'if these drift, a migration is either skipped or wrongly reported as pending');
  });

  test('a baseline import that died partway resumes instead of refusing', () => {
    // DDL is not transactional: a crash at table 60 of 116 leaves a strict
    // subset. That is OUR schema, unfinished — the plan applies the baseline
    // again (statement-level tolerances skip what exists) and records it.
    const plan = planMigration({
      applied: new Set(),
      tableCount: 60,
      covered: ['0001_a.sql'],
      sourceMigrations: ['0001_a.sql'],
      incrementals: ['0013_x.sql'],
      baselineName: 'mysql-schema.sql',
      verification: {
        matches: false,
        missingTables: ['leads', 'calls'], missingColumns: [], missingIndexes: ['users.idx_x'],
        extraTables: [],
      },
    });
    assert.equal(plan.action, 'resume_baseline');
    assert.equal(plan.applyBaseline, true);
    assert.deepEqual(plan.pending, ['0013_x.sql']);
  });

  test('a column that differs still refuses — that is a different database', () => {
    const plan = planMigration({
      applied: new Set(), tableCount: 60,
      covered: ['0001_a.sql'], sourceMigrations: ['0001_a.sql'], incrementals: [],
      baselineName: 'mysql-schema.sql',
      verification: { matches: false, missingTables: ['leads'],
        missingColumns: ['users.email'], missingIndexes: [], extraTables: [] },
    });
    assert.equal(plan.action, 'refuse');
  });

  test('an extra table still refuses — nothing of ours is quietly adopted around it', () => {
    const plan = planMigration({
      applied: new Set(), tableCount: 60,
      covered: ['0001_a.sql'], sourceMigrations: ['0001_a.sql'], incrementals: [],
      baselineName: 'mysql-schema.sql',
      verification: { matches: false, missingTables: ['leads'],
        missingColumns: [], missingIndexes: [], extraTables: ['wp_posts'] },
    });
    assert.equal(plan.action, 'refuse');
  });

  test('every incremental file has a source migration behind it', () => {
    if (!existsSync('database/mysql')) return;
    const incrementals = readdirSync('database/mysql').filter(f => f.endsWith('.sql'));
    const sources = readdirSync('database/migrations').filter(f => f.endsWith('.sql'));

    for (const file of incrementals) {
      if (sources.some(s => s.slice(0, 4) === file.slice(0, 4))) continue;

      // One narrow exception: a migration that repairs the SQLite → MySQL
      // translation rather than changing the schema. The SQLite side was
      // already correct, so there is nothing to mirror there — the whole
      // point is that the two had diverged. It has to say so, and say why, so
      // the exception cannot be used to smuggle in a real schema change that
      // the test suite would then never exercise.
      const sql = readFileSync(join('database/mysql', file), 'utf8');
      const declared = /^--\s*TRANSLATION-ONLY:\s*(.+)$/m.exec(sql);

      assert.ok(declared,
        `${file} has no matching migration in database/migrations — the tests run `
        + 'against those, so SQL that exists only here is never exercised. If it repairs '
        + 'the translation rather than the schema, say so with a `-- TRANSLATION-ONLY: <why>` line.');
      assert.ok(declared[1].trim().length >= 20,
        `${file} declares TRANSLATION-ONLY but does not say why`);
    }
  });

  test('a translation-only migration changes no table the SQLite schema does not already have', () => {
    if (!existsSync('database/mysql')) return;
    const sourceSql = readdirSync('database/migrations').filter(f => f.endsWith('.sql')).sort()
      .map(f => readFileSync(join('database/migrations', f), 'utf8')).join('\n');
    const sourceTables = new Set(
      [...sourceSql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+[`"]?(\w+)[`"]?/gi)]
        .map(m => m[1].toLowerCase()));

    for (const file of readdirSync('database/mysql').filter(f => f.endsWith('.sql'))) {
      const sql = readFileSync(join('database/mysql', file), 'utf8');
      if (!/^--\s*TRANSLATION-ONLY:/m.test(sql)) continue;

      // It may only touch tables SQLite already defines. A new table here
      // would be a schema change wearing the exception's clothes.
      for (const m of sql.matchAll(/(?:ALTER TABLE|CREATE(?: UNIQUE)? INDEX\s+\S+\s+ON|DROP INDEX\s+\S+\s+ON)\s+[`"]?(\w+)[`"]?/gi)) {
        assert.ok(sourceTables.has(m[1].toLowerCase()),
          `${file} touches ${m[1]}, which database/migrations never creates`);
      }
      assert.doesNotMatch(sql, /CREATE TABLE/i,
        `${file} is declared TRANSLATION-ONLY but creates a table`);
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
