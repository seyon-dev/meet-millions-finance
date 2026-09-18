# Architecture

## The shape of it

One Cloudflare Worker serves everything: the API, the static single-page
application, signed file downloads and inbound webhooks. There is no origin
server, no container and no build step.

```
Browser ──► Worker (src/index.js)
              ├── /api/*       the API, 34 routers
              ├── /files/*     private bytes, permission-checked or signed
              ├── /webhooks/*  inbound from vendors, signature-verified
              └── everything else → static assets from public/
                                    (single-page-application fallback)
Bindings:  DB → D1 (SQLite)   DOCS → R2   CACHE → KV   Cron → scheduled jobs
```

The front end is vanilla ES modules. Each screen is one module, imported on
demand by the router, so a first paint costs the shell and one screen rather
than an application bundle.

## A request, end to end

1. **`src/index.js`** builds a `Context`: request id, client IP, user agent,
   timing, and a `defer()` for work that should not hold up the response.
2. **Rate limiting** (`services/ratelimit.js`) runs before anything else does
   work. KV is the fast path; the D1 table is the durable fallback so the limit
   still applies if KV is unavailable.
3. **Authentication** (`auth/session.js`) resolves the bearer token or API key
   into a user, their roles, their effective permissions and their company
   scope. Expired per-user overrides are dropped here, not later.
4. **Authorisation** is the route's own `permission` / `anyPermission` option,
   checked before the handler is entered. A handler that forgets is a handler
   that cannot be reached without a permission, because the option is the gate.
5. **The handler** works through a `TenantScope`, which injects `tenant_id` into
   every read and refuses to write a row belonging to another tenant.
6. **The response** is always the same envelope:
   ```json
   { "success": true, "data": {}, "error": null, "meta": { "requestId": "…" } }
   ```
   Errors carry a `code` the front end switches on — `feature_locked`,
   `integration_not_configured`, `validation_failed` — rather than a status code
   it has to interpret.
7. **Deferred work** (notifications, audit writes, activity entries) runs in
   `waitUntil` after the response has gone.

## Multi-tenancy

`TenantScope` is the only way into the database for tenant-owned tables. It

- adds `tenant_id = ?` to every query it builds,
- refuses an insert whose `tenant_id` is not its own,
- refuses to touch a tenant-owned table without a tenant id at all,
- narrows further by company when a user's access is limited to some of an
  organisation's companies.

Crossing tenants requires `platformScope()`. That is one function in one file,
so "which code can see every organisation?" is answered by grep, not by reading
everything.

The platform Super Admin has `tenant_id` NULL — they belong to no organisation.
Endpoints that are meaningful only inside one (the notification feed, the
sidebar badges) answer with an empty result for such an account rather than
constructing a scope that cannot exist.

## Storage

Objects in R2 are never public. The key layout carries the ownership:

```
tenant/{tenantId}/company/{companyId}/client/{clientId}/documents/{documentId}/versions/{versionId}/{filename}
tenant/{tenantId}/voice-notes/{voiceNoteId}/{filename}
tenant/{tenantId}/calls/{callId}/recording.mp3
tenant/{tenantId}/reports/{reportId}/report.pdf
```

Bytes leave through exactly two doors:

- an authenticated request, where the permission is checked against the owning
  record rather than the key; or
- a signed URL with an expiry and an HMAC, for the cases where a link must
  travel — an email attachment, a WhatsApp document. The signature covers the
  key, the tenant prefix and the expiry.

A browser cannot attach an `Authorization` header to `<img>`, `<audio>` or a
navigation, so screens that display private bytes fetch them through the API
client and hand the player or the frame a blob. That is why a document preview
and a voice note both load through JavaScript rather than a plain `src`.

## Scheduled work

Three cron triggers, in `services/scheduler.js`:

| Schedule | Jobs |
| --- | --- |
| every 15 minutes | due reminders, overdue invoices, SLA breaches, call metrics, task reminders |
| daily at 03:00 | open the month's filing periods, flag subscription renewals, apply retention, run scheduled reports, generate nightly insights, retry storage sync |
| Mondays at 09:00 | the weekly digest |

Each job is named, and a failure is written to the system log with its stack and
the cron that triggered it, rather than disappearing.

## Data

Ten migrations, 113 tables. They are applied in filename order and are never
edited once written — a change is a new migration, because an edited migration
is a migration that has already run somewhere.

`npm run build` applies all of them to an in-memory SQLite database and runs
`PRAGMA foreign_key_check`, so a migration that cannot apply is caught before a
deployment stops half way through.

## The front end

- **`core/router.js`** — real URLs, ranked by specificity so `/clients/:id`
  never shadows `/clients`.
- **`core/api.js`** — one envelope, four named errors, upload progress through
  XHR (which `fetch` cannot report), and authorised downloads.
- **`core/dom.js`** — `el()` builds nodes; there is no template string HTML and
  no `innerHTML` with anything that came from the API.
- **`components/table.js`** — a table on a wide screen and a list of cards below
  860px, mutually exclusive rather than one hidden behind the other.
- **`layout/shell.js`** — navigation, badges, company switcher, command palette,
  notifications. Badges are resolved from one endpoint and polled, and a zero
  renders nothing rather than a grey "0".

Charts are inline SVG, drawn from the data. QR codes are generated in
`core/qr.js` — a real ISO/IEC 18004 encoder, verified against reference
matrices, because a QR code that looks right and does not scan is worse than no
QR code at all.
