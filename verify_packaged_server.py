"""Smoke-test the packaged ``minimost-server.exe`` as the desktop shell runs it.

This is the counterpart to ``verify_desktop.py``: that one exercises the Python
code path in-process, this one launches the actual frozen executable the
installer ships, waits for its health endpoint the way ``electron/backend.js``
does, and drives the same requests the interface makes.

Run with::

    .venv/Scripts/python.exe -u verify_packaged_server.py

Exit code 0 means every check passed and the process tree was cleaned up.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXE = ROOT / "packaging" / "dist" / "minimost-server" / "minimost-server.exe"
DATA = ROOT / ".verify-packaged"

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"  PASS {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def free_port() -> int:
    """Bind port 0 and read back what the OS handed us."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fetch(url: str, *, timeout: float = 5.0) -> tuple[int, bytes, str]:
    request = urllib.request.Request(url, headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as err:
        return err.code, err.read(), err.headers.get("Content-Type", "") if err.headers else ""


def wait_for_health(port: int, process: subprocess.Popen, timeout: float = 45.0) -> dict | None:
    """Poll ``/app/health`` exactly like the Electron shell does."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            return None
        try:
            status, body, _ = fetch(f"http://127.0.0.1:{port}/app/health", timeout=2.0)
            if status == 200:
                return json.loads(body)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass
        time.sleep(0.25)
    return None


def _wait_exit(process: subprocess.Popen, timeout: float) -> bool:
    """Wait for *process* to exit; return True when it did."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            return True
        time.sleep(0.2)
    return process.poll() is not None


def main() -> int:
    if not EXE.is_file():
        print(f"missing packaged executable: {EXE}")
        print("Build it first:")
        print("  .venv/Scripts/python.exe -m PyInstaller packaging/minimost-server.spec "
              "--distpath packaging/dist --workpath packaging/build --noconfirm")
        return 2

    shutil.rmtree(DATA, ignore_errors=True)
    DATA.mkdir(parents=True, exist_ok=True)

    port = free_port()
    env = dict(os.environ)
    env.update(
        {
            "MINIMOST_DATA_DIR": str(DATA),
            "MINIMOST_DESKTOP": "1",
            "MINIMOST_SKIP_TLS": "1",
        }
    )
    # Sandboxed shells sometimes refuse to inherit a piped stdout for a windowed
    # executable; DEVNULL keeps the launch identical to what Electron does
    # (no console attached).
    process = subprocess.Popen(
        [str(EXE), "--host", "127.0.0.1", "--port", str(port)],
        env=env,
        cwd=str(EXE.parent),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        print(f"\n=== launch (pid {process.pid}, port {port}) ===")
        health = wait_for_health(port, process)
        check("executable answers /app/health", health is not None)
        if health is None:
            code = process.poll()
            log = DATA / "server.log"
            if log.is_file():
                print("\n--- server.log ---")
                print(log.read_text(encoding="utf-8", errors="replace")[-3000:])
            check("process still running", code is None, f"exited with {code}")
            return 1

        check("health status ok", health.get("status") == "ok", str(health))
        check("packaged build is in desktop mode", health.get("desktop_mode") is True, str(health))
        check("bundled UI detected", health.get("ui_bundled") is True, str(health))
        check("version reported", bool(health.get("version")), str(health))

        print("\n=== bundle served by the frozen build ===")
        status, body, content_type = fetch(f"http://127.0.0.1:{port}/app/")
        text = body.decode("utf-8", "replace")
        check("/app/ returns 200", status == 200, str(status))
        check("/app/ is the real bundle", "assets/index.js" in text, text[:160])
        check("/app/ is not the placeholder", "桌面界面尚未构建" not in text)

        status, body, content_type = fetch(f"http://127.0.0.1:{port}/app/assets/index.js")
        check("bundle JS served", status == 200, str(status))
        check("bundle JS content type", "javascript" in content_type, content_type)
        check("bundle JS is complete", len(body) > 50_000, str(len(body)))

        status, body, _ = fetch(f"http://127.0.0.1:{port}/csrf-token")
        payload = json.loads(body) if status == 200 else {}
        check("/csrf-token works", status == 200 and bool(payload.get("csrf_token")), str(status))

        print("\n=== offline guarantee ===")
        started = time.time()
        status, body, _ = fetch(f"http://127.0.0.1:{port}/link_preview?url=http://example.com")
        elapsed = time.time() - started
        # Unauthenticated -> 302 to /login; either way it must not fetch.
        check("link preview does not fetch", elapsed < 1.0, f"{elapsed:.3f}s")

        print("\n=== data directory ===")
        check("auth.db created in the data dir", (DATA / "auth.db").is_file())
        check("presence.db created in the data dir", (DATA / "presence.db").is_file())
        check("server.log written", (DATA / "server.log").is_file())
        check(
            "nothing written next to the executable",
            not (EXE.parent / "auth.db").exists() and not (EXE.parent / "_internal" / "auth.db").exists(),
        )
    finally:
        print("\n=== shutdown ===")
        # Mirror electron/backend.js: taskkill first (it reaps the tree), then
        # escalate to terminate/kill, because a restricted shell can be denied
        # taskkill even though it can signal its own child.
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        exited = _wait_exit(process, 6.0)
        if not exited:
            process.terminate()
            exited = _wait_exit(process, 4.0)
        if not exited:
            process.kill()
            exited = _wait_exit(process, 4.0)
        check("process tree terminated", exited, "still running after all three steps")

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")

    shutil.rmtree(DATA, ignore_errors=True)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
