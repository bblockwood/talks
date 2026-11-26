// The code store: ~/.config/lectern/codes.json, mode 0600. The only place talk codes are kept.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config.ts";

export interface StoredDeck {
  code: string;
  /** Absolute path of the PDF last published under this key. */
  source: string;
  /** ISO 8601 time of the last publish. */
  published: string;
}

export interface CodeStore {
  version: 1;
  /** Keyed by `--name`, or else by the PDF's absolute path. */
  decks: Record<string, StoredDeck>;
}

export const storePath = (): string => path.join(configDir(), "codes.json");

export function loadStore(): CodeStore {
  let text: string;
  try {
    text = readFileSync(storePath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, decks: {} };
    throw e;
  }
  const raw = JSON.parse(text) as Partial<CodeStore>;
  if (raw.version !== 1 || typeof raw.decks !== "object" || raw.decks === null) {
    throw new Error(`${storePath()} is not a Lectern code store this version understands`);
  }
  return { version: 1, decks: raw.decks };
}

export function saveStore(store: CodeStore): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Write-then-rename, so a crash can't leave a half-written store.
  const tmp = `${storePath()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, storePath());
}

/** The store key for a deck: its `--name`, or the PDF's absolute path. */
export function deckKey(pdfPath: string, name: string | undefined): string {
  return name ?? path.resolve(pdfPath);
}

/** Finds a deck by key, by `--name`, or by the path of a PDF. */
export function findDeck(store: CodeStore, nameOrFile: string): string | null {
  if (nameOrFile in store.decks) return nameOrFile;
  const abs = path.resolve(nameOrFile);
  if (abs in store.decks) return abs;
  const bySource = Object.entries(store.decks).filter(([, d]) => d.source === abs);
  return bySource.length === 1 ? (bySource[0]?.[0] ?? null) : null;
}

/** The key of another deck already using `code`, if any. Two decks with one code would overwrite each other. */
export function codeOwner(store: CodeStore, code: string, exceptKey: string): string | null {
  for (const [key, deck] of Object.entries(store.decks)) {
    if (key !== exceptKey && deck.code === code) return key;
  }
  return null;
}
