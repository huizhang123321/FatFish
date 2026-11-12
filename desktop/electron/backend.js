/**
 * Backend process lifecycle for the desktop shell.
 *
 * The window is only ever pointed at ``http://127.0.0.1:<port>/app/`` and never
 * at ``file://``: same-origin loading keeps the signed session cookie
 * first-party so ``SameSite=Lax`` and the ``connect-src 'self'`` CSP continue to
 * apply unchanged (see ``minimost/desktop.py``).  This module owns everything
 * that has to happen before that URL can be trusted to answer.
 *
 * Responsibilities
 * ----------------
 * * pick a port -- preferring the one used last launch, so the origin stays the
 *   same (see PREFERRED_PORT below for why that matters),
 * * spawn the packaged server (or the source checkout in development) with the
 *   data directory, desktop-mode and plain-HTTP flags the backend expects,
 * * poll ``/app/health`` until it answers, so the user never sees a connection
 *   error page,
 * * tear the whole process tree down on quit (on Windows a plain ``kill()``
 *   leaves the Flask reloader/threads behind, so ``taskkill /T`` is used).
 */

"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/**
 * Port we try first: the same default the server and docs use.
 *
 * The port is not just plumbing. ``localStorage`` is keyed by origin
 * (scheme://host:port), so a launch on a different port is a different origin and
 * the window starts with empty storage: the saved password, the theme, the last
 * channel -- all gone. That is why the last successful port is remembered and
 * tried before anything else, and why the fallback is a small fixed range rather
 * than a random ephemeral port that guarantees a fresh origin every time.
 */
const PREFERRED_PORT = 5000;

/** Stable fallbacks, used in order, when 5000 is taken. */
const FALLBACK_PORTS = [5100, 5101, 5102, 5103, 5104, 5105, 5106, 5107, 5108, 5109];

/** Where the last successful port is remembered, inside the shell's state dir. */
const PORT_MEMORY_FILE = "shell-port.json";

/** How long to wait for ``/app/health`` before giving up, in milliseconds. */
const HEALTH_TIMEOUT_MS = 45000;

/** How long to wait between health probes, in milliseconds. */
const HEALTH_INTERVAL_MS = 200;

/**
 * Ask the OS for an unused TCP port.
 *
 * A daemon is spawned on port 0 and the port the kernel assigned is read back,
 * which is the only reliable way to avoid the race between "is this port free?"
 * and "bind it".
 *
 * Candidates are tried in order; ``0`` means "any free port" and is the last
 * resort, because a random port is a random origin.
 *
 * @param {number[]} candidates Ports to try in order.
 * @returns {Promise<number>} A port that was free a moment ago.
 */
function findFreePort(candidates) {
  const tryBind = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => resolve(null));
      srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        const got = srv.address().port;
        srv.close(() => resolve(got));
      });
    });

  return (async () => {
    for (const port of candidates) {
      const got = await tryBind(port);
      if (got) return got;
    }
    const ephemeral = await tryBind(0);
    return ephemeral || 0;
  })();
}

/** Read the port the last launch actually used, or 0 when there is no record. */
function readRememberedPort(stateDir) {
  if (!stateDir) return 0;
  try {
    const raw = fs.readFileSync(path.join(stateDir, PORT_MEMORY_FILE), "utf8");
    const port = JSON.parse(raw).port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  } catch {
    return 0;
  }
}

/** Remember this launch's port so the next one can reuse the same origin. */
function rememberPort(stateDir, port) {
  if (!stateDir || !port) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, PORT_MEMORY_FILE),
      JSON.stringify({ port, savedAt: new Date().toISOString() }),
      "utf8",
    );
  } catch {
    // Losing this only costs a possibly-different port next launch.
  }
}

/**
 * Locate the server executable to run.
 *
 * Packaged builds ship ``minimost-server.exe`` as an extra resource; a source
 * checkout runs ``python -m minimost`` from the repository instead, which keeps
 * the development loop (edit Python, relaunch) immediate.
 *
 * @param {import('electron').App} electronApp
 * @returns {{command: string, args: string[], cwd: string, env: object, label: string}}
 */
function resolveServerCommand(electronApp) {
  const appRoot = electronApp.getAppPath();

  // Packaged: extraResources puts the backend next to resources/, not inside
  // app.asar, because an asar archive cannot be executed.
  const packagedCandidates = [
    path.join(process.resourcesPath || "", "server", "minimost-server.exe"),
    path.join(process.resourcesPath || "", "server", "minimost-server"),
  ];
  for (const candidate of packagedCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return {
        command: candidate,
        args: [],
        cwd: path.dirname(candidate),
        label: candidate,
      };
    }
  }

  const repoRoot = path.resolve(appRoot, "..");
  const pythonCandidates = [
    process.env.FATFISH_PYTHON,
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, ".venv", "bin", "python"),
    "python",
  ].filter(Boolean);

  const python = pythonCandidates.find(
    (candidate) => candidate === "python" || fs.existsSync(candidate),
  );

  return {
    command: python || "python",
    args: ["-m", "minimost"],
    cwd: repoRoot,
    label: `${python || "python"} -m minimost`,
    env: {
      PYTHONPATH: path.join(repoRoot, "minimost", "src"),
      PYTHONUNBUFFERED: "1",
    },
  };
}

/**
 * Wait until the backend reports healthy.
 *
 * @param {number} port Loopback port the server was told to bind.
 * @param {() => boolean} isStopped Returns true if the child already exited.
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function waitForHealth(port, isStopped) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = "no response";

  while (Date.now() < deadline) {
    if (isStopped()) {
      return { ok: false, detail: "后端进程已退出" };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/app/health`, {
        cache: "no-store",
      });
      if (res.ok) {
        const body = await res.json();
        if (body && body.status === "ok") {
          return { ok: true, detail: JSON.stringify(body) };
        }
        lastError = `health 返回 ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
  }
  return { ok: false, detail: `等待健康检查超时（${lastError}）` };
}

/**
 * Resolve once the child has exited, or after *ms* milliseconds.
 *
 * ``child.exitCode``/``signalCode`` rather than ``child.killed``: the latter only
 * records that ``kill()`` was called, which is exactly the case where the process
 * might still be alive.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} ms
 * @returns {Promise<boolean>} True when the child exited in time.
 */
function settle(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), ms);
    child.once("exit", onExit);
  });
}

/**
 * Ask Windows to kill a process and its whole tree.
 *
 * @param {number} pid
 * @returns {Promise<void>} Resolves whether or not taskkill succeeded.
 */
function runTaskkill(pid) {
  return new Promise((resolve) => {
    execFile(
      "taskkill",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => resolve(),
    );
  });
}

/**
 * Terminate a child process and everything it spawned.
 *
 * Three escalating steps, because none of them is reliable on its own:
 *
 * 1. ``taskkill /T /F`` -- the only one that also reaps grandchildren, and the
 *    normal path on a user's machine. It can be refused when the shell is running
 *    under a restricted token, so its failure must not stop the shutdown.
 * 2. ``SIGTERM`` -- reaches the direct child even when taskkill is denied.
 * 3. ``SIGKILL`` -- last resort for a wedged interpreter.
 *
 * Every step waits for the exit event before giving up, so ``app.exit()`` is only
 * called once the server really is gone and cannot leave an orphan holding the
 * SQLite files.
 *
 * @param {import('node:child_process').ChildProcess|null} child
 * @returns {Promise<void>}
 */
async function terminateTree(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32" && child.pid) {
    await runTaskkill(child.pid);
    if (await settle(child, 6000)) return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  if (await settle(child, 4000)) return;

  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await settle(child, 4000);
}

/**
 * Build the complete launch description for the backend.
 *
 * Pure on purpose: the command, arguments and environment are the parts most
 * likely to be wrong and the hardest to eyeball inside a running Electron app, so
 * they are computed here and asserted by ``scripts/backend-selftest.js`` without
 * spawning anything.
 *
 * @param {import('electron').App} electronApp
 * @param {number} port Loopback port the server must bind.
 * @param {string} dataDir Directory the server keeps all state in.
 * @returns {{
 *   command: string,
 *   args: string[],
 *   cwd: string,
 *   env: Record<string, string>,
 *   label: string,
 * }}
 */
function buildLaunchSpec(electronApp, port, dataDir) {
  const resolved = resolveServerCommand(electronApp);

  const env = {
    ...process.env,
    ...(resolved.env || {}),
    // Everything mutable lives under the user's own profile, never in the
    // install directory: an installed app under Program Files is read-only, and
    // a frozen bundle's own directory is deleted when the process exits.
    MINIMOST_DATA_DIR: dataDir,
    // Turns on the desktop-only rules in the backend (currently: no outbound
    // link-preview fetches, so the app really is offline).
    MINIMOST_DESKTOP: "1",
    // Loopback plain HTTP. Chromium treats http://127.0.0.1 as a secure
    // context, so camera/microphone keep working without shipping a
    // self-signed CA the user would have to trust.
    MINIMOST_SKIP_TLS: "1",
  };

  // Both entry points -- the frozen server executable and ``python -m minimost``
  // -- accept the same two flags.
  const args = [...resolved.args, "--host", "127.0.0.1", "--port", String(port)];

  return {
    command: resolved.command,
    args,
    cwd: resolved.cwd,
    env,
    label: resolved.label,
  };
}

/**
 * Owns the local backend subprocess for the lifetime of the window.
 */
class Backend {
  /**
   * @param {object} options
   * @param {string} options.dataDir Directory the server keeps all state in.
   * @param {string} [options.stateDir] Directory for shell state (remembered port).
   * @param {(line: string) => void} [options.onLog] Receives stderr/stdout lines.
   */
  constructor({ dataDir, stateDir, onLog }) {
    this.dataDir = dataDir;
    this.stateDir = stateDir || "";
    this.onLog = onLog || (() => {});
    this.child = null;
    this.port = 0;
    this.recentOutput = [];
  }

  /** Remember the tail of the server's output so a failed start can be shown. */
  _record(stream, chunk) {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.recentOutput.push(`[${stream}] ${line}`);
      if (this.recentOutput.length > 40) this.recentOutput.shift();
      this.onLog(line);
    }
  }

  /**
   * Spawn the server and wait until it answers its health check.
   *
   * @param {import('electron').App} electronApp
   * @returns {Promise<{ok: boolean, port: number, detail: string}>}
   */
  async start(electronApp) {
    // The last port first: reusing it keeps the origin (and therefore the saved
    // password, theme and last channel in localStorage) intact across restarts.
    const remembered = readRememberedPort(this.stateDir);
    const candidates = [remembered, PREFERRED_PORT, ...FALLBACK_PORTS].filter(
      (port, index, all) => port > 0 && all.indexOf(port) === index,
    );
    this.port = await findFreePort(candidates);

    fs.mkdirSync(this.dataDir, { recursive: true });

    const spec = buildLaunchSpec(electronApp, this.port, this.dataDir);

    this.child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this._record("out", chunk));
    this.child.stderr.on("data", (chunk) => this._record("err", chunk));

    const exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    this._exitPromise = exitPromise;
    exitPromise.then(({ code, signal }) => {
      if (this.child && this.child.exitCode !== null) {
        this.onLog(`server exited code=${code} signal=${signal}`);
      }
    });

    let stopped = false;
    exitPromise.then(() => {
      stopped = true;
    });

    const health = await waitForHealth(this.port, () => stopped);
    if (!health.ok) {
      const tail = this.recentOutput.slice(-12).join("\n");
      await this.stop();
      return {
        ok: false,
        port: this.port,
        detail: `${health.detail}\n\n启动命令：${spec.label}\n\n${tail}`,
      };
    }
    this.onLog(`backend ready on port ${this.port} (${spec.label})`);
    // Only remember a port that actually worked, so a failed launch does not pin
    // the next one to a broken choice.
    rememberPort(this.stateDir, this.port);
    return { ok: true, port: this.port, detail: health.detail };
  }

  /** Stop the backend if it is running. */
  async stop() {
    await terminateTree(this.child);
    this.child = null;
  }
}

module.exports = {
  Backend,
  buildLaunchSpec,
  findFreePort,
  readRememberedPort,
  rememberPort,
  PREFERRED_PORT,
  FALLBACK_PORTS,
  findFreePort,
  resolveServerCommand,
  terminateTree,
  HEALTH_TIMEOUT_MS,
};
