/**
 * "记住密码": the credentials used to re-establish a session automatically.
 *
 * Why this exists
 * ---------------
 * The server ends a session after 15 minutes of inactivity (a STIG control, see
 * `SESSION_IDLE_SECONDS`). For a single-user desktop app that means being asked to
 * type a 15-character password again several times an hour, which is exactly the
 * kind of friction that makes people pick a short password. Remembering the
 * credentials locally and silently re-authenticating is the smaller evil.
 *
 * Security posture -- stated plainly, because it drives the UI wording
 * ----------------------------------------------------------------
 * This is **not encryption**. The value sits in `localStorage` for the app's
 * origin, readable by anything that can run script on that origin or read this
 * machine's profile. It is offered because the alternative on this machine is a
 * password in a sticky note. The login screen says so, and there is a one-click
 * way to forget it.
 *
 * Only the password that the server accepts is stored; a failed auto-login clears
 * it, so a changed password never leaves a stale secret behind.
 */

/** What we persist. */
export interface SavedCredentials {
  username: string;
  password: string;
}

const STORAGE_KEY = "fatfish.credentials";

/**
 * Set for the lifetime of the page when the user logs out on purpose.
 *
 * Without it, "退出登录" would be pointless: the next re-render would immediately
 * sign the user back in from storage. It is deliberately not persisted -- a real
 * restart should auto-login again.
 */
let autoLoginSuppressed = false;

/** True when an explicit logout has happened in this page session. */
export function isAutoLoginSuppressed(): boolean {
  return autoLoginSuppressed;
}

/** Suppress (or re-allow) auto-login for the rest of this page session. */
export function setAutoLoginSuppressed(value: boolean): void {
  autoLoginSuppressed = value;
}

/** Read the saved credentials, or null when nothing usable is stored. */
export function loadCredentials(): SavedCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedCredentials>;
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
      return null;
    }
    if (!parsed.username || !parsed.password) return null;
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

/** Remember credentials (called only after the server accepted them). */
export function saveCredentials(credentials: SavedCredentials): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    /* storage unavailable: the session still works, it just is not remembered */
  }
}

/** Forget them. Safe to call when nothing is stored. */
export function clearCredentials(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
