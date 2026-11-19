"""
minimost.migrations
===================

Idempotent, version-tracked SQLite migrations for MiniMost extensions.

Upstream MiniMost bootstraps its schema with ``CREATE TABLE IF NOT EXISTS``
inside :mod:`minimost.database` and :mod:`minimost.presence`, and adds columns
with best-effort ``ALTER TABLE ... ADD COLUMN`` wrapped in ``try/except``. That
works for a handful of columns but does not scale to the friend-system and
group-management tables this fork adds, and gives no record of *which* changes
have been applied to a given database.

This module adds a tiny, dependency-free migration runner:

* Every ``*.sql`` file under ``minimost/migrations/`` is named
  ``NNN_<db>_<slug>.sql`` where ``NNN`` is a monotonically increasing integer
  version and ``<db>`` is the target database (``auth`` or ``presence``).
* Each target database carries a ``schema_migrations`` table recording which
  versions have been applied. A file is executed at most once.
* Files run in version order, each in its own transaction.
* ``ALTER TABLE ... ADD COLUMN`` statements are made idempotent: a
  "duplicate column name" error is tolerated so a column that already exists
  (e.g. added by an older code path) never aborts the migration.

The runner reads the live ``auth.AUTH_DB`` / ``presence.PRESENCE_DB`` module
attributes at call time so the test suite's monkeypatched paths are honoured.

:func:`run_migrations` is called from :func:`minimost.create_app` at startup
(idempotent, multi-worker safe) and from the ``minimost migrate`` CLI
subcommand.
"""

import re
import sqlite3
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_MIGRATIONS_DIR = _HERE / "migrations"

_WAL = "PRAGMA journal_mode=WAL"

# NNN_auth_slug.sql / NNN_presence_slug.sql
_FILENAME_RE = re.compile(r"^(\d+)_(auth|presence)_(.+)\.sql$")

_CREATE_VERSION_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_ts REAL NOT NULL
)
"""


def _split_statements(sql):
    """Split a migration file into individual statements on ``;`` boundaries.

    Full-line ``--`` comments are stripped *before* splitting, so a semicolon
    inside a comment (e.g. "queries X in either column; user_b needs an index")
    cannot cut a statement in two. The migration SQL this fork ships keeps every
    comment on its own line and has no ``--`` inside a string literal, so
    line-based stripping plus a split on ``;`` is sufficient and keeps the runner
    free of a full SQL parser.

    :param sql: The full text of a migration file.
    :returns: A list of non-empty statement strings (comments removed).
    :rtype: list[str]
    """
    code_lines = [
        line for line in sql.splitlines() if not line.lstrip().startswith("--")
    ]
    statements = []
    for raw in "\n".join(code_lines).split(";"):
        statement = raw.strip()
        if statement:
            statements.append(statement)
    return statements


def _is_duplicate_column_error(exc):
    """True when *exc* is SQLite's "duplicate column name" OperationalError."""
    return isinstance(exc, sqlite3.OperationalError) and "duplicate column" in str(
        exc
    ).lower()


def _applied_versions(db):
    """Return the set of migration versions already applied to *db*."""
    db.execute(_CREATE_VERSION_TABLE)
    rows = db.execute("SELECT version FROM schema_migrations").fetchall()
    return {int(row[0]) for row in rows}


def _discover():
    """Return migration files as ``(version, db_name, path)`` sorted by version.

    Files that do not match the ``NNN_<db>_<slug>.sql`` convention are ignored
    so stray files in the directory cannot break the runner.
    """
    found = []
    if not _MIGRATIONS_DIR.is_dir():
        return found
    for path in sorted(_MIGRATIONS_DIR.iterdir()):
        match = _FILENAME_RE.match(path.name)
        if not match:
            continue
        found.append((int(match.group(1)), match.group(2), path))
    found.sort(key=lambda item: item[0])
    return found


def _db_path(db_name):
    """Resolve the on-disk path for the ``auth`` or ``presence`` database.

    Read from the live module attributes so monkeypatched test paths are used.

    :param db_name: ``"auth"`` or ``"presence"``.
    :returns: The absolute path string, or ``None`` if the name is unknown.
    :rtype: str or None
    """
    if db_name == "auth":
        from . import auth

        return auth.AUTH_DB
    if db_name == "presence":
        from . import presence

        return presence.PRESENCE_DB
    return None


def _apply_file(db, version, path):
    """Execute one migration file against *db* and record its version.

    Statements run in order. A tolerated "duplicate column name" error lets an
    ``ADD COLUMN`` be skipped when the column already exists. The version row is
    written in the same transaction so a file is never half-applied without a
    record.

    :param db: An open sqlite3 connection to the target database.
    :param version: The integer migration version.
    :param path: The ``Path`` to the SQL file.
    """
    sql = path.read_text(encoding="utf-8")
    for statement in _split_statements(sql):
        try:
            db.execute(statement)
        except sqlite3.OperationalError as exc:
            if _is_duplicate_column_error(exc):
                continue
            raise
    db.execute(
        "INSERT INTO schema_migrations (version, name, applied_ts) VALUES (?, ?, ?)",
        (version, path.name, time.time()),
    )
    db.commit()


def run_migrations():
    """Apply every pending migration to the auth and presence databases.

    Idempotent and safe to call on every startup and from multiple workers: a
    version already present in ``schema_migrations`` is skipped, and each file
    runs inside its own transaction. Base tables (``users``, ``user_settings``,
    ``private_channels``, ...) are created at import time by
    :mod:`minimost.database` and :mod:`minimost.presence`, so they exist before
    this runs.

    :returns: The number of migration files applied by this call.
    :rtype: int
    """
    applied = 0
    # Group files by database so each DB is opened once.
    for db_name in ("auth", "presence"):
        path = _db_path(db_name)
        if not path:
            continue
        files = [item for item in _discover() if item[1] == db_name]
        if not files:
            continue
        db = sqlite3.connect(path)
        try:
            db.execute(_WAL)
            done = _applied_versions(db)
            for version, _name, sql_path in files:
                if version in done:
                    continue
                _apply_file(db, version, sql_path)
                applied += 1
        finally:
            db.close()
    return applied


def current_versions():
    """Return ``{db_name: sorted list of applied versions}`` for diagnostics.

    Used by the ``minimost migrate --status`` CLI path to report what has been
    applied without changing anything.
    """
    result = {}
    for db_name in ("auth", "presence"):
        path = _db_path(db_name)
        if not path or not Path(path).exists():
            result[db_name] = []
            continue
        db = sqlite3.connect(path)
        try:
            db.execute(_WAL)
            result[db_name] = sorted(_applied_versions(db))
        finally:
            db.close()
    return result
