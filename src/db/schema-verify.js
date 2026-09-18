/**
 * Verify that a database really is the baseline before adopting it.
 *
 * The workflow this exists for: create an empty database, import
 * database/mysql-schema.sql through phpMyAdmin because the host gives you no
 * shell, then start the application. At that point the schema is correct and
 * complete, but nothing has written the record of it — so a migration runner
 * that only asks "are there tables?" sees an unexplained database and refuses.
 *
 * Adopting it means writing that record without re-running the DDL. That is
 * only safe if the database genuinely is the baseline, and "116 tables exist"
 * does not establish that: a truncated import, an older baseline, or somebody
 * else's database of a similar size would all pass. So this compares what is
 * actually there against what the baseline file says should be there —
 * tables, columns and indexes, by name.
 *
 * Pure, and takes the actual structure as an argument rather than querying for
 * it, so every outcome is exercised by the test suite instead of being met for
 * the first time against a production database.
 */

/**
 * Read the expected structure out of the generated baseline.
 *
 * Parsing the file that is actually imported, rather than keeping a separate
 * list of what it contains, is what stops the two drifting.
 *
 * @returns {Map<string, {columns: Set<string>, indexes: Set<string>}>}
 */
export function parseExpectedSchema(sql) {
  const tables = new Map();

  // CREATE TABLE <name> ( … ) ENGINE=…
  for (const m of sql.matchAll(/^CREATE TABLE (\w+) \(([\s\S]*?)\n\) ENGINE/gm)) {
    const name = m[1];
    const body = m[2];
    const columns = new Set();

    for (const line of body.split('\n')) {
      const text = line.trim();
      if (!text || text.startsWith('--')) continue;
      // A column line starts with its name; a constraint line starts with a
      // keyword. Anything beginning PRIMARY/UNIQUE/FOREIGN/CHECK/CONSTRAINT
      // is not a column.
      if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT|KEY|INDEX)\b/i.test(text)) continue;
      const col = /^`?(\w+)`?\s+[A-Za-z]/.exec(text);
      if (col) columns.add(col[1].toLowerCase());
    }

    tables.set(name.toLowerCase(), { columns, indexes: new Set() });
  }

  // CREATE [UNIQUE] INDEX <name> ON <table> (…)
  for (const m of sql.matchAll(/^CREATE (?:UNIQUE )?INDEX (\w+) ON (\w+)\s*\(/gm)) {
    const table = tables.get(m[2].toLowerCase());
    if (table) table.indexes.add(m[1].toLowerCase());
  }

  return tables;
}

/**
 * Compare what is in the database against what the baseline expects.
 *
 * @param {Map} expected  from parseExpectedSchema
 * @param {Map} actual    same shape, read from information_schema
 * @param {object} [opts]
 * @param {Set<string>} [opts.ignoreTables]  tables that are ours but not the baseline's
 *
 * @returns {{matches: boolean, missingTables: string[],
 *            missingColumns: string[], missingIndexes: string[],
 *            extraTables: string[], summary: string}}
 */
export function compareSchema(expected, actual, { ignoreTables = new Set(['schema_migrations']) } = {}) {
  const missingTables = [];
  const missingColumns = [];
  const missingIndexes = [];

  for (const [name, want] of expected) {
    const have = actual.get(name);
    if (!have) { missingTables.push(name); continue; }

    for (const column of want.columns) {
      if (!have.columns.has(column)) missingColumns.push(`${name}.${column}`);
    }
    for (const index of want.indexes) {
      if (!have.indexes.has(index)) missingIndexes.push(`${name}.${index}`);
    }
  }

  // Extra tables are reported but do not block. A host or a tool may add its
  // own, and refusing over one would make adoption impossible for reasons
  // that have nothing to do with whether the baseline is present.
  const extraTables = [...actual.keys()]
    .filter(t => !expected.has(t) && !ignoreTables.has(t))
    .sort();

  const matches = missingTables.length === 0
    && missingColumns.length === 0
    && missingIndexes.length === 0;

  const parts = [];
  if (missingTables.length) parts.push(`${missingTables.length} missing table(s)`);
  if (missingColumns.length) parts.push(`${missingColumns.length} missing column(s)`);
  if (missingIndexes.length) parts.push(`${missingIndexes.length} missing index(es)`);

  return {
    matches,
    missingTables: missingTables.sort(),
    missingColumns: missingColumns.sort(),
    missingIndexes: missingIndexes.sort(),
    extraTables,
    summary: matches
      ? `Matches the baseline: ${expected.size} tables, `
        + `${[...expected.values()].reduce((n, t) => n + t.indexes.size, 0)} indexes.`
      : parts.join(', '),
  };
}

/**
 * The first few of each, for an error message that fits on a screen.
 *
 * A list of 116 missing tables tells somebody less than "these three are
 * missing, and 113 more".
 */
export function describeDifferences(result, limit = 8) {
  const lines = [];
  const section = (label, items) => {
    if (!items.length) return;
    lines.push(`  ${items.length} ${label}:`);
    for (const item of items.slice(0, limit)) lines.push(`    ${item}`);
    if (items.length > limit) lines.push(`    … and ${items.length - limit} more`);
  };

  section('missing table(s)', result.missingTables);
  section('missing column(s)', result.missingColumns);
  section('missing index(es)', result.missingIndexes);

  if (result.extraTables.length) {
    lines.push(`  ${result.extraTables.length} table(s) present that the baseline does not define:`);
    for (const item of result.extraTables.slice(0, limit)) lines.push(`    ${item}`);
  }

  return lines.join('\n');
}
