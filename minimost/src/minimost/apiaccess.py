"""
minimost.apiaccess
==================

Machine access to the chat: issue API tokens from the Settings screen, and let
other programs push messages into a channel with one of them.

Why this lives in the same Flask process
----------------------------------------
A pushed message has to be indistinguishable from a typed one: it must land in
the shared ``messages`` table so history, search, mentions and read watermarks
treat it identically, and it must bump the SSE change counter so every open
client sees it immediately. Both of those live here, so the push route calls the
exact same helpers the ``/send/<channel>`` route uses instead of opening its own
write path.

Token model
-----------
* The plaintext token is returned **once**, at creation. Only its SHA-256 digest
  is stored, so a copy of ``presence.db`` cannot be replayed against the server.
* Tokens are high-entropy (32 random bytes), so a plain hash is sufficient --
  unlike a user password, there is nothing to guess. PBKDF2 would only add
  latency to every push.
* A token is scoped to the user who created it: pushes are attributed to that
  account and inherit its channel permissions. Revoking is a flag, not a delete,
  so ``last_used_ts`` survives for auditing.
* ``ff_`` prefix + the first characters are stored separately, so a token that
  leaks into a log can be identified without being usable.

Routes
------
Session-authenticated (called by the Settings screen)::

    GET    /api/tokens              list this user's tokens
    POST   /api/tokens              create one, returns the plaintext once
    DELETE /api/tokens/<id>         revoke one

Token-authenticated (called by any other program)::

    POST   /api/v1/messages         push a message into a channel
    GET    /api/v1/whoami           check a token and see who it belongs to
"""

import hashlib
import json
import secrets
import sqlite3
import time

from flask import Blueprint, jsonify, request, session

from . import audit
from . import auth
from . import chat
from . import presence
from . import ratelimit

apiaccess_bp = Blueprint("apiaccess", __name__)

_WAL = "PRAGMA journal_mode=WAL"

#: Prefix on every issued token. Makes a token recognisable in a log or a paste,
#: and lets the UI show "ff_ab12…" without revealing the secret.
TOKEN_PREFIX = "ff_"

#: 32 bytes = 256 bits of entropy: not guessable, and short enough to paste.
TOKEN_BYTES = 32

#: How many characters of the token are kept (hashed) for display.
_TOKEN_DISPLAY_CHARS = 8

#: Cap on live tokens per user, so a runaway script cannot fill the table.
MAX_TOKENS_PER_USER = 20

#: Longest label accepted for a token.
MAX_LABEL_LEN = 40


def _presence_db():
    """Open a WAL connection to ``presence.db`` (path read live for tests)."""
    db = sqlite3.connect(presence.PRESENCE_DB)
    db.execute(_WAL)
    db.row_factory = sqlite3.Row
    return db


def _hash_token(token: str) -> str:
    """Return the stored digest for *token*.

    SHA-256 without a salt is deliberate: the input is already 256 bits of
    randomness, so there is nothing for a rainbow table to find, and the digest
    must be computable from the presented token alone on every request.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _token_from_request():
    """Extract the presented API token from the request headers.

    Accepts ``Authorization: Bearer <token>`` (the convention every HTTP client
    supports) and ``X-API-Key: <token>`` (simpler for shell one-liners).

    :returns: The token string, or ``""`` when none was supplied.
    """
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.headers.get("X-API-Key", "").strip()


def _resolve_token(token: str):
    """Return the token's row if it is valid and not revoked, else ``None``."""
    if not token or not token.startswith(TOKEN_PREFIX):
        return None
    digest = _hash_token(token)
    db = _presence_db()
    try:
        row = db.execute(
            "SELECT id, owner, label, revoked FROM api_tokens WHERE token_hash = ?",
            (digest,),
        ).fetchone()
        if row is None or row["revoked"]:
            return None
        db.execute(
            "UPDATE api_tokens SET last_used_ts = ? WHERE id = ?", (time.time(), row["id"])
        )
        db.commit()
        return row
    finally:
        db.close()


def _serialise(row) -> dict:
    """Render a token row for the Settings screen (never the secret)."""
    return {
        "id": row["id"],
        "label": row["label"],
        "hint": row["hint"],
        "created_ts": row["created_ts"],
        "last_used_ts": row["last_used_ts"],
        "revoked": bool(row["revoked"]),
    }


# ── Token management (session) ─────────────────────────────────────────────


@apiaccess_bp.route("/api/tokens", methods=["GET"])
@auth.login_required
def list_tokens():
    """List the calling user's API tokens.

    Route: ``GET /api/tokens``

    The secret itself is never returned again -- only a short ``hint``
    (``ff_ab12cd34…``) so a person can tell two tokens apart.

    :returns: ``{"items": [...], "endpoint": "...", "max_tokens": N}``.
    """
    me = session["user"]
    db = _presence_db()
    try:
        rows = db.execute(
            "SELECT id, owner, label, hint, created_ts, last_used_ts, revoked"
            " FROM api_tokens WHERE owner = ? AND revoked = 0"
            " ORDER BY created_ts DESC",
            (me,),
        ).fetchall()
    finally:
        db.close()

    return jsonify(
        {
            "items": [_serialise(row) for row in rows],
            "endpoint": request.host_url.rstrip("/") + "/api/v1/messages",
            "max_tokens": MAX_TOKENS_PER_USER,
        }
    )


@apiaccess_bp.route("/api/tokens", methods=["POST"])
@auth.login_required
@ratelimit.rate_limit("api_token_create", by="user")
def create_token():
    """Mint a new API token for the calling user.

    Route: ``POST /api/tokens`` -- JSON body ``{"label": "..."}``.

    The plaintext token is in the response **and nowhere else**: it is not
    stored, so it cannot be shown again. Losing it means creating another and
    revoking this one.

    :returns: ``{"token": "...", "item": {...}}`` with 201, or ``409`` when the
        user already holds :data:`MAX_TOKENS_PER_USER` live tokens.
    """
    me = session["user"]
    data = request.get_json(silent=True) or {}
    label = str(data.get("label") or "").strip()[:MAX_LABEL_LEN] or "未命名令牌"

    db = _presence_db()
    try:
        live = db.execute(
            "SELECT COUNT(*) FROM api_tokens WHERE owner = ? AND revoked = 0", (me,)
        ).fetchone()[0]
        if live >= MAX_TOKENS_PER_USER:
            return (
                jsonify({"error": "too many tokens", "max_tokens": MAX_TOKENS_PER_USER}),
                409,
            )

        token = TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)
        now = time.time()
        cursor = db.execute(
            "INSERT INTO api_tokens (owner, label, hint, token_hash, created_ts)"
            " VALUES (?, ?, ?, ?, ?)",
            (me, label, token[:_TOKEN_DISPLAY_CHARS], _hash_token(token), now),
        )
        db.commit()
        row = db.execute(
            "SELECT id, owner, label, hint, created_ts, last_used_ts, revoked"
            " FROM api_tokens WHERE id = ?",
            (cursor.lastrowid,),
        ).fetchone()
    finally:
        db.close()

    audit.log_event(
        "api_token_create",
        "success",
        user=me,
        detail="token id {0}".format(row["id"]),
    )
    return jsonify({"token": token, "item": _serialise(row)}), 201


@apiaccess_bp.route("/api/tokens/<int:token_id>", methods=["DELETE"])
@auth.login_required
def revoke_token(token_id):
    """Revoke one of the calling user's tokens.

    Route: ``DELETE /api/tokens/<id>``

    Revocation is a flag, so the row (and its ``last_used_ts``) stays for
    auditing while the token immediately stops working.

    :returns: ``{"ok": true}``; ``404`` when the token is unknown or belongs to
        someone else.
    """
    me = session["user"]
    db = _presence_db()
    try:
        cursor = db.execute(
            "UPDATE api_tokens SET revoked = 1 WHERE id = ? AND owner = ?",
            (token_id, me),
        )
        db.commit()
        if cursor.rowcount == 0:
            return jsonify({"error": "token not found"}), 404
    finally:
        db.close()

    audit.log_event(
        "api_token_revoke",
        "success",
        user=me,
        detail="token id {0}".format(token_id),
    )
    return jsonify({"ok": True})


# ── Machine-facing routes (token auth) ─────────────────────────────────────


@apiaccess_bp.route("/api/v1/whoami", methods=["GET"])
@ratelimit.rate_limit("api_push", by="ip")
def api_whoami():
    """Report which account a token belongs to.

    Route: ``GET /api/v1/whoami`` with ``Authorization: Bearer <token>``.

    Useful as the first call when wiring up an integration: it proves the token
    is valid without posting anything into a channel.
    """
    row = _resolve_token(_token_from_request())
    if row is None:
        return jsonify({"error": "invalid token"}), 401
    return jsonify({"user": row["owner"], "token": row["label"]})


@apiaccess_bp.route("/api/v1/messages", methods=["POST"])
@ratelimit.rate_limit("api_push", by="ip")
def api_push_message():
    """Push a message into a channel as the token's owner.

    Route: ``POST /api/v1/messages``

    Headers: ``Authorization: Bearer <token>`` (or ``X-API-Key``).

    JSON body::

        {"channel": "general", "text": "hello from my script"}

    ``channel`` accepts any channel the owning account can post to: a public
    channel name, a ``private:<id>`` group/channel, or a ``dm:...`` identifier.

    The write goes through :func:`minimost.chat._insert_message`, the same helper
    ``/send/<channel>`` uses, so mentions, the sender's read watermark and the
    SSE wake-up all behave exactly as if the message had been typed. The message
    is attributed to the token owner; there is no way to post as somebody else.

    :returns: ``{"ok": true, "message": {...}}`` with 201, ``401`` for a missing
        or revoked token, ``403`` when the owner cannot post to that channel,
        ``400`` for a malformed body.
    """
    owner_row = _resolve_token(_token_from_request())
    if owner_row is None:
        return jsonify({"error": "invalid token"}), 401
    owner = owner_row["owner"]

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "expected a JSON object body"}), 400

    channel = str(data.get("channel") or "").strip()
    text = str(data.get("text") or "").strip()
    if not channel:
        return jsonify({"error": "channel is required"}), 400
    if not text:
        return jsonify({"error": "text is required"}), 400
    if len(text) > chat.MAX_MESSAGE_LEN:
        return (
            jsonify(
                {"error": "text too long", "max_length": chat.MAX_MESSAGE_LEN}
            ),
            400,
        )

    if not chat.is_valid_channel(channel, owner):
        return jsonify({"error": "not a channel this token may post to"}), 403

    mentions = chat._mentions_json(text, channel)
    now = time.time()

    db = chat.get_db()
    try:
        chat._insert_message(db, channel, owner, text, now, None, [], mentions)
        # The sender has by definition read their own message.
        chat._advance_read(db, owner, channel, now)
        db.commit()
        row = db.execute(
            "SELECT id, channel, sender, content, content_type, ts"
            " FROM messages WHERE channel = ? AND sender = ? AND ts = ?"
            " ORDER BY id DESC LIMIT 1",
            (channel, owner, now),
        ).fetchone()
    finally:
        db.close()

    payload = dict(row) if row is not None else {
        "channel": channel,
        "sender": owner,
        "content": text,
        "ts": now,
    }

    return jsonify({"ok": True, "message": payload}), 201
