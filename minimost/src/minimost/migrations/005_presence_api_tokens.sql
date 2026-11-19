-- 005_presence_api_tokens.sql
-- Machine-access tokens issued from the Settings screen ("API 接入服务").
--
-- One row per issued token. Only the SHA-256 digest is stored: the plaintext
-- exists solely in the HTTP response that created it, so a copy of this database
-- cannot be replayed against the server. `hint` keeps the first few characters
-- so a person can tell two tokens apart without exposing either.
--
-- Revoking sets `revoked = 1` rather than deleting the row, so `last_used_ts`
-- survives for auditing and a re-created token is never confused with the old
-- one.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner        TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    hint         TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    created_ts   REAL NOT NULL,
    last_used_ts REAL,
    revoked      INTEGER NOT NULL DEFAULT 0
);

-- The Settings screen lists "my live tokens, newest first".
CREATE INDEX IF NOT EXISTS idx_api_tokens_owner
    ON api_tokens (owner, revoked, created_ts)
