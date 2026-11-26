// How the service worker treats each request (SPEC §9). Pure, so it is unit-tested; the worker
// itself (src/sw/sw.ts) only wires these decisions to the Cache API.

export type RouteKind =
  /** An app page: network first, so updates arrive; the cached copy when the network fails. */
  | "page"
  /** A content-hashed bundle file or a PDF.js asset: cache first, they never change. */
  | "asset"
  /** `d/<deckId>/current.json`: always the network when it answers; the last copy when it doesn't. */
  | "current"
  /** `d/<deckId>/<hash>.bin`: an encrypted deck, named by its content hash: cache first. */
  | "bin"
  /** Everything else is left to the browser. */
  | "pass";

export interface Route {
  readonly kind: RouteKind;
  /** For `current` and `bin`: the deck directory, `d/<deckId>/`. */
  readonly deckDir?: string;
}

const CURRENT = /^(d\/[0-9a-f]{32}\/)current\.json$/;
const BIN = /^(d\/[0-9a-f]{32}\/)[0-9a-f]{16}\.bin$/;

/** `base` is the app's base path with a trailing slash, e.g. `/talks/`. */
export function classify(pathname: string, base: string): Route {
  if (!pathname.startsWith(base)) {
    // `/talks` without the slash is the app's entry page too.
    return pathname === base.slice(0, -1) ? { kind: "page" } : { kind: "pass" };
  }
  const rel = pathname.slice(base.length);
  const current = CURRENT.exec(rel);
  if (current) return { kind: "current", deckDir: current[1] ?? "" };
  const bin = BIN.exec(rel);
  if (bin) return { kind: "bin", deckDir: bin[1] ?? "" };
  if (rel.startsWith("d/")) return { kind: "pass" }; // nothing else under d/ is ours to cache
  if (rel === "sw.js") return { kind: "pass" };
  if (rel.startsWith("assets/") || rel.startsWith("pdfjs/")) return { kind: "asset" };
  const last = rel.slice(rel.lastIndexOf("/") + 1);
  if (rel === "" || rel.endsWith("/") || last.endsWith(".html") || !last.includes(".")) return { kind: "page" };
  return { kind: "pass" };
}

/** Cache key for `current.json`: the URL without its cache-busting query. */
export function withoutQuery(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

/** Which cached deck files to delete once `current.json` names `keep` as the deck's file. */
export function staleBins(cachedUrls: readonly string[], deckDirUrl: string, keep: string): string[] {
  return cachedUrls.filter((url) => url.startsWith(deckDirUrl) && url.endsWith(".bin") && url !== `${deckDirUrl}${keep}`);
}
