"""End-to-end verification of the desktop UI delivery path.

Checks, against a real ``create_app()`` instance and a throw-away data
directory, that:

1. ``GET /app/`` serves the built bundle (not the "not built yet" placeholder),
2. the bundle's JS/CSS/SVG assets are served with a usable content type and the
   security headers are still intact,
3. ``GET /app/health`` reports ``ui_bundled: true``,
4. the desktop login protocol works: ``GET /csrf-token`` then a form ``POST
   /login`` redirects to ``/`` (302) and the session is established,
5. a protected API answers with JSON for that session, and
6. unknown ``/app/`` paths fall back to ``index.html`` and traversal is refused.

Run with::

    .venv/Scripts/python.exe -u verify_desktop.py

Exit code 0 means every check passed.
"""

import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "minimost" / "src"
sys.path.insert(0, str(SRC))

DATA = ROOT / ".verify-desktop"
os.environ["MINIMOST_SKIP_TLS"] = "1"
os.environ["MINIMOST_SKIP_CLEANUP"] = "1"
os.environ["MINIMOST_DESKTOP"] = "1"
os.environ["MINIMOST_DATA_DIR"] = str(DATA)

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    if condition:
        PASSED.append(name)
        print(f"  PASS {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def main():
    shutil.rmtree(DATA, ignore_errors=True)
    DATA.mkdir(parents=True, exist_ok=True)

    from werkzeug.security import generate_password_hash

    import minimost.common as common_mod
    from minimost import create_app
    from minimost.database import init_auth_db

    init_auth_db()

    app = create_app()
    app.config["TESTING"] = True
    app.config["CSRF_ENABLED"] = True
    app.config["RATELIMIT_ENABLED"] = False

    from minimost.auth import AUTH_DB

    db = sqlite3.connect(AUTH_DB)
    db.execute(
        "INSERT INTO users (username, password_hash) VALUES (?, ?)",
        ("alice", generate_password_hash("DesktopPassword1!")),
    )
    db.commit()
    db.close()
    common_mod.init_user_db("alice")

    client = app.test_client()

    print("\n=== bundle delivery ===")
    index = client.get("/app/")
    body = index.get_data(as_text=True)
    check("/app/ returns 200", index.status_code == 200, str(index.status_code))
    check("/app/ is the built bundle", "assets/index.js" in body, body[:120])
    check("/app/ is not the placeholder", "桌面界面尚未构建" not in body)
    check(
        "CSP header present on the bundle",
        "default-src 'self'" in index.headers.get("Content-Security-Policy", ""),
    )
    check(
        "nosniff header present",
        index.headers.get("X-Content-Type-Options") == "nosniff",
    )

    js = client.get("/app/assets/index.js")
    check("bundle JS served", js.status_code == 200, str(js.status_code))
    check(
        "bundle JS content type",
        "javascript" in js.headers.get("Content-Type", ""),
        js.headers.get("Content-Type", ""),
    )
    check("bundle JS is non-trivial", len(js.get_data()) > 50_000, str(len(js.get_data())))

    css = client.get("/app/assets/index.css")
    check("bundle CSS served", css.status_code == 200, str(css.status_code))

    logo = client.get("/app/logo.svg")
    check("logo served", logo.status_code == 200, str(logo.status_code))

    fallback = client.get("/app/some/deep/route")
    check(
        "unknown /app path falls back to index.html",
        fallback.status_code == 200 and b"<div id=\"root\">" in fallback.get_data(),
        str(fallback.status_code),
    )

    traversal = client.get("/app/%2e%2e/%2e%2e/settings.json")
    check(
        "path traversal refused",
        traversal.status_code in (404, 400, 308, 200)
        and b"max_upload_size_mb" not in traversal.get_data(),
        str(traversal.status_code),
    )

    print("\n=== health ===")
    health = client.get("/app/health").get_json()
    check("health ok", health.get("status") == "ok", str(health))
    check("health reports bundled UI", health.get("ui_bundled") is True, str(health))
    check("health reports desktop mode", health.get("desktop_mode") is True, str(health))

    print("\n=== desktop login protocol ===")
    token_resp = client.get("/csrf-token")
    token_body = token_resp.get_json()
    check("/csrf-token returns 200", token_resp.status_code == 200)
    check("csrf token present", bool(token_body.get("csrf_token")))
    check("not logged in yet", token_body.get("user") is None, str(token_body))

    token = token_body["csrf_token"]
    login = client.post(
        "/login",
        data={
            "csrf_token": token,
            "username": "alice",
            "password": "DesktopPassword1!",
        },
        headers={"X-Requested-With": "XMLHttpRequest"},
        follow_redirects=False,
    )
    check("login redirects on success", login.status_code == 302, str(login.status_code))
    check(
        "login redirects to /",
        login.headers.get("Location", "").endswith("/"),
        login.headers.get("Location", ""),
    )

    after = client.get("/csrf-token").get_json()
    check("session now carries the user", after.get("user") == "alice", str(after))

    channels = client.get("/channels")
    check("/channels answers JSON", channels.status_code == 200 and isinstance(channels.get_json(), list))
    check("/channels is non-empty", bool(channels.get_json()))

    messages = client.get("/messages/general?after=0")
    check("/messages answers JSON", messages.status_code == 200 and isinstance(messages.get_json(), list))

    friends = client.get("/friends")
    check("/friends answers JSON", friends.status_code == 200 and isinstance(friends.get_json(), list))

    search = client.get("/users/search?q=ali")
    check("/users/search answers JSON", search.status_code == 200 and "items" in (search.get_json() or {}))

    print("\n=== link preview stays offline ===")
    started = time.time()
    preview = client.get("/link_preview?url=http://example.com")
    elapsed = time.time() - started
    check("link preview returns {}", preview.get_json() == {}, str(preview.get_json()))
    check("link preview did not wait on the network", elapsed < 0.5, f"{elapsed:.3f}s")

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")
    shutil.rmtree(DATA, ignore_errors=True)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
