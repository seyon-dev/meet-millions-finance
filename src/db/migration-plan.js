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
 * @param {object|null} state.verification  structural comparison, or null
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
  // The result of comparing this database against the baseline, from
  // src/db/schema-verify.js. Null when nothing looked — which is itself a
  // reason to refuse rather than to assume.
  verification = null,
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

  // ---- A database that already has the schema, but no record of it --------
  //
  // This is the phpMyAdmin-first case, and it is a supported workflow rather
  // than an accident: a managed host with no shell leaves importing the
  // baseline by hand as the only way to create the tables. The schema is then
  // correct and complete, and nothing has written the record of it.
  //
  // Re-running the DDL would fail on the first CREATE TABLE. Refusing outright
  // — which is what this did — makes the documented workflow impossible. The
  // right answer is to adopt it: write the record without touching the schema.
  //
  // Only when it has been verified, though. `verification` is the result of
  // comparing the database against the baseline structurally; without one, or
  // with one that does not match, there is nothing to justify the claim that
  // this database is the baseline.
  if (!hasBaseline && tableCount > 0) {
    if (!verification) {
      return {
        action: 'refuse',
        reason: 'unverified_existing_schema',
        tableCount,
        applyBaseline: false,
        record: [],
        pending: [],
        safe: false,
      };
    }

    if (!verification.matches) {
      return {
        action: 'refuse',
        reason: 'schema_does_not_match_baseline',
        tableCount,
        verification,
        applyBaseline: false,
        record: [],
        pending: [],
        safe: false,
      };
    }

    // Verified. Record the baseline and everything folded into it, then carry
    // on to any incremental migrations that are also pending — a database
    // imported from an older baseline still needs those.
    return {
      action: 'adopt',
      reason: 'existing_schema_matches_baseline',
      tableCount,
      verification,
      applyBaseline: false,
      record: [baselineName, ...covered],
      pending: incrementals.filter(f => !applied.has(f)),
      safe: true,
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
