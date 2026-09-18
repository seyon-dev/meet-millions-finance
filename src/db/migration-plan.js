/**
 * What a migration run should do, decided without touching a database.
 *
 * The decisions are the part worth testing — whether something is pending,
 * whether it is safe to apply, whether a migration has no route to an existing
 * database. Keeping them here means every branch can be exercised in the test
 * suite, rather than only being discovered against a live server during a
 * deployment.
 *
 * scripts/migrate-mysql.mjs does the talking to MySQL; this decides what to say.
 */

/**
 * @param {object} state
 * @param {Set<string>} state.applied      names already in schema_migrations
 * @param {number}      state.tableCount   application tables present (excluding schema_migrations)
 * @param {string[]}    state.covered      migrations folded into the baseline
 * @param {string[]}    state.sourceMigrations  everything in database/migrations
 * @param {string[]}    state.incrementals      files in database/mysql
 * @param {string}      state.baselineName
 *
 * @returns {{action: string, reason: string, applyBaseline: boolean,
 *            record: string[], pending: string[], safe: boolean}}
 */
export function planMigration({
  applied,
  tableCount,
  covered,
  sourceMigrations,
  incrementals,
  baselineName = 'mysql-schema.sql',
}) {
  const hasBaseline = applied.has(baselineName);

  // A source migration is unhandled when it is neither folded into the
  // baseline nor present as an incremental file. On a fresh database that does
  // not matter — the baseline is about to be regenerated or is already current.
  // On an existing one it means a table will never be created, and the
  // application will fail against a schema that looks applied.
  const unhandled = sourceMigrations.filter(m =>
    !covered.includes(m) && !incrementals.some(f => f.slice(0, 4) === m.slice(0, 4)));

  if (hasBaseline && unhandled.length) {
    return {
      action: 'refuse',
      reason: 'migrations_without_a_route',
      unhandled,
      applyBaseline: false,
      record: [],
      pending: [],
      safe: false,
    };
  }

  // Applying a schema over a database somebody else's data is in could fail
  // halfway and leave it unreasonable about. Refusing is the only safe answer.
  if (!hasBaseline && tableCount > 0) {
    return {
      action: 'refuse',
      reason: 'database_not_empty',
      tableCount,
      applyBaseline: false,
      record: [],
      pending: [],
      safe: false,
    };
  }

  const pending = incrementals.filter(f => !applied.has(f));

  if (hasBaseline && !pending.length) {
    return {
      action: 'up_to_date',
      reason: 'nothing_pending',
      applyBaseline: false,
      record: [],
      pending: [],
      safe: true,
    };
  }

  return {
    action: 'apply',
    reason: hasBaseline ? 'incremental_only' : 'baseline_and_incrementals',
    applyBaseline: !hasBaseline,
    // The baseline stands in for every migration squashed into it, so a later
    // run can tell which source migrations are already present.
    record: hasBaseline ? [] : [baselineName, ...covered],
    pending,
    safe: true,
  };
}
