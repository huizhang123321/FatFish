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

/**
 * Apply the theme to the document.
 *
 * Dark is the absence of the attribute rather than `data-theme="dark"`, so the
 * default rules in styles.css are the dark palette and there is exactly one place
 * that defines a second one.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "light") {
    root.dataset.theme = "light";
  } else {
    delete root.dataset.theme;
  }
}
