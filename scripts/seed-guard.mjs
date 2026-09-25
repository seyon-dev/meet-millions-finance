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
  // Two spellings of the same decision: a flag for the command line, an
  // environment variable for the server's own startup path, which has no argv.
  const accepted = argv.includes('--i-accept-the-risk')
    || String(env.SEED_DEMO_ACCEPT_RISK ?? '') === 'true';
  const isProduction = env.NODE_ENV === 'production';
  const passwordIsPublished = !env.DEMO_PASSWORD;

  const base = { dryRun, accepted, isProduction, passwordIsPublished };

  // An explicit SEED_DEMO=false is the operator saying this deployment must
  // carry no demonstration data. The manual command respects that as much as
  // the server's startup path does — unset it (or set it true) to seed.
  if (String(env.SEED_DEMO ?? '') === 'false' && !dryRun) {
    return {
      ...base, allowed: false, reason: 'seed_demo_disabled',
      message: 'SEED_DEMO=false is set for this deployment, so demonstration data is disabled. Unset it or set SEED_DEMO=true to seed.',
    };
  }

  // --check is read-only, so the guard has nothing to protect: it reports the
  // target and writes nothing, whatever NODE_ENV says.
  if (isProduction && passwordIsPublished && !accepted && !dryRun) {
    return { ...base, allowed: false, reason: 'published_password_in_production', message: REFUSAL };
  }
  return { ...base, allowed: true, reason: dryRun ? 'dry_run' : 'ok', message: null };
}
