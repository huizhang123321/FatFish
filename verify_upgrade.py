"""Verify that installing a new version upgrades in place and keeps user data.

What "自动覆盖旧版本，保留账号数据" has to mean in practice:

* running the installer *without* choosing a directory installs over the previous
  copy -- NSIS reads the recorded location, so there is no second installation;
* a running FatFish is stopped first, otherwise Windows keeps the exe and its dlls
  locked and the upgrade leaves a half-old program behind;
* files the previous version left in the install directory survive (an upgrade is
  not an uninstall);
* %APPDATA%\\FatFish is never read or written by the installer, so accounts and
  message history are untouched.

The real installation is not disturbed: the registry keys are exported before the
test and imported back afterwards.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(r"E:\肥鱼收集")
RELEASE = ROOT / "desktop" / "release"
WORK = ROOT / "upgrade-test"
TEMP_FOR_SETUP = ROOT / ".setuptemp"

REG_APP = r"HKCU\Software\FatFish"
REG_UNINST = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish"

PASSED: list[str] = []
FAILED: list[tuple[str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSED.append(name)
        print(f"  PASS {name}")
    else:
        FAILED.append((name, detail))
        print(f"  FAIL {name}{': ' + detail if detail else ''}")


def newest_setup() -> Path | None:
    candidates = sorted(RELEASE.glob("FatFish-Setup-*.exe"), key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None


def reg_query_value(key: str, name: str) -> str:
    result = subprocess.run(
        ["reg", "query", key, "/v", name], capture_output=True, text=True, timeout=30
    )
    for line in result.stdout.splitlines():
        if name in line and "REG_" in line:
            return line.split("REG_")[1].split(None, 1)[1].strip()
    return ""


def run_installer(setup: Path, extra: list[str]) -> int:
    """Install silently, with a temp folder NSIS can actually use on this machine."""
    TEMP_FOR_SETUP.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["TEMP"] = str(TEMP_FOR_SETUP)
    env["TMP"] = str(TEMP_FOR_SETUP)
    return subprocess.run(
        [str(setup), "/S", *extra], env=env, timeout=1800
    ).returncode


def data_fingerprint() -> tuple[int, float]:
    """Account count and DB mtime of the real data directory, to prove it is idle."""
    db = Path(os.path.expandvars(r"%APPDATA%\FatFish\data\auth.db"))
    if not db.is_file():
        return (-1, 0.0)
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    finally:
        conn.close()
    return (count, db.stat().st_mtime)


def main() -> int:
    setup = newest_setup()
    if setup is None:
        print("no installer found")
        return 2
    print(f"installer: {setup}")

    # ── Save everything the test may change ────────────────────────────────
    backup = ROOT / ".upgrade-backup"
    shutil.rmtree(backup, ignore_errors=True)
    backup.mkdir()
    exported = {}
    for index, key in enumerate((REG_APP, REG_UNINST)):
        target = backup / f"key{index}.reg"
        if subprocess.run(
            ["reg", "export", key, str(target), "/y"], capture_output=True, timeout=30
        ).returncode == 0:
            exported[key] = target
    real_install = reg_query_value(REG_APP, "InstallDir")
    print(f"real install: {real_install or '(none registered)'}")

    running = None
    before = data_fingerprint()
    print(f"data before: {before[0]} accounts, db mtime {before[1]:.0f}")

    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)

    try:
        # ── A. A previous version is installed and registered ──────────────
        print("\n=== setup: previous version installed ===")
        first = run_installer(setup, [f"/D={WORK}"])
        check("first install runs", first == 0, f"exit {first}")
        exe = WORK / "FatFish.exe"
        check("previous version is in place", exe.is_file())
        # Make the copy on disk differ from the package, the way an older build
        # would. NSIS skips writing files whose bytes are already identical
        # (SetDatablockOptimize), so comparing timestamps after installing the same
        # package twice would prove nothing.
        with open(exe, "ab") as handle:
            handle.write(b"old-version-marker")

        # Register the location, which is what an installation normally leaves
        # behind -- this is the state an upgrade starts from.
        subprocess.run(["reg", "add", REG_APP, "/v", "InstallDir", "/d", str(WORK), "/f"],
                       capture_output=True, timeout=30)

        # Something the old version left that an upgrade must not delete.
        marker = WORK / "user-kept-file.txt"
        marker.write_text("keep me", encoding="utf-8")

        # A running copy, to prove the upgrade stops it before overwriting.
        server = WORK / "resources" / "server" / "minimost-server.exe"
        running = None
        if server.is_file():
            env = dict(os.environ)
            env["MINIMOST_DATA_DIR"] = str(WORK / "throwaway-data")
            running = subprocess.Popen(
                [str(server), "--host", "127.0.0.1", "--port", "5399"],
                cwd=str(server.parent),
                env=env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(4)
        check("an instance of the old version is running", running is not None and running.poll() is None)

        # ── B. Install the new version without choosing a directory ─────────
        print("\n=== upgrade: install without /D ===")
        second = run_installer(setup, [])
        check("upgrade runs", second == 0, f"exit {second}")
        time.sleep(1)

        check("still installed in the same directory", exe.is_file())
        check(
            "no second installation was created",
            not (Path(os.environ["LOCALAPPDATA"]) / "Programs" / "FatFish" / "FatFish.exe").is_file(),
        )
        packaged = sorted(RELEASE.glob("win-unpacked/FatFish.exe"))[0]
        import hashlib

        def digest(path: Path) -> str:
            return hashlib.sha256(path.read_bytes()).hexdigest()

        check(
            "the program on disk was replaced by the packaged one",
            digest(exe) == digest(packaged),
            f"{digest(exe)[:12]} vs {digest(packaged)[:12]}",
        )
        check("files the old version left survive", marker.is_file())

        if running is not None:
            code = running.poll()
            check("the running instance was stopped", code is not None, f"still running (poll={code})")

        log = WORK / "_setup.log"
        if log.is_file():
            text = log.read_text(encoding="utf-8", errors="replace")
            check("the installer recognised this as an upgrade", "mode=upgrade" in text, text)

        # ── C. User data ───────────────────────────────────────────────────
        print("\n=== user data ===")
        after = data_fingerprint()
        check(
            "accounts untouched",
            after[0] == before[0],
            f"{before[0]} -> {after[0]}",
        )
        check(
            "the data directory was not written",
            after[1] == before[1],
            f"mtime {before[1]:.0f} -> {after[1]:.0f}",
        )

    finally:
        # Only the instance this test started: the installer stops processes by
        # image name, but the cleanup must not touch anything else the user runs.
        if running is not None and running.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(running.pid), "/T", "/F"],
                capture_output=True,
                timeout=30,
            )

        # Put the real installation's registration back exactly as it was.
        for key in (REG_APP, REG_UNINST):
            subprocess.run(["reg", "delete", key, "/f"], capture_output=True, timeout=30)
            saved = exported.get(key)
            if saved is not None and saved.is_file():
                subprocess.run(["reg", "import", str(saved)], capture_output=True, timeout=30)

        shutil.rmtree(WORK, ignore_errors=True)
        shutil.rmtree(backup, ignore_errors=True)
        shutil.rmtree(TEMP_FOR_SETUP, ignore_errors=True)

    print("\n" + "=" * 60)
    print(f"PASSED {len(PASSED)}   FAILED {len(FAILED)}")
    for name, detail in FAILED:
        print(f"  {name}: {detail}")
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
