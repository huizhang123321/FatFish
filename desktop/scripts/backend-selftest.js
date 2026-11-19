/**
 * Self-test for the desktop shell's backend wiring.
 *
 * Runs under plain Node (no Electron): the parts of `electron/backend.js` that
 * decide *what* to launch, *where*, and *with which environment* are pure
 * functions, so they can be asserted directly. That matters because those values
 * are almost impossible to inspect inside a running Electron app, and getting one
 * of them wrong shows up only as a generic "无法启动本地服务" dialog.
 *
 * What is covered:
 *   * port selection never hands back a busy port,
 *   * the development layout resolves to `python -m minimost` in the repo root
 *     with the data-directory / desktop-mode / plain-HTTP flags set,
 *   * the packaged layout prefers `resources/server/minimost-server.exe` and does
 *     not pass `-m`,
 *   * the health-check URL the shell polls is the one the server actually serves.
 *
 * Spawning the real process is deliberately NOT done here: that path is covered
 * end-to-end by `verify_packaged_server.py`, which launches the frozen executable
 * and drives it over HTTP.
 *
 * Usage:  node scripts/backend-selftest.js
 * Exit 0 = every assertion passed.
 */

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildLaunchSpec, findFreePort, resolveServerCommand } = require("../electron/backend.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "desktop");

const passed = [];
const failed = [];

function check(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed.push([name, err.message]);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed.push(name);
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed.push([name, err.message]);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

/** The only part of Electron's App object these functions touch. */
function fakeApp(appPath) {
  return { getAppPath: () => appPath };
}

async function main() {
  console.log("\n=== port selection ===");
  await checkAsync("findFreePort(0) returns a usable port", async () => {
    const port = await findFreePort(0);
    assert.ok(Number.isInteger(port) && port > 0, `unexpected port ${port}`);
  });

  await checkAsync("a busy preferred port falls back to another one", async () => {
    const net = require("node:net");
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen({ port: 0, host: "127.0.0.1" }, resolve));
    const busy = blocker.address().port;
    try {
      const port = await findFreePort(busy);
      assert.notStrictEqual(port, busy, "handed back the port that is in use");
      assert.ok(port > 0);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  console.log("\n=== development layout ===");
  const devSpec = buildLaunchSpec(fakeApp(DESKTOP_DIR), 5000, "C:/data/debug");
  check("resolves a python interpreter", () => {
    assert.match(devSpec.command, /python(\.exe)?$/i, devSpec.command);
  });
  check("runs the minimost module", () => {
    assert.deepStrictEqual(
      devSpec.args.slice(0, 2),
      ["-m", "minimost"],
      JSON.stringify(devSpec.args),
    );
  });
  check("passes host and port", () => {
    const hostAt = devSpec.args.indexOf("--host");
    const portAt = devSpec.args.indexOf("--port");
    assert.ok(hostAt >= 0 && portAt >= 0, JSON.stringify(devSpec.args));
    assert.strictEqual(devSpec.args[hostAt + 1], "127.0.0.1");
    assert.strictEqual(devSpec.args[portAt + 1], "5000");
  });
  check("runs from the repository root", () => {
    assert.strictEqual(path.resolve(devSpec.cwd), REPO_ROOT, devSpec.cwd);
  });
  check("puts the source tree on PYTHONPATH", () => {
    assert.strictEqual(
      path.resolve(devSpec.env.PYTHONPATH),
      path.join(REPO_ROOT, "minimost", "src"),
      devSpec.env.PYTHONPATH,
    );
  });
  check("enables desktop mode", () => {
    assert.strictEqual(devSpec.env.MINIMOST_DESKTOP, "1");
  });
  check("forces plain loopback HTTP", () => {
    assert.strictEqual(devSpec.env.MINIMOST_SKIP_TLS, "1");
  });
  check("points the data directory at the caller's choice", () => {
    assert.strictEqual(devSpec.env.MINIMOST_DATA_DIR, "C:/data/debug");
  });

  console.log("\n=== packaged layout ===");
  // Simulate an install: resources/server/minimost-server.exe
  const fakeResources = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-pack-"));
  const serverDir = path.join(fakeResources, "server");
  fs.mkdirSync(serverDir, { recursive: true });
  const fakeExe = path.join(serverDir, "minimost-server.exe");
  fs.writeFileSync(fakeExe, "");

  const previousResources = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", {
    value: fakeResources,
    configurable: true,
    writable: true,
  });

  try {
    const packagedApp = fakeApp(path.join(fakeResources, "app.asar"));
    const resolved = resolveServerCommand(packagedApp);
    check("finds the bundled server executable", () => {
      assert.strictEqual(resolved.command, fakeExe, resolved.command);
    });

    const packagedSpec = buildLaunchSpec(packagedApp, 6100, "C:/Users/x/AppData/Roaming/FatFish/data");
    check("does not pass -m to the frozen executable", () => {
      assert.ok(!packagedSpec.args.includes("-m"), JSON.stringify(packagedSpec.args));
    });
    check("still passes host and port", () => {
      assert.deepStrictEqual(packagedSpec.args, ["--host", "127.0.0.1", "--port", "6100"]);
    });
    check("runs the executable from its own directory", () => {
      assert.strictEqual(path.resolve(packagedSpec.cwd), path.resolve(serverDir));
    });
  } finally {
    Object.defineProperty(process, "resourcesPath", {
      value: previousResources,
      configurable: true,
      writable: true,
    });
    fs.rmSync(fakeResources, { recursive: true, force: true });
  }

  console.log("\n=== health endpoint contract ===");
  check("health URL matches minimost/desktop.py", () => {
    // Guard against the shell polling a path the server does not serve: the
    // route is registered in the Python package, so read it from there.
    const desktopPy = path.join(REPO_ROOT, "minimost", "src", "minimost", "desktop.py");
    const source = fs.readFileSync(desktopPy, "utf8");
    assert.match(source, /@desktop_bp\.route\("\/app\/health"/, "desktop.py has no /app/health route");
    const backendJs = path.join(__dirname, "..", "electron", "backend.js");
    const backendSource = fs.readFileSync(backendJs, "utf8");
    assert.match(backendSource, /\/app\/health/, "backend.js does not poll /app/health");
  });

  console.log("\n" + "=".repeat(60));
  console.log(`PASSED ${passed.length}   FAILED ${failed.length}`);
  for (const [name, detail] of failed) console.log(`  ${name}: ${detail}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
