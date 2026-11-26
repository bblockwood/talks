// Single source of truth (Native §3.2). Every input becomes a Command; the reducer is the only
// thing that produces a new SessionState; every view renders from the state. Ported from the
// native app's SessionReducer so both apps behave the same.
import type { FrameIndex } from "./frames";
import type { PageLink } from "./links";

export type AudienceMode =
  | { readonly kind: "live" }
  | { readonly kind: "frozen"; readonly page: number }
  | { readonly kind: "black" }
  | { readonly kind: "white" };

export const LIVE: AudienceMode = { kind: "live" };

/** Wire format is SPEC §8.2: `{name:"next"}`, `{name:"goToPage", page:12}`. */
export type Command =
  // `next`/`previous` step one page (one build). The frame commands move between frames.
  | { readonly name: "next" }
  | { readonly name: "previous" }
  | { readonly name: "nextFrame" }
  | { readonly name: "previousFrame" }
  | { readonly name: "goToPage"; readonly page: number }
  | { readonly name: "goToFrameLabel"; readonly label: string }
  /** `index` is the link's position in the link list of `page`. */
  | { readonly name: "followLink"; readonly page: number; readonly index: number }
  | { readonly name: "back" }
  | { readonly name: "forward" }
  | { readonly name: "setAudienceMode"; readonly mode: AudienceMode }
  // The talk clock (Native §6.7). It starts when presenting starts; these adjust it by hand.
  | { readonly name: "timerStart" }
  | { readonly name: "timerPause" }
  | { readonly name: "timerToggle" }
  | { readonly name: "timerReset" };

/** Times are milliseconds on the room PC's clock. */
export interface TimerState {
  /** Time accumulated before `runningSince`. */
  readonly accumulatedMs: number;
  /** Non-null while running. */
  readonly runningSince: number | null;
  /** Target length of the talk, if one is set. */
  readonly targetMs: number | null;
}

export function elapsedMs(timer: TimerState, now: number): number {
  return timer.accumulatedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince));
}

export interface SessionState {
  /** What the audience sees when `audienceMode` is live. 0-based. */
  readonly committedPage: number;
  readonly audienceMode: AudienceMode;
  /** Back stack of pages that jumps left (links, jump-by-number). Steps never touch it. */
  readonly history: readonly number[];
  /** Pages `back` left, for `forward`. Cleared by any new jump. */
  readonly forwardHistory: readonly number[];
  readonly timer: TimerState;
}

export const initialState: SessionState = {
  committedPage: 0,
  audienceMode: LIVE,
  history: [],
  forwardHistory: [],
  timer: { accumulatedMs: 0, runningSince: null, targetMs: null },
};

/** The page the audience surface shows, or null for black/white. */
export function audiencePage(state: SessionState): number | null {
  switch (state.audienceMode.kind) {
    case "live":
      return state.committedPage;
    case "frozen":
      return state.audienceMode.page;
    default:
      return null;
  }
}

const lastOther = (pages: readonly number[], current: number): number | null => {
  for (let i = pages.length - 1; i >= 0; i--) {
    const p = pages[i];
    if (p !== undefined && p !== current) return p;
  }
  return null;
};

/** Where `back` would go: the latest history entry that is not the page already shown. */
export const backTarget = (state: SessionState): number | null => lastOther(state.history, state.committedPage);
export const forwardTarget = (state: SessionState): number | null =>
  lastOther(state.forwardHistory, state.committedPage);

export interface DeckContext {
  readonly frames: FrameIndex;
  /** Links of a page, in annotation order. Undefined while they are still loading. */
  linksFor(page: number): readonly PageLink[] | undefined;
}

/**
 * Applies a command. Returns the same object when nothing changed, so views can skip work.
 * `now` is the room PC's clock in milliseconds; only the timer commands read it.
 */
export function apply(state: SessionState, command: Command, deck: DeckContext, now = 0): SessionState {
  switch (command.name) {
    case "timerStart":
      return state.timer.runningSince !== null ? state : { ...state, timer: { ...state.timer, runningSince: now } };
    case "timerPause":
      return state.timer.runningSince === null
        ? state
        : { ...state, timer: { ...state.timer, accumulatedMs: elapsedMs(state.timer, now), runningSince: null } };
    case "timerToggle":
      return apply(state, { name: state.timer.runningSince === null ? "timerStart" : "timerPause" }, deck, now);
    case "timerReset":
      // The clock runs whenever a talk is being presented, so a reset restarts it at once.
      return { ...state, timer: { ...state.timer, accumulatedMs: 0, runningSince: now } };
    default:
      break;
  }

  const { frames } = deck;
  if (frames.pageCount === 0) return state;
  const clamp = (page: number): number => frames.clamp(page);

  // Steps never push history.
  const stepTo = (page: number): SessionState => {
    const target = clamp(page);
    return target === state.committedPage ? state : { ...state, committedPage: target };
  };

  // Any jump that is not a step pushes the current page onto history.
  const jumpTo = (page: number): SessionState => {
    if (!Number.isFinite(page)) return state;
    const target = clamp(page);
    if (target === state.committedPage) return state;
    return {
      ...state,
      committedPage: target,
      history: [...state.history, state.committedPage],
      forwardHistory: [],
    };
  };

  // Entries for the page already shown are spent (the talk stepped back to where the jump came
  // from), so they are dropped rather than producing a no-op.
  const goBack = (): SessionState => {
    const history = [...state.history];
    while (history.length > 0) {
      const previous = clamp(history.pop() ?? 0);
      if (previous === state.committedPage) continue;
      return {
        ...state,
        committedPage: previous,
        history,
        forwardHistory: [...state.forwardHistory, state.committedPage],
      };
    }
    return state.history.length === 0 ? state : { ...state, history };
  };

  const goForward = (): SessionState => {
    const forwardHistory = [...state.forwardHistory];
    while (forwardHistory.length > 0) {
      const next = clamp(forwardHistory.pop() ?? 0);
      if (next === state.committedPage) continue;
      return {
        ...state,
        committedPage: next,
        history: [...state.history, state.committedPage],
        forwardHistory,
      };
    }
    return state.forwardHistory.length === 0 ? state : { ...state, forwardHistory };
  };

  switch (command.name) {
    case "next":
      return stepTo(state.committedPage + 1);
    case "previous":
      return stepTo(state.committedPage - 1);
    case "nextFrame":
      return stepTo(frames.nextFrameFirstPage(state.committedPage) ?? frames.pageCount - 1);
    case "previousFrame":
      return stepTo(frames.previousFrameLastPage(state.committedPage) ?? 0);
    case "goToPage":
      return jumpTo(command.page);
    case "goToFrameLabel": {
      const frame = frames.frameWithLabel(command.label);
      return frame ? jumpTo(frame.firstPage) : state;
    }
    case "followLink": {
      const link = deck.linksFor(command.page)?.[command.index];
      if (!link) return state;
      if (link.action.kind === "goToPage") return jumpTo(link.action.page);
      if (link.action.kind !== "named") return state; // URIs are ignored (SPEC §6.3)
      switch (link.action.action) {
        case "nextPage":
          return stepTo(state.committedPage + 1);
        case "previousPage":
          return stepTo(state.committedPage - 1);
        case "firstPage":
          return jumpTo(0);
        case "lastPage":
          return jumpTo(frames.pageCount - 1);
        case "goBack":
          return goBack();
        case "goForward":
          return goForward();
        default:
          return state;
      }
    }
    case "back":
      return goBack();
    case "forward":
      return goForward();
    case "setAudienceMode": {
      const mode = command.mode.kind === "frozen" ? { kind: "frozen" as const, page: clamp(command.mode.page) } : command.mode;
      const same =
        mode.kind === state.audienceMode.kind &&
        (mode.kind !== "frozen" || (state.audienceMode.kind === "frozen" && state.audienceMode.page === mode.page));
      return same ? state : { ...state, audienceMode: mode };
    }
    default:
      return state;
  }
}
