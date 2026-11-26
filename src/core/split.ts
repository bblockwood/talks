// Beamer second-screen notes (Native §5.1(4)): `\setbeameroption{show notes on second screen=right}`
// puts the slide and a notes panel side by side (or stacked) on every page. The audience gets
// only the slide part; the presenter's notes pane shows the notes part as an image.
import type { NormalizedRect, PageLink } from "./links";

/** Where the notes panel sits on the page. */
export type NotesSplit = "left" | "right" | "top" | "bottom";

const SPLITS: readonly string[] = ["left", "right", "top", "bottom"];

export function parseSplit(value: unknown): NotesSplit | null {
  return typeof value === "string" && SPLITS.includes(value.toLowerCase()) ? (value.toLowerCase() as NotesSplit) : null;
}

/**
 * A guess at the layout, or null when the page looks like an ordinary slide: the page is about
 * twice as wide or twice as tall as a slide. `hint` is pdfpc's notes position when the deck
 * carries one; it picks the side but never forces a split on an ordinary-shaped page.
 */
export function detectSplit(pageWidth: number, pageHeight: number, hint?: string | null): NotesSplit | null {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return null;
  const aspect = pageWidth / pageHeight;
  const hinted = parseSplit(hint);
  if (hinted === "left" || hinted === "right") return aspect > 2.3 ? hinted : null;
  if (hinted === "top" || hinted === "bottom") return aspect < 0.95 ? hinted : null;
  if (aspect > 2.3) return "right"; // 4:3 → 2.67, 16:9 → 3.56
  if (aspect < 0.95) return "bottom"; // 4:3 → 0.67, 16:9 → 0.89
  return null;
}

/**
 * What a deck's settings and files say about the split. A `stored` value comes from the sidecar or
 * `--notes-split` at publish time; the word "none" there turns the heuristic off.
 */
export function chooseSplit(
  stored: string | undefined,
  pdfpcHint: string | null,
  pageWidth: number,
  pageHeight: number,
): NotesSplit | null {
  if (stored !== undefined && stored.toLowerCase() === "none") return null;
  return parseSplit(stored) ?? detectSplit(pageWidth, pageHeight, pdfpcHint);
}

export const FULL_PAGE: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

/** The slide part and the notes part of the page, as fractions of the whole page. */
export function splitRects(split: NotesSplit | null): { slide: NormalizedRect; notes: NormalizedRect | null } {
  switch (split) {
    case "right":
      return { slide: { x: 0, y: 0, width: 0.5, height: 1 }, notes: { x: 0.5, y: 0, width: 0.5, height: 1 } };
    case "left":
      return { slide: { x: 0.5, y: 0, width: 0.5, height: 1 }, notes: { x: 0, y: 0, width: 0.5, height: 1 } };
    case "bottom":
      return { slide: { x: 0, y: 0, width: 1, height: 0.5 }, notes: { x: 0, y: 0.5, width: 1, height: 0.5 } };
    case "top":
      return { slide: { x: 0, y: 0.5, width: 1, height: 0.5 }, notes: { x: 0, y: 0, width: 1, height: 0.5 } };
    default:
      return { slide: FULL_PAGE, notes: null };
  }
}

/**
 * Re-expresses page-relative link rectangles relative to a crop. Links whose centre falls
 * outside the crop keep their place in the list (link indices travel over the relay) but get an
 * empty rectangle, so they can't be hit.
 */
export function cropLinks(links: readonly PageLink[], crop: NormalizedRect): PageLink[] {
  if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) return [...links];
  return links.map((link) => {
    const cx = link.rect.x + link.rect.width / 2;
    const cy = link.rect.y + link.rect.height / 2;
    const inside = cx >= crop.x && cx <= crop.x + crop.width && cy >= crop.y && cy <= crop.y + crop.height;
    const rect: NormalizedRect = inside
      ? {
          x: (link.rect.x - crop.x) / crop.width,
          y: (link.rect.y - crop.y) / crop.height,
          width: link.rect.width / crop.width,
          height: link.rect.height / crop.height,
        }
      : { x: -1, y: -1, width: 0, height: 0 };
    return { rect, action: link.action };
  });
}
