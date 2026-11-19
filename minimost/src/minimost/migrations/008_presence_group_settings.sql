-- 008_presence_group_settings.sql
-- Per-group settings: a shareable group number and an invite policy.
--
-- group_no: an 8-digit number people can read out or paste ("群号"). It is
--   assigned lazily -- the column is nullable and the application fills it the
--   first time a group is read or created, which avoids a data migration that
--   would have to invent numbers for existing rows inside plain SQL. SQLite
--   treats NULLs as distinct in a UNIQUE index, so unassigned rows coexist.
--
-- invite_admin_only: until now "only admins may invite" was a single global flag
--   in settings.json. Groups need their own answer, so this is per row. The global
--   flag still applies as a floor, so an operator can tighten every group at once.
ALTER TABLE private_channels ADD COLUMN group_no TEXT;

ALTER TABLE private_channels ADD COLUMN invite_admin_only INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channels_group_no
    ON private_channels (group_no)
