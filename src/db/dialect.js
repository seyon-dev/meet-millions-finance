/**
 * SQLite → MySQL translation.
 *
 * The application writes SQLite-flavoured SQL in 123 places. Rewriting all of
 * them would mean the test suite — which runs on real SQLite against the real
 * migrations — could no longer prove the queries it exercises are the queries
 * that ship. So the translation happens here instead, at the one boundary
 * where the driver knows which database it is talking to.
 *
 * Only the constructs this codebase actually uses are handled, and anything
 * unrecognised is passed through untouched: a translator that silently
 * "fixes" SQL it does not understand is worse than one that leaves it alone
 * and lets MySQL reject it loudly.
 */

/**
 * MySQL 8.0 reserved words.
 *
 * The full list rather than the two this schema happens to hit today (`key`
 * and `trigger`), so a column added later called `rank`, `system` or `groups`
 * is quoted automatically instead of failing at import time on a server
 * nobody can reproduce locally.
 */
export const RESERVED = new Set(`accessible add all alter analyze and as asc asensitive before between bigint
binary blob both by call cascade case change char character check collate column condition constraint continue
convert create cross cube cume_dist current_date current_time current_timestamp current_user cursor database
databases day_hour day_microsecond day_minute day_second dec decimal declare default delayed delete dense_rank
desc describe deterministic distinct distinctrow div double drop dual each else elseif empty enclosed escaped
except exists exit explain false fetch first_value float float4 float8 for force foreign from fulltext function
generated get grant group grouping groups having high_priority hour_microsecond hour_minute hour_second if
ignore in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer interval into
io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value lateral lead leading
leave left like limit linear lines load localtime localtimestamp lock long longblob longtext loop low_priority
master_bind master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint
minute_microsecond minute_second mod modifies natural not no_write_to_binlog nth_value ntile null numeric of on
optimize optimizer_costs option optionally or order out outer outfile over partition percent_rank precision
primary procedure purge range rank read reads read_write real recursive references regexp release rename repeat
replace require resignal restrict return revoke right rlike row rows row_number schema schemas
second_microsecond select sensitive separator set show signal smallint spatial specific sql sqlexception
sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stored straight_join system
table terminated then tinyblob tinyint tinytext to trailing trigger true undo union unique unlock unsigned
update usage use using utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying virtual
when where while window with write xor year_month zerofill`.split(/\s+/).filter(Boolean));

/** Quote an identifier for MySQL, if it needs it. */
export function mysqlIdent(name) {
  return RESERVED.has(String(name).toLowerCase()) ? `\`${name}\`` : name;
}

/**
 * The reserved words this schema actually uses as column names.
 *
 * Deliberately not the whole RESERVED list. Quoting every reserved word inside
 * a statement would backtick SELECT, FROM and WHERE along with the columns —
 * the words are only a problem where they appear as *identifiers*, and which
 * ones do is a fact about this schema. tests/dialect.test.js reads
 * database/mysql-schema.sql and fails if a migration ever adds another, so the
 * set cannot drift away from the tables.
 */
export const SCHEMA_RESERVED = new Set(['key', 'trigger']);

/**
 * Backtick the reserved words this schema uses as column names.
 *
 * This is the bug that took the deployment down. The schema generator quotes
 * them in the DDL — `mysqlIdent` above, used by scripts/mysql-schema.mjs — so
 * MySQL happily holds a column called `key`. Nothing quoted them at *query*
 * time, so every statement reading one went out as `... AND key = ?` and MySQL
 * answered with a 1064 syntax error. The very first of them is the one
 * `ensureBootstrapped` runs, which is on the path of every request.
 *
 * SQLite never complained, so no test could see it: `key` is an ordinary
 * identifier there.
 *
 * Quoting has to be literal-aware — `namespace = 'key'` is a value, not a
 * column, and `\`key\`` is already done. So this walks the statement rather
 * than running a regex over it, stepping over string literals, quoted
 * identifiers and comments whole.
 */
export function quoteReservedIdentifiers(sql, words = SCHEMA_RESERVED) {
  const text = String(sql);
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // A string literal or an already-quoted identifier: copy it verbatim.
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }        // \' escape
        if (text[j] === ch) {
          if (text[j + 1] === ch) { j += 2; continue; }      // '' escape
          break;
        }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Comments, for the same reason.
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }

    // A bare word.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      out += words.has(word.toLowerCase()) ? `\`${word}\`` : word;
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Translate one statement.
 *
 * Deliberately conservative — each rule below exists because a specific
 * statement in this codebase needs it.
 */
export function toMysql(sql) {
  // First, before anything below introduces SQL of its own. The ON CONFLICT
  // rewrite emits `ON DUPLICATE KEY UPDATE`, where KEY is syntax rather than a
  // column — quoting after that rule would break the statement it just built.
  // The statements arriving here are SQLite-flavoured and never contain that
  // phrase, so doing it first is safe. DDL never reaches this function at all:
  // the migration runner goes through MysqlD1.exec, which does not translate.
  let out = quoteReservedIdentifiers(String(sql));

  // PRAGMA table_info(x) → information_schema.
  //
  // Db.columnsOf reads a table's columns to decide whether it carries
  // created_at / updated_at, which is far more reliable than a hand-kept list.
  // It asked SQLite the only way SQLite answers, and MySQL has no PRAGMA at
  // all — so the statement arrived as a syntax error. TenantScope calls it on
  // every tenant-scoped insert and update, so on MySQL that was most of the
  // application, registration included.
  //
  // The alias matters: the caller reads `row.name`, which is what SQLite's
  // PRAGMA returns and what this has to keep returning.
  out = out.replace(
    /\bPRAGMA\s+table_info\s*\(\s*`?([A-Za-z_][\w$]*)`?\s*\)/gi,
    (_, table) => 'SELECT column_name AS name FROM information_schema.columns '
      + `WHERE table_schema = DATABASE() AND table_name = '${table}'`);

  // INSERT OR IGNORE → INSERT IGNORE. Used by the bootstrap seeder and the
  // rate limiter, both of which rely on the insert being a no-op on conflict.
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  out = out.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');

  // ON CONFLICT (cols) DO UPDATE SET a = excluded.b
  //   → ON DUPLICATE KEY UPDATE a = VALUES(b)
  //
  // MySQL's form does not name the conflicting columns: it fires on any
  // unique-key collision. Every use here targets exactly one unique key, so
  // the behaviour matches; a second unique key on those tables would make
  // this wrong, which is why the schema generator keeps them to one.
  out = out.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\b/gi,
    'ON DUPLICATE KEY UPDATE');
  out = out.replace(/\bON\s+CONFLICT\s*\([^)]*\)\s*DO\s+NOTHING\b/gi,
    'ON DUPLICATE KEY UPDATE id = id');
  out = out.replace(/\bexcluded\.([a-zA-Z_][\w]*)/g, 'VALUES($1)');

  // Date formatting. SQLite's strftime and MySQL's DATE_FORMAT share the
  // same % codes for the patterns used here.
  out = out.replace(/\bstrftime\s*\(\s*('(?:[^']*)')\s*,\s*([^)]+)\)/gi,
    (_, fmt, expr) => `DATE_FORMAT(${expr.trim()}, ${fmt})`);

  // SQLite's IS / IS NOT work on any value; MySQL restricts IS to
  // TRUE/FALSE/NULL/UNKNOWN, so `x IS ?` has to become the null-safe
  // equality operator. This matters: the audit chain queries platform rows
  // with `tenant_id IS ?` and a null parameter.
  // `IS NOT ?` would need `NOT (x <=> ?)`. It appears nowhere in this
  // codebase, so rather than carry an untested rewrite this refuses it and
  // says so — a wrong translation here silently changes which rows match.
  if (/\bIS\s+NOT\s+\?/i.test(out)) {
    throw new Error('`IS NOT ?` has no translation here. Write `NOT (col <=> ?)` instead.');
  }
  out = out.replace(/([\w`.]+)\s+IS\s+\?/gi, '$1 <=> ?');

  // Identifier quoting: SQLite accepts "x", MySQL wants `x` unless
  // ANSI_QUOTES is set, which is not the default on Hostinger.
  out = out.replace(/"([a-zA-Z_][\w]*)"/g, '`$1`');

  return out;
}

/**
 * Column types.
 *
 * SQLite stores everything as one of five affinities and does not care about
 * width. MySQL does, and an index cannot cover an unbounded TEXT column — the
 * single largest source of change in this schema, since every primary key is
 * a `TEXT PRIMARY KEY`.
 */
export function mysqlType(sqliteType, { indexed = false, primaryKey = false, hasDefault = false } = {}) {
  const t = String(sqliteType ?? '').trim().toUpperCase();

  if (t.startsWith('INTEGER')) return 'INT';
  if (t.startsWith('REAL') || t.startsWith('NUMERIC') || t.startsWith('DOUBLE')) return 'DOUBLE';
  if (t.startsWith('BLOB')) return 'LONGBLOB';

  // Every identifier in this system is a prefixed ULID — `ten_01M2TE...`,
  // 30 characters or so. 64 leaves room and keeps the index narrow.
  if (primaryKey) return 'VARCHAR(64)';
  if (indexed) return 'VARCHAR(255)';

  // A column with a DEFAULT must not be TEXT: MySQL does not allow a default
  // on TEXT, so the generator used to drop it. That left 138 NOT NULL columns
  // across 76 tables with no default at all, and under STRICT_TRANS_TABLES
  // every insert that relied on one — a status, a priority, a currency —
  // failed with "Field 'x' doesn't have a default value". SQLite filled them
  // in, so nothing in the test suite could see it.
  //
  // These defaults are all short enum-like words: 'active', 'pending',
  // 'monthly'. VARCHAR(255) keeps the default and stays inside InnoDB's index
  // limit at utf8mb4.
  if (hasDefault) return 'VARCHAR(255)';

  return 'TEXT';
}
