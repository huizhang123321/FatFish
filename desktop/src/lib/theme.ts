/**
 * Colour theme: dark (the app's own palette) or light.
 *
 * The whole interface is driven by CSS custom properties, so switching themes is
 * one attribute on `<html>` — no component knows which theme is active, and no
 * rule is duplicated per theme.
 *
 * The choice is remembered in `localStorage`. `index.html` also applies it inline
 * before the first paint, because otherwise a light-theme user would see a dark
 * flash on every load; this module then keeps that attribute in sync as the user
 * switches.
 */

export type Theme = "dark" | "light";

const STORAGE_KEY = "fatfish.theme";

/**
 * Read the saved theme.
 *
 * Anything unreadable or unrecognised means dark: that is the palette the app was
 * designed around, and it is the safer default for a dark room.
 */
export function loadTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Persist the choice. Storage can be unavailable (private mode); never throw. */
export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* the theme still applies for this session */
  }
}

/** How long the day↔night cross-fade runs. Matches `.theme-fading` in styles.css. */
export const THEME_FADE_MS = 320;

/** True when the user asked the OS to avoid animations. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Apply the theme to the document.
 *
 * Dark is the absence of the attribute rather than `data-theme="dark"`, so the
 * default rules in styles.css are the dark palette and there is exactly one place
 * that defines a second one.
 *
 * With ``animate`` the colours cross-fade instead of flipping: a ``.theme-fading``
 * class on `<html>` turns on colour transitions for every element (see styles.css),
 * and it is removed once the fade is over so hover states stay instant the rest of
 * the time. A class rather than a permanent transition because a global
 * ``transition: background-color`` makes every hover and list update feel late.
 *
 * ``animate`` is deliberately opt-in: the first paint must not fade in, and a
 * reload should land on the right colours immediately.
 */
export function applyTheme(theme: Theme, options: { animate?: boolean } = {}): void {
  const root = document.documentElement;
  const animate = options.animate === true && !prefersReducedMotion();

  if (animate) {
    root.classList.add("theme-fading");
    // Force a style recalculation so the transition is armed *before* the colours
    // change; without it the browser batches both edits and nothing animates.
    void root.offsetWidth;
  }

  if (theme === "light") {
    root.dataset.theme = "light";
  } else {
    delete root.dataset.theme;
  }

  if (animate) {
    window.setTimeout(() => root.classList.remove("theme-fading"), THEME_FADE_MS + 80);
  }
}

