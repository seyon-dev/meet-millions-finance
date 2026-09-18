-- ---------------------------------------------------------------------------
-- 0011 — Chatbot conversation state on a chat thread.
--
-- `chatbot_flows` has existed since 0005 but nothing could read or write it:
-- there was no API, no screen, and no way for an inbound message to enter a
-- flow. These three columns are what a thread needs to remember where it is in
-- one, so the bot can pick up a conversation on the next message instead of
-- starting over.
--
-- All three are nullable with sane defaults, so existing threads are unchanged
-- and behave exactly as before: no flow, no handover, nothing automated.
-- ---------------------------------------------------------------------------

-- The flow this thread is currently inside, if any. NULL means the bot is not
-- driving this conversation.
ALTER TABLE chat_threads ADD COLUMN bot_flow_id TEXT REFERENCES chatbot_flows(id) ON DELETE SET NULL;

-- Which node of that flow the thread is waiting at.
ALTER TABLE chat_threads ADD COLUMN bot_node_id TEXT;

-- Set once the bot has given up and a person is expected. It stays set so the
-- bot does not re-enter a conversation somebody has already taken over.
ALTER TABLE chat_threads ADD COLUMN bot_handed_over INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_chatthreads_bot ON chat_threads(tenant_id, bot_flow_id);
