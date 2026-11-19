/**
 * Assert that a built app.asar contains what the shell needs.
 *
 * The packaged main process is the one file that cannot be read as source after
 * packaging, so this reads it straight back out of the archive. Usage:
 *
 *   node scripts/check-asar.js release/win-unpacked/resources/app.asar
 */

"use strict";

const path = require("node:path");
const asar = require("@electron/asar");

const archive = process.argv[2];
if (!archive) {
  console.error("usage: node scripts/check-asar.js <path-to-app.asar>");
  process.exit(2);
}

const files = asar.listPackage(path.resolve(archive));
const main = asar.extractFile(path.resolve(archive), "electron/main.js").toString("utf8");
const logModule = asar.extractFile(path.resolve(archive), "electron/log.js").toString("utf8");

const checks = [
  ["electron/main.js packaged", files.includes("\\electron\\main.js") || files.includes("/electron/main.js")],
  ["electron/backend.js packaged", files.some((f) => /backend\.js$/.test(f))],
  ["electron/preload.js packaged", files.some((f) => /preload\.js$/.test(f))],
  ["electron/log.js packaged", files.some((f) => /log\.js$/.test(f))],
  ["hardware acceleration disabled", main.includes("app.disableHardwareAcceleration()")],
  ["RendererCodeIntegrity overridden", main.includes("RendererCodeIntegrity")],
  ["startup logging wired", main.includes('require("./log")')],
  ["startup log path under userData", main.includes('shell.log')],
  ["logger writes synchronously", logModule.includes("appendFileSync")],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
console.log(`\narchive: ${archive}`);
console.log(`entries: ${files.length}`);
process.exit(failed === 0 ? 0 : 1);
