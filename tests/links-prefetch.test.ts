import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { hitTest, isNavigational, linkFromRaw, namedAction } from "../src/core/links";
import { evictions, fitPage, prefetchPages } from "../src/core/prefetch";
import { initialState } from "../src/core/session";
import type { SessionState } from "../src/core/session";
import { labelsFor } from "./frames.test";

describe("links", () => {
  const rect = { x: 0.2, y: 0.4, width: 0.2, height: 0.1 };

  it("maps PDF named actions", () => {
    expect(namedAction("NextPage")).toBe("nextPage");
    expect(namedAction("PrevPage")).toBe("previousPage");
    expect(namedAction("GoBack")).toBe("goBack");
    expect(namedAction("Find")).toBe("other");
    expect(namedAction("toString")).toBe("other");
  });

  it("prefers a resolved destination, then a named action, then a URL", () => {
    expect(linkFromRaw({ rect, destPage: 3, url: "https://x.example" }).action).toEqual({ kind: "goToPage", page: 3 });
    expect(linkFromRaw({ rect, destPage: null, namedAction: "LastPage" }).action).toEqual({ kind: "named", action: "lastPage" });
    expect(linkFromRaw({ rect, url: "https://x.example" }).action).toEqual({ kind: "uri", url: "https://x.example" });
    expect(linkFromRaw({ rect }).action).toEqual({ kind: "unsupported" });
    expect(linkFromRaw({ rect, destPage: -1 }).action).toEqual({ kind: "unsupported" });
  });

  it("only GoTo and known named actions are navigational", () => {
    expect(isNavigational(linkFromRaw({ rect, destPage: 0 }))).toBe(true);
    expect(isNavigational(linkFromRaw({ rect, namedAction: "GoBack" }))).toBe(true);
    expect(isNavigational(linkFromRaw({ rect, namedAction: "Find" }))).toBe(false);
    expect(isNavigational(linkFromRaw({ rect, url: "https://x.example" }))).toBe(false);
  });

  it("hit-tests in normalised coordinates, topmost link first, skipping inert links", () => {
    const links = [
      linkFromRaw({ rect, destPage: 1 }),
      linkFromRaw({ rect: { x: 0.3, y: 0.4, width: 0.3, height: 0.1 }, destPage: 2 }),
      linkFromRaw({ rect: { x: 0, y: 0, width: 1, height: 1 }, url: "https://x.example" }),
    ];
    expect(hitTest(links, 0.25, 0.45)).toBe(0);
    expect(hitTest(links, 0.35, 0.45)).toBe(1);
    expect(hitTest(links, 0.9, 0.9)).toBe(-1);
    expect(hitTest([], 0.5, 0.5)).toBe(-1);
  });
});

describe("prefetchPages", () => {
  const frames = new FrameIndex(labelsFor([1, 3, 4, 3, 2, 1, 3, 5, 1]));
  const at = (page: number, extra: Partial<SessionState> = {}): SessionState => ({
    ...initialState,
    committedPage: page,
    ...extra,
  });

  it("puts the page on screen first, then neighbours, next frame and back target", () => {
    // Page 5 is build 2 of frame 3 (pages 4–7); the next frame starts at 8.
    expect(prefetchPages(at(5, { history: [20] }), frames)).toEqual([5, 6, 4, 7, 8, 20, 3]);
  });

  it("stays inside the deck and has no duplicates", () => {
    expect(prefetchPages(at(0), frames)).toEqual([0, 1, 2]);
    expect(prefetchPages(at(22), frames)).toEqual([22, 21, 20]);
  });

  it("when frozen, the frozen page comes first", () => {
    expect(prefetchPages(at(10, { audienceMode: { kind: "frozen", page: 2 } }), frames)[0]).toBe(2);
  });

  it("is empty for an empty deck", () => {
    expect(prefetchPages(initialState, new FrameIndex([]))).toEqual([]);
  });
});

describe("evictions", () => {
  it("drops the oldest unwanted pages down to capacity", () => {
    expect(evictions([1, 2, 3, 4, 5], [4, 5], 3)).toEqual([1, 2]);
  });
  it("never drops wanted pages, even over capacity", () => {
    expect(evictions([1, 2, 3], [1, 2, 3], 1)).toEqual([]);
    expect(evictions([1, 2, 3, 4], [1, 3], 1)).toEqual([2, 4]);
  });
  it("does nothing under capacity", () => {
    expect(evictions([1, 2], [], 12)).toEqual([]);
  });
});

describe("fitPage", () => {
  it("pillarboxes a 4:3 page on a 16:9 surface", () => {
    expect(fitPage(362.8, 272.1, 1920, 1080)).toMatchObject({ width: 1440, height: 1080, x: 240, y: 0 });
  });
  it("letterboxes a 16:9 page on a 4:3 surface", () => {
    expect(fitPage(1600, 900, 1024, 768)).toMatchObject({ width: 1024, height: 576, x: 0, y: 96 });
  });
  it("fills a matching surface exactly", () => {
    expect(fitPage(454, 255.4, 3024, 1701)).toMatchObject({ x: 0, y: 0, width: 3024 });
  });
  it("returns nothing for a zero-sized surface", () => {
    expect(fitPage(100, 100, 0, 500).width).toBe(0);
  });
});
