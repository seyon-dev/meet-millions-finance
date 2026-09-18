# Security

What is implemented, how it works, and — at the end — what it does not do. The
last section matters most: a security document that lists only strengths is a
security document nobody can act on.

## Authentication

**Passwords** are hashed with PBKDF2-SHA256 at 210,000 iterations (OWASP
guidance for this KDF), with a per-password random salt, stored as
`pbkdf2$<iterations>$<salt>$<hash>`. The iteration count is inside the hash, so
raising it later re-hashes on next sign-in rather than invalidating everybody.
Comparison is constant-time. PBKDF2 rather than Argon2 or scrypt because it is
what the Workers runtime provides natively; the cost is that PBKDF2 is more
GPU-friendly than Argon2id, which is why the iteration count is high.

**Sessions** are opaque tokens signed with HMAC-SHA256 over `AUTH_SECRET`.
The token is not a JWT and carries no claims: it is a key into a `sessions`
row, so revoking a session revokes it immediately rather than waiting for an
expiry to pass. Default lifetime 12 hours, idle timeout 60 minutes, both
configurable per organisation.

**Two-factor** is TOTP (RFC 6238), 30-second step, ±1 window for clock drift.
Seeds are encrypted at rest with AES-GCM. Recovery codes are single-use and
stored hashed. An organisation can require 2FA outright, or require it of
particular roles.

**Failed sign-ins** lock the account after 5 attempts for 15 minutes, by
default and per organisation. "No such user" and "wrong password" return the
same message, so the endpoint does not reveal which addresses exist.

**Sign-in anomalies** — a new device, a new country — raise a notification to
the account holder rather than blocking, unless device approval is switched on.

## Authorisation

Every route declares its permission. The check runs before the handler, so a
handler cannot accidentally be reachable without one. Hiding a button is a
courtesy; the route option is the control. `npm run build` fails if any route
or screen checks a permission key that is not in the catalogue, because a
misspelt key silently hides a control from the people who should have had it.

Tenant isolation is structural rather than remembered: see
[architecture.md](architecture.md#multi-tenancy).

## Data at rest

- Integration credentials, OAuth tokens and TOTP seeds are encrypted with
  AES-GCM under `ENCRYPTION_KEY`, with a random IV per value.
- Documents live in R2 under a tenant-scoped key, never in a public bucket.
- `AUTH_SECRET`, `ENCRYPTION_KEY` and `FILE_SIGNING_SECRET` are separate keys
  with separate jobs, so rotating one does not force rotating the others.

No credential is ever committed. `.env.example` and `.dev.vars.example` contain
empty placeholders and comments, nothing else.

## Uploads

Before a byte is written:

- the filename is sanitised — path separators, control characters and leading
  dots are stripped;
- the extension is checked against a deny list (`exe`, `bat`, `js`, `html`,
  `svg`, `php`, …) **whatever MIME type is claimed**, so a `.exe` renamed to
  `.pdf` is refused, and an `.svg`, which can carry script, is never stored as a
  document;
- the extension is then checked against an allow list;
- the MIME type is checked against an allow list;
- the size is checked against the plan's limit;
- ZIP archives are expanded with a bounded entry count and total size, so a zip
  bomb is refused rather than expanded.

Voice notes have their own, narrower list — audio types only — so widening what
documents accept never quietly widens what the recorder accepts.

## Output

- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Cross-Origin-Opener-Policy: same-origin` and a restrictive
  `Permissions-Policy` on every response.
- The front end builds DOM nodes; text goes in through `textContent`. There is
  no `innerHTML` carrying anything that came from the API.
- Every SQL statement is parameterised. String interpolation into SQL appears
  nowhere in `src/`.

## Rate limiting

Per bucket, per identity (API key, else user, else IP):

| Bucket | Window | Limit |
| --- | --- | --- |
| `auth.login` | 5 min | 10 |
| `auth.register` | 1 hour | 5 |
| `auth.forgot` | 1 hour | 5 |
| `auth.twofa` | 5 min | 10 |
| `documents.upload` | 1 min | 60 |
| API key | 1 min | 120, or the key's own limit |
| everything else | 1 min | 300 |

Sign-in is metered by IP **and** by the email address being attempted, so a
distributed attempt against one mailbox is throttled too.

## Webhooks

Signature first, business logic second. A delivery that fails its signature is
recorded and rejected before anything is read from it. Every webhook is
idempotent on the vendor's own event id. See
[integrations.md](integrations.md#webhooks) for the per-vendor scheme.

## Audit trail

`audit_logs` is hash-chained: each entry stores a SHA-256 over its own fields
plus the previous entry's hash. Editing a row in place breaks every hash after
it, and `verifyChain()` reports the first break. The Advanced Audit Log screen
runs it on demand.

**What the chain does not prove:** it detects modification and insertion, but it
cannot detect truncation of the tail. Somebody with write access to the database
can delete the most recent entries and the remaining chain still verifies.
Detecting that needs the head hash anchored somewhere outside the database —
periodically written to an append-only store — which this system does not yet
do. It is listed in [honesty.md](honesty.md) for that reason.

## The first Super Admin

There is no default account and no default password. The first platform Super
Admin is created from `PLATFORM_OWNER_EMAIL` and `PLATFORM_OWNER_PASSWORD` at
first boot, only when both are set, only when no Super Admin exists, and only if
the password is at least 12 characters. It is created with
`must_change_password`, so the value that configured it does not remain the
password. Clear those variables afterwards.

A product that ships with a default password ships with a way in for everybody
who has read its documentation.

## Known limits

Stated plainly, because knowing them is what makes them manageable:

1. **The audit chain cannot prove tail truncation.** As above.
2. **PBKDF2, not Argon2id.** A runtime constraint. The iteration count
   compensates as far as it can; it does not make PBKDF2 memory-hard.
3. **KV rate limiting is eventually consistent.** A burst arriving at several
   edge locations at once can briefly exceed a limit before the counter
   converges. The durable D1 path is exact and is used for API-key quotas.
4. **No Content-Security-Policy header yet.** The payment gateways each load
   their own SDK from their own CDN, and a CSP that covers all four correctly
   needs testing against each gateway's live checkout before it is turned on.
   Until then the other headers are set and the DOM-building discipline above is
   what limits XSS.
5. **Virus scanning is not implemented.** Uploads are validated by extension,
   MIME and size, and stored privately, but nothing scans their contents. A
   deployment handling untrusted uploads should put a scanner in front of R2.
6. **Sessions are not bound to an IP or device fingerprint.** A stolen token is
   usable until it expires or is revoked. Anomaly alerts notify; they do not
   block.
