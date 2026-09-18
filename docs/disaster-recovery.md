# Disaster recovery

The proposal (p.23) promises "a documented recovery plan to minimise downtime
and data loss". This is that document.

It is written to be followed under pressure by somebody who did not build the
system. Every command here can be run from a laptop with `wrangler` installed
and access to the Cloudflare account.

---

## What can be lost, and what protects it

| Asset | Lives in | Protected by | Worst-case loss |
| --- | --- | --- | --- |
| Client records, documents metadata, tax, reports, invoices, audit trail | **D1** | Cloudflare Time Travel (30 days, automatic) | Up to the last bookmark — minutes |
| Uploaded documents, reports, recordings, voice notes | **R2** | Durability is Cloudflare's; there is **no second copy by default** | Everything, if a bucket is deleted |
| Rate-limit counters | **KV** (optional) or D1 | Nothing — they are disposable | Nothing that matters |
| Secrets | Cloudflare secret store | **Not recoverable** — they are write-only | Must be regenerated |
| Application code | GitHub | Git history | Nothing |
| Per-organisation exports | R2 + whatever the firm downloads | `Settings → Backup & Restore` | Depends on the firm's own retention |

**The honest gap:** R2 has no automatic second copy. Cloudflare's durability
protects against hardware failure, not against somebody deleting a bucket or
against a bug that overwrites objects. Item 4 under *Improving this plan* is
the fix, and it is not yet implemented.

---

## Recovery time and point objectives

These are what the current architecture actually supports — not aspirations.

| Scenario | RTO (time to recover) | RPO (data lost) |
| --- | --- | --- |
| Bad deploy | **2 minutes** — `wrangler rollback` | None |
| Bad migration or data corruption | **15–30 minutes** — D1 Time Travel | Minutes |
| Accidental delete inside the app | **Minutes** — most deletes are soft | None |
| D1 database deleted | **1–2 hours** — restore from the most recent export | Up to 24 hours |
| R2 bucket deleted | **Not recoverable today** | Everything since the last manual export |
| Whole Cloudflare account lost | **1 day** — rebuild from Git + exports | Up to 24 hours |

---

## 1. A bad deployment

Symptom: the Worker is up but wrong — errors on every request, a broken screen,
a bad migration behind a feature.

```bash
npx wrangler deployments list
npx wrangler rollback <deployment-id>
```

Takes seconds and needs no coordination. **A rollback reverts the Worker, not
the database** — a migration that has run stays run. That is why migrations are
only ever added, never edited: every migration must be safe to leave in place
while the code that used it is rolled back.

If the migration itself is the problem, roll the Worker back first (stop the
bleeding), then use Time Travel below.

---

## 2. Data corruption or a bad migration — D1 Time Travel

D1 keeps a continuous 30-day history. You do not need a backup to have been
taken; it is always there.

```bash
# Find a point before the damage
npx wrangler d1 time-travel info meetmillions_crm --timestamp=2026-09-18T12:00:00Z

# Look before you leap — restore into a scratch database first
npx wrangler d1 time-travel restore meetmillions_crm --timestamp=2026-09-18T12:00:00Z
```

**Before restoring, write down the current bookmark.** A restore is itself a
change, and this is how you undo the undo:

```bash
npx wrangler d1 time-travel info meetmillions_crm    # note the bookmark FIRST
```

After any restore, run:

```bash
npm run db:check                      # migrations still apply cleanly
npx wrangler d1 execute meetmillions_crm --remote \
  --command "SELECT COUNT(*) FROM tenants; SELECT COUNT(*) FROM documents;"
```

Then verify the audit chain from inside the app: **Audit Logs → Verify the
chain**. A restore rewinds the chain; it should still verify as internally
consistent. If it reports a break, the restore landed mid-write and you should
restore to a slightly earlier point.

---

## 3. Something was deleted inside the application

Most deletion in this system is soft — `deleted_at` is set and the row stays.
Check before reaching for Time Travel:

```bash
npx wrangler d1 execute meetmillions_crm --remote \
  --command "SELECT id, display_name, deleted_at FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 20;"
```

Undeleting is a single update. Do it through a support ticket and record why —
the audit trail should say who asked.

**Hard deletes**, which Time Travel is the only recourse for: voice notes,
folder mappings, and API keys.

---

## 4. R2 objects lost

There is no automatic second copy. What exists:

- **The manifest.** `Settings → Backup & Restore` exports every R2 key for an
  organisation alongside its records, so you can tell exactly what is missing.
- **Re-collection.** Documents can be re-requested from clients. The query
  thread on each document says what was asked for.

To export the objects themselves, today, run this per bucket and keep the
output somewhere else:

```bash
npx wrangler r2 object get meetmillions-crm-documents/<key> --file ./restore/<key>
```

This is a genuine weakness. See *Improving this plan*.

---

## 5. Secrets lost or leaked

Secrets are write-only: Cloudflare will never show you a value again. If one is
lost or exposed, regenerate it — and know what breaks:

| Secret | Regenerating it means |
| --- | --- |
| `AUTH_SECRET` | **Every session is invalidated.** Everybody signs in again. No data loss. |
| `ENCRYPTION_KEY` | **Do not regenerate casually.** TOTP seeds and stored OAuth tokens become undecryptable: every user must re-enrol 2FA and every OAuth account must be relinked. |
| `FILE_SIGNING_SECRET` | Outstanding share links stop working. Nothing else. |
| Any vendor key | That vendor reports Not Connected until replaced. The CRM core keeps working. |

```bash
openssl rand -base64 48 | npx wrangler secret put AUTH_SECRET
```

On a suspected compromise, rotate `AUTH_SECRET` **first** — it ends every
active session, including the attacker's.

---

## 6. Total loss of the Cloudflare account

```bash
# 1. New account, then recreate the resources
npx wrangler d1 create meetmillions_crm
npx wrangler r2 bucket create meetmillions-crm-documents

# 2. Paste the new database_id into wrangler.jsonc, then
npm run db:migrate:remote

# 3. Re-set every secret (see docs/deployment.md)

# 4. Deploy and seed the catalogue
npm run deploy
curl -s https://<worker>/ready

# 5. Restore each organisation from its export, via Settings → Backup & Restore
```

Expect a day, and expect to lose whatever happened since the last export. This
is the scenario the offsite export in *Improving this plan* exists to shorten.

---

## Rehearsing this

A recovery plan nobody has run is a document, not a plan. Quarterly:

1. Restore D1 Time Travel into a scratch database and run `npm run db:check`.
2. Export one organisation, delete it in a staging deployment, restore it, and
   confirm the document count and audit chain match.
3. Roll back a deployment in staging and time it.
4. Confirm somebody other than the author can follow this document.

Record the date and the measured times at the bottom of this file. A plan with
no rehearsal dates is one that has not been rehearsed.

| Date | Scenario rehearsed | Measured RTO | By |
| --- | --- | --- | --- |
| _(not yet rehearsed)_ | | | |

---

## Improving this plan

In the order they reduce the most risk:

1. **Offsite R2 replication.** A scheduled job copying new objects to a second
   bucket in another account, or to S3. Closes the only unrecoverable
   scenario. **Not implemented.**
2. **A nightly export to cold storage.** The backup export exists and runs on
   demand; nothing schedules it or moves it off the account. **Not
   implemented.**
3. **Off-database audit anchoring.** The nightly anchor closes tail truncation,
   but the anchors live in the database they protect. Writing the head hash to
   an append-only store in another account would close the rest. See
   [security.md](security.md#audit-trail). **Partly implemented — anchoring
   runs nightly; the off-database copy does not exist.**
4. **A staging deployment.** Rehearsing on production is not rehearsing.
   `npx wrangler deploy --name meet-millions-finance-staging` is the one-line
   version; a separate D1 and R2 make it real.
