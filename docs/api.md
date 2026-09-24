# API reference

327 routes across 34 routers. This file is generated from the
routers themselves — `node scripts/gen-api-docs.mjs > docs/api.md` — so it
cannot drift from the code.

## The envelope

Every response, success or failure, has the same shape:

```json
{
  "success": true,
  "data": { },
  "error": null,
  "meta": { "requestId": "req_…", "timestamp": "2026-01-01T00:00:00.000Z" }
}
```

A list response carries `meta.pagination` with `page`, `pageSize`, `total`,
`totalPages`, `hasPrev` and `hasNext`.

A failure sets `success: false` and fills `error`:

```json
{ "success": false, "data": null,
  "error": { "code": "feature_locked", "message": "…", "details": { } },
  "meta": { "requestId": "req_…" } }
```

The front end switches on `error.code`, not on the status:

| Code | Status | Means |
| --- | --- | --- |
| `auth_required` | 401 | No session, or it has expired. The shell signs out. |
| `twofa_required` | 401 | Credentials were right; the second factor is not done. |
| `forbidden` | 403 | Signed in, but the permission is not held. |
| `not_found` | 404 | Including anything outside the caller's tenant. |
| `validation_failed` | 422 | `details` is a map of field → message. |
| `feature_locked` | 402 | `details` names the plan or add-on that would unlock it. |
| `integration_not_configured` | 409 | `details` names the provider and its missing keys. |
| `rate_limited` | 429 | `Retry-After` is set. |

## Authentication

Send the session token as `Authorization: Bearer <token>`, or a machine key as
`X-Api-Key: <key>`. 15 routes are public — registration, sign-in,
password reset, signed file links and the vendor webhooks, which authenticate by
signature instead.

## Conventions

- **Paging**: `?page=1&pageSize=25`. Page size is capped per endpoint.
- **Sorting**: `?sort=created_at&dir=desc`, against an allow-list of columns.
- **Filtering**: named query parameters per endpoint; unknown ones are ignored.
- **Searching**: `?q=`, matched against the fields that endpoint declares.
- **Money**: integer paise everywhere. A field named `…Paise` is an integer; a
  field named `…Label` is the formatted string beside it.
- **Dates**: ISO 8601 with a timezone. Filing periods are `YYYY-MM`.
- **Ids**: prefixed and sortable — `cli_…`, `doc_…`, `inv_…`.

## Routes


### `/api/auth` — `src/modules/auth.js`

| Method | Path | Requires |
| --- | --- | --- |
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/2fa/verify` | public |
| POST | `/api/auth/2fa/setup` | signed in |
| POST | `/api/auth/2fa/enable` | signed in |
| POST | `/api/auth/2fa/disable` | signed in |
| POST | `/api/auth/2fa/backup-codes` | signed in |
| POST | `/api/auth/2fa/step-up` | signed in |
| POST | `/api/auth/forgot-password` | public |
| POST | `/api/auth/reset-password` | public |
| POST | `/api/auth/change-password` | signed in |
| POST | `/api/auth/logout` | signed in |
| GET | `/api/auth/sessions` | signed in |
| DELETE | `/api/auth/sessions/:id` | signed in |
| POST | `/api/auth/sessions/revoke-others` | signed in |
| GET | `/api/auth/me` | signed in |
| POST | `/api/auth/active-company` | `companies.switch` |
| GET | `/api/auth/permissions-catalogue` | `roles.view` or `users.view` |

### `/api/clients` — `src/modules/clients.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/clients` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| GET | `/api/clients/export/csv` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| GET | `/api/clients/:id` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| POST | `/api/clients` | `clients.create` |
| PATCH | `/api/clients/:id` | `clients.update` |
| POST | `/api/clients/:id/assign` | `clients.assign` |
| DELETE | `/api/clients/:id` | `clients.delete` |
| GET | `/api/clients/:id/periods` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| POST | `/api/clients/:id/periods` | `clients.update` |
| GET | `/api/clients/:id/periods/:periodId` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| GET | `/api/clients/:id/timeline` | `clients.view` or `clients.view.assigned` or `clients.view.own` |
| POST | `/api/clients/:id/contacts` | `clients.update` |
| DELETE | `/api/clients/:id/contacts/:contactId` | `clients.update` |

### `/api/documents` — `src/modules/documents.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/documents` | `documents.view` or `documents.view.own` |
| GET | `/api/documents/:id` | `documents.view` or `documents.view.own` |
| POST | `/api/documents/upload` | `documents.upload` |
| POST | `/api/documents/:id/versions` | `documents.replace` |
| GET | `/api/documents/:id/download` | `documents.download` |
| POST | `/api/documents/:id/share-link` | `documents.download` |
| POST | `/api/documents/:id/comments` | `documents.comment` |
| POST | `/api/documents/:id/lock` | `documents.lock` |
| POST | `/api/documents/:id/archive` | `documents.archive` |
| DELETE | `/api/documents/:id` | `documents.delete` |
| GET | `/api/documents/types/list` | `documents.view` or `documents.view.own` or `documents.upload` |
| GET | `/api/documents/limits` | `documents.upload` or `documents.view` or `documents.view.own` |

### `/api/verification` — `src/modules/verification.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/verification/queue` | `documents.verify` |
| GET | `/api/verification/stats` | `documents.verify` |
| POST | `/api/verification/:id/open` | `documents.verify` |
| POST | `/api/verification/:id/decision` | `documents.verify` |
| POST | `/api/verification/bulk` | `documents.verify` |
| POST | `/api/verification/:id/assign` | `documents.assign` |
| GET | `/api/verification/:id` | `documents.verify` |

### `/api/queries` — `src/modules/queries.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/queries` | `queries.view` or `queries.view.own` |
| GET | `/api/queries/:id` | `queries.view` or `queries.view.own` |
| POST | `/api/queries` | `queries.create` |
| POST | `/api/queries/:id/replies` | `queries.reply` |
| POST | `/api/queries/:id/resolve` | `queries.resolve` |
| POST | `/api/queries/:id/reopen` | `queries.resolve` |

### `/api/tax` — `src/modules/tax.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/tax/computations` | `tax.view` |
| GET | `/api/tax/computations/:id` | `tax.view` |
| POST | `/api/tax/computations/run` | `tax.calculate` |
| POST | `/api/tax/computations/:id/finalise` | `tax.finalise` |
| GET | `/api/tax/gst-records` | `tax.view` |
| POST | `/api/tax/gst-records` | `tax.edit` |
| PATCH | `/api/tax/gst-records/:id` | `tax.edit` |
| DELETE | `/api/tax/gst-records/:id` | `tax.edit` |
| GET | `/api/tax/tds-records` | `tax.view` |
| POST | `/api/tax/tds-records` | `tax.edit` |
| POST | `/api/tax/calculate/gst` | `tax.view` |
| POST | `/api/tax/calculate/tds` | `tax.view` |
| GET | `/api/tax/rules` | `tax.view` |
| POST | `/api/tax/rules` | `tax.rules.manage` |
| PATCH | `/api/tax/rules/:id` | `tax.rules.manage` |
| GET | `/api/tax/summary` | `tax.view` |
| GET | `/api/tax/reconciliation` | `tax.reconcile` |

### `/api/reports` — `src/modules/reports.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/reports/types` | `reports.view` or `reports.view.own` |
| GET | `/api/reports` | `reports.view` or `reports.view.own` |
| GET | `/api/reports/:id` | `reports.view` or `reports.view.own` |
| POST | `/api/reports` | `reports.create` |
| POST | `/api/reports/:id/submit` | `reports.submit` |
| POST | `/api/reports/:id/decision` | `reports.approve` |
| POST | `/api/reports/:id/sign-off` | `reports.signoff` or `reports.approve` |
| POST | `/api/reports/:id/archive` | `documents.archive` |
| GET | `/api/reports/:id/export` | `reports.export` |
| GET | `/api/reports/schedules/list` | `reports.schedule` |
| POST | `/api/reports/schedules` | `reports.schedule` |
| DELETE | `/api/reports/schedules/:id` | `reports.schedule` |

### `/api/approvals` — `src/modules/approvals.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/approvals` | `approvals.view` |
| GET | `/api/approvals/stats` | `approvals.view` |
| POST | `/api/approvals/:id/decide` | `approvals.decide` |

### `/api/tasks` — `src/modules/tasks.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/tasks` | `tasks.view` |
| POST | `/api/tasks` | `tasks.manage` |
| PATCH | `/api/tasks/:id` | `tasks.manage` |
| DELETE | `/api/tasks/:id` | `tasks.manage` |

### `/api/billing` — `src/modules/billing.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/billing/plans` | public |
| GET | `/api/billing/subscription` | `billing.view` |
| POST | `/api/billing/subscription/change-plan` | `subscriptions.manage` |
| POST | `/api/billing/subscription/cancel` | `subscriptions.manage` |
| POST | `/api/billing/subscription/resume` | `subscriptions.manage` |
| GET | `/api/billing/invoices` | `invoices.view` or `invoices.view.own` |
| GET | `/api/billing/invoices/:id` | `invoices.view` or `invoices.view.own` |
| POST | `/api/billing/invoices` | `invoices.create` |
| POST | `/api/billing/invoices/:id/void` | `invoices.void` |
| GET | `/api/billing/invoices/:id/pdf` | `invoices.view` or `invoices.view.own` |
| GET | `/api/billing/payments` | `payments.view` |
| POST | `/api/billing/payments/checkout` | `payments.pay` |
| POST | `/api/billing/payments/:id/verify` | `payments.pay` |
| POST | `/api/billing/payments/record` | `payments.record` |
| POST | `/api/billing/payments/:id/refund` | `payments.refund` |
| GET | `/api/billing/payments/:id/receipt` | `payments.view` |
| GET | `/api/billing/gateways` | `billing.view` or `integrations.view` |

### `/api/addons` — `src/modules/addons.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/addons` | `addons.view` |
| GET | `/api/addons/:key` | `addons.view` |
| POST | `/api/addons/:key/activate` | `addons.activate` |
| POST | `/api/addons/:key/deactivate` | `addons.activate` |
| PATCH | `/api/addons/:key/config` | `addons.configure` |
| POST | `/api/addons/bundles/:plan` | `addons.activate` |
| GET | `/api/addons/:key/usage` | `addons.view` |

### `/api/calls` — `src/modules/calls.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/calls/settings` | `calls.configure` or `calls.view` or `calls.view.own` |
| PATCH | `/api/calls/settings` | `calls.configure` |
| POST | `/api/calls/settings/test` | `calls.configure` |
| POST | `/api/calls/dial` | `calls.place` |
| GET | `/api/calls/live` | `calls.view` or `calls.view.own` |
| POST | `/api/calls/:id/control` | `calls.place` |
| POST | `/api/calls/:id/transfer` | `calls.transfer` |
| POST | `/api/calls/:id/conference` | `calls.transfer` |
| GET | `/api/calls` | `calls.view` or `calls.view.own` |
| GET | `/api/calls/:id` | `calls.view` or `calls.view.own` |
| GET | `/api/calls/timeline/:clientId` | `calls.view` or `calls.view.own` |
| POST | `/api/calls/:id/notes` | `calls.notes` |
| POST | `/api/calls/:id/disposition` | `calls.notes` |
| POST | `/api/calls/:id/missed/handle` | `calls.notes` |
| GET | `/api/calls/:id/recording` | `calls.recordings.listen` |
| GET | `/api/calls/recordings/search` | `calls.recordings.listen` |
| POST | `/api/calls/:id/analyse` | `calls.notes` |
| GET | `/api/calls/analytics/overview` | `calls.analytics` |
| GET | `/api/calls/analytics/performance` | `calls.analytics` |
| GET | `/api/calls/analytics/reports` | `calls.analytics` |
| GET | `/api/calls/voicemails` | `calls.view` or `calls.view.own` |
| POST | `/api/calls/voicemails/:id/status` | `calls.notes` |
| GET | `/api/calls/ivr` | `calls.configure` |
| POST | `/api/calls/ivr` | `calls.configure` |
| POST | `/api/calls/agents` | `calls.configure` |
| POST | `/api/calls/presence` | `calls.place` or `calls.receive` |
| POST | `/api/calls/dispositions` | `calls.configure` |

### `/api/users` — `src/modules/users.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/users` | `users.view` |
| GET | `/api/users/assignable-roles` | `users.view` |
| GET | `/api/users/:id` | `users.view` |
| POST | `/api/users` | `users.create` |
| PATCH | `/api/users/:id` | `users.update` |
| PUT | `/api/users/:id/roles` | `roles.manage` |
| PUT | `/api/users/:id/permissions` | `roles.manage` |
| PUT | `/api/users/:id/companies` | `users.update` |
| POST | `/api/users/:id/reset-password` | `users.update` |
| DELETE | `/api/users/:id` | `users.delete` |
| DELETE | `/api/users/:id/sessions/:sessionId` | `users.update` |

### `/api/companies` — `src/modules/companies.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/companies` | `companies.view` |
| GET | `/api/companies/switcher` | signed in |
| POST | `/api/companies/switch` | `companies.switch` |
| GET | `/api/companies/:id` | `companies.view` |
| POST | `/api/companies` | `companies.create` |
| PATCH | `/api/companies/:id` | `companies.update` |
| DELETE | `/api/companies/:id` | `companies.delete` |

### `/api/branches` — `src/modules/branches.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/branches` | `branches.view` |
| GET | `/api/branches/performance` | `branches.view` |
| GET | `/api/branches/:id` | `branches.view` |
| POST | `/api/branches` | `branches.manage` |
| PATCH | `/api/branches/:id` | `branches.manage` |
| DELETE | `/api/branches/:id` | `branches.manage` |

### `/api/settings` — `src/modules/settings.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/settings` | `settings.view` |
| PUT | `/api/settings` | `settings.manage` |
| GET | `/api/settings/security` | `settings.view` |
| PATCH | `/api/settings/security` | `settings.manage` |
| POST | `/api/settings/security/ip-allowlist` | `settings.manage` |
| DELETE | `/api/settings/security/ip-allowlist/:id` | `settings.manage` |
| GET | `/api/settings/views` | signed in |
| POST | `/api/settings/views` | signed in |
| DELETE | `/api/settings/views/:id` | signed in |

### `/api/dashboard` — `src/modules/dashboards.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/dashboard` | signed in |
| GET | `/api/dashboard/badges` | signed in |
| GET | `/api/dashboard/:role` | signed in |

### `/api/audit` — `src/modules/audit.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/audit` | `audit.view` |
| GET | `/api/audit/verify` | `audit.view` |
| GET | `/api/audit/:id` | `audit.view` |
| GET | `/api/audit/export/csv` | `audit.export` |
| GET | `/api/audit/entity/:entityType/:entityId` | `audit.view` |

### `/api/activity` — `src/modules/activity.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/activity` | `clients.view` or `clients.view.assigned` or `clients.view.own` |

### `/api/notifications` — `src/modules/notifications.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/notifications` | signed in |
| GET | `/api/notifications/unread-count` | signed in |
| POST | `/api/notifications/read` | signed in |
| DELETE | `/api/notifications/:id` | signed in |
| GET | `/api/notifications/preferences` | signed in |
| PUT | `/api/notifications/preferences` | signed in |
| DELETE | `/api/notifications/preferences` | signed in |
| GET | `/api/notifications/templates` | `notifications.manage` |
| PUT | `/api/notifications/templates/:triggerKey/:channel` | `notifications.manage` |
| POST | `/api/notifications/templates/:triggerKey/:channel/preview` | `notifications.manage` |
| POST | `/api/notifications/test` | `notifications.manage` |
| GET | `/api/notifications/deliveries` | `notifications.manage` |

### `/api/search` — `src/modules/search.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/search` | signed in |

### `/api/integrations` — `src/modules/integrations.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/integrations` | `integrations.view` |
| GET | `/api/integrations/:key` | `integrations.view` |
| POST | `/api/integrations/:key/test` | `integrations.manage` |
| PATCH | `/api/integrations/:key/config` | `integrations.manage` |
| POST | `/api/integrations/:key/oauth/start` | `integrations.manage` |
| POST | `/api/integrations/:key/oauth/callback` | `integrations.manage` |
| DELETE | `/api/integrations/:key/oauth` | `integrations.manage` |
| GET | `/api/integrations/:key/logs` | `integrations.view` |
| GET | `/api/integrations/storage/folders` | `integrations.view` |
| POST | `/api/integrations/storage/folders` | `integrations.manage` |
| PATCH | `/api/integrations/storage/folders/:id` | `integrations.manage` |
| DELETE | `/api/integrations/storage/folders/:id` | `integrations.manage` |
| GET | `/api/integrations/storage/folders/:id/queue` | `integrations.view` |
| PUT | `/api/integrations/:key/mappings` | `integrations.manage` |

### `/api/platform` — `src/modules/platform.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/platform/tenants` | `tenants.view` |
| GET | `/api/platform/tenants/:id` | `tenants.view` |
| POST | `/api/platform/tenants` | `tenants.create` |
| PATCH | `/api/platform/tenants/:id` | `tenants.update` or `tenants.suspend` |
| POST | `/api/platform/tenants/:id/plan` | `tenants.update` |
| POST | `/api/platform/tenants/:id/impersonate` | `users.impersonate` |
| GET | `/api/platform/franchises` | `franchises.view` |
| POST | `/api/platform/franchises` | `franchises.manage` |
| PATCH | `/api/platform/franchises/:id` | `franchises.manage` |
| GET | `/api/platform/plans` | `plans.manage` |
| PATCH | `/api/platform/plans/:key` | `plans.manage` |
| GET | `/api/platform/revenue` | `platform.analytics` |
| GET | `/api/platform/logs` | `platform.logs.view` |

### `/api/leads` — `src/modules/leads.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/leads` | `leads.view` |
| GET | `/api/leads/:id` | `leads.view` |
| POST | `/api/leads` | `leads.manage` |
| PATCH | `/api/leads/:id` | `leads.manage` |
| POST | `/api/leads/:id/convert` | `leads.manage` |
| POST | `/api/leads/:id/duplicate-of/:originalId` | `leads.manage` |
| GET | `/api/leads/campaigns/list` | `leads.view` |
| POST | `/api/leads/campaigns` | `leads.manage` |
| GET | `/api/leads/rules/list` | `leads.view` |
| POST | `/api/leads/rules` | `leads.manage` |

### `/api/messaging` — `src/modules/messaging.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/messaging/threads` | `messaging.view` |
| GET | `/api/messaging/threads/:id` | `messaging.view` |
| POST | `/api/messaging/threads/:id/reply` | `messaging.send` |
| POST | `/api/messaging/threads/:id/assign` | `messaging.view` |
| POST | `/api/messaging/threads` | `messaging.send` |
| GET | `/api/messaging/templates` | `messaging.view` |
| POST | `/api/messaging/templates` | `messaging.templates` |
| GET | `/api/messaging/broadcasts` | `messaging.view` |
| POST | `/api/messaging/broadcasts` | `messaging.broadcast` |
| GET | `/api/messaging/flows` | `messaging.view` |
| GET | `/api/messaging/flows/:id` | `messaging.view` |
| POST | `/api/messaging/flows` | `messaging.templates` |
| PATCH | `/api/messaging/flows/:id` | `messaging.templates` |
| DELETE | `/api/messaging/flows/:id` | `messaging.templates` |
| POST | `/api/messaging/flows/:id/simulate` | `messaging.view` |

### `/api/voice-notes` — `src/modules/voice-notes.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/voice-notes` | `voicenotes.create` or `clients.view` or `clients.view.assigned` |
| POST | `/api/voice-notes` | `voicenotes.create` |
| GET | `/api/voice-notes/:id` | `voicenotes.create` or `clients.view` or `clients.view.assigned` |
| GET | `/api/voice-notes/:id/audio` | `voicenotes.create` or `clients.view` or `clients.view.assigned` |
| POST | `/api/voice-notes/:id/transcribe` | `voicenotes.create` |
| DELETE | `/api/voice-notes/:id` | `voicenotes.create` or `clients.assign` |

### `/api/automation` — `src/modules/automation.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/automation` | `automation.manage` or `settings.view` |
| POST | `/api/automation` | `automation.manage` |
| PATCH | `/api/automation/:id` | `automation.manage` |
| DELETE | `/api/automation/:id` | `automation.manage` |
| POST | `/api/automation/:id/preview` | `automation.manage` or `settings.view` |

### `/api/support` — `src/modules/support.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/support` | `support.view` or `support.view.own` |
| GET | `/api/support/:id` | `support.view` or `support.view.own` |
| POST | `/api/support` | `support.create` |
| POST | `/api/support/:id/reply` | `support.reply` |
| PATCH | `/api/support/:id` | `support.manage` |
| POST | `/api/support/:id/rate` | signed in |
| GET | `/api/support/stats/overview` | `support.view` |

### `/api/attendance` — `src/modules/fieldops.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/attendance/today` | `attendance.self` |
| POST | `/api/attendance/check-in` | `attendance.self` |
| POST | `/api/attendance/check-out` | `attendance.self` |
| POST | `/api/attendance/visits` | `attendance.self` |
| POST | `/api/attendance/visits/:id/complete` | `attendance.self` |
| GET | `/api/attendance` | `attendance.view` or `attendance.self` |
| GET | `/api/attendance/summary` | `attendance.view` |
| PATCH | `/api/attendance/:id` | `attendance.manage` |

### `/api/ai` — `src/modules/ai.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/ai/ocr` | `ai.ocr` |
| POST | `/api/ai/ocr/:documentId` | `ai.ocr` |
| POST | `/api/ai/ocr/:id/review` | `ai.ocr` |
| GET | `/api/ai/verifications` | `ai.verify` |
| GET | `/api/ai/conversations` | `ai.assistant` |
| GET | `/api/ai/conversations/:id` | `ai.assistant` |
| POST | `/api/ai/ask` | `ai.assistant` |
| GET | `/api/ai/insights` | `ai.insights` |
| POST | `/api/ai/insights/refresh` | `ai.insights` |
| POST | `/api/ai/insights/:id/acknowledge` | `ai.insights` |
| GET | `/api/ai/status` | `ai.ocr` or `ai.assistant` or `ai.insights` |

### `/api/analytics` — `src/modules/analytics.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/analytics/datasets` | `analytics.view` |
| POST | `/api/analytics/query` | `analytics.build` |
| GET | `/api/analytics/dashboards` | `analytics.view` |
| POST | `/api/analytics/dashboards` | `analytics.build` |
| DELETE | `/api/analytics/dashboards/:id` | `analytics.build` |
| GET | `/api/analytics/schedules` | `reports.schedule` |
| POST | `/api/analytics/schedules` | `reports.schedule` |
| DELETE | `/api/analytics/schedules/:id` | `reports.schedule` |
| GET | `/api/analytics/trends` | `analytics.view` |

### `/api` — `src/modules/workspace.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/api/calendar` | `calendar.view` |
| POST | `/api/calendar` | `calendar.manage` |
| PATCH | `/api/calendar/:id` | `calendar.manage` |
| DELETE | `/api/calendar/:id` | `calendar.manage` |
| GET | `/api/esign` | `esign.view` |
| POST | `/api/esign` | `esign.send` |
| GET | `/api/esign/:id` | `esign.view` |
| GET | `/api/api-keys` | `api.view` |
| POST | `/api/api-keys` | `api.manage` |
| DELETE | `/api/api-keys/:id` | `api.manage` |
| GET | `/api/api-keys/:id/usage` | `api.view` |
| GET | `/api/branding` | `settings.view` |
| PATCH | `/api/branding` | `whitelabel.manage` |
| POST | `/api/branding/logo` | `whitelabel.manage` |
| POST | `/api/branding/domain` | `whitelabel.manage` |
| POST | `/api/branding/domain/verify` | `whitelabel.manage` |
| GET | `/api/backups` | `backup.view` |
| POST | `/api/backups` | `backup.manage` |
| GET | `/api/backups/:id/download` | `backup.manage` |
| POST | `/api/backups/:id/verify` | `backup.manage` |

### `/files` — `src/modules/files.js`

| Method | Path | Requires |
| --- | --- | --- |
| GET | `/files/signed` | public |
| GET | `/files/documents/:documentId` | signed in |
| GET | `/files/assets/:kind/:id` | signed in |

### `/webhooks` — `src/modules/webhooks.js`

| Method | Path | Requires |
| --- | --- | --- |
| POST | `/webhooks/payments/:gateway` | public |
| POST | `/webhooks/telephony/:provider` | public |
| GET | `/webhooks/whatsapp` | public |
| POST | `/webhooks/whatsapp` | public |
| GET | `/webhooks/meta-leads` | public |
| POST | `/webhooks/meta-leads` | public |
| POST | `/webhooks/esign/:provider` | public |
| POST | `/webhooks/forms/:endpointKey` | public |
