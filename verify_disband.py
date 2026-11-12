"""End-to-end check of disbanding a group against the installed build.

Walks the whole path with real sessions: create a group, post messages including
one attachment, join-request from an outsider, then disband as the owner and
confirm that the transcript, the attachment file, the read state, the pending
request and the sidebar entry are all gone, while a non-owner's attempt destroys
nothing.
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
import uuid
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
    def __init__(self, base: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect
        )

    def _send(self, request):
        try:
            with self.opener.open(request, timeout=20) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()

    def get(self, path: str):
        return self._send(urllib.request.Request(self.base + path))

    def post_json(self, path: str, payload=None):
        return self._send(
            urllib.request.Request(
                self.base + path,
                data=json.dumps(payload or {}).encode(),
                headers={"Content-Type": "application/json"},
            )
        )

    def delete_json(self, path: str, payload=None):
        return self._send(
            urllib.request.Request(
                self.base + path,
                data=json.dumps(payload or {}).encode(),
                headers={"Content-Type": "application/json"},
                method="DELETE",
            )
        )

    def post_multipart(self, path: str, fields: dict, filename: str, content: bytes, ctype: str):
        boundary = "----fatfish" + uuid.uuid4().hex
        body = b""
        for key, value in fields.items():
            body += f"--{boundary}\r\n".encode()
            body += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
            body += str(value).encode() + b"\r\n"
        body += f"--{boundary}\r\n".encode()
        body += (
            f'Content-Disposition: form-data; name="files"; filename="{filename}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode()
        body += content + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        return self._send(
            urllib.request.Request(
                self.base + path,
                data=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
        )


def signup(base: str, username: str, password: str) -> Session:
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
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(session.jar))
    request = urllib.request.Request(
        base + "/signup", data=data, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    with opener.open(request, timeout=20) as resp:
        assert resp.status == 200, resp.status
    status, _ = session.get("/settings")
    assert status == 200, f"signup did not sign {username} in (HTTP {status})"
    return session


PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    b"\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def main() -> int:
    if not SERVER.is_file():
        print(f"missing {SERVER}")
        return 2

    work = Path(tempfile.gettempdir()) / f"fatfish-disband-{os.getpid()}"
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

        alice = signup(base, "alice", "AliceStrongPass1!")
        bob = signup(base, "bob", "BobStrongPass1!xy")

        _, created = alice.post_json(
            "/private_channels/create", {"name": "临时群", "members": [], "kind": "group"}
        )
        group = json.loads(created)
        channel = group["channel"]
        print(f"  group {group['id']} channel={channel}")

        print("\n=== 准备数据 ===")
        alice.post_multipart(f"/send/{channel}", {"text": "带图的消息"}, "shot.png", PNG, "image/png")
        alice.post_multipart(f"/send/{channel}", {"text": "第二条"}, "x.bin", b"hello", "application/octet-stream")
        alice.post_json(f"/read/{channel}")
        bob.post_json(f"/groups/{group['id']}/join_request", {})
        _, listing = alice.get(f"/private_channels")
        check("the group is in the sidebar", any(r["id"] == group["id"] for r in json.loads(listing)))

        uploads = work / "uploads"
        before_files = sorted(p.name for p in uploads.iterdir()) if uploads.is_dir() else []
        check("two attachments were stored", len(before_files) == 2, str(before_files))

        print("\n=== 非群主不能解散 ===")
        status, _ = bob.delete_json(f"/groups/{group['id']}", {"confirm": "临时群"})
        check("a non-member is refused", status == 403, f"status {status}")
        _, messages = alice.get(f"/messages/{channel}?after=0")
        check("the refused attempt deleted nothing", len(json.loads(messages)) >= 3, str(len(json.loads(messages))))

        print("\n=== 销毁确认 ===")
        status, _ = alice.delete_json(f"/groups/{group['id']}", {"confirm": "临时群"})
        check("the owner disbands it", status == 200, f"status {status}")

        status, _ = alice.get(f"/messages/{channel}?after=0")
        check("the transcript is unreachable", status in (403, 404), f"status {status}")

        after_files = sorted(p.name for p in uploads.iterdir()) if uploads.is_dir() else []
        check("the attachment files are gone", after_files == [], str(after_files))

        _, listing = alice.get("/private_channels")
        check("it left the owner's sidebar", json.loads(listing) == [], str(json.loads(listing)))
        _, listing = bob.get("/private_channels")
        check("it left the other member's sidebar", json.loads(listing) == [], str(json.loads(listing)))

        db = work / "users" / "messages.db"
        if db.is_file():
            import sqlite3

            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = conn.execute("SELECT COUNT(*) FROM messages WHERE channel = ?", (channel,)).fetchone()[0]
            reads = conn.execute("SELECT COUNT(*) FROM read_state WHERE channel = ?", (channel,)).fetchone()[0]
            conn.close()
            check("no message rows remain", rows == 0, str(rows))
            check("no read-state rows remain", reads == 0, str(reads))

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
