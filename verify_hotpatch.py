"""Verify a hot patch of an *installed* FatFish, without reinstalling it.

Starts the installed backend on a spare port against a throw-away data directory,
then checks the three things a patch has to change:

  1. ``/app/health`` still answers (the frozen server itself is intact);
  2. the installed interface bundle contains the new Settings section;
  3. the new machine-access routes exist and reject an unauthenticated caller
     (``/api/tokens`` redirects to the login page, ``/api/v1/messages`` is 401).

Usage:
    python verify_hotpatch.py "E:\\wj\\FatFish"
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

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
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fetch(url: str, *, data: bytes | None = None, headers: dict | None = None, timeout: float = 5.0):
    request = urllib.request.Request(url, data=data, headers=headers or {})
    # A 302 is a result worth reporting, not an error.
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers or {})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> int:
    install = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\wj\FatFish")
    server = install / "resources" / "server" / "minimost-server.exe"
    bundle_dir = install / "resources" / "server" / "_internal" / "minimost" / "desktop_ui"

    print(f"install : {install}")
    print(f"server  : {server}")

    if not server.is_file():
        print("missing packaged server")
        return 2

    # 1. The interface bundle on disk already tells us whether the patch landed.
    js_files = sorted(bundle_dir.glob("assets/*.js"))
    print(f"\n=== bundle on disk ===")
    check("interface bundle present", bool(js_files), str(bundle_dir))
    if js_files:
        blob = js_files[0].read_bytes()
        text = blob.decode("utf-8", "replace")
        print(f"  {js_files[0].name}: {len(blob):,} bytes")
        check("bundle carries the API section", "API 接入服务" in text)
        check("bundle carries the push endpoint path", "/api/v1/messages" in text)
        check("bundle carries the token route", "/api/tokens" in text)
        check("bundle carries both theme choices", "日间模式" in text and "夜间模式" in text)
        check("bundle writes the theme attribute", "dataset.theme" in text or 'data-theme' in text)

    css_files = sorted(bundle_dir.glob("assets/*.css"))
    if css_files:
        css = css_files[0].read_text("utf-8", "replace")
        print(f"  {css_files[0].name}: {len(css):,} bytes")
        # The minifier drops the quotes from the attribute selector, so both
        # spellings have to be accepted.
        check(
            "stylesheet defines the light palette",
            "data-theme=light" in css or 'data-theme="light"' in css,
        )
        check("light palette sets a white page background", "#fff" in css.lower())

    # 2. Start it and check the routes really answer.
    #
    # ``tempfile.mkdtemp`` is avoided on purpose: it creates the directory with
    # mode 0o700, which this Python maps onto a Windows ACL the server process
    # cannot write into, so the backend would fail to open its databases. A
    # default-mode mkdir inherits a usable ACL.
    workdir = Path(tempfile.gettempdir()) / f"fatfish-hotpatch-{os.getpid()}"
    if workdir.exists():
        shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir()
    port = free_port()
    env = dict(os.environ)
    env.update(
        {
            "MINIMOST_DATA_DIR": str(workdir),
            "MINIMOST_DESKTOP": "1",
            "MINIMOST_SKIP_TLS": "1",
        }
    )

    proc = subprocess.Popen(
        [str(server), "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(server.parent),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    base = f"http://127.0.0.1:{port}"
    try:
        health = None
        deadline = time.time() + 60
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                status, body, _ = fetch(base + "/app/health")
                if status == 200:
                    health = json.loads(body)
                    break
            except Exception:
                pass
            time.sleep(0.4)

        print(f"\n=== installed server ===")
        check("server answers /app/health", health is not None)
        if health:
            check("still in desktop mode", health.get("desktop_mode") is True, str(health))
            check("reports a bundled UI", health.get("ui_bundled") is True, str(health))

        print(f"\n=== new routes ===")
        status, _, headers = fetch(base + "/api/tokens")
        check("/api/tokens requires a session (302 to login)", status == 302, f"status {status}")

        status, body, _ = fetch(
            base + "/api/v1/messages",
            data=json.dumps({"channel": "general", "text": "x"}).encode(),
            headers={"Content-Type": "application/json"},
        )
        check("/api/v1/messages rejects a missing token (401)", status == 401, f"status {status}")

        status, body, _ = fetch(
            base + "/api/v1/whoami",
            headers={"Authorization": "Bearer ff_deadbeef"},
        )
        check("/api/v1/whoami rejects a bogus token (401)", status == 401, f"status {status}")
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
        shutil.rmtree(workdir, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
