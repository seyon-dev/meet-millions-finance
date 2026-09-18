# MySQL

The application ran on Cloudflare D1, which is SQLite. It now runs on MySQL.
This is what changed, what did not, and how to verify it.

## What the application sees

Nothing. The 123 places that reach the database all do it the same way —
`new Db(ctx.env.DB)` — and `env.DB` is a binding object, not a driver. On
Cloudflare that object was D1. Here it is `src/db/mysql.js`, which presents
the same six methods over a mysql2 pool.

That is why this migration did not require touching route code: the interface
was already the seam. The test suite provides a third implementation of the
same interface over `node:sqlite`, which is the evidence it is a real
abstraction and not a hopeful one.

```
src/db/client.js   the application's query helpers — unchanged
  ↳ env.DB         a D1-shaped binding
      ├─ Cloudflare D1            (historical)
      ├─ src/db/mysql.js          (production)
      └─ tests/helpers/d1.js      (the test suite, over node:sqlite)
```

## The schema

`database/mysql-schema.sql` is **generated** from `database/migrations/*.sql`
by `npm run schema:mysql`. The migrations stay the source of truth, because
they are what the tests build a real database from. A hand-maintained second
copy would drift the first time somebody added a migration and forgot.

```bash
npm run schema:mysql          # regenerate
node scripts/mysql-schema.mjs --check   # is it current? (the build runs this)
```

116 tables, 272 foreign keys, 168 indexes.

### What had to change, and why

**Every primary key.** SQLite does not care how wide a `TEXT` column is;
MySQL cannot index one that is unbounded. All 112 `TEXT PRIMARY KEY` columns —
and every column that references one — become `VARCHAR(64)`. Every id here is
a prefixed ULID of about 30 characters, so 64 is comfortable. The widths are
derived from the foreign-key graph rather than guessed, because MySQL rejects
a foreign key whose type does not match its target exactly.

**Eighteen partial indexes.** SQLite allows `UNIQUE (tenant_id, key) WHERE
tenant_id IS NOT NULL`. MySQL has no such thing, and its unique indexes treat
NULLs as distinct — so the obvious translation would let two platform-level
rows share a key and silently corrupt the shared catalogue of roles,
permissions, plans and document types.

They come in pairs: one for tenant rows, one for platform rows. Each pair
collapses onto a generated column that maps NULL to a sentinel, with a single
unique index over it:

```sql
tenant_id_k VARCHAR(64) AS (IFNULL(tenant_id, '~platform')) STORED,
UNIQUE INDEX roles_uq_tenant_id_k_key (tenant_id_k, `key`)
```

Same rule, enforced by the database. Eleven generated columns replace all
eighteen indexes.

**Two reserved words.** `key` and `trigger` are reserved in MySQL 8 and are
back-quoted. The generator checks every column against the full MySQL 8
keyword list, not just those two, so a column added later called `rank` or
`system` is handled without anybody noticing it needed to be.

**Indexes on TEXT columns** get a 191-character prefix, which is the longest
a utf8mb4 index can cover in one key part.

## Dialect translation at runtime

Eleven statements in the application use SQLite syntax. Rather than rewrite
them — which would mean the test suite no longer exercised the SQL that
ships — `src/db/dialect.js` translates on the way to MySQL:

| SQLite | MySQL |
| --- | --- |
| `INSERT OR IGNORE` | `INSERT IGNORE` |
| `ON CONFLICT (…) DO UPDATE SET x = excluded.y` | `ON DUPLICATE KEY UPDATE x = VALUES(y)` |
| `strftime('%Y-W%W', day)` | `DATE_FORMAT(day, '%Y-W%W')` |
| `col IS ?` | `col <=> ?` |
| `"identifier"` | `` `identifier` `` |

Anything it does not recognise passes through untouched and MySQL rejects it
loudly. A translator that silently "fixes" SQL it does not understand is worse
than one that leaves it alone.

`ON DUPLICATE KEY UPDATE` fires on **any** unique-key collision, where SQLite's
form names the columns. Every use here targets exactly one unique key, so the
behaviour matches — adding a second unique key to one of those tables would
need this revisited.

## Connection handling

`src/db/mysql.js` uses a pool. `DB_POOL_SIZE` defaults to 10, which suits one
Node process; Hostinger caps concurrent connections per database, so raising
it on shared hosting is usually the wrong move.

A dropped pooled connection or a deadlock (`PROTOCOL_CONNECTION_LOST`,
`ER_LOCK_DEADLOCK`, and similar) is retried **once**. A second failure is real
and surfaces rather than looping.

`batch()` runs inside a transaction and rolls back on any error, matching D1,
because the audit chain depends on it.

## Setting it up

See [hostinger-deployment.md](hostinger-deployment.md) for the click-by-click
version. In short:

```bash
# 1. Create a database and user in hPanel → Databases → Management
# 2. Put the four values in the environment
DB_HOST=localhost
DB_NAME=u123456789_meetmillions_crm
DB_USER=u123456789_mm_app
DB_PASSWORD=…

# 3. Create the tables
npm run migrate
```

`npm run migrate` is non-destructive. It creates what is missing, records that
it did, and **refuses to run against a database that already contains tables
it did not create** rather than writing over somebody's data.

### Checking the connection

```bash
npm run migrate:check
```

Reports what it would do without changing anything. If the credentials are
wrong it says so.

## Adopting a database somebody imported by hand

Managed hosting often has no shell, so the only way to create the tables is to
import `database/mysql-schema.sql` through phpMyAdmin. That leaves the schema
correct and complete with nothing recording which migrations it represents.

`AUTO_MIGRATE=true` handles it. Finding tables but no record, it reads the
expected structure out of the baseline file — 116 tables, 1,808 columns, 167
indexes, by name — reads the actual structure out of `information_schema`, and
compares them. If everything expected is present it records the baseline and
every migration folded into it, and runs no DDL at all. The adoption path
executes exactly two kinds of statement: `SELECT` against `information_schema`,
and `INSERT IGNORE INTO schema_migrations`.

If anything is missing it refuses to start and names it. It does not infer
success from the number of tables: a truncated import, an older baseline, or an
unrelated database of a similar size would all satisfy a count and none of them
is this schema.

A database imported from an older baseline is adopted and then brought up to
date with whatever incremental migrations it predates, in the same pass.

The comparison is by name, not by type. A column that exists with the wrong
type is not caught — MySQL normalises types on the way in, so comparing them
reliably means more machinery than the risk warrants for a schema that is
generated rather than hand-edited.

## What is not verified here

The schema is generated and validated against a MySQL 8 parser — all 284
statements parse. It has **not** been executed against a live MySQL server,
because no MySQL was available in the environment this migration was carried
out in.

Parsing is not the same as running. Things a parser cannot catch: a foreign
key whose target index does not exist, a row size exceeding MySQL's 65,535-byte
limit, a generated-column expression MySQL rejects at table creation.

`npm run migrate` against an empty database is the real test, and it is the
first thing to do on Hostinger. It takes under a minute and either prints
`Done. 116 tables.` or names exactly what MySQL objected to.
