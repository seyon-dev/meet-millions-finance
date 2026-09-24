# Deploying on Hostinger

From an empty Hostinger account to a running CRM.

This is written to be followed by somebody who is not a developer. Every step
says what to click, what to type, and how to tell it worked. Where something
can go wrong, it says what the failure looks like.

Set aside about an hour. Most of it is waiting.

---

## Before you start

You need:

- A Hostinger **Cloud Startup** plan (or anything above it)
- The GitHub repository connected to your Hostinger account
- A domain, or Hostinger's temporary one to begin with

You do **not** need Cloudflare, Wrangler, or anything installed on your own
computer.

---

## 1. Create the MySQL database

**hPanel → Databases → Management**

1. Under *Create a New MySQL Database*, fill in:
   - **Database name** — `meetmillions_crm` (Hostinger adds a prefix, giving
     something like `u123456789_meetmillions_crm`; that full name is what you
     need later)
   - **Database username** — `mm_app`
   - **Password** — press *Generate* and **copy it somewhere safe now**.
     Hostinger will not show it again.
2. Press **Create**.

Write down all four values. You will paste them in step 5:

| | Where to find it |
| --- | --- |
| Database name | the full prefixed name in the list |
| Username | the full prefixed username |
| Password | the one you just generated |
| Host | usually `localhost` — the list shows it |

---

## 2. Create the Node.js application

**hPanel → Websites → Add Website → Node.js**

If Hostinger asks you to pick a framework and Express is not offered, choose
**Other**. The settings below are what matter.

| Setting | Value |
| --- | --- |
| Node.js version | **20.x or newer** (22.x is what this is tested on) |
| Application root | leave as the default |
| Application startup file | **`server.cjs`** |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |

> **The startup file must be `server.cjs`, not `server.js`.**
>
> Hostinger's runtime loads the entry file with `require()`. The application
> is ESM, and `require()` of an ESM module fails — on Node 20 with
> `ERR_REQUIRE_ESM`, on Node 22 and 24 with `ERR_REQUIRE_ASYNC_MODULE`. Either
> way every request returns **503 Service Unavailable**.
>
> `server.cjs` is a small CommonJS file that `require()` accepts, and it
> reaches the application through `import()`, which works on every version. It
> contains no application logic — it starts the same server.
>
> Setting `server.js` here is worse than it looks: on newer Node it loads
> without error and then never listens, because the application only starts
> itself when it is the process entry point. The result is a process the host
> believes is healthy, answering nothing.

---

## 3. Connect GitHub

1. In the application's settings, find **GitHub** (sometimes under *Deployment*).
2. Authorise Hostinger if it asks.
3. Choose this repository.
4. Choose the branch: **`main`**.

`main` is the production branch. Every push to it can be deployed from here.

---

## 4. Create the storage folder

Uploaded documents — every client's tax records — are stored as files. They
must live **outside** the folder the website serves, or anyone who guesses a
URL could download them.

**hPanel → Files → File Manager**

1. Go to your home folder (the one containing `domains`, `public_html` and so on).
2. Create a folder called `mm-storage`.
3. Note its full path. It looks like `/home/u123456789/mm-storage`.

The application refuses to start if you point it at a public folder, so a
mistake here stops the deployment rather than quietly exposing documents.

---

## 5. Set the environment variables

**In the Node.js application → Environment variables.**

Add each of these. `.env.example` in the repository lists every variable the
application understands; these are the ones it cannot start without.

| Variable | What to put |
| --- | --- |
| `NODE_ENV` | `production` |
| `APP_URL` | your real address, e.g. `https://crm.yourfirm.in` — no trailing slash |
| `DB_HOST` | from step 1 (usually `localhost`) |
| `DB_PORT` | `3306` |
| `DB_NAME` | the full prefixed database name from step 1 |
| `DB_USER` | the full prefixed username from step 1 |
| `DB_PASSWORD` | the password from step 1 |
| `STORAGE_ROOT` | the path from step 4, e.g. `/home/u123456789/mm-storage` |
| `AUTH_SECRET` | a long random string — see below |
| `ENCRYPTION_KEY` | a different long random string |
| `FILE_SIGNING_SECRET` | a third long random string |
| `DEMO_MODE` | `false` |

### The three secrets

They do three different jobs — signing sessions, encrypting stored
credentials, signing file links. They must be **three different values**, so
that changing one does not force changing the others.

Generate them at <https://www.random.org/strings/> (60 characters, letters and
digits, three of them), or on a Mac or Linux terminal:

```bash
openssl rand -base64 48
```

Run it three times. Keep them somewhere safe — losing `ENCRYPTION_KEY` means
every user has to set up two-factor authentication again.

**Never put these in the repository.** They belong only in Hostinger's
environment variables screen.

---

## 6. Deploy

Press **Deploy** in the Node.js application.

Hostinger will pull `main`, run `npm install && npm run build`, and start
`npm start`.

**How to tell it worked:** the build log ends with `Build checks passed.` and
the application status shows as running.

**If the build fails**, the log names the reason. The usual ones:

| Message | Meaning |
| --- | --- |
| `ERR_REQUIRE_ASYNC_MODULE` or `ERR_REQUIRE_ESM` | The startup file is set to `server.js`. Change it to `server.cjs` (step 2) |
| `The application failed to start` | The lines under it name the cause |
| `DB_NAME, DB_USER … are not set` | A variable in step 5 is missing or misspelled |
| `STORAGE_ROOT … is inside the directory this server publishes` | Step 4's folder is in the wrong place |
| `The storage directory … is not writable` | The path in step 4 is wrong, or the folder does not exist |

---

## 7. Create the database tables

The application will not work until the database has its tables. Pick **one**
of the three ways below.

`npm run migrate` never drops, truncates or deletes anything. It creates what
is missing, records what it did, and does nothing at all on a second run. If
the database already holds tables it did not create, it **refuses** rather than
writing over them.

### Option A — during the build (try this first)

**Node.js application → Build command:**

```
npm install && npm run build && npm run migrate
```

Every deploy then checks the schema and applies anything new. On a deploy with
nothing to do it prints `Already up to date; nothing to do.` and moves on.

**The catch:** this only works if Hostinger's build step can reach your MySQL
server. Some managed hosts build in a separate environment with no database
access. If the build log shows

```
Could not connect to … — connect ETIMEDOUT
```

then it cannot, and the build will fail. Use option B or C instead — the
failure is loud and costs you nothing but a rebuild.

### Option B — at application startup (no shell, no build access needed)

Add one environment variable:

| Variable | Value |
| --- | --- |
| `AUTO_MIGRATE` | `true` |

Restart the application. It checks the schema before it starts listening, and
applies anything missing. The application always has database access — it
cannot serve a request without it — so this works when option A does not.

It is guarded by the same record of applied migrations, so restarting does not
re-apply anything. **Run one instance.** If you ever run more than one, leave
this off on the others.

If the schema cannot be applied, the application **refuses to start** and says
why, rather than starting up and returning errors on every request.

### Option C — phpMyAdmin (certain, and entirely manual)

No moving parts, and nothing to go wrong:

1. **hPanel → Databases → phpMyAdmin**, and open your database.
2. Go to the **Import** tab.
3. Choose the file `database/mysql-schema.sql` from the repository.
4. Press **Import**.

It should report success and you should see **116 tables**.

**If an import failed part-way**, the database is left holding whatever was
created before the error. MySQL has no transactional DDL, so there is nothing
to roll back. Before importing again, empty it: **phpMyAdmin → your database →
Check all → With selected: Drop**. Then import the file again. Dropping the
tables of a half-created database loses nothing, because nothing has used it
yet — do not do this to a database that has been in service.

This is the surest option for the first load.

**Then turn on `AUTO_MIGRATE=true`.** phpMyAdmin creates the tables but not the
record of which migrations they represent. On the next start the application
notices tables with no record, **verifies the database against
`database/mysql-schema.sql` — every table, every column, every index by name —**
and, if it matches, writes the record without re-running any of the DDL. It
says so in the log:

```
  migrate    Existing tables with no migration record — verifying against the baseline…
  migrate    Verified: Matches the baseline: 116 tables, 167 indexes.
  migrate    Adopting the existing schema — recording it as applied without re-running it.
```

From then on every future release applies only what is new.

If the database does **not** match, it refuses to start and names what is
missing — a table, a column, an index. It never guesses from the table count,
because a truncated import, an older baseline or an unrelated database of a
similar size would all pass that test.

### Which to choose

| | |
| --- | --- |
| **First deployment, want it certain** | **Option C**, then set `AUTO_MIGRATE=true` — it adopts the imported schema and handles every release after |
| **Want it automatic from now on** | **Option A**, falling back to **B** if the build cannot reach MySQL |
| **No build access and no shell** | **Option B** |

### Checking it worked

Visit `https://your-domain/ready`. It answers with JSON describing the setup.
If the tables are missing it says so instead.

## 8. Create the first administrator

There is no default account and no default password.

You have two ways in, and they make different accounts.

### The quick one: create an organisation

Open `https://your-domain/register` and fill in the form. That creates a
practice and makes you its **Admin** — everything except the platform screens
(`/platform/*`), which sit above every organisation. No environment variables,
no restart. If you only need to use the CRM, this is enough.

### The platform owner: a Super Admin who sees every organisation

1. Add two more environment variables:
   - `PLATFORM_OWNER_EMAIL` — your email address
   - `PLATFORM_OWNER_PASSWORD` — a password of at least 12 characters
2. Restart the application.
3. Visit `https://your-domain/ready` in a browser. It answers with JSON saying
   what it set up. Look at `platformOwner`:

   | What it says | What happened |
   | --- | --- |
   | `{"created": true, …}` | The account exists. Sign in. |
   | `{"created": false, "reason": "not_configured"}` | The variables did not reach the process. Check them, restart again. |
   | `{"created": false, "reason": "password_too_weak"}` | Under 12 characters. |
   | `{"created": false, "reason": "already_exists"}` | There is already a platform owner. |

   This works whether or not the deployment has run before — it is checked on
   every start, and it will not create a second owner.
4. Sign in at `https://your-domain/login`. You will be asked to change the
   password immediately. (`/` is the public landing page; the **Sign in**
   button on it goes to the same place.)
5. **Delete those two environment variables** and restart.

### Demonstration data, if you want screens with something on them

An invented practice — five client companies, a month of documents, computed
GST and TDS, an invoice paid and one not — so the screens have something to
show. It never drops or deletes anything.

`npm run seed` does it from a shell. You do not have one here, so use the
environment instead:

1. Set two variables:
   - `SEED_DEMO` = `true`
   - `DEMO_PASSWORD` = a password of your own
2. Restart.
3. Read the runtime log. It prints what it created and the address to sign in
   with, or says why it refused.
4. **Set `SEED_DEMO=false` and restart.**

Without `DEMO_PASSWORD` the seed refuses: the fallback is committed to this
repository, and the set includes a Super Admin who can see every organisation.
`SEED_DEMO_ACCEPT_RISK=true` overrides that, and means this deployment is a
demonstration and nothing else.

It writes once. A restart finds the organisation already there and does
nothing. See [demo-accounts.md](demo-accounts.md) for the twelve accounts and
how to shut them out again.

---

## 9. Domain and SSL

**hPanel → Websites → your site → Domains**

1. Point your domain at the application.
2. Under **SSL**, turn on the free certificate. Wait for it to issue — usually
   a few minutes.
3. Set `APP_URL` to the `https://` address and restart.

`APP_URL` must match the address people actually use. Every OAuth
redirect and e-mail link is built from it.

---

## 10. Check it works

Visit each of these:

| Address | What you should see |
| --- | --- |
| `https://your-domain/health` | `{"success":true,"data":{"status":"ok",...}}` — the app is running |
| `https://your-domain/ready` | JSON describing the setup |
| `https://your-domain/` | The landing page |
| `https://your-domain/login` | The sign-in screen |

Then sign in and:

- **Upload a document** to a client. It should appear in the list, and a file
  should appear under your `mm-storage` folder.
- **Download it back.** It should open.
- **Open Settings → Integrations.** Everything will say *Not Connected* until
  you add credentials, which is correct.

---

## 11. Scheduled jobs

Reminders, digests, retention and sync run **inside the application** — there
is nothing to set up in Hostinger's cron screen.

Three schedules run automatically:

| When | What |
| --- | --- |
| Every 15 minutes | Due reminders, overdue invoices, SLA breaches, delayed automation, broadcasts |
| Daily at 03:00 UTC | Filing periods, renewals, retention, audit anchoring, reports, sync |
| Mondays at 09:00 UTC | The weekly digest |

They stop when the application stops. If Hostinger puts your application to
sleep when idle, jobs do not run while it is asleep — see *Known limits*.

**If you ever run more than one copy of the application**, set
`RUN_SCHEDULER=false` on all but one, or every job runs twice.

To use a different timezone, set `CRON_TIMEZONE`, e.g. `Asia/Kolkata`.

---

## 12. Adding integrations

Everything below is optional. The CRM works without any of it, and each one
honestly reports *Not Connected* until configured.

Add the relevant variables from `.env.example` in the environment variables
screen, restart, then open **Settings → Integrations** and press **Test
connection** — it makes a real call to the vendor rather than trusting the
configuration.

| To enable | Variables |
| --- | --- |
| Email | `SES_*` |
| SMS | `MSG91_*` |
| WhatsApp | `WHATSAPP_*` |
| Payments | `RAZORPAY_*`, `STRIPE_*`, `CASHFREE_*`, `PHONEPE_*` |
| Cloud calling | the chosen provider's keys (`EXOTEL_*`, `TWILIO_*`, ...) |
| Google / Microsoft | `GOOGLE_*`, `MS_GRAPH_*` |
| Upload scanning | `VIRUS_SCAN_URL` |

### Webhooks

Several integrations call back into the application. Give the vendor:

```
https://your-domain/webhooks/<provider>
```

for example `https://your-domain/webhooks/razorpay`. Signatures are verified,
so a webhook without the matching secret configured is rejected.

---

## Known limits on shared hosting

Stated plainly, because they affect how the application behaves:

1. **One process.** The scheduler assumes a single instance. Running several
   without setting `RUN_SCHEDULER=false` makes every scheduled job run once
   per instance.
2. **Sleeping applications.** If your plan suspends idle applications,
   scheduled jobs do not run while suspended. They catch up on the next pass,
   except for anything time-critical. If reminders must be punctual, keep the
   application awake with an uptime monitor hitting `/health`.
3. **Disk is not backed up by the application.** `mm-storage` holds every
   uploaded document. Hostinger's own backups cover it; the application does
   not replicate it anywhere. See [disaster-recovery.md](disaster-recovery.md).
4. **Uploads are limited by memory.** A very large ZIP is expanded in memory.
   The default ceiling is 50MB (`UPLOAD_MAX_BYTES`).

---

## Updating later

Push to `main`, then press **Deploy** in Hostinger.

If a release adds database tables, run `npm run migrate` again afterwards. It
only ever adds; it never drops anything.

---

## Getting help from the logs

**hPanel → the Node.js application → Logs.**

If the application starts, it prints what it is doing. If it does not, it
prints why and exits — a failed start is never left running behind a 503.

At startup you should see:

```
  Meet Millions Finance CRM
  listening  http://0.0.0.0:3000
  app url    https://crm.yourfirm.in
  database   u123_meetmillions_crm@localhost
  storage    /home/u123456789/mm-storage
```

If any of those lines is wrong or missing, the matching environment variable
is wrong.
