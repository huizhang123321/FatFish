"use strict";

/**
 * Where the tsnet sidecar lives, in both the packaged app and the source tree.
 *
 * Packaged: ``resources/tsnet/tsnet-sidecar.exe`` (the installer ships it next to
 * app.asar). Development: ``tsnet-sidecar/tsnet-sidecar.exe`` beside the desktop
 * folder, so ``npm start`` finds the same binary the installer would.
 *
 * Kept separate from tsnet.js so the manager stays testable without electron.
 */

const fs = require("node:fs");
const path = require("node:path");

const EXE = process.platform === "win32" ? "tsnet-sidecar.exe" : "tsnet-sidecar";

function candidates() {
  const list = [];
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, "tsnet", EXE));
  // __dirname is <app>/electron inside app.asar; the source tree keeps the Go
  // module one level up from desktop/.
  list.push(path.resolve(__dirname, "..", "..", "tsnet-sidecar", EXE));
  list.push(path.resolve(__dirname, "..", "tsnet", EXE));
  return list;
}

/** First existing candidate, or the packaged location so the error is useful. */
function sidecarPath() {
  for (const candidate of candidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return candidates()[0];
}

module.exports = { sidecarPath };
