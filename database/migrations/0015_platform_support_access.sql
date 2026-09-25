-- ---------------------------------------------------------------------------
-- 0015 — platform support access and the subscription lifecycle ledger.
--
-- Support access: a session the platform Super Admin opens inside an
-- organisation must carry who really holds it, so the original identity is
-- never lost, actions are attributed to the administrator (not the person
-- they act as), and view-only mode can be enforced server-side. The label is
-- frozen at mint time so audit attribution never depends on a later lookup.
--
-- Lifecycle: subscription changes need a history that outlives audit-log
-- retention — what plan an organisation was on, when a period was extended,
-- when a reminder was sent, when a payment was recorded by the platform.
-- One append-only ledger covers all of it.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN impersonator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN impersonator_label TEXT;
ALTER TABLE sessions ADD COLUMN impersonation_mode TEXT
  CHECK (impersonation_mode IN ('view','support') OR impersonation_mode IS NULL);

-- The dunning window after a missed renewal or an ended trial: past_due until
-- this moment, expired after it.
ALTER TABLE subscriptions ADD COLUMN grace_until TEXT;

CREATE TABLE subscription_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL
                    CHECK (kind IN ('plan_changed','period_extended','trial_extended','status_changed',
                                    'payment_recorded','reminder_sent','renewed','suspended','reactivated','note')),
  actor_id        TEXT,
  actor_name      TEXT,
  old_value_json  TEXT,
  new_value_json  TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_subevents_tenant ON subscription_events(tenant_id, created_at);
