import { useSyncExternalStore } from "react";
// Skin = the look (fonts, palette, radii), independent of light/dark. index.html applies the saved
// skin before first paint with the same key; this module switches it at runtime.
export const SKINS = ["griffin", "karsara"];
const KEY = "griffin.skin";

export function readSkin() {
  try {
    const value = localStorage.getItem(KEY);
    return SKINS.includes(value) ? value : "griffin";
  } catch {
    return "griffin";
  }
}

export function applySkin(skin) {
  const value = SKINS.includes(skin) ? skin : "griffin";
  document.documentElement.dataset.skin = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // storage unavailable: the skin lasts for this page only
  }
  return value;
}

// The current skin for components whose markup differs under a skin: re-renders when <html
// data-skin> changes (Settings → «ظاهر»).

const currentSkin = () => (typeof document === "undefined" ? "griffin" : document.documentElement.dataset.skin || "griffin");
function subscribeSkin(onChange) {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => observer.disconnect();
}

export function useSkin() {
  return useSyncExternalStore(subscribeSkin, currentSkin, () => "griffin");
}
