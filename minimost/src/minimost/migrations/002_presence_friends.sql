-- 002_presence_friends.sql
-- Normalised friendship: one row per pair, with the lexicographically smaller
-- username in user_a. The CHECK keeps that invariant at the database level so a
-- pair can never be stored twice in both directions.
CREATE TABLE IF NOT EXISTS friends (
    user_a     TEXT NOT NULL,
    user_b     TEXT NOT NULL,
    created_ts REAL NOT NULL,
    PRIMARY KEY (user_a, user_b),
    CHECK (user_a < user_b)
);

-- "Who is friends with X?" queries X in either column; user_a hits the primary
-- key index, user_b needs this one.
CREATE INDEX IF NOT EXISTS idx_friends_b ON friends (user_b)
