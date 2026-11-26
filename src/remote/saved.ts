// Talks remembered on this phone (SPEC §7, §9). Only used when the user ticks
// "Remember on this device"; nothing is stored otherwise. Never used on the room PC.

export interface SavedTalk {
  readonly code: string;
  readonly title: string;
  readonly savedAt: string;
}

const KEY = "lectern.savedTalks";
const SIZE_KEY = "lectern.notesSize";

export function loadSaved(): SavedTalk[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is SavedTalk =>
        typeof t === "object" && t !== null && typeof (t as SavedTalk).code === "string" && typeof (t as SavedTalk).title === "string",
    );
  } catch {
    return [];
  }
}

function store(talks: SavedTalk[]): void {
  try {
    if (talks.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(talks));
  } catch {
    // Private browsing or a full store: remembering is a convenience, not a requirement.
  }
}

export function remember(code: string, title: string): void {
  const rest = loadSaved().filter((t) => t.code !== code);
  store([{ code, title, savedAt: new Date().toISOString() }, ...rest].slice(0, 30));
}

export function forget(code: string): void {
  store(loadSaved().filter((t) => t.code !== code));
}

export function isSaved(code: string): boolean {
  return loadSaved().some((t) => t.code === code);
}

export function loadNotesSize(): number | null {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return Number.isFinite(n) && n >= 12 && n <= 40 ? n : null;
  } catch {
    return null;
  }
}

export function saveNotesSize(px: number): void {
  try {
    localStorage.setItem(SIZE_KEY, String(px));
  } catch {
    // See above.
  }
}
