// The deck payload (SPEC §4.2): a stored (uncompressed) ZIP holding the PDF and its sidecars.
// It exists only in memory in the browser, and only inside the encrypted `.bin` on the server.
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export interface DeckSettings {
  /** Seconds. From the `.lectern.json` sidecar. */
  targetDuration?: number;
  /** 0-based page index where the main talk ends. */
  endOfTalkPage?: number;
  notesSplit?: string;
}

/** A note authored in the native app (sidecar), which overrides every other notes source. */
export interface NoteOverride {
  frameLabel: string;
  pageIndex: number;
  text: string;
}

export interface DeckMeta {
  v: 1;
  title: string;
  /** ISO 8601 time of this publish. Also sent as `deckPublished` in relay state (SPEC §8.2). */
  published: string;
  /** Source file name, without its directory. */
  source: string;
  pageCount: number;
  settings: DeckSettings;
  noteOverrides: NoteOverride[];
}

/** `notes.json`: PowerPoint notes, one entry per PDF page that has any. */
export interface DeckNotes {
  pages: { index: number; text: string }[];
}

export interface DeckPayload {
  pdf: Uint8Array;
  meta: DeckMeta;
  notes: DeckNotes | null;
  /** A sibling pdfpc file, verbatim. */
  pdfpc: Uint8Array | null;
}

export class PayloadError extends Error {
  override name = "PayloadError";
}

/** `mtime` is the timestamp stamped on every entry; fix it for reproducible output in tests. */
export function packPayload(payload: DeckPayload, mtime: Date = new Date(payload.meta.published)): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "deck.pdf": payload.pdf,
    "meta.json": strToU8(JSON.stringify(payload.meta)),
  };
  if (payload.notes) files["notes.json"] = strToU8(JSON.stringify(payload.notes));
  if (payload.pdfpc) files["deck.pdfpc"] = payload.pdfpc;
  return zipSync(files, { level: 0, mtime });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseMeta(text: string): DeckMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PayloadError("meta.json is not valid JSON");
  }
  if (!isRecord(raw) || raw["v"] !== 1) throw new PayloadError("unsupported meta.json version");
  const settingsIn = isRecord(raw["settings"]) ? raw["settings"] : {};
  const settings: DeckSettings = {};
  if (typeof settingsIn["targetDuration"] === "number") settings.targetDuration = settingsIn["targetDuration"];
  if (typeof settingsIn["endOfTalkPage"] === "number") settings.endOfTalkPage = settingsIn["endOfTalkPage"];
  if (typeof settingsIn["notesSplit"] === "string") settings.notesSplit = settingsIn["notesSplit"];
  const noteOverrides: NoteOverride[] = [];
  if (Array.isArray(raw["noteOverrides"])) {
    for (const n of raw["noteOverrides"] as unknown[]) {
      if (isRecord(n) && typeof n["frameLabel"] === "string" && typeof n["pageIndex"] === "number" && typeof n["text"] === "string") {
        noteOverrides.push({ frameLabel: n["frameLabel"], pageIndex: n["pageIndex"], text: n["text"] });
      }
    }
  }
  return {
    v: 1,
    title: typeof raw["title"] === "string" ? raw["title"] : "",
    published: typeof raw["published"] === "string" ? raw["published"] : "",
    source: typeof raw["source"] === "string" ? raw["source"] : "",
    pageCount: typeof raw["pageCount"] === "number" ? raw["pageCount"] : 0,
    settings,
    noteOverrides,
  };
}

function parseNotes(text: string): DeckNotes | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !Array.isArray(raw["pages"])) return null;
    const pages: DeckNotes["pages"] = [];
    for (const p of raw["pages"] as unknown[]) {
      if (isRecord(p) && typeof p["index"] === "number" && typeof p["text"] === "string") {
        pages.push({ index: p["index"], text: p["text"] });
      }
    }
    return { pages };
  } catch {
    return null; // bad notes never prevent opening a deck
  }
}

export function unpackPayload(zip: Uint8Array): DeckPayload {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new PayloadError("payload is not a ZIP archive");
  }
  const pdf = files["deck.pdf"];
  const meta = files["meta.json"];
  if (!pdf) throw new PayloadError("payload has no deck.pdf");
  if (!meta) throw new PayloadError("payload has no meta.json");
  const notes = files["notes.json"];
  return {
    pdf,
    meta: parseMeta(strFromU8(meta)),
    notes: notes ? parseNotes(strFromU8(notes)) : null,
    pdfpc: files["deck.pdfpc"] ?? null,
  };
}
