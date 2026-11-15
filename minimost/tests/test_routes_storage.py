"""Storage report and cleanup routes.

The panel exists to answer two questions honestly: where the disk went, and can I
get some of it back without destroying a whole group. These tests pin both, plus the
permission line — clearing shared history is destructive, so only people who could
already manage the conversation may do it.
"""

import io
import json
import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import chat as chat_mod
from minimost import common as common_mod


PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


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


def _group(client, name="要清理的群", members=()):
    resp = client.post(
        "/private_channels/create",
        json={"name": name, "members": list(members), "kind": "group"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


def _channel(client, name="旧频道", members=()):
    resp = client.post(
        "/private_channels/create",
        json={"name": name, "members": list(members), "kind": "channel"},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


def _post_text(client, channel, text="hi"):
    return client.post(
        f"/send/{channel}", data={"text": text}, content_type="multipart/form-data"
    )


def _post_file(client, channel):
    return client.post(
        f"/send/{channel}",
        data={"text": "with-file", "files": (io.BytesIO(PNG), "shot.png")},
        content_type="multipart/form-data",
    )


def _stored_filename(channel):
    db = sqlite3.connect(str(common_mod.shared_db_path()))
    try:
        row = db.execute(
            "SELECT filename FROM messages WHERE channel = ? AND filename IS NOT NULL",
            (channel,),
        ).fetchone()
    finally:
        db.close()
    return row[0] if row else None


def _message_count(channel):
    db = sqlite3.connect(str(common_mod.shared_db_path()))
    try:
        return db.execute(
            "SELECT COUNT(*) FROM messages WHERE channel = ?", (channel,)
        ).fetchone()[0]
    finally:
        db.close()


# ── Report ────────────────────────────────────────────────────────────────


def test_report_requires_login(client):
    assert client.get("/storage").status_code == 302


def test_report_has_a_breakdown_that_adds_up(app):
    clients = _setup(app, "alice")

    body = clients["alice"].get("/storage").get_json()

    assert set(body["parts"]) == {"databases", "uploads", "avatars", "stickers", "other"}
    assert body["total_bytes"] >= sum(body["parts"].values())
    assert body["data_dir"]
    assert "conversations" in body and "orphans" in body


def _entry(client, channel):
    body = client.get("/storage").get_json()
    return [row for row in body["conversations"] if row["channel"] == channel][0]


def test_report_lists_conversations_with_their_weight(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    # Group creation leaves a system line, so compare deltas rather than totals.
    base = _entry(clients["alice"], group["channel"])["messages"]

    _post_text(clients["alice"], group["channel"], "one")
    _post_file(clients["alice"], group["channel"])

    # /send stores each attachment as its own message row, so text+file is two
    # rows: one with the text, one with the filename. Hence +3, not +2.
    entry = _entry(clients["alice"], group["channel"])
    assert entry["messages"] == base + 3
    assert entry["attachments"] == 1
    assert entry["attachment_bytes"] > 0
    assert entry["can_purge"] is True
    assert entry["kind"] == "group"


def test_a_plain_member_is_listed_but_cannot_purge(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], members=["bob"])

    entry = [
        row
        for row in clients["bob"].get("/storage").get_json()["conversations"]
        if row["channel"] == group["channel"]
    ][0]

    assert entry["can_purge"] is False


def test_an_admin_may_purge(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], members=["bob"])
    clients["alice"].post(
        f"/groups/{group['id']}/role", json={"username": "bob", "role": "admin"}
    )

    entry = [
        row
        for row in clients["bob"].get("/storage").get_json()["conversations"]
        if row["channel"] == group["channel"]
    ][0]

    assert entry["can_purge"] is True


# ── Purging one conversation ──────────────────────────────────────────────


def test_owner_can_purge_and_files_are_freed(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    _post_text(clients["alice"], group["channel"])
    _post_file(clients["alice"], group["channel"])
    stored = _stored_filename(group["channel"])
    assert (chat_mod.UPLOAD_DIR / stored).is_file()

    resp = clients["alice"].post("/storage/purge", json={"channel": group["channel"]})

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["freed_bytes"] > 0
    assert body["files"] == 1
    assert not (chat_mod.UPLOAD_DIR / stored).is_file()
    # The conversation itself survives, with a note explaining what happened.
    assert _message_count(group["channel"]) == 1
    listed = clients["alice"].get("/private_channels").get_json()
    assert [row["id"] for row in listed] == [group["id"]]


def test_purging_keeps_the_conversation_usable(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    clients["alice"].post("/storage/purge", json={"channel": group["channel"]})

    after = _post_text(clients["alice"], group["channel"], "收拾干净了")

    assert after.status_code == 200


def test_a_plain_member_cannot_purge(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], members=["bob"])
    _post_text(clients["alice"], group["channel"], "one")

    resp = clients["bob"].post("/storage/purge", json={"channel": group["channel"]})

    assert resp.status_code == 403
    assert _message_count(group["channel"]) >= 1


def test_an_outsider_cannot_purge(app):
    clients = _setup(app, "alice", "mallory")
    group = _group(clients["alice"])
    _post_text(clients["alice"], group["channel"], "one")

    assert (
        clients["mallory"].post("/storage/purge", json={"channel": group["channel"]}).status_code
        == 403
    )


def test_a_legacy_channel_member_may_purge(app):
    """Role-free channels have no owner, so any member counts as trusted."""
    clients = _setup(app, "alice", "bob")
    created = _channel(clients["alice"], members=["bob"])
    _post_text(clients["bob"], created["channel"], "hi")

    resp = clients["bob"].post("/storage/purge", json={"channel": created["channel"]})

    assert resp.status_code == 200


def test_a_dm_cannot_be_purged(app):
    clients = _setup(app, "alice", "bob")
    _post_text(clients["alice"], "dm:alice:bob", "hi")

    resp = clients["alice"].post("/storage/purge", json={"channel": "dm:alice:bob"})

    assert resp.status_code == 400


def test_purging_an_unknown_conversation_is_404(app):
    clients = _setup(app, "alice")

    assert clients["alice"].post("/storage/purge", json={"channel": "private:9999"}).status_code == 404


def test_purge_requires_a_channel(app):
    clients = _setup(app, "alice")

    assert clients["alice"].post("/storage/purge", json={}).status_code == 400


# ── Orphan files ──────────────────────────────────────────────────────────


def test_orphans_are_counted_and_removed(app):
    clients = _setup(app, "alice")
    channel = "general"
    _post_file(clients["alice"], channel)
    kept = _stored_filename(channel)

    # A file nothing references, the way deleting a single message leaves one.
    orphan = chat_mod.UPLOAD_DIR / "00000000000000000000000000000000_orphan.bin"
    orphan.write_bytes(b"x" * 500)

    before = clients["alice"].get("/storage").get_json()["orphans"]
    assert before["files"] >= 1

    resp = clients["alice"].post("/storage/orphans")

    assert resp.status_code == 200
    assert resp.get_json()["files"] >= 1
    assert not orphan.exists()
    assert (chat_mod.UPLOAD_DIR / kept).is_file(), "a referenced file must survive"
    after = clients["alice"].get("/storage").get_json()["orphans"]
    assert after["files"] == 0
