-- 009_presence_group_join_requests.sql
-- "Join by group number": a person who knows a group's number asks to be let in,
-- and an owner or admin decides.
--
-- A request is a row rather than a flag on the membership table because the
-- history matters: who asked, when, what was decided and by whom. The applicant
-- can also withdraw, which is a state, not a deletion.
--
-- The partial unique index is the important bit: it allows exactly one *pending*
-- request per person per group, while leaving any number of decided rows so a
-- rejected applicant can ask again later.
CREATE TABLE IF NOT EXISTS group_join_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id  INTEGER NOT NULL,
    username    TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    created_ts  REAL NOT NULL,
    decided_by  TEXT,
    decided_ts  REAL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_join_pending
    ON group_join_requests (channel_id, username)
    WHERE status = 'pending';

-- The owner's queue: pending requests for one group.
CREATE INDEX IF NOT EXISTS idx_group_join_channel
    ON group_join_requests (channel_id, status, created_ts);

-- The applicant's view: my own requests wherever they stand.
CREATE INDEX IF NOT EXISTS idx_group_join_user
    ON group_join_requests (username, status, created_ts);
