// What kind of device this is, where the page has to behave differently.

/**
 * An iPad or iPhone. Safari's full screen there leaves on any downward swipe and draws its own
 * close button over the page, and neither can be turned off, so neither view uses it (Ben,
 * 2026-11-27). Added to the Home Screen, the page fills the screen anyway.
 */
export const APPLE_TOUCH =
  typeof navigator !== "undefined" && (/iPad|iPhone|iPod/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** A Mac, iPad or iPhone: the keyboard has ⌘ where Windows and Linux use Ctrl. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPad|iPhone|iPod/.test(navigator.platform);

/** How a shortcut with the platform's command key is written: "⌘D" on a Mac, "Ctrl+D" elsewhere. */
export const shortcut = (key: string, mac: boolean = IS_MAC): string => (mac ? `⌘${key}` : `Ctrl+${key}`);

/**
 * While a view of the talk is up, the page behind it is black and can't scroll, so no strip of
 * another colour shows at an edge of the screen and nothing slides under a finger.
 */
export function setStage(on: boolean): void {
  document.documentElement.classList.toggle("presenting", on);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", on ? "#000000" : "#111418");
}
