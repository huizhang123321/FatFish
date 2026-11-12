"""
minimost.desktop
================

Serves the desktop application's bundled user interface.

Why this lives in Flask rather than being loaded from ``file://``
----------------------------------------------------------------
The desktop shell (Electron) points its window at ``http://127.0.0.1:<port>/app/``
instead of loading local files. Keeping the UI on the *same origin* as the API
means every existing server-side contract works unchanged and without
weakening anything:

* the signed session cookie is first-party, so ``SameSite=Lax`` still applies
  and no CORS or ``SameSite=None`` exception is needed;
* ``connect-src 'self'`` in the Content-Security-Policy already permits the
  ``fetch`` calls and the long-lived ``/events`` SSE stream;
* no cross-origin surface is opened between a ``file://`` document and the
  local server.

The legacy browser frontend stays at ``/`` untouched, so opening
``http://127.0.0.1:<port>/`` in a normal browser still serves the original UI.

The interface is a prebuilt static bundle in ``minimost/desktop_ui/`` (produced
by the ``desktop/`` project's build step and packaged into the wheel / frozen
executable). When the bundle is absent — e.g. a source checkout that has not
been built yet — the routes return a short explanatory page rather than a 500.
"""

from pathlib import Path

from flask import Blueprint, abort, current_app, send_file, send_from_directory

desktop_bp = Blueprint("desktop", __name__)

_HERE = Path(__file__).resolve().parent

#: Directory holding the prebuilt desktop interface bundle.
DESKTOP_UI_DIR = _HERE / "desktop_ui"

# Extensions the bundle may serve. Anything else 404s, so a crafted path cannot
# be used to reach a file the interface did not ship.
_ALLOWED_SUFFIXES = {
    ".html",
    ".js",
    ".mjs",
    ".css",
    ".json",
    ".svg",
    ".png",
    ".ico",
    ".woff",
    ".woff2",
    ".map",
}

_MISSING_BUNDLE_HTML = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>MiniMost Desktop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 48px;
         background: #14161a; color: #e6e6e6; line-height: 1.6; }
  code { background: #23262d; padding: 2px 6px; border-radius: 4px; }
  h1 { font-size: 20px; }
</style></head>
<body>
<h1>桌面界面尚未构建</h1>
<p>后端已正常运行，但 <code>minimost/desktop_ui/</code> 里没有界面文件。</p>
<p>请在项目根目录执行：</p>
<p><code>cd desktop &amp;&amp; npm install &amp;&amp; npm run build</code></p>
<p>构建产物会自动复制到该目录，之后刷新即可。</p>
<p>也可以直接访问 <a style="color:#7aa2f7" href="/">旧版浏览器界面</a>。</p>
</body>
</html>
"""


def desktop_ui_available() -> bool:
    """Return ``True`` when a built interface bundle is present."""
    return (DESKTOP_UI_DIR / "index.html").is_file()


@desktop_bp.route("/app/", methods=["GET"])
@desktop_bp.route("/app/<path:subpath>", methods=["GET"])
def desktop_ui(subpath="index.html"):
    """Serve the desktop interface bundle.

    Route: ``GET /app/`` and ``GET /app/<path>``

    Unauthenticated on purpose: the bundle is static markup and script, and the
    login screen itself must be reachable before a session exists. Every data
    route it calls is still ``@login_required``.

    Client-side routing is not used (the interface is a single screen with
    panels), but unknown non-file paths fall back to ``index.html`` so a deep
    link or a stale asset path still renders instead of 404-ing.
    """
    if not desktop_ui_available():
        return (
            _MISSING_BUNDLE_HTML,
            200,
            {"Content-Type": "text/html; charset=utf-8"},
        )

    # Normalise and refuse anything that escapes the bundle directory.
    candidate = (DESKTOP_UI_DIR / subpath).resolve()
    try:
        candidate.relative_to(DESKTOP_UI_DIR.resolve())
    except ValueError:
        abort(404)

    if candidate.is_file() and candidate.suffix.lower() in _ALLOWED_SUFFIXES:
        return send_from_directory(DESKTOP_UI_DIR, subpath)

    # Unknown path -> single-page fallback.
    index = DESKTOP_UI_DIR / "index.html"
    if not index.is_file():
        abort(404)
    return send_file(str(index))


@desktop_bp.route("/app/health", methods=["GET"])
def health():
    """Report that the server is up and ready to serve the UI.

    Route: ``GET /app/health``

    The desktop shell polls this after spawning the backend and only opens its
    window once it answers, so the user never sees a connection error. It also
    reports whether the interface bundle is present, which lets the shell show a
    precise message instead of a blank page.
    """
    from ._version import __version__

    return {
        "status": "ok",
        "version": __version__,
        "ui_bundled": desktop_ui_available(),
        "desktop_mode": bool(current_app.config.get("DESKTOP_MODE")),
    }
