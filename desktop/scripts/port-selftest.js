/**
 * Self-test for the shell's port choice.
 *
 * Why this matters: `localStorage` is keyed by origin (scheme://host:port), so a
 * launch on a different port is a different origin and the window starts with no
 * saved password, no theme and no last channel. The shell therefore remembers the
 * port it actually used and tries it first, with a small fixed range of fallbacks
 * instead of a random ephemeral port.
 *
 * Runs without Electron: it exercises the port helpers directly.
 *
 *   node scripts/port-selftest.js
 */

"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  findFreePort,
  readRememberedPort,
  rememberPort,
  PREFERRED_PORT,
  FALLBACK_PORTS,
} = require("../electron/backend.js");

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failures.push([name, err.message]);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

/** Hold a port so the picker has to skip it. */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function release(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fatfish-port-"));
}

async function main() {
  const dir = tempDir();

  await check("no record means 'no preferred port'", () => {
    assert.strictEqual(readRememberedPort(dir), 0);
  });

  await check("a saved port is read back", () => {
    rememberPort(dir, 5103);
    assert.strictEqual(readRememberedPort(dir), 5103);
  });

  await check("a corrupt record is ignored, not fatal", () => {
    fs.writeFileSync(path.join(dir, "shell-port.json"), "{not json", "utf8");
    assert.strictEqual(readRememberedPort(dir), 0);
  });

  await check("an out-of-range record is ignored", () => {
    fs.writeFileSync(path.join(dir, "shell-port.json"), JSON.stringify({ port: 999999 }), "utf8");
    assert.strictEqual(readRememberedPort(dir), 0);
  });

  await check("remembering without a state dir does nothing", () => {
    rememberPort("", 5103);
    assert.strictEqual(readRememberedPort(""), 0);
  });

  await check("the remembered port is preferred when it is free", async () => {
    const port = await findFreePort([5103, PREFERRED_PORT, ...FALLBACK_PORTS]);
    assert.strictEqual(port, 5103, `got ${port}`);
  });

  await check("an occupied remembered port falls through to the next candidate", async () => {
    const blocker = await occupy(5103);
    try {
      const port = await findFreePort([5103, PREFERRED_PORT, ...FALLBACK_PORTS]);
      assert.notStrictEqual(port, 5103, "returned the occupied port");
      assert.ok(port > 0, "no port found");
    } finally {
      await release(blocker);
    }
  });

  await check("candidates are tried in order, not randomly", async () => {
    const [first, second] = FALLBACK_PORTS;
    const blocker = await occupy(first);
    try {
      const port = await findFreePort([first, second]);
      assert.strictEqual(port, second, `got ${port}, expected ${second}`);
    } finally {
      await release(blocker);
    }
  });

  await check("a port is always found even when every candidate is taken", async () => {
    const blockers = [];
    try {
      for (const port of FALLBACK_PORTS.slice(0, 3)) {
        blockers.push(await occupy(port));
      }
      const port = await findFreePort(FALLBACK_PORTS.slice(0, 3));
      assert.ok(port > 0, "fell back to nothing");
      assert.ok(!FALLBACK_PORTS.slice(0, 3).includes(port), "returned an occupied port");
    } finally {
      for (const srv of blockers) await release(srv);
    }
  });

  fs.rmSync(dir, { recursive: true, force: true });

  console.log("\n" + "=".repeat(60));
  console.log(`PASSED ${passed}   FAILED ${failures.length}`);
  for (const [name, message] of failures) console.log(`  ${name}: ${message}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
