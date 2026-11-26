// Which pages to render ahead (SPEC §6.4, Native §3.3), most urgent first.
import type { FrameIndex } from "./frames";
import { audiencePage, backTarget } from "./session";
import type { SessionState } from "./session";

export function prefetchPages(state: SessionState, frames: FrameIndex): number[] {
  if (frames.pageCount === 0) return [];
  const current = state.committedPage;
  const candidates: (number | null)[] = [
    audiencePage(state), // what is on screen now (differs from `current` when frozen)
    current,
    current + 1,
    current - 1,
    current + 2,
    frames.nextFrameFirstPage(current),
    backTarget(state),
    current - 2,
  ];
  const seen = new Set<number>();
  const pages: number[] = [];
  for (const page of candidates) {
    if (page === null || page < 0 || page >= frames.pageCount || seen.has(page)) continue;
    seen.add(page);
    pages.push(page);
  }
  return pages;
}

/**
 * Which cached pages to drop. `cached` is oldest first. Wanted pages are never dropped; the rest
 * go oldest-first until at most `capacity` remain.
 */
export function evictions(cached: readonly number[], wanted: readonly number[], capacity: number): number[] {
  const keep = new Set(wanted);
  const drop: number[] = [];
  let size = cached.length;
  for (const page of cached) {
    if (size <= capacity) break;
    if (keep.has(page)) continue;
    drop.push(page);
    size -= 1;
  }
  return drop;
}

/**
 * The size, in device pixels, at which a page of `pageWidth`×`pageHeight` (any unit) fits inside
 * a surface, letterboxed or pillarboxed, plus its offset within the surface.
 */
export function fitPage(
  pageWidth: number,
  pageHeight: number,
  surfaceWidth: number,
  surfaceHeight: number,
): { width: number; height: number; x: number; y: number; scale: number } {
  if (pageWidth <= 0 || pageHeight <= 0 || surfaceWidth <= 0 || surfaceHeight <= 0) {
    return { width: 0, height: 0, x: 0, y: 0, scale: 0 };
  }
  const scale = Math.min(surfaceWidth / pageWidth, surfaceHeight / pageHeight);
  const width = Math.min(surfaceWidth, Math.round(pageWidth * scale));
  const height = Math.min(surfaceHeight, Math.round(pageHeight * scale));
  return {
    width,
    height,
    x: Math.floor((surfaceWidth - width) / 2),
    y: Math.floor((surfaceHeight - height) / 2),
    scale,
  };
}
