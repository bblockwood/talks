// The PDF's outline (its bookmarks) as a flat list in reading order (Native §4.4). Beamer writes
// one entry per part, section and subsection.

export interface OutlineEntry {
  readonly title: string;
  /** 0-based page the entry points at, or null when it points nowhere usable. */
  readonly page: number | null;
  /** 0 for a top-level entry. */
  readonly depth: number;
}

/** An outline as a PDF reader hands it over: a tree whose destinations are already resolved to pages. */
export interface OutlineNode {
  readonly title: string;
  readonly page: number | null;
  readonly children: readonly OutlineNode[];
}

const MAX_ENTRIES = 2000;

/** Depth first, with depths. Titles are trimmed; a page outside the deck counts as none. */
export function flattenOutline(roots: readonly OutlineNode[], pageCount: number): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const walk = (nodes: readonly OutlineNode[], depth: number): void => {
    for (const node of nodes) {
      if (out.length >= MAX_ENTRIES) return;
      const page = node.page !== null && Number.isInteger(node.page) && node.page >= 0 && node.page < pageCount ? node.page : null;
      out.push({ title: node.title.replace(/\s+/g, " ").trim(), page, depth });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return out;
}

/**
 * The entry the talk is "in" at `page`: the last one, in reading order, that starts at or before
 * the page. -1 before the first entry, or when no entry has a page.
 */
export function currentEntry(entries: readonly OutlineEntry[], page: number): number {
  let current = -1;
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i]?.page;
    if (start === null || start === undefined) continue;
    if (start <= page) current = i;
    else break;
  }
  return current;
}

/**
 * Entries that can never be the current one: a section whose first subsection starts on the same
 * page (the subsection wins). They are listed without a frame number, which would promise a stop
 * that never comes.
 */
export function shadowedEntries(entries: readonly OutlineEntry[]): Set<number> {
  const shadowed = new Set<number>();
  for (let i = 0; i + 1 < entries.length; i++) {
    const page = entries[i]?.page;
    if (page !== null && page !== undefined && entries[i + 1]?.page === page) shadowed.add(i);
  }
  return shadowed;
}
