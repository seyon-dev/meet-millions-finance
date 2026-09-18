# Requirements matrix

Every requirement from the proposal, the add-on addendum and the integration
stack, with where it lives and what state it is in.

**States**
&nbsp;&nbsp;**Built** — implemented, tested, and working end to end.
&nbsp;&nbsp;**Built, needs credentials** — complete in code; does nothing until
the vendor's keys are set, and says so rather than pretending.
&nbsp;&nbsp;**Not built** — listed here rather than quietly omitted.

---

## Core CRM

| Requirement | State | Where |
| --- | --- | --- |
| Organisation registration and onboarding | Built | `modules/auth.js`, `services/provisioning.js` |
| Seven roles with server-side authorisation | Built | `permissions/`, every route's `permission` option |
| Per-user permission overrides, with reason and enforced expiry | Built | `modules/users.js`, `auth/identity.js` |
| Multi-company, with a company switcher | Built | `modules/companies.js`, `layout/shell.js` |
| Multi-branch, with geofencing | Built | `modules/branches.js`, `/settings/branches` |
| Client onboarding, contacts, assignment | Built | `modules/clients.js`, `/clients` |
| Monthly filing periods and a checklist per client | Built | `services/workflow.js`, `components/period.js` |
| Document upload — single, multiple, ZIP | Built | `modules/documents.js`, `/client/upload` |
| Document versioning, with history | Built | `document_versions`, `/documents/:id` |
| Verification queue and workspace | Built | `modules/verification.js`, `/verification` |
| Bulk approve and reject, with skip reporting | Built | `POST /api/verification/bulk` |
| Query threads on a document, client-visible | Built | `modules/queries.js`, `/queries/:id` |
| GST computation — CGST/SGST intra-state, IGST inter-state | Built | `services/tax.js`, `data/tax-rules.js` |
| TDS computation | Built | `services/tax.js` |
| Reconciliation against filed returns | Built | `/tax/reconciliation` |
| Report generation as PDF | Built | `services/pdf.js`, `modules/reports.js` |
| Report approval and client sign-off | Built | `modules/reports.js`, `modules/approvals.js` |
| Tasks, assignment and a board | Built | `modules/tasks.js`, `/tasks` |
| Activity feed, client-visible where marked | Built | `modules/activity.js`, `/activity` |
| Notification centre, with per-trigger channels | Built | `modules/notifications.js` |
| Global search across clients, documents, reports, invoices | Built | `modules/search.js`, the command palette |
| Dashboards per role | Built | `modules/dashboards.js`, six dashboard screens |
| Sidebar counters that match the screen they point at | Built | `GET /api/dashboard/badges` |
| Audit trail, hash-chained and verifiable | Built | `services/audit.js`, `/audit` |
| Backup and restore per organisation | Built | `/settings/backup` |
| Dark and light themes | Built | `assets/css/tokens.css` |
| Responsive at 375–1440 and beyond | Built | verified at 390/768/1280/1440 by `npm run ui-check` |

## Billing

| Requirement | State | Where |
| --- | --- | --- |
| Four plans, with feature and limit gating | Built | `data/plans.js`, `services/features.js` |
| Subscribe, upgrade, downgrade, cancel, resume | Built | `modules/billing.js`, `/billing/subscription` |
| Invoices with GST, and a PDF | Built | `modules/billing.js`, `/billing/invoices` |
| Payment through a gateway | Built, needs credentials | `integrations/payments.js`, `core/checkout.js` |
| Webhook-confirmed settlement, signature-verified | Built | `modules/webhooks.js` |
| UPI QR on an invoice | Built | `core/qr.js` — a real encoder, tested against reference matrices |
| Overdue flagging and reminders | Built | `services/scheduler.js` |
| Platform revenue and MRR | Built | `/platform/revenue` |

## The thirty add-ons

| # | Add-on | State | Screen |
| --- | --- | --- | --- |
| 1 | WhatsApp Business API | Built, needs credentials | `/messaging/inbox` |
| 2 | Email Automation | Built, needs credentials | `/automation` |
| 3 | SMS Automation | Built, needs credentials | `/automation` |
| 4 | Voice Notes to CRM | Built; transcription needs credentials | `/voice-notes` |
| 5 | Meta Lead Ads | Built, needs credentials | `/leads` |
| 6 | Google Sheets | Built, needs credentials | `/settings/integrations` |
| 7 | Google Forms | Built, needs credentials | `/settings/integrations` |
| 8 | Website Contact Forms | Built | `/settings/integrations` |
| 9 | AI OCR Engine | Built, needs credentials | `/ai/ocr` |
| 10 | AI Document Verification | Built, needs credentials | `/verification` |
| 11 | AI GST & Tax Assistant | Built, needs credentials | `/ai/assistant` |
| 12 | AI Business Insights | Built, needs credentials | `/ai/insights` |
| 13 | Payment Gateway | Built, needs credentials | `/settings/integrations`, `/billing/*` |
| 14 | E-Sign | Built, needs credentials | `/documents` |
| 15 | Google Drive | Built, needs credentials | `/settings/integrations` |
| 16 | Dropbox | Built, needs credentials | `/settings/integrations` |
| 17 | OneDrive | Built, needs credentials | `/settings/integrations` |
| 18 | Mobile App (Android & iOS) | **Not built** — the API it needs exists; no native client is in this repository | — |
| 19 | Client Self-Service Portal | Built | `/client/*` |
| 20 | Employee GPS Attendance | Built | `/attendance` |
| 21 | Calendar Integration | Built, needs credentials | `/calendar` |
| 22 | Advanced Analytics Dashboard | Built | `/analytics/builder` |
| 23 | API Marketplace | Built | `/settings/api` |
| 24 | White Label Branding | Built; custom domains need a Cloudflare token | `/settings/branding` |
| 25 | Multi Branch Management | Built | `/settings/branches` |
| 26 | Franchise Management | Built | `/platform/franchises` |
| 27 | Multi Company Management | Built | `/companies` |
| 28 | Audit Logs (Advanced) | Built | `/audit` |
| 29 | Enterprise Security | Built | `/settings/security` |
| 30 | Cloud Telephony | Built, needs credentials | `/calls` |

Each add-on carries its own pricing, feature keys, plan fit and provider keys in
`src/data/addons.js`, and activating one is a real subscription row that gates
real endpoints — not a flag that only changes the interface.

## Cloud Calling module

| Requirement | State |
| --- | --- |
| Seven providers behind one `TelephonyProvider` interface | Built |
| Click-to-call, call masking, IVR, voicemail | Built, needs credentials |
| Recording, storage and retention | Built, needs credentials |
| Live call status and a call bar | Built, needs credentials |
| Transcript and AI summary | Built, needs credentials |
| Call metrics and agent performance | Built |
| Provider webhooks, signature-verified | Built |

No vendor name appears outside `integrations/telephony.js`. Switching provider
is one environment variable.

## Integration stack

All thirteen categories are in [integrations.md](integrations.md). Every one
reports **Not Connected** with its missing keys named, and every one has a
"Test connection" that makes a real call.

## Platform

| Requirement | State | Where |
| --- | --- | --- |
| Organisations across the platform | Built | `/platform/organisations` |
| Create an organisation, change its plan, suspend it | Built | `modules/platform.js` |
| Impersonation, marked and audited | Built | `POST /api/platform/tenants/:id/impersonate` |
| Franchises | Built | `/platform/franchises` |
| Plans and their limits | Built | `/platform/plans` |
| Revenue and MRR | Built | `/platform/revenue` |
| System logs | Built | `/platform/logs` |
| First Super Admin from the environment, no default password | Built | `services/bootstrap.js` |

## Not built

Repeated here so it is in one place. The reasoning is in
[honesty.md](honesty.md#what-is-not-built).

- The native mobile application (add-on 18)
- A virus scanner. The integration and the four honest `scan_status` states
  exist, and an infected file is refused before it reaches R2 — but no scanner
  ships here, so an upload is recorded `skipped` until `VIRUS_SCAN_URL` points
  at one
- Anchoring the audit chain's head **outside** the database. The nightly anchor
  now detects tail truncation; the anchors live in the same database, so an
  attacker with write access to both tables can still rewrite them
- Filing returns with the GST portal
- Automated visual-regression comparison
