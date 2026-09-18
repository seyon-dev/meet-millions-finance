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
 * Translate one statement.
 *
 * Deliberately conservative — each rule below exists because a specific
 * statement in this codebase needs it.
 */
export function toMysql(sql) {
  let out = String(sql);

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
export function mysqlType(sqliteType, { indexed = false, primaryKey = false } = {}) {
  const t = String(sqliteType ?? '').trim().toUpperCase();

  if (t.startsWith('INTEGER')) return 'INT';
  if (t.startsWith('REAL') || t.startsWith('NUMERIC') || t.startsWith('DOUBLE')) return 'DOUBLE';
  if (t.startsWith('BLOB')) return 'LONGBLOB';

  // Every identifier in this system is a prefixed ULID — `ten_01M2TE...`,
  // 30 characters or so. 64 leaves room and keeps the index narrow.
  if (primaryKey) return 'VARCHAR(64)';
  if (indexed) return 'VARCHAR(255)';
  return 'TEXT';
}
