/**
 * Headless smoke test for the built desktop interface.
 *
 * Loads the real bundle in a real Chromium (Electron) against a real backend and
 * reports what happened, so a bundle that type-checks but blows up at runtime —
 * a missing export, a CSP violation, a fetch that never resolves — is caught
 * without a human clicking around.
 *
 * It asserts the things that would make the app useless if broken:
 *   * the page loads and React actually mounts,
 *   * the login screen renders (its tabs and fields are in the DOM),
 *   * no uncaught page error and no CSP violation was logged,
 *   * the backend answered `GET /csrf-token` from inside the page.
 *
 * Usage:
 *   $env:FATFISH_URL = 'http://127.0.0.1:5099/app/'
 *   npx electron scripts/ui-smoke.js
 * Exit 0 = every check passed.
 */

"use strict";

const { app, BrowserWindow } = require("electron");

const URL_TO_TEST = process.env.FATFISH_URL || "http://127.0.0.1:5000/app/";
const SETTLE_MS = Number(process.env.FATFISH_SMOKE_SETTLE_MS || 3500);
const HARD_TIMEOUT_MS = 60000;

const consoleErrors = [];
const pageErrors = [];
const failedLoads = [];
const failedRequests = [];

function fail(message) {
  console.log(`  FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`  PASS ${message}`);
}

async function run() {
  console.log(`\n=== loading ${URL_TO_TEST} ===`);

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      // Never enable Node in a window that renders remote-ish content; the smoke
      // test must run the page under the same isolation the app uses.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.on("console-message", (event, level, message) => {
    // level: 0 verbose, 1 info, 2 warning, 3 error
    const text = typeof message === "string" ? message : event?.message;
    if (level >= 2 && text) consoleErrors.push(text);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    failedLoads.push(`${code} ${description} ${url}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    pageErrors.push(`renderer gone: ${details.reason}`);
  });
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    failedRequests.push(`${details.error} ${details.url}`);
  });

  try {
    await win.loadURL(URL_TO_TEST);
    pass("page loaded");
  } catch (err) {
    fail(`loadURL threw: ${err && err.message ? err.message : err}`);
  }

  // Give React a moment to mount, fetch /csrf-token and settle.
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  let probe = null;
  try {
    probe = await win.webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById("root");
        const text = (document.body.innerText || "").trim();
        return {
          rootChildren: root ? root.children.length : -1,
          hasLoginTabs: !!document.querySelector(".login-tabs"),
          hasPasswordField: !!document.querySelector('input[type="password"]'),
          hasUsernameField: !!document.querySelector('input:not([type="password"])'),
          hasPrimaryButton: !!document.querySelector(".primary-btn"),
          text: text.slice(0, 600),
          title: document.title,
          csrfFetched: window.__fatfishSmokeCsrf === true,
        };
      })()`,
      true,
    );
  } catch (err) {
    fail(`could not inspect the page: ${err && err.message ? err.message : err}`);
  }

  if (probe) {
    console.log("\n=== page state ===");
    console.log(`  title: ${probe.title}`);
    console.log(`  root children: ${probe.rootChildren}`);
    console.log(`  visible text: ${JSON.stringify(probe.text.slice(0, 300))}`);

    if (probe.rootChildren > 0) pass("React mounted into #root");
    else fail("React did not mount into #root");

    if (probe.hasLoginTabs) pass("login screen rendered (tabs present)");
    else fail("login screen did not render");

    if (probe.hasPasswordField) pass("password field present");
    else fail("password field missing");

    if (probe.hasPrimaryButton) pass("primary action button present");
    else fail("primary action button missing");

    if (/登录|注册/.test(probe.text)) pass("Chinese UI copy rendered");
    else fail("expected Chinese UI copy in the page text");
  }

  console.log("\n=== network + console ===");

  // The interface must reach the backend it was served from.
  let csrfOk = false;
  try {
    const result = await win.webContents.executeJavaScript(
      `fetch("/csrf-token", { credentials: "same-origin" })
         .then(r => r.json())
         .then(d => ({ ok: true, hasToken: typeof d.csrf_token === "string" }))
         .catch(e => ({ ok: false, error: String(e) }))`,
      true,
    );
    csrfOk = Boolean(result && result.ok && result.hasToken);
    if (csrfOk) pass("in-page fetch of /csrf-token succeeded");
    else fail(`in-page /csrf-token failed: ${JSON.stringify(result)}`);
  } catch (err) {
    fail(`in-page fetch threw: ${err && err.message ? err.message : err}`);
  }

  const csp = consoleErrors.filter((line) => /Content Security Policy/i.test(line));
  const realErrors = consoleErrors.filter((line) => !/DevTools|Autofill|third-party cookie/i.test(line));

  if (failedLoads.length === 0) pass("no failed subresource loads");
  else fail(`failed loads: ${failedLoads.join(" | ")}`);

  if (csp.length === 0) pass("no CSP violations");
  else fail(`CSP violations: ${csp.slice(0, 3).join(" | ")}`);

  if (realErrors.length === 0) pass("no console errors");
  else fail(`console errors: ${realErrors.slice(0, 5).join(" | ")}`);

  if (pageErrors.length === 0) pass("renderer stayed alive");
  else fail(`renderer problems: ${pageErrors.join(" | ")}`);

  const unexpectedRequests = failedRequests.filter((line) => !/ERR_ABORTED/.test(line));
  if (unexpectedRequests.length === 0) pass("no failed network requests");
  else fail(`failed requests: ${unexpectedRequests.slice(0, 5).join(" | ")}`);

  win.destroy();
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => {
    console.log("  FAIL hard timeout");
    process.exitCode = 1;
    app.exit(process.exitCode);
  }, HARD_TIMEOUT_MS);

  try {
    await run();
  } catch (err) {
    fail(`unexpected failure: ${err && err.stack ? err.stack : err}`);
  } finally {
    clearTimeout(timer);
  }

  console.log("\n" + "=".repeat(60));
  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
  // Hard exit: a lingering renderer or a service worker would otherwise keep the
  // process alive and hang CI.
  app.exit(process.exitCode || 0);
});
