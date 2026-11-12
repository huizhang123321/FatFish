# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build description for ``minimost-server.exe``.

Build it with::

    .venv/Scripts/python.exe -m PyInstaller packaging/minimost-server.spec \
        --distpath packaging/dist --workpath packaging/build --noconfirm

The result is a single-folder bundle at ``packaging/dist/minimost-server/``.
Electron-builder copies that whole folder into the installer's
``resources/server`` directory, which is where ``electron/backend.js`` looks for
it first.

Why one folder rather than ``--onefile``: a one-file build unpacks itself into a
temporary directory on every launch, which adds a multi-second start-up cost and
defeats the "double-click and it is there" goal. The folder is also what lets the
icon, the bundled templates and the SQLite migrations sit on disk where the
process can read them without an extraction step.

Why the data files are listed explicitly: the Flask app finds its templates,
static assets, migration SQL and the desktop interface through
``Path(__file__).parent``, so each of those trees has to land at exactly
``minimost/<name>`` inside the bundle. Anything missing shows up as a 500 or a
"界面尚未构建" placeholder rather than a build error, so the checks below fail the
build instead.
"""

import sys
from pathlib import Path

# SPECPATH is injected by PyInstaller and points at this file's directory.
HERE = Path(SPECPATH).resolve()
ROOT = HERE.parent
PACKAGE = ROOT / "minimost" / "src" / "minimost"

if not (PACKAGE / "__init__.py").is_file():
    raise SystemExit(f"cannot find the minimost package at {PACKAGE}")

#: (source, destination-inside-bundle) pairs.
_data_specs = [
    (PACKAGE / "templates", "minimost/templates"),
    (PACKAGE / "static", "minimost/static"),
    (PACKAGE / "migrations", "minimost/migrations"),
    (PACKAGE / "settings.json", "minimost"),
    (PACKAGE / "desktop_ui", "minimost/desktop_ui"),
]

datas = []
for source, destination in _data_specs:
    if not source.exists():
        raise SystemExit(
            f"missing build input: {source}\n"
            "The desktop interface must be built first:  cd desktop && npm run build"
        )
    datas.append((str(source), destination))

# The desktop interface is generated; shipping an empty one would produce a
# server that answers /app/ with the "not built yet" placeholder.
_index = PACKAGE / "desktop_ui" / "index.html"
if not _index.is_file():
    raise SystemExit(
        f"desktop interface bundle is incomplete: {_index} is missing\n"
        "Build it with:  cd desktop && npm install && npm run build"
    )

a = Analysis(
    [str(HERE / "server_entry.py")],
    pathex=[str(PACKAGE.parent)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Flask, Werkzeug and Jinja2 are imported normally, so PyInstaller's own
    # hooks cover them; excluding the test/typing heavyweights keeps the bundle
    # small without touching anything the server uses.
    excludes=[
        "tkinter",
        "pytest",
        "unittest",
        "pydoc",
        "doctest",
        "email_validator",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="minimost-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # No console window: this is spawned by the desktop shell, and a black
    # terminal flashing up behind the window would look broken. Diagnostics go
    # to server.log in the data directory instead (see packaging/server_entry.py).
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(HERE / "minimost-server.ico") if (HERE / "minimost-server.ico").is_file() else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="minimost-server",
)
