-- ---------------------------------------------------------------------------
-- 0015 — platform support access and the subscription lifecycle ledger.
-- MySQL equivalent of database/migrations/0015_platform_support_access.sql.
-- Additive only; every statement is safe to re-run (the runner treats
-- duplicate-column/table errors as already-applied work).
-- ---------------------------------------------------------------------------

ALTER TABLE `sessions` ADD COLUMN `impersonator_user_id` VARCHAR(64) NULL;
ALTER TABLE `sessions` ADD COLUMN `impersonator_label` TEXT NULL;
ALTER TABLE `sessions` ADD COLUMN `impersonation_mode` VARCHAR(16) NULL;

ALTER TABLE `subscriptions` ADD COLUMN `grace_until` TEXT NULL;

CREATE TABLE IF NOT EXISTS `subscription_events` (
  `id`              VARCHAR(64) PRIMARY KEY,
  `tenant_id`       VARCHAR(64) NOT NULL,
  `subscription_id` VARCHAR(64) NULL,
  `kind`            VARCHAR(32) NOT NULL,
  `actor_id`        VARCHAR(64) NULL,
  `actor_name`      TEXT NULL,
  `old_value_json`  TEXT NULL,
  `new_value_json`  TEXT NULL,
  `note`            TEXT NULL,
  `created_at`      VARCHAR(64) NOT NULL,
  CONSTRAINT `fk_subevents_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX `idx_subevents_tenant` ON `subscription_events` (`tenant_id`, `created_at`);
