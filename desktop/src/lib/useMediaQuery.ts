import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query from React.
 *
 * The initial value is read synchronously so the first render already knows
 * whether this is a phone; waiting for an effect would paint the desktop shell
 * for one frame and then snap it into the mobile layout.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    // Safari/WebView before 14 only has the deprecated listener API.
    media.addListener(update);
    return () => media.removeListener(update);
  }, [query]);

  return matches;
}
