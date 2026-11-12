"""Route tests for :mod:`minimost.apiaccess` — the machine-access API.

Two halves, tested separately because they authenticate in completely different
ways: the Settings screen issues tokens with a session cookie, while other
programs push messages with a bearer token and no session at all.
"""

import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import common as common_mod
from minimost import presence as presence_mod


def _add_user(username, password="Password1!"):
    db = sqlite3.connect(auth_mod.AUTH_DB)
    db.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (username, generate_password_hash(password)),
    )
    db.commit()
    db.close()
    common_mod.init_user_db(username)


def _client_for(app, username):
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user"] = username
    return c


def _create_token(client, label="test"):
    """Issue a token through the real route and return the plaintext."""
    resp = client.post("/api/tokens", json={"label": label})
    assert resp.status_code == 201, resp.get_data(as_text=True)
    return resp.get_json()["token"]


def _push(client, token, channel="general", text="hello from a script"):
    return client.post(
        "/api/v1/messages",
        json={"channel": channel, "text": text},
        headers={"Authorization": "Bearer " + token},
    )


# ── Token management (session auth) ────────────────────────────────────────


def test_token_list_requires_login(client):
    resp = client.get("/api/tokens")
    assert resp.status_code == 302


def test_token_create_requires_login(client):
    resp = client.post("/api/tokens", json={"label": "x"})
    assert resp.status_code == 302


def test_token_create_returns_plaintext_once(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = alice.post("/api/tokens", json={"label": "我的脚本"})

    assert resp.status_code == 201
    body = resp.get_json()
    token = body["token"]
    assert token.startswith("ff_")
    assert len(token) > 20
    assert body["item"]["label"] == "我的脚本"
    # The listing must never repeat the secret.
    listing = alice.get("/api/tokens").get_json()
    assert token not in str(listing)
    assert listing["items"][0]["hint"].startswith("ff_")


def test_token_is_not_stored_in_plaintext(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    rows = db.execute("SELECT token_hash, hint FROM api_tokens").fetchall()
    db.close()

    assert len(rows) == 1
    stored_hash, hint = rows[0]
    assert token not in stored_hash
    assert len(stored_hash) == 64  # sha256 hex
    assert hint and token.startswith(hint)


def test_token_list_reports_the_endpoint(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    listing = alice.get("/api/tokens").get_json()

    assert listing["items"] == []
    assert listing["endpoint"].endswith("/api/v1/messages")


def test_revoke_stops_the_token(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)
    token_id = alice.get("/api/tokens").get_json()["items"][0]["id"]

    assert _push(alice, token).status_code == 201

    resp = alice.delete("/api/tokens/{0}".format(token_id))
    assert resp.status_code == 200

    # Revoked: gone from the list and refused on use.
    assert alice.get("/api/tokens").get_json()["items"] == []
    assert _push(alice, token).status_code == 401


def test_revoke_someone_elses_token_is_404(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    _create_token(alice)
    token_id = alice.get("/api/tokens").get_json()["items"][0]["id"]

    resp = bob.delete("/api/tokens/{0}".format(token_id))

    assert resp.status_code == 404
    # And alice's token still works.
    assert alice.get("/api/tokens").get_json()["items"][0]["id"] == token_id


def test_token_limit_is_enforced(app):
    from minimost.apiaccess import MAX_TOKENS_PER_USER

    _add_user("alice")
    alice = _client_for(app, "alice")
    for _ in range(MAX_TOKENS_PER_USER):
        assert alice.post("/api/tokens", json={"label": "t"}).status_code == 201

    resp = alice.post("/api/tokens", json={"label": "one too many"})

    assert resp.status_code == 409


# ── Machine access (token auth) ────────────────────────────────────────────


def test_whoami_reports_the_owner(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice, "integrations")

    resp = app.test_client().get(
        "/api/v1/whoami", headers={"Authorization": "Bearer " + token}
    )

    assert resp.status_code == 200
    assert resp.get_json()["user"] == "alice"
    assert resp.get_json()["token"] == "integrations"


def test_push_requires_a_token(app):
    resp = app.test_client().post(
        "/api/v1/messages", json={"channel": "general", "text": "hi"}
    )
    assert resp.status_code == 401


def test_push_rejects_a_bogus_token(app):
    resp = app.test_client().post(
        "/api/v1/messages",
        json={"channel": "general", "text": "hi"},
        headers={"Authorization": "Bearer ff_not-a-real-token"},
    )
    assert resp.status_code == 401


def test_push_accepts_the_x_api_key_header(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    resp = app.test_client().post(
        "/api/v1/messages",
        json={"channel": "general", "text": "via header"},
        headers={"X-API-Key": token},
    )

    assert resp.status_code == 201


def test_pushed_message_is_a_normal_message(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    resp = _push(alice, token, text="推送进频道的消息")
    assert resp.status_code == 201
    body = resp.get_json()
    assert body["ok"] is True
    assert body["message"]["sender"] == "alice"
    assert body["message"]["channel"] == "general"

    # It shows up through the ordinary history endpoint, attributed to the owner,
    # because it was written through the ordinary insert path.
    messages = alice.get("/messages/general?after=0").get_json()
    contents = [m["content"] for m in messages]
    assert "推送进频道的消息" in contents
    pushed = next(m for m in messages if m["content"] == "推送进频道的消息")
    assert pushed["sender"] == "alice"


def test_push_records_mentions(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    _push(alice, token, text="@bob 看一下这个")

    messages = alice.get("/messages/general?after=0").get_json()
    pushed = next(m for m in messages if "看一下这个" in m["content"])
    assert pushed["mentions"] and "bob" in pushed["mentions"]


def test_push_bumps_the_sse_counter(app):
    """A push must wake held-open streams, or it would look like a dead app."""
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    before = db.execute("SELECT gen FROM event_signal WHERE id = 1").fetchone()[0]
    db.close()

    _push(alice, token)

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    after = db.execute("SELECT gen FROM event_signal WHERE id = 1").fetchone()[0]
    db.close()

    assert after > before


def test_push_requires_channel_and_text(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    assert _push(alice, token, channel="", text="x").status_code == 400
    assert _push(alice, token, channel="general", text="").status_code == 400


def test_push_rejects_overlong_text(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    resp = _push(alice, token, text="x" * 10001)

    assert resp.status_code == 400
    assert resp.get_json()["max_length"] == 10000


def test_push_cannot_reach_a_channel_the_owner_cannot_see(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    resp = _push(alice, token, channel="not-a-channel")

    assert resp.status_code == 403


def test_push_into_a_private_channel_requires_membership(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    created = alice.post(
        "/private_channels/create", json={"name": "秘密基地", "members": []}
    ).get_json()
    channel = created["channel"]

    alice_token = _create_token(alice)
    bob_token = _create_token(bob)

    assert _push(alice, alice_token, channel=channel).status_code == 201
    # Bob is not a member, so his token is refused for that channel.
    assert _push(bob, bob_token, channel=channel).status_code == 403


def test_push_rejects_a_non_object_body(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    token = _create_token(alice)

    resp = alice.post(
        "/api/v1/messages",
        json=["not", "an", "object"],
        headers={"Authorization": "Bearer " + token},
    )

    assert resp.status_code == 400
