# Demonstration accounts

Everything here is invented. The organisation, the people, the client
companies and every figure in them are fictional, every record is flagged
`is_demo`, and the tenant is marked as a demonstration so the interface can
say so. None of it corresponds to a real practice, a real client or a real
filing.

## Creating them

```
npm run seed            # against the configured MySQL database
npm run seed -- --check # report the target and change nothing
```

Running it a second time writes nothing: it finds the organisation and says
so. It never drops, truncates or deletes.

The development server seeds the same data into its in-memory database with
`npm run dev`, which resets on restart.

### On a production database

`npm run seed` refuses to run when `NODE_ENV=production` unless you either

- set `DEMO_PASSWORD` to a password of your own, or
- pass `--i-accept-the-risk`.

The fallback password below is committed to this repository, and the set
includes a Super Admin who can see every organisation on the platform. A
production deployment seeded with a published password is a way in, not a
demonstration.

## The accounts

Every account uses the same password. With no `DEMO_PASSWORD` set that is:

```
Demo-Passw0rd!24
```

### The platform

| Role | Email | Lands on |
| --- | --- | --- |
| Super Admin | `devika@meetmillions.example` | `/admin/dashboard` |

Devika Ramanathan sits above every organisation and belongs to no tenant.
The Super Admin screens are under **Platform** in the sidebar:
`/platform/organisations`, `/platform/franchises`, `/platform/plans`,
`/platform/revenue`, `/platform/logs`.

### Meridian Tax Associates — the demonstration practice

| Role | Name | Email | Lands on |
| --- | --- | --- | --- |
| Admin (owner) | Asha Menon | `asha@meridiantax.example` | `/admin/dashboard` |
| Finance Manager | Vikram Rao | `vikram@meridiantax.example` | `/manager/dashboard` |
| Finance Executive | Sneha Pillai | `sneha@meridiantax.example` | `/finance/dashboard` |
| Finance Executive | Arjun Das | `arjun@meridiantax.example` | `/finance/dashboard` |
| Accountant | Lakshmi Iyer | `lakshmi@meridiantax.example` | `/finance/dashboard` |
| Auditor | Nandini Rao | `nandini@meridiantax.example` | `/auditor/dashboard` |

### Client portal

Each of these signs in to the portal and sees only their own company's
documents, queries, reports and invoices.

| Company | Contact | Email | Lands on |
| --- | --- | --- | --- |
| Radiant Traders | Priya Sharma | `priya@radianttraders.example` | `/client/dashboard` |
| Northline Textiles | Rahul Nair | `rahul@northlinetextiles.example` | `/client/dashboard` |
| Vantara Foods | Meera Joshi | `meera@vantarafoods.example` | `/client/dashboard` |
| Kestrel Logistics | Imran Qureshi | `imran@kestrellogistics.example` | `/client/dashboard` |
| Solaris Apparel | Divya Menon | `divya@solarisapparel.example` | `/client/dashboard` |

## What is in the data

A month of a small practice: five client companies across different states so
GST varies, documents at every stage of the workflow, computed GST and TDS, an
invoice that has been paid and one that has not, a query thread, a few calls
with playable audio, and a calendar.

The PDFs say **DEMONSTRATION DATA** on their face, so a page printed or
forwarded from this organisation cannot be mistaken for a real filing.

## Removing them

There is no un-seed command, deliberately — a script that deletes rows from a
live database is a worse risk than the demonstration data it removes.

To shut the practice and its clients out of a production deployment, suspend
the organisation from **Platform → Organisations**. Sign-in then fails for
everyone in it: `src/auth/identity.js` rejects a session whose tenant is
suspended, before any screen loads.

That does **not** cover the Super Admin. Devika Ramanathan belongs to no
organisation, so suspending Meridian leaves that account signing in and seeing
every tenant on the platform. On a production deployment, change its password
or remove the row — suspending the demonstration tenant is not enough.
