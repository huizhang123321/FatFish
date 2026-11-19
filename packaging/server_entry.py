"""Frozen entry point for the packaged backend (``minimost-server.exe``).

The desktop shell spawns this executable as a child process, hands it a port on
loopback, and waits for ``GET /app/health`` to answer.  It is deliberately a thin
wrapper: every piece of server behaviour lives in the ``minimost`` package, so
the packaged build and ``python -m minimost`` run the same code.

Two things differ from ``python -m minimost`` and both exist for the packaged
case:

* **Data directory default.**  A frozen executable lives under ``Program Files``
  (read-only) and ``paths._CHECKOUT_ROOT`` would point inside the unpacked
  bundle, which is deleted on exit.  When ``MINIMOST_DATA_DIR`` is unset this
  falls back to ``%APPDATA%\\FatFish\\data`` so double-clicking the executable
  alone still works.  The Electron shell always sets the variable explicitly.
* **A log file.**  A windowed executable has no console, so anything written to
  stderr is lost.  A rotating file in the data directory keeps start-up failures
  diagnosable.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_DIR_NAME = "FatFish"


def _default_data_dir() -> Path:
    """Return the per-user data directory for a standalone (unmanaged) run."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / APP_DIR_NAME / "data"
    return Path.home() / f".{APP_DIR_NAME.lower()}" / "data"


def _configure_logging(data_dir: Path) -> None:
    """Send the server's logging to a rotating file next to the database."""
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return  # no writable location: stay silent rather than fail to start

    handler = RotatingFileHandler(
        data_dir / "server.log",
        maxBytes=2 * 1024 * 1024,
        backupCount=2,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)


def main() -> int:
    """Parse the desktop shell's arguments and serve the application."""
    parser = argparse.ArgumentParser(
        prog="minimost-server",
        description="FatFish local chat server (packaged build)",
    )
    parser.add_argument(
        "--host", default="127.0.0.1", help="Address to listen on (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port", type=int, default=5000, help="Port to listen on (default: 5000)"
    )
    args = parser.parse_args()

    if not os.environ.get("MINIMOST_DATA_DIR"):
        os.environ["MINIMOST_DATA_DIR"] = str(_default_data_dir())

    data_dir = Path(os.environ["MINIMOST_DATA_DIR"]).expanduser()
    _configure_logging(data_dir)

    logging.info(
        "starting minimost-server host=%s port=%s data=%s", args.host, args.port, data_dir
    )

    # Imported after the environment is finalised: importing the package resolves
    # the data directory and opens the databases at import time.
    from minimost import create_app
    from minimost.__main__ import _silence_stream_disconnect_logs

    app = create_app()
    app.config["DEV_SERVER"] = True

    cert = app.config.get("TLS_CERT_FILE")
    key = app.config.get("TLS_KEY_FILE")
    ssl_context = (cert, key) if cert and key else None

    _silence_stream_disconnect_logs()

    try:
        app.run(
            host=args.host,
            port=args.port,
            debug=False,
            ssl_context=ssl_context,
            threaded=True,
        )
    except Exception:  # pragma: no cover - only reachable in a packaged build
        logging.exception("server terminated unexpectedly")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
