# Production Readiness Audit — Final Report

**Repository:** seyon-dev/meet-millions-finance · **Branch:** main
**Final commit:** `0e364752108a1b0e183ca99e09bc6091d376d4f6` (pushed, `origin/main` confirmed identical)
**Test suite:** 275 passed / 0 failed · **Build:** all checks passed · **UI sweep:** 55 screens × 4 widths clean on SQLite **and** MySQL

---

## 1. How the audit was run

- A 54-agent parallel audit across 7 dimensions (SQL dialect, API contract, auth/RBAC, dead UI, security, migration states, env/docs) with independent adversarial verification of every finding. 26 findings confirmed real, 16 refuted, all confirmed findings fixed.
- Every distinct SQL statement the full test suite emits (677) was captured, translated, and `PREPARE`d against real MariaDB 10.11: **0 failures**.
- All 20 acceptance flows were driven end to end against the MySQL-backed production server (`server.cjs`), not the SQLite test harness.
- Each fix in the final batch was verified behaviourally over HTTP against MySQL, and the step-up flow additionally end-to-end in Chromium.

## 2. Problems found and fixed (by area)

### Database / MySQL dialect (`src/db/dialect.js`, `mysql.js`, `tenancy.js`, `client.js`)
- `?N` numbered placeholders (7 modules) → 500s on MySQL. Rewritten to positional with parameter expansion.
- `LIKE ? ESCAPE '\'` → syntax error under MySQL backslash escaping. Literal-aware backslash doubling.
- `IS ?` / identifier rewrites corrupted string literals — now run outside literals only.
- `strftime('%Y-W%W')` produced `2026-WThursday` on MySQL (weekday name, not week). Per-code mapping table; unmapped codes throw.
- `ORDER BY rowid` fallback (SQLite-only) → `created_at`/`updated_at`/`id`.
- `date('now','-N days')` → bound JS parameter.
- MySQL errnos 1062/1451/1452/4025/3819 map to the same typed 409/422 errors as SQLite.

### Migration system (`scripts/migrate-runner.mjs`, `migration-plan.js`, `mysql-schema.mjs`)
All five database states proven live: **empty** (baseline applies), **crashed import** (resumes: 60 half-imported tables → 116, idempotent), **matching import** (adopted), **divergent** (refused, nothing written), **current** (no-op).
- Generator silently dropped `RENAME COLUMN` (`oauth_states.state` never became `state_hash`); now emitted, unknown ALTERs throw, incremental `0014` repairs imported DBs.
- Per-statement apply with already-applied tolerance (1050/1060/1061/1091 + information_schema probe for renames).
- `migrate:check` (dry-run) wrote adoption records — now gated on adopt **and** resume paths (verified: 0 rows written).
- `0013` creates replacement unique indexes before dropping sentinels — uniqueness never lapses mid-migration.

### Authentication / authorisation
- **Step-up was a dead end**: every `{ stepUp: true }` route hard-failed 15 min after sign-in, and the frontend signed the user out on the 401. New `POST /api/auth/2fa/step-up` (TOTP if enrolled, password otherwise); the org's `step_up_for_sensitive` policy controls enforcement; the SPA shows a "Confirm it is you" prompt and replays the original request. Verified over HTTP and in Chromium.
- **Per-tenant idle timeout** (Settings → Security) now enforced (was env-only). Verified: 2h-idle session → 401, row revoked `idle_timeout`.
- **TOTP replay**: accepted time-step recorded; replayed codes refused at login, enrolment and step-up (all three verified).
- **2FA secret takeover**: `/2fa/setup` refuses while 2FA is enabled (verified 409).
- **Duplicate email across organisations** (possible via invites): login now resolves by password; forgot-password issues a reset per account (both verified with a real cross-tenant duplicate).
- **Session revoke hierarchy**: `DELETE /users/:id/sessions/:sessionId` now applies the same role-level guard as every other user mutation — and the endpoint itself was dead (`.meta?.changes` on an already-unwrapped result made it always 404). Fixed and verified (200, revoked).
- **Role levels**: equal-level assignment allowed (an admin can appoint another admin — verified 201); above-level still refused (suite).

### Security
- **CORS**: `CORS_ORIGINS='*'` reflected the caller's origin with `Allow-Credentials: true`. Now a literal `*` without credentials (verified on preflight and simple responses).
- **Request-body ceiling**: the byte counter used a side `data` listener that switched the socket to flowing mode before the Request reader attached — bridged POST bodies could arrive empty (this broke registration in the server tests). Replaced with a pass-through Transform; 413 verified, streaming intact, all 16 server tests pass.
- **WhatsApp webhook tenant attribution**: unmatched/unattributed inbound events were routed to an arbitrary tenant (`?? candidates[0]`). Now exact business-number match or dropped (both verified: `ignored`, no thread created).
- **Signed URLs**: filename now covered by the HMAC (no Content-Disposition swaps).
- **`/ready`** no longer echoes the platform owner's email on first boot.
- **`UPLOAD_ALLOWED_MIME`** narrows instead of unioning with defaults.
- **Security-policy PATCH**: omitted booleans were written as 0 (any partial PATCH silently disabled enforce-2FA etc.). `bool(null)` → undefined; verified a partial PATCH leaves other flags intact.
- Trust-proxy hop counting, client-IP pinning at the bridge, no secrets/hashes/tokens logged, request-ID on every unexpected error (from earlier phases of this audit, all still green).

### Frontend
- **Modal host click-freeze**: after any dialog, an invisible layer swallowed every click app-wide. Host now hides when empty; router dispatches `mm:teardown`.
- **Step-up 401 = logout**: the `twofa_required` branch was unreachable behind the generic 401 handler. Reordered + prompt + one replay.
- Security settings form never saved (snake_case vs camelCase). API-key modal showed `[object Object]` instead of the one-time secret. Client editor sent dropped field names and refused status values. Subscription screen read non-existent response fields. Calls live-poll died after one navigation. Automation rules got their Edit button. Saved analytics reports now listed/re-runnable/deletable. Clients Export button had pointed at a 404 — the CSV endpoint now exists (scoped, audited, BOM).
- Login/register/reset: show-hide password toggle, loading state, no double submit.
- Landing page: real pricing mirrored from `src/data/plans.js` (locked by `tests/landing-content.test.js`), honest FAQ, `Sign In` / `Create Organisation` / `Super Admin` CTAs — Super Admin goes through the normal sign-in, no shortcut.
- Sidebar Revenue → `/billing/payments`; team search → `/settings/users/:id`; dead `_list.js` removed.

### Emails / seeds / env / docs
- `account.invited` template rewritten to the real flow (login URL + temporary password; old placeholders rendered empty). Bootstrap v2 re-seeds it on deployed DBs.
- Seed system: works without a shell (`npm run seed`), honours `DEMO_PASSWORD`, idempotent, refuses when `SEED_DEMO=false` (flows 17–19 verified earlier).
- `.env.example` / `.dev.vars.example`: Hostinger-first, dead variables removed, `TRUST_PROXY_HOPS` + `MAX_BODY_BYTES` documented; env-docs build check now scans `server.js` (it immediately caught `MAX_BODY_BYTES` undocumented). 105 variables, all documented, checked at build.
- `docs/deployment.md` (legacy script names), `docs/integrations.md` + `docs/hostinger-deployment.md` (telephony provider is a per-org setting, not `TELEPHONY_PROVIDER`), README quickstart (`node --env-file=.env server.cjs`).

## 3. Test / verification results

| Gate | Result |
|---|---|
| Unit/integration suite | **275 / 275 pass** |
| Build checks (`npm run build`) | **pass** (incl. env-docs, migrations, API docs) |
| SQL corpus PREPARE on MariaDB | **677 / 677** |
| 20 acceptance flows on MySQL server | **all pass** (incl. tenant isolation → 404, suspension → 403, role denials, restart, AUTO_MIGRATE, SEED_DEMO once/no-dup/off, `/ready` failing honestly with DB down and recovering) |
| UI sweep SQLite | 55 screens × 4 widths, 0 errors/failed requests/overflow |
| UI sweep MySQL | 55 screens × 4 widths, 0 errors/failed requests/overflow |
| Browser E2E (Chromium) | sign-in, step-up prompt, replay, modal lifecycle, navigation — pass |

**Commits (all pushed):** `c65cb68` dialect · `bb84864` migrations · `00c3bec` auth/authz · `f87cc19` server bridge + endpoints · `f667380` frontend + landing · `0e36475` env/docs.

## 4. VERIFIED / NOT VERIFIED / BLOCKED

**VERIFIED (locally, against real MariaDB + Chromium):** everything in section 3; every fix listed in section 2 that names a verification.

**NOT VERIFIED:**
- Real provider integrations (WhatsApp/Meta, telephony vendors, payment gateways, SES/MSG91) — no live credentials here; only signature verification, config matching and not-configured paths are exercised.
- MySQL 8.x specifically — local verification used MariaDB 10.11; the SQL corpus avoids anything MariaDB-specific, but Hostinger's exact MySQL build was not driven.
- Email delivery end-to-end (templates render and dispatch rows are written; no SMTP here).

**BLOCKED BY EXTERNAL ENVIRONMENT:**
- Anything on the live site (`lightseagreen-herring-635919.hostingersite.com`) — the egress proxy in this workspace refuses that host, so live smoke tests, live migration run and live seeding could not be performed from here. The local MariaDB-backed server stood in for all of it.

I am not claiming "100% working" — the local gates all pass; the Hostinger checklist below is what remains for you.

## 5. Hostinger checklist (manual steps)

1. **Deploy** branch `main` at commit `0e36475` (Node 20+; entry point `server.cjs`; build command `npm install --omit=dev` is enough — no build step required to run).
2. **Environment variables** (hPanel → Node.js app → Environment variables) — minimum set:
   - `DB_HOST`, `DB_PORT`, `DB_NAME` (`u567854538_mmfinace_crm`), `DB_USER`, `DB_PASSWORD`
   - `AUTH_SECRET`, `ENCRYPTION_KEY`, `FILE_SIGNING_SECRET` (long random values; never the `replace-with-` placeholders)
   - `APP_URL=https://<your-domain>`
   - `STORAGE_ROOT=/home/<account>/mm-storage` (outside the published directory — startup refuses otherwise)
   - `TRUST_PROXY_HOPS=1` · `MAX_BODY_BYTES=52428800`
   - `AUTO_MIGRATE=true` (first boot applies/adopts/resumes as needed; it never drops anything)
   - Optional first boot: `PLATFORM_OWNER_EMAIL` + `PLATFORM_OWNER_PASSWORD` (Super Admin), then remove the password variable.
   - Demo data only if wanted: `SEED_DEMO=true` + `DEMO_PASSWORD=<your own>`; set `SEED_DEMO=false` afterwards (seeding is idempotent and refuses when off).
3. **Restart** the app, then check in order:
   - `GET /health` → 200 JSON `{status:"ok"}`
   - `GET /ready` → 200 JSON with `database: ok` and `migrations` current (a 500 here names the real cause with a requestId)
   - `/` (landing), `/login`, `/register` → 200 HTML
4. **Sign in** as the platform owner → Super Admin area; create the first real organisation from `/register` or the platform screens.
5. If you had previously imported the schema by phpMyAdmin: nothing extra to do — the runner adopts it and applies `0013`/`0014` (the `oauth_states.state_hash` rename) automatically on boot.
6. If anything fails on boot, the log names the exact missing variable or the failing migration statement; re-running after fixing is safe by design.
