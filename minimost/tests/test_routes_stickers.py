"""Route tests for :mod:`minimost.stickers` — the imported sticker library."""

import io
import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import common as common_mod
from minimost import presence as presence_mod

# A real 1x1 PNG: the routes validate by signature, so the bytes have to be real.
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


def _import(client, content=PNG, filename="sticker.png", name="测试贴纸"):
    return client.post(
        "/stickers",
        data={"file": (io.BytesIO(content), filename), "name": name},
        content_type="multipart/form-data",
    )


# ── Listing and access control ────────────────────────────────────────────


def test_list_requires_login(client):
    assert client.get("/stickers").status_code == 302


def test_import_requires_login(client):
    assert client.post("/stickers").status_code == 302


def test_list_is_empty_at_first(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    body = alice.get("/stickers").get_json()

    assert body["items"] == []
    assert body["max"] > 0


# ── Importing ─────────────────────────────────────────────────────────────


def test_import_stores_the_image(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = _import(alice, name="我的贴纸")

    assert resp.status_code == 201, resp.get_data(as_text=True)
    item = resp.get_json()["item"]
    assert item["name"] == "我的贴纸"
    assert item["mine"] is True
    assert item["token"] == "[sticker:custom-{0}]".format(item["id"])
    assert item["url"] == "/stickers/{0}/image".format(item["id"])


def test_import_rejects_a_renamed_non_image(app):
    """A text file called .png must not be stored, or it is served as an image."""
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = _import(alice, content=b"<html><script>alert(1)</script></html>", filename="x.png")

    assert resp.status_code == 400
    assert alice.get("/stickers").get_json()["items"] == []


def test_import_rejects_an_oversized_file(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    oversized = PNG + b"\x00" * (1024 * 1024 + 10)
    resp = _import(alice, content=oversized)

    assert resp.status_code == 413


def test_import_without_a_file_is_rejected(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = alice.post("/stickers", data={}, content_type="multipart/form-data")

    assert resp.status_code == 400


def test_import_ignores_the_uploaded_filename(app):
    """The stored name is generated, so a traversal attempt cannot matter."""
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = _import(alice, filename="../../../evil.png")

    assert resp.status_code == 201
    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    stored = db.execute("SELECT stored_name FROM custom_stickers").fetchone()[0]
    db.close()
    assert ".." not in stored and "/" not in stored and "\\" not in stored


# ── Serving ───────────────────────────────────────────────────────────────


def test_image_is_served_with_an_image_content_type(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    item = _import(alice).get_json()["item"]

    resp = alice.get(item["url"])

    assert resp.status_code == 200
    assert resp.mimetype == "image/png"
    assert resp.get_data() == PNG


def test_image_requires_login(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    item = _import(alice).get_json()["item"]

    assert app.test_client().get(item["url"]).status_code == 302


def test_missing_image_is_404(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    assert alice.get("/stickers/9999/image").status_code == 404


def test_any_user_can_see_the_shared_library(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    item = _import(alice).get_json()["item"]

    listed = bob.get("/stickers").get_json()["items"]
    assert len(listed) == 1
    assert listed[0]["mine"] is False
    assert bob.get(item["url"]).status_code == 200


# ── Removing ──────────────────────────────────────────────────────────────


def test_uploader_can_delete(app):
    _add_user("alice")
    alice = _client_for(app, "alice")
    item = _import(alice).get_json()["item"]

    resp = alice.delete("/stickers/{0}".format(item["id"]))

    assert resp.status_code == 200
    assert alice.get("/stickers").get_json()["items"] == []
    assert alice.get(item["url"]).status_code == 404


def test_only_the_uploader_can_delete(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")
    item = _import(alice).get_json()["item"]

    resp = bob.delete("/stickers/{0}".format(item["id"]))

    assert resp.status_code == 403
    assert len(alice.get("/stickers").get_json()["items"]) == 1


def test_delete_unknown_is_404(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    assert alice.delete("/stickers/4242").status_code == 404


def test_deleted_sticker_leaves_the_file_behind_or_not_but_disappears(app):
    """The row is what matters: once it is gone nothing can resolve the id."""
    _add_user("alice")
    alice = _client_for(app, "alice")
    item = _import(alice).get_json()["item"]
    alice.delete("/stickers/{0}".format(item["id"]))

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    rows = db.execute("SELECT COUNT(*) FROM custom_stickers").fetchone()[0]
    db.close()

    assert rows == 0
