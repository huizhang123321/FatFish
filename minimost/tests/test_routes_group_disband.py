"""Disbanding a group must destroy what the group owned.

Earlier behaviour kept the transcript, on the reasoning that a vanished channel
makes it unreachable. In practice a disbanded group still appeared as a
conversation other members could click, and clicking it produced nothing -- the
"group chat does not respond" report. These tests pin the destructive version:
transcript, attachments, read state and pending join requests all go.
"""

import io
import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import chat as chat_mod
from minimost import common as common_mod
from minimost import presence as presence_mod

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


def _group(client, name="临时群"):
    resp = client.post(
        "/private_channels/create", json={"name": name, "members": [], "kind": "group"}
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    return resp.get_json()


def _send(client, channel, text=""):
    return client.post(f"/send/{channel}", data={"text": text}, content_type="multipart/form-data")


def _row_counts(channel):
    """(messages, reactions, read_state) for one channel."""
    db = sqlite3.connect(str(common_mod.shared_db_path()))
    try:
        messages = db.execute(
            "SELECT COUNT(*) FROM messages WHERE channel = ?", (channel,)
        ).fetchone()[0]
        reactions = db.execute(
            "SELECT COUNT(*) FROM reactions WHERE message_id IN"
            " (SELECT id FROM messages WHERE channel = ?)",
            (channel,),
        ).fetchone()[0]
        reads = db.execute(
            "SELECT COUNT(*) FROM read_state WHERE channel = ?", (channel,)
        ).fetchone()[0]
    finally:
        db.close()
    return messages, reactions, reads


def _disband(client, group):
    return client.delete(f"/groups/{group['id']}", json={"confirm": group["name"]})


# ── The transcript goes with the group ────────────────────────────────────


def test_disband_erases_the_transcript(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    _send(clients["alice"], group["channel"], "第一条")
    _send(clients["alice"], group["channel"], "第二条")

    before = _row_counts(group["channel"])
    assert before[0] == 2, before

    assert _disband(clients["alice"], group).status_code == 200

    assert _row_counts(group["channel"])[0] == 0


def test_disband_erases_read_state(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    _send(clients["alice"], group["channel"], "hi")
    clients["alice"].post(f"/read/{group['channel']}")

    assert _row_counts(group["channel"])[2] >= 1
    _disband(clients["alice"], group)
    assert _row_counts(group["channel"])[2] == 0


def test_disband_erases_pending_join_requests(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"])
    clients["bob"].post(f"/groups/{group['id']}/join_request", json={})

    _disband(clients["alice"], group)

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    rows = db.execute(
        "SELECT COUNT(*) FROM group_join_requests WHERE channel_id = ?", (group["id"],)
    ).fetchone()[0]
    db.close()
    assert rows == 0


def test_disband_removes_the_attachment_file(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    clients["alice"].post(
        f"/send/{group['channel']}",
        data={"text": "", "files": (io.BytesIO(PNG), "shot.png")},
        content_type="multipart/form-data",
    )

    db = sqlite3.connect(str(common_mod.shared_db_path()))
    filename = db.execute(
        "SELECT filename FROM messages WHERE channel = ? AND filename IS NOT NULL",
        (group["channel"],),
    ).fetchone()[0]
    db.close()
    path = chat_mod.UPLOAD_DIR / filename
    assert path.is_file()

    _disband(clients["alice"], group)

    assert not path.is_file(), "the message's file was left on disk"


def test_disband_removes_the_group_from_the_sidebar(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"], "一起玩")
    clients["alice"].post(
        f"/private_channels/{group['id']}/add_member", json={"username": "bob"}
    )
    assert any(row["id"] == group["id"] for row in clients["bob"].get("/private_channels").get_json())

    _disband(clients["alice"], group)

    assert clients["bob"].get("/private_channels").get_json() == []


def test_the_channel_becomes_unreadable(app):
    """Clicking a disbanded group must be a clear 404, not an empty pane."""
    clients = _setup(app, "alice")
    group = _group(clients["alice"])
    _send(clients["alice"], group["channel"], "hi")
    _disband(clients["alice"], group)

    resp = clients["alice"].get(f"/messages/{group['channel']}?after=0")

    assert resp.status_code in (403, 404), resp.status_code


# ── The safety rails stay ─────────────────────────────────────────────────


def test_only_the_owner_may_disband(app):
    clients = _setup(app, "alice", "bob")
    group = _group(clients["alice"])
    clients["alice"].post(
        f"/private_channels/{group['id']}/add_member", json={"username": "bob"}
    )
    _send(clients["alice"], group["channel"], "hi")

    # Adding a member posts a system line, so compare before/after rather than
    # hard-coding a count.
    before = _row_counts(group["channel"])[0]
    assert before >= 1, before

    assert _disband(clients["bob"], group).status_code == 403
    assert _row_counts(group["channel"])[0] == before, "a refused disband must not delete anything"


def test_confirmation_must_match(app):
    clients = _setup(app, "alice")
    group = _group(clients["alice"], "别删我")
    _send(clients["alice"], group["channel"], "hi")

    resp = clients["alice"].delete(f"/groups/{group['id']}", json={"confirm": "猜的"})

    assert resp.status_code == 400
    assert _row_counts(group["channel"])[0] == 1


def test_a_legacy_channel_has_no_disband(app):
    """Ordering channels are removed by leaving, not by disbanding."""
    clients = _setup(app, "alice")
    created = clients["alice"].post(
        "/private_channels/create",
        json={"name": "旧频道", "members": [], "kind": "channel"},
    ).get_json()

    assert (
        clients["alice"].delete(f"/groups/{created['id']}", json={"confirm": "旧频道"}).status_code
        == 404
    )
