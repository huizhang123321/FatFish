"""Tests for ``MINIMOST_DESKTOP=1`` desktop mode.

Desktop mode promises that the desktop build makes no outbound network
connections.  The single code path in the server that downloads a third-party
page is the link-preview fetcher, so it must be answered locally instead of
being invoked.  These tests pin that behaviour down and also assert the
non-desktop build still fetches, so the guard cannot silently become a
permanent stub.
"""


def _make_app():
    """Create an app with the same test configuration conftest uses."""
    from minimost import create_app

    application = create_app()
    application.config["TESTING"] = True
    application.config["CSRF_ENABLED"] = False
    application.config["RATELIMIT_ENABLED"] = False
    return application


def _login(client, username="alice"):
    """Attach an authenticated session to *client*."""
    with client.session_transaction() as sess:
        sess["user"] = username
    return client


def test_desktop_mode_reads_environment(monkeypatch):
    """``MINIMOST_DESKTOP`` is reflected in ``app.config["DESKTOP_MODE"]``."""
    monkeypatch.setenv("MINIMOST_DESKTOP", "1")
    app = _make_app()
    assert app.config["DESKTOP_MODE"] is True


def test_non_desktop_mode_is_the_default(monkeypatch):
    """Without the environment variable the server is *not* in desktop mode."""
    monkeypatch.delenv("MINIMOST_DESKTOP", raising=False)
    app = _make_app()
    assert not app.config["DESKTOP_MODE"]


def test_link_preview_skips_fetch_in_desktop_mode(monkeypatch):
    """Desktop mode answers ``{}`` and never reaches the network fetcher."""
    import minimost.preview as preview_mod

    calls = []

    def _must_not_run(url, *args, **kwargs):  # pragma: no cover - guard
        calls.append(url)
        raise AssertionError("fetch_preview must not run in desktop mode")

    monkeypatch.setattr(preview_mod, "fetch_preview", _must_not_run)
    monkeypatch.setenv("MINIMOST_DESKTOP", "1")

    client = _login(_make_app().test_client())
    resp = client.get("/link_preview?url=http://example.com")

    assert resp.status_code == 200
    assert resp.get_json() == {}
    assert calls == []


def test_link_preview_skips_fetch_for_blank_url_in_desktop_mode(monkeypatch):
    """The desktop guard also covers a request without a ``url`` parameter."""
    monkeypatch.setenv("MINIMOST_DESKTOP", "1")
    client = _login(_make_app().test_client())
    resp = client.get("/link_preview")
    assert resp.status_code == 200
    assert resp.get_json() == {}


def test_link_preview_still_fetches_outside_desktop_mode(monkeypatch):
    """Outside desktop mode the route keeps delegating to the fetcher."""
    import minimost.preview as preview_mod

    sentinel = {"type": "og", "title": "Example", "url": "http://example.com"}
    seen = []

    def _fake_fetch(url, *args, **kwargs):
        seen.append(url)
        return dict(sentinel)

    monkeypatch.setattr(preview_mod, "fetch_preview", _fake_fetch)
    monkeypatch.delenv("MINIMOST_DESKTOP", raising=False)

    client = _login(_make_app().test_client())
    resp = client.get("/link_preview?url=http://example.com")

    assert resp.status_code == 200
    assert resp.get_json() == sentinel
    assert seen == ["http://example.com"]


def test_link_preview_requires_login_in_desktop_mode(monkeypatch):
    """The desktop guard does not bypass authentication."""
    monkeypatch.setenv("MINIMOST_DESKTOP", "1")
    client = _make_app().test_client()
    resp = client.get("/link_preview?url=http://example.com")
    assert resp.status_code == 302


def test_health_reports_desktop_mode(monkeypatch):
    """``/app/health`` advertises desktop mode so the shell can display it."""
    monkeypatch.setenv("MINIMOST_DESKTOP", "1")
    client = _make_app().test_client()

    data = client.get("/app/health").get_json()

    assert data["status"] == "ok"
    assert data["desktop_mode"] is True
    assert "ui_bundled" in data


def test_health_reports_non_desktop_mode(monkeypatch):
    """The same endpoint reports ``desktop_mode: False`` for a browser build."""
    monkeypatch.delenv("MINIMOST_DESKTOP", raising=False)
    client = _make_app().test_client()

    data = client.get("/app/health").get_json()

    assert data["desktop_mode"] is False


# ── GET /csrf-token ───────────────────────────────────────────────────────────
#
# The desktop interface logs in with fetch instead of a server-rendered form, so
# it has no template to read the CSRF token from. This endpoint is the only way it
# can obtain the same per-session token the HTML forms embed; if it broke, every
# login from the desktop UI would be rejected with 403 by _enforce_csrf.


def test_csrf_token_is_anonymous():
    """A visitor without a session still gets a token (that is how they log in)."""
    client = _make_app().test_client()

    resp = client.get("/csrf-token")

    assert resp.status_code == 200
    data = resp.get_json()
    assert isinstance(data["csrf_token"], str)
    assert len(data["csrf_token"]) == 64  # secrets.token_hex(32)
    assert data["user"] is None


def test_csrf_token_is_stable_within_a_session():
    """Repeated calls return the same token, so it can be cached by the client."""
    client = _make_app().test_client()

    first = client.get("/csrf-token").get_json()["csrf_token"]
    second = client.get("/csrf-token").get_json()["csrf_token"]

    assert first == second


def test_csrf_token_reports_the_logged_in_user():
    """After login the endpoint tells the interface who it is."""
    client = _login(_make_app().test_client(), "alice")

    data = client.get("/csrf-token").get_json()

    assert data["user"] == "alice"


def test_csrf_token_unblocks_a_desktop_form_login():
    """The token works for a real form POST, which is the whole point."""
    import sqlite3

    from werkzeug.security import generate_password_hash

    import minimost.auth as auth_mod

    db = sqlite3.connect(auth_mod.AUTH_DB)
    db.execute(
        "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)",
        ("dave", generate_password_hash("DesktopPassword1!")),
    )
    db.commit()
    db.close()

    app = _make_app()
    # The shared test configuration disables CSRF checks; this test is about the
    # token actually satisfying them, so turn the real behaviour back on.
    app.config["CSRF_ENABLED"] = True
    client = app.test_client()
    token = client.get("/csrf-token").get_json()["csrf_token"]

    resp = client.post(
        "/login",
        data={"csrf_token": token, "username": "dave", "password": "DesktopPassword1!"},
        follow_redirects=False,
    )

    assert resp.status_code == 302
    assert client.get("/csrf-token").get_json()["user"] == "dave"


def test_csrf_token_login_rejects_a_bogus_token():
    """The endpoint does not weaken the existing CSRF check."""
    app = _make_app()
    app.config["CSRF_ENABLED"] = True
    client = app.test_client()
    # Establish a session (and therefore an expected token) without using it.
    client.get("/csrf-token")

    resp = client.post(
        "/login",
        data={"csrf_token": "0" * 64, "username": "dave", "password": "DesktopPassword1!"},
        follow_redirects=False,
    )

    assert resp.status_code == 403
