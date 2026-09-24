/**
 * Create the demonstration organisation, from the command line.
 *
 *   npm run seed            # against the configured MySQL database
 *   npm run seed -- --check # say what it would do, change nothing
 *
 * `npm run seed` used to point straight at scripts/seed-demo.mjs, which only
 * *exports* seedDemoData and has no entry point of its own — so the command
 * loaded the module, ran nothing and exited 0. It looked like it had worked.
 *
 * Two things this refuses to do, because they are how a demonstration account
 * becomes a way in:
 *
 *   - Seed twice. seedDemoData already returns early if the organisation is
 *     there, so re-running is safe and says so rather than duplicating.
 *   - Seed with the published password when NODE_ENV=production. The password
 *     in scripts/seed-demo.mjs is in the repository, and the demonstration set
 *     includes a platform-level Super Admin. On a production database you must
 *     set DEMO_PASSWORD to something of your own, or pass --i-accept-the-risk
 *     to say out loud that this deployment is a demo and nothing else.
 */

import { createMysqlBinding, closePool } from '../src/db/mysql.js';
import { createFilesystemStorage } from '../src/storage/filesystem.js';
import { seedDemoData, PUBLISHED_DEMO_PASSWORD } from './seed-demo.mjs';
import { decideSeed } from './seed-guard.mjs';

const decision = decideSeed({ argv: process.argv.slice(2), env: process.env });
const { dryRun, passwordIsPublished } = decision;

function fail(message) {
  console.error(`\n  Demonstration data was not created.\n\n    ${message}\n`);
  process.exit(1);
}

if (!decision.allowed) fail(decision.message);

if (dryRun) {
  console.log('\n  --check: nothing was written.');
  console.log(`  Target:   ${process.env.MYSQL_DATABASE ?? '(MYSQL_DATABASE not set)'} on ${process.env.MYSQL_HOST ?? '(MYSQL_HOST not set)'}`);
  console.log(`  Password: ${passwordIsPublished ? 'the repository default — set DEMO_PASSWORD to override' : 'from DEMO_PASSWORD'}\n`);
  process.exit(0);
}

let result;
try {
  const env = { ...process.env };
  env.DB = createMysqlBinding(process.env);
  env.DOCS = await createFilesystemStorage(process.env);
  env.CACHE = undefined;
  result = await seedDemoData(env);
} catch (err) {
  console.error(`\n  Demonstration data was not created.\n\n    ${err.message}\n`);
  if (err.stack) console.error(err.stack);
  await closePool().catch(() => {});
  process.exit(1);
}

await closePool().catch(() => {});

if (result.reused) {
  console.log('\n  The demonstration organisation is already in this database. Nothing was written.');
  console.log(`  Sign in:  ${result.email}\n`);
  process.exit(0);
}

console.log('\n  Demonstration organisation created.\n');
console.log(`    Practice owner   ${result.email}`);
console.log(`    Super Admin      ${result.platformEmail}`);
console.log(`    Password         ${passwordIsPublished ? PUBLISHED_DEMO_PASSWORD : '(the DEMO_PASSWORD you set)'}`);
console.log(`\n    ${result.clients} client companies, ${result.staff} staff accounts.`);
console.log('    Every account uses the same password. See docs/demo-accounts.md.\n');
