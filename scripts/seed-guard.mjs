/**
 * Whether the demonstration data may be written to this database.
 *
 * Pure, and takes the argv and the environment as arguments, so every branch
 * is testable without a database, a server or a process to kill — the same
 * shape as planMigration in src/db/migration-plan.js.
 *
 * The thing being guarded: the demonstration set includes a platform-level
 * Super Admin who can see every organisation, and the fallback password is
 * committed to this repository. Seeding that onto a production database hands
 * anyone who has read the repository the whole platform.
 */

const REFUSAL = [
  'NODE_ENV=production and DEMO_PASSWORD is not set.',
  '',
  '    The fallback password is committed to this repository, and the demo set',
  '    includes a Super Admin that can see every organisation on the platform.',
  '',
  '    Set DEMO_PASSWORD to a password of your own and run this again, or pass',
  '    --i-accept-the-risk if this deployment is a demonstration and nothing else.',
].join('\n');

export function decideSeed({ argv = [], env = {} } = {}) {
  const dryRun = argv.includes('--check');
  const accepted = argv.includes('--i-accept-the-risk');
  const isProduction = env.NODE_ENV === 'production';
  const passwordIsPublished = !env.DEMO_PASSWORD;

  const base = { dryRun, accepted, isProduction, passwordIsPublished };

  // --check is read-only, so the guard has nothing to protect: it reports the
  // target and writes nothing, whatever NODE_ENV says.
  if (isProduction && passwordIsPublished && !accepted && !dryRun) {
    return { ...base, allowed: false, reason: 'published_password_in_production', message: REFUSAL };
  }
  return { ...base, allowed: true, reason: dryRun ? 'dry_run' : 'ok', message: null };
}
