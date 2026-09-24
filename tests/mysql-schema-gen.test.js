/**
 * The generated MySQL schema against its SQLite source.
 *
 * Two defects shipped here, and neither could be caught by running the
 * application: the test suite uses SQLite, where both were correct. They were
 * only ever visible in the *translation*, so that is what these read.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const generated = readFileSync('database/mysql-schema.sql', 'utf8');
const source = readdirSync('database/migrations').filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join('database/migrations', f), 'utf8')).join('\n');

/** Column definitions from a CREATE TABLE body, comments stripped first. */
function columnsOf(sql) {
  const out = new Map();
  const re = /CREATE TABLE(?: IF NOT EXISTS)?\s+[`"]?(\w+)[`"]?\s*\(([\s\S]*?)\n\)\s*(?:ENGINE|;)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const body = m[2].split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    let depth = 0, buf = '', parts = [];
    for (const ch of body) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
      buf += ch;
    }
    parts.push(buf);
    for (const raw of parts) {
      const def = raw.trim().replace(/\s+/g, ' ');
      if (!def || /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX)\b/i.test(def)) continue;
      const cm = /^[`"]?(\w+)[`"]?\s+(.*)$/.exec(def);
      if (cm) out.set(`${m[1]}.${cm[1]}`, cm[2]);
    }
  }
  return out;
}

describe('column defaults survive the translation', () => {
  /**
   * MySQL cannot put a DEFAULT on a TEXT column, and the generator used to
   * drop the default rather than widen the type. That left 115 NOT NULL
   * columns with no default, and under STRICT_TRANS_TABLES every insert
   * relying on one failed with "Field 'x' doesn't have a default value".
   * Registration was the first thing anybody hit.
   */
  test('every NOT NULL DEFAULT in the source is present in the generated schema', () => {
    const src = columnsOf(source);
    const gen = columnsOf(generated);
    const lost = [];

    for (const [key, def] of src) {
      if (!/\bNOT NULL\b/i.test(def)) continue;
      const d = /\bDEFAULT\s+('(?:[^']*)'|\S+)/i.exec(def);
      if (!d) continue;
      const out = gen.get(key);
      if (out === undefined) continue;              // renamed or dropped elsewhere
      if (!/\bDEFAULT\b/i.test(out)) lost.push(`${key} lost ${d[0].trim()}`);
    }

    assert.deepEqual(lost, [],
      'a NOT NULL column with no default rejects every insert that does not name it');
  });

  test('no generated column is TEXT and carrying a default, which MySQL forbids', () => {
    for (const [key, def] of columnsOf(generated)) {
      if (/^TEXT\b/i.test(def)) {
        assert.doesNotMatch(def, /\bDEFAULT\b/i, `${key} is TEXT with a DEFAULT, which MySQL rejects`);
      }
    }
  });
});

describe('partial unique indexes keep their meaning', () => {
  /**
   * `CREATE UNIQUE INDEX ... WHERE col IS NOT NULL` means "unique among the
   * rows that have one". The generator mapped every NULL to a sentinel so a
   * single index could cover a NULL/NOT NULL pair — right for the tenant_id
   * pairs it was written for, wrong for a lone predicate, because it made all
   * the NULL rows collide. A second payment with no idempotency key was
   * rejected; so was a second call with no provider id.
   *
   * MySQL does not collide on NULL, so a lone predicate needs no sentinel.
   */
  const sentinelColumns = new Set(
    [...generated.matchAll(/^\s*(\w+)_k\s+VARCHAR\(\d+\)\s+AS\s*\(IFNULL\((\w+),/gim)]
      .map(m => m[2].toLowerCase()));

  const lonePredicates = (() => {
    const rows = [...source.matchAll(
      /CREATE\s+UNIQUE\s+INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)\s*WHERE\s+(\w+)\s+IS\s+(NOT\s+)?NULL\s*;/gi)]
      .map(m => ({ name: m[1], table: m[2], guard: m[4], negated: !!m[5],
        cols: m[3].split(',').map(s => s.trim()) }));

    const groups = new Map();
    for (const r of rows) {
      const key = `${r.table}|${r.guard}|${r.cols.filter(c => c !== r.guard).join(',')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.values()]
      .filter(g => g.some(r => r.negated) && !g.some(r => !r.negated))
      .flat();
  })();

  test('there are lone IS NOT NULL predicates to get right', () => {
    assert.ok(lonePredicates.length > 0, 'if this is zero the test below proves nothing');
  });

  test('a lone IS NOT NULL predicate gets no sentinel column', () => {
    for (const idx of lonePredicates) {
      assert.equal(sentinelColumns.has(idx.guard.toLowerCase()), false,
        `${idx.table}.${idx.guard} has a sentinel: every row with NULL there would collide, `
        + 'which is stricter than the SQLite index it came from');
    }
  });

  test('its unique index survives, over the original columns', () => {
    // Every CREATE INDEX in the generated file, by name.
    const byName = new Map(
      [...generated.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+`?(\w+)`?\s+ON\s+`?(\w+)`?\s*\(([^)]*)\)/gi)]
        .map(m => [m[2], { unique: !!m[1], table: m[3], cols: m[4] }]));

    for (const idx of lonePredicates) {
      const got = byName.get(idx.name);
      assert.ok(got, `${idx.name} is missing from the generated schema`);
      assert.ok(got.unique, `${idx.name} must stay UNIQUE — that is the whole point of it`);
      assert.ok(got.cols.includes(idx.guard),
        `${idx.name} must still cover ${idx.guard}, got (${got.cols})`);
      assert.ok(!got.cols.includes(`${idx.guard}_k`),
        `${idx.name} still uses the sentinel column`);
    }
  });
});

describe('ALTER statements survive the translation', () => {
  /**
   * Migration 0010 renames oauth_states.state to state_hash. The generator
   * recognised ADD COLUMN and RENAME TO (table) and silently dropped every
   * other ALTER — so the baseline kept the old column name and every OAuth
   * query, which reads state_hash, failed with "Unknown column". The
   * generator now throws on an ALTER it does not understand; this pins the
   * outcome for the one that already burned us.
   */
  test('the oauth_states rename is reflected in the baseline', () => {
    const body = /CREATE TABLE oauth_states \(([\s\S]*?)\) ENGINE/.exec(generated);
    assert.ok(body, 'oauth_states missing');
    assert.match(body[1], /\bstate_hash\b/, 'the renamed column is present');
    assert.doesNotMatch(body[1], /\bstate\s+(TEXT|VARCHAR)/, 'the old name is gone');
  });

  test('every column the runtime queries by name exists in the baseline', () => {
    // The two the drift actually hit; cheap to keep as canaries.
    for (const [table, col] of [['oauth_states', 'state_hash'], ['user_permissions', 'reason'],
                                 ['chat_threads', 'bot_flow_id']]) {
      const body = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\) ENGINE`).exec(generated);
      assert.ok(body, `${table} missing`);
      assert.match(body[1], new RegExp(`\\b${col}\\b`), `${table}.${col} missing from the baseline`);
    }
  });
});
