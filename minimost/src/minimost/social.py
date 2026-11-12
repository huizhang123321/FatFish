"""
minimost.social
===============

User search, the friend system, and display-name profiles.

This blueprint is a pure addition to upstream MiniMost: it introduces no new
dependency, no new database file, and no change to the message path. Friend
relations and requests live in the shared ``presence.db`` (alongside presence
and private-channel membership); the searchable ``display_name`` is a new column
on ``auth.db``'s ``user_settings``. Both are created by :mod:`minimost.migrations`.

Design notes
------------
* **Normalised friendship.** ``friends`` stores one row per pair with the
  lexicographically smaller username in ``user_a`` (a ``CHECK`` enforces it), so
  "are A and B friends?" is a single indexed lookup and a pair can never be
  duplicated in both directions.
* **Requests are a small state machine.** ``friend_requests.status`` moves
  ``pending -> accepted | rejected``; the requester withdrawing deletes the
  pending row. A partial unique index keeps at most one pending request per
  direction, so the database itself rejects a duplicate send.
* **SSE parity.** :func:`list_friends` and :func:`list_friend_requests` are the
  very functions registered as SSE collectors in :mod:`minimost.events`, so a
  pushed ``friends`` / ``friend_requests`` payload is byte-for-byte what the
  matching REST call returns. ``list_friend_requests`` reads ``request.args``
  with ``direction``/``status`` defaults of ``in``/``pending``; the ``/events``
  URL carries neither, so the stream always pushes the current user's incoming
  pending requests — exactly the "someone added you" notification.
* **CSRF.** Like the chat/presence JSON APIs, these routes rely on the
  ``SameSite=Lax`` session cookie rather than a token (only the ``auth``
  blueprint's HTML forms are token-checked).
"""

import sqlite3
import time

from flask import Blueprint, jsonify, request, session

from . import auth, presence, ratelimit

social_bp = Blueprint("social", __name__)

_WAL = "PRAGMA journal_mode=WAL"

# Match chat._like_literal: backslash is the LIKE escape character, so escape it
# first, then the two wildcards. Usernames may contain '_' (auth._USERNAME_RE),
# which is a single-char wildcard — leaving it unescaped would let 'a_ice' match
# 'alice'. Every LIKE pattern built from user input uses this + ESCAPE '\'.
_LIKE_ESCAPE = "\\"

# A display name is capped at the same length as a username.
_MAX_DISPLAY_NAME_LEN = 32

# Bound on a single friend-requests listing. History is small; the inbox view
# (the common case) is far under this.
_MAX_REQUESTS_LISTED = 200

# Search paging bounds.
_DEFAULT_PAGE_SIZE = 20
_MAX_PAGE_SIZE = 50
_MAX_QUERY_LEN = 32


def _like_literal(value):
    """Escape LIKE metacharacters so *value* matches only itself."""
    return (
        value.replace(_LIKE_ESCAPE, _LIKE_ESCAPE * 2)
        .replace("%", _LIKE_ESCAPE + "%")
        .replace("_", _LIKE_ESCAPE + "_")
    )


def _pair(a, b):
    """Return the two usernames in the canonical (smaller, larger) order."""
    return (a, b) if a < b else (b, a)


def _auth_db():
    """Open a WAL connection to ``auth.db`` (path read live for test monkeypatch)."""
    db = sqlite3.connect(auth.AUTH_DB)
    db.execute(_WAL)
    return db


def _presence_db():
    """Open a WAL connection to ``presence.db`` (path read live for tests)."""
    db = sqlite3.connect(presence.PRESENCE_DB)
    db.execute(_WAL)
    return db


def _resolve_username(name):
    """Return the canonical stored spelling of *name*, or ``None`` if unknown.

    Usernames are unique case-insensitively (see :func:`minimost.auth.login_post`),
    so every lookup that takes a user-supplied name resolves it here first and
    then works with the canonical spelling.
    """
    if not name:
        return None
    db = _auth_db()
    try:
        row = db.execute(
            "SELECT username FROM users WHERE username = ? COLLATE NOCASE", (name,)
        ).fetchone()
    finally:
        db.close()
    return row[0] if row else None


def _settings_map(usernames):
    """Return ``{username: (display_name, has_avatar, name_color)}`` for *usernames*.

    Users with no ``user_settings`` row are absent from the map; callers fall
    back to ``(None, False, None)``.
    """
    names = [n for n in dict.fromkeys(usernames) if n]
    if not names:
        return {}
    placeholders = ",".join("?" * len(names))
    db = _auth_db()
    try:
        rows = db.execute(
            "SELECT username, display_name, avatar_file, name_color"
            " FROM user_settings WHERE username IN ({0})".format(placeholders),
            names,
        ).fetchall()
    finally:
        db.close()
    return {r[0]: (r[1], r[2] is not None, r[3]) for r in rows}


def _relation_sets(me):
    """Return ``(friend_set, out_pending, in_pending)`` for user *me*.

    * ``friend_set`` — usernames ``me`` is friends with.
    * ``out_pending`` — ``{to_username: request_id}`` for requests ``me`` sent.
    * ``in_pending`` — ``{from_username: request_id}`` for requests ``me`` got.
    """
    db = _presence_db()
    try:
        friend_set = set()
        for a, b in db.execute(
            "SELECT user_a, user_b FROM friends WHERE user_a = ? OR user_b = ?",
            (me, me),
        ).fetchall():
            friend_set.add(b if a == me else a)
        out_pending = {
            to: rid
            for (to, rid) in db.execute(
                "SELECT to_user, id FROM friend_requests"
                " WHERE from_user = ? AND status = 'pending'",
                (me,),
            ).fetchall()
        }
        in_pending = {
            frm: rid
            for (frm, rid) in db.execute(
                "SELECT from_user, id FROM friend_requests"
                " WHERE to_user = ? AND status = 'pending'",
                (me,),
            ).fetchall()
        }
    finally:
        db.close()
    return friend_set, out_pending, in_pending


def _relation_of(username, me, friend_set, out_pending, in_pending):
    """Classify *username* relative to *me* as ``(relation, request_id)``."""
    if username == me:
        return "self", None
    if username in friend_set:
        return "friend", None
    if username in out_pending:
        return "pending_out", out_pending[username]
    if username in in_pending:
        return "pending_in", in_pending[username]
    return "none", None


# ── User search ────────────────────────────────────────────────────────────


@social_bp.route("/users/search", methods=["GET"])
@auth.login_required
@ratelimit.rate_limit(
    "user_search",
    by="user",
    on_limit=lambda retry: (
        {"error": ratelimit.rate_limit_message(retry)},
        429,
        {"Retry-After": str(retry)},
    ),
)
def search_users():
    """Search registered users by username or display name, paginated.

    Route: ``GET /users/search?q=<term>&page=<n>&page_size=<n>``

    Matching is a case-insensitive substring match on both ``users.username``
    and ``user_settings.display_name``. Results are ordered with username-prefix
    hits first, then by username, so paging is stable. The current user is
    excluded. Each item carries its friendship ``relation`` to the caller so the
    client can render the right action button without a second round trip.

    :query q: Search term (required, 1–32 chars; longer is truncated).
    :query page: 1-based page number (default 1).
    :query page_size: Items per page (default 20, max 50).
    :returns: ``{items, page, page_size, total, total_pages}``.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"error": "q is required"}), 400
    if len(q) > _MAX_QUERY_LEN:
        q = q[:_MAX_QUERY_LEN]

    try:
        page = max(1, int(request.args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        page_size = int(request.args.get("page_size", _DEFAULT_PAGE_SIZE))
    except (TypeError, ValueError):
        page_size = _DEFAULT_PAGE_SIZE
    page_size = min(_MAX_PAGE_SIZE, max(1, page_size))
    offset = (page - 1) * page_size

    esc = _like_literal(q)
    contains = "%" + esc + "%"
    prefix = esc + "%"

    db = _auth_db()
    try:
        total = db.execute(
            "SELECT COUNT(*) FROM users u"
            " LEFT JOIN user_settings s ON s.username = u.username"
            " WHERE u.username <> ?"
            " AND (u.username LIKE ? ESCAPE '\\'"
            "      OR COALESCE(s.display_name, '') LIKE ? ESCAPE '\\')",
            (me, contains, contains),
        ).fetchone()[0]
        rows = db.execute(
            "SELECT u.username, s.display_name, s.avatar_file, s.name_color"
            " FROM users u LEFT JOIN user_settings s ON s.username = u.username"
            " WHERE u.username <> ?"
            " AND (u.username LIKE ? ESCAPE '\\'"
            "      OR COALESCE(s.display_name, '') LIKE ? ESCAPE '\\')"
            " ORDER BY (u.username LIKE ? ESCAPE '\\') DESC, u.username"
            " LIMIT ? OFFSET ?",
            (me, contains, contains, prefix, page_size, offset),
        ).fetchall()
    finally:
        db.close()

    friend_set, out_pending, in_pending = _relation_sets(me)
    items = []
    for username, display_name, avatar_file, name_color in rows:
        relation, request_id = _relation_of(
            username, me, friend_set, out_pending, in_pending
        )
        items.append(
            {
                "username": username,
                "display_name": display_name,
                "avatar": avatar_file is not None,
                "name_color": name_color,
                "relation": relation,
                "request_id": request_id,
            }
        )

    total_pages = (total + page_size - 1) // page_size if page_size else 0
    return jsonify(
        {
            "items": items,
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        }
    )


# ── Display-name profile ───────────────────────────────────────────────────


@social_bp.route("/profile", methods=["GET"])
@auth.login_required
def get_profile():
    """Return the current user's profile fields.

    Route: ``GET /profile``

    :returns: ``{username, display_name, bio, name_color}``.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    db = _auth_db()
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT display_name, bio, name_color FROM user_settings"
            " WHERE username = ?",
            (me,),
        ).fetchone()
    finally:
        db.close()
    return jsonify(
        {
            "username": me,
            "display_name": row["display_name"] if row else None,
            "bio": row["bio"] if row else None,
            "name_color": row["name_color"] if row else None,
        }
    )


@social_bp.route("/profile", methods=["POST"])
@auth.login_required
def set_profile():
    """Set or clear the current user's display name.

    Route: ``POST /profile`` — JSON body ``{"display_name": "..."}``.

    An empty string or ``null`` clears the display name (reads fall back to the
    username). The name is trimmed and capped at 32 characters. Avatar and
    colour remain on the existing ``/avatar`` and ``/settings`` routes.

    :returns: ``{"ok": true}``, or ``{"error": ...}`` with 400 when too long.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    data = request.get_json(silent=True) or {}
    raw = data.get("display_name")
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        display_name = None
    else:
        if not isinstance(raw, str):
            return jsonify({"error": "display_name must be a string"}), 400
        display_name = raw.strip()
        if len(display_name) > _MAX_DISPLAY_NAME_LEN:
            return jsonify({"error": "display_name too long"}), 400

    db = _auth_db()
    try:
        db.execute("INSERT OR IGNORE INTO user_settings (username) VALUES (?)", (me,))
        db.execute(
            "UPDATE user_settings SET display_name = ? WHERE username = ?",
            (display_name, me),
        )
        db.commit()
    finally:
        db.close()
    return jsonify({"ok": True})


# ── Friend requests ────────────────────────────────────────────────────────


@social_bp.route("/friends/requests", methods=["POST"])
@auth.login_required
@ratelimit.rate_limit(
    "friend_request",
    by="user",
    on_limit=lambda retry: (
        {"error": ratelimit.rate_limit_message(retry)},
        429,
        {"Retry-After": str(retry)},
    ),
)
def send_friend_request():
    """Send a friend request to another user.

    Route: ``POST /friends/requests`` — JSON body ``{"username": "bob"}``.

    :returns: ``{"ok": true, "request_id": <id>}`` with 201, or an error:
        404 unknown user, 400 self, 409 already friends / already pending /
        an incoming request from them already exists (carries ``request_id``).
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    data = request.get_json(silent=True) or {}
    target = _resolve_username((data.get("username") or "").strip())
    if not target:
        return jsonify({"error": "user not found"}), 404
    if target == me:
        return jsonify({"error": "cannot add yourself"}), 400

    friend_set, out_pending, in_pending = _relation_sets(me)
    if target in friend_set:
        return jsonify({"error": "already friends"}), 409
    if target in out_pending:
        return (
            jsonify({"error": "request already pending", "request_id": out_pending[target]}),
            409,
        )
    if target in in_pending:
        return (
            jsonify({"error": "incoming request exists", "request_id": in_pending[target]}),
            409,
        )

    db = _presence_db()
    try:
        cur = db.execute(
            "INSERT INTO friend_requests (from_user, to_user, status, created_ts)"
            " VALUES (?, ?, 'pending', ?)",
            (me, target, time.time()),
        )
        request_id = cur.lastrowid
        db.commit()
    except sqlite3.IntegrityError:
        # Lost a race with an identical pending insert; report as duplicate.
        return jsonify({"error": "request already pending"}), 409
    finally:
        db.close()
    return jsonify({"ok": True, "request_id": request_id}), 201


@social_bp.route("/friends/requests", methods=["GET"])
@auth.login_required
def list_friend_requests():
    """List friend requests visible to the current user.

    Route: ``GET /friends/requests?direction=in|out|all&status=pending|accepted|rejected|all``

    Defaults to ``direction=in&status=pending`` (the inbox). Also used verbatim
    as the ``friend_requests`` SSE collector, where the ``/events`` URL supplies
    neither parameter and so the same default applies.

    :returns: ``{"items": [...]}`` newest-first, capped at 200 rows.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    direction = (request.args.get("direction") or "in").lower()
    status = (request.args.get("status") or "pending").lower()
    if direction not in ("in", "out", "all"):
        direction = "in"
    if status not in ("pending", "accepted", "rejected", "all"):
        status = "pending"

    where = []
    params = []
    if direction == "in":
        where.append("to_user = ?")
        params.append(me)
    elif direction == "out":
        where.append("from_user = ?")
        params.append(me)
    else:
        where.append("(from_user = ? OR to_user = ?)")
        params.extend([me, me])
    if status != "all":
        where.append("status = ?")
        params.append(status)

    db = _presence_db()
    try:
        db.row_factory = sqlite3.Row
        sql = (
            "SELECT id, from_user, to_user, status, created_ts, resolved_ts"
            " FROM friend_requests WHERE {0}"
            " ORDER BY created_ts DESC, id DESC LIMIT ?".format(" AND ".join(where))
        )
        rows = db.execute(sql, params + [_MAX_REQUESTS_LISTED]).fetchall()
    finally:
        db.close()

    names = set()
    for r in rows:
        names.add(r["from_user"])
        names.add(r["to_user"])
    settings = _settings_map(names)

    def _disp(u):
        return settings.get(u, (None, False, None))[0]

    items = [
        {
            "id": r["id"],
            "from_user": r["from_user"],
            "to_user": r["to_user"],
            "from_display_name": _disp(r["from_user"]),
            "to_display_name": _disp(r["to_user"]),
            "status": r["status"],
            "created_ts": r["created_ts"],
            "resolved_ts": r["resolved_ts"],
        }
        for r in rows
    ]
    return jsonify({"items": items})


def _resolve_request(request_id, me, new_status):
    """Shared accept/reject implementation.

    Validates ownership and state, then transitions the request. On ``accept``
    it also inserts the normalised ``friends`` row in the same transaction.

    :returns: A ``(body, status_code)`` tuple for the route to return.
    """
    db = _presence_db()
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT id, from_user, to_user, status FROM friend_requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "request not found"}), 404
        if row["to_user"] != me:
            return jsonify({"error": "forbidden"}), 403
        if row["status"] != "pending":
            return jsonify({"error": "already resolved"}), 409

        now = time.time()
        # Guard on status='pending' so a concurrent resolve can't double-apply.
        cur = db.execute(
            "UPDATE friend_requests SET status = ?, resolved_ts = ?"
            " WHERE id = ? AND status = 'pending'",
            (new_status, now, request_id),
        )
        if cur.rowcount == 0:
            db.rollback()
            return jsonify({"error": "already resolved"}), 409

        if new_status == "accepted":
            a, b = _pair(row["from_user"], row["to_user"])
            # OR IGNORE: two opposite requests accepted at once must not violate
            # the friends primary key.
            db.execute(
                "INSERT OR IGNORE INTO friends (user_a, user_b, created_ts)"
                " VALUES (?, ?, ?)",
                (a, b, now),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return jsonify({"ok": True}), 200


@social_bp.route("/friends/requests/<int:request_id>/accept", methods=["POST"])
@auth.login_required
def accept_friend_request(request_id):
    """Accept a pending friend request (recipient only).

    Route: ``POST /friends/requests/<id>/accept``

    :returns: ``{"ok": true}``; 404 unknown, 403 not the recipient, 409 already
        resolved.
    :rtype: flask.Response (application/json)
    """
    return _resolve_request(request_id, session["user"], "accepted")


@social_bp.route("/friends/requests/<int:request_id>/reject", methods=["POST"])
@auth.login_required
def reject_friend_request(request_id):
    """Reject a pending friend request (recipient only).

    Route: ``POST /friends/requests/<id>/reject``

    :returns: ``{"ok": true}``; 404 unknown, 403 not the recipient, 409 already
        resolved.
    :rtype: flask.Response (application/json)
    """
    return _resolve_request(request_id, session["user"], "rejected")


@social_bp.route("/friends/requests/<int:request_id>", methods=["DELETE"])
@auth.login_required
def withdraw_friend_request(request_id):
    """Withdraw a pending request the current user sent (deletes the row).

    Route: ``DELETE /friends/requests/<id>``

    :returns: ``{"ok": true}``; 404 unknown, 403 not the sender, 409 not pending.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    db = _presence_db()
    try:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT id, from_user, status FROM friend_requests WHERE id = ?",
            (request_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "request not found"}), 404
        if row["from_user"] != me:
            return jsonify({"error": "forbidden"}), 403
        if row["status"] != "pending":
            return jsonify({"error": "not pending"}), 409
        db.execute("DELETE FROM friend_requests WHERE id = ?", (request_id,))
        db.commit()
    finally:
        db.close()
    return jsonify({"ok": True}), 200


# ── Friend list ────────────────────────────────────────────────────────────


@social_bp.route("/friends", methods=["GET"])
@auth.login_required
def list_friends():
    """Return the current user's friend list, newest friendship first.

    Route: ``GET /friends``. Also the ``friends`` SSE collector, so the pushed
    payload is identical to this response.

    Online state is deliberately **not** included — the client merges it with the
    existing ``online_users`` stream, matching how the rest of the UI works and
    avoiding a second source of presence truth.

    :returns: JSON array of ``{username, display_name, avatar, name_color,
        since_ts}``.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    db = _presence_db()
    try:
        rows = db.execute(
            "SELECT user_a, user_b, created_ts FROM friends"
            " WHERE user_a = ? OR user_b = ? ORDER BY created_ts DESC",
            (me, me),
        ).fetchall()
    finally:
        db.close()

    peers = [(b if a == me else a, ts) for a, b, ts in rows]
    settings = _settings_map([p for p, _ in peers])
    items = []
    for username, since_ts in peers:
        display_name, has_avatar, name_color = settings.get(
            username, (None, False, None)
        )
        items.append(
            {
                "username": username,
                "display_name": display_name,
                "avatar": has_avatar,
                "name_color": name_color,
                "since_ts": since_ts,
            }
        )
    return jsonify(items)


@social_bp.route("/friends/<username>", methods=["DELETE"])
@auth.login_required
def remove_friend(username):
    """Remove a friend (both directions in one row). Chat history is kept.

    Route: ``DELETE /friends/<username>``

    :returns: ``{"ok": true}``; 404 if not a friend.
    :rtype: flask.Response (application/json)
    """
    me = session["user"]
    target = _resolve_username(username)
    if not target or target == me:
        return jsonify({"error": "not a friend"}), 404

    a, b = _pair(me, target)
    db = _presence_db()
    try:
        cur = db.execute(
            "DELETE FROM friends WHERE user_a = ? AND user_b = ?", (a, b)
        )
        db.commit()
        removed = cur.rowcount
    finally:
        db.close()
    if not removed:
        return jsonify({"error": "not a friend"}), 404
    return jsonify({"ok": True}), 200
