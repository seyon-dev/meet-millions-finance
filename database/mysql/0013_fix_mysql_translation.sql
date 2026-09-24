-- ---------------------------------------------------------------------------
-- 0013 — two things the MySQL schema generator got wrong.
--
-- TRANSLATION-ONLY: this repairs the SQLite-to-MySQL translation, not the
-- schema. database/migrations is already correct and has nothing to mirror
-- here; the whole defect is that the generated MySQL diverged from it.
--
-- Both were invisible to the test suite, which runs on SQLite against the real
-- migrations. SQLite is right in both cases; only the translation was wrong.
--
-- 1. Column defaults (115 columns, 64 tables)
--
--    MySQL cannot put a DEFAULT on a TEXT column. The generator dropped the
--    default rather than widening the type, so these came out NOT NULL with no
--    default at all. Under STRICT_TRANS_TABLES every insert relying on one —
--    a status, a priority, a currency — failed with "Field 'x' doesn't have a
--    default value". Registration was the first thing anybody hit.
--
--    Each becomes VARCHAR(255) carrying the default the migrations always
--    specified. The values are short enum-like words that already fit.
--
-- 2. Partial unique indexes (5 replaced)
--
--    SQLite writes `CREATE UNIQUE INDEX ... WHERE col IS NOT NULL` to mean
--    "unique among the rows that have one". The generator mapped every NULL to
--    a sentinel so one index could cover a NULL/NOT NULL pair — correct for
--    the tenant_id pairs it was written for, and wrong here, because it made
--    all the NULL rows collide with each other. A second payment with no
--    idempotency key, a second webhook with no event id, a second call with no
--    provider id: all rejected.
--
--    MySQL already does what the predicate means — a unique index does not
--    collide on NULL — so these need no sentinel and no generated column.
--
-- Additive in effect: no row is read, moved or deleted. Existing CHECK
-- constraints are untouched; MODIFY COLUMN does not disturb them.
-- ---------------------------------------------------------------------------


-- 1. Restore the defaults ---------------------------------------------------

ALTER TABLE `activities` MODIFY COLUMN `visibility` VARCHAR(255) NOT NULL DEFAULT 'internal';
ALTER TABLE `add_on_subscriptions` MODIFY COLUMN `billing_cycle` VARCHAR(255) NOT NULL DEFAULT 'monthly';
ALTER TABLE `ai_conversations` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'tax_assistant';
ALTER TABLE `ai_insights` MODIFY COLUMN `generated_by` VARCHAR(255) NOT NULL DEFAULT 'rules';
ALTER TABLE `ai_insights` MODIFY COLUMN `severity` VARCHAR(255) NOT NULL DEFAULT 'info';
ALTER TABLE `ai_verifications` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `approvals` MODIFY COLUMN `stage` VARCHAR(255) NOT NULL DEFAULT 'manager';
ALTER TABLE `attendance` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'present';
ALTER TABLE `audit_logs` MODIFY COLUMN `actor_type` VARCHAR(255) NOT NULL DEFAULT 'user';
ALTER TABLE `audit_logs` MODIFY COLUMN `category` VARCHAR(255) NOT NULL DEFAULT 'general';
ALTER TABLE `audit_logs` MODIFY COLUMN `result` VARCHAR(255) NOT NULL DEFAULT 'success';
ALTER TABLE `audit_logs` MODIFY COLUMN `severity` VARCHAR(255) NOT NULL DEFAULT 'info';
ALTER TABLE `backups` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'full';
ALTER TABLE `backups` MODIFY COLUMN `scope` VARCHAR(255) NOT NULL DEFAULT 'tenant';
ALTER TABLE `backups` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `backups` MODIFY COLUMN `trigger` VARCHAR(255) NOT NULL DEFAULT 'manual';
ALTER TABLE `branches` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'active';
ALTER TABLE `calendar_events` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'meeting';
ALTER TABLE `calendar_events` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'confirmed';
ALTER TABLE `calendar_events` MODIFY COLUMN `sync_status` VARCHAR(255) NOT NULL DEFAULT 'local';
ALTER TABLE `call_ai_analysis` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `call_dispositions` MODIFY COLUMN `outcome` VARCHAR(255) NOT NULL DEFAULT 'neutral';
ALTER TABLE `call_recordings` MODIFY COLUMN `mime_type` VARCHAR(255) NOT NULL DEFAULT 'audio/mpeg';
ALTER TABLE `call_transcripts` MODIFY COLUMN `provider` VARCHAR(255) NOT NULL DEFAULT 'google_speech';
ALTER TABLE `call_transcripts` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `campaigns` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'active';
ALTER TABLE `chat_messages` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `chat_messages` MODIFY COLUMN `type` VARCHAR(255) NOT NULL DEFAULT 'text';
ALTER TABLE `checklist_items` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `clients` MODIFY COLUMN `onboarding_status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `companies` MODIFY COLUMN `country` VARCHAR(255) NOT NULL DEFAULT 'IN';
ALTER TABLE `companies` MODIFY COLUMN `entity_type` VARCHAR(255) NOT NULL DEFAULT 'private_limited';
ALTER TABLE `companies` MODIFY COLUMN `financial_year_start` VARCHAR(255) NOT NULL DEFAULT '04-01';
ALTER TABLE `companies` MODIFY COLUMN `gst_filing_frequency` VARCHAR(255) NOT NULL DEFAULT 'monthly';
ALTER TABLE `companies` MODIFY COLUMN `gst_registration_type` VARCHAR(255) NOT NULL DEFAULT 'regular';
ALTER TABLE `companies` MODIFY COLUMN `state_code` VARCHAR(255) NOT NULL DEFAULT '33';
ALTER TABLE `document_comments` MODIFY COLUMN `visibility` VARCHAR(255) NOT NULL DEFAULT 'shared';
ALTER TABLE `document_types` MODIFY COLUMN `periodicity` VARCHAR(255) NOT NULL DEFAULT 'monthly';
ALTER TABLE `document_versions` MODIFY COLUMN `scan_status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `documents` MODIFY COLUMN `ai_precheck_status` VARCHAR(255) NOT NULL DEFAULT 'none';
ALTER TABLE `documents` MODIFY COLUMN `ocr_status` VARCHAR(255) NOT NULL DEFAULT 'none';
ALTER TABLE `documents` MODIFY COLUMN `priority` VARCHAR(255) NOT NULL DEFAULT 'normal';
ALTER TABLE `documents` MODIFY COLUMN `source` VARCHAR(255) NOT NULL DEFAULT 'portal';
ALTER TABLE `esign_requests` MODIFY COLUMN `method` VARCHAR(255) NOT NULL DEFAULT 'aadhaar_esign';
ALTER TABLE `esign_requests` MODIFY COLUMN `provider` VARCHAR(255) NOT NULL DEFAULT 'digio';
ALTER TABLE `esign_requests` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'draft';
ALTER TABLE `esign_signers` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `field_mappings` MODIFY COLUMN `target_entity` VARCHAR(255) NOT NULL DEFAULT 'lead';
ALTER TABLE `franchise_revenue` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'accrued';
ALTER TABLE `franchises` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'onboarding';
ALTER TABLE `gps_visits` MODIFY COLUMN `purpose` VARCHAR(255) NOT NULL DEFAULT 'document_collection';
ALTER TABLE `gst_records` MODIFY COLUMN `source` VARCHAR(255) NOT NULL DEFAULT 'manual';
ALTER TABLE `gst_records` MODIFY COLUMN `supply_type` VARCHAR(255) NOT NULL DEFAULT 'intra';
ALTER TABLE `invoices` MODIFY COLUMN `currency` VARCHAR(255) NOT NULL DEFAULT 'INR';
ALTER TABLE `invoices` MODIFY COLUMN `direction` VARCHAR(255) NOT NULL DEFAULT 'platform_to_tenant';
ALTER TABLE `invoices` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'subscription';
ALTER TABLE `ivr_flows` MODIFY COLUMN `after_hours_action` VARCHAR(255) NOT NULL DEFAULT 'voicemail';
ALTER TABLE `lead_assignment_rules` MODIFY COLUMN `strategy` VARCHAR(255) NOT NULL DEFAULT 'round_robin';
ALTER TABLE `notifications` MODIFY COLUMN `severity` VARCHAR(255) NOT NULL DEFAULT 'info';
ALTER TABLE `oauth_connections` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'active';
ALTER TABLE `ocr_extractions` MODIFY COLUMN `provider` VARCHAR(255) NOT NULL DEFAULT 'google_vision';
ALTER TABLE `ocr_extractions` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `offline_captures` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `payments` MODIFY COLUMN `currency` VARCHAR(255) NOT NULL DEFAULT 'INR';
ALTER TABLE `permissions` MODIFY COLUMN `category` VARCHAR(255) NOT NULL DEFAULT 'general';
ALTER TABLE `plans` MODIFY COLUMN `currency` VARCHAR(255) NOT NULL DEFAULT 'INR';
ALTER TABLE `plans` MODIFY COLUMN `support_level` VARCHAR(255) NOT NULL DEFAULT 'email';
ALTER TABLE `queries` MODIFY COLUMN `category` VARCHAR(255) NOT NULL DEFAULT 'document';
ALTER TABLE `queries` MODIFY COLUMN `priority` VARCHAR(255) NOT NULL DEFAULT 'normal';
ALTER TABLE `query_replies` MODIFY COLUMN `channel` VARCHAR(255) NOT NULL DEFAULT 'portal';
ALTER TABLE `query_replies` MODIFY COLUMN `visibility` VARCHAR(255) NOT NULL DEFAULT 'shared';
ALTER TABLE `restore_jobs` MODIFY COLUMN `mode` VARCHAR(255) NOT NULL DEFAULT 'dry_run';
ALTER TABLE `restore_jobs` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'queued';
ALTER TABLE `scheduled_reports` MODIFY COLUMN `format` VARCHAR(255) NOT NULL DEFAULT 'csv';
ALTER TABLE `scheduled_reports` MODIFY COLUMN `frequency` VARCHAR(255) NOT NULL DEFAULT 'monthly';
ALTER TABLE `settings` MODIFY COLUMN `value_type` VARCHAR(255) NOT NULL DEFAULT 'string';
ALTER TABLE `storage_folder_maps` MODIFY COLUMN `scope_type` VARCHAR(255) NOT NULL DEFAULT 'tenant';
ALTER TABLE `storage_folder_maps` MODIFY COLUMN `sync_on` VARCHAR(255) NOT NULL DEFAULT 'verified';
ALTER TABLE `subscriptions` MODIFY COLUMN `billing_cycle` VARCHAR(255) NOT NULL DEFAULT 'monthly';
ALTER TABLE `support_tickets` MODIFY COLUMN `category` VARCHAR(255) NOT NULL DEFAULT 'general';
ALTER TABLE `support_tickets` MODIFY COLUMN `channel` VARCHAR(255) NOT NULL DEFAULT 'portal';
ALTER TABLE `support_tickets` MODIFY COLUMN `priority` VARCHAR(255) NOT NULL DEFAULT 'normal';
ALTER TABLE `tasks` MODIFY COLUMN `priority` VARCHAR(255) NOT NULL DEFAULT 'normal';
ALTER TABLE `tasks` MODIFY COLUMN `type` VARCHAR(255) NOT NULL DEFAULT 'general';
ALTER TABLE `tax_computations` MODIFY COLUMN `engine_version` VARCHAR(255) NOT NULL DEFAULT '1.0.0';
ALTER TABLE `tax_computations` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'draft';
ALTER TABLE `tds_records` MODIFY COLUMN `payee_type` VARCHAR(255) NOT NULL DEFAULT 'company';
ALTER TABLE `tds_records` MODIFY COLUMN `source` VARCHAR(255) NOT NULL DEFAULT 'manual';
ALTER TABLE `telephony_agents` MODIFY COLUMN `presence` VARCHAR(255) NOT NULL DEFAULT 'offline';
ALTER TABLE `telephony_settings` MODIFY COLUMN `provider` VARCHAR(255) NOT NULL DEFAULT 'exotel';
ALTER TABLE `telephony_settings` MODIFY COLUMN `recording_mode` VARCHAR(255) NOT NULL DEFAULT 'automatic';
ALTER TABLE `telephony_settings` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'not_connected';
ALTER TABLE `tenants` MODIFY COLUMN `country` VARCHAR(255) NOT NULL DEFAULT 'IN';
ALTER TABLE `tenants` MODIFY COLUMN `currency` VARCHAR(255) NOT NULL DEFAULT 'INR';
ALTER TABLE `tenants` MODIFY COLUMN `onboarding_step` VARCHAR(255) NOT NULL DEFAULT 'complete';
ALTER TABLE `tenants` MODIFY COLUMN `timezone` VARCHAR(255) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE `ticket_messages` MODIFY COLUMN `author_kind` VARCHAR(255) NOT NULL DEFAULT 'agent';
ALTER TABLE `ticket_messages` MODIFY COLUMN `visibility` VARCHAR(255) NOT NULL DEFAULT 'shared';
ALTER TABLE `upload_batches` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'zip';
ALTER TABLE `upload_batches` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'processing';
ALTER TABLE `user_companies` MODIFY COLUMN `relationship` VARCHAR(255) NOT NULL DEFAULT 'member';
ALTER TABLE `users` MODIFY COLUMN `locale` VARCHAR(255) NOT NULL DEFAULT 'en-IN';
ALTER TABLE `users` MODIFY COLUMN `theme` VARCHAR(255) NOT NULL DEFAULT 'dark';
ALTER TABLE `users` MODIFY COLUMN `timezone` VARCHAR(255) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE `voice_notes` MODIFY COLUMN `mime_type` VARCHAR(255) NOT NULL DEFAULT 'audio/webm';
ALTER TABLE `voice_notes` MODIFY COLUMN `transcript_status` VARCHAR(255) NOT NULL DEFAULT 'pending';
ALTER TABLE `webhook_endpoints` MODIFY COLUMN `kind` VARCHAR(255) NOT NULL DEFAULT 'website_form';
ALTER TABLE `webhook_endpoints` MODIFY COLUMN `target_entity` VARCHAR(255) NOT NULL DEFAULT 'lead';
ALTER TABLE `webhook_events` MODIFY COLUMN `signature_status` VARCHAR(255) NOT NULL DEFAULT 'unverified';
ALTER TABLE `webhook_events` MODIFY COLUMN `status` VARCHAR(255) NOT NULL DEFAULT 'received';
ALTER TABLE `whatsapp_templates` MODIFY COLUMN `approval_status` VARCHAR(255) NOT NULL DEFAULT 'draft';
ALTER TABLE `whatsapp_templates` MODIFY COLUMN `category` VARCHAR(255) NOT NULL DEFAULT 'UTILITY';
ALTER TABLE `white_label_settings` MODIFY COLUMN `domain_status` VARCHAR(255) NOT NULL DEFAULT 'not_configured';
ALTER TABLE `white_label_settings` MODIFY COLUMN `sidebar_style` VARCHAR(255) NOT NULL DEFAULT 'glass';
ALTER TABLE `white_label_settings` MODIFY COLUMN `ssl_status` VARCHAR(255) NOT NULL DEFAULT 'none';


-- 2. Replace the sentinel indexes with plain unique indexes -----------------
-- The replacements are created BEFORE the sentinels are dropped, so a failure
-- anywhere in this section never leaves a table without uniqueness
-- enforcement: at worst both indexes exist, and the re-run skips the ones
-- already in place.

CREATE UNIQUE INDEX `idx_payments_idempotency` ON `payments` (`idempotency_key`);
CREATE UNIQUE INDEX `idx_webhookevents_dedupe` ON `webhook_events` (`source`, `event_id`);
CREATE UNIQUE INDEX `idx_leads_external` ON `leads` (`tenant_id`, `source`, `external_id`);
CREATE UNIQUE INDEX `idx_calls_provider` ON `call_records` (`provider`, `provider_call_id`);
CREATE UNIQUE INDEX `idx_autojobs_dedupe` ON `automation_jobs` (`rule_id`, `dedupe_key`);
DROP INDEX `payments_uq_idempotency_key_k` ON `payments`;
DROP INDEX `webhook_events_uq_event_id_k_source` ON `webhook_events`;
DROP INDEX `leads_uq_external_id_k_tenant_id_source` ON `leads`;
DROP INDEX `call_records_uq_provider_call_id_k_provider` ON `call_records`;
DROP INDEX `automation_jobs_uq_dedupe_key_k_rule_id` ON `automation_jobs`;
ALTER TABLE `payments` DROP COLUMN `idempotency_key_k`;
ALTER TABLE `webhook_events` DROP COLUMN `event_id_k`;
ALTER TABLE `leads` DROP COLUMN `external_id_k`;
ALTER TABLE `call_records` DROP COLUMN `provider_call_id_k`;
ALTER TABLE `automation_jobs` DROP COLUMN `dedupe_key_k`;
