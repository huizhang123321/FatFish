"""Group settings: the group number and the per-group invite policy.

The number is what a person reads out to be added ("群号 12345678"), so it has to
be assigned once, stay stable, and never be a thinly disguised row id. The invite
policy used to be one global switch; groups now own theirs, while the global one
keeps acting as a floor.
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


def _make_users(*names):
    for name in names:
        _add_user(name)


def _create_group(client, name="测试群", members=()):
    resp = client.post(
        "/private_channels/create",
        json={"name": name, "members": list(members), "kind": "group"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


# ── Group number ──────────────────────────────────────────────────────────


def test_creating_a_group_assigns_a_number(app):
    _make_users("alice")
    alice = _client_for(app, "alice")

    body = _create_group(alice)

    assert body["group_no"]
    assert len(body["group_no"]) == 8
    assert body["group_no"].isdigit()


def test_two_groups_get_different_numbers(app):
    _make_users("alice")
    alice = _client_for(app, "alice")

    first = _create_group(alice, "群一")
    second = _create_group(alice, "群二")

    assert first["group_no"] != second["group_no"]


def test_group_number_is_stable(app):
    """Reading the settings twice must not re-roll the number."""
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    first = alice.get(f"/groups/{group['id']}/settings").get_json()["group_no"]
    second = alice.get(f"/groups/{group['id']}/settings").get_json()["group_no"]

    assert first == second == group["group_no"]


def test_number_is_not_derived_from_the_row_id(app):
    """A number that is just the id would let anyone enumerate groups."""
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    assert group["group_no"] != str(group["id"])
    assert group["group_no"] != str(10_000_000 + group["id"])


def test_legacy_group_without_a_number_gets_one_on_first_read(app):
    """Rows created before the column existed are filled in lazily."""
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    db.execute("UPDATE private_channels SET group_no = NULL WHERE id = ?", (group["id"],))
    db.commit()
    db.close()

    listed = alice.get("/private_channels").get_json()
    entry = [row for row in listed if row["id"] == group["id"]][0]

    assert entry["group_no"]
    assert entry["group_no"].isdigit()


def test_a_private_channel_has_no_number(app):
    _make_users("alice")
    alice = _client_for(app, "alice")

    resp = alice.post(
        "/private_channels/create",
        json={"name": "旧频道", "members": ["alice"], "kind": "channel"},
    )

    assert resp.get_json()["group_no"] is None


# ── Settings read ─────────────────────────────────────────────────────────


def test_settings_report_role_and_capabilities(app):
    _make_users("alice", "bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    group = _create_group(alice, members=["bob"])

    owner_view = alice.get(f"/groups/{group['id']}/settings").get_json()
    member_view = bob.get(f"/groups/{group['id']}/settings").get_json()

    assert owner_view["my_role"] == "owner"
    assert owner_view["can_manage"] is True
    assert owner_view["can_change_policy"] is True

    assert member_view["my_role"] == "member"
    assert member_view["can_manage"] is False
    assert member_view["can_change_policy"] is False


def test_non_member_cannot_read_settings(app):
    _make_users("alice", "mallory")
    alice = _client_for(app, "alice")
    mallory = _client_for(app, "mallory")
    group = _create_group(alice)

    assert mallory.get(f"/groups/{group['id']}/settings").status_code == 403


# ── Settings write ────────────────────────────────────────────────────────


def test_owner_can_change_the_invite_policy(app):
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    assert (
        alice.post(f"/groups/{group['id']}/settings", json={"invite_admin_only": True}).status_code
        == 200
    )

    settings = alice.get(f"/groups/{group['id']}/settings").get_json()
    assert settings["invite_admin_only"] is True


def test_admin_can_rename_but_not_change_the_policy(app):
    _make_users("alice", "bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    group = _create_group(alice, members=["bob"])
    alice.post(f"/groups/{group['id']}/role", json={"username": "bob", "role": "admin"})

    assert bob.post(f"/groups/{group['id']}/settings", json={"name": "新群名"}).status_code == 200
    # An admin must not be able to lock their peers out of inviting.
    assert (
        bob.post(f"/groups/{group['id']}/settings", json={"invite_admin_only": True}).status_code
        == 403
    )


def test_member_cannot_change_settings(app):
    _make_users("alice", "bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    group = _create_group(alice, members=["bob"])

    assert bob.post(f"/groups/{group['id']}/settings", json={"name": "偷改"}).status_code == 403
    assert (
        bob.post(f"/groups/{group['id']}/settings", json={"invite_admin_only": True}).status_code
        == 403
    )


def test_rename_through_settings_takes_effect(app):
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice, "旧名字")

    alice.post(f"/groups/{group['id']}/settings", json={"name": "新名字"})

    listed = alice.get("/private_channels").get_json()
    entry = [row for row in listed if row["id"] == group["id"]][0]
    assert entry["name"] == "新名字"


def test_empty_name_is_rejected(app):
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    assert alice.post(f"/groups/{group['id']}/settings", json={"name": "   "}).status_code == 400


def test_nothing_to_update_is_rejected(app):
    _make_users("alice")
    alice = _client_for(app, "alice")
    group = _create_group(alice)

    assert alice.post(f"/groups/{group['id']}/settings", json={}).status_code == 400


# ── The policy actually gates inviting ────────────────────────────────────


def test_admin_only_policy_blocks_a_plain_member_invite(app):
    _make_users("alice", "bob", "carol")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    group = _create_group(alice, members=["bob"])
    alice.post(f"/groups/{group['id']}/settings", json={"invite_admin_only": True})

    denied = bob.post(f"/private_channels/{group['id']}/add_member", json={"username": "carol"})
    allowed = alice.post(f"/private_channels/{group['id']}/add_member", json={"username": "carol"})

    assert denied.status_code == 403
    assert allowed.status_code == 200


def test_default_policy_lets_any_member_invite(app):
    _make_users("alice", "bob", "carol")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    group = _create_group(alice, members=["bob"])

    assert (
        bob.post(f"/private_channels/{group['id']}/add_member", json={"username": "carol"}).status_code
        == 200
    )


def test_invite_policy_can_be_chosen_at_creation(app):
    _make_users("alice", "bob", "carol")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    resp = alice.post(
        "/private_channels/create",
        json={
            "name": "严格群",
            "members": ["bob"],
            "kind": "group",
            "invite_admin_only": True,
        },
    )
    group = resp.get_json()

    assert group["invite_admin_only"] is True
    assert (
        bob.post(f"/private_channels/{group['id']}/add_member", json={"username": "carol"}).status_code
        == 403
    )
