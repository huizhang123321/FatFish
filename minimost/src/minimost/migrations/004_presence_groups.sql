-- 004_presence_groups.sql
-- Distinguish user-created "groups" from legacy private channels, and give each
-- private-channel member a role. Both are additive columns with defaults, so
-- existing rows and the legacy private-channel behaviour are unchanged.
ALTER TABLE private_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
ALTER TABLE private_channel_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- Backfill: the creator of every existing private channel becomes its owner.
-- Idempotent — once role is 'owner' the WHERE clause no longer matches.
UPDATE private_channel_members
   SET role = 'owner'
 WHERE role = 'member'
   AND username = (
       SELECT created_by FROM private_channels
        WHERE private_channels.id = private_channel_members.channel_id
   )
