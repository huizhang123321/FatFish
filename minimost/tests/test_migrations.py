"""Tests for :mod:`minimost.migrations` — the friend/group schema runner."""

import sqlite3

from minimost import migrations
from minimost import auth as auth_mod
from minimost import presence as presence_mod


def _tables(db_path):
    db = sqlite3.connect(db_path)
    try:
        rows = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    finally:
        db.close()
    return {r[0] for r in rows}


def _columns(db_path, table):
    db = sqlite3.connect(db_path)
    try:
        return {r[1] for r in db.execute(f"PRAGMA table_info({table})").fetchall()}
    finally:
        db.close()


def test_migrations_run_at_startup(app):
    """create_app() applies the migrations, so the new tables/columns exist."""
    presence_tables = _tables(presence_mod.PRESENCE_DB)
    assert "friends" in presence_tables
    assert "friend_requests" in presence_tables
    assert "schema_migrations" in presence_tables

    # display_name added to auth.db's user_settings.
    assert "display_name" in _columns(auth_mod.AUTH_DB, "user_settings")
    # group columns added to presence.db.
    assert "kind" in _columns(presence_mod.PRESENCE_DB, "private_channels")
    assert "role" in _columns(presence_mod.PRESENCE_DB, "private_channel_members")


def test_migrations_are_idempotent(app):
    """A second run applies nothing and never raises."""
    # First run already happened in create_app(); a repeat is a no-op.
    assert migrations.run_migrations() == 0
    # Tables still intact.
    assert "friends" in _tables(presence_mod.PRESENCE_DB)


def test_friends_pair_check_enforced(app):
    """The CHECK (user_a < user_b) invariant is enforced at the DB level."""
    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    try:
        import pytest

        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "INSERT INTO friends (user_a, user_b, created_ts) VALUES ('z', 'a', 0)"
            )
    finally:
        db.close()


def test_pending_request_unique_index(app):
    """Only one pending request per (from, to) direction is allowed."""
    import time

    import pytest

    db = sqlite3.connect(presence_mod.PRESENCE_DB)
    try:
        db.execute(
            "INSERT INTO friend_requests (from_user, to_user, created_ts)"
            " VALUES ('a', 'b', ?)",
            (time.time(),),
        )
        db.commit()
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                "INSERT INTO friend_requests (from_user, to_user, created_ts)"
                " VALUES ('a', 'b', ?)",
                (time.time(),),
            )
        db.commit()
    finally:
        db.close()


def test_current_versions_reports_applied(app):
    """current_versions() lists the applied versions per database."""
    versions = migrations.current_versions()
    assert 1 in versions["auth"]
    assert {2, 3, 4}.issubset(set(versions["presence"]))