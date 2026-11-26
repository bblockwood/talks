import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { linkFromRaw } from "../src/core/links";
import { fold, hitsByFrame, searchPages } from "../src/core/search";
import { chooseSplit, cropLinks, detectSplit, parseSplit, splitRects } from "../src/core/split";
import { labelsFor } from "./frames.test";

describe("Beamer notes split", () => {
  it("detects pages about twice as wide or tall as a slide", () => {
    expect(detectSplit(907, 255)).toBe("right"); // 16:9 slide + notes on the right (fixtures/notes-right.pdf)
    expect(detectSplit(725.6, 272.1)).toBe("right"); // 4:3 + notes
    expect(detectSplit(363, 544)).toBe("bottom"); // fixtures/notes-bottom.pdf
    expect(detectSplit(454, 255)).toBeNull(); // ordinary 16:9
    expect(detectSplit(363, 272)).toBeNull(); // ordinary 4:3
    expect(detectSplit(0, 100)).toBeNull();
  });

  it("uses pdfpc's hint for the side, but never splits an ordinary page", () => {
    expect(detectSplit(907, 255, "left")).toBe("left");
    expect(detectSplit(363, 544, "TOP")).toBe("top");
    expect(detectSplit(454, 255, "right")).toBeNull();
    expect(detectSplit(907, 255, "bottom")).toBeNull(); // the hint contradicts the shape
    expect(detectSplit(907, 255, "none")).toBe("right"); // not a side: fall back to the shape
  });

  it("lets the deck's stored setting override the guess", () => {
    expect(chooseSplit("left", null, 907, 255)).toBe("left");
    expect(chooseSplit("none", "right", 907, 255)).toBeNull();
    expect(chooseSplit(undefined, null, 907, 255)).toBe("right");
    expect(chooseSplit("nonsense", null, 454, 255)).toBeNull();
    expect(parseSplit("Right")).toBe("right");
    expect(parseSplit(3)).toBeNull();
  });

  it("gives the slide part and the notes part", () => {
    expect(splitRects("right")).toEqual({ slide: { x: 0, y: 0, width: 0.5, height: 1 }, notes: { x: 0.5, y: 0, width: 0.5, height: 1 } });
    expect(splitRects("left").slide.x).toBe(0.5);
    expect(splitRects("bottom").notes).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(splitRects("top").slide.y).toBe(0.5);
    expect(splitRects(null)).toEqual({ slide: { x: 0, y: 0, width: 1, height: 1 }, notes: null });
  });

  it("remaps links into the slide part and disables those on the notes part, keeping their order", () => {
    const links = [
      linkFromRaw({ rect: { x: 0.1, y: 0.8, width: 0.1, height: 0.1 }, destPage: 3 }), // on the slide half
      linkFromRaw({ rect: { x: 0.7, y: 0.2, width: 0.1, height: 0.1 }, destPage: 4 }), // on the notes half
    ];
    const cropped = cropLinks(links, splitRects("right").slide);
    expect(cropped).toHaveLength(2);
    expect(cropped[0]?.rect).toEqual({ x: 0.2, y: 0.8, width: 0.2, height: 0.1 });
    expect(cropped[1]?.rect.width).toBe(0);
    expect(cropped[1]?.action).toEqual({ kind: "goToPage", page: 4 });
    expect(cropLinks(links, splitRects(null).slide)).toEqual(links);
  });
});

describe("search", () => {
  const frames = new FrameIndex(labelsFor([1, 3, 1]));
  const texts = [
    "Optimal Soda Taxes\nBen Lockwood",
    "Elasticities\nThe demand elasticity is",
    "Elasticities\nThe demand elasticity is 1.4",
    "Elasticities\nThe demand elasticity is 1.4 and regressive",
    "Résumé of results: internalities matter",
  ];

  it("finds text regardless of case and accents", () => {
    expect(searchPages(texts, "soda", frames).map((h) => h.page)).toEqual([0]);
    expect(searchPages(texts, "RESUME", frames).map((h) => h.page)).toEqual([4]);
    expect(searchPages(texts, "résumé", frames).map((h) => h.page)).toEqual([4]);
    expect(fold("Écart-type")).toBe("ecart-type");
  });

  it("groups hits by frame, keeping the first matching build", () => {
    const hits = searchPages(texts, "elasticity", frames);
    expect(hits.map((h) => h.page)).toEqual([1, 2, 3]);
    expect(hits.every((h) => h.frameIndex === 1)).toBe(true);
    expect(hitsByFrame(hits).map((h) => h.page)).toEqual([1]);
    expect(hitsByFrame(searchPages(texts, "regressive", frames)).map((h) => h.page)).toEqual([3]);
  });

  it("gives a one-line snippet around the match", () => {
    const [hit] = searchPages(["x".repeat(100) + " the needle here " + "y".repeat(100)], "needle", FrameIndex.unlabelled(1));
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.endsWith("…")).toBe(true);
    expect(hit?.snippet).toContain("the needle here");
    expect(searchPages(texts, "soda", frames)[0]?.snippet).toBe("Optimal Soda Taxes Ben Lockwood");
  });

  it("returns nothing for an empty query or no match, and respects the limit", () => {
    expect(searchPages(texts, "   ", frames)).toEqual([]);
    expect(searchPages(texts, "zebra", frames)).toEqual([]);
    expect(searchPages(texts, "e", frames, 2)).toHaveLength(2);
  });
});
