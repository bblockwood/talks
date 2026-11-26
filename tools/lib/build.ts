// Builds the encrypted deck for one PDF and its sidecars (SPEC §4.2, §4.4). No git, no network.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { contentHash16, deriveKeys, encryptDeck } from "../../src/core/crypto.ts";
import { packPayload } from "../../src/core/payload.ts";
import type { DeckMeta, DeckNotes, DeckSettings, NoteOverride } from "../../src/core/payload.ts";
import { extractPptxNotes } from "../../src/core/pptx.ts";

export interface BuiltDeck {
  deckId: string;
  /** `<sha256-16>.bin` */
  fileName: string;
  bin: Uint8Array;
  /** Contents of `current.json`. No title or other identifying metadata (SPEC §4.1). */
  currentJson: string;
  meta: DeckMeta;
  /** What was picked up, and anything the user should know. Never contains the code. */
  messages: string[];
}

async function inspectPdf(pdf: Uint8Array): Promise<{ pageCount: number; title: string | null }> {
  // The legacy build is the one PDF.js supports under Node.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(pdf), verbosity: 0, useSystemFonts: false, disableFontFace: true });
  try {
    const doc = await task.promise;
    let title: string | null = null;
    try {
      const info = (await doc.getMetadata()).info as { Title?: unknown };
      if (typeof info.Title === "string" && info.Title.trim() !== "") title = info.Title.trim();
    } catch {
      // No metadata.
    }
    return { pageCount: doc.numPages, title };
  } finally {
    await task.destroy();
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Settings and note overrides from a `.lectern.json` sidecar (Native §3.4). A bad sidecar is skipped. */
export function readSidecar(text: string): { settings: DeckSettings; noteOverrides: NoteOverride[] } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const s = isRecord(raw["settings"]) ? raw["settings"] : {};
  const settings: DeckSettings = {};
  if (typeof s["targetDuration"] === "number") settings.targetDuration = s["targetDuration"];
  if (typeof s["endOfTalkPage"] === "number") settings.endOfTalkPage = s["endOfTalkPage"];
  if (typeof s["notesSplit"] === "string") settings.notesSplit = s["notesSplit"];
  const noteOverrides: NoteOverride[] = [];
  if (Array.isArray(raw["notes"])) {
    for (const n of raw["notes"] as unknown[]) {
      if (isRecord(n) && typeof n["frameLabel"] === "string" && typeof n["pageIndex"] === "number" && typeof n["text"] === "string") {
        noteOverrides.push({ frameLabel: n["frameLabel"], pageIndex: n["pageIndex"], text: n["text"] });
      }
    }
  }
  return { settings, noteOverrides };
}

export async function buildDeck(pdfPath: string, code: string, now: Date = new Date()): Promise<BuiltDeck> {
  const messages: string[] = [];
  const pdf = new Uint8Array(readFileSync(pdfPath));
  let info: { pageCount: number; title: string | null };
  try {
    info = await inspectPdf(pdf);
  } catch {
    throw new Error(`${pdfPath} could not be read as a PDF`);
  }

  const base = pdfPath.replace(/\.pdf$/i, "");
  const fileName = path.basename(pdfPath);

  let settings: DeckSettings = {};
  let noteOverrides: NoteOverride[] = [];
  const sidecarPath = `${base}.lectern.json`;
  if (existsSync(sidecarPath)) {
    const sidecar = readSidecar(readFileSync(sidecarPath, "utf8"));
    if (sidecar) {
      ({ settings, noteOverrides } = sidecar);
      messages.push(`Sidecar: ${path.basename(sidecarPath)} (${noteOverrides.length} notes)`);
    } else {
      messages.push(`Warning: ${path.basename(sidecarPath)} is not valid and was skipped.`);
    }
  }

  let notes: DeckNotes | null = null;
  const pptxPath = `${base}.pptx`;
  if (existsSync(pptxPath)) {
    try {
      const pptx = extractPptxNotes(new Uint8Array(readFileSync(pptxPath)));
      if (pptx.visibleSlideCount !== info.pageCount) {
        // Mapping notes to the wrong slides is worse than having none.
        messages.push(
          `Warning: ${path.basename(pptxPath)} has ${pptx.visibleSlideCount} visible slides but the PDF has ` +
            `${info.pageCount} pages. PowerPoint notes were left out.`,
        );
      } else {
        notes = { pages: pptx.notes.map((n) => ({ index: n.index, text: n.text })) };
        messages.push(
          `PowerPoint notes: ${pptx.notes.length} slides with notes` +
            (pptx.hiddenSlideCount > 0 ? `, ${pptx.hiddenSlideCount} hidden slides skipped` : ""),
        );
      }
    } catch (e) {
      messages.push(`Warning: ${path.basename(pptxPath)} could not be read (${(e as Error).message}). Notes left out.`);
    }
  }

  let pdfpc: Uint8Array | null = null;
  const pdfpcPath = `${base}.pdfpc`;
  if (existsSync(pdfpcPath)) {
    pdfpc = new Uint8Array(readFileSync(pdfpcPath));
    messages.push(`pdfpc file: ${path.basename(pdfpcPath)}`);
  }

  const meta: DeckMeta = {
    v: 1,
    title: info.title ?? fileName.replace(/\.pdf$/i, ""),
    published: now.toISOString(),
    source: fileName,
    pageCount: info.pageCount,
    settings,
    noteOverrides,
  };

  const keys = await deriveKeys(code);
  const bin = await encryptDeck(keys.deckKey, packPayload({ pdf, meta, notes, pdfpc }));
  const binName = `${await contentHash16(bin)}.bin`;
  return {
    deckId: keys.deckId,
    fileName: binName,
    bin,
    currentJson: JSON.stringify({ v: 1, file: binName, bytes: bin.length, published: meta.published }) + "\n",
    meta,
    messages,
  };
}
