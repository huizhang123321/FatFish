/**
 * Startup logging for the desktop shell.
 *
 * A packaged Electron app has no console, so anything that goes wrong before the
 * window appears is invisible: the user sees "double-clicked, nothing happened"
 * and there is nothing to look at. This writes the same information to
 * ``%APPDATA%\FatFish\shell.log`` so a failed start can be explained after the
 * fact -- including the case where Chromium never gets far enough to run any
 * JavaScript, in which case the log simply stays empty (its absence is itself the
 * answer).
 *
 * Deliberately synchronous and dependency-free: it has to work as the very first
 * thing the main process does, before Electron's own modules are trusted to load.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Rotate once the file passes this size, so it cannot grow without bound. */
const MAX_BYTES = 512 * 1024;

/** @type {string|null} */
let logFile = null;

/**
 * Point the logger at a file and start a fresh session in it.
 *
 * @param {string} filePath Absolute path of the log file.
 * @returns {boolean} True when the file is writable.
 */
function start(filePath) {
  logFile = filePath;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      size = 0;
    }
    if (size > MAX_BYTES) {
      fs.writeFileSync(filePath, "", "utf8");
    }
    fs.appendFileSync(
      filePath,
      `\n===== shell started ${new Date().toISOString()} =====\n`,
      "utf8",
    );
    return true;
  } catch {
    logFile = null;
    return false;
  }
}

/**
 * Append one line to the log, and mirror it to stdout for development runs.
 *
 * @param {string} message
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      /* logging must never take the app down */
    }
  }
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* no console attached */
  }
}

/**
 * Log an error with its stack.
 *
 * @param {string} context What was being attempted.
 * @param {unknown} error
 */
function error(context, err) {
  const detail = err && err.stack ? err.stack : String(err);
  log(`ERROR ${context}: ${detail}`);
}

/** Path of the log file currently in use (for messages shown to the user). */
function currentFile() {
  return logFile;
}

module.exports = { start, log, error, currentFile };
