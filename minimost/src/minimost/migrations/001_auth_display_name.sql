-- 001_auth_display_name.sql
-- Add a display_name column to user_settings so users can set a friendly name
-- that user search matches on (alongside the username). NULL falls back to the
-- username everywhere it is read. Idempotent: the runner tolerates the
-- "duplicate column name" error if the column already exists.
ALTER TABLE user_settings ADD COLUMN display_name TEXT
