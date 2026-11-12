-- 006_presence_stickers.sql
-- Sticker library imported from the UI ("表情包").
--
-- Only the bookkeeping lives here; the image bytes are files under
-- <data dir>/stickers, so they sit next to the uploads and avatars and survive a
-- reinstall. `stored_name` is a random hex name chosen by the server -- the
-- uploaded filename never reaches the filesystem, which rules out traversal.
CREATE TABLE IF NOT EXISTS custom_stickers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL DEFAULT '',
    stored_name TEXT NOT NULL UNIQUE,
    uploader    TEXT NOT NULL,
    created_ts  REAL NOT NULL
);

-- The picker lists the whole shared library in insertion order.
CREATE INDEX IF NOT EXISTS idx_custom_stickers_created
    ON custom_stickers (created_ts, id)
