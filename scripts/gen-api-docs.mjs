/**
 * Generate docs/api.md from the routers themselves.
 *
 * Hand-written API documentation drifts the moment a route changes. This reads
 * `src/routes.js` for the mount points and each module for its routes and their
 * access rules, so the table cannot disagree with the code.
 *
 *   node scripts/gen-api-docs.mjs > docs/api.md
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const routesSource = readFileSync('src/routes.js', 'utf8');

/** export name → mount path, in the order they are mounted. */
const mounts = [...routesSource.matchAll(/router\.mount\('([^']+)',\s*(\w+)\)/g)]
  .map(m => ({ base: m[1], exportName: m[2] }));

/** export name → module file. */
const files = {};
for (const name of readdirSync('src/modules')) {
  const text = readFileSync(join('src/modules', name), 'utf8');
  for (const m of text.matchAll(/export\s*\{[^}]*router as (\w+)/g)) files[m[1]] = name;
}

/**
 * Find each `router.<method>(...)` call and its final argument.
 *
 * Brace and paren depth is tracked rather than pattern-matched: a handler body
 * contains every character a regex would use as a boundary.
 */
function readRoutes(text) {
  const out = [];
  const start = /router\.(get|post|put|patch|delete)\('([^']*)'/g;

  for (const m of text.matchAll(start)) {
    const method = m[1].toUpperCase();
    const path = m[2];

    // Walk from the opening paren to its match, ignoring strings and comments.
    let i = text.indexOf('(', m.index);
    let depth = 0;
    let end = -1;
    let quote = null;
    let lastComma = -1;

    // The last character that was code, so a `/` can be told apart: after a
    // value it is division, after an operator or an opening bracket it starts
    // a regular expression. Without this, `replace(/^https?:\/\//, '')` reads
    // as a line comment and the rest of the route disappears.
    let previous = '';
    const startsRegex = () => previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous);

    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      const prev = text[j - 1];

      if (quote) {
        if (c === quote && prev !== '\\') quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; previous = c; continue; }
      if (c === '/' && text[j + 1] === '/') { j = text.indexOf('\n', j); if (j < 0) break; continue; }
      if (c === '/' && text[j + 1] === '*') { j = text.indexOf('*/', j) + 1; continue; }

      if (c === '/' && startsRegex()) {
        // Skip to the closing delimiter, honouring escapes and character
        // classes (a `/` inside [...] does not end the literal).
        let inClass = false;
        j += 1;
        for (; j < text.length; j += 1) {
          const d = text[j];
          if (d === '\\') { j += 1; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          else if (d === '\n') break;      // not a regex after all; stop guessing
        }
        previous = '/';
        continue;
      }

      if ('([{'.includes(c)) { depth += 1; previous = c; continue; }
      if (')]}'.includes(c)) {
        depth -= 1;
        if (depth === 0) { end = j; break; }
        previous = c;
        continue;
      }
      if (c === ',' && depth === 1) lastComma = j;
      if (!/\s/.test(c)) previous = c;
    }
    if (end < 0) continue;

    // The options object is whatever follows the last top-level comma, when
    // that argument is an object literal.
    const tail = lastComma > 0 ? text.slice(lastComma + 1, end).trim() : '';
    const opts = tail.startsWith('{') ? tail : '';

    out.push({ method, path, access: describeAccess(opts) });
  }
  return out;
}

function describeAccess(opts) {
  if (!opts) return 'signed in';
  if (/\.\.\.PUBLIC/.test(opts) || /\bauth:\s*false/.test(opts)) return 'public';

  const permission = /\bpermission:\s*'([^']+)'/.exec(opts)?.[1];
  if (permission) return `\`${permission}\``;

  const any = /\banyPermission:\s*\[([^\]]+)\]/.exec(opts)?.[1];
  if (any) {
    return [...any.matchAll(/'([a-z0-9_.]+)'/g)].map(m => `\`${m[1]}\``).join(' or ');
  }
  return 'signed in';
}

// ---------------------------------------------------------------------------

const groups = mounts.map(({ base, exportName }) => {
  const file = files[exportName];
  const routes = file ? readRoutes(readFileSync(join('src/modules', file), 'utf8')) : [];
  return { base, file, routes };
});

const total = groups.reduce((n, g) => n + g.routes.length, 0);
const publicCount = groups.reduce((n, g) => n + g.routes.filter(r => r.access === 'public').length, 0);

console.log(`# API reference

${total} routes across ${groups.length} routers. This file is generated from the
routers themselves — \`node scripts/gen-api-docs.mjs > docs/api.md\` — so it
cannot drift from the code.

## The envelope

Every response, success or failure, has the same shape:

\`\`\`json
{
  "success": true,
  "data": { },
  "error": null,
  "meta": { "requestId": "req_…", "timestamp": "2026-01-01T00:00:00.000Z" }
}
\`\`\`

A list response carries \`meta.pagination\` with \`page\`, \`pageSize\`, \`total\`,
\`totalPages\`, \`hasPrev\` and \`hasNext\`.

A failure sets \`success: false\` and fills \`error\`:

\`\`\`json
{ "success": false, "data": null,
  "error": { "code": "feature_locked", "message": "…", "details": { } },
  "meta": { "requestId": "req_…" } }
\`\`\`

The front end switches on \`error.code\`, not on the status:

| Code | Status | Means |
| --- | --- | --- |
| \`auth_required\` | 401 | No session, or it has expired. The shell signs out. |
| \`twofa_required\` | 401 | Credentials were right; the second factor is not done. |
| \`forbidden\` | 403 | Signed in, but the permission is not held. |
| \`not_found\` | 404 | Including anything outside the caller's tenant. |
| \`validation_failed\` | 422 | \`details\` is a map of field → message. |
| \`feature_locked\` | 402 | \`details\` names the plan or add-on that would unlock it. |
| \`integration_not_configured\` | 409 | \`details\` names the provider and its missing keys. |
| \`rate_limited\` | 429 | \`Retry-After\` is set. |

## Authentication

Send the session token as \`Authorization: Bearer <token>\`, or a machine key as
\`X-Api-Key: <key>\`. ${publicCount} routes are public — registration, sign-in,
password reset, signed file links and the vendor webhooks, which authenticate by
signature instead.

## Conventions

- **Paging**: \`?page=1&pageSize=25\`. Page size is capped per endpoint.
- **Sorting**: \`?sort=created_at&dir=desc\`, against an allow-list of columns.
- **Filtering**: named query parameters per endpoint; unknown ones are ignored.
- **Searching**: \`?q=\`, matched against the fields that endpoint declares.
- **Money**: integer paise everywhere. A field named \`…Paise\` is an integer; a
  field named \`…Label\` is the formatted string beside it.
- **Dates**: ISO 8601 with a timezone. Filing periods are \`YYYY-MM\`.
- **Ids**: prefixed and sortable — \`cli_…\`, \`doc_…\`, \`inv_…\`.

## Routes
`);

for (const group of groups) {
  console.log(`\n### \`${group.base}\` — \`src/modules/${group.file}\`\n`);
  if (!group.routes.length) { console.log('_No routes found._\n'); continue; }
  console.log('| Method | Path | Requires |');
  console.log('| --- | --- | --- |');
  for (const r of group.routes) {
    const full = (group.base + r.path).replace(/([^:])\/$/, '$1');
    console.log(`| ${r.method} | \`${full}\` | ${r.access} |`);
  }
}
