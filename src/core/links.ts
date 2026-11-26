// Link annotations (SPEC §6.3, Native §4.3). Pure data: the PDF.js adapter in src/shared fills these in.

/** Named actions (PDF 32000 §12.6.4.11) as Beamer emits them for navigation symbols and \Acrobatmenu. */
export type NamedAction =
  | "nextPage"
  | "previousPage"
  | "firstPage"
  | "lastPage"
  | "goBack"
  | "goForward"
  | "other";

export type LinkAction =
  /** GoTo an explicit page or a resolved named destination. */
  | { readonly kind: "goToPage"; readonly page: number }
  | { readonly kind: "named"; readonly action: NamedAction }
  /** Ignored by default (SPEC §6.3). */
  | { readonly kind: "uri"; readonly url: string }
  | { readonly kind: "unsupported" };

/** A rectangle in normalised coordinates of the displayed page: 0–1 on both axes, origin top-left. */
export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PageLink {
  readonly rect: NormalizedRect;
  readonly action: LinkAction;
}

const NAMED: ReadonlyMap<string, NamedAction> = new Map([
  ["NextPage", "nextPage"],
  ["PrevPage", "previousPage"],
  ["FirstPage", "firstPage"],
  ["LastPage", "lastPage"],
  ["GoBack", "goBack"],
  ["GoForward", "goForward"],
]);

export function namedAction(pdfName: string): NamedAction {
  return NAMED.get(pdfName) ?? "other";
}

/** What the adapter knows about one link annotation after resolving its destination. */
export interface RawLink {
  readonly rect: NormalizedRect;
  /** 0-based target page of a GoTo, when it resolved. */
  readonly destPage?: number | null;
  /** PDF name of a named action, e.g. "NextPage". */
  readonly namedAction?: string | null;
  readonly url?: string | null;
}

export function linkFromRaw(raw: RawLink): PageLink {
  let action: LinkAction = { kind: "unsupported" };
  if (typeof raw.destPage === "number" && Number.isInteger(raw.destPage) && raw.destPage >= 0) {
    action = { kind: "goToPage", page: raw.destPage };
  } else if (raw.namedAction) {
    action = { kind: "named", action: namedAction(raw.namedAction) };
  } else if (raw.url) {
    action = { kind: "uri", url: raw.url };
  }
  return { rect: raw.rect, action };
}

export function rectContains(rect: NormalizedRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** True for links the session acts on. URI and unsupported links are inert, so they get no hit region. */
export function isNavigational(link: PageLink): boolean {
  if (link.action.kind === "goToPage") return true;
  return link.action.kind === "named" && link.action.action !== "other";
}

/**
 * Index of the link under a normalised point, or -1. Only navigational links count. Where they
 * overlap, the last one in annotation order wins: that is the one drawn on top.
 */
export function hitTest(links: readonly PageLink[], x: number, y: number): number {
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    if (link && isNavigational(link) && rectContains(link.rect, x, y)) return i;
  }
  return -1;
}
