"""Searching groups by name.

The rule that matters: a group is only findable by name if its owner opted in.
Number lookup ignores that flag -- a number is handed out on purpose, a name is
not. These tests also pin the wildcard escaping and the paging.
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


def _group(client, name="周末联机", discoverable=False):
    created = client.post(
        "/private_channels/create",
        json={"name": name, "members": [], "kind": "group"},
    ).get_json()
    if discoverable:
        resp = client.post(f"/groups/{created['id']}/settings", json={"discoverable": True})
        assert resp.status_code == 200, resp.get_data(as_text=True)
    return created


def _search(client, query, offset=None):
    url = f"/groups/search?q={query}"
    if offset is not None:
        url += f"&offset={offset}"
    return client.get(url)


# ── Opt-in ────────────────────────────────────────────────────────────────


def test_a_group_is_not_searchable_by_default(app):
    clients = _setup(app, "alice", "bob")
    _group(clients["alice"], "周末联机")

    assert _search(clients["bob"], "周末").get_json()["items"] == []


def test_an_opted_in_group_is_found(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "周末联机", discoverable=True)

    items = _search(clients["bob"], "周末").get_json()["items"]

    assert [row["id"] for row in items] == [group["id"]]
    assert items[0]["name"] == "周末联机"
    assert items[0]["already_member"] is False


def test_a_number_still_works_for_a_hidden_group(app):
    """Opting out of name search must not break the number someone was given."""
    clients = _setup(app, "bob")
    alice = _client_for(app, "alice")
    _add_user("alice")
    group = _group(alice, "秘密基地", discoverable=False)

    assert _search(clients["bob"], "秘密").get_json()["items"] == []
    lookup = clients["bob"].get(f"/groups/lookup?group_no={group['group_no']}")
    assert lookup.status_code == 200


def test_only_the_owner_can_toggle_discoverability(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"])
    clients["alice"].post(
        f"/private_channels/{group['id']}/add_member", json={"username": "bob"}
    )
    clients["alice"].post(f"/groups/{group['id']}/role", json={"username": "bob", "role": "admin"})

    resp = clients["bob"].post(f"/groups/{group['id']}/settings", json={"discoverable": True})

    assert resp.status_code == 403


def test_settings_report_the_flag(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"], discoverable=True)

    settings = clients["alice"].get(f"/groups/{group['id']}/settings").get_json()

    assert settings["discoverable"] is True


def test_turning_it_off_removes_it_from_results(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "周末联机", discoverable=True)
    assert _search(clients["bob"], "周末").get_json()["items"]

    clients["alice"].post(f"/groups/{group['id']}/settings", json={"discoverable": False})

    assert _search(clients["bob"], "周末").get_json()["items"] == []


# ── Matching ──────────────────────────────────────────────────────────────


def test_matching_is_case_insensitive(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "Game Night", discoverable=True)

    items = _search(clients["bob"], "game").get_json()["items"]

    assert [row["id"] for row in items] == [group["id"]]


def test_a_wildcard_is_matched_literally(app):
    """Without escaping, a query of "%" would return every discoverable group."""
    clients = _setup(app, "alice", "bob")
    _group(clients["alice"], "周末联机", discoverable=True)
    _group(clients["alice"], "读书会", discoverable=True)

    # "%%" decodes to a two-character query of two literal percent signs.
    assert _search(clients["bob"], "%25%25").get_json()["items"] == []
    # "__" is two literal underscores, not "match any two characters".
    assert _search(clients["bob"], "__").get_json()["items"] == []


def test_a_group_named_with_a_percent_is_findable_by_it(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "100%通过率", discoverable=True)

    # "100%25" decodes to "100%", which must match literally.
    items = _search(clients["bob"], "100%25").get_json()["items"]

    assert [row["id"] for row in items] == [group["id"]]


def test_a_short_query_is_rejected(app):
    clients = _setup(app, "alice")
    for bad in ("", "周"):
        assert _search(clients["alice"], bad).status_code == 400, bad


def test_searching_does_not_reveal_members(app):
    clients = _setup(app, "alice", "bob")
    _group(clients["alice"], "周末联机", discoverable=True)

    item = _search(clients["bob"], "周末").get_json()["items"][0]

    assert "members" not in item
    assert "owner" not in item


def test_private_channels_are_never_listed(app):
    """Only groups have names worth searching; channels stay unfindable."""
    clients = _setup(app, "alice", "bob")
    clients["alice"].post(
        "/private_channels/create",
        json={"name": "周末频道", "members": [], "kind": "channel"},
    )

    assert _search(clients["bob"], "周末").get_json()["items"] == []


# ── Paging ────────────────────────────────────────────────────────────────


def test_results_are_paged(app):
    clients = _setup(app, "alice", "bob")
    for index in range(3):
        _group(clients["alice"], f"读书会{index}", discoverable=True)

    first = _search(clients["bob"], "读书会").get_json()

    assert len(first["items"]) == 3
    assert first["next_offset"] is None


def test_offset_skips_ahead(app):
    clients = _setup(app, "alice", "bob")
    for index in range(3):
        _group(clients["alice"], f"书友会{index}", discoverable=True)

    all_items = _search(clients["bob"], "书友会").get_json()["items"]
    tail = _search(clients["bob"], "书友会", offset=2).get_json()["items"]

    assert len(tail) == 1
    assert tail[0]["id"] == all_items[2]["id"]


def test_a_bad_offset_is_rejected(app):
    clients = _setup(app, "alice")

    assert _search(clients["alice"], "周末", offset="abc").status_code == 400


def test_an_unknown_name_is_an_empty_page(app):
    clients = _setup(app, "alice", "bob")

    body = _search(clients["bob"], "并不存在的群").get_json()

    assert body["items"] == []
    assert body["next_offset"] is None


# ── Interaction with joining ──────────────────────────────────────────────


def test_a_found_group_can_be_asked_to_join(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "周末联机", discoverable=True)

    found = _search(clients["bob"], "周末").get_json()["items"][0]
    status = clients["bob"].post(f"/groups/{found['id']}/join_request", json={}).status_code

    assert status == 202
    after = _search(clients["bob"], "周末").get_json()["items"][0]
    assert after["pending"] is True


def test_search_requires_login(app):
    assert app.test_client().get("/groups/search?q=%E5%91%A8%E6%9C%AB").status_code == 302
