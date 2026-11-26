// Speaker notes: the text sources and their merge (SPEC §6.2, Native §5). Ported from the
// native app's PDFPCFile, NotesTable and NotesMerger. The Beamer second-screen split (source 4)
// is an image crop, not text, and is handled by the views.
import type { FrameIndex } from "./frames";

export type NoteSource = "sidecar" | "pdfpcFile" | "embedded" | "pptx";

export interface PageNote {
  readonly text: string;
  readonly source: NoteSource;
}

export type NotesByPage = ReadonlyMap<number, string>;

// ---------------------------------------------------------------- .pdfpc files

export interface PdfpcEntry {
  /** 0-based real page index. Negative marks a legacy entry: minus the 1-based user slide. */
  readonly idx: number;
  readonly label: string | null;
  /** 0-based position within the run of pages sharing the label. */
  readonly overlay: number;
  readonly note: string;
}

export interface PdfpcFile {
  /** Target length of the talk, in minutes. */
  readonly durationMinutes: number | null;
  /** 0-based frame index of the last main-talk slide. */
  readonly endSlide: number | null;
  readonly notePosition: string | null;
  readonly pages: readonly PdfpcEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * pdfpc's companion file. Current pdfpc writes JSON with `pdfpcFormat: 2`; older versions wrote
 * a bracketed text format, parsed as a fallback. Keys verified against pdfpc's
 * `src/classes/metadata/pdf.vala` for the native app (2026-10-25). Returns null if unreadable.
 */
export function parsePdfpc(text: string): PdfpcFile | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return parseLegacyPdfpc(text);
  }
  if (!isRecord(json)) return null;
  const pages: PdfpcEntry[] = [];
  if (Array.isArray(json["pages"])) {
    for (const p of json["pages"] as unknown[]) {
      if (!isRecord(p)) continue;
      const idx = int(p["idx"]);
      if (idx === null || idx < 0 || typeof p["note"] !== "string") continue;
      pages.push({
        idx,
        label: typeof p["label"] === "string" ? p["label"] : null,
        overlay: int(p["overlay"]) ?? 0,
        note: p["note"],
      });
    }
  }
  return {
    durationMinutes: int(json["duration"]),
    endSlide: int(json["endSlide"]),
    notePosition: typeof json["beamerNotePosition"] === "string" ? json["beamerNotePosition"].toLowerCase() : null,
    pages,
  };
}

/** Legacy format: `[section]` headers; `[notes]` holds `### N` blocks where N is a 1-based user slide. */
function parseLegacyPdfpc(text: string): PdfpcFile | null {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\[[A-Za-z_]+\]$/.test(line)) {
      if (current !== null) sections.set(current, buffer.join("\n"));
      current = line.slice(1, -1).toLowerCase();
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  if (current === null) return null;
  sections.set(current, buffer.join("\n"));

  const number = (name: string): number | null => {
    const raw = sections.get(name)?.trim();
    return raw !== undefined && /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  };
  const pages: PdfpcEntry[] = [];
  for (const block of (sections.get("notes") ?? "").split("### ").slice(1)) {
    const newline = block.indexOf("\n");
    if (newline < 0) continue;
    const userSlide = block.slice(0, newline).trim();
    if (!/^\d+$/.test(userSlide) || Number.parseInt(userSlide, 10) < 1) continue;
    pages.push({ idx: -Number.parseInt(userSlide, 10), label: null, overlay: 0, note: block.slice(newline + 1).trim() });
  }
  const end = number("end_user_slide");
  return {
    durationMinutes: number("duration"),
    endSlide: end === null ? null : end - 1, // legacy stored the 1-based user slide
    notePosition: sections.get("notes_position")?.trim().toLowerCase() ?? null,
    pages,
  };
}

/** Notes per real page, applying pdfpc's matching: label and overlay first, then idx. */
export function pdfpcNotesByPage(file: PdfpcFile, frames: FrameIndex): Map<number, string> {
  const { labels } = frames;
  const notes = new Map<number, string>();
  for (const entry of file.pages) {
    if (entry.note === "") continue;
    if (entry.idx < 0) {
      // Legacy: a 1-based user slide covers every page of that frame.
      const frame = frames.frames[-entry.idx - 1];
      if (frame) for (let p = frame.firstPage; p <= frame.lastPage; p++) notes.set(p, entry.note);
      continue;
    }
    const inRange = entry.idx < labels.length;
    let page: number | null = inRange ? entry.idx : null;
    if (entry.label !== null && entry.label !== "") {
      if (!(inRange && labels[entry.idx] === entry.label && frames.buildIndex(entry.idx) === entry.overlay)) {
        // The deck changed since the file was written: find the labelled frame again.
        const first = labels.indexOf(entry.label);
        const candidate = first + entry.overlay;
        if (first >= 0 && labels[candidate] === entry.label) page = candidate;
      }
    }
    if (page !== null) notes.set(page, entry.note);
  }
  return notes;
}

// ---------------------------------------------------------------- merge and lookup

export class NotesTable {
  static readonly empty = new NotesTable(new Map());

  readonly byPage: ReadonlyMap<number, PageNote>;

  constructor(byPage: ReadonlyMap<number, PageNote>) {
    this.byPage = byPage;
  }

  get isEmpty(): boolean {
    return this.byPage.size === 0;
  }

  /** The page's own note, else its frame's: the closest earlier build, then any build (Native §5.2). */
  noteFor(page: number, frames: FrameIndex): PageNote | null {
    const own = this.byPage.get(page);
    if (own) return own;
    const frame = frames.frameContaining(page);
    if (!frame) return null;
    for (let p = Math.min(page, frame.lastPage + 1) - 1; p >= frame.firstPage; p--) {
      const earlier = this.byPage.get(p);
      if (earlier) return earlier;
    }
    for (let p = frame.firstPage; p <= frame.lastPage; p++) {
      const any = this.byPage.get(p);
      if (any) return any;
    }
    return null;
  }
}

/** Layers in priority order. Earlier sources win per page; blank texts never shadow lower layers. */
export function mergeNotes(layers: readonly { source: NoteSource; notes: NotesByPage }[]): NotesTable {
  const byPage = new Map<number, PageNote>();
  for (const layer of layers) {
    for (const [page, text] of layer.notes) {
      if (byPage.has(page) || text.trim() === "") continue;
      byPage.set(page, { text, source: layer.source });
    }
  }
  return new NotesTable(byPage);
}

export interface NoteInputs {
  /** Sidecar notes authored in the native app (`meta.json` noteOverrides). */
  readonly overrides: readonly { readonly pageIndex: number; readonly text: string }[];
  readonly pdfpc: PdfpcFile | null;
  /** Text annotations found in the PDF, per page. */
  readonly embedded: NotesByPage;
  /** `notes.json` from a PowerPoint file. */
  readonly pptx: readonly { readonly index: number; readonly text: string }[];
}

/** SPEC §6.2 merge order: sidecar overrides, `.pdfpc`, PDF annotations, (Beamer split), PowerPoint. */
export function assembleNotes(inputs: NoteInputs, frames: FrameIndex): NotesTable {
  return mergeNotes([
    { source: "sidecar", notes: new Map(inputs.overrides.map((n) => [n.pageIndex, n.text])) },
    { source: "pdfpcFile", notes: inputs.pdfpc ? pdfpcNotesByPage(inputs.pdfpc, frames) : new Map() },
    { source: "embedded", notes: inputs.embedded },
    { source: "pptx", notes: new Map(inputs.pptx.map((n) => [n.index, n.text])) },
  ]);
}

/**
 * Notes from one page's annotations (Native §5.1(3)): the contents of `/Text` annotations, which
 * is what the pdfpc LaTeX package (hidden, zero-size) and pdfcomment emit. Visible annotation
 * types such as FreeText are page content and never notes.
 */
export function embeddedNote(annotations: readonly { readonly subtype: string; readonly contents: string }[]): string | null {
  const texts = annotations
    .filter((a) => a.subtype === "Text")
    .map((a) => a.contents.trim())
    .filter((t) => t !== "");
  return texts.length > 0 ? texts.join("\n\n") : null;
}

/** Target length of the talk: pdfpc's `duration` (minutes) first, then the sidecar's (seconds). Native §6.7. */
export function targetDurationMs(pdfpc: PdfpcFile | null, sidecarSeconds: number | undefined): number | null {
  if (pdfpc && pdfpc.durationMinutes !== null && pdfpc.durationMinutes > 0) return pdfpc.durationMinutes * 60_000;
  if (sidecarSeconds !== undefined && sidecarSeconds > 0) return Math.round(sidecarSeconds * 1000);
  return null;
}
