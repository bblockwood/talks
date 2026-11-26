// Full-text search over the PDF text layer (Native §4.4): case- and diacritic-insensitive
// substring search, hits in page order, grouped by frame in the UI.
import type { FrameIndex } from "./frames";

export interface SearchHit {
  readonly page: number;
  readonly frameIndex: number;
  readonly snippet: string;
}

/** Lowercases and strips diacritics, keeping the string the same length where it can. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function snippet(text: string, start: number, length: number, context = 40): string {
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, start + length + context);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
}

/** `pageTexts[i]` is the text of page i. At most one hit per page, and at most `limit` in all. */
export function searchPages(pageTexts: readonly string[], query: string, frames: FrameIndex, limit = 200): SearchHit[] {
  const needle = fold(query.trim());
  if (needle === "") return [];
  const hits: SearchHit[] = [];
  for (let page = 0; page < Math.min(pageTexts.length, frames.pageCount); page++) {
    const text = pageTexts[page] ?? "";
    const at = fold(text).indexOf(needle);
    if (at < 0) continue;
    hits.push({ page, frameIndex: frames.frameContaining(page)?.index ?? 0, snippet: snippet(text, at, needle.length) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * One hit per frame: its first matching build. A term on every build of a frame would otherwise
 * fill the list with near-identical rows.
 */
export function hitsByFrame(hits: readonly SearchHit[]): SearchHit[] {
  const seen = new Set<number>();
  return hits.filter((h) => (seen.has(h.frameIndex) ? false : (seen.add(h.frameIndex), true)));
}
