"use strict";

/**
 * Owns the tsnet sidecar: the Go process that puts this machine on a Tailscale
 * network without installing the Tailscale client.
 *
 * Why a sidecar at all: `tsnet` is a Go library, and the FatFish server is Python.
 * Rather than bolt a Go runtime into the Python app, this process keeps the
 * Tailscale identity while the Flask server keeps binding 127.0.0.1 only -- nothing
 * is exposed to the LAN, and the only way in is the tailnet, which is already
 * encrypted and subject to the tailnet's ACLs.
 *
 * The sidecar writes a status JSON file next to its state; this module reads that
 * file rather than parsing logs, so the UI always has structured data (state,
 * login URL, tailnet address, connection count) and no scraping is involved.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** States the sidecar reports, plus "off" when we never started it. */
const STATES = ["off", "starting", "login_required", "running", "stopped", "error"];

class TsnetManager {
  /**
   * @param {object} options
   * @param {string} options.stateDir  where the node keeps its identity
   * @param {string} options.sidecarPath  the tsnet-sidecar executable
   * @param {(line: string) => void} [options.onLog]
   */
  constructor({ stateDir, sidecarPath, onLog }) {
    this.stateDir = stateDir;
    this.sidecarPath = sidecarPath;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.lastError = "";
    this.statusFile = path.join(stateDir, "tsnet-status.json");
    this.logFile = path.join(stateDir, "tsnet.log");
  }

  /** Is the sidecar binary present? The UI hides the section when it is not. */
  available() {
    try {
      return fs.existsSync(this.sidecarPath);
    } catch {
      return false;
    }
  }

  /**
   * Current state, merged with what we know about the process itself.
   *
   * The file can lag behind reality (the sidecar may have been killed by hand),
   * so `running` is only reported as running when our child is still alive; the
   * rest of the fields still come from the file.
   */
  status() {
    const base = {
      available: this.available(),
      state: "off",
      running: false,
      hostname: "",
      port: 80,
      target: "",
      login_url: "",
      url: "",
      addresses: [],
      connections: 0,
      error: "",
      log_tail: [],
      path: this.sidecarPath,
      state_dir: this.stateDir,
    };

    let fromFile = {};
    try {
      fromFile = JSON.parse(fs.readFileSync(this.statusFile, "utf8"));
    } catch {
      fromFile = {};
    }

    const alive = Boolean(this.child && this.child.exitCode === null && !this.child.killed);
    const merged = { ...base, ...fromFile, running: alive };
    if (!STATES.includes(merged.state)) merged.state = "unknown";

    // A stale "running" from the file with no live process means it was stopped
    // outside the app (Task Manager, a crash): say so instead of pretending.
    if (!alive && merged.state === "running") merged.state = "stopped";
    if (!alive && this.lastError) merged.error = this.lastError;

    try {
      const text = fs.readFileSync(this.logFile, "utf8");
      merged.log_tail = text.split(/\r?\n/).filter(Boolean).slice(-40);
    } catch {
      merged.log_tail = [];
    }
    return merged;
  }

  /**
   * Start the sidecar.
   *
   * @param {object} options
   * @param {string} [options.hostname] name on the tailnet
   * @param {string} [options.authKey] pre-authorised key; empty for interactive login
   * @param {number} [options.port] port to listen on inside the tailnet
   * @param {string} options.target  local server, e.g. 127.0.0.1:5100
   */
  start({ hostname, authKey, port, target }) {
    if (this.child && this.child.exitCode === null) {
      return { ok: true, already: true, status: this.status() };
    }
    if (!this.available()) {
      return { ok: false, error: "没有找到 tsnet-sidecar，安装包里缺少该组件" };
    }
    fs.mkdirSync(this.stateDir, { recursive: true });

    const args = [
      "--state",
      this.stateDir,
      "--hostname",
      String(hostname || "fatfish"),
      "--port",
      String(port || 80),
      "--target",
      String(target || "127.0.0.1:5100"),
      "--status",
      this.statusFile,
    ];
    // The key goes through the environment, not argv: argv is visible to every
    // user on the machine through the process list.
    const env = { ...process.env, TS_AUTHKEY: String(authKey || "") };

    this.lastError = "";
    this.child = spawn(this.sidecarPath, args, {
      cwd: this.stateDir,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pipe = (stream) => {
      stream.on("data", (chunk) => {
        String(chunk)
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((line) => this.onLog(`tsnet: ${line}`));
      });
    };
    pipe(this.child.stdout);
    pipe(this.child.stderr);

    this.child.on("error", (err) => {
      this.lastError = String(err && err.message ? err.message : err);
      this.onLog(`tsnet: spawn error: ${this.lastError}`);
    });
    this.child.on("exit", (code, signal) => {
      this.onLog(`tsnet: exited code=${code} signal=${signal}`);
    });

    return { ok: true, status: this.status() };
  }

  /** Stop the sidecar. The node stays registered in the tailnet. */
  stop() {
    if (!this.child || this.child.exitCode !== null) {
      this.child = null;
      return { ok: true, status: this.status() };
    }
    const child = this.child;
    try {
      child.kill();
    } catch (err) {
      this.lastError = String(err);
    }
    this.child = null;
    return { ok: true, status: this.status() };
  }
}

module.exports = { TsnetManager };
