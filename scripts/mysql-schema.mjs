/**
 * Generate the MySQL schema from the SQLite migrations.
 *
 * The migrations remain the single source of truth: the test suite builds a
 * real SQLite database from them, so they are the schema the queries are
 * proven against. This derives the MySQL form rather than maintaining a second
 * hand-written copy that would drift on the first migration nobody mirrored.
 *
 *   node scripts/mysql-schema.mjs            # write database/mysql-schema.sql
 *   node scripts/mysql-schema.mjs --check    # is it current?
 *
 * What has to change, and why:
 *
 *   TEXT PRIMARY KEY (112 of them)
 *     MySQL cannot index an unbounded TEXT. Every id in this system is a
 *     prefixed ULID of about 30 characters, so keys and anything they
 *     reference become VARCHAR(64). A foreign key whose type does not match
 *     its target exactly is rejected, so the widths are derived, not guessed.
 *
 *   Partial unique indexes (16 of them)
 *     `UNIQUE (tenant_id, key) WHERE tenant_id IS NOT NULL` has no MySQL
 *     equivalent. They all encode the same rule: unique per tenant, and
 *     separately unique among platform-level rows where tenant_id is NULL.
 *     MySQL treats NULLs as distinct in a unique index, which would let two
 *     platform rows share a key — silently breaking the platform catalogue.
 *     So each pair collapses onto a STORED generated column that maps NULL to
 *     a sentinel, and one unique index over it. Same rule, enforced by the
 *     database rather than by hope.
 *
 *   Reserved words
 *     `key`, `value`, `status` and friends are reserved in MySQL and are
 *     back-quoted throughout.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mysqlType, mysqlIdent, RESERVED } from '../src/db/dialect.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const SOURCE = join(root, 'database/migrations');
const TARGET = join(root, 'database/mysql-schema.sql');

/** Strip comments so the parser sees only statements. */
function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Split on semicolons that are not inside quotes or parentheses. */
function statements(sql) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ';' && depth === 0) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ---------------------------------------------------------------------------
// Pass 1 — read every table so column widths can be derived before writing
// ---------------------------------------------------------------------------

const tables = new Map();   // name -> { columns: Map, tableConstraints: [], order }
const indexes = [];         // { name, table, columns, unique, where }
const alters = [];          // ALTER TABLE ... ADD COLUMN
const renames = [];         // ALTER TABLE ... RENAME TO
const drops = [];           // DROP TABLE

let order = 0;

function parseCreateTable(stmt) {
  const m = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?)(\w+)\1\s*\(([\s\S]*)\)\s*$/i.exec(stmt);
  if (!m) return null;
  const name = m[2];
  const body = m[3];

  const columns = new Map();
  const constraints = [];

  for (const part of splitTop(body)) {
    const line = part.trim();
    if (!line) continue;
    if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(line)) {
      constraints.push(line);
      continue;
    }
    const cm = /^([`"]?)(\w+)\1\s+([A-Za-z]+)([\s\S]*)$/.exec(line);
    if (!cm) { constraints.push(line); continue; }
    columns.set(cm[2], { name: cm[2], type: cm[3], rest: cm[4].trim() });
  }

  return { name, columns, constraints, order: order++ };
}

/** Split a CREATE TABLE body on top-level commas. */
function splitTop(body) {
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (const ch of body) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; buf += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

const files = readdirSync(SOURCE).filter(f => f.endsWith('.sql')).sort();

for (const file of files) {
  const sql = stripComments(readFileSync(join(SOURCE, file), 'utf8'));
  for (const stmt of statements(sql)) {
    if (/^PRAGMA\b/i.test(stmt)) continue;

    if (/^CREATE\s+TABLE\b/i.test(stmt)) {
      const t = parseCreateTable(stmt);
      if (t) tables.set(t.name, t);
      continue;
    }

    if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(stmt)) {
      const m = /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"]?)(\w+)\2\s+ON\s+([`"]?)(\w+)\4\s*\(([^)]*)\)\s*(?:WHERE\s+([\s\S]+))?$/i.exec(stmt);
      if (m) {
        indexes.push({
          unique: !!m[1], name: m[3], table: m[5],
          columns: m[6].split(',').map(s => s.trim()),
          where: m[7]?.trim() ?? null,
        });
      }
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(stmt)) {
      const add = /ALTER\s+TABLE\s+([`"]?)(\w+)\1\s+ADD\s+COLUMN\s+([`"]?)(\w+)\3\s+([A-Za-z]+)([\s\S]*)$/i.exec(stmt);
      if (add) {
        const t = tables.get(add[2]);
        if (t) t.columns.set(add[4], { name: add[4], type: add[5], rest: add[6].trim() });
        continue;
      }
      const ren = /ALTER\s+TABLE\s+([`"]?)(\w+)\1\s+RENAME\s+TO\s+([`"]?)(\w+)\3/i.exec(stmt);
      if (ren) {
        const from = tables.get(ren[2]);
        if (from) { tables.delete(ren[2]); from.name = ren[4]; tables.set(ren[4], from); }
        // An index follows its table across a rename, so any already declared
        // on the old name has to be retargeted or it would point at a table
        // that no longer exists.
        for (const idx of indexes) if (idx.table === ren[2]) idx.table = ren[4];
        renames.push([ren[2], ren[4]]);
      }
      continue;
    }

    if (/^DROP\s+TABLE\b/i.test(stmt)) {
      const m = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"]?)(\w+)\1/i.exec(stmt);
      if (m) {
        tables.delete(m[2]);
        // Dropping a table drops its indexes with it. Leaving them in the list
        // is how a table rebuilt by a later migration ended up with the same
        // index declared twice — SQLite never saw the first one again, but this
        // generator flattens every migration into one file and emitted both,
        // so MySQL rejected the import with
        //   #1061 Duplicate key name 'idx_broadcasts_tenant'
        for (let i = indexes.length - 1; i >= 0; i -= 1) {
          if (indexes[i].table === m[2]) indexes.splice(i, 1);
        }
        drops.push(m[2]);
      }
      continue;
    }

    // INSERT ... SELECT inside a table rebuild: the rebuilt table is what
    // survives, so the data move is irrelevant to a fresh schema.
    if (/^INSERT\b/i.test(stmt)) continue;
  }
}

// ---------------------------------------------------------------------------
// Pass 2 — decide each column's MySQL type
// ---------------------------------------------------------------------------

/** Columns that are a primary key, or referenced by one, must be VARCHAR(64). */
const keyColumns = new Set();     // "table.column"
const indexedColumns = new Set(); // "table.column"

for (const t of tables.values()) {
  for (const c of t.columns.values()) {
    if (/PRIMARY\s+KEY/i.test(c.rest)) keyColumns.add(`${t.name}.${c.name}`);
    const ref = /REFERENCES\s+([`"]?)(\w+)\1\s*(?:\(\s*([`"]?)(\w+)\3\s*\))?/i.exec(c.rest);
    if (ref) {
      keyColumns.add(`${t.name}.${c.name}`);
      keyColumns.add(`${ref[2]}.${ref[4] ?? 'id'}`);
    }
  }
  for (const con of t.constraints) {
    const fk = /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([`"]?)(\w+)\2\s*\(([^)]*)\)/i.exec(con);
    if (fk) {
      for (const c of fk[1].split(',')) keyColumns.add(`${t.name}.${c.trim().replace(/[`"]/g, '')}`);
      for (const c of fk[4].split(',')) keyColumns.add(`${fk[3]}.${c.trim().replace(/[`"]/g, '')}`);
    }
    const uq = /^UNIQUE\s*\(([^)]*)\)/i.exec(con);
    if (uq) for (const c of uq[1].split(',')) indexedColumns.add(`${t.name}.${c.trim().replace(/[`"]/g, '')}`);
    const pk = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(con);
    if (pk) for (const c of pk[1].split(',')) keyColumns.add(`${t.name}.${c.trim().replace(/[`"]/g, '')}`);
  }
}
for (const idx of indexes) {
  for (const c of idx.columns) {
    indexedColumns.add(`${idx.table}.${c.replace(/[`"]/g, '').split(/\s+/)[0]}`);
  }
}

function typeFor(table, col) {
  const qualified = `${table}.${col.name}`;
  return mysqlType(col.type, {
    primaryKey: keyColumns.has(qualified),
    indexed: indexedColumns.has(qualified),
  });
}

// ---------------------------------------------------------------------------
// Pass 3 — the partial indexes
// ---------------------------------------------------------------------------

/**
 * Pair up `WHERE tenant_id IS NULL` / `IS NOT NULL` indexes on the same table
 * and columns, and replace both with one unique index over a generated column.
 */
const generatedColumns = new Map();  // table -> [{ name, expr, source }]
const translatedIndexes = [];
const skippedIndexes = [];

for (const idx of indexes) {
  if (!idx.where) { translatedIndexes.push(idx); continue; }

  const nullable = /(\w+)\s+IS\s+NOT\s+NULL/i.exec(idx.where);
  const isNull = /(\w+)\s+IS\s+NULL/i.exec(idx.where);

  // The tenant_id NULL/NOT NULL pair.
  if (idx.unique && (nullable || isNull)) {
    const guard = (nullable?.[1] ?? isNull?.[1]);
    const rest = idx.columns.filter(c => c.replace(/[`"]/g, '') !== guard);
    const genName = `${guard}_k`;

    if (!generatedColumns.has(idx.table)) generatedColumns.set(idx.table, []);
    const existing = generatedColumns.get(idx.table);
    if (!existing.some(g => g.name === genName)) {
      existing.push({
        name: genName,
        source: guard,
        // A sentinel no real id can collide with: every id here is prefixed
        // and none begins with '~'.
        expr: `IFNULL(${mysqlIdent(guard)}, '~platform')`,
      });
    }

    const combined = [genName, ...rest.map(c => c.replace(/[`"]/g, ''))];
    const name = `${idx.table}_uq_${combined.join('_')}`.slice(0, 60);
    if (!translatedIndexes.some(t => t.name === name)) {
      translatedIndexes.push({
        unique: true, name, table: idx.table, columns: combined,
        where: null,
        note: `replaces ${idx.name} and its NULL/NOT NULL counterpart`,
      });
    }
    continue;
  }

  // Any other partial index loses only selectivity, never correctness, when
  // the predicate is dropped — unless it is UNIQUE, where dropping the
  // predicate would reject rows MySQL should accept.
  if (idx.unique) {
    skippedIndexes.push(idx);
  } else {
    translatedIndexes.push({ ...idx, where: null, note: `predicate dropped: ${idx.where}` });
  }
}

// ---------------------------------------------------------------------------
// Pass 4 — order tables so foreign keys resolve
// ---------------------------------------------------------------------------

function referencedTables(t) {
  const refs = new Set();
  for (const c of t.columns.values()) {
    const m = /REFERENCES\s+([`"]?)(\w+)\1/i.exec(c.rest);
    if (m && m[2] !== t.name) refs.add(m[2]);
  }
  for (const con of t.constraints) {
    const m = /REFERENCES\s+([`"]?)(\w+)\1/i.exec(con);
    if (m && m[2] !== t.name) refs.add(m[2]);
  }
  return refs;
}

const ordered = [];
const placed = new Set();
const pending = [...tables.values()];
let guard = 0;

while (pending.length && guard < 1000) {
  guard += 1;
  for (let i = 0; i < pending.length; i += 1) {
    const t = pending[i];
    const refs = [...referencedTables(t)].filter(r => tables.has(r));
    if (refs.every(r => placed.has(r))) {
      ordered.push(t);
      placed.add(t.name);
      pending.splice(i, 1);
      i -= 1;
    }
  }
}
// A reference cycle, if any, keeps its declaration order; MySQL is told to
// defer checks around the whole file anyway.
for (const t of pending) { ordered.push(t); placed.add(t.name); }

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------


/**
 * Back-quote this table's own column names where they are reserved words.
 *
 * Not "every reserved word": NOT, NULL, CHECK, DEFAULT and PRIMARY are all
 * reserved, and quoting those produces `PRIMARY` `KEY`, which is nonsense.
 * Telling syntax from identifier needs a grammar — but the set of names that
 * actually need quoting is already known exactly, because the columns have
 * been parsed. So only those are touched, and only outside string literals,
 * which keeps `CHECK (trigger IN ('manual'))` intact while quoting `trigger`.
 */
function quoteKnownColumns(text, columnNames) {
  const needQuoting = [...columnNames].filter(n => RESERVED.has(String(n).toLowerCase()));
  if (!needQuoting.length) return text;

  // A table with a column called `key` also contains the words PRIMARY KEY,
  // FOREIGN KEY and UNIQUE KEY. The lookbehind keeps those intact.
  const pattern = new RegExp(
    `(?<!\\b(?:primary|foreign|unique|index|fulltext|spatial)\\s)\\b(${needQuoting.join('|')})\\b`, 'gi');
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    // Skip string literals and anything already back-quoted.
    if (ch === "'" || ch === '"' || ch === '`') {
      const close = text.indexOf(ch, i + 1);
      const stop = close === -1 ? text.length : close + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    const nextQuote = text.slice(i).search(/['"`]/);
    const chunkEnd = nextQuote === -1 ? text.length : i + nextQuote;
    out += text.slice(i, chunkEnd).replace(pattern, (m) => `\`${m}\``);
    i = chunkEnd;
  }

  return out;
}

function renderColumn(table, col) {
  const type = typeFor(table, col);
  let rest = col.rest;

  // SQLite allows an inline REFERENCES on the column; MySQL accepts it too,
  // but emitting them as table-level constraints keeps the ordering explicit.
  rest = rest.replace(/\s*REFERENCES\s+[`"]?\w+[`"]?\s*(\([^)]*\))?(\s+ON\s+DELETE\s+[A-Z\s]+)?(\s+ON\s+UPDATE\s+[A-Z\s]+)?/gi, '');

  // A TEXT column cannot carry a DEFAULT in MySQL.
  if (type === 'TEXT') rest = rest.replace(/\s*DEFAULT\s+('(?:[^']*)'|\S+)/gi, '');

  // A column's own CHECK body names the column, so it needs the same quoting
  // the column definition got — `trigger TEXT CHECK (trigger IN (...))` is
  // two syntax errors, not one.
  rest = quoteKnownColumns(rest, [...tables.get(table)?.columns.keys() ?? []]);

  return `  ${mysqlIdent(col.name)} ${type}${rest ? ' ' + rest.trim() : ''}`.replace(/\s+$/, '');
}

function renderForeignKeys(t) {
  const out = [];
  for (const c of t.columns.values()) {
    const m = /REFERENCES\s+([`"]?)(\w+)\1\s*(?:\(\s*([`"]?)(\w+)\3\s*\))?((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))*)/i.exec(c.rest);
    if (!m || !tables.has(m[2])) continue;
    const actions = (m[5] ?? '').trim();
    out.push(`  FOREIGN KEY (${mysqlIdent(c.name)}) REFERENCES ${m[2]}(${mysqlIdent(m[4] ?? 'id')})${actions ? ' ' + actions.replace(/\s+/g, ' ') : ''}`);
  }
  return out;
}

const lines = [];
lines.push(`-- ---------------------------------------------------------------------------
-- Meet Millions Finance CRM — MySQL schema.
--
-- GENERATED by scripts/mysql-schema.mjs from database/migrations/*.sql.
-- Do not edit by hand: add a migration and regenerate, or the two will drift
-- and the MySQL deployment will quietly differ from what the tests prove.
--
-- ${ordered.length} tables. Import into an EMPTY database:
--
--     mysql -h <host> -u <user> -p <database> < database/mysql-schema.sql
--
-- Nothing here drops a database or a table that was not created in this file.
--
-- COVERS — the source migrations squashed into this baseline. Read by
-- scripts/migrate-mysql.mjs to know which are already present, so a migration
-- added later is recognised as pending rather than silently skipped. Machine
-- read; keep the format.
${files.map(f => `-- COVERS: ${f}`).join('\n')}
-- ---------------------------------------------------------------------------

SET FOREIGN_KEY_CHECKS = 0;
SET NAMES utf8mb4;
`);

for (const t of ordered) {
  const cols = [...t.columns.values()].map(c => renderColumn(t.name, c));

  for (const gen of generatedColumns.get(t.name) ?? []) {
    cols.push(`  -- Collapses a pair of SQLite partial unique indexes: MySQL treats\n`
      + `  -- NULLs as distinct, which would let two platform rows share a key.\n`
      + `  ${mysqlIdent(gen.name)} VARCHAR(64) AS (${gen.expr}) STORED`);
  }

  const constraints = t.constraints
    .filter(c => !/^FOREIGN\s+KEY/i.test(c))
    .map(c => `  ${quoteKnownColumns(c, [...t.columns.keys()]).trim()}`);

  const fks = renderForeignKeys(t);

  lines.push(`-- ${'-'.repeat(73)}`);
  lines.push(`CREATE TABLE ${t.name} (`);
  lines.push([...cols, ...constraints, ...fks].join(',\n'));
  lines.push(`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
  lines.push('');
}

lines.push(`-- ${'-'.repeat(73)}`);
lines.push('-- Indexes');
lines.push(`-- ${'-'.repeat(73)}`);
for (const idx of translatedIndexes) {
  if (!tables.has(idx.table)) continue;
  const cols = idx.columns.map(c => {
    const bare = c.replace(/[`"]/g, '').split(/\s+/)[0];
    const col = tables.get(idx.table)?.columns.get(bare);
    const type = col ? typeFor(idx.table, col) : 'VARCHAR(255)';
    // An index on a TEXT column needs a prefix length in MySQL.
    return type === 'TEXT' ? `${mysqlIdent(bare)}(191)` : mysqlIdent(bare);
  });
  if (idx.note) lines.push(`-- ${idx.note}`);
  lines.push(`CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${idx.name} ON ${idx.table} (${cols.join(', ')});`);
}

if (skippedIndexes.length) {
  lines.push('');
  lines.push('-- NOT TRANSLATED — these need review:');
  for (const idx of skippedIndexes) {
    lines.push(`--   ${idx.name} ON ${idx.table} (${idx.columns.join(', ')}) WHERE ${idx.where}`);
  }
}

lines.push('');
lines.push('SET FOREIGN_KEY_CHECKS = 1;');
lines.push('');

// ---------------------------------------------------------------------------
// Refuse to emit a schema MySQL will reject
//
// An index name must be unique within its table; a duplicate is #1061 at
// import time, part-way through, leaving a half-created database. That is
// exactly what a rebuilt table produced before DROP TABLE started removing its
// indexes, and it reached a real import because nothing here looked. Checking
// at the point of generation means the file on disk is always importable.
// ---------------------------------------------------------------------------
{
  const seen = new Map();          // "table.index" -> count
  const duplicates = [];
  for (const idx of translatedIndexes) {
    if (!tables.has(idx.table)) continue;
    const key = `${idx.table}.${idx.name}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) duplicates.push(key);
  }

  // A column can only be indexed once under one name too — two names for the
  // same columns is not an error, but two of the same name is.
  if (duplicates.length) {
    console.error(`\n  Refusing to write a schema MySQL would reject.\n`);
    console.error(`  ${duplicates.length} duplicate index name(s):\n`);
    for (const d of duplicates) console.error(`    ${d}`);
    console.error('\n  An index declared twice on one table is #1061 at import time.');
    console.error('  Usually this means a migration rebuilt the table and the earlier');
    console.error('  index was not removed with it.\n');
    process.exit(1);
  }

  // Every index must point at a table that still exists.
  const orphans = translatedIndexes.filter(i => !tables.has(i.table));
  if (orphans.length) {
    console.error(`\n  ${orphans.length} index(es) point at tables that do not exist:\n`);
    for (const o of orphans) console.error(`    ${o.name} ON ${o.table}`);
    console.error('');
    process.exit(1);
  }
}

const text = lines.join('\n');

const check = process.argv.includes('--check');
const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;

if (check) {
  if (current === text) {
    console.log(`  database/mysql-schema.sql is current (${ordered.length} tables).`);
    process.exit(0);
  }
  console.error(`\n  database/mysql-schema.sql is ${current === null ? 'missing' : 'stale'}.`);
  console.error('  Run: node scripts/mysql-schema.mjs\n');
  process.exit(1);
}

writeFileSync(TARGET, text);
console.log(`  Wrote database/mysql-schema.sql`);
console.log(`    ${ordered.length} tables`);
console.log(`    ${translatedIndexes.length} indexes`);
console.log(`    ${[...generatedColumns.values()].flat().length} generated columns replacing ${indexes.filter(i => i.where).length} partial indexes`);
if (skippedIndexes.length) console.log(`    ${skippedIndexes.length} index(es) NOT translated — see the file`);
