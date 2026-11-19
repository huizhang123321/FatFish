"""Verify the installer really lays down a usable program.

Silently installs into a temporary directory, lists what arrived, checks that the
browser-mode launcher is there (the path that works on machines where Chromium
will not start), asserts the shipped interface bundle really contains the
features of this build, then silently uninstalls and confirms the directory is
gone.

The install target is a scratch directory, but the NSIS script's shortcut and
Add/Remove Programs entries are keyed on the product, not on the directory: a test
install would otherwise point the user's own shortcuts at the scratch copy, and
the test uninstall would delete the real Add/Remove entry. Both are therefore
snapshotted before the test and restored afterwards.

One caveat about this machine: an NSIS installer launched from an agent-spawned
process copies files but its registry and shortcut writes do not land at all (a
twenty-line control installer behaves the same way), so those parts of this script
are insurance for a normal session rather than something exercised here.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(r"E:\肥鱼收集")
RELEASE = ROOT / "desktop" / "release"
TARGET = ROOT / "insttest"

# Keys the installer owns, snapshotted so a test install cannot leave the user's
# own installation unregistered.
REGISTRY_KEYS = [
    r"HKCU\Software\FatFish",
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FatFish",
]

SHORTCUT_NAMES = [
    "FatFish.lnk",
    "FatFish（浏览器模式）.lnk",
]

# The start menu also carries these two. A test uninstall deletes them by name, so
# they must be snapshotted too or the user quietly loses them.
MENU_ONLY_NAMES = [
    "停止 FatFish.lnk",
    "卸载 FatFish.lnk",
]


def _shortcut_paths() -> list[Path]:
    """The shortcut files an install rewrites, in the user's desktop and menu."""
    home = Path(os.path.expanduser("~"))
    desktop = home / "Desktop"
    menu = Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs"
    paths = [desktop / name for name in SHORTCUT_NAMES]
    paths += [menu / "FatFish" / name for name in SHORTCUT_NAMES]
    paths += [menu / "FatFish" / name for name in MENU_ONLY_NAMES]
    return paths


def snapshot() -> dict:
    """Record the registry keys and shortcut files a test install would touch.

    Uses ``reg export`` rather than reading values, because export/import round
    trips the key exactly -- types, names, spacing -- where parsing ``reg query``
    output does not (it silently dropped DisplayName the first time this ran).
    """
    state: dict = {"registry": {}, "shortcuts": {}, "menu_dir": False}
    workdir = ROOT / ".verify-registry"
    workdir.mkdir(exist_ok=True)

    for index, key in enumerate(REGISTRY_KEYS):
        target = workdir / f"key{index}.reg"
        result = subprocess.run(
            ["reg", "export", key, str(target), "/y"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0 and target.is_file():
            state["registry"][key] = target

    for path in _shortcut_paths():
        if path.is_file():
            state["shortcuts"][str(path)] = path.read_bytes()

    menu_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs/FatFish"
    state["menu_dir"] = menu_dir.is_dir()
    return state


def restore(state: dict) -> None:
    """Put back what [snapshot] recorded, deleting anything the test created."""
    for key in REGISTRY_KEYS:
        subprocess.run(["reg", "delete", key, "/f"], capture_output=True, timeout=30)
        saved = state["registry"].get(key)
        if saved is not None and Path(saved).is_file():
            subprocess.run(
                ["reg", "import", str(saved)], capture_output=True, timeout=30
            )

    for path in _shortcut_paths():
        saved_bytes = state["shortcuts"].get(str(path))
        if saved_bytes is None:
            if path.is_file():
                path.unlink(missing_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(saved_bytes)

    menu_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft/Windows/Start Menu/Programs/FatFish"
    if menu_dir.is_dir() and not state["menu_dir"]:
        try:
            menu_dir.rmdir()
        except OSError:
            pass

    import shutil

    shutil.rmtree(ROOT / ".verify-registry", ignore_errors=True)


def newest_setup() -> Path | None:
    """The installer to test: the most recently built one, whatever its version."""
    candidates = sorted(RELEASE.glob("FatFish-Setup-*.exe"), key=lambda p: p.stat().st_mtime)
    return candidates[-1] if candidates else None


SETUP = newest_setup()

EXPECTED = [
    "FatFish.exe",
    "Uninstall.exe",
    "launcher-browser.cmd",
    "launcher-browser.ps1",
    "launcher-stop.cmd",
    "launcher-uninstall.cmd",
    os.path.join("resources", "app.asar"),
    os.path.join("resources", "server", "minimost-server.exe"),
    os.path.join("resources", "server", "_internal", "minimost", "desktop_ui", "index.html"),
]


def run(cmd: list[str], timeout: int = 600) -> int:
    print(f"  $ {' '.join(cmd)}")
    proc = subprocess.run(cmd, timeout=timeout)
    return proc.returncode


def main() -> int:
    """Run the whole install/uninstall cycle and report one pass/fail line."""
    # The test install rewrites the user's shortcuts and Add/Remove entry, so put
    # them back no matter how this ends.
    state = snapshot()
    try:
        return _run()
    finally:
        restore(state)


def _run() -> int:
    """Run the whole install/uninstall cycle and report one pass/fail line."""
    missing_side: list[str] = []

    if not SETUP.is_file():
        print(f"missing: {SETUP}")
        return 2

    if TARGET.exists():
        subprocess.run(["cmd", "/c", "rd", "/s", "/q", str(TARGET)], timeout=120)

    print(f"installer: {SETUP}  ({SETUP.stat().st_size} bytes)")
    print(f"target   : {TARGET}")

    # Ship-with check: the folder must also contain the launchers that work on a
    # machine whose %TEMP% NSIS cannot use (this one included).
    print("\n=== launcher shipped alongside ===")
    for path in (
        SETUP.parent / "安装 FatFish.cmd",
        SETUP.parent / "setup-launcher.ps1",
        SETUP.parent / "卸载 FatFish.cmd",
        SETUP.parent / "uninstall-fatfish.ps1",
    ):
        ok = path.is_file()
        print(f"  {'OK  ' if ok else 'MISS'} {path.name}")
        if not ok:
            missing_side.append(path.name)

    print("\n=== silent install ===")
    # NSIS needs a temp folder it can write to. On this machine the per-user
    # %TEMP% is refused ("Error writing temporary file"), which is exactly what
    # setup-launcher.ps1 works around, so the same redirection is applied here.
    temp_dir = ROOT / ".setuptemp"
    temp_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["TEMP"] = str(temp_dir)
    env["TMP"] = str(temp_dir)

    proc = subprocess.run([str(SETUP), "/S", f"/D={TARGET}"], env=env, timeout=1800)
    print(f"  exit code: {proc.returncode}")

    # The payload is ~386 MB; extraction is slow enough that the exit code is not
    # a reliable signal on its own, so wait for the files.
    deadline = time.time() + 1800
    while time.time() < deadline and not (TARGET / "resources" / "app.asar").is_file():
        time.sleep(2)

    if not TARGET.exists():
        print("  FAIL: install directory was never created")
        return 1

    print("\n=== installed files ===")
    missing = list(missing_side)
    for relative in EXPECTED:
        path = TARGET / relative
        ok = path.exists()
        size = path.stat().st_size if ok else 0
        print(f"  {'OK  ' if ok else 'MISS'} {relative}  {size:,} bytes")
        if not ok:
            missing.append(relative)

    total = sum(p.stat().st_size for p in TARGET.rglob("*") if p.is_file())
    print(f"\n  total installed: {total / 1024 / 1024:.1f} MB")

    # File presence is not enough: the installed bundle must be *this* build.
    # These two markers are the features added after the first release, so a
    # stale `resources\server` copied into the installer shows up here rather than
    # in the user's hands.
    print("\n=== shipped interface is the current build ===")
    ui = TARGET / "resources" / "server" / "_internal" / "minimost" / "desktop_ui"
    js_files = sorted(ui.glob("assets/*.js"))
    css_files = sorted(ui.glob("assets/*.css"))
    if not js_files:
        print("  FAIL: no interface bundle in the installed payload")
        missing.append("desktop_ui/assets/*.js")
    else:
        js = js_files[0].read_text("utf-8", "replace")
        for marker, label in (
            ("API 接入服务", "machine-access settings section"),
            ("日间模式", "light theme option"),
            ("夜间模式", "dark theme option"),
            ("/api/v1/messages", "push endpoint"),
        ):
            ok = marker in js
            print(f"  {'OK  ' if ok else 'MISS'} bundle: {label}")
            if not ok:
                missing.append(f"bundle marker {marker}")

    # The shell lives inside app.asar, and an installer can easily ship a stale
    # one (it is built from win-unpacked, not from the source tree). Check a
    # string that only the current main.js has: the product name in a start-up
    # dialog, which the rename changed.
    asar = TARGET / "resources" / "app.asar"
    if asar.is_file():
        shell = asar.read_bytes().decode("utf-8", "replace")
        ok = "FatFish 启动失败" in shell
        print(f"  {'OK  ' if ok else 'MISS'} shell: current main.js is packaged")
        if not ok:
            missing.append("app.asar from the current build")
        stale = "肥鱼聊天" in shell
        print(f"  {'OK  ' if not stale else 'MISS'} shell: old product name gone")
        if stale:
            missing.append("app.asar still carries the old name")
    else:
        print("  FAIL: resources/app.asar missing")
        missing.append("resources/app.asar")
    if css_files:
        css = css_files[0].read_text("utf-8", "replace")
        ok = "data-theme=light" in css or 'data-theme="light"' in css
        print(f"  {'OK  ' if ok else 'MISS'} stylesheet: light palette")
        if not ok:
            missing.append("stylesheet light palette")
    else:
        print("  FAIL: no stylesheet in the installed payload")
        missing.append("desktop_ui/assets/*.css")

    print("\n=== silent uninstall ===")
    # Uninstall with the standalone uninstaller that ships beside the setup. The
    # packaged NSIS uninstaller cannot start on this machine ("Error writing
    # temporary file"), which is exactly why the standalone one exists.
    standalone = SETUP.parent / "卸载 FatFish.cmd"
    if standalone.is_file():
        rc = run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SETUP.parent / "uninstall-fatfish.ps1"),
                "-InstallDir",
                str(TARGET),
                "-Quiet",
            ]
        )
        print(f"  uninstaller exit code: {rc}")
        deadline = time.time() + 120
        while time.time() < deadline and TARGET.exists():
            time.sleep(1)
    else:
        print("  FAIL: 卸载 FatFish.cmd missing, cannot test the uninstall route")
        missing.append("卸载 FatFish.cmd")

    leftovers = TARGET.exists()
    print(f"  install directory removed: {not leftovers}")
    if leftovers:
        remaining = sum(1 for p in TARGET.rglob("*") if p.is_file()) if TARGET.exists() else 0
        print(f"  files still present: {remaining}")

    print("\n=== result ===")
    if missing:
        print(f"  FAIL: {len(missing)} expected file(s) missing: {missing}")
        return 1
    if leftovers:
        print("  FAIL: uninstall left the programme behind")
        return 1
    print("  PASS: payload complete, this build verified, uninstall clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
