// PDF.js adapter: opens a deck from bytes held in memory and exposes what the core needs.
// Nothing here writes to any storage (SPEC §1.1 principle 4).
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FrameIndex } from "../core/frames";
import { linkFromRaw } from "../core/links";
import type { PageLink } from "../core/links";
import type { NormalizedRect } from "../core/links";
import { flattenOutline } from "../core/outline";
import type { OutlineEntry, OutlineNode } from "../core/outline";
import { cropLinks, splitRects } from "../core/split";
import type { NotesSplit } from "../core/split";
import { loadEmbeddedNotes } from "./deck-notes";

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * In a packed copy the worker's code is inside the page, as a data URL. Opened from a disk,
 * Chrome will not start a module worker (which is how PDF.js starts its own), but it does start
 * an ordinary worker that then imports the module. That worker is handed to PDF.js once it has
 * loaded; before that it would miss what PDF.js sends it.
 */
let workerReady: Promise<void> | null = null;
function prepareWorker(): Promise<void> {
  workerReady ??= (async () => {
    if (!workerUrl.startsWith("data:")) return;
    let worker: Worker | null = null;
    try {
      const boot = `import(${JSON.stringify(workerUrl)}).then(() => postMessage("lectern-worker-ready"), () => postMessage("lectern-worker-failed"));`;
      const made = new Worker(URL.createObjectURL(new Blob([boot], { type: "text/javascript" })));
      worker = made;
      const ready = await new Promise<boolean>((resolve) => {
        // Loaded: PDF.js's worker announces itself first (a message PDF.js ignores when it is
        // handed a worker), then the import settles.
        made.onmessage = (ev: MessageEvent) => resolve(ev.data !== "lectern-worker-failed");
        made.onerror = () => resolve(false);
        window.setTimeout(() => resolve(false), 8000);
      });
      made.onmessage = null;
      made.onerror = null;
      if (!ready) throw new Error("worker did not load");
      GlobalWorkerOptions.workerPort = made;
    } catch {
      // PDF.js then reads the PDF on the page's own thread: slower, but it works.
      worker?.terminate();
    }
  })();
  return workerReady;
}

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

/** A failure with a message fit to show on the entry screen. */
export class DeckError extends Error {
  override name = "DeckError";
}

export interface Deck {
  readonly pageCount: number;
  /** Frames and builds. For a notes-split deck, every page is its own frame (see `setSplit`). */
  readonly frames: FrameIndex;
  /** The PDF's own title, if it has one. */
  readonly title: string | null;
  getPage(page: number): Promise<PDFPageProxy>;
  /** Links of a page once loaded, in annotation order; undefined until then. */
  linksNow(page: number): readonly PageLink[] | undefined;
  loadLinks(page: number): Promise<readonly PageLink[]>;
  /** Width divided by height of the slide part of the first page, for laying out slide boxes. */
  readonly aspect: number;
  /** Size of the first page in PDF points, whole page. */
  readonly pageSize: { readonly width: number; readonly height: number };
  /** Beamer second-screen notes layout in force, or null for an ordinary deck. */
  readonly split: NotesSplit | null;
  /** The part of each page that is the slide, and the part that is the notes panel (null without a split). */
  readonly slideCrop: NormalizedRect;
  readonly notesCrop: NormalizedRect | null;
  /**
   * Sets or clears the notes split. Do this before presenting: it changes the crops, the link
   * rectangles and the frames. Beamer's page labels are not frame numbers in such decks
   * (5 frames can be labelled 1,1,2,2,3,3), so each page becomes its own frame.
   */
  setSplit(split: NotesSplit | null): void;
  /** Plain text of a page, for search. */
  pageText(page: number): Promise<string>;
  /** Notes embedded in the PDF as text annotations, per page. Scans every page once. */
  loadEmbeddedNotes(): Promise<Map<number, string>>;
  /** The PDF's outline (bookmarks) in reading order; empty when it has none. */
  loadOutline(): Promise<readonly OutlineEntry[]>;
  /** Drops the document and its worker. The deck is unusable afterwards. */
  destroy(): Promise<void>;
}

export async function openDeck(data: ArrayBuffer): Promise<Deck> {
  await prepareWorker();
  const task = getDocument({
    data: new Uint8Array(data),
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    // A slide deck is small and already in memory: no range requests, no auto-fetch.
    disableAutoFetch: true,
    disableStream: true,
  });

  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") throw new DeckError("This PDF is password-protected.");
    throw new DeckError("This file could not be read as a PDF.");
  }
  if (pdf.numPages < 1) {
    await task.destroy().catch(() => {});
    throw new DeckError("This PDF has no pages.");
  }

  let labels: (string | null)[] | null = null;
  try {
    const raw = await pdf.getPageLabels();
    if (raw && raw.length === pdf.numPages) labels = raw.map((l) => (typeof l === "string" && l !== "" ? l : null));
  } catch {
    // Broken label tree: fall back to one frame per page.
  }
  const labelledFrames = labels ? new FrameIndex(labels) : FrameIndex.unlabelled(pdf.numPages);
  const pageFrames = FrameIndex.unlabelled(pdf.numPages);
  let split: NotesSplit | null = null;

  let title: string | null = null;
  try {
    const info = (await pdf.getMetadata()).info as { Title?: unknown };
    if (typeof info.Title === "string" && info.Title.trim() !== "") title = info.Title.trim();
  } catch {
    // No metadata.
  }

  let pageSize = { width: 1600, height: 900 };
  try {
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    if (first.width > 0 && first.height > 0) pageSize = { width: first.width, height: first.height };
  } catch {
    // Keep the default.
  }
  const texts = new Map<number, Promise<string>>();
  let embeddedNotes: Promise<Map<number, string>> | null = null;

  const links = new Map<number, readonly PageLink[]>();
  const loading = new Map<number, Promise<readonly PageLink[]>>();
  const namedDestinations = new Map<string, Promise<number | null>>();

  const pageOfExplicitDest = async (dest: unknown): Promise<number | null> => {
    if (!Array.isArray(dest)) return null;
    const target: unknown = dest[0];
    if (typeof target === "number") return Number.isInteger(target) ? target : null;
    if (target && typeof target === "object" && "num" in target && "gen" in target) {
      try {
        return await pdf.getPageIndex(target as { num: number; gen: number });
      } catch {
        return null;
      }
    }
    return null;
  };

  const resolveDest = (dest: unknown): Promise<number | null> => {
    if (typeof dest !== "string") return pageOfExplicitDest(dest);
    let known = namedDestinations.get(dest);
    if (!known) {
      known = pdf
        .getDestination(dest)
        .then(pageOfExplicitDest)
        .catch(() => null);
      namedDestinations.set(dest, known);
    }
    return known;
  };

  interface RawOutline {
    title?: unknown;
    dest?: unknown;
    items?: unknown;
  }
  const outlineNodes = async (items: unknown, depth: number): Promise<OutlineNode[]> => {
    if (!Array.isArray(items) || depth > 8) return [];
    const out: OutlineNode[] = [];
    for (const item of items as RawOutline[]) {
      if (!item || typeof item !== "object") continue;
      out.push({
        title: typeof item.title === "string" ? item.title : "",
        page: item.dest != null ? await resolveDest(item.dest) : null,
        children: await outlineNodes(item.items, depth + 1),
      });
    }
    return out;
  };
  let outline: Promise<readonly OutlineEntry[]> | null = null;

  const extractLinks = async (page: number): Promise<readonly PageLink[]> => {
    const proxy = await pdf.getPage(page + 1);
    const viewport = proxy.getViewport({ scale: 1 });
    const annotations = (await proxy.getAnnotations({ intent: "display" })) as Record<string, unknown>[];
    const out: PageLink[] = [];
    for (const a of annotations) {
      if (a["subtype"] !== "Link" || !Array.isArray(a["rect"]) || a["rect"].length !== 4) continue;
      const [rx1, ry1, rx2, ry2] = a["rect"] as [number, number, number, number];
      // PDF user space → the rotated, cropped page as displayed (origin top-left).
      const [x1, y1] = viewport.convertToViewportPoint(rx1, ry1) as [number, number];
      const [x2, y2] = viewport.convertToViewportPoint(rx2, ry2) as [number, number];
      const rect = {
        x: Math.min(x1, x2) / viewport.width,
        y: Math.min(y1, y2) / viewport.height,
        width: Math.abs(x2 - x1) / viewport.width,
        height: Math.abs(y2 - y1) / viewport.height,
      };
      const url = typeof a["url"] === "string" ? a["url"] : typeof a["unsafeUrl"] === "string" ? a["unsafeUrl"] : null;
      out.push(
        linkFromRaw({
          rect,
          destPage: a["dest"] != null ? await resolveDest(a["dest"]) : null,
          namedAction: typeof a["action"] === "string" ? a["action"] : null,
          url,
        }),
      );
    }
    // Rectangles are relative to the slide part of the page, which is what every surface shows.
    return cropLinks(out, splitRects(split).slide);
  };

  return {
    pageCount: pdf.numPages,
    get frames() {
      return split ? pageFrames : labelledFrames;
    },
    title,
    get aspect() {
      const crop = splitRects(split).slide;
      return (pageSize.width * crop.width) / (pageSize.height * crop.height);
    },
    pageSize,
    get split() {
      return split;
    },
    get slideCrop() {
      return splitRects(split).slide;
    },
    get notesCrop() {
      return splitRects(split).notes;
    },
    setSplit(next) {
      if (next === split) return;
      split = next;
      links.clear();
      loading.clear();
    },
    pageText(page) {
      let text = texts.get(page);
      if (!text) {
        text = pdf
          .getPage(page + 1)
          .then((proxy) => proxy.getTextContent())
          .then((content) =>
            (content.items as { str?: string; hasEOL?: boolean }[])
              .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : " "))
              .join("")
              .replace(/[ \t]+/g, " ")
              .trim(),
          )
          .catch(() => "");
        texts.set(page, text);
      }
      return text;
    },
    loadEmbeddedNotes: () => (embeddedNotes ??= loadEmbeddedNotes(pdf)),
    loadOutline: () =>
      (outline ??= pdf
        .getOutline()
        .then((raw) => outlineNodes(raw, 0))
        .then((nodes) => flattenOutline(nodes, pdf.numPages))
        .catch((): readonly OutlineEntry[] => [])),
    getPage: (page) => pdf.getPage(page + 1),
    linksNow: (page) => links.get(page),
    loadLinks(page) {
      let p = loading.get(page);
      if (!p) {
        p = extractLinks(page)
          .catch((): readonly PageLink[] => [])
          .then((found) => {
            links.set(page, found);
            return found;
          });
        loading.set(page, p);
      }
      return p;
    },
    async destroy() {
      links.clear();
      loading.clear();
      namedDestinations.clear();
      await task.destroy().catch(() => {});
    },
  };
}
