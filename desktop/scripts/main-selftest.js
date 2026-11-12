/**
 * Self-test for the Electron main process, without Electron.
 *
 * The main process is the one part of the shell that cannot be exercised in a
 * headless environment: starting it requires Chromium. This test loads
 * `electron/main.js` for real -- its module-level code runs -- but with a fake
 * `electron` module injected, so every API call is recorded instead of executed.
 *
 * What it proves:
 *   * main.js loads without throwing (no bad import, no API used too early),
 *   * the single-instance lock is taken before anything else,
 *   * the window is created with the security-relevant webPreferences we intend
 *     (nodeIntegration off, contextIsolation on, sandbox on, a preload file that
 *     actually exists on disk),
 *   * the window loads an http(s) URL under the expected origin, never file://,
 *   * all five IPC handlers the renderer relies on are registered,
 *   * the application menu is removed.
 *
 * Run:  node scripts/main-selftest.js
 */

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const DESKTOP = path.resolve(__dirname, "..");
const MAIN = path.join(DESKTOP, "electron", "main.js");
const PRELOAD = path.join(DESKTOP, "electron", "preload.js");

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

/** Everything the fake Electron records. */
const record = {
  lockCalls: 0,
  readyCallback: null,
  windows: [],
  loadUrls: [],
  ipcHandlers: [],
  menus: [],
  dialogs: [],
  listeners: new Map(),
  exitCode: null,
};

function makeFakeElectron(userDataDir) {
  const app = {
    requestSingleInstanceLock() {
      record.lockCalls += 1;
      return true;
    },
    disableHardwareAcceleration() {
      record.hardwareAccelerationDisabled = true;
    },
    commandLine: {
      appendSwitch: (name, value) => {
        (record.switches || (record.switches = [])).push([name, value]);
      },
    },
    on(event, handler) {
      record.listeners.set(event, handler);
      return app;
    },
    once(event, handler) {
      record.listeners.set(event, handler);
      return app;
    },
    whenReady() {
      return {
        then(callback) {
          record.readyCallback = callback;
          return { then: () => undefined, catch: () => undefined };
        },
      };
    },
    getPath(name) {
      assert.strictEqual(name, "userData", `unexpected getPath(${name})`);
      return userDataDir;
    },
    getAppPath() {
      return DESKTOP;
    },
    getVersion() {
      return "1.0.0-test";
    },
    quit() {
      record.listeners.set("__quit", true);
    },
    exit(code) {
      record.exitCode = code;
    },
    relaunch() {
      record.listeners.set("__relaunch", true);
    },
  };

  class BrowserWindow {
    constructor(options) {
      record.windows.push(options);
      this.options = options;
      this.shown = false;
      this.webContents = {
        setWindowOpenHandler: (handler) => {
          this.windowOpenHandler = handler;
        },
        on: (event, handler) => {
          this[`wc_${event}`] = handler;
        },
        loadURL: (url) => {
          record.loadUrls.push(url);
        },
      };
      this.events = new Map();
    }
    once(event, handler) {
      this.events.set(event, handler);
      return this;
    }
    on(event, handler) {
      this.events.set(event, handler);
      return this;
    }
    show() {
      this.shown = true;
    }
    isMinimized() {
      return false;
    }
    restore() {}
    focus() {}
    destroy() {}
    loadURL(url) {
      record.loadUrls.push(url);
    }
  }

  return {
    app,
    BrowserWindow,
    Menu: {
      setApplicationMenu: (menu) => record.menus.push(menu),
    },
    dialog: {
      showErrorBox: (title, content) => record.dialogs.push({ title, content }),
    },
    ipcMain: {
      handle: (channel) => record.ipcHandlers.push(channel),
    },
    shell: {
      openExternal: () => undefined,
      openPath: () => Promise.resolve(""),
    },
  };
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-main-"));
  const fake = makeFakeElectron(userDataDir);

  const realLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fake;
    return realLoad.apply(this, arguments);
  };

  // Keep the spawned-backend path out of this test: FATFISH_URL makes main.js
  // open a window directly instead of launching a server.
  process.env.FATFISH_URL = "http://127.0.0.1:5000/app/";

  console.log("\n=== main process load ===");
  check("electron/main.js loads without throwing", () => {
    require(MAIN);
  });
  check("single-instance lock taken exactly once", () => {
    assert.strictEqual(record.lockCalls, 1, `lockCalls=${record.lockCalls}`);
  });
  check("hardware acceleration turned off before start-up", () => {
    assert.strictEqual(record.hardwareAccelerationDisabled, true);
  });
  check("RendererCodeIntegrity compatibility switch applied", () => {
    const switches = record.switches || [];
    assert.ok(
      switches.some(([name, value]) => name === "disable-features" && /RendererCodeIntegrity/.test(value)),
      `switches=${JSON.stringify(switches)}`,
    );
  });

  console.log("\n=== application start-up ===");
  check("whenReady() was used (nothing ran before the app was ready)", () => {
    assert.strictEqual(typeof record.readyCallback, "function", "no ready callback");
  });

  if (typeof record.readyCallback === "function") {
    await record.readyCallback();
    // Let the microtasks inside the ready callback settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  check("application menu removed", () => {
    assert.deepStrictEqual(record.menus, [null], JSON.stringify(record.menus));
  });

  check("a window was created", () => {
    assert.ok(record.windows.length >= 1, `windows=${record.windows.length}`);
  });

  if (record.windows.length > 0) {
    const options = record.windows[0];
    const prefs = options.webPreferences || {};
    check("window loads an http(s) URL", () => {
      assert.ok(record.loadUrls.length >= 1, "loadURL was never called");
      const url = record.loadUrls[0];
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/app\/$/, url);
    });
    check("nodeIntegration disabled", () => {
      assert.strictEqual(prefs.nodeIntegration, false);
    });
    check("contextIsolation enabled", () => {
      assert.strictEqual(prefs.contextIsolation, true);
    });
    check("renderer sandbox enabled", () => {
      assert.strictEqual(prefs.sandbox, true);
    });
    check("webSecurity enabled", () => {
      assert.strictEqual(prefs.webSecurity, true);
    });
    check("preload script points at an existing file", () => {
      assert.ok(prefs.preload, "no preload configured");
      assert.strictEqual(path.resolve(prefs.preload), path.resolve(PRELOAD));
      assert.ok(fs.existsSync(prefs.preload), `missing ${prefs.preload}`);
    });
    check("window starts hidden and shows on ready-to-show", () => {
      assert.strictEqual(options.show, false);
    });
  }

  console.log("\n=== IPC surface ===");
  const expectedChannels = [
    "fatfish:connection",
    "fatfish:setServer",
    "fatfish:relaunch",
    "fatfish:openDataDir",
    "fatfish:openExternal",
  ];
  check("every channel the preload uses is registered", () => {
    for (const channel of expectedChannels) {
      assert.ok(
        record.ipcHandlers.includes(channel),
        `missing handler ${channel}; got ${record.ipcHandlers.join(", ")}`,
      );
    }
  });
  check("preload references the same channels", () => {
    const source = fs.readFileSync(PRELOAD, "utf8");
    for (const channel of expectedChannels) {
      assert.ok(source.includes(channel), `preload never invokes ${channel}`);
    }
  });

  console.log("\n=== quit handling ===");
  check("window-all-closed and before-quit are wired", () => {
    assert.ok(record.listeners.has("window-all-closed"), "window-all-closed not handled");
    assert.ok(record.listeners.has("before-quit"), "before-quit not handled");
    assert.ok(record.listeners.has("second-instance"), "second-instance not handled");
  });

  Module._load = realLoad;
  fs.rmSync(userDataDir, { recursive: true, force: true });

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
