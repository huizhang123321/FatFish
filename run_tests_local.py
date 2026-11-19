"""Local test runner that executes the repo's pytest test files without pytest.

Why this exists
---------------
pytest cannot run under this sandbox at all: its ``tmp_path`` machinery creates
numbered directories and then enumerates their parent, and both the enumeration
and the nested ``mkdir`` are rejected with WinError 5. This is environmental,
not a code defect — upstream's own untouched ``tests/test_common.py`` fails
identically here, and the same ``mkdtemp`` + nested ``mkdir`` succeeds when run
as a plain script.

The test files themselves are the deliverable and are plain pytest (they run
unchanged on a normal dev box). This runner imports those very files, reproduces
the ``conftest.isolated_dbs`` isolation by hand, and calls each test function
with the fixtures it asks for, so the assertions are genuinely executed here.

Usage:  python run_tests_local.py [test_module.py ...]
Exit code 0 = every selected test passed.
"""

import importlib.util
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "minimost" / "src"
TESTS = ROOT / "minimost" / "tests"

os.environ["MINIMOST_SKIP_TLS"] = "1"
os.environ["MINIMOST_SKIP_CLEANUP"] = "1"
# The sandbox only permits nested mkdir under a scratch dir we create ourselves;
# put every temp dir there instead of the default system temp.
SCRATCH = ROOT / ".test-scratch"
if SCRATCH.exists():
    shutil.rmtree(SCRATCH, ignore_errors=True)


def _writable_dir(path):
    """Return True when *path* can be created and nested ``mkdir`` works.

    A directory left behind by an earlier run can carry a stale security label
    (it was created before the workspace was provisioned), in which case the
    sandbox refuses every write inside it with WinError 5.  It also cannot be
    deleted, because the workspace root denies child deletion for Everyone.
    Probing lets us fall back to a sibling instead of failing every test.
    """
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-probe"
        probe.mkdir()
        probe.rmdir()
        return True
    except OSError:
        return False


def _pick_scratch_base():
    """Choose a scratch directory that is actually writable from this process.

    Three candidates, in order: the repository (fast, same volume as the data
    under test), then the operating system's temp directory.  The workspace can
    become read-only for this process -- a sandbox grant that expired, a
    permission reset -- and the suite must still be runnable instead of refusing
    to start, so the temp directory is tried last rather than not at all.
    """
    os_temp = Path(tempfile.gettempdir()) / "fatfish-tests"
    for candidate in (SCRATCH, ROOT / ".test-scratch-run", os_temp):
        if _writable_dir(candidate):
            return candidate
    raise SystemExit(
        "no writable scratch directory: tried "
        + ", ".join(str(p) for p in (SCRATCH, ROOT / ".test-scratch-run", os_temp))
    )


SCRATCH = _pick_scratch_base()


def _new_tmp_dir(name):
    """Create a fresh, writable per-test directory under :data:`SCRATCH`.

    ``tempfile.mkdtemp`` is deliberately avoided here.  It creates its
    directory with mode ``0o700``, and this Python maps that mode onto a
    restrictive Windows ACL that the sandbox token cannot traverse, so every
    test would die with WinError 5 before its first statement.  A default-mode
    ``mkdir`` simply inherits the scratch directory's ACL and stays usable.
    """
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)[:40] or "test"
    for attempt in range(1000):
        candidate = SCRATCH / f"{stem}_{attempt}"
        try:
            candidate.mkdir()
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"could not create a scratch directory for {name!r}")

# ``presence`` initialises its tables at import time against whatever
# ``paths.data_dir()`` resolves to.  Point that at a freshly created directory
# inside the scratch tree instead of the source checkout: the checkout was
# extracted outside the sandbox, so its label makes it read-only for this
# process and the import would die with "unable to open database file" before a
# single test ran.  Every test redirects the DB paths again via _isolated().
os.environ["MINIMOST_DATA_DIR"] = str(SCRATCH / "_data_dir")

sys.path.insert(0, str(SRC))


class MonkeyPatch:
    """Minimal stand-in for pytest's monkeypatch (object-form setattr + env)."""

    def __init__(self):
        self._undo = []

    def setattr(self, target, name, value, raising=True):
        if isinstance(target, str):
            # "module.attr" form
            mod_name, _, attr = target.rpartition(".")
            target = importlib.import_module(mod_name)
            name, value = attr, name
        old = getattr(target, name, None)
        had = hasattr(target, name)
        self._undo.append((target, name, old, had))
        setattr(target, name, value)

    def setenv(self, key, value):
        self._undo.append(("__env__", key, os.environ.get(key), key in os.environ))
        os.environ[key] = value

    def delenv(self, key, raising=True):
        if key not in os.environ and raising:
            raise KeyError(key)
        self._undo.append(("__env__", key, os.environ.get(key), key in os.environ))
        os.environ.pop(key, None)

    def undo(self):
        for target, name, old, had in reversed(self._undo):
            if target == "__env__":
                if had:
                    os.environ[name] = old
                else:
                    os.environ.pop(name, None)
            elif had:
                setattr(target, name, old)
        self._undo.clear()


def _load_module(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = module
    spec.loader.exec_module(module)
    return module


def _isolated(tmp):
    """Reproduce conftest.isolated_dbs: redirect every data path into tmp."""
    from werkzeug.security import generate_password_hash  # noqa: F401

    import minimost.audit as audit_mod
    import minimost.auth as auth_mod
    import minimost.chat as chat_mod
    import minimost.common as common_mod
    import minimost.preview as preview_mod
    import minimost.presence as presence_mod
    import minimost.ratelimit as ratelimit_mod

    users_dir = tmp / "users"
    uploads_dir = tmp / "uploads"
    avatars_dir = tmp / "avatars"
    for d in (users_dir, uploads_dir, avatars_dir):
        d.mkdir(parents=True, exist_ok=True)

    mp = MonkeyPatch()
    mp.setattr(auth_mod, "AUTH_DB", str(tmp / "auth.db"))
    mp.setattr(presence_mod, "PRESENCE_DB", str(tmp / "presence.db"))
    mp.setattr(common_mod, "DB_DIR", users_dir)
    mp.setattr(chat_mod, "UPLOAD_DIR", uploads_dir)
    mp.setattr(chat_mod, "AVATAR_DIR", avatars_dir)
    mp.setattr(audit_mod, "AUDIT_LOG", str(tmp / "audit.log"))
    preview_mod._CACHE.clear()
    ratelimit_mod.reset_all()

    from minimost.database import init_auth_db
    from minimost.presence import _init_tables

    init_auth_db()
    _init_tables()
    return mp


def _make_app():
    from minimost import create_app

    app = create_app()
    app.config["TESTING"] = True
    app.config["CSRF_ENABLED"] = False
    app.config["RATELIMIT_ENABLED"] = False
    return app


def _seed_users(usernames, app):
    """Register *usernames* and return an authenticated client for the first."""
    import sqlite3 as _s

    from werkzeug.security import generate_password_hash

    import minimost.auth as auth_mod
    import minimost.common as common_mod

    for u in usernames:
        db = _s.connect(auth_mod.AUTH_DB)
        db.execute(
            "INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)",
            (u, generate_password_hash("Password1!")),
        )
        db.commit()
        db.close()
        common_mod.init_user_db(u)
    c = app.test_client()
    with c.session_transaction() as sess:
        sess["user"] = usernames[0]
    return c


def _unwrap_fixture(fn):
    """Return the plain function behind a ``@pytest.fixture`` decorator.

    pytest's marker wraps the function and raises if it is called directly. The
    original is reachable via ``__wrapped__`` (set by functools.wraps) or the
    marker's ``func`` attribute; fall back to ``fn`` if neither is present.
    """
    marker = getattr(fn, "_pytestfixturefunction", None)
    inner = getattr(marker, "func", None) or getattr(fn, "__wrapped__", None)
    return inner or fn


def _resolve_fixture(pname, module, app_holder, tmp, extra_undo):
    """Build the value for one fixture parameter, resolving recursively.

    Supports the conftest fixtures this repo uses (``app``, ``client``,
    ``alice``, ``alice_and_bob``, ``isolated_dbs``, ``tmp_path``,
    ``monkeypatch``) plus module-level fixtures declared with
    ``@pytest.fixture`` inside the test file itself (e.g. ``fast_stream`` in
    test_routes_events.py).

    :param app_holder: One-element list caching the lazily-created app so every
        fixture in a single test sees the same instance.
    """
    import inspect

    def get_app():
        if app_holder[0] is None:
            app_holder[0] = _make_app()
        return app_holder[0]

    if pname == "app":
        return get_app()
    if pname == "client":
        return get_app().test_client()
    if pname == "tmp_path":
        return tmp
    if pname == "monkeypatch":
        m = MonkeyPatch()
        extra_undo.append(m)
        return m
    if pname == "isolated_dbs":
        # Isolation is already applied by _isolated(tmp). The conftest fixture
        # yields nothing, so tests request it purely as an ordering dependency.
        get_app()
        return None
    if pname == "alice":
        return _seed_users(("alice",), get_app())
    if pname == "alice_and_bob":
        return _seed_users(("alice", "bob"), get_app())

    # Module-level @pytest.fixture functions. The decorator refuses direct
    # calls, so unwrap to the original function first.
    fn = getattr(module, pname, None)
    if callable(fn):
        fn = _unwrap_fixture(fn)
        sig = inspect.signature(fn)
        return fn(
            **{
                dep: _resolve_fixture(dep, module, app_holder, tmp, extra_undo)
                for dep in sig.parameters
            }
        )

    raise RuntimeError(f"unknown fixture: {pname}")


def run_module(path):
    print(f"\n=== {path.name} ===")
    module = _load_module(path)
    import inspect

    names = [n for n, f in vars(module).items() if n.startswith("test_") and callable(f)]
    names.sort(key=lambda n: (inspect.getsourcelines(getattr(module, n))[1]))

    passed, failed = 0, []
    for name in names:
        fn = getattr(module, name)
        tmp = _new_tmp_dir(name)
        mp = None
        extra_undo = []
        try:
            mp = _isolated(tmp)
            sig = inspect.signature(fn)
            app_holder = [None]
            kwargs = {
                pname: _resolve_fixture(pname, module, app_holder, tmp, extra_undo)
                for pname in sig.parameters
            }

            fn(**kwargs)
            passed += 1
            print(f"  PASS {name}")
        except Exception:
            failed.append(name)
            last = traceback.format_exc().strip().splitlines()[-1]
            print(f"  FAIL {name}: {last}")
        finally:
            for m in extra_undo:
                m.undo()
            if mp is not None:
                mp.undo()
            shutil.rmtree(tmp, ignore_errors=True)
    return passed, failed


def main(argv):
    targets = argv[1:] or [
        "test_migrations.py",
        "test_routes_social.py",
        "test_routes_groups.py",
    ]
    total_passed, total_failed = 0, []
    for t in targets:
        p = Path(t)
        if not p.is_absolute():
            p = TESTS / t
        pp, ff = run_module(p)
        total_passed += pp
        total_failed.extend((p.name, f) for f in ff)

    print("\n" + "=" * 60)
    print(f"PASSED {total_passed}   FAILED {len(total_failed)}")
    if total_failed:
        print("\nFailures:")
        for mod, f in total_failed:
            print(f"  {mod}::{f}")
        return 1
    print("ALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))