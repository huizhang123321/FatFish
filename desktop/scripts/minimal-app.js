/**
 * Minimal Electron app used to tell "this machine cannot run Electron" apart
 * from "our application has a bug".
 *
 * It does nothing but create one window. If this shows a window and
 * FatFish.exe does not, the fault is in our main process. If this fails the
 * same way, the environment refuses to start Chromium.
 *
 * Run:
 *   $env:ELECTRON_RUN_AS_NODE = $null
 *   node_modules\electron\dist\electron.exe scripts\minimal-app.js
 */

"use strict";

const { app, BrowserWindow } = require("electron");

const started = Date.now();
console.log("main entry reached");

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  console.log(`app ready after ${Date.now() - started} ms`);

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    title: "electron-minimal-check",
  });

  win.loadURL("data:text/html,<h1 style='font-family:sans-serif'>Electron works</h1>");

  win.webContents.on("did-finish-load", () => {
    console.log("page loaded -> electron is usable here");
    // Leave the window up long enough for the observer to see it.
    setTimeout(() => app.exit(0), 8000);
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("renderer gone:", JSON.stringify(details));
  });
});

process.on("uncaughtException", (err) => {
  console.error("uncaught:", err && err.stack ? err.stack : err);
  app.exit(99);
});

setTimeout(() => {
  console.error("timeout: no window within 25s");
  app.exit(98);
}, 25000);
