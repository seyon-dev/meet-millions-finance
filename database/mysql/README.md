# Incremental MySQL migrations

`database/mysql-schema.sql` is a **baseline**: every migration up to the point
it was generated, squashed into one file. A fresh database gets that.

A database that already has the baseline cannot receive a regenerated baseline
— it would try to create tables that exist. So any migration added *after* the
baseline needs its own file here, and `npm run migrate` applies them in
filename order, once each.

## Adding one

1. Write the SQLite migration in `database/migrations/` as usual — that is what
   the tests run against and it stays the source of truth.
2. Write the MySQL equivalent here, named so its first four characters match:
   `0013_whatever.sql`.
3. Regenerate the baseline so a fresh database still gets everything:
   `npm run schema:mysql`.

`npm run migrate` **refuses to run** if it finds a migration in
`database/migrations/` that is neither in the baseline nor here — otherwise a
new table would silently never be created on an existing database, and the
application would fail against a schema that looked applied.

## Rules

- Additive only. No `DROP TABLE`, no `TRUNCATE`, no `DELETE`.
- To remove a column, stop using it. Dropping it breaks a running instance
  mid-deploy.
- MySQL has no transactional DDL: a file that fails halfway leaves what it
  already did. Keep each one small.
