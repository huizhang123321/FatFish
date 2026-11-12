"""
minimost.stickers
=================

User-imported stickers ("表情包").

The app ships a handful of original SVG stickers (see
``desktop/src/lib/stickers.ts`` and ``minimost/static/stickers/``). This module lets
people add their own images to that panel.

Design notes
------------
**Why the server stores them.** A sticker someone imports has to appear the same
for everyone in the conversation, otherwise it is just an image in one person's
browser. So the bytes and the name live on the server, and a message references a
sticker by id.

**Why the files live in the data directory.** ``data_dir()/stickers`` is where all
mutable state lives, so imports survive a reinstall (the install directory is
replaced) and are backed up with the rest of the chat. Nothing is written next to
the code.

**Why the bytes are sniffed.** The extension alone would let someone upload an
HTML or SVG file and have it served from the app's own origin — stored XSS. Only
PNG/JPEG/GIF/WebP signatures are accepted, and the response always carries an
explicit image content type plus ``nosniff`` (set globally by the app).

A message refers to a custom sticker with the token ``[sticker:custom-<id>]``, which
keeps the renderer stateless: it can build the URL from the id alone, exactly like
the built-in ones.

Routes
------
::

    GET    /stickers                list imported stickers
    POST   /stickers                import one (multipart: file, optional name)
    DELETE /stickers/<id>           remove one (only the person who imported it)
    GET    /stickers/<id>/image     the image bytes
"""

import secrets
import sqlite3
import time
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file, session

from . import audit
from . import auth
from . import presence
from . import ratelimit
from .paths import data_dir

stickers_bp = Blueprint("stickers", __name__)

_WAL = "PRAGMA journal_mode=WAL"

#: Where imported sticker images are kept.
STICKER_DIR = data_dir() / "stickers"
STICKER_DIR.mkdir(parents=True, exist_ok=True)

#: Per-file ceiling. A sticker is a small picture; anything bigger is a mistake.
MAX_STICKER_BYTES = 1024 * 1024

#: How many imported stickers may exist in total.
MAX_STICKERS = 300

#: Sniffed signatures -> (extension, mime type). SVG is deliberately absent: it can
#: carry script, and this file is served from the app's own origin.
_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", ".png", "image/png"),
    (b"\xff\xd8\xff", ".jpg", "image/jpeg"),
    (b"GIF87a", ".gif", "image/gif"),
    (b"GIF89a", ".gif", "image/gif"),
)

_MIME_BY_EXT = {".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


def _presence_db():
    """Open a WAL connection to ``presence.db`` (path read live for tests)."""
    db = sqlite3.connect(presence.PRESENCE_DB)
    db.execute(_WAL)
    db.row_factory = sqlite3.Row
    return db


def _detect_image(head: bytes):
    """Return ``(extension, mime)`` for a supported image, or ``(None, None)``.

    Signature-based, because trusting the upload's own filename is how image
    uploads turn into stored XSS.
    """
    for signature, extension, mime in _SIGNATURES:
        if head.startswith(signature):
            return extension, mime
    # WebP: RIFF....WEBP
    if len(head) >= 12 and head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return ".webp", "image/webp"
    return None, None


def _serialise(row) -> dict:
    """Render one sticker row for the client."""
    return {
        "id": row["id"],
        # The token the message carries and the client renders.
        "token": "[sticker:custom-{0}]".format(row["id"]),
        "name": row["name"],
        "url": "/stickers/{0}/image".format(row["id"]),
        "uploader": row["uploader"],
        "created_ts": row["created_ts"],
    }


@stickers_bp.route("/stickers", methods=["GET"])
@auth.login_required
def list_stickers():
    """List every imported sticker, newest last.

    Route: ``GET /stickers``

    All stickers are visible to everyone: they are a shared library, the same way
    the built-in set is. ``uploader`` is included so the UI can offer a delete
    button only to the person who added it.

    :returns: ``{"items": [...]}``.
    """
    me = session["user"]
    db = _presence_db()
    try:
        rows = db.execute(
            "SELECT id, name, uploader, created_ts FROM custom_stickers"
            " ORDER BY created_ts ASC, id ASC"
        ).fetchall()
    finally:
        db.close()

    items = []
    for row in rows:
        item = _serialise(row)
        item["mine"] = row["uploader"] == me
        items.append(item)
    return jsonify({"items": items, "max": MAX_STICKERS, "max_bytes": MAX_STICKER_BYTES})


@stickers_bp.route("/stickers", methods=["POST"])
@auth.login_required
@ratelimit.rate_limit("sticker_upload", by="user")
def import_sticker():
    """Import one sticker image.

    Route: ``POST /stickers`` — multipart with ``file`` and an optional ``name``.

    The image is validated by its signature before anything is written, so a
    renamed ``.png`` that is really HTML is rejected rather than stored and served
    from the app's origin.

    :returns: ``{"item": {...}}`` with 201, ``400`` for a missing/unsupported file,
        ``413`` when too large, ``409`` when the library is full.
    """
    me = session["user"]
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return jsonify({"error": "file is required"}), 400

    head = upload.stream.read(32)
    upload.stream.seek(0)
    extension, mime = _detect_image(head)
    if extension is None:
        return jsonify({"error": "only PNG, JPEG, GIF or WebP images are accepted"}), 400

    upload.stream.seek(0, 2)
    size = upload.stream.tell()
    upload.stream.seek(0)
    if size > MAX_STICKER_BYTES:
        return (
            jsonify({"error": "file too large", "max_bytes": MAX_STICKER_BYTES}),
            413,
        )

    name = (request.form.get("name") or "").strip()[:40]

    db = _presence_db()
    try:
        existing = db.execute("SELECT COUNT(*) FROM custom_stickers").fetchone()[0]
        if existing >= MAX_STICKERS:
            return jsonify({"error": "sticker library is full", "max": MAX_STICKERS}), 409

        # A random name: the upload's own filename never reaches the filesystem, so
        # no traversal and no collisions.
        stored = secrets.token_hex(16) + extension
        upload.save(STICKER_DIR / stored)
        cursor = db.execute(
            "INSERT INTO custom_stickers (name, stored_name, uploader, created_ts)"
            " VALUES (?, ?, ?, ?)",
            (name, stored, me, time.time()),
        )
        db.commit()
        row = db.execute(
            "SELECT id, name, uploader, created_ts FROM custom_stickers WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    finally:
        db.close()

    audit.log_event("sticker_import", "success", user=me, detail="sticker id {0}".format(row["id"]))
    item = _serialise(row)
    item["mine"] = True
    return jsonify({"item": item, "mime": mime}), 201


@stickers_bp.route("/stickers/<int:sticker_id>", methods=["DELETE"])
@auth.login_required
def delete_sticker(sticker_id):
    """Remove an imported sticker.

    Route: ``DELETE /stickers/<id>``

    Only the person who imported it may remove it. Messages that already reference
    it keep their token, which then renders as text rather than a broken image —
    the same rule as an unknown built-in id.

    :returns: ``{"ok": true}``; ``404`` unknown, ``403`` not the importer.
    """
    me = session["user"]
    db = _presence_db()
    try:
        row = db.execute(
            "SELECT id, stored_name, uploader FROM custom_stickers WHERE id = ?",
            (sticker_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "sticker not found"}), 404
        if row["uploader"] != me:
            return jsonify({"error": "forbidden"}), 403

        db.execute("DELETE FROM custom_stickers WHERE id = ?", (sticker_id,))
        db.commit()
    finally:
        db.close()

    try:
        (STICKER_DIR / row["stored_name"]).unlink()
    except OSError:
        # A missing file is not worth failing the request over: the row is gone, so
        # nothing can reference it any more.
        pass

    audit.log_event("sticker_delete", "success", user=me, detail="sticker id {0}".format(sticker_id))
    return jsonify({"ok": True})


@stickers_bp.route("/stickers/<int:sticker_id>/image", methods=["GET"])
@auth.login_required
def sticker_image(sticker_id):
    """Serve an imported sticker's bytes.

    Route: ``GET /stickers/<id>/image``

    Requires a session but no other permission: the sticker library is shared, just
    like the built-in one. The content type is derived from the stored extension and
    was decided when the file was sniffed, never from the client's input.
    """
    db = _presence_db()
    try:
        row = db.execute(
            "SELECT stored_name FROM custom_stickers WHERE id = ?", (sticker_id,)
        ).fetchone()
    finally:
        db.close()

    if row is None:
        abort(404)

    path = STICKER_DIR / row["stored_name"]
    if not path.is_file():
        abort(404)

    mime = _MIME_BY_EXT.get(Path(row["stored_name"]).suffix.lower(), "application/octet-stream")
    response = send_file(path, mimetype=mime, conditional=True)
    response.headers["Content-Type"] = mime
    return response
