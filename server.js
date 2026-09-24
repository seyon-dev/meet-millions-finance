/**
 * The Node.js entry point.
 *
 * Hostinger runs this. It is what `npm start` starts.
 *
 * Why Express sits in front of the existing handler rather than replacing it
 * -------------------------------------------------------------------------
 * The application is 325 routes, seven roles and 137 permissions written
 * against the Web platform's Request and Response — `worker.fetch(request,
 * env, ctx)`. Node 18+ implements both natively. So the migration off
 * Cloudflare does not require rewriting a single route: it requires giving
 * that handler a Node server, a database, a filesystem and a scheduler.
 *
 * Rewriting 325 routes into Express handlers would have meant re-deriving
 * every permission check and every tenant scope by hand, with the test suite
 * unable to tell me whether I had changed behaviour. This way the tests keep
 * exercising the same code that serves production.
 *
 * What changes, and where:
 *
 *   env.DB      → src/db/mysql.js          (a D1-shaped binding over mysql2)
 *   env.DOCS    → src/storage/filesystem.js (an R2-shaped binding over a directory)
 *   env.ASSETS  → express.static           (below)
 *   cron        → node-cron                (below, calling worker.scheduled)
 */

import express from 'express';
import compression from 'compression';
import cron from 'node-cron';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { isWorkerPath } from './src/index.js';
import { createMysqlBinding, closePool } from './src/db/mysql.js';
import { createFilesystemStorage } from './src/storage/filesystem.js';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(here, 'public');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Everything the application reads off `env`.
 *
 * On Workers this was the bindings object; here it is the process
 * environment plus the two bindings built below. Passing process.env through
 * unchanged means every integration variable keeps the name it already has.
 */
async function buildEnv({ db = null, storage = null } = {}) {
  const env = { ...process.env };

  // Injectable so the server can be exercised end to end in tests against the
  // same SQLite binding the rest of the suite uses. Production passes neither
  // and gets MySQL and the filesystem.
  env.DB = db ?? createMysqlBinding(process.env);
  env.DOCS = storage ?? await createFilesystemStorage(process.env);

  // KV was always optional — src/services/ratelimit.js falls back to the
  // durable rate_limits table in the database, which is exact rather than
  // eventually consistent. Nothing else read it, so there is nothing to
  // replace.
  env.CACHE = undefined;

  return env;
}

/**
 * Refuse to serve documents from inside the web root.
 *
 * On Cloudflare this could not happen: an R2 bucket is not a directory the
 * server serves. On a filesystem it can, and it would put every client's tax
 * documents one guessed URL away.
 */
function assertStorageIsPrivate(storageRoot) {
  const root = resolve(storageRoot);
  if (root === PUBLIC_DIR || root.startsWith(PUBLIC_DIR + sep)) {
    throw new Error(
      `STORAGE_ROOT (${root}) is inside the directory this server publishes (${PUBLIC_DIR}). `
      + 'Every uploaded document would be downloadable without signing in. '
      + 'Point STORAGE_ROOT somewhere outside the application directory.');
  }
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/** An Express request as a Web Request, which is what the handler expects. */
function toWebRequest(req) {
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const url = `${proto}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, String(value));
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method);

  return new Request(url, {
    method: req.method,
    headers,
    // req is a readable stream; handing it over unbuffered keeps a large
    // upload off the heap. duplex is required when a stream is the body.
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
    redirect: 'manual',
  });
}

/** Copy a Web Response back onto the Express response. */
async function sendWebResponse(res, response) {
  res.status(response.status);
  for (const [key, value] of response.headers) res.setHeader(key, value);

  if (!response.body) { res.end(); return; }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------

/**
 * The three Cloudflare cron triggers, as node-cron schedules.
 *
 * The handler is unchanged: `worker.scheduled({ cron }, env, ctx)` receives
 * the same cron string it received from Cloudflare, and selectJobs in
 * src/services/scheduler.js matches on it exactly as before.
 *
 * Cloudflare guaranteed one invocation across the fleet. A single Node process
 * gives the same guarantee for free; running more than one instance of this
 * app would not, which is why docs/hostinger-deployment.md says to run one,
 * and why RUN_SCHEDULER exists to turn it off on any additional instance.
 */
const CRON_SCHEDULES = ['*/15 * * * *', '0 3 * * *', '0 9 * * 1'];

function startScheduler(env) {
  if (String(process.env.RUN_SCHEDULER ?? 'true') === 'false') {
    console.log('  scheduler  disabled (RUN_SCHEDULER=false)');
    return [];
  }

  const tasks = [];
  for (const schedule of CRON_SCHEDULES) {
    tasks.push(cron.schedule(schedule, async () => {
      const started = Date.now();
      try {
        await worker.scheduled({ cron: schedule, scheduledTime: Date.now() }, env, {
          waitUntil: (p) => Promise.resolve(p).catch(() => {}),
          passThroughOnException: () => {},
        });
        console.log(`  cron ${schedule} finished in ${Date.now() - started}ms`);
      } catch (err) {
        // A failed pass must not stop the next one.
        console.error(`  cron ${schedule} failed:`, err?.message ?? err);
      }
    }, { timezone: process.env.CRON_TIMEZONE ?? 'UTC' }));
  }

  console.log(`  scheduler  ${tasks.length} cron schedules (${process.env.CRON_TIMEZONE ?? 'UTC'})`);
  return tasks;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export async function createServer({ db = null, storage = null } = {}) {
  assertStorageIsPrivate(process.env.STORAGE_ROOT ?? join(here, '..', 'mm-storage'));

  const env = await buildEnv({ db, storage });
  const app = express();

  // Behind Hostinger's proxy: without this, req.protocol is http and every
  // generated link and secure-cookie decision is wrong.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(compression());

  // Liveness, before anything that touches the database — so a health check
  // still answers when the database is the thing that is broken.
  app.get('/healthz', (_req, res) => res.json({ ok: true, at: new Date().toISOString() }));

  // The application: /api, /webhooks and /files go to the Worker handler.
  // Body parsing is deliberately NOT installed — the handler reads the body
  // itself, and consuming it here would empty the stream before it arrives.
  app.use(async (req, res, next) => {
    // The Worker's own predicate, imported rather than re-expressed: /health
    // and /ready live outside /api/, and a second copy of the rule drifts.
    if (!isWorkerPath(req.path)) return next();
    try {
      const response = await worker.fetch(toWebRequest(req), env, {
        waitUntil: (p) => Promise.resolve(p).catch((err) => {
          console.error('  deferred work failed:', err?.message ?? err);
        }),
        passThroughOnException: () => {},
      });
      await sendWebResponse(res, response);
    } catch (err) {
      console.error('  request failed:', err?.stack ?? err);
      if (!res.headersSent) {
        res.status(500).json({
          success: false, data: null,
          error: { code: 'internal_error', message: 'Something went wrong on our side.' },
        });
      } else {
        res.end();
      }
    }
  });

  // Static assets, and the SPA fallback. This replaces the ASSETS binding;
  // the security headers the Worker attached to a document are applied here
  // for the same reason — see src/http/security.js.
  const { documentCsp, BASE_SECURITY_HEADERS, hstsFor } = await import('./src/http/security.js');

  app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    maxAge: '1h',
    setHeaders: (res) => {
      for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(k, v);
    },
  }));

  // Anything else is an SPA route: serve the shell and let the client router
  // decide. A missing index.html is a broken deployment, not a 404.
  const indexPath = join(PUBLIC_DIR, 'index.html');
  app.use((req, res) => {
    if (!existsSync(indexPath)) {
      res.status(500).type('text').send('public/index.html is missing from this deployment.');
      return;
    }
    const url = new URL(`${req.protocol}://${req.headers.host ?? 'localhost'}${req.originalUrl}`);
    for (const [k, v] of Object.entries(BASE_SECURITY_HEADERS)) res.setHeader(k, v);
    for (const [k, v] of Object.entries(hstsFor(url))) res.setHeader(k, v);
    res.setHeader('Content-Security-Policy', documentCsp({ appUrl: process.env.APP_URL }));
    res.type('html').send(readFileSync(indexPath, 'utf8'));
  });

  return { app, env };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Guard against starting twice.
 *
 * `start()` can be reached two ways — `node server.js` directly, or the
 * CommonJS bootstrap in server.cjs — and binding the port, the cron schedules
 * and the database pool twice in one process would be a mess that only shows
 * up under load. Holding the promise makes a second call a no-op that returns
 * the first result.
 */
let starting = null;

/**
 * Boot the application: build the server, start the scheduler, listen.
 *
 * Exported rather than left inline because server.cjs has to be able to call
 * it. When this file is loaded through `import()` from the bootstrap,
 * `process.argv[1]` is server.cjs, so the isMain check below is false and
 * nothing would start on its own.
 */
export async function start() {
  if (starting) return starting;

  starting = (async () => {
    // Optional, off by default. It exists because a managed host may not give
    // you a shell: the build step can reach the repository but not always the
    // database, while the application certainly can — it cannot serve a
    // request otherwise. Running the migration here is the one place that is
    // guaranteed to have both the credentials and the network.
    //
    // Guarded by the same schema_migrations table the CLI uses, so a second
    // instance finds nothing to do. Run one instance, or leave this off and
    // migrate from the build step.
    if (String(process.env.AUTO_MIGRATE ?? 'false') === 'true') {
      console.log('  migrate    AUTO_MIGRATE=true — checking the schema');
      const { runMigration } = await import('./scripts/migrate-runner.mjs');
      const result = await runMigration();
      console.log(`  migrate    ${result.message}`);
      if (!result.ok) {
        // A schema that did not apply means the application cannot work.
        // Refusing to listen is better than answering 500 on every request.
        throw new Error(`The database schema could not be applied: ${result.message}`);
      }
    }

    const { app, env } = await createServer();

    // Demonstration data, for the same reason AUTO_MIGRATE exists: a managed
    // host may give you no shell, so `npm run seed` is not something you can
    // run. Without this there is no way to get the demonstration organisation
    // onto such a deployment at all.
    //
    // Off by default, and refuses the repository's published password on a
    // production database — the demonstration set includes a Super Admin who
    // can see every organisation, so seeding it behind a password anyone can
    // read hands the platform to whoever has read this repository.
    // scripts/seed-guard.mjs decides; the same rule the CLI uses.
    if (String(process.env.SEED_DEMO ?? 'false') === 'true') {
      const { decideSeed } = await import('./scripts/seed-guard.mjs');
      const decision = decideSeed({ argv: [], env: process.env });

      if (!decision.allowed) {
        // Not fatal: the application works, it simply has no demonstration
        // data. Refusing to listen over this would take a working deployment
        // down for the sake of sample rows.
        console.warn('  seed       refused — ' + decision.message.split('\n')[0]);
        console.warn('  seed       set DEMO_PASSWORD, or SEED_DEMO_ACCEPT_RISK=true, and restart.');
      } else {
        try {
          // The catalogue first. Demonstration data provisions a tenant, which
          // assigns its owner the `admin` role — and roles are seeded by the
          // bootstrap, which does not run until the first request arrives.
          // This block runs before the server listens, so on a database that
          // has never served a request the roles are simply not there yet and
          // the insert fails on a null role_id. Both are idempotent.
          const { ensureBootstrapped } = await import('./src/services/bootstrap.js');
          await ensureBootstrapped(env);

          const { seedDemoData } = await import('./scripts/seed-demo.mjs');
          const result = await seedDemoData(env);
          if (result.reused) {
            console.log('  seed       the demonstration organisation is already here; nothing written');
          } else {
            console.log(`  seed       created — ${result.clients} clients, ${result.staff} staff`);
            console.log(`  seed       sign in as ${result.email}`);
            console.log(`  seed       platform owner ${result.platformEmail}`);
            console.log('  seed       set SEED_DEMO=false and restart once you have signed in');
          }
        } catch (err) {
          // Same judgement: sample data failing is not a reason to refuse
          // every real request.
          console.error('  seed       failed:', err?.message ?? err);
        }
      }
    }

    const tasks = startScheduler(env);

    const server = app.listen(PORT, HOST, () => {
      console.log(`\n  Meet Millions Finance CRM`);
      console.log(`  listening  http://${HOST}:${PORT}`);
      console.log(`  app url    ${process.env.APP_URL ?? '(APP_URL is not set)'}`);
      console.log(`  database   ${process.env.DB_NAME}@${process.env.DB_HOST}`);
      console.log(`  storage    ${resolve(process.env.STORAGE_ROOT)}\n`);
    });

    // Finish in-flight requests before exiting, so a deploy does not cut off
    // somebody's upload.
    const shutdown = async (signal) => {
      console.log(`\n  ${signal} — shutting down`);
      for (const task of tasks) task.stop();
      server.close(async () => {
        await closePool().catch(() => {});
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 15000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    return { app, env, server, tasks };
  })();

  return starting;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // Deliberately NOT `await start()`. A top-level await anywhere in this
  // module's graph makes the whole graph un-`require()`-able, and Hostinger's
  // runtime loads the configured entry file with require() — which is exactly
  // the ERR_REQUIRE_ASYNC_MODULE that took the deployment down. A promise
  // chain does the same job and leaves the module synchronous to load.
  start().catch((err) => {
    // Configuration failures name what is missing; anything else is a bug.
    console.error(`\n  The server could not start.\n\n    ${err.message}\n`);
    process.exit(1);
  });
}

export default { createServer, start };
