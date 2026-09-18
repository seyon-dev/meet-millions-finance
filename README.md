# Meet Millions Finance CRM

A multi-tenant finance-practice CRM built for Cloudflare Workers: client
onboarding, document collection and verification, GST computation, reports and
sign-off, billing and payments, cloud calling, and thirty enterprise add-ons.

Nothing here is a mock. Every screen reads and writes the real API, every API
route reads and writes D1, and where a third-party vendor has no credentials on
a deployment, the interface says **Not Connected** rather than simulating a
success. See [docs/honesty.md](docs/honesty.md) for what that means in practice
and how it is enforced.

---

## Running it locally

```bash
npm install
npm run dev            # http://localhost:8787, with a demonstration organisation
```

`npm run dev` starts a development server that runs **the real Worker** over a
`node:sqlite` stand-in for D1, an in-memory R2 and an in-memory KV. No
Cloudflare account, no `wrangler login`, no network. Data resets on restart.

It prints two sign-ins:

| Account | What it is |
| --- | --- |
| `asha@meridiantax.example` | Admin of the demonstration practice |
| `devika@meetmillions.example` | Platform Super Admin, above every organisation |

Both use `Demo-Passw0rd!24`. Every record the seed creates is flagged as
demonstration data, and the interface says so in a banner, because a demo that
looks like production is how somebody ends up filing it.

### Against Cloudflare

```bash
cp .dev.vars.example .dev.vars      # fill in what you have; blanks are fine
npm run db:migrate:local
npm run dev:wrangler
```

---

## Checking it

```bash
npm run check        # build checks + the full test suite
npm test             # 101 tests, no network, no browser
npm run build        # the build checks alone
npm run ui-check     # drives real Chromium at 390/768/1280/1440
```

There is no bundler: the Worker runs ES modules directly and `public/` is served
as static assets. `npm run build` therefore verifies what a deploy actually
needs — that every file parses, every migration applies, every registered route
has a screen file, every internal link points at a route that exists, every
permission key is in the catalogue, every CSS variable is defined and every icon
name is in the set. Each of those checks exists because its absence once shipped
something broken.

`npm run ui-check` needs a running dev server. It walks every screen at four
widths and reports console errors, failed requests, horizontal overflow and
stuck skeletons.

---

## How it is put together

```
src/
  index.js          the Worker entry point
  routes.js         every router, mounted
  http/             context, router, responses, errors
  db/               D1 client, tenant scoping, query building
  auth/             passwords, sessions, TOTP, API keys, crypto
  permissions/      the 137-permission catalogue and the seven roles
  modules/          one file per API area (34 of them)
  services/         workflow, billing, notifications, audit, storage, AI, …
  integrations/     one adapter per vendor, behind a common Provider interface
  data/             document types, add-ons, plans, tax rules, triggers
public/
  index.html        the single page
  assets/js/        vanilla ES modules — no framework, no build step
    core/           DOM, router, API client, formatting, icons, QR
    components/     table, filters, uploader, charts, period views
    layout/         shell, navigation, command palette, notifications
    screens/        67 screens, one module each, loaded on demand
  assets/css/       tokens, base, components, layout, screens, app
database/migrations/  10 SQL migrations, 113 tables
tests/                9 suites, 101 tests
```

### The rules the code holds to

- **Tenant isolation is structural.** Every query goes through a `TenantScope`
  that injects `tenant_id`. Stepping outside it requires `platformScope()`,
  which is one function and therefore greppable.
- **Authorisation is enforced on the server.** Hiding a button is a courtesy;
  the route's `permission` option is the control.
- **Money is integer paise.** Never a float.
- **The audit log is hash-chained.** Each entry covers every stored field of
  the last, so an edited row breaks the chain. It cannot prove that the tail
  was not truncated, and [docs/security.md](docs/security.md) says so.
- **Vendors sit behind one interface.** Every provider answers
  `isConfigured()`, `missingKeys()`, `describe()` and `test()`, and returns the
  same envelope. `not_configured` is a first-class result, distinct from
  `failed`.

---

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Request lifecycle, tenancy, storage layout, scheduled jobs |
| [docs/roles.md](docs/roles.md) | The seven roles, what each can reach, and how overrides work |
| [docs/api.md](docs/api.md) | Every route, its permission, and the response envelope |
| [docs/integrations.md](docs/integrations.md) | The thirteen vendors, their keys, and what happens without them |
| [docs/security.md](docs/security.md) | Auth, hashing, encryption, uploads, audit, and the known limits |
| [docs/deployment.md](docs/deployment.md) | From an empty Cloudflare account to a running deployment |
| [docs/honesty.md](docs/honesty.md) | What is real, what is not built, and how to tell |
| [docs/requirements-matrix.md](docs/requirements-matrix.md) | Every requirement from the brief, and where it lives |

---

## Licence

Proprietary. All rights reserved.
