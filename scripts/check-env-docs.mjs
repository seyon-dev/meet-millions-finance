/**
 * Every environment variable the code reads must be documented.
 *
 * The failure this prevents is quiet and expensive: somebody adds
 * `env.SOME_NEW_KEY`, it works locally because their own .dev.vars has it,
 * and production runs for weeks with the feature silently doing nothing
 * because nobody deploying it knew the key existed. A missing line in
 * .env.example is the whole bug.
 *
 * Run as part of `npm run build`, so it cannot be forgotten.
 *
 *   node scripts/check-env-docs.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

/**
 * Cloudflare bindings, not variables.
 *
 * These arrive on `env` exactly like a variable does, but they are declared in
 * wrangler.jsonc as a D1 database, an R2 bucket, a KV namespace or the static
 * asset handler. Putting them in .env.example would be telling somebody to set
 * a value that does nothing.
 */
const BINDINGS = new Set(['DB', 'DOCS', 'CACHE', 'ASSETS']);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (path.endsWith('.js')) yield path;
  }
}

/** Where each key is read, so a failure names a file rather than a symbol. */
async function collectUsed() {
  const used = new Map();
  for await (const file of walk(join(root, 'src'))) {
    const text = await readFile(file, 'utf8');
    const rel = file.slice(root.length + 1);

    // `env.FOO` and `this.env.FOO` — the direct read.
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      if (!used.has(m[1])) used.set(m[1], rel);
    }
    // requiredKeys / optionalKeys / providerKeys list their keys as strings.
    for (const m of text.matchAll(/(?:required|optional|provider)Keys:\s*\[([^\]]*)\]/g)) {
      for (const k of m[1].matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) {
        if (!used.has(k[1])) used.set(k[1], rel);
      }
    }
  }
  return used;
}

async function documented(file) {
  const text = await readFile(join(root, file), 'utf8');
  return new Set(
    text.split('\n')
      .map(line => line.match(/^([A-Z][A-Z0-9_]*)\s*=/))
      .filter(Boolean)
      .map(m => m[1]));
}

/**
 * The check itself, as a list of problems — empty means it passed.
 *
 * Exported so scripts/build.mjs can fold it in with the other build checks
 * rather than duplicating the scan.
 */
export async function checkEnvDocs() {
  const used = await collectUsed();
  const inEnv = await documented('.env.example');
  const inDev = await documented('.dev.vars.example');

  const problems = [];

  for (const [key, where] of [...used].sort()) {
    if (BINDINGS.has(key)) continue;
    if (!inEnv.has(key)) problems.push(`${key} is read in ${where} but is not in .env.example`);
  }

  // The two files drift apart just as easily as either drifts from the code.
  for (const key of inEnv) if (!inDev.has(key)) {
    problems.push(`${key} is in .env.example but not in .dev.vars.example`);
  }
  for (const key of inDev) if (!inEnv.has(key)) {
    problems.push(`${key} is in .dev.vars.example but not in .env.example`);
  }

  return { problems, count: used.size - BINDINGS.size };
}

// Run directly: node scripts/check-env-docs.mjs
if (process.argv[1] && process.argv[1].endsWith('check-env-docs.mjs')) {
  const { problems, count } = await checkEnvDocs();
  if (problems.length) {
    console.error(`\n  ${problems.length} environment documentation problem(s):\n`);
    for (const p of problems) console.error(`    ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(`  ${count} environment variables, all documented.`);
}
