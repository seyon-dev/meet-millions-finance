-- =============================================================================
-- 0005 — Notifications, messaging channels, voice notes and support tickets
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Notification templates — one row per trigger × channel.
-- --------------------------------------------------------------------------
CREATE TABLE notification_templates (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform default
  trigger_key     TEXT NOT NULL,        -- document.uploaded | payment.due | gst.due_date ...
  channel         TEXT NOT NULL
                    CHECK (channel IN ('email','sms','whatsapp','in_app','push')),
  name            TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,        -- {{placeholders}}
  provider_template_id TEXT,            -- e.g. approved WhatsApp template name
  variables_json  TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_nt_default ON notification_templates(trigger_key, channel) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_nt_tenant ON notification_templates(tenant_id, trigger_key, channel) WHERE tenant_id IS NOT NULL;

-- Per-tenant + per-user channel switches (the Notification Settings screen).
CREATE TABLE notification_preferences (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = tenant-wide default
  trigger_key   TEXT NOT NULL DEFAULT '*',
  email_enabled     INTEGER NOT NULL DEFAULT 1,
  sms_enabled       INTEGER NOT NULL DEFAULT 0,
  whatsapp_enabled  INTEGER NOT NULL DEFAULT 0,
  in_app_enabled    INTEGER NOT NULL DEFAULT 1,
  push_enabled      INTEGER NOT NULL DEFAULT 1,
  quiet_hours_start TEXT,
  quiet_hours_end   TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, user_id, trigger_key)
);

-- In-app notification feed.
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_key   TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  severity      TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','success','warning','danger')),
  icon          TEXT,
  link_path     TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  read_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at, created_at);

-- Outbound delivery queue/log across every channel. Nothing is reported as
-- "sent" unless a provider actually accepted it.
CREATE TABLE message_deliveries (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','push','in_app')),
  provider          TEXT,               -- ses | msg91 | whatsapp_cloud | fcm
  trigger_key       TEXT,
  template_id       TEXT,
  to_user_id        TEXT,
  to_address        TEXT NOT NULL,      -- email / E.164 / device token
  subject           TEXT,
  body              TEXT,
  attachments_json  TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sending','sent','delivered','read','opened','clicked','failed','bounced','skipped','not_configured')),
  provider_message_id TEXT,
  error_code        TEXT,
  error_message     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  opened_at         TEXT,
  clicked_at        TEXT,
  delivered_at      TEXT,
  entity_type       TEXT,
  entity_id         TEXT,
  client_id         TEXT,
  campaign_id       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_deliveries_tenant ON message_deliveries(tenant_id, channel, created_at);
CREATE INDEX idx_deliveries_status ON message_deliveries(status, created_at);
CREATE INDEX idx_deliveries_client ON message_deliveries(client_id, created_at);

-- Automation rules — the trigger→action engine behind Email/SMS automation.
CREATE TABLE automation_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_key     TEXT NOT NULL,
  conditions_json TEXT,                 -- [{field, op, value}]
  actions_json    TEXT NOT NULL,        -- [{type:'send_email', templateId, delayMinutes}]
  channel         TEXT,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_fired_at   TEXT,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_automation_tenant ON automation_rules(tenant_id, trigger_key, is_active);

-- --------------------------------------------------------------------------
-- WhatsApp Business API (add-on 01)
-- --------------------------------------------------------------------------
CREATE TABLE whatsapp_templates (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  language            TEXT NOT NULL DEFAULT 'en',
  category            TEXT NOT NULL DEFAULT 'UTILITY'
                        CHECK (category IN ('UTILITY','MARKETING','AUTHENTICATION')),
  header_text         TEXT,
  body_text           TEXT NOT NULL,
  footer_text         TEXT,
  buttons_json        TEXT,
  variables_json      TEXT,
  approval_status     TEXT NOT NULL DEFAULT 'draft'
                        CHECK (approval_status IN ('draft','pending','approved','rejected','disabled')),
  provider_template_id TEXT,
  rejection_reason    TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, name, language)
);

CREATE TABLE chat_threads (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','sms')),
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  contact_id        TEXT REFERENCES client_contacts(id) ON DELETE SET NULL,
  phone             TEXT NOT NULL,
  display_name      TEXT,
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','bot','assigned','snoozed','closed')),
  unread_count      INTEGER NOT NULL DEFAULT 0,
  last_message_at   TEXT,
  last_message_preview TEXT,
  window_expires_at TEXT,               -- the 24h customer-service window
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, channel, phone)
);
CREATE INDEX idx_chatthreads_tenant ON chat_threads(tenant_id, status, last_message_at);

CREATE TABLE chat_messages (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  thread_id           TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  type                TEXT NOT NULL DEFAULT 'text'
                        CHECK (type IN ('text','image','document','audio','video','template','interactive','location','system')),
  body                TEXT,
  media_key           TEXT,
  media_mime          TEXT,
  media_name          TEXT,
  template_id         TEXT,
  sent_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_bot              INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  error_message       TEXT,
  linked_document_id  TEXT REFERENCES documents(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_chatmessages_thread ON chat_messages(thread_id, created_at);

CREATE TABLE chatbot_flows (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  trigger_keywords_json TEXT,
  nodes_json    TEXT NOT NULL,          -- [{id,type,prompt,options,next,action}]
  entry_node_id TEXT,
  is_active     INTEGER NOT NULL DEFAULT 0,
  fallback_to_human INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE broadcasts (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  name              TEXT NOT NULL,
  template_id       TEXT,
  body              TEXT,
  audience_json     TEXT NOT NULL,      -- filter describing the recipient set
  recipient_count   INTEGER NOT NULL DEFAULT 0,
  sent_count        INTEGER NOT NULL DEFAULT 0,
  delivered_count   INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','scheduled','sending','completed','failed','cancelled')),
  scheduled_at      TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_broadcasts_tenant ON broadcasts(tenant_id, status);

-- --------------------------------------------------------------------------
-- Voice notes (add-on 04)
-- --------------------------------------------------------------------------
CREATE TABLE voice_notes (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE CASCADE,
  entity_type       TEXT,               -- query | document | client | task
  entity_id         TEXT,
  author_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  storage_key       TEXT NOT NULL,
  mime_type         TEXT NOT NULL DEFAULT 'audio/webm',
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  transcript        TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (transcript_status IN ('pending','processing','done','failed','not_configured','skipped')),
  transcript_lang   TEXT,
  transcript_confidence REAL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_voicenotes_entity ON voice_notes(entity_type, entity_id);
CREATE INDEX idx_voicenotes_client ON voice_notes(client_id, created_at);

-- --------------------------------------------------------------------------
-- Support tickets
-- --------------------------------------------------------------------------
CREATE TABLE support_tickets (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  company_id        TEXT REFERENCES companies(id) ON DELETE SET NULL,
  ticket_no         TEXT NOT NULL,
  subject           TEXT NOT NULL,
  description       TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'general'
                      CHECK (category IN ('general','technical','billing','document','filing','account','feature_request','bug','other')),
  priority          TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low','normal','high','urgent')),
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','waiting_customer','waiting_internal','resolved','closed','reopened')),
  raised_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  channel           TEXT NOT NULL DEFAULT 'portal'
                      CHECK (channel IN ('portal','email','whatsapp','phone','chat','api')),
  first_response_at TEXT,
  resolved_at       TEXT,
  closed_at         TEXT,
  resolution        TEXT,
  satisfaction_rating INTEGER,
  sla_due_at        TEXT,
  sla_breached      INTEGER NOT NULL DEFAULT 0,
  reopen_count      INTEGER NOT NULL DEFAULT 0,
  message_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, ticket_no)
);
CREATE INDEX idx_tickets_tenant_status ON support_tickets(tenant_id, status);
CREATE INDEX idx_tickets_client ON support_tickets(client_id, status);
CREATE INDEX idx_tickets_assignee ON support_tickets(assigned_to, status);

CREATE TABLE ticket_messages (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id         TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id         TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name       TEXT,
  author_kind       TEXT NOT NULL DEFAULT 'agent'
                      CHECK (author_kind IN ('agent','client','system')),
  body              TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'shared'
                      CHECK (visibility IN ('shared','internal')),
  attachments_json  TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_ticketmessages_ticket ON ticket_messages(ticket_id, created_at);
