# Deployment

From an empty Cloudflare account to a running deployment.

## What you need

- A Cloudflare account with Workers, D1 and R2 enabled
- Node 22 or newer (the tests use `node:sqlite`)
- `npx wrangler login`

## 1. Create the bindings

```bash
npx wrangler d1 create meetmillions_crm
npx wrangler r2 bucket create meetmillions-crm-documents
npx wrangler r2 bucket create meetmillions-crm-documents-preview
npx wrangler kv namespace create CACHE
```

Each command prints an id. Put them in `wrangler.jsonc`, replacing the
placeholder `database_id` and the KV namespace id.

## 2. Set the three required secrets

```bash
openssl rand -base64 48 | npx wrangler secret put AUTH_SECRET
openssl rand -base64 32 | npx wrangler secret put ENCRYPTION_KEY
openssl rand -base64 32 | npx wrangler secret put FILE_SIGNING_SECRET
```

Three separate keys with three separate jobs: signing sessions, encrypting
stored credentials, signing file links. Rotating one should not force rotating
the others, which is only true if they are actually different.

Nothing else is required. Every integration degrades to **Not Connected**, and
the CRM works without any of them.

## 3. Migrate

```bash
npm run db:migrate:remote
```

Migrations apply in filename order. `npm run db:check` applies all of them to an
in-memory SQLite first and runs a foreign-key check, which is worth doing before
a deployment stops half way through.

## 4. Deploy

```bash
npm run check      # build checks and the full test suite
npm run deploy
```

## 5. Create the first Super Admin

There is no default account and no default password. Set two secrets, make one
request so the Worker boots, then clear them:

```bash
echo -n 'you@example.com'          | npx wrangler secret put PLATFORM_OWNER_EMAIL
echo -n '<a long random password>' | npx wrangler secret put PLATFORM_OWNER_PASSWORD

curl -s https://<your-worker>/ready

npx wrangler secret delete PLATFORM_OWNER_EMAIL
npx wrangler secret delete PLATFORM_OWNER_PASSWORD
```

`/ready` is what seeds a fresh deployment. A Worker has no deploy hook, so the
permissions, roles, plans and add-on catalogue are written on the first request
that reaches the Worker; `/ready` is that request made deliberately, and it
reports what it did. `/health` is separate on purpose: it answers without
touching the database, so it stays truthful about the Worker when D1 is the
thing that is broken.

The account is created only if no Super Admin exists, only if the password is at
least 12 characters, and always with `must_change_password` — so sign in and
change it immediately.

## 6. Add the vendors you actually have

`Settings → Integrations`, in the application, shows every provider, whether it
is connected, and exactly which environment variables are missing. Add each with
`wrangler secret put`, then press **Test connection**: it makes a real call
against the vendor rather than reporting itself as configured.

`.env.example` documents every variable.

## Cron

`wrangler.jsonc` declares three triggers — every 15 minutes, daily at 03:00 UTC
and Mondays at 09:00 UTC. They are created on deploy. What each one runs is in
[architecture.md](architecture.md#scheduled-work).

## Custom domains

`Settings → Branding` can point an organisation at its own domain, using the
Cloudflare API (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`). Without those the
screen says the feature is not configured, and the rest of branding — logo,
colours, sender names — still works.

## Backups

`Settings → Backup & Restore` exports an organisation's data as JSON, and the
documents as a manifest of R2 keys. Restoring is deliberately a two-step
confirmation, because restoring over live data is not something to do by
accident.

D1 has its own time-travel restore, which is the right tool for
"the whole database, half an hour ago"; this export is for
"this one organisation's records, in a format somebody else can read".

## Rolling back

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

A rollback reverts the Worker, not the database. A migration that has run stays
run — which is why migrations are only ever added, never edited.
