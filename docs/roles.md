# Roles and permissions

Seven roles, 137 permissions. A role is a named set of permission keys; a
permission key is checked on the server, on the route, before the handler runs.
Hiding a control in the interface is a courtesy to the person using it — it is
never the control itself.

## The seven roles

| Role | Level | Permissions | What the role is for |
| --- | --- | --- | --- |
| Super Admin | 100 | 137 (all) | The platform, above every organisation: tenants, plans, platform revenue and system logs. Belongs to no tenant. |
| Admin | 80 | 118 | Runs one organisation: people, roles, subscription, integrations, branding, backups. |
| Finance Manager | 65 | 81 | Approves reports, assigns work, watches the team and the SLA. |
| Finance Executive | 50 | 50 | Verifies documents, raises queries, prepares tax calculations. |
| Accountant | 45 | 34 | Computes tax and reconciles ledgers and statements. |
| Auditor | 30 | 23 | Reads verified documents, reports and the audit trail. Writes nothing. |
| Client | 20 | 25 | Uploads documents, follows filing status, answers queries, reads reports, pays invoices. |

Level orders the roles for one purpose: a person may only assign or edit a role
at or below their own level. A Finance Manager cannot make somebody an Admin.

## Where a role lands

Signing in sends a person to the screen their role is actually for:

| Role | Landing |
| --- | --- |
| Super Admin | `/admin/dashboard` — which, for an account with no tenant, is the platform overview rather than a firm's |
| Admin | `/admin/dashboard` |
| Finance Manager | `/manager/dashboard` |
| Finance Executive, Accountant | `/finance/dashboard` |
| Auditor | `/auditor/dashboard` |
| Client | `/client/dashboard` |

## The three shapes of visibility

Several permissions come in three widths, and the difference matters:

- `clients.view` — every client in the organisation.
- `clients.view.assigned` — only clients assigned to this person. An executive
  holds this one, and their queue, their badges and their search results are all
  narrowed to it, not just their client list.
- `clients.view.own` — a client user seeing their own record.

The same pattern applies to `documents.*`, `reports.*`, `invoices.*`,
`support.*` and `calls.*`. When a screen narrows, its sidebar badge narrows with
it: an executive's "Pending verification" count is their queue, because a badge
that disagrees with the screen it points at is worse than no badge.

## Per-user overrides

A permission can be granted to or withdrawn from one person without changing
their role. Every override records:

- who made it and when,
- a written reason — required, not optional,
- an expiry, which is enforced rather than advisory. An expired override stops
  applying at the moment it expires; it does not need a job to sweep it.

Overrides are in the audit trail like any other change.

## Impersonation

A Super Admin can enter an organisation as one of its users, to see what that
person sees. It is deliberately noisy:

- the session is marked as impersonated and shows a persistent bar,
- the original Super Admin identity is carried on the session and recorded on
  every audited action taken during it,
- it expires on its own.

It is not a way to act as somebody quietly, and it is not meant to be.

## Reading the catalogue

`src/permissions/catalog.js` is the single list, grouped into 26 categories. A
key that is not in it is not a permission — `npm run build` fails on any route
or screen that checks one, because a misspelt key silently hides a control from
the people who should have had it, and nothing else reports that.
