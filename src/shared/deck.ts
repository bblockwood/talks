// PDF.js adapter: opens a deck from bytes held in memory and exposes what the core needs.
// Nothing here writes to any storage (SPEC §1.1 principle 4).
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FrameIndex } from "../core/frames";
import { linkFromRaw } from "../core/links";
import type { PageLink } from "../core/links";
import { loadEmbeddedNotes } from "./deck-notes";

GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

/** A failure with a message fit to show on the entry screen. */
export class DeckError extends Error {
  override name = "DeckError";
}

export interface Deck {
  readonly pageCount: number;
  readonly frames: FrameIndex;
  /** The PDF's own title, if it has one. */
  readonly title: string | null;
  getPage(page: number): Promise<PDFPageProxy>;
  /** Links of a page once loaded, in annotation order; undefined until then. */
  linksNow(page: number): readonly PageLink[] | undefined;
  loadLinks(page: number): Promise<readonly PageLink[]>;
  /** Width divided by height of the first page, for laying out slide boxes before anything is rendered. */
  readonly aspect: number;
  /** Notes embedded in the PDF as text annotations, per page. Scans every page once. */
  loadEmbeddedNotes(): Promise<Map<number, string>>;
  /** Drops the document and its worker. The deck is unusable afterwards. */
  destroy(): Promise<void>;
}

export async function openDeck(data: ArrayBuffer): Promise<Deck> {
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
  const frames = labels ? new FrameIndex(labels) : FrameIndex.unlabelled(pdf.numPages);

  let title: string | null = null;
  try {
    const info = (await pdf.getMetadata()).info as { Title?: unknown };
    if (typeof info.Title === "string" && info.Title.trim() !== "") title = info.Title.trim();
  } catch {
    // No metadata.
  }

  let aspect = 16 / 9;
  try {
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    if (first.width > 0 && first.height > 0) aspect = first.width / first.height;
  } catch {
    // Keep the default.
  }
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
    return out;
  };

  return {
    pageCount: pdf.numPages,
    frames,
    title,
    aspect,
    loadEmbeddedNotes: () => (embeddedNotes ??= loadEmbeddedNotes(pdf)),
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
