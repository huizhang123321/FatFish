"""Route tests for group management (kind='group' private channels + roles)."""

import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import common as common_mod
from minimost import chat as chat_mod


def _add_user(username):
    db = sqlite3.connect(auth_mod.AUTH_DB)
    db.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        (username, generate_password_hash("Password1!")),
    )
    db.commit()
    db.close()
    common_mod.init_user_db(username)


def _client_for(app, username):
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user"] = username
    return c


def _create_group(app, owner="alice", name="team", members=("bob",)):
    c = _client_for(app, owner)
    resp = c.post(
        "/private_channels/create",
        json={"name": name, "members": list(members), "kind": "group"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()["id"]


# ── creation ───────────────────────────────────────────────────────────────


def test_create_group_sets_kind_and_owner_role(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)

    db = sqlite3.connect(common_mod.DB_DIR.parent / "presence.db")
    db.row_factory = sqlite3.Row
    try:
        kind = db.execute(
            "SELECT kind FROM private_channels WHERE id = ?", (gid,)
        ).fetchone()["kind"]
        roles = {
            r["username"]: r["role"]
            for r in db.execute(
                "SELECT username, role FROM private_channel_members WHERE channel_id = ?",
                (gid,),
            )
        }
    finally:
        db.close()

    assert kind == "group"
    assert roles == {"alice": "owner", "bob": "member"}


def test_create_channel_default_kind_unchanged(app):
    """Omitting kind still creates a legacy role-free private channel."""
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    resp = c.post(
        "/private_channels/create", json={"name": "legacy", "members": ["bob"]}
    )
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["kind"] == "channel"

    db = sqlite3.connect(common_mod.DB_DIR.parent / "presence.db")
    db.row_factory = sqlite3.Row
    try:
        roles = {
            r["username"]: r["role"]
            for r in db.execute(
                "SELECT username, role FROM private_channel_members WHERE channel_id = ?",
                (data["id"],),
            )
        }
    finally:
        db.close()
    assert roles == {"alice": "member", "bob": "member"}


def test_create_group_rejects_bad_kind(app):
    _add_user("alice")
    c = _client_for(app, "alice")
    resp = c.post(
        "/private_channels/create", json={"name": "x", "members": [], "kind": "bogus"}
    )
    assert resp.status_code == 400


def test_create_group_member_cap(app):
    _add_user("alice")
    for i in range(5):
        _add_user(f"m{i}")
    old = chat_mod.MAX_GROUP_MEMBERS
    chat_mod.MAX_GROUP_MEMBERS = 3
    try:
        c = _client_for(app, "alice")
        resp = c.post(
            "/private_channels/create",
            json={
                "name": "big",
                "members": ["m0", "m1", "m2", "m3", "m4"],
                "kind": "group",
            },
        )
        assert resp.status_code == 400
    finally:
        chat_mod.MAX_GROUP_MEMBERS = old


def test_create_group_resolves_member_casing(app):
    _add_user("alice")
    _add_user("Bob")
    gid = _create_group(app, members=("bob",))
    listing = _client_for(app, "alice").get("/private_channels").get_json()
    entry = next(e for e in listing if e["id"] == gid)
    assert "Bob" in entry["members"]


# ── listing ────────────────────────────────────────────────────────────────


def test_list_includes_kind_and_role(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    a_entry = next(e for e in alice.get("/private_channels").get_json() if e["id"] == gid)
    b_entry = next(e for e in bob.get("/private_channels").get_json() if e["id"] == gid)

    assert (a_entry["kind"], a_entry["role"]) == ("group", "owner")
    assert (b_entry["kind"], b_entry["role"]) == ("group", "member")


def test_list_non_member_excluded(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app)
    carol = _client_for(app, "carol")
    assert gid not in [e["id"] for e in carol.get("/private_channels").get_json()]


# ── member roster ──────────────────────────────────────────────────────────


def test_members_route_returns_roles_sorted(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"})

    data = alice.get(f"/groups/{gid}/members").get_json()
    assert data["kind"] == "group"
    roles = [m["role"] for m in data["members"]]
    # owner first, then admin, then member
    assert roles == ["owner", "admin", "member"]
    assert data["members"][0]["username"] == "alice"
    assert all("display_name" in m and "avatar" in m for m in data["members"])


def test_members_route_forbidden_for_non_member(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app)
    assert _client_for(app, "carol").get(f"/groups/{gid}/members").status_code == 403


def test_members_route_404_for_unknown(app):
    _add_user("alice")
    assert _client_for(app, "alice").get("/groups/999/members").status_code == 404


def test_legacy_members_route_contract_preserved(app):
    """Regression: the legacy roster route still returns a flat array."""
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")

    data = alice.get(f"/private_channels/{gid}/members").get_json()
    assert isinstance(data, list)
    assert all(set(m) == {"username"} for m in data)
    assert sorted(m["username"] for m in data) == ["alice", "bob"]


# ── invite ─────────────────────────────────────────────────────────────────


def test_invite_member_any_member_by_default(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app)
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/add_member", json={"username": "carol"}).status_code == 200

    roster = bob.get(f"/groups/{gid}/members").get_json()["members"]
    carol_row = next(m for m in roster if m["username"] == "carol")
    assert carol_row["role"] == "member"


def test_invite_respects_admin_only_setting(app, monkeypatch):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app)
    monkeypatch.setattr(chat_mod, "_group_invite_admin_only", lambda: True)

    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/add_member", json={"username": "carol"}).status_code == 403

    alice = _client_for(app, "alice")
    assert alice.post(f"/private_channels/{gid}/add_member", json={"username": "carol"}).status_code == 200


def test_invite_duplicate_409(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/private_channels/{gid}/add_member", json={"username": "bob"}).status_code == 409


def test_invite_unknown_user_404(app):
    _add_user("alice")
    gid = _create_group(app, members=())
    alice = _client_for(app, "alice")
    assert alice.post(f"/private_channels/{gid}/add_member", json={"username": "ghost"}).status_code == 404


def test_invite_non_member_forbidden(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app)
    carol = _client_for(app, "carol")
    assert carol.post(f"/private_channels/{gid}/add_member", json={"username": "bob"}).status_code == 403


# ── rename ─────────────────────────────────────────────────────────────────


def test_group_rename_requires_admin(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/rename", json={"name": "nope"}).status_code == 403

    alice = _client_for(app, "alice")
    assert alice.post(f"/private_channels/{gid}/rename", json={"name": "renamed"}).status_code == 200
    entry = next(e for e in alice.get("/private_channels").get_json() if e["id"] == gid)
    assert entry["name"] == "renamed"


def test_admin_can_rename(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"})
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/rename", json={"name": "byadmin"}).status_code == 200


def test_legacy_channel_rename_still_any_member(app):
    """Regression: a role-free private channel keeps its old behaviour."""
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    cid = c.post(
        "/private_channels/create", json={"name": "legacy", "members": ["bob"]}
    ).get_json()["id"]
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{cid}/rename", json={"name": "ok"}).status_code == 200


# ── remove member ──────────────────────────────────────────────────────────


def test_remove_member_by_owner(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/remove_member", json={"username": "bob"}).status_code == 200
    roster = alice.get(f"/groups/{gid}/members").get_json()["members"]
    assert [m["username"] for m in roster] == ["alice"]


def test_remove_member_by_plain_member_forbidden(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    bob = _client_for(app, "bob")
    assert bob.post(f"/groups/{gid}/remove_member", json={"username": "carol"}).status_code == 403


def test_admin_cannot_remove_admin_or_owner(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    _add_user("dave")
    gid = _create_group(app, members=("bob", "carol", "dave"))
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"})
    alice.post(f"/groups/{gid}/role", json={"username": "carol", "role": "admin"})

    bob = _client_for(app, "bob")
    # peer admin
    assert bob.post(f"/groups/{gid}/remove_member", json={"username": "carol"}).status_code == 403
    # owner
    assert bob.post(f"/groups/{gid}/remove_member", json={"username": "alice"}).status_code == 403
    # ordinary member is fine
    assert bob.post(f"/groups/{gid}/remove_member", json={"username": "dave"}).status_code == 200


def test_remove_self_uses_leave(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/remove_member", json={"username": "alice"}).status_code == 400


def test_remove_down_to_sole_owner_allowed(app):
    """Removing everyone but the owner is fine; disband handles the empty case."""
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/remove_member", json={"username": "bob"}).status_code == 200
    roster = alice.get(f"/groups/{gid}/members").get_json()["members"]
    assert [m["username"] for m in roster] == ["alice"]
    # The owner can still disband the now-solo group.
    assert alice.delete(f"/groups/{gid}", json={"confirm": "team"}).status_code == 200


def test_remove_route_404_on_channel_not_group(app):
    """The /groups/... routes only operate on kind='group'."""
    _add_user("alice")
    _add_user("bob")
    c = _client_for(app, "alice")
    cid = c.post(
        "/private_channels/create", json={"name": "legacy", "members": ["bob"]}
    ).get_json()["id"]
    assert c.post(f"/groups/{cid}/remove_member", json={"username": "bob"}).status_code == 404


# ── leave ──────────────────────────────────────────────────────────────────


def test_member_can_leave(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/leave").status_code == 200
    assert gid not in [e["id"] for e in bob.get("/private_channels").get_json()]


def test_owner_cannot_leave_before_transfer(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/private_channels/{gid}/leave").status_code == 409
    # after transfer, the former owner (now admin) may leave
    alice.post(f"/groups/{gid}/transfer", json={"username": "bob"})
    assert alice.post(f"/private_channels/{gid}/leave").status_code == 200


def test_admin_can_leave(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"})
    bob = _client_for(app, "bob")
    assert bob.post(f"/private_channels/{gid}/leave").status_code == 200


def test_leave_non_member_403(app):
    _add_user("alice")
    _add_user("carol")
    gid = _create_group(app, members=())
    carol = _client_for(app, "carol")
    assert carol.post(f"/private_channels/{gid}/leave").status_code == 403


# ── roles / transfer ───────────────────────────────────────────────────────


def test_promote_and_demote(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"}).status_code == 200

    roster = alice.get(f"/groups/{gid}/members").get_json()["members"]
    assert next(m for m in roster if m["username"] == "bob")["role"] == "admin"

    assert alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "member"}).status_code == 200
    roster = alice.get(f"/groups/{gid}/members").get_json()["members"]
    assert next(m for m in roster if m["username"] == "bob")["role"] == "member"


def test_role_change_owner_only(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    bob = _client_for(app, "bob")
    assert bob.post(f"/groups/{gid}/role", json={"username": "carol", "role": "admin"}).status_code == 403


def test_admin_cannot_promote(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "admin"})
    bob = _client_for(app, "bob")
    assert bob.post(f"/groups/{gid}/role", json={"username": "carol", "role": "admin"}).status_code == 403


def test_role_invalid_value_400(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "owner"}).status_code == 400
    assert alice.post(f"/groups/{gid}/role", json={"username": "bob", "role": "wizard"}).status_code == 400


def test_role_self_400(app):
    _add_user("alice")
    gid = _create_group(app, members=())
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/role", json={"username": "alice", "role": "member"}).status_code == 400


def test_transfer_ownership(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/transfer", json={"username": "bob"}).status_code == 200

    roster = alice.get(f"/groups/{gid}/members").get_json()["members"]
    roles = {m["username"]: m["role"] for m in roster}
    assert roles == {"bob": "owner", "alice": "admin"}

    listing = alice.get("/private_channels").get_json()
    assert next(e for e in listing if e["id"] == gid)["role"] == "admin"


def test_transfer_exactly_one_owner(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    alice = _client_for(app, "alice")
    alice.post(f"/groups/{gid}/transfer", json={"username": "bob"})
    bob = _client_for(app, "bob")
    bob.post(f"/groups/{gid}/transfer", json={"username": "carol"})

    roster = bob.get(f"/groups/{gid}/members").get_json()["members"]
    owners = [m["username"] for m in roster if m["role"] == "owner"]
    assert owners == ["carol"]


def test_transfer_non_owner_403(app):
    _add_user("alice")
    _add_user("bob")
    _add_user("carol")
    gid = _create_group(app, members=("bob", "carol"))
    bob = _client_for(app, "bob")
    assert bob.post(f"/groups/{gid}/transfer", json={"username": "carol"}).status_code == 403


def test_transfer_to_non_member_404(app):
    _add_user("alice")
    _add_user("ghost")
    gid = _create_group(app, members=())
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/transfer", json={"username": "ghost"}).status_code == 404


def test_transfer_to_self_400(app):
    _add_user("alice")
    gid = _create_group(app, members=())
    alice = _client_for(app, "alice")
    assert alice.post(f"/groups/{gid}/transfer", json={"username": "alice"}).status_code == 400


# ── disband ────────────────────────────────────────────────────────────────


def test_disband_group_owner_only(app):
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app, name="doomed")
    bob = _client_for(app, "bob")
    assert bob.delete(f"/groups/{gid}", json={"confirm": "doomed"}).status_code == 403

    alice = _client_for(app, "alice")
    assert alice.delete(f"/groups/{gid}", json={"confirm": "wrong"}).status_code == 400
    assert alice.delete(f"/groups/{gid}", json={"confirm": "doomed"}).status_code == 200

    # Gone for everyone.
    assert gid not in [e["id"] for e in alice.get("/private_channels").get_json()]
    assert gid not in [e["id"] for e in bob.get("/private_channels").get_json()]
    assert alice.get(f"/groups/{gid}/members").status_code == 404


def test_disband_requires_confirmation(app):
    _add_user("alice")
    gid = _create_group(app, name="keepme", members=())
    alice = _client_for(app, "alice")
    assert alice.delete(f"/groups/{gid}", json={}).status_code == 400
    # still there
    assert gid in [e["id"] for e in alice.get("/private_channels").get_json()]


def test_disband_unknown_404(app):
    _add_user("alice")
    assert _client_for(app, "alice").delete("/groups/999", json={"confirm": "x"}).status_code == 404


# ── message-path integration ───────────────────────────────────────────────


def test_group_messages_use_existing_send_route(app):
    """Groups reuse POST /send/<channel> and GET /messages/<channel> untouched."""
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    ch = f"private:{gid}"
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    assert alice.post(f"/send/{ch}", data={"text": "hello group"}).status_code == 200
    msgs = bob.get(f"/messages/{ch}").get_json()
    assert any(m["content"] == "hello group" and m["sender"] == "alice" for m in msgs)


def test_removed_member_loses_message_access(app):
    """Access control follows membership, so a removed member gets 403."""
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app)
    ch = f"private:{gid}"
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    alice.post(f"/send/{ch}", data={"text": "secret"})
    assert bob.get(f"/messages/{ch}").status_code == 200

    alice.post(f"/groups/{gid}/remove_member", json={"username": "bob"})
    assert bob.get(f"/messages/{ch}").status_code == 403
    assert bob.post(f"/send/{ch}", data={"text": "let me in"}).status_code == 403


def test_new_member_cannot_see_prior_history(app):
    """Late joiners are bounded by history_start_ts, as upstream intends."""
    _add_user("alice")
    _add_user("bob")
    gid = _create_group(app, members=())
    ch = f"private:{gid}"
    alice = _client_for(app, "alice")
    alice.post(f"/send/{ch}", data={"text": "before bob joined"})

    alice.post(f"/private_channels/{gid}/add_member", json={"username": "bob"})
    bob = _client_for(app, "bob")
    msgs = bob.get(f"/messages/{ch}").get_json()
    assert not any(m["content"] == "before bob joined" for m in msgs)


def test_group_change_bumps_event_signal(app):
    """Group writes wake SSE streams via the shared counter."""
    import minimost.presence as presence_mod

    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    before = presence_mod.read_event_signal()
    alice.post(
        "/private_channels/create", json={"name": "sig", "members": ["bob"], "kind": "group"}
    )
    assert presence_mod.read_event_signal() > before


def test_group_routes_require_login(client):
    assert client.get("/private_channels").status_code == 302
    assert client.delete("/groups/1", json={"confirm": "x"}).status_code == 302