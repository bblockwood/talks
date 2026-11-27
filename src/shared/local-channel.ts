// The channel between the audience window and a presenter view in a second window on the same
// computer (two-screen mode, SPEC §5.2). It carries the same messages the relay does, unencrypted
// because they never leave the machine, plus the handover of the decrypted deck. The channel's
// name is random per talk and travels in the presenter window's URL hash.
import type { NoteOverride } from "../core/payload";
import type { NotesSplit } from "../core/split";

/** Everything a presenter view needs to render the deck and its notes by itself. */
export interface PresenterDeck {
  /** The decrypted PDF. In memory only; structured-cloned to the presenter window. */
  pdf: ArrayBuffer;
  title: string;
  split: NotesSplit | null;
  noteOverrides: NoteOverride[];
  pdfpcText: string | null;
  pptxNotes: { index: number; text: string }[];
  /** True when the browser placed the two windows itself and can exchange them (Swap displays). */
  canSwap?: boolean;
}

export type LocalFrame =
  /** A protocol message, as on the relay. `body` is validated by whoever receives it. */
  | { k: "msg"; sid: string; seq: number; to?: string; type: string; body: unknown }
  | { k: "deck-request" }
  | { k: "deck"; deck: PresenterDeck }
  /** Something the presenter should know, shown briefly. Never shown to the audience. */
  | { k: "notice"; text: string }
  /** The talk is over: the presenter window drops everything and closes. */
  | { k: "end" }
  /** The presenter window is closing. */
  | { k: "closed" };

/**
 * Sent from the presenter window straight to the audience window with `window.opener.postMessage`
 * and `delegate: "fullscreen"`, so the click in one window lets the other move its full screen.
 */
export const SWAP_MESSAGE = "lectern-swap-displays";

export const channelNameFromHash = (hash: string): string | null => /^#ch=([0-9a-f]{32})$/.exec(hash)?.[1] ?? null;

export function randomChannelName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const openLocalChannel = (name: string): BroadcastChannel => new BroadcastChannel(`lectern-${name}`);
