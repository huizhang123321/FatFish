import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// The bundle is built straight into the Python package, which is the directory
// minimost/desktop.py serves from (DESKTOP_UI_DIR) and the one PyInstaller and
// the wheel both package. Building there means "npm run build" is the only step
// needed between editing the UI and it being served by the backend.
const OUT_DIR = path.resolve(here, "../minimost/src/minimost/desktop_ui");

/**
 * Backend paths the dev server must forward to Flask.
 *
 * In production the bundle is served BY the backend, so every request is already
 * same-origin. During `npm run dev` the page comes from Vite instead, so these
 * prefixes are proxied to the Flask process to keep cookies, SSE and the login
 * redirect behaving exactly as they do in the shipped app.
 */
const API_PREFIXES = [
  "/app/health",
  "/avatar",
  "/ca.pem",
  "/calls",
  "/channel_members",
  "/channel_unreads",
  "/channels",
  "/csrf-token",
  "/delete",
  "/dms",
  "/edit",
  "/events",
  "/file_preview",
  "/files",
  "/friends",
  "/groups",
  "/last_read",
  "/link_preview",
  "/login",
  "/logout",
  "/mark_read",
  "/mentions",
  "/message",
  "/messages",
  "/messages_before",
  "/online_users",
  "/pin",
  "/pins",
  "/presence",
  "/private_channels",
  "/profile",
  "/react",
  "/read_receipts",
  "/screenshare",
  "/search_messages",
  "/send",
  "/settings",
  "/signup",
  "/typing",
  "/unread_count",
  "/user_avatars",
  "/user_colors",
  "/users",
];

const DEV_BACKEND = process.env.FATFISH_BACKEND ?? "http://127.0.0.1:5000";

const proxy = Object.fromEntries(
  API_PREFIXES.map((prefix) => [prefix, { target: DEV_BACKEND, changeOrigin: false }]),
);

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs so the bundle works regardless of the host prefix it is
  // mounted under; desktop.py serves it from /app/.
  base: "./",
  build: {
    outDir: OUT_DIR,
    emptyOutDir: false,
    // Source maps help debugging a packaged build; they are served only from
    // the loopback server, never published anywhere.
    sourcemap: true,
    target: "chrome128",
    rollupOptions: {
      output: {
        // Deterministic names: no hashed entry point, so index.html stays stable
        // and a stale bookmark or cached shell still resolves.
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
});
