/**
 * Preload bridge.
 *
 * Runs sandboxed, so it may only require Electron's own modules.  Everything the
 * renderer is allowed to ask the shell for is listed here explicitly -- the page
 * never gets Node access, and adding a capability means adding it to this object
 * on purpose.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fatfish", {
  /** True when running inside the desktop shell rather than a browser tab. */
  isDesktop: true,

  platform: process.platform,

  /** Connection information for the running instance. */
  getConnection: () => ipcRenderer.invoke("fatfish:connection"),

  /**
   * Switch between the bundled local server and a server on the LAN.
   *
   * Pass an empty string to go back to local mode.  The change takes effect
   * after the restart the caller triggers with ``relaunch()``.
   */
  setServer: (url) => ipcRenderer.invoke("fatfish:setServer", url),

  /** Restart the application (used after changing the server address). */
  relaunch: () => ipcRenderer.invoke("fatfish:relaunch"),

  /** Open the folder that holds the local database, uploads and avatars. */
  openDataDir: () => ipcRenderer.invoke("fatfish:openDataDir"),

  /** Open an http(s) link in the user's default browser. */
  openExternal: (url) => ipcRenderer.invoke("fatfish:openExternal", url),
});
