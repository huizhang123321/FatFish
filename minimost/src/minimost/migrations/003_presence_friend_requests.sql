-- 003_presence_friend_requests.sql
-- One row per friend request. Status moves pending -> accepted/rejected (both
-- terminal). The requester withdrawing deletes the pending row outright.
CREATE TABLE IF NOT EXISTS friend_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user   TEXT NOT NULL,
    to_user     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_ts  REAL NOT NULL,
    resolved_ts REAL,
    CHECK (from_user <> to_user)
);

-- At most one pending request per (from_user, to_user) direction. A partial
-- unique index so accepted/rejected history rows never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fr_pending_pair
    ON friend_requests (from_user, to_user) WHERE status = 'pending';

-- Inbox query: "requests sent to me, still pending, newest first".
CREATE INDEX IF NOT EXISTS idx_fr_to_status
    ON friend_requests (to_user, status, created_ts)
