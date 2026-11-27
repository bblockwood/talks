import { describe, expect, it } from "vitest";
import { currentEntry, flattenOutline, shadowedEntries } from "../src/core/outline";
import type { OutlineNode } from "../src/core/outline";

const node = (title: string, page: number | null, children: OutlineNode[] = []): OutlineNode => ({ title, page, children });

const tree: OutlineNode[] = [
  node("Introduction", 1, [node("Motivation", 1), node("  Related\n work ", 4)]),
  node("Model", 6),
  node("Nowhere", null),
  node("Appendix", 12, [node("Proofs", 99)]),
];

describe("outline", () => {
  const entries = flattenOutline(tree, 20);

  it("flattens depth first, trims titles, and drops pages outside the deck", () => {
    expect(entries).toEqual([
      { title: "Introduction", page: 1, depth: 0 },
      { title: "Motivation", page: 1, depth: 1 },
      { title: "Related work", page: 4, depth: 1 },
      { title: "Model", page: 6, depth: 0 },
      { title: "Nowhere", page: null, depth: 0 },
      { title: "Appendix", page: 12, depth: 0 },
      { title: "Proofs", page: null, depth: 1 },
    ]);
  });

  it("finds the entry the talk is in", () => {
    expect(currentEntry(entries, 0)).toBe(-1); // the title page, before the first section
    expect(currentEntry(entries, 1)).toBe(1); // the subsection that starts with its section wins
    expect(currentEntry(entries, 3)).toBe(1);
    expect(currentEntry(entries, 4)).toBe(2);
    expect(currentEntry(entries, 11)).toBe(3);
    expect(currentEntry(entries, 19)).toBe(5);
    expect(currentEntry([], 3)).toBe(-1);
    expect(currentEntry([{ title: "x", page: null, depth: 0 }], 3)).toBe(-1);
  });

  it("marks a section whose first subsection starts on the same page", () => {
    expect([...shadowedEntries(entries)]).toEqual([0]);
  });

  it("stops at a sane size", () => {
    const many = Array.from({ length: 5000 }, (_, i) => node(`s${i}`, 0));
    expect(flattenOutline(many, 1)).toHaveLength(2000);
  });
});
