/**
 * Build.
 *
 * There is no bundler here: the Worker runs ES modules directly and `public/`
 * is served as static assets, so "build" means verifying that everything the
 * deploy needs is present and coherent. Each check below exists because its
 * absence once shipped something broken:
 *
 *   parse        — one unbalanced bracket made every list screen fail to load
 *   migrations   — a migration that will not apply is a deployment that stops
 *                  half way
 *   routes       — a route pointing at a screen file that is not there is a
 *                  blank page, and nothing else reports it
 *   links        — navigation to a path no router registers is a dead end
 *   permissions  — a permission key that is not in the catalogue silently
 *                  hides a control from the people who should have it
 *   css          — `var(--name)` with no definition renders as nothing at all
 *   icons        — a missing icon name falls back to the same generic mark
 *   env          — a key the code reads but nobody documented is a feature
 *                  that silently does nothing in production
 *   deploy       — only inside Cloudflare Workers Builds: a placeholder
 *                  resource id, which the deploy would reject a minute
 *                  later with a bare error code
 *   bundle       — the pasteable schema drifting from the migrations it
 *                  claims to contain hands somebody an incomplete database
 *   undefined    — a name called but never imported parses fine and throws
 *                  ReferenceError on the live route; this found the Worker
 *                  serving every page with an unimported header helper
 *
 *   node scripts/build.mjs [--quiet]
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const quiet = process.argv.includes('--quiet');
const problems = [];
const note = (check, detail) => problems.push({ check, detail });
const say = (line) => { if (!quiet) console.log(line); };

// ---------------------------------------------------------------------------

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.includes(extname(full))) out.push(full);
  }
  return out;
}

const jsFiles = ['src', 'public/assets/js', 'scripts', 'tests'].flatMap(d => walk(d, ['.js', '.mjs']));
const cssFiles = walk('public/assets/css', ['.css']);

// ---- 1. Everything parses --------------------------------------------------
{
  const { execFileSync } = await import('node:child_process');
  let failed = 0;
  for (const file of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed += 1;
      note('parse', `${file}: ${String(err.stderr ?? err.message).split('\n')[1] ?? 'syntax error'}`);
    }
  }
  say(`  parse        ${jsFiles.length - failed}/${jsFiles.length} files`);
}

// ---- 2. Migrations apply in order -----------------------------------------
{
  const dir = 'database/migrations';
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  let applied = 0;
  for (const f of files) {
    try { db.exec(readFileSync(join(dir, f), 'utf8')); applied += 1; }
    catch (err) { note('migrations', `${f}: ${err.message}`); break; }
  }
  const tables = db.prepare(
    "SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
  for (const issue of db.prepare('PRAGMA foreign_key_check').all()) {
    note('migrations', `foreign key: ${JSON.stringify(issue)}`);
  }
  say(`  migrations   ${applied}/${files.length} applied, ${tables} tables`);
}

// ---- 3. Every SPA route has a screen file ---------------------------------
const app = readFileSync('public/assets/js/app.js', 'utf8');
const routes = [...app.matchAll(/\broute\('([^']+)',\s*\(\)\s*=>\s*import\('([^']+)'\)/g)]
  .map(m => ({ path: m[1], module: m[2] }));
{
  for (const r of routes) {
    const file = join('public/assets/js', r.module.replace(/^\.\//, ''));
    if (!existsSync(file)) note('routes', `${r.path} → ${r.module} (no such file)`);
  }
  say(`  routes       ${routes.length} registered`);
}

// ---- 4. No internal link points at an unregistered route ------------------
{
  const registered = routes.map(r => r.path);
  const matches = (path) => registered.some((pattern) => {
    const p = pattern.split('/').filter(Boolean);
    const q = path.split('?')[0].split('/').filter(Boolean);
    return p.length === q.length && p.every((seg, i) => seg.startsWith(':') || seg === q[i]);
  });

  let checked = 0;
  for (const file of jsFiles) {
    if (file.startsWith('tests/') || file.startsWith('scripts/')) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/(?:route|path|href|linkPath):\s*'(\/[^'`$]*)'/g)) {
        const path = m[1];
        if (path.startsWith('/api') || path === '/' || path === '/login') continue;
        checked += 1;
        if (!matches(path)) note('links', `${file}:${i + 1} → ${path}`);
      }
    });
  }
  say(`  links        ${checked} internal links`);
}

// ---- 5. Permission keys exist in the catalogue ----------------------------
{
  const catalogue = new Set(
    [...readFileSync('src/permissions/catalog.js', 'utf8').matchAll(/p\('([a-z0-9_.]+)'/g)].map(m => m[1]));

  let checked = 0;
  const seen = new Set();
  for (const file of jsFiles) {
    if (file.startsWith('tests/') || file.startsWith('scripts/')) continue;
    const text = readFileSync(file, 'utf8');
    const used = [
      ...[...text.matchAll(/(?:permission|anyPermission):\s*'([a-z0-9_.]+)'/g)].map(m => m[1]),
      ...[...text.matchAll(/(?:permission|anyPermission):\s*\[([^\]]+)\]/g)]
        .flatMap(m => [...m[1].matchAll(/'([a-z0-9_.]+)'/g)].map(x => x[1])),
      ...[...text.matchAll(/(?:ctx\.has|session\.can|can)\('([a-z0-9_.]+)'\)/g)].map(m => m[1]),
    ];
    for (const key of used) {
      checked += 1;
      // A dotted key with a verb-like tail is a permission; anything else
      // matched here (a CSS class, a status) is not, and is left alone.
      if (!key.includes('.')) continue;
      if (!catalogue.has(key) && !seen.has(`${file}|${key}`)) {
        seen.add(`${file}|${key}`);
        note('permissions', `${file}: '${key}' is not in the catalogue`);
      }
    }
  }
  say(`  permissions  ${checked} uses against ${catalogue.size} keys`);
}

// ---- 6. Every CSS variable referenced is defined --------------------------
{
  const css = cssFiles.map(f => readFileSync(f, 'utf8')).join('\n');
  const defined = new Set([...css.matchAll(/(--mm-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  const used = new Set([...css.matchAll(/var\((--mm-[a-z0-9-]+)/g)].map(m => m[1]));
  for (const name of used) if (!defined.has(name)) note('css', `var(${name}) has no definition`);
  say(`  css          ${used.size} variables, ${defined.size} defined`);
}

// ---- 7. The generated API reference is current ----------------------------
{
  const doc = existsSync('docs/api.md') ? readFileSync('docs/api.md', 'utf8') : null;
  if (!doc) {
    note('docs', 'docs/api.md is missing — run: node scripts/gen-api-docs.mjs > docs/api.md');
  } else {
    // Compared against the generator's own output rather than re-counting by
    // hand: two ways of counting the same thing is two things to keep in step.
    const { execFileSync } = await import('node:child_process');
    const fresh = execFileSync(process.execPath, ['scripts/gen-api-docs.mjs'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (fresh.trim() !== doc.trim()) {
      note('docs', 'docs/api.md is out of date — run: node scripts/gen-api-docs.mjs > docs/api.md');
    }
    const stated = /^(\d+) routes across (\d+) routers/m.exec(doc)?.[1] ?? '?';
    say(`  docs         api.md documents ${stated} routes`);
  }
}

// ---- 8. Every filter a screen applies is read by an endpoint ---------------
{
  const read = new Set();
  for (const file of walk('src/modules', ['.js'])) {
    const text = readFileSync(file, 'utf8');
    for (const re of [/ctx\.q\('([a-zA-Z0-9_]+)'/g, /ctx\.qBool\('([a-zA-Z0-9_]+)'/g,
      /ctx\.qInt\('([a-zA-Z0-9_]+)'/g, /ctx\.qList\('([a-zA-Z0-9_]+)'/g]) {
      for (const m of text.matchAll(re)) read.add(m[1]);
    }
  }
  // Paging and sorting go through ctx.pagination() and safeOrder(), not ctx.q.
  for (const name of ['page', 'pageSize', 'sort', 'dir', 'q']) read.add(name);

  let checked = 0;
  for (const file of walk('public/assets/js/screens', ['.js'])) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/apply\('([a-zA-Z0-9_]+)'/g)) {
        checked += 1;
        if (!read.has(m[1])) {
          // A query parameter nothing reads is ignored rather than rejected,
          // so the dropdown moves and the list does not. Nothing else reports
          // it.
          note('filters', `${file}:${i + 1} apply('${m[1]}') — no endpoint reads that name`);
        }
      }
    });
  }
  say(`  filters      ${checked} against ${read.size} query names`);
}

// ---- 9. The CSP hash matches the inline script it covers -------------------
{
  const html = readFileSync('public/index.html', 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

  const { createHash } = await import('node:crypto');
  const policy = readFileSync('src/http/security.js', 'utf8');
  const declared = /INLINE_THEME_SCRIPT_HASH = '([^']+)'/.exec(policy)?.[1] ?? null;

  if (!inline.length) {
    note('csp', 'public/index.html has no inline script, but security.js still carries a hash for one.');
  } else if (inline.length > 1) {
    note('csp', `public/index.html has ${inline.length} inline scripts; the policy hashes only one. `
      + 'Each needs its own hash or the extra ones are blocked.');
  } else {
    const actual = 'sha256-' + createHash('sha256').update(inline[0], 'utf8').digest('base64');
    if (actual !== declared) {
      // A mismatch does not fail loudly in a browser — the script is simply
      // blocked, and the page loads with the wrong theme and no explanation.
      note('csp', `The inline theme script changed but its CSP hash did not.\n`
        + `       declared: ${declared}\n`
        + `       actual:   ${actual}\n`
        + '       Update INLINE_THEME_SCRIPT_HASH in src/http/security.js.');
    }
  }
  say(`  csp          inline script hash ${declared ? 'declared' : 'MISSING'}`);
}

// ---- 10. Every icon name used exists --------------------------------------
{
  const iconsSource = readFileSync('public/assets/js/core/icons.js', 'utf8');
  const known = new Set([
    ...[...iconsSource.matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s*'/gm)].map(m => m[1]),
  ]);

  let checked = 0;
  const seen = new Set();
  for (const file of [...walk('public/assets/js', ['.js']), ...walk('src', ['.js'])]) {
    if (file.endsWith('core/icons.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:icon\(|icon:\s*)'([a-z0-9-]+)'/g)) {
      checked += 1;
      const name = m[1];
      if (!known.has(name) && !seen.has(name)) {
        seen.add(name);
        note('icons', `'${name}' is not in the icon set (${file})`);
      }
    }
  }
  say(`  icons        ${checked} uses against ${known.size} icons`);
}

// ---- 11. Every environment variable is documented -------------------------
{
  const { checkEnvDocs } = await import('./check-env-docs.mjs');
  const { problems: envProblems, count } = await checkEnvDocs();
  for (const detail of envProblems) note('env', detail);
  say(`  env          ${count} variables documented`);
}

// ---- 12. Every called name exists -------------------------------------------
//
// `node --check` parses; it does not resolve names. A function that was
// renamed, moved or deleted in a refactor leaves a file that parses perfectly
// and throws ReferenceError the first time its route is reached. This caught
// src/index.js calling three header helpers it never imported, which would
// have thrown on every page load in production — the dev server serves static
// files by a different path, so no amount of browser testing would have found
// it.
{
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['scripts/check-undefined.mjs'], { stdio: 'pipe' });
    say('  undefined    every called name resolves');
  } catch (err) {
    for (const line of String(err.stdout ?? '').split('\n')) {
      const hit = line.trim();
      if (hit && hit.includes('()')) note('undefined', hit);
    }
  }
}

// ---- 13. The pasteable schema matches the migrations -----------------------
//
// database/bundled/schema.sql exists so a database can be created from the
// Cloudflare dashboard, where there is no CLI. It is generated, so it rots the
// moment a migration is added and nobody regenerates it — and a stale bundle
// is worse than none: it produces a database that is silently missing tables.
{
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, ['scripts/bundle-migrations.mjs', '--check'], { stdio: 'pipe' });
    say('  bundle       schema.sql matches the migrations');
  } catch (err) {
    note('bundle', `${String(err.stdout ?? '').trim() || 'database/bundled/schema.sql is stale'}`
      + ' — run: node scripts/bundle-migrations.mjs');
  }
}

// ---- 14. Deployment readiness, in a pipeline that deploys --------------------
//
// Cloudflare Workers Builds runs `npm run build` and then a separate deploy
// command, which defaults to `npx wrangler deploy` — so `npm run deploy`, and
// with it scripts/preflight-deploy.mjs, is skipped entirely. That is how a
// placeholder `database_id` got as far as the Cloudflare API and came back as
//
//   binding DB of type d1 must have a valid `database_id` specified [code: 10021]
//
// after a full build. Running the same check here fails in seconds instead,
// and says which command produces the missing id.
//
// Deliberately NOT gated on plain CI: a test pipeline that builds without
// deploying has no business needing real resource ids.
{
  const { preflightProblems, isDeployingCi } = await import('./preflight-deploy.mjs');
  if (isDeployingCi()) {
    for (const detail of preflightProblems()) note('deploy', detail);
    say(`  deploy       checked (this build deploys)`);
  } else {
    const pending = preflightProblems().length;
    say(`  deploy       ${pending ? `${pending} item(s) still to resolve before deploying` : 'ready'} (not enforced here)`);
  }
}

// ---------------------------------------------------------------------------

if (!problems.length) {
  say('\n  Build checks passed.\n');
  process.exit(0);
}

const byCheck = {};
for (const p of problems) (byCheck[p.check] ??= []).push(p.detail);

console.error(`\n  ${problems.length} problem(s):\n`);
for (const [check, list] of Object.entries(byCheck)) {
  console.error(`  ${check.toUpperCase()} (${list.length})`);
  for (const detail of list) console.error(`    ${detail}`);
  console.error('');
}
process.exit(1);
