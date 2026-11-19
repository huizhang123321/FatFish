-- 010_presence_group_discoverable.sql
-- Whether a group may be found by searching its name.
--
-- Off by default, deliberately: a group called "家里人" or "三号楼业主" is not
-- something its members expect strangers to browse. Knowing the *number* is a
-- different thing -- that is shared on purpose -- so number lookup ignores this
-- flag entirely.
--
-- The owner turns it on in the group settings when they want the group to be
-- discoverable.
ALTER TABLE private_channels ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;

-- Name search filters on discoverable first, then matches the name.
CREATE INDEX IF NOT EXISTS idx_private_channels_discoverable
    ON private_channels (discoverable, name)
