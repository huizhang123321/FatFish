/**
 * FatFish desktop shell -- Electron main process.
 *
 * The shell is deliberately thin: it starts the local backend, waits until it
 * answers, and then points a plain BrowserWindow at it.  All application logic
 * lives in the React bundle served by the backend, so nothing here has to be
 * duplicated for the browser build.
 *
 * @see ./backend.js for the server process lifecycle.
 */

"use strict";

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { Backend } = require("./backend");
const log = require("./log");

/**
 * Start logging before anything can fail.
 *
 * ``app.getPath('userData')`` is valid this early (it is just
 * ``%APPDATA%\FatFish``), and having the file open means a start-up failure is
 * explained in a file the user can send us instead of being a silent no-op.
 */
const LOG_PATH = path.join(app.getPath("userData"), "shell.log");
log.start(LOG_PATH);
log.log(
  `boot electron=${process.versions.electron} chrome=${process.versions.chrome} ` +
    `node=${process.versions.node} pid=${process.pid}`,
);
log.log(`resourcesPath=${process.resourcesPath} appPath=${app.getAppPath()}`);
log.log(
  `cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(1))} ` +
    `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE || "(unset)"} ` +
    `FATFISH_URL=${process.env.FATFISH_URL || "(unset)"}`,
);

// A crash in the main process must leave a trace, not just a missing window.
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", err);
  try {
    dialog.showErrorBox(
      "FatFish 启动失败",
      `${err && err.message ? err.message : err}\n\n详细信息已写入：\n${LOG_PATH}`,
    );
  } catch {
    /* dialog itself failed; the log still has the record */
  }
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", reason);
});

// ---------------------------------------------------------------------------
// Compatibility switches, applied before Electron initialises anything.
//
// Both address the same class of failure: the process exiting with
// 0x80000003 (STATUS_BREAKPOINT) before a single line of our own code runs,
// which is what a Chromium bootstrap CHECK failure looks like from outside.
//
// * Hardware acceleration off: a chat client has nothing to gain from the GPU,
//   and broken or half-installed graphics drivers are the single most common
//   reason Chromium refuses to start on an otherwise healthy Windows box. This
//   is exactly what the user's machine showed: other GUI apps (including another
//   Electron app) hanging in the event log at the same time.
// * RendererCodeIntegrity off: some endpoint-protection products hook the
//   renderer-creation path hard enough that Chromium aborts. The two renderer
//   processes still run inside the Chromium sandbox with our own CSP and
//   contextIsolation, so this removes a compatibility blocker, not a security
//   boundary.
// ---------------------------------------------------------------------------
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-features", "RendererCodeIntegrity");
log.log("compatibility switches: disableHardwareAcceleration, RendererCodeIntegrity=off");

/** Window geometry. */
const WINDOW = {
  width: 1280,
  height: 820,
  minWidth: 960,
  minHeight: 620,
  backgroundColor: "#10131a",
};

/** Only one copy may run: two of them would fight over the same SQLite files. */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
log.log(`singleInstanceLock=${gotSingleInstanceLock}`);

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** @type {Backend|null} */
let backend = null;

/** Base URL the window is allowed to navigate within. */
let baseUrl = "";

/** Set once shutdown has started, so the async teardown runs exactly once. */
let shuttingDown = false;

/**
 * Read the desktop shell's own configuration (not the server's settings).
 *
 * Kept in Electron's per-user data directory so switching between "run the
 * server here" and "connect to a server on the LAN" survives restarts.
 *
 * @returns {{mode: 'local'|'remote', serverUrl: string}}
 */
function readConfig() {
  const file = path.join(app.getPath("userData"), "desktop-config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      mode: parsed.mode === "remote" ? "remote" : "local",
      serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : "",
    };
  } catch {
    return { mode: "local", serverUrl: "" };
  }
}

/**
 * Persist the shell configuration.
 *
 * @param {{mode: 'local'|'remote', serverUrl: string}} config
 */
function writeConfig(config) {
  const file = path.join(app.getPath("userData"), "desktop-config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

/** Directory holding the local server's SQLite files, uploads and avatars. */
function localDataDir() {
  return path.join(app.getPath("userData"), "data");
}

/**
 * Normalise a user-supplied server address into an origin.
 *
 * Accepts ``192.168.1.20``, ``192.168.1.20:5000``, ``https://host:5000/`` and
 * returns something ``new URL()`` accepts.  HTTPS is assumed by default because
 * that is what a server-mode host serves; loopback defaults to HTTP because the
 * desktop's own backend uses plain HTTP.
 *
 * @param {string} value
 * @returns {string} Origin without a trailing slash, or "" when unusable.
 */
function normaliseServerUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${/^(127\.0\.0\.1|localhost)(:|\/|$)/.test(trimmed) ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * Create the application window and load *targetUrl* once it is ready.
 *
 * @param {string} targetUrl URL to load (always same-origin with the backend).
 */
function createWindow(targetUrl) {
  baseUrl = new URL(targetUrl).origin;

  mainWindow = new BrowserWindow({
    ...WINDOW,
    show: false,
    title: "FatFish",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  // Show only once the first paint is ready: a white flash over a dark UI is
  // the kind of detail that makes an app feel unpolished.
  //
  // A window restored from a previous session can also come back off-screen (a
  // monitor was removed, or the saved position is stale). Those coordinates read
  // as "the window opened but there is nothing to see", so the bounds are pulled
  // back onto the nearest display before it is shown.
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    const b = mainWindow.getBounds();
    const { screen } = require("electron");
    const onScreen = screen.getAllDisplays().some((display) => {
      const w = display.workArea;
      return (
        b.x + b.width > w.x &&
        b.x < w.x + w.width &&
        b.y + b.height > w.y &&
        b.y < w.y + w.height
      );
    });
    if (!onScreen) {
      log.log(`window bounds ${JSON.stringify(b)} were off every display - centring`);
      mainWindow.center();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Keep the window inside our own origin. External links open in the user's
  // real browser instead of navigating the shell away from the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== baseUrl) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    log.log("window closed");
    mainWindow = null;
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log.log(`page loaded: ${targetUrl}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log.log(`did-fail-load code=${code} description=${description} url=${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log.log(`renderer gone: ${JSON.stringify(details)}`);
  });

  log.log(`creating window for ${targetUrl}`);
  mainWindow.loadURL(targetUrl);
}

/**
 * Start the bundled backend and open the window on it, or fail loudly.
 */
async function openLocal() {
  const dataDir = localDataDir();
  log.log(`starting local backend, dataDir=${dataDir}`);
  backend = new Backend({
    dataDir,
    // The shell's own state (the remembered port) lives next to the logs, not in
    // the data directory the server owns.
    stateDir: app.getPath("userData"),
    onLog: (line) => log.log(`server: ${line}`),
  });
  const result = await backend.start(app);
  log.log(`backend start ok=${result.ok} port=${result.port} ${result.detail || ""}`);

  if (!result.ok) {
    dialog.showErrorBox(
      "无法启动本地服务",
      `FatFish 需要一个本地聊天服务进程，但它没有成功启动。\n\n${result.detail}`,
    );
    app.exit(1);
    return;
  }
  createWindow(`http://127.0.0.1:${result.port}/app/`);
}

/**
 * Open the window on a server that is already running elsewhere on the LAN.
 *
 * @param {string} origin Origin such as ``https://192.168.1.20:5000``.
 */
async function openRemote(origin) {
  log.log(`connecting to remote server ${origin}`);
  try {
    const res = await fetch(`${origin}/app/health`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    log.log(`remote server reachable: ${await res.text()}`);
  } catch (err) {
    log.error(`remote server unreachable (${origin})`, err);
    dialog.showErrorBox(
      "无法连接服务器",
      `连不上 ${origin}。\n\n请确认那台机器上的 FatFish 服务端已经启动、` +
        `地址和端口填写正确，并且防火墙放行了该端口。\n\n${err && err.message ? err.message : err}`,
    );
    app.exit(1);
    return;
  }
  createWindow(`${origin}/app/`);
}

/** Wire up the small IPC surface the renderer needs from the shell. */
function registerIpc() {
  ipcMain.handle("fatfish:connection", () => {
    const config = readConfig();
    return {
      mode: config.mode,
      serverUrl: config.serverUrl,
      baseUrl: baseUrl || "http://127.0.0.1:5000",
      dataDir: localDataDir(),
      appVersion: app.getVersion(),
      electron: process.versions.electron,
    };
  });

  ipcMain.handle("fatfish:setServer", (_event, value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) {
      writeConfig({ mode: "local", serverUrl: "" });
      return { ok: true, mode: "local" };
    }
    const origin = normaliseServerUrl(raw);
    if (!origin) {
      return { ok: false, error: "地址格式不正确" };
    }
    writeConfig({ mode: "remote", serverUrl: origin });
    return { ok: true, mode: "remote", serverUrl: origin };
  });

  ipcMain.handle("fatfish:relaunch", () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("fatfish:openDataDir", async () => {
    const dir = localDataDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle("fatfish:openExternal", (_event, url) => {
    if (typeof url === "string" && /^https?:/i.test(url)) shell.openExternal(url);
  });
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  // Clicking the shortcut while the app is already running gets here. Restoring is
  // not enough on Windows: a background process is normally refused the
  // foreground, so the window came back *behind* whatever was on screen and the
  // launch looked like it did nothing at all. Showing, restoring and momentarily
  // forcing top-most is the reliable way to bring it to the front.
  log.log("second-instance: bringing the existing window forward");
  if (!mainWindow.isVisible()) mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.moveTop();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 600);
});

// A second copy must not keep running: it would open its own server on another
// port against the same databases.
if (!gotSingleInstanceLock) {
  // The common cause is a still-running copy; log it so a "nothing happens"
  // launch can be explained instead of guessed at.
  log.log("another instance holds the lock - exiting (this launch shows no window)");
  app.quit();
} else {
  app.whenReady().then(async () => {
    log.log("app ready");
    Menu.setApplicationMenu(null);
    registerIpc();

    // FATFISH_URL lets the renderer be developed against a server started by
    // hand (``python -m minimost``), skipping the spawn-and-wait cycle.
    const forcedUrl = process.env.FATFISH_URL;
    if (forcedUrl) {
      log.log(`FATFISH_URL override -> ${forcedUrl}`);
      createWindow(forcedUrl);
      return;
    }

    const config = readConfig();
    log.log(`mode=${config.mode} serverUrl=${config.serverUrl || "(none)"}`);
    if (config.mode === "remote" && config.serverUrl) {
      await openRemote(config.serverUrl);
    } else {
      await openLocal();
    }
  }).catch((err) => {
    log.error("start-up failed", err);
    try {
      dialog.showErrorBox(
        "FatFish 启动失败",
        `${err && err.message ? err.message : err}\n\n详细信息已写入：\n${LOG_PATH}`,
      );
    } catch {
      /* nothing else we can do */
    }
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    (async () => {
      try {
        if (backend) await backend.stop();
      } finally {
        app.exit(0);
      }
    })();
  });
}
