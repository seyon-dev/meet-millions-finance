# Migrating from Cloudflare to Hostinger

What moved, what did not, and what to check.

## The short version

The application did not change. Its runtime did.

It was written against the Web platform — `Request`, `Response`, `fetch` — and
those exist in Node. So the 325 routes, seven roles, 137 permissions, every
tenant scope and every integration are the same code they were. What was
replaced is the four things Cloudflare supplied underneath them.

| Was | Is now | Where |
| --- | --- | --- |
| Workers runtime | Node.js + Express | `server.js` |
| D1 (SQLite) | MySQL | `src/db/mysql.js` |
| R2 | Filesystem | `src/storage/filesystem.js` |
| Cron triggers | node-cron, in-process | `server.js` |
| ASSETS binding | `express.static` | `server.js` |
| KV | nothing — it was always optional | — |

## Why it was done this way

The alternative was rewriting 325 routes as Express handlers. That would have
meant re-deriving every permission check and every tenant filter by hand, with
the test suite unable to say whether behaviour had changed — the kind of
migration that looks finished and is not.

Instead Express translates a Node request into a `Request`, hands it to the
existing handler, and writes the `Response` back. The application is untouched,
so the tests that pass are testing what actually serves.

```
Express  →  toWebRequest(req)  →  worker.fetch(request, env, ctx)  →  sendWebResponse(res, …)
                                        ↑
                                  unchanged: routing, auth, RBAC,
                                  tenancy, every module
```

## KV

Nothing to migrate. It only ever accelerated rate-limit counters, and
`src/services/ratelimit.js` has always had a complete fallback to the durable
`rate_limits` table — which is exact rather than eventually consistent. The
binding is simply absent.

## Scheduled jobs

The three Cloudflare cron triggers are now three node-cron schedules, calling
the same `worker.scheduled()` handler with the same cron strings. `selectJobs`
in `src/services/scheduler.js` matches on them exactly as before, so which
jobs run when has not changed.

The one behavioural difference: Cloudflare guaranteed a single invocation
across its fleet. One Node process gives that for free; several do not.
`RUN_SCHEDULER=false` turns the scheduler off on additional instances.

## File storage

R2 was private by default and unreachable except through the Worker. A
directory is not. So:

- `STORAGE_ROOT` must be outside the published directory. **The server refuses
  to start otherwise** rather than trusting the configuration.
- Keys are resolved and then checked to be inside the root, so `../` cannot
  escape. The check is on the resolved path, because a string check misses
  symlinks and encodings.
- Files are written `0600`, directories `0700`.
- Nothing is served directly. Downloads still go through `/files`, which
  checks permission and tenant first.

The key scheme already carried tenant isolation, so the directory layout
inherits it:

```
mm-storage/tenant/<tenant>/company/<company>/client/<client>/documents/<doc>/versions/<ver>/<filename>
```

## What Cloudflare files remain, and why

Nothing in production reads them. They are kept because deleting them would
lose the record of how the system was deployed for its first months.

| File | Status |
| --- | --- |
| `wrangler.jsonc` | historical — nothing in the Node path reads it |
| `scripts/preflight-deploy.mjs` | historical — validated Cloudflare resources |
| `scripts/dev-server.mjs` | dev only — the local Worker-style server |
| `docs/deployment.md` | historical — the Cloudflare instructions |
| `npm run legacy:*` | renamed so production never invokes them |

`npm start` does not touch any of them.

## Checking the migration

```bash
npm run check       # build checks and the full test suite
npm start           # with the environment set
```

`tests/server.test.js` drives the real Express server over real HTTP: SPA
routing, static assets, security headers, an authenticated API call, an upload
that lands on disk, a download that comes back, and the two refusals that
matter (a traversing storage key, and a storage root inside the web root).

## What is not verified

**MySQL has not been executed against.** The schema parses cleanly as MySQL 8
and the driver is written against mysql2's documented behaviour, but no MySQL
server was available where this migration was carried out. The test suite runs
on SQLite, which proves the application logic is unchanged — not that the
MySQL dialect translation is complete.

`npm run migrate` on Hostinger is the first real test. See
[mysql.md](mysql.md#what-is-not-verified-here).
