import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FrameIndex } from "../src/core/frames";
import { escapeHtml, formatClock, parseBlocks, renderNotesHtml } from "../src/core/markdown";
import { NotesTable, assembleNotes, embeddedNote, mergeNotes, parsePdfpc, pdfpcNotesByPage, targetDurationMs } from "../src/core/notes";
import { loadEmbeddedNotes } from "../src/shared/deck-notes";
import { labelsFor } from "./frames.test";

async function openFixture(name: string) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(readFileSync(`fixtures/${name}`)), verbosity: 0 });
  const pdf = await task.promise;
  const labels = (await pdf.getPageLabels()) ?? [];
  return { pdf, frames: new FrameIndex(labels), close: () => task.destroy() };
}

describe(".pdfpc files", () => {
  const text = readFileSync("fixtures/pdfpc-notes.pdfpc", "utf8");

  it("parses the current JSON format", () => {
    const file = parsePdfpc(text);
    expect(file?.durationMinutes).toBe(30);
    expect(file?.endSlide).toBe(4);
    expect(file?.pages).toHaveLength(3);
    expect(file?.pages[1]).toMatchObject({ idx: 4, label: "3", overlay: 2 });
    expect(targetDurationMs(file ?? null, 600)).toBe(1_800_000);
    expect(targetDurationMs(null, 600)).toBe(600_000);
    expect(targetDurationMs(null, undefined)).toBeNull();
  });

  it("maps entries to pages by label and overlay, falling back to idx", () => {
    // pdfpc-notes.pdf: 10 pages, frames 1 | 2 | 3,3,3 | 4,4 | 5 | 6 | 7.
    const frames = new FrameIndex(["1", "2", "3", "3", "3", "4", "4", "5", "6", "7"]);
    const notes = pdfpcNotesByPage(parsePdfpc(text)!, frames);
    expect([...notes.keys()].sort((a, b) => a - b)).toEqual([1, 4, 9]);
    expect(notes.get(4)).toContain("build 3 of frame 3");

    // The same file against a deck with one page inserted at the front: labels still find the frames.
    const shifted = new FrameIndex(["0", "1", "2", "3", "3", "3", "4", "4", "5", "6", "7"]);
    expect([...pdfpcNotesByPage(parsePdfpc(text)!, shifted).keys()].sort((a, b) => a - b)).toEqual([2, 5, 10]);
  });

  it("parses the legacy bracketed format, whose notes cover a whole frame", () => {
    const legacy = "[file]\ntalk.pdf\n[duration]\n20\n[end_user_slide]\n3\n[notes]\n### 2\nfirst note\nsecond line\n### 3\nother\n";
    const file = parsePdfpc(legacy);
    expect(file).toMatchObject({ durationMinutes: 20, endSlide: 2 });
    const frames = new FrameIndex(labelsFor([1, 3, 2]));
    const notes = pdfpcNotesByPage(file!, frames);
    expect([...notes.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(notes.get(2)).toBe("first note\nsecond line");
  });

  it("returns null for something that is neither format", () => {
    expect(parsePdfpc("just some text")).toBeNull();
    expect(parsePdfpc("[]")).toBeNull();
  });
});

describe("merging", () => {
  const frames = new FrameIndex(labelsFor([1, 3, 2]));

  it("earlier sources win per page; blank notes never shadow lower ones", () => {
    const table = mergeNotes([
      { source: "sidecar", notes: new Map([[0, "mine"], [1, "   "]]) },
      { source: "pdfpcFile", notes: new Map([[0, "pdfpc"], [1, "pdfpc 1"]]) },
      { source: "embedded", notes: new Map([[1, "embedded"], [2, "embedded 2"]]) },
      { source: "pptx", notes: new Map([[4, "ppt"]]) },
    ]);
    expect(table.byPage.get(0)).toEqual({ text: "mine", source: "sidecar" });
    expect(table.byPage.get(1)).toEqual({ text: "pdfpc 1", source: "pdfpcFile" });
    expect(table.byPage.get(2)).toEqual({ text: "embedded 2", source: "embedded" });
    expect(table.byPage.get(4)).toEqual({ text: "ppt", source: "pptx" });
  });

  it("a build without notes shows its frame's: the closest earlier build, then any", () => {
    // Frame 2 is pages 1–3; frame 3 is pages 4–5.
    const table = mergeNotes([{ source: "embedded", notes: new Map([[1, "build 1"], [5, "last build"]]) }]);
    expect(table.noteFor(1, frames)?.text).toBe("build 1");
    expect(table.noteFor(3, frames)?.text).toBe("build 1");
    expect(table.noteFor(4, frames)?.text).toBe("last build");
    expect(table.noteFor(0, frames)).toBeNull();
    expect(NotesTable.empty.noteFor(2, frames)).toBeNull();
    expect(NotesTable.empty.isEmpty).toBe(true);
  });

  it("only /Text annotations are notes", () => {
    expect(
      embeddedNote([
        { subtype: "Link", contents: "" },
        { subtype: "Text", contents: " first " },
        { subtype: "FreeText", contents: "visible on the slide" },
        { subtype: "Text", contents: "second" },
        { subtype: "Text", contents: "  " },
      ]),
    ).toBe("first\n\nsecond");
    expect(embeddedNote([{ subtype: "FreeText", contents: "x" }])).toBeNull();
  });
});

describe("notes in the fixture PDFs (read with PDF.js)", () => {
  it("finds pdfpc-package notes, which are hidden annotations", async () => {
    const { pdf, frames, close } = await openFixture("pdfpc-notes.pdf");
    try {
      const embedded = await loadEmbeddedNotes(pdf);
      expect(embedded.size).toBeGreaterThanOrEqual(5);
      // The un-overlaid note of frame 3 is repeated on each of its build pages (2–4).
      expect(embedded.get(2)).toBeTruthy();
      expect(embedded.get(3)).toBe(embedded.get(2));

      const table = assembleNotes(
        { overrides: [], pdfpc: parsePdfpc(readFileSync("fixtures/pdfpc-notes.pdfpc", "utf8")), embedded, pptx: [] },
        frames,
      );
      // The .pdfpc file overrides page 2's embedded note, adds one for build 3 of frame 3, and one for the last page.
      expect(table.byPage.get(1)).toMatchObject({ source: "pdfpcFile" });
      expect(table.byPage.get(2)).toMatchObject({ source: "embedded" });
      expect(table.byPage.get(4)).toMatchObject({ source: "pdfpcFile" });
      expect(table.byPage.get(9)).toMatchObject({ source: "pdfpcFile" });
    } finally {
      await close();
    }
  });

  it("finds pdfcomment notes but never the visible FreeText comment", async () => {
    const { pdf, close } = await openFixture("pdfcomment-notes.pdf");
    try {
      const embedded = await loadEmbeddedNotes(pdf);
      expect(embedded.size).toBeGreaterThanOrEqual(3);
      expect(embedded.has(6)).toBe(false); // page 7 has no annotations
      expect(embedded.has(5)).toBe(false); // page 6 has only the visible FreeText
    } finally {
      await close();
    }
  });

  it("finds none in a deck without notes", async () => {
    const { pdf, close } = await openFixture("overlays.pdf");
    try {
      expect((await loadEmbeddedNotes(pdf)).size).toBe(0);
    } finally {
      await close();
    }
  });
});

describe("markdown", () => {
  it("splits paragraphs, bullets and numbered items", () => {
    expect(parseBlocks("One\nstill one\n\n- a\n  - b\n* c\n1. first\n2) second\n\nlast")).toEqual([
      { kind: "paragraph", text: "One\nstill one" },
      { kind: "bullet", text: "a", level: 0 },
      { kind: "bullet", text: "b", level: 1 },
      { kind: "bullet", text: "c", level: 0 },
      { kind: "numbered", text: "first", number: 1 },
      { kind: "numbered", text: "second", number: 2 },
      { kind: "paragraph", text: "last" },
    ]);
  });

  it("renders emphasis, code and line breaks", () => {
    expect(renderNotesHtml("**bold** and *em* and `code*x*`\nnext line")).toBe(
      "<p><strong>bold</strong> and <em>em</em> and <code>code*x*</code><br>next line</p>",
    );
    expect(renderNotesHtml("- **markdown** is on")).toBe('<p class="li l0"><span class="mark">•</span><span><strong>markdown</strong> is on</span></p>');
    expect(renderNotesHtml("snake_case_name and 2 * 3 * 4")).toBe("<p>snake_case_name and 2 * 3 * 4</p>");
  });

  it("escapes everything, so note text can never become markup", () => {
    const html = renderNotesHtml('<img src=x onerror="alert(1)"> & <script>x</script> `<b>`');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&#60;img");
    expect(escapeHtml(`<>&"'`)).toBe("&#60;&#62;&#38;&#34;&#39;");
  });

  it("formats clock times", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(754_000)).toBe("12:34");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(-45_500)).toBe("-0:45");
  });
});
