/**
 * Parse every source file.
 *
 * The browser is the only thing that parses the front-end, and it does so at
 * the moment somebody opens the screen. This runs the same parse ahead of
 * time, over the Worker and the interface alike, so a stray bracket is a
 * failed check rather than a blank page.
 *
 *   node scripts/check-syntax.mjs
 */

import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(new URL('..', import.meta.url).pathname);
const roots = ['src', 'public/assets/js', 'scripts', 'tests'];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(js|mjs)$/.test(entry.name)) yield path;
  }
}

const failures = [];
let checked = 0;

for (const base of roots) {
  for await (const file of walk(join(root, base))) {
    checked += 1;
    try {
      await run(process.execPath, ['--check', file]);
    } catch (err) {
      failures.push({ file: file.replace(`${root}/`, ''), message: String(err.stderr ?? err.message).trim() });
    }
  }
}

if (!failures.length) {
  console.log(`  ${checked} files parse.`);
  process.exit(0);
}

console.error(`\n  ${failures.length} of ${checked} files failed to parse:\n`);
for (const failure of failures) {
  console.error(`  ${failure.file}`);
  console.error(`${failure.message.split('\n').slice(0, 6).map(l => `    ${l}`).join('\n')}\n`);
}
process.exit(1);
