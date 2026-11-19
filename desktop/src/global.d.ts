/**
 * Type surface for the bridges the Electron preload script and the Android
 * shell install.
 *
 * The interface itself lives in `lib/types` so nothing has to import from a
 * declaration file; this file only augments `Window`.
 */

import type { DesktopConnection, TsnetStatus } from "./lib/types";

export interface FatFishBridge {
  isDesktop: true;
  platform: string;
  getConnection(): Promise<DesktopConnection>;
  setServer(url: string): Promise<{ ok: boolean; mode?: string; error?: string }>;
  relaunch(): Promise<void>;
  openDataDir(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Embedded Tailscale (tsnet). Absent on older shells and in browser mode. */
  tsnet?: {
    status(): Promise<TsnetStatus>;
    start(options: { hostname?: string; authKey?: string; port?: number }): Promise<{ ok: boolean; error?: string; status?: TsnetStatus }>;
    stop(): Promise<{ ok: boolean; status?: TsnetStatus }>;
  };
}

/** The small native surface exposed by the Android WebView shell. */
export interface FatFishAndroidBridge {
  isAndroid: true;
  version: string;
  getServerUrl(): string;
  switchServer(): void;
  setSystemTheme(theme: "light" | "dark"): void;
  openExternal(url: string): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell; undefined in a browser tab. */
    fatfish?: FatFishBridge;
    /** Present only inside the Android shell. */
    fatfishAndroid?: FatFishAndroidBridge;
    /** Android hardware/gesture back calls this; return true when consumed. */
    fatfishAndroidBack?: () => boolean;
  }
}

export {};
