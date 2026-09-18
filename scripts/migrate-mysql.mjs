/**
 * Apply the MySQL schema, from the command line.
 *
 *   npm run migrate            # apply anything not yet applied
 *   npm run migrate:check      # report without changing anything
 *
 * The work is in scripts/migrate-runner.mjs, which server.js also calls when
 * AUTO_MIGRATE is set — one implementation, so it cannot behave differently
 * depending on how it was invoked.
 *
 * It never drops, truncates or deletes. See database/mysql/README.md.
 */

import { runMigration } from './migrate-runner.mjs';

const dryRun = process.argv.includes('--check');

const result = await runMigration({
  dryRun,
  log: (line) => console.log(`  ${line}`),
});

if (result.ok) {
  console.log(`\n  ${result.message}\n`);
  process.exit(0);
}

console.error(`\n  Migration did not run.\n\n    ${result.message}\n`);
process.exit(1);
