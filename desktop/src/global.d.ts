/**
 * Type surface for the bridge the Electron preload script installs.
 *
 * The interface itself lives in ``lib/types`` so nothing has to import from a
 * declaration file; this file only augments ``Window``.
 */

import type { DesktopConnection } from "./lib/types";

export interface FatFishBridge {
  isDesktop: true;
  platform: string;
  getConnection(): Promise<DesktopConnection>;
  setServer(url: string): Promise<{ ok: boolean; mode?: string; error?: string }>;
  relaunch(): Promise<void>;
  openDataDir(): Promise<void>;
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell; undefined in a browser tab. */
    fatfish?: FatFishBridge;
  }
}

export {};
