/**
 * Identifiers used but never defined, imported or declared.
 *
 * `node --check` parses a file; it does not resolve names. So a function that
 * was renamed, moved to another module, or deleted in a refactor leaves a
 * file that parses perfectly and throws ReferenceError the first time that
 * route is hit. That happened twice while extracting the automation engine,
 * and neither the syntax check nor the build noticed.
 *
 * This walks each module's top-level declarations and imports, then looks for
 * called identifiers that match none of them and none of the globals a Worker
 * provides.
 *
 * Scoped to src/ deliberately. A ReferenceError there is a 500 on a live
 * route; the browser code is covered by the browser sweep, which loads every
 * screen, and the build scripts by the fact that the build runs them.
 *
 *   node scripts/check-undefined.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const ROOTS = ['src'];

/** Everything a Worker, a browser or Node provides without importing it. */
const GLOBALS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'Request',
  'Response', 'Headers', 'URL', 'URLSearchParams', 'FormData', 'File', 'Blob',
  'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal', 'ReadableStream',
  'WritableStream', 'TransformStream', 'crypto', 'atob', 'btoa', 'caches',
  'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'EventTarget', 'Event',
  'CustomEvent', 'globalThis', 'process', 'Buffer', 'require', 'module', 'exports',
  '__dirname', '__filename', 'document', 'window', 'navigator', 'localStorage',
  'sessionStorage', 'location', 'history', 'alert', 'confirm', 'prompt', 'Image',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'Node', 'Element',
  'HTMLElement', 'DocumentFragment', 'performance', 'WebSocket', 'Audio', 'Intl',
  'super', 'this', 'arguments', 'undefined', 'null', 'true', 'false',
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (path.endsWith('.js') || path.endsWith('.mjs')) yield path;
  }
}

/** Names this module brings into scope, however they got there. */
function declaredNames(text) {
  const names = new Set();

  // import x, {a, b as c}, * as ns from '...'
  for (const m of text.matchAll(/import\s+([^'"]+?)\s+from\s*['"]/g)) {
    const clause = m[1];
    for (const n of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const part of n[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
    const bare = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s*as\s+(\w+)/g, (_, n) => { names.add(n); return ''; });
    for (const part of bare.split(',')) {
      const name = part.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }

  // Declarations at any depth: what matters is whether the name exists at all.
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // Destructuring, parameters and catch bindings.
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Anything that appears as a parameter somewhere in the file.
  for (const m of text.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^\.\.\./, '').split('=')[0].split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of text.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // Destructured parameters: `({ close, save }) => ...`, `function f({ a, b })`.
  for (const m of text.matchAll(/\(\s*\{([^}]*)\}\s*(?:=[^)]*)?\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Object-literal and class method shorthand: `close() { ... }`.
  for (const m of text.matchAll(/(?:^|[,{;)]|\bstatic\b|\basync\b|\bget\b|\bset\b|\*)\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) names.add(m[1]);
  // A property holding a function: `{ onClick: () => ... }` / `foo.bar = () =>`.
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/g)) names.add(m[1]);
  for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  return names;
}

/** Strip what must not be scanned: strings, template literals, comments, regexes. */
function stripNoise(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

const problems = [];

for (const dir of ROOTS) {
  for await (const file of walk(join(root, dir))) {
    const raw = await readFile(file, 'utf8');
    const text = stripNoise(raw);
    const declared = declaredNames(raw);
    const rel = file.slice(root.length + 1);
    const seen = new Set();

    // Only direct calls: `foo(` not preceded by a dot, `new`, or a keyword.
    for (const m of text.matchAll(/(^|[^\w$.?#])([a-z_$][\w$]*)\s*\(/gm)) {
      const name = m[2];
      // `async (` opens an arrow function; `?.name(` is a property call.
      if (name === 'async') continue;
      if (seen.has(name) || declared.has(name) || GLOBALS.has(name)) continue;
      if (/^(if|for|while|switch|catch|return|typeof|void|delete|await|yield|function|new|in|of|do|else|case|throw|import|export|async|instanceof)$/.test(name)) continue;
      seen.add(name);
      problems.push(`${rel}: ${name}() is called but never defined or imported`);
    }
  }
}

if (problems.length) {
  console.error(`\n  ${problems.length} undefined reference(s):\n`);
  for (const p of problems) console.error(`    ${p}`);
  console.error('');
  process.exit(1);
}
console.log('  Every called identifier is defined or imported.');
