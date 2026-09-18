/**
 * Deployment preflight.
 *
 * `wrangler deploy` does not validate resource ids locally — a placeholder
 * D1 id, or an all-zero KV namespace, passes `--dry-run` without a murmur and
 * fails against the Cloudflare API minutes later, half way through a CI run.
 * That is exactly how this project's first deployment failed.
 *
 * So the check lives here instead, and `npm run deploy` runs it first. It
 * refuses to deploy while any resource id is still a placeholder, and names
 * the command that produces the real one.
 *
 *   node scripts/preflight-deploy.mjs
 *
 * Exit 0 = safe to deploy. Exit 1 = something must be created or pasted.
 */

import { readFileSync, existsSync } from 'node:fs';

const CONFIG = 'wrangler.jsonc';

/** The Cloudflare Workers project this repository deploys to. */
const EXPECTED_WORKER_NAME = 'meet-millions-finance';

/** Secrets the application cannot start without. */
const REQUIRED_SECRETS = ['AUTH_SECRET', 'ENCRYPTION_KEY', 'FILE_SIGNING_SECRET'];

const problems = [];
const notes = [];

// ---------------------------------------------------------------------------
// Read the config. JSONC, so comments and trailing commas have to go first.
// ---------------------------------------------------------------------------

function parseJsonc(text) {
  const withoutComments = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      m => (m.startsWith('"') ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutComments);
}

if (!existsSync(CONFIG)) {
  console.error(`\n  ${CONFIG} is missing. There is nothing to deploy.\n`);
  process.exit(1);
}

let config;
try {
  config = parseJsonc(readFileSync(CONFIG, 'utf8'));
} catch (err) {
  console.error(`\n  ${CONFIG} could not be parsed: ${err.message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Anything that looks like a placeholder rather than a resource.
// ---------------------------------------------------------------------------

function isPlaceholder(value) {
  if (!value || typeof value !== 'string') return true;
  const v = value.trim();
  if (!v) return true;
  if (/^0[0-9a-f-]*$/i.test(v) && /^[0-9a-f-]+$/i.test(v) && !/[1-9a-f]/i.test(v)) return true;
  return /replace|placeholder|your[-_]|xxx|todo|changeme|<.*>/i.test(v);
}

// ---- Worker name ----------------------------------------------------------
if (config.name !== EXPECTED_WORKER_NAME) {
  problems.push({
    what: `The Worker is named "${config.name}", but the Cloudflare project is "${EXPECTED_WORKER_NAME}".`,
    fix: `Set "name": "${EXPECTED_WORKER_NAME}" in ${CONFIG}, or rename the Cloudflare project to match.`,
  });
}

// ---- One environment ------------------------------------------------------
if (config.env && Object.keys(config.env).length) {
  problems.push({
    what: `${CONFIG} defines named environments (${Object.keys(config.env).join(', ')}) as well as a top-level one.`,
    fix: 'wrangler deploy then needs an explicit --env, and a named environment renames the Worker to '
      + '<name>-<env> unless overridden. Keep one top-level environment, or pass --env on every deploy.',
  });
}

// ---- D1 (required) --------------------------------------------------------
const d1 = config.d1_databases ?? [];
if (!d1.length) {
  problems.push({
    what: 'No D1 database is bound. The application cannot serve a single request without one.',
    fix: 'npx wrangler d1 create meetmillions_crm   → paste database_id into wrangler.jsonc',
  });
}
for (const db of d1) {
  if (isPlaceholder(db.database_id)) {
    problems.push({
      what: `D1 binding "${db.binding}" (${db.database_name}) has a placeholder database_id: ${JSON.stringify(db.database_id ?? null)}`,
      fix: `npx wrangler d1 create ${db.database_name}   → paste the printed id as "database_id" in ${CONFIG}`,
    });
  }
}

// ---- R2 (required) --------------------------------------------------------
const r2 = config.r2_buckets ?? [];
if (!r2.length) {
  problems.push({
    what: 'No R2 bucket is bound. Document upload, reports, recordings and voice notes all need one.',
    fix: 'npx wrangler r2 bucket create meetmillions-crm-documents',
  });
}
for (const bucket of r2) {
  if (isPlaceholder(bucket.bucket_name)) {
    problems.push({
      what: `R2 binding "${bucket.binding}" has a placeholder bucket_name.`,
      fix: 'Name the bucket, then: npx wrangler r2 bucket create <name>',
    });
  } else {
    notes.push(`R2 bucket "${bucket.bucket_name}" must exist — npx wrangler r2 bucket create ${bucket.bucket_name}`);
  }
}

// ---- KV (optional) --------------------------------------------------------
const kv = config.kv_namespaces ?? [];
for (const ns of kv) {
  if (isPlaceholder(ns.id)) {
    problems.push({
      what: `KV binding "${ns.binding}" has a placeholder namespace id: ${JSON.stringify(ns.id ?? null)}. `
        + 'This is what made the last deployment fail with "KV namespace ... not found".',
      fix: `npx wrangler kv namespace create ${ns.binding}   → paste the id, `
        + 'or remove the binding entirely (rate limiting falls back to D1 on its own).',
    });
  }
  if (ns.preview_id !== undefined && isPlaceholder(ns.preview_id)) {
    problems.push({
      what: `KV binding "${ns.binding}" has a placeholder preview_id.`,
      fix: `npx wrangler kv namespace create ${ns.binding} --preview   → paste the id, or drop preview_id.`,
    });
  }
}
if (!kv.length) {
  notes.push('No KV binding — rate limiting will use the durable D1 table. That is supported and exact; '
    + 'KV is only faster. Add a CACHE binding later with no code change.');
}

// ---- Entry point and assets ----------------------------------------------
if (!config.main || !existsSync(config.main)) {
  problems.push({ what: `"main" points at ${config.main ?? '(nothing)'}, which does not exist.`, fix: 'Fix "main" in wrangler.jsonc.' });
}
if (config.assets?.directory && !existsSync(config.assets.directory)) {
  problems.push({ what: `Assets directory ${config.assets.directory} does not exist.`, fix: 'Fix "assets.directory".' });
}

// ---- APP_URL --------------------------------------------------------------
const appUrl = config.vars?.APP_URL ?? '';
if (!appUrl) {
  problems.push({ what: 'APP_URL is not set.', fix: 'Set vars.APP_URL to the origin this Worker is served from.' });
} else if (/localhost|127\.0\.0\.1/.test(appUrl)) {
  problems.push({
    what: `APP_URL is ${appUrl} — a local address in a deployed configuration.`,
    fix: 'Set vars.APP_URL to the real origin. OAuth redirects and e-mail links are built from it.',
  });
}
if (String(config.vars?.DEMO_MODE) === 'true') {
  problems.push({
    what: 'DEMO_MODE is "true". A deployment would show the demonstration banner and seed demo data.',
    fix: 'Set vars.DEMO_MODE to "false" in wrangler.jsonc.',
  });
}

// ---- Migrations -----------------------------------------------------------
const migrationsDir = d1[0]?.migrations_dir;
if (migrationsDir && !existsSync(migrationsDir)) {
  problems.push({ what: `migrations_dir ${migrationsDir} does not exist.`, fix: 'Fix migrations_dir in wrangler.jsonc.' });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (problems.length) {
  console.error(`\n  Deployment stopped — ${problems.length} thing(s) must be resolved first.\n`);
  problems.forEach((p, i) => {
    console.error(`  ${i + 1}. ${p.what}`);
    console.error(`     → ${p.fix}\n`);
  });
  console.error('  Nothing was deployed. No Cloudflare resource was created or changed.\n');
  process.exit(1);
}

console.log('\n  Preflight passed.\n');
console.log(`  Worker:  ${config.name}`);
console.log(`  D1:      ${d1.map(d => `${d.database_name} (${String(d.database_id).slice(0, 8)}…)`).join(', ') || 'none'}`);
console.log(`  R2:      ${r2.map(b => b.bucket_name).join(', ') || 'none'}`);
console.log(`  KV:      ${kv.map(n => n.binding).join(', ') || 'none (D1 fallback)'}`);
console.log(`  Cron:    ${(config.triggers?.crons ?? []).length} trigger(s)`);
console.log(`  URL:     ${appUrl}\n`);

for (const note of notes) console.log(`  Note: ${note}`);
if (notes.length) console.log('');

console.log(`  Secrets must already be set with \`wrangler secret put\`: ${REQUIRED_SECRETS.join(', ')}.`);
console.log('  Preflight cannot read them — Cloudflare does not expose secret values.\n');
