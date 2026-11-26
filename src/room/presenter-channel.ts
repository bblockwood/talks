// Messages between the audience window and the presenter window in Mode B (SPEC §5.2). Both are
// same-origin windows on the room PC, joined by a BroadcastChannel with a random name; nothing
// here leaves the machine. The audience window stays authoritative.
import type { NoteOverride } from "../core/payload";
import type { Command, SessionState } from "../core/session";
import type { NotesSplit } from "../core/split";

/** Everything the presenter window needs to render the deck and its notes by itself. */
export interface PresenterDeck {
  /** The decrypted PDF. In memory only; structured-cloned to the presenter window. */
  pdf: ArrayBuffer;
  title: string;
  split: NotesSplit | null;
  noteOverrides: NoteOverride[];
  pdfpcText: string | null;
  pptxNotes: { index: number; text: string }[];
}

export interface PresenterInfo {
  relay: string;
  /** Phones and other remotes heard from in the last few seconds. */
  remotes: string[];
  draw: { count: number; medianMs: number | null; lastMs: number | null; maxMs: number | null };
  cacheMisses: number;
}

export type ToPresenter =
  | { t: "deck"; deck: PresenterDeck }
  | { t: "state"; state: SessionState; info: PresenterInfo }
  /** Something the presenter should know, shown briefly in the status bar. Never shown to the audience. */
  | { t: "notice"; text: string }
  | { t: "end" };

/**
 * Sent from the presenter window straight to the audience window with `window.opener.postMessage`
 * and `delegate: "fullscreen"`, so the click in one window lets the other move its full screen.
 */
export const SWAP_MESSAGE = "lectern-swap-displays";

export type ToAudience =
  | { t: "ready" }
  | { t: "command"; command: Command }
  | { t: "pointer"; x: number; y: number; visible: boolean }
  | { t: "end" }
  | { t: "closed" };

export const channelNameFromHash = (hash: string): string | null => /^#ch=([0-9a-f]{32})$/.exec(hash)?.[1] ?? null;

export function randomChannelName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
