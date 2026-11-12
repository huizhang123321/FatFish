"""The theme preference must survive a restart, so it lives on the account.

It used to live only in ``localStorage``, which is keyed by origin. The desktop
shell picks a free port on start, and a different port is a different origin, so
the choice silently reverted. These tests pin the server-side copy.
"""

import sqlite3

from werkzeug.security import generate_password_hash

from minimost import auth as auth_mod
from minimost import common as common_mod


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


def test_settings_reports_a_null_theme_before_any_choice(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    body = alice.get("/settings").get_json()

    assert body["theme"] is None


def test_saving_light_reads_back_as_light(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    assert alice.post("/theme", json={"theme": "light"}).status_code == 200
    assert alice.get("/settings").get_json()["theme"] == "light"


def test_saving_dark_reads_back_as_dark(app):
    """Switching back must work too -- dark is not represented by NULL."""
    _add_user("alice")
    alice = _client_for(app, "alice")

    alice.post("/theme", json={"theme": "light"})
    assert alice.post("/theme", json={"theme": "dark"}).status_code == 200
    assert alice.get("/settings").get_json()["theme"] == "dark"


def test_unknown_theme_is_rejected(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    resp = alice.post("/theme", json={"theme": "neon"})

    assert resp.status_code == 400
    assert alice.get("/settings").get_json()["theme"] is None


def test_missing_theme_is_rejected(app):
    _add_user("alice")
    alice = _client_for(app, "alice")

    assert alice.post("/theme", json={}).status_code == 400


def test_theme_toggle_does_not_blank_other_settings(app):
    """Reusing POST /settings would have nulled these; a separate route must not."""
    _add_user("alice")
    alice = _client_for(app, "alice")
    alice.post("/settings", json={"name_color": "#4cc2ff", "bio": "写代码的鱼"})

    alice.post("/theme", json={"theme": "light"})

    body = alice.get("/settings").get_json()
    assert body["name_color"] == "#4cc2ff"
    assert body["bio"] == "写代码的鱼"


def test_settings_route_still_works_without_a_theme(app):
    """The old callers (name colour, bio) must be unaffected by the new column."""
    _add_user("alice")
    alice = _client_for(app, "alice")

    assert alice.post("/settings", json={"name_color": "#ff0000", "bio": "hi"}).status_code == 200
    body = alice.get("/settings").get_json()
    assert body["name_color"] == "#ff0000"
    assert body["bio"] == "hi"


def test_saving_theme_requires_login(client):
    assert client.post("/theme", json={"theme": "light"}).status_code == 302


def test_theme_is_per_account(app):
    _add_user("alice")
    _add_user("bob")
    alice = _client_for(app, "alice")
    bob = _client_for(app, "bob")

    alice.post("/theme", json={"theme": "light"})

    assert alice.get("/settings").get_json()["theme"] == "light"
    assert bob.get("/settings").get_json()["theme"] is None
