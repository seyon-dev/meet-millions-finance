-- Store only the hash of an OAuth state value.
--
-- The state is the one thing standing between a stolen authorisation code and
-- a linked account, so the database should not hold a value that could be
-- replayed as a valid callback. The column is renamed rather than shadowed so
-- its name says what it holds.

ALTER TABLE oauth_states RENAME COLUMN state TO state_hash;
