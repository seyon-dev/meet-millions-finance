-- ---------------------------------------------------------------------------
-- 0014 — rename oauth_states.state to state_hash on databases imported from
-- an older baseline.
--
-- TRANSLATION-ONLY: the SQLite migrations renamed this column in 0010, and
-- the schema generator silently dropped the RENAME COLUMN statement it did
-- not recognise — so the generated MySQL baseline kept the old name, and
-- every OAuth query, which reads state_hash, failed with "Unknown column".
-- database/migrations is already correct; only the translation diverged.
--
-- Additive in effect: the column and its data survive, only the name changes.
-- ---------------------------------------------------------------------------

ALTER TABLE `oauth_states` RENAME COLUMN `state` TO `state_hash`;
