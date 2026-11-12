"""End-to-end check of "join a group with its number" against the installed build.

Starts the packaged server on a spare port with a throw-away data directory, then
walks the whole flow with two real sessions:

    alice creates a group  ->  bob looks it up by number  ->  bob asks
    ->  alice sees the request  ->  alice approves  ->  bob can open the group

It also confirms the boundary: the number lets you ask, never enter.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVER = Path(r"E:\wj\FatFish\resources\server\minimost-server.exe")

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSED.append(name)
        print(f"  PASS {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Session:
    """One logged-in browser: cookie jar plus JSON helpers."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect
        )

    def get(self, path: str):
        return self._open(path, None, None)

    def post(self, path: str, payload=None):
        body = json.dumps(payload or {}).encode()
        return self._open(path, body, {"Content-Type": "application/json"})

    def delete(self, path: str):
        request = urllib.request.Request(self.base + path, method="DELETE")
        return self._raw(request)

    def _open(self, path, body, headers):
        request = urllib.request.Request(self.base + path, data=body, headers=headers or {})
        return self._raw(request)

    def _raw(self, request):
        try:
            with self.opener.open(request, timeout=15) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def json(self, path: str):
        """GET and parse, tolerating the plain-text error bodies the API returns."""
        status, body = self.get(path)
        if not body:
            return status, None
        try:
            return status, json.loads(body)
        except json.JSONDecodeError:
            return status, None


def signup(base: str, username: str, password: str) -> Session:
    """Create an account and return a session that is already signed in.

    The signup POST answers with a redirect that also carries ``Set-Cookie``.
    ``NoRedirect`` (used for the API checks, where a redirect must not be mistaken
    for success) also stops the cookie processor from seeing that response, so
    signup uses a plain opener over the same jar.
    """
    session = Session(base)
    _, body = session.get("/csrf-token")
    token = json.loads(body)["csrf_token"]
    data = urllib.parse.urlencode(
        {
            "csrf_token": token,
            "username": username,
            "password": password,
            "confirm_password": password,
        }
    ).encode()
    plain = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(session.jar),
        urllib.request.HTTPRedirectHandler(),
    )
    request = urllib.request.Request(
        base + "/signup", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with plain.open(request, timeout=20) as resp:
        assert resp.status == 200, resp.status

    status, body = session.get("/settings")
    assert status == 200, (
        f"signup did not leave {username} signed in (HTTP {status}): {body[:200]!r}"
    )
    return session


def main() -> int:
    if not SERVER.is_file():
        print(f"missing {SERVER}")
        return 2

    work = Path(tempfile.gettempdir()) / f"fatfish-join-{os.getpid()}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()

    port = free_port()
    env = dict(os.environ)
    env.update({"MINIMOST_DATA_DIR": str(work), "MINIMOST_SKIP_TLS": "1"})
    proc = subprocess.Popen(
        [str(SERVER), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(SERVER.parent),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{port}"

    try:
        deadline = time.time() + 60
        up = False
        while time.time() < deadline and proc.poll() is None:
            try:
                with urllib.request.urlopen(base + "/app/health", timeout=2) as resp:
                    up = resp.status == 200
                    break
            except Exception:
                time.sleep(0.4)
        print(f"\n=== server on {base} ===")
        check("installed server starts", up)
        if not up:
            return 1

        alice = signup(base, "alice", "AliceStrongPass1!x")
        bob = signup(base, "bob", "BobStrongPass1!xy")
        check("two accounts created", True)

        status, created = alice.post(
            "/private_channels/create",
            {"name": "周末联机", "members": [], "kind": "group"},
        )
        group = json.loads(created)
        check("group created", status == 200 and bool(group.get("group_no")), f"status {status}")
        group_no = group.get("group_no", "")
        print(f"  group_no: {group_no}")

        print("\n=== lookup ===")
        status, found = bob.json(f"/groups/lookup?group_no={group_no}")
        check("bob finds it by number", status == 200 and found["id"] == group["id"], f"status {status}")
        check("lookup hides the roster", "members" not in (found or {}))

        status, _ = bob.json("/groups/lookup?group_no=00000000")
        check("unknown number is 404", status == 404, f"status {status}")

        print("\n=== request ===")
        status, _ = bob.post(f"/groups/{group['id']}/join_request", {"note": "我是小林"})
        check("bob can ask", status == 202, f"status {status}")

        status, listing = bob.json("/private_channels")
        check(
            "asking is not joining",
            all(row["id"] != group["id"] for row in listing),
            str([row["id"] for row in listing]),
        )

        status, _ = bob.post(f"/groups/{group['id']}/join_request", {})
        check("a second request is refused", status == 409, f"status {status}")

        print("\n=== approval ===")
        status, queue = alice.json("/groups/join_requests")
        incoming = (queue or {}).get("incoming", [])
        check("owner sees the request", len(incoming) == 1, str(len(incoming)))

        if incoming:
            request_id = incoming[0]["id"]
            status, _ = bob.post(
                f"/groups/{group['id']}/join_requests/{request_id}", {"action": "approve"}
            )
            check("an outsider cannot approve", status == 403, f"status {status}")

            status, _ = alice.post(
                f"/groups/{group['id']}/join_requests/{request_id}", {"action": "approve"}
            )
            check("owner approves", status == 200, f"status {status}")

            status, listing = bob.json("/private_channels")
            check(
                "bob now has the group",
                [row["id"] for row in listing] == [group["id"]],
                str([row["id"] for row in listing]),
            )

            status, _ = alice.post(
                f"/groups/{group['id']}/join_requests/{request_id}", {"action": "reject"}
            )
            check("a decided request cannot be decided again", status == 409, f"status {status}")

        print("\n=== search by name (opt-in only) ===")
        status, page = bob.json(f"/groups/search?q={urllib.parse.quote('周末')}")
        check("a group is not searchable by default", status == 200 and page["items"] == [], str(page))

        status, _ = alice.post(f"/groups/{group['id']}/settings", {"discoverable": True})
        check("owner can make it discoverable", status == 200, f"status {status}")

        status, page = bob.json(f"/groups/search?q={urllib.parse.quote('周末')}")
        names = [item["name"] for item in (page or {}).get("items", [])]
        check("it is found by name after opting in", names == ["周末联机"], str(names))

        status, page = bob.json("/groups/search?q=%25%25")
        check(
            "a wildcard is matched literally, not as 'everything'",
            status == 200 and page["items"] == [],
            str((page or {}).get("items")),
        )

        status, _ = bob.get(f"/groups/search?q={urllib.parse.quote('周')}")
        check("a one-character query is refused", status == 400, f"status {status}")

        status, _ = alice.post(f"/groups/{group['id']}/settings", {"discoverable": False})
        status, page = bob.json(f"/groups/search?q={urllib.parse.quote('周末')}")
        check("turning it off hides it again", page["items"] == [], str(page))

        status, _ = bob.get(f"/groups/lookup?group_no={group_no}")
        check("the number still works while hidden", status == 200, f"status {status}")

        print("\n=== the number is not a key ===")
        carol = signup(base, "carol", "CarolStrongPass1!")
        status, _ = carol.post(f"/groups/{group['id']}/join_request", {})
        check("a stranger can ask too", status == 202, f"status {status}")
        status, listing = carol.json("/private_channels")
        check("but is not in the group", listing == [], str(listing))
        status, _ = carol.get(f"/private_channels/{group['id']}/members")
        check("and cannot read the roster", status == 403, f"status {status}")

    finally:
        if proc.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
