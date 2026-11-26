import { describe, expect, it } from "vitest";
import { FrameIndex, buildCount } from "../src/core/frames";

/** Labels for a deck whose frames have the given build counts, like Beamer writes them. */
export const labelsFor = (builds: number[]): string[] => builds.flatMap((n, i) => new Array<string>(n).fill(String(i + 1)));

// fixtures/overlays.pdf: 23 pages, 9 frames, builds per frame 1,3,4,3,2,1,3,5,1.
const OVERLAYS = [1, 3, 4, 3, 2, 1, 3, 5, 1];

describe("FrameIndex", () => {
  const index = new FrameIndex(labelsFor(OVERLAYS));

  it("groups runs of identical labels", () => {
    expect(index.pageCount).toBe(23);
    expect(index.frameCount).toBe(9);
    expect(index.frames.map(buildCount)).toEqual(OVERLAYS);
    expect(index.frames[2]).toEqual({ index: 2, label: "3", firstPage: 4, lastPage: 7 });
  });

  it("finds the frame and build of a page", () => {
    expect(index.frameContaining(0)?.label).toBe("1");
    expect(index.frameContaining(3)?.label).toBe("2");
    expect(index.frameContaining(4)?.label).toBe("3");
    expect(index.buildIndex(4)).toBe(0);
    expect(index.buildIndex(7)).toBe(3);
  });

  it("clamps out-of-range pages", () => {
    expect(index.frameContaining(-5)?.index).toBe(0);
    expect(index.frameContaining(999)?.index).toBe(8);
    expect(index.clamp(2.9)).toBe(2);
  });

  it("nextFrame goes to the first build, previousFrame to the last", () => {
    expect(index.nextFrameFirstPage(5)).toBe(8);
    expect(index.previousFrameLastPage(5)).toBe(3);
    expect(index.nextFrameFirstPage(22)).toBeNull();
    expect(index.previousFrameLastPage(0)).toBeNull();
  });

  it("finds frames by label", () => {
    expect(index.frameWithLabel("8")?.firstPage).toBe(17);
    expect(index.frameWithLabel("99")).toBeUndefined();
  });

  it("gives every page its own frame when there are no labels", () => {
    const plain = FrameIndex.unlabelled(4);
    expect(plain.frameCount).toBe(4);
    expect(plain.frames.map((f) => f.label)).toEqual(["1", "2", "3", "4"]);
  });

  it("gives every page its own frame when every label is unique", () => {
    expect(new FrameIndex(["i", "ii", "1", "2"]).frameCount).toBe(4);
  });

  it("never joins unlabelled pages, and only joins consecutive equal labels", () => {
    const mixed = new FrameIndex(["1", "1", null, null, "1", "2", "2"]);
    expect(mixed.frames.map((f) => [f.label, f.firstPage, f.lastPage])).toEqual([
      ["1", 0, 1],
      ["3", 2, 2],
      ["4", 3, 3],
      ["1", 4, 4],
      ["2", 5, 6],
    ]);
  });

  it("handles an empty deck", () => {
    const empty = new FrameIndex([]);
    expect(empty.frameCount).toBe(0);
    expect(empty.frameContaining(0)).toBeUndefined();
    expect(empty.buildIndex(0)).toBe(0);
  });
});
