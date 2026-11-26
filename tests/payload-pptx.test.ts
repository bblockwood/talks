import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PayloadError, packPayload, unpackPayload } from "../src/core/payload";
import type { DeckMeta } from "../src/core/payload";
import { PptxError, decodeXmlText, extractPptxNotes, notesText, resolveTarget } from "../src/core/pptx";

const meta: DeckMeta = {
  v: 1,
  title: "A talk",
  published: "2026-11-26T12:00:00.000Z",
  source: "talk.pdf",
  pageCount: 3,
  settings: { targetDuration: 1800, endOfTalkPage: 2 },
  noteOverrides: [{ frameLabel: "2", pageIndex: 1, text: "say hello" }],
};
const pdf = strToU8("%PDF-1.5 not really a pdf");

describe("payload", () => {
  it("round-trips every part", () => {
    const zip = packPayload({ pdf, meta, notes: { pages: [{ index: 0, text: "n" }] }, pdfpc: strToU8("{}") });
    const back = unpackPayload(zip);
    expect(back.pdf).toEqual(pdf);
    expect(back.meta).toEqual(meta);
    expect(back.notes).toEqual({ pages: [{ index: 0, text: "n" }] });
    expect(back.pdfpc).toEqual(strToU8("{}"));
  });

  it("leaves out absent sidecars", () => {
    const back = unpackPayload(packPayload({ pdf, meta, notes: null, pdfpc: null }));
    expect(back.notes).toBeNull();
    expect(back.pdfpc).toBeNull();
  });

  it("is stored, not compressed, and reproducible for a fixed time", () => {
    const big = new Uint8Array(50_000); // zeros would compress to almost nothing
    const a = packPayload({ pdf: big, meta, notes: null, pdfpc: null });
    const b = packPayload({ pdf: big, meta, notes: null, pdfpc: null });
    expect(a.length).toBeGreaterThan(50_000);
    expect(a).toEqual(b);
  });

  it("rejects payloads that are not a deck", () => {
    expect(() => unpackPayload(strToU8("nope"))).toThrow(PayloadError);
    expect(() => unpackPayload(zipSync({ "meta.json": strToU8(JSON.stringify(meta)) }))).toThrow("no deck.pdf");
    expect(() => unpackPayload(zipSync({ "deck.pdf": pdf }))).toThrow("no meta.json");
    expect(() => unpackPayload(zipSync({ "deck.pdf": pdf, "meta.json": strToU8("{") }))).toThrow("not valid JSON");
    expect(() => unpackPayload(zipSync({ "deck.pdf": pdf, "meta.json": strToU8('{"v":2}') }))).toThrow("unsupported");
  });

  it("tolerates missing fields, unknown keys and broken notes", () => {
    const back = unpackPayload(
      zipSync({
        "deck.pdf": pdf,
        "meta.json": strToU8('{"v":1,"title":"T","future":true,"settings":{"targetDuration":"x"}}'),
        "notes.json": strToU8("not json"),
      }),
    );
    expect(back.meta).toEqual({ v: 1, title: "T", published: "", source: "", pageCount: 0, settings: {}, noteOverrides: [] });
    expect(back.notes).toBeNull();
  });
});

// ---- A minimal synthetic .pptx: 4 slides in list order 2,1,3,4 by file name; slide "1" is hidden.

const rels = (entries: [string, string, string][]) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("") +
  `</Relationships>`;
const slide = (hidden = false) => `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"${hidden ? ' show="0"' : ""}><p:cSld/></p:sld>`;
const notesSlide = (body: string) =>
  `<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>` +
  `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:notes>`;

function makePptx(): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml":
      `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldMasterIdLst><p:sldMasterId id="1" r:id="rId9"/></p:sldMasterIdLst>` +
      `<p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/><p:sldId id="258" r:id="rId4"/><p:sldId id="259" r:id="rId5"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels([
      ["rId9", "slideMaster", "slideMasters/slideMaster1.xml"],
      ["rId2", "slide", "slides/slide1.xml"],
      ["rId3", "slide", "slides/slide2.xml"],
      ["rId4", "slide", "/ppt/slides/slide3.xml"],
      ["rId5", "slide", "slides/slide4.xml"],
    ]),
    "ppt/slides/slide1.xml": slide(true),
    "ppt/slides/slide2.xml": slide(),
    "ppt/slides/slide3.xml": slide(),
    "ppt/slides/slide4.xml": slide(),
    "ppt/slides/_rels/slide1.xml.rels": rels([["rId1", "notesSlide", "../notesSlides/notesSlide1.xml"]]),
    "ppt/slides/_rels/slide2.xml.rels": rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "notesSlide", "../notesSlides/notesSlide2.xml"],
    ]),
    "ppt/slides/_rels/slide3.xml.rels": rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]]),
    "ppt/slides/_rels/slide4.xml.rels": rels([["rId1", "notesSlide", "../notesSlides/notesSlide4.xml"]]),
    "ppt/notesSlides/notesSlide1.xml": notesSlide("<a:p><a:r><a:t>hidden slide notes</a:t></a:r></a:p>"),
    "ppt/notesSlides/notesSlide2.xml": notesSlide(
      `<a:p><a:r><a:rPr lang="en-US"/><a:t>First point: R&amp;D &lt; 5%</a:t></a:r></a:p>` +
        `<a:p><a:r><a:t>Second </a:t></a:r><a:r><a:rPr b="1"/><a:t>bold</a:t></a:r><a:br/><a:r><a:t>same paragraph</a:t></a:r></a:p>`,
    ),
    "ppt/notesSlides/notesSlide4.xml": notesSlide("<a:p><a:endParaRPr/></a:p>"),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

describe("pptx notes", () => {
  it("follows the slide list order, skips hidden slides, and keeps only real notes", () => {
    const result = extractPptxNotes(makePptx());
    expect(result.visibleSlideCount).toBe(3);
    expect(result.hiddenSlideCount).toBe(1);
    // slide2.xml is first in the list → PDF page 0. slide4's notes are empty.
    expect(result.notes).toEqual([{ index: 0, text: "First point: R&D < 5%\nSecond bold\nsame paragraph" }]);
  });

  it("reads only the body placeholder", () => {
    expect(notesText(notesSlide("<a:p><a:r><a:t>x</a:t></a:r></a:p>"))).toBe("x");
    expect(notesText("<p:notes/>")).toBe("");
  });

  it("decodes XML entities", () => {
    expect(decodeXmlText("a &amp; b &#233; &#x1F600; &quot;q&quot; &unknown;")).toBe('a & b \u00e9 \u{1F600} "q" &unknown;');
  });

  it("resolves relationship targets", () => {
    expect(resolveTarget("ppt", "slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    expect(resolveTarget("ppt/slides", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolveTarget("ppt/slides", "/ppt/media/x.png")).toBe("ppt/media/x.png");
  });

  it("rejects files that are not a pptx", () => {
    expect(() => extractPptxNotes(strToU8("nope"))).toThrow(PptxError);
    expect(() => extractPptxNotes(zipSync({ "word/document.xml": strToU8("<x/>") }))).toThrow("no presentation part");
  });
});
