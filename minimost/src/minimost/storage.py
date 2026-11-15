"""
minimost.storage
================

Storage report and cleanup ("存储空间").

Two problems this solves, both of which a long-running local chat runs into:

* **Where did the disk go?** A chat keeps four kinds of bytes -- the SQLite
  databases, uploaded attachments, avatars, imported stickers -- plus whatever
  SQLite's WAL is holding. Without a breakdown the only available answer is "look
  at the folder and guess".
* **Old group chatter is the bulk of it.** A finished group's 3000 messages and
  their images stay forever, so the panel lets a conversation's history be deleted
  on purpose, per conversation, rather than only by destroying the whole group.

Deliberately *not* here: any automatic deletion. Retention is configured in
``settings.json`` and runs on its own; this module only reports and, on an explicit
request, deletes.

Routes
------
::

    GET  /storage               sizes, per-conversation breakdown, orphan count
    POST /storage/purge         delete one conversation's history (owner/admin)
    POST /storage/orphans       delete attachment files no message references

Permissions mirror the group routes: a group's history may be cleared by its owner
or an admin (the people who may already remove members), a legacy private channel
by any member (it has no roles), and a DM by nobody -- a DM is one person's record
of a conversation with someone else, not a shared resource.
"""

import os
import sqlite3
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from . import audit
from . import auth
from . import common
from . import presence
from . import ratelimit
from . import chat
from .chat import (
    KIND_CHANNEL,
    KIND_GROUP,
    PRIVATE_CHANNEL_PREFIX,
    ROLE_ADMIN,
    ROLE_OWNER,
    _channel_kind,
    _member_role,
    get_db,
)

storage_bp = Blueprint("storage", __name__)

_WAL = "PRAGMA journal_mode=WAL"

def _upload_dir() -> Path:
    """Attachment directory, read live.

    Read through the module rather than bound at import: the test fixtures swap
    ``chat.UPLOAD_DIR`` for a temporary directory, and a value captured at import
    time would keep pointing at the real data directory (which is also how the
    first version of this file silently reported zero attachment bytes).
    """
    return Path(chat.UPLOAD_DIR)


def _avatar_dir() -> Path:
    return Path(chat.AVATAR_DIR)


def _sticker_dir() -> Path:
    """Imported stickers live next to uploads, so they follow the same swap."""
    return _upload_dir().parent / "stickers"


def _data_root() -> Path:
    """The data directory, taken from where the databases actually are."""
    return Path(auth.AUTH_DB).parent


def _database_paths() -> list[Path]:
    """The three databases, read live for the same reason as the uploads."""
    return [Path(auth.AUTH_DB), Path(presence.PRESENCE_DB), common.shared_db_path()]

#: A conversation whose history is small is not worth a destructive button, but
#: hiding it would be surprising -- so every conversation is listed and the client
#: decides how to present it. No threshold here.


def _dir_bytes(path: Path) -> tuple[int, int]:
    """Return ``(files, bytes)`` for a directory, ignoring unreadable entries."""
    files = 0
    total = 0
    if not path.is_dir():
        return 0, 0
    for entry in os.scandir(path):
        try:
            if entry.is_file(follow_symlinks=False):
                files += 1
                total += entry.stat().st_size
            elif entry.is_dir(follow_symlinks=False):
                sub_files, sub_bytes = _dir_bytes(Path(entry.path))
                files += sub_files
                total += sub_bytes
        except OSError:
            continue
    return files, total


def _file_bytes(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _sqlite_family_bytes(path: Path) -> int:
    """Size of a SQLite database including its WAL and shared-memory files.

    Leaving the ``-wal`` out understates the footprint by exactly the amount that
    has not been checkpointed yet, which for a busy chat is the part that matters.
    """
    return sum(
        _file_bytes(Path(str(path) + suffix)) for suffix in ("", "-wal", "-shm")
    )


def _conversation_rows():
    """Every private channel and group, with its transcript size.

    Returns a list of dicts ordered by bytes descending, because the useful
    question is "what is the biggest thing here".
    """
    rows: list[dict] = []
    db = get_db()
    try:
        preset = common.shared_db_path()
        message_counts = {
            row[0]: row[1]
            for row in db.execute(
                "SELECT channel, COUNT(*) FROM messages"
                " WHERE channel LIKE ? GROUP BY channel",
                (f"{PRIVATE_CHANNEL_PREFIX}%",),
            )
        }
        attachment_rows = db.execute(
            "SELECT channel, filename FROM messages"
            " WHERE channel LIKE ? AND filename IS NOT NULL",
            (f"{PRIVATE_CHANNEL_PREFIX}%",),
        ).fetchall()
    finally:
        db.close()

    attachments: dict[str, list[str]] = {}
    for channel, filename in attachment_rows:
        attachments.setdefault(channel, []).append(filename)

    pdb = sqlite3.connect(presence.PRESENCE_DB)
    pdb.row_factory = sqlite3.Row
    try:
        channels = pdb.execute(
            "SELECT id, name, COALESCE(kind, ?) AS kind FROM private_channels"
            " ORDER BY id",
            (KIND_CHANNEL,),
        ).fetchall()
    finally:
        pdb.close()

    for row in channels:
        channel = f"{PRIVATE_CHANNEL_PREFIX}{row['id']}"
        files = attachments.get(channel, [])
        # Attachments are the bytes that really add up; the rows themselves are
        # small, so report both instead of pretending the message count is a size.
        attachment_bytes = sum(_file_bytes(_upload_dir() / name) for name in files)
        rows.append(
            {
                "channel": channel,
                "id": row["id"],
                "name": row["name"],
                "kind": row["kind"],
                "messages": message_counts.get(channel, 0),
                "attachments": len(files),
                "attachment_bytes": attachment_bytes,
            }
        )

    rows.sort(key=lambda item: (item["attachment_bytes"], item["messages"]), reverse=True)
    return rows


def _can_purge(channel_id: int, user: str) -> bool:
    """Whether *user* may delete this conversation's history.

    Groups follow their role matrix (owner or admin); a legacy private channel has
    no roles, so any member may; anything else is refused.
    """
    kind = _channel_kind(channel_id)
    role = _member_role(channel_id, user)
    if role is None:
        return False
    if kind == KIND_GROUP:
        return role in (ROLE_OWNER, ROLE_ADMIN)
    if kind == KIND_CHANNEL:
        return True
    return False


def _referenced_attachment_names() -> set[str]:
    """Every stored filename a surviving message points at."""
    db = get_db()
    try:
        return {
            row[0]
            for row in db.execute(
                "SELECT filename FROM messages WHERE filename IS NOT NULL"
            )
        }
    finally:
        db.close()


@storage_bp.route("/storage", methods=["GET"])
@auth.login_required
def storage_report():
    """Report what is using disk, and what may be cleaned.

    Route: ``GET /storage``

    ``parts`` splits the data directory into the four things that actually grow
    (databases, uploads, avatars, stickers) and everything else, so the numbers in
    the panel add up to ``total_bytes`` instead of overlapping.

    :returns: JSON with ``total_bytes``, ``parts``, ``conversations`` (each with
        ``messages``, ``attachments``, ``attachment_bytes`` and ``can_purge``) and
        ``orphans`` (attachment files no message references).
    """
    user = session["user"]
    root = _data_root()

    databases = sum(_sqlite_family_bytes(path) for path in _database_paths())
    upload_files, upload_bytes = _dir_bytes(_upload_dir())
    avatar_files, avatar_bytes = _dir_bytes(_avatar_dir())
    sticker_files, sticker_bytes = _dir_bytes(_sticker_dir())

    # Everything else that sits in the data root (audit log, session key, WAL
    # leftovers of a database we do not otherwise size). Measured as the loose
    # files in the root so the four categories above are not double counted.
    other = 0
    if root.is_dir():
        for entry in os.scandir(root):
            if not entry.is_file(follow_symlinks=False):
                continue
            if Path(entry.path) in {p.resolve() for p in _database_paths()}:
                continue
            try:
                other += entry.stat().st_size
            except OSError:
                continue
    total = databases + upload_bytes + avatar_bytes + sticker_bytes + other

    conversations = _conversation_rows()
    for item in conversations:
        item["can_purge"] = _can_purge(item["id"], user)

    referenced = _referenced_attachment_names()
    orphan_files = 0
    orphan_bytes = 0
    if _upload_dir().is_dir():
        for entry in os.scandir(_upload_dir()):
            if not entry.is_file(follow_symlinks=False):
                continue
            if entry.name not in referenced:
                orphan_files += 1
                orphan_bytes += entry.stat().st_size

    return jsonify(
        {
            "data_dir": str(root),
            "total_bytes": total,
            "parts": {
                "databases": databases,
                "uploads": upload_bytes,
                "avatars": avatar_bytes,
                "stickers": sticker_bytes,
                "other": other,
            },
            "files": {
                "uploads": upload_files,
                "avatars": avatar_files,
                "stickers": sticker_files,
            },
            "conversations": conversations,
            "orphans": {"files": orphan_files, "bytes": orphan_bytes},
        }
    )


@storage_bp.route("/storage/purge", methods=["POST"])
@auth.login_required
@ratelimit.rate_limit("storage_purge", by="user")
def purge_conversation():
    """Delete one conversation's messages and their attachments.

    Route: ``POST /storage/purge`` -- body ``{"channel": "private:3"}``.

    Only the transcript goes: the conversation itself, its members and its roles
    stay, so people can carry on talking afterwards. A system line records who
    cleared it, which is the one message that survives.

    :returns: JSON ``{"freed_bytes": int, "messages": int, "files": int}``;
        ``403`` when the caller may not, ``400`` for a channel that is not a
        conversation, ``404`` for one that does not exist.
    """
    user = session["user"]
    data = request.get_json(silent=True) or {}
    channel = (data.get("channel") or "").strip()
    if not channel.startswith(PRIVATE_CHANNEL_PREFIX):
        return "channel must be a private conversation", 400
    try:
        channel_id = int(channel[len(PRIVATE_CHANNEL_PREFIX):])
    except ValueError:
        return "channel must be a private conversation", 400

    if _channel_kind(channel_id) is None:
        return "conversation not found", 404
    if not _can_purge(channel_id, user):
        return "forbidden", 403

    db = get_db()
    try:
        names = [
            row[0]
            for row in db.execute(
                "SELECT filename FROM messages WHERE channel = ? AND filename IS NOT NULL",
                (channel,),
            ).fetchall()
        ]
        message_count = db.execute(
            "SELECT COUNT(*) FROM messages WHERE channel = ?", (channel,)
        ).fetchone()[0]
        db.execute(
            "DELETE FROM reactions WHERE message_id IN"
            " (SELECT id FROM messages WHERE channel = ?)",
            (channel,),
        )
        db.execute("DELETE FROM messages WHERE channel = ?", (channel,))
        db.execute("DELETE FROM read_state WHERE channel = ?", (channel,))
        db.commit()
    finally:
        db.close()

    freed = 0
    removed_files = 0
    for name in names:
        path = _upload_dir() / name
        try:
            size = path.stat().st_size
            path.unlink()
            freed += size
            removed_files += 1
        except OSError:
            continue

    # Leave one line behind so the others can see why their history is gone.
    from .chat import _post_system_message

    _post_system_message(channel_id, f"{user} cleared this conversation's history")

    audit.log_event(
        "storage_purge",
        "success",
        user=user,
        detail=f"{channel}: {message_count} messages, {removed_files} files, {freed} bytes",
    )
    return jsonify(
        {"freed_bytes": freed, "messages": message_count, "files": removed_files}
    )


@storage_bp.route("/storage/orphans", methods=["POST"])
@auth.login_required
@ratelimit.rate_limit("storage_purge", by="user")
def delete_orphans():
    """Delete attachment files that no message points at any more.

    Route: ``POST /storage/orphans``

    These accumulate when messages are deleted individually: the row goes, the
    file stays. Removing them is safe precisely because nothing references them.

    :returns: JSON ``{"freed_bytes": int, "files": int}``.
    """
    user = session["user"]
    referenced = _referenced_attachment_names()
    freed = 0
    removed = 0
    if _upload_dir().is_dir():
        for entry in os.scandir(_upload_dir()):
            if not entry.is_file(follow_symlinks=False):
                continue
            if entry.name in referenced:
                continue
            try:
                size = entry.stat().st_size
                os.unlink(entry.path)
                freed += size
                removed += 1
            except OSError:
                continue

    audit.log_event(
        "storage_orphans",
        "success",
        user=user,
        detail=f"{removed} files, {freed} bytes",
    )
    return jsonify({"freed_bytes": freed, "files": removed})
