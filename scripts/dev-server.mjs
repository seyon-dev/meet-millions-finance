/**
 * A local development server.
 *
 * Runs the real Worker `fetch` handler over the same in-memory D1/R2/KV shims
 * the tests use, and serves `public/` for everything else. That makes the
 * browser talk to the actual API — the same routing, the same permissions, the
 * same responses — rather than to a mock that would drift from it.
 *
 *   node --experimental-sqlite scripts/dev-server.mjs [--port 8787] [--seed]
 *
 * It is a development tool. Production is `wrangler deploy`, which runs the
 * same Worker against real D1, R2 and KV.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';

import worker from '../src/index.js';
import { createTestD1, R2Shim, KVShim } from '../tests/helpers/d1.js';
import { bootstrapPlatform } from '../src/services/bootstrap.js';

const args = process.argv.slice(2);
const port = Number(readFlag('--port') ?? process.env.PORT ?? 8787);
const withSeed = args.includes('--seed');
const publicDir = resolve(new URL('../public', import.meta.url).pathname);

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const env = {
  APP_NAME: 'Meet Millions Finance CRM',
  APP_ENV: 'development',
  APP_URL: `http://localhost:${port}`,
  AUTH_SECRET: 'dev-only-auth-secret-at-least-32-bytes-long-0000',
  ENCRYPTION_KEY: 'dev-only-encryption-key-at-least-32-bytes-000',
  FILE_SIGNING_SECRET: 'dev-only-file-signing-secret-32-bytes-00000',
  SESSION_TTL_HOURS: '12',
  UPLOAD_MAX_BYTES: String(50 * 1024 * 1024),
  AUDIT_RETENTION_DAYS: '2555',
  DEMO_MODE: 'true',
  DB: createTestD1(),
  DOCS: new R2Shim(),
  CACHE: new KVShim(),
};

const pending = [];
const executionCtx = {
  waitUntil: (p) => pending.push(Promise.resolve(p).catch(err => {
    console.warn('deferred work failed:', err.message);
  })),
  passThroughOnException: () => {},
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/** Paths the Worker owns. Everything else is a static file or the SPA shell. */
function isWorkerPath(pathname) {
  return pathname.startsWith('/api/')
    || pathname.startsWith('/webhooks/')
    || pathname.startsWith('/files/')
    || pathname === '/health';
}

await bootstrapPlatform(env);
if (withSeed) await seed();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  try {
    if (isWorkerPath(url.pathname)) {
      await handleWorker(req, res, url);
      return;
    }
    await handleStatic(res, url.pathname);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { message: err.message } }));
  }
});

async function handleWorker(req, res, url) {
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  // The Worker reads the caller's address from this header, which the runtime
  // sets in production.
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', '127.0.0.1');

  const request = new Request(url, { method: req.method, headers, body });
  const started = Date.now();
  const response = await worker.fetch(request, env, executionCtx);

  while (pending.length) await Promise.allSettled(pending.splice(0));

  const outHeaders = {};
  response.headers.forEach((value, key) => { outHeaders[key] = value; });
  res.writeHead(response.status, outHeaders);

  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();

  const ms = Date.now() - started;
  const mark = response.status >= 500 ? '✖' : response.status >= 400 ? '·' : '✓';
  console.log(`${mark} ${req.method.padEnd(6)} ${url.pathname}${url.search} → ${response.status} (${ms}ms)`);
}

async function handleStatic(res, pathname) {
  // Normalised and stripped of its leading slash so "/../" cannot escape the
  // public directory and the prefix test below compares like with like.
  const relative = normalize(pathname).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '');
  let filePath = join(publicDir, relative);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info) {
    // A missing file under /assets is a 404, not the SPA shell. Falling
    // through would hand the browser index.html with a text/html type, and a
    // missing module would surface as a MIME error instead of the 404 it is.
    if (relative.startsWith('assets/')) {
      console.log(`✖ GET    ${pathname} → 404 (no such file)`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // Any other unknown path is a client route, which is what
    // not_found_handling: "single-page-application" does in production.
    filePath = join(publicDir, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info) { res.writeHead(404).end('Not found'); return; }
  }

  const content = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(content);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A demonstration organisation, so the screens have something to show. */
async function seed() {
  const { seedDemoData } = await import('./seed-demo.mjs');
  const result = await seedDemoData(env);
  console.log('\nDemo organisation seeded.');
  console.log(`  Sign in:   ${result.email}`);
  if (result.platformEmail) console.log(`  Platform:  ${result.platformEmail}`);
  console.log(`  Password:  ${result.password}\n`);
}

server.listen(port, () => {
  console.log(`\n  Meet Millions Finance CRM — development server`);
  console.log(`  http://localhost:${port}\n`);
  console.log(`  The API is the real Worker. Data is in memory and resets on restart.`);
  if (!withSeed) console.log(`  Pass --seed for a demonstration organisation.\n`);
});
