"""Join by group number: lookup, request, approve/reject, withdraw.

A number is a handle, not a key: knowing it lets you *ask*, never enter. These
tests pin that boundary, plus the re-request rule (one pending per person, but a
decided row does not block a later attempt).
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


def _setup(app, *names):
    for name in names:
        _add_user(name)
    return {name: _client_for(app, name) for name in names}


def _create_group(client, name="游戏群"):
    resp = client.post(
        "/private_channels/create",
        json={"name": name, "members": [], "kind": "group"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


# ── Lookup ────────────────────────────────────────────────────────────────


def test_lookup_requires_login(app):
    _setup(app, "alice")
    group = _create_group(_client_for(app, "alice"))

    assert app.test_client().get(f"/groups/lookup?group_no={group['group_no']}").status_code == 302


def test_lookup_finds_the_group_by_number(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])

    body = clients["bob"].get(f"/groups/lookup?group_no={group['group_no']}").get_json()

    assert body["id"] == group["id"]
    assert body["name"] == group["name"]
    assert body["member_count"] == 1
    assert body["already_member"] is False
    assert body["pending"] is False


def test_lookup_rejects_a_malformed_number(app):
    clients = _setup(app, "alice")
    for bad in ("", "123", "1234567", "123456789", "abcdefgh", "1234 678"):
        assert clients["alice"].get(f"/groups/lookup?group_no={bad}").status_code == 400, bad


def test_lookup_unknown_number_is_404(app):
    clients = _setup(app, "alice")

    assert clients["alice"].get("/groups/lookup?group_no=99999999").status_code == 404


def test_lookup_does_not_reveal_members(app):
    """The number is shared; the roster is not."""
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])

    body = clients["bob"].get(f"/groups/lookup?group_no={group['group_no']}").get_json()

    assert "members" not in body
    assert "owner" not in body


def test_lookup_cannot_find_a_legacy_channel(app):
    """Only groups have numbers, so channels stay unfindable."""
    clients = _setup(app, "alice")
    resp = clients["alice"].post(
        "/private_channels/create",
        json={"name": "旧频道", "members": [], "kind": "channel"},
    )
    assert resp.get_json()["group_no"] is None


# ── Requesting ────────────────────────────────────────────────────────────


def test_request_join_creates_a_pending_request(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])

    resp = clients["bob"].post(f"/groups/{group['id']}/join_request", json={"note": "是我"})

    assert resp.status_code == 202
    lookup = clients["bob"].get(f"/groups/lookup?group_no={group['group_no']}").get_json()
    assert lookup["pending"] is True


def test_a_second_request_is_rejected(app):
    """One pending request per person, enforced by the partial unique index too."""
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    clients["bob"].post(f"/groups/{group['id']}/join_request", json={})

    assert clients["bob"].post(f"/groups/{group['id']}/join_request", json={}).status_code == 409


def test_a_member_cannot_request_to_join(app):
    clients = _setup(app, "alice")
    group = _create_group(clients["alice"])

    assert clients["alice"].post(f"/groups/{group['id']}/join_request", json={}).status_code == 409


def test_requesting_to_join_a_legacy_channel_is_forbidden(app):
    clients = _setup(app, "alice", "bob")
    created = clients["alice"].post(
        "/private_channels/create",
        json={"name": "旧频道", "members": [], "kind": "channel"},
    ).get_json()

    assert clients["bob"].post(f"/groups/{created['id']}/join_request", json={}).status_code == 403


def test_requesting_does_not_make_you_a_member(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    clients["bob"].post(f"/groups/{group['id']}/join_request", json={})

    listed = clients["bob"].get("/private_channels").get_json()

    assert all(row["id"] != group["id"] for row in listed)


# ── Deciding ──────────────────────────────────────────────────────────────


def _request_from(client, group):
    resp = client.post(f"/groups/{group['id']}/join_request", json={})
    assert resp.status_code == 202
    return resp


def _incoming(client):
    return client.get("/groups/join_requests").get_json()["incoming"]


def test_owner_sees_the_request_and_can_approve(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)

    queue = _incoming(clients["alice"])
    assert len(queue) == 1
    assert queue[0]["username"] == "bob"

    resp = clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{queue[0]['id']}",
        json={"action": "approve"},
    )

    assert resp.status_code == 200
    listed = clients["bob"].get("/private_channels").get_json()
    assert [row["id"] for row in listed] == [group["id"]]


def test_approved_member_cannot_read_history_from_before(app):
    """Same rule as an invitation: joining gives you from-now, not the backlog."""
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{_incoming(clients['alice'])[0]['id']}",
        json={"action": "approve"},
    )

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    row = db.execute(
        "SELECT history_start_ts FROM private_channel_members"
        " WHERE channel_id = ? AND username = ?",
        (group["id"], "bob"),
    ).fetchone()
    db.close()

    assert row is not None
    assert row[0] is not None


def test_rejecting_leaves_the_applicant_out(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)

    clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{_incoming(clients['alice'])[0]['id']}",
        json={"action": "reject"},
    )

    listed = clients["bob"].get("/private_channels").get_json()
    assert listed == []
    assert _incoming(clients["alice"]) == []


def test_rejection_is_visible_to_the_applicant(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{_incoming(clients['alice'])[0]['id']}",
        json={"action": "reject"},
    )

    outgoing = clients["bob"].get("/groups/join_requests").get_json()["outgoing"]

    assert outgoing[0]["status"] == "rejected"
    assert outgoing[0]["group_name"] == group["name"]


def test_a_rejected_applicant_may_ask_again(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{_incoming(clients['alice'])[0]['id']}",
        json={"action": "reject"},
    )

    assert clients["bob"].post(f"/groups/{group['id']}/join_request", json={}).status_code == 202


def test_admin_can_approve_but_a_plain_member_cannot(app):
    clients = _setup(app, "alice", "bob", "carol")
    group = _create_group(clients["alice"])
    clients["alice"].post(
        f"/private_channels/{group['id']}/add_member", json={"username": "bob"}
    )
    clients["alice"].post(f"/groups/{group['id']}/role", json={"username": "bob", "role": "admin"})
    _request_from(clients["carol"], group)
    request_id = _incoming(clients["alice"])[0]["id"]

    assert (
        clients["bob"]
        .post(f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "approve"})
        .status_code
        == 200
    )


def test_a_plain_member_cannot_decide(app):
    clients = _setup(app, "alice", "bob", "carol")
    group = _create_group(clients["alice"])
    clients["alice"].post(
        f"/private_channels/{group['id']}/add_member", json={"username": "bob"}
    )
    _request_from(clients["carol"], group)
    request_id = _incoming(clients["alice"])[0]["id"]

    assert (
        clients["bob"]
        .post(f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "approve"})
        .status_code
        == 403
    )


def test_outsider_cannot_decide(app):
    clients = _setup(app, "alice", "bob", "mallory")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = _incoming(clients["alice"])[0]["id"]

    assert (
        clients["mallory"]
        .post(f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "approve"})
        .status_code
        == 403
    )


def test_a_decided_request_cannot_be_decided_again(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = _incoming(clients["alice"])[0]["id"]
    clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "approve"}
    )

    resp = clients["alice"].post(
        f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "reject"}
    )

    assert resp.status_code == 409


def test_bad_action_is_rejected(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = _incoming(clients["alice"])[0]["id"]

    assert (
        clients["alice"]
        .post(f"/groups/{group['id']}/join_requests/{request_id}", json={"action": "maybe"})
        .status_code
        == 400
    )


# ── Withdrawing ───────────────────────────────────────────────────────────


def test_applicant_can_withdraw(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = clients["bob"].get("/groups/join_requests").get_json()["outgoing"][0]["id"]

    assert (
        clients["bob"]
        .delete(f"/groups/{group['id']}/join_requests/{request_id}")
        .status_code
        == 200
    )
    assert _incoming(clients["alice"]) == []


def test_only_the_applicant_can_withdraw(app):
    clients = _setup(app, "alice", "bob", "carol")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = clients["bob"].get("/groups/join_requests").get_json()["outgoing"][0]["id"]

    assert (
        clients["carol"]
        .delete(f"/groups/{group['id']}/join_requests/{request_id}")
        .status_code
        == 403
    )


def test_withdrawing_frees_the_slot(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)
    request_id = clients["bob"].get("/groups/join_requests").get_json()["outgoing"][0]["id"]
    clients["bob"].delete(f"/groups/{group['id']}/join_requests/{request_id}")

    assert clients["bob"].post(f"/groups/{group['id']}/join_request", json={}).status_code == 202


# ── Notifications ─────────────────────────────────────────────────────────


def test_owner_gets_a_system_dm_about_a_request(app):
    clients = _setup(app, "alice", "bob")
    group = _create_group(clients["alice"])
    _request_from(clients["bob"], group)

    db = sqlite3.connect(str(common_mod.shared_db_path()))
    rows = db.execute(
        "SELECT content FROM messages WHERE channel = ? AND content_type = 'system'",
        ("dm:system:alice",),
    ).fetchall()
    db.close()

    assert any("申请加入" in row[0] for row in rows)
