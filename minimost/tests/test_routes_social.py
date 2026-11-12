"""Route tests for :mod:`minimost.social` — user search + the friend system."""

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


def _set_display_name(username, name):
    db = sqlite3.connect(auth_mod.AUTH_DB)
    db.execute("INSERT OR IGNORE INTO user_settings (username) VALUES (?)", (username,))
    db.execute(
        "UPDATE user_settings SET display_name = ? WHERE username = ?", (name, username)
    )
    db.commit()
    db.close()


# ── User search ────────────────────────────────────────────────────────────


def test_search_requires_q(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    resp = c.get("/users/search")
    assert resp.status_code == 400


def test_search_matches_username_and_display_name(app):
    for u in ("alice", "bob", "carol"):
        _add_user(u)
    _set_display_name("carol", "Zelda")
    c = _client_for(app, "alice")

    # username substring
    data = c.get("/users/search?q=bo").get_json()
    assert [i["username"] for i in data["items"]] == ["bob"]

    # display-name match
    data = c.get("/users/search?q=zeld").get_json()
    assert [i["username"] for i in data["items"]] == ["carol"]

    # excludes self
    data = c.get("/users/search?q=ali").get_json()
    assert data["items"] == []


def test_search_is_case_insensitive(app):
    _add_user("alice")
    _add_user("Bob")
    c = _client_for(app, "alice")
    data = c.get("/users/search?q=BOB").get_json()
    assert [i["username"] for i in data["items"]] == ["Bob"]


def test_search_escapes_like_wildcards(app):
    """'_' in a query must not act as a wildcard (a_ice should not match alice)."""
    _add_user("alice")
    _add_user("searcher")
    c = _client_for(app, "searcher")
    data = c.get("/users/search?q=a_ice").get_json()
    assert data["items"] == []


def test_search_pagination(app):
    _add_user("alice")
    for i in range(5):
        _add_user(f"user{i}")
    c = _client_for(app, "alice")

    page1 = c.get("/users/search?q=user&page_size=2&page=1").get_json()
    page2 = c.get("/users/search?q=user&page_size=2&page=2").get_json()

    assert page1["total"] == 5
    assert page1["total_pages"] == 3
    assert len(page1["items"]) == 2
    assert len(page2["items"]) == 2
    # No overlap between pages.
    names1 = {i["username"] for i in page1["items"]}
    names2 = {i["username"] for i in page2["items"]}
    assert not (names1 & names2)


def test_search_page_size_capped(app):
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    data = c.get("/users/search?q=b&page_size=999").get_json()
    assert data["page_size"] <= 50


def test_search_relation_field(app):
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    # Not yet friends.
    item = c.get("/users/search?q=bob").get_json()["items"][0]
    assert item["relation"] == "none"

    c.post("/friends/requests", json={"username": "bob"})
    item = c.get("/users/search?q=bob").get_json()["items"][0]
    assert item["relation"] == "pending_out"
    assert item["request_id"] is not None


# ── Friend requests ────────────────────────────────────────────────────────


def test_send_request_unknown_user(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    assert c.post("/friends/requests", json={"username": "ghost"}).status_code == 404


def test_send_request_to_self(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    assert c.post("/friends/requests", json={"username": "alice"}).status_code == 400


def test_send_request_case_insensitive_target(app):
    _add_user("alice")
    _add_user("Bob")
    c = _client_for(app, "alice")
    resp = c.post("/friends/requests", json={"username": "bob"})
    assert resp.status_code == 201
    # Canonical spelling used downstream.
    inbox = _client_for(app, "Bob").get("/friends/requests").get_json()
    assert inbox["items"][0]["from_user"] == "alice"


def test_duplicate_request_rejected(app):
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    assert c.post("/friends/requests", json={"username": "bob"}).status_code == 201
    assert c.post("/friends/requests", json={"username": "bob"}).status_code == 409


def test_reverse_request_reports_incoming(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    bob.post("/friends/requests", json={"username": "alice"})
    resp = alice.post("/friends/requests", json={"username": "bob"})
    assert resp.status_code == 409
    body = resp.get_json()
    assert body["error"] == "incoming request exists"
    assert body["request_id"]


def test_accept_makes_friends(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    resp = bob.post(f"/friends/requests/{rid}/accept")
    assert resp.status_code == 200

    # Both see each other in their friend list.
    assert any(f["username"] == "alice" for f in bob.get("/friends").get_json())
    assert any(f["username"] == "bob" for f in alice.get("/friends").get_json())

    # Search now reports 'friend'.
    item = alice.get("/users/search?q=bob").get_json()["items"][0]
    assert item["relation"] == "friend"


def test_accept_twice_conflict(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    assert bob.post(f"/friends/requests/{rid}/accept").status_code == 200
    assert bob.post(f"/friends/requests/{rid}/accept").status_code == 409


def test_reject_request(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    assert bob.post(f"/friends/requests/{rid}/reject").status_code == 200
    # Not friends.
    assert alice.get("/friends").get_json() == []
    # Can re-request after rejection (new row allowed).
    assert alice.post("/friends/requests", json={"username": "bob"}).status_code == 201


def test_only_recipient_can_resolve(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    alice = _client_for(app, "alice")
    carol = _client_for(app, "carol")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    # carol is not the recipient.
    assert carol.post(f"/friends/requests/{rid}/accept").status_code == 403


def test_resolve_unknown_request(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    assert c.post("/friends/requests/99999/accept").status_code == 404


def test_withdraw_request(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    assert alice.delete(f"/friends/requests/{rid}").status_code == 200
    # bob no longer sees it.
    assert bob.get("/friends/requests").get_json()["items"] == []
    # Sender cannot withdraw someone else's request.
    rid2 = bob.post("/friends/requests", json={"username": "alice"}).get_json()["request_id"]
    assert alice.delete(f"/friends/requests/{rid2}").status_code == 403


def test_list_requests_direction_filter(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    alice.post("/friends/requests", json={"username": "bob"})
    # alice's outgoing
    assert len(alice.get("/friends/requests?direction=out").get_json()["items"]) == 1
    # alice's incoming is empty
    assert alice.get("/friends/requests").get_json()["items"] == []
    # bob's incoming has one
    assert len(bob.get("/friends/requests").get_json()["items"]) == 1


# ── Friend list & removal ──────────────────────────────────────────────────


def test_remove_friend(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    bob.post(f"/friends/requests/{rid}/accept")

    assert alice.delete("/friends/bob").status_code == 200
    assert alice.get("/friends").get_json() == []
    assert bob.get("/friends").get_json() == []
    # Removing a non-friend is 404.
    assert alice.delete("/friends/bob").status_code == 404


def test_remove_friend_case_insensitive(app):
    _add_user("alice")
    _add_user("Bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "Bob")
    rid = alice.post("/friends/requests", json={"username": "bob"}).get_json()["request_id"]
    bob.post(f"/friends/requests/{rid}/accept")
    assert alice.delete("/friends/BOB").status_code == 200


# ── Display name / profile ─────────────────────────────────────────────────


def test_profile_roundtrip(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    assert c.get("/profile").get_json()["display_name"] is None
    assert c.post("/profile", json={"display_name": "  Alice A  "}).status_code == 200
    assert c.get("/profile").get_json()["display_name"] == "Alice A"
    # Clear it.
    c.post("/profile", json={"display_name": ""})
    assert c.get("/profile").get_json()["display_name"] is None


def test_profile_display_name_too_long(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    assert c.post("/profile", json={"display_name": "x" * 33}).status_code == 400


# ── SSE wiring ─────────────────────────────────────────────────────────────


def test_social_bumps_event_signal(app):
    """A social write bumps the shared counter that wakes SSE streams."""
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")

    before = presence_mod.read_event_signal()
    resp = alice.post("/friends/requests", json={"username": "bob"})
    assert resp.status_code == 201
    after = presence_mod.read_event_signal()
    assert after > before


def test_social_routes_require_login(client):
    """Unauthenticated calls redirect to /login (302), not 200."""
    assert client.get("/friends").status_code == 302
    assert client.get("/users/search?q=a").status_code == 302