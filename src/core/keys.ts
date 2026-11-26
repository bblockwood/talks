// The default key map (Native §6.5, SPEC §5.3) as a pure interpreter: key in, command out.
// Clickers send Page Up/Down, B or ".", and F5/Esc; all of those must be handled here.
import { LIVE } from "./session";
import type { Command, SessionState } from "./session";

export interface KeyInput {
  /** `KeyboardEvent.key`. */
  readonly key: string;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly repeat: boolean;
  /** Milliseconds on any monotonic clock. */
  readonly time: number;
}

export interface KeyResult {
  /** True when the key is ours and the browser's default action must be suppressed. */
  readonly handled: boolean;
  readonly command?: Command;
  /** End the talk (Esc twice within a second). */
  readonly end?: boolean;
}

export const ESCAPE_WINDOW_MS = 1000;
const MAX_DIGITS = 6;

const NEXT = new Set(["ArrowRight", "ArrowDown", " ", "PageDown", "n", "N"]);
const PREVIOUS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "p", "P"]);
/** Keys that belong to later milestones (overview, laser, draw, timer) or would disturb the talk (F5 reloads). */
const SWALLOWED = new Set(["Tab", "F5", "l", "L", "d", "D", "c", "C", "t", "T", "?"]);

const HANDLED: KeyResult = { handled: true };
const IGNORED: KeyResult = { handled: false };
const run = (command: Command): KeyResult => ({ handled: true, command });

export class KeyInterpreter {
  private digits = "";
  private lastEscape = -Infinity;

  /** Digits typed so far for jump-by-number. */
  get typedDigits(): string {
    return this.digits;
  }

  interpret(input: KeyInput, state: SessionState): KeyResult {
    const { key } = input;

    // Back / forward across jumps: Cmd+[ and Cmd+] (Native §6.5). Every other shortcut with
    // Ctrl, Alt or Cmd belongs to the browser or the OS.
    if (input.meta && !input.ctrl && !input.alt && (key === "[" || key === "]")) {
      this.digits = "";
      return input.repeat ? HANDLED : run({ name: key === "[" ? "back" : "forward" });
    }
    if (input.ctrl || input.alt || input.meta) return IGNORED;
    if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return IGNORED;

    if (key === "Escape") {
      if (input.repeat) return HANDLED;
      // A single Esc first clears typed digits; only then does it count towards ending.
      if (this.digits !== "") {
        this.digits = "";
        return HANDLED;
      }
      if (input.time - this.lastEscape <= ESCAPE_WINDOW_MS) {
        this.lastEscape = -Infinity;
        return { handled: true, end: true };
      }
      this.lastEscape = input.time;
      return HANDLED;
    }

    if (key.length === 1 && key >= "0" && key <= "9") {
      if (this.digits.length < MAX_DIGITS) this.digits += key;
      return HANDLED;
    }

    if (key === "Enter") {
      const label = this.digits;
      this.digits = "";
      // Return with no digits typed means `next`.
      if (label === "") return run({ name: "next" });
      return input.repeat ? HANDLED : run({ name: "goToFrameLabel", label });
    }

    // Any other key abandons a half-typed number.
    this.digits = "";

    if (input.shift && key === "ArrowRight") return run({ name: "nextFrame" });
    if (input.shift && key === "ArrowLeft") return run({ name: "previousFrame" });
    if (NEXT.has(key)) return run({ name: "next" });
    if (PREVIOUS.has(key)) return run({ name: "previous" });

    if (key === "Backspace" || key === "Delete") return input.repeat ? HANDLED : run({ name: "back" });

    // Toggles ignore auto-repeat, or holding the key would flicker the screen.
    const mode = state.audienceMode.kind;
    if (key === "b" || key === "B" || key === ".") {
      if (input.repeat) return HANDLED;
      return run({ name: "setAudienceMode", mode: mode === "black" ? LIVE : { kind: "black" } });
    }
    if (key === "w" || key === "W") {
      if (input.repeat) return HANDLED;
      return run({ name: "setAudienceMode", mode: mode === "white" ? LIVE : { kind: "white" } });
    }
    if (key === "f" || key === "F") {
      if (input.repeat) return HANDLED;
      return run({
        name: "setAudienceMode",
        mode: mode === "frozen" ? LIVE : { kind: "frozen", page: state.committedPage },
      });
    }

    return SWALLOWED.has(key) ? HANDLED : IGNORED;
  }
}
