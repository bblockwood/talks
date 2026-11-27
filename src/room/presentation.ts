// Showing the slides (SPEC §5.2–5.3): this device's full-screen view for the audience. Keys and
// clicks become commands for the talk, and the view draws whatever the talk's host says, which
// is this device itself whenever it can be (see core/peer.ts). Leaving wipes everything here;
// the talk goes on for the other devices.
import { KeyInterpreter } from "../core/keys";
import { prefetchPages } from "../core/prefetch";
import { initialState } from "../core/session";
import type { Command } from "../core/session";
import { parseSplit } from "../core/split";
import type { RenderCache } from "../shared/render-cache";
import type { Talk } from "../shared/talk";
import { AudienceView } from "./audience";

export interface PresentationOptions {
  /** False when the user chose to show the slides in the window (full screen was blocked). */
  readonly fullscreen: boolean;
  /** Two-screen mode: the screen to put the slides on. Omitted, full screen uses the current screen. */
  readonly screen?: ScreenDetailed;
  /**
   * The browser can't place windows on screens itself, so the user will drag this one to the
   * projector: the Full screen button then stays in view until it has been used once.
   */
  readonly setup?: boolean;
  /** Esc twice: the slides are off this screen, but the device is still in the talk, choosing a view. */
  readonly onStopped: () => void;
  /** Called once this device has left the talk and everything decrypted has been dropped. */
  readonly onEnded: () => void;
}

export class Presentation {
  private readonly view: AudienceView;
  private readonly keys = new KeyInterpreter();
  private wakeLock: WakeLockSentinel | null = null;
  private keyboardLocked = false;
  private escapeDown = false;
  private ended = false;

  /** Two-screen mode: Ctrl+D or Cmd+D was pressed in the slides window (swap displays, Native §6.5). */
  onSwapKey: (() => void) | null = null;
  /** Two-screen mode: this view is going away, and the second window with it. */
  onEnding: (() => void) | null = null;

  /**
   * Starts showing the slides. Must be called synchronously from the click, because full screen
   * needs that user gesture. Resolves to null, with nothing changed, if full screen is refused.
   */
  static async start(talk: Talk, cache: RenderCache, root: HTMLElement, options: PresentationOptions): Promise<Presentation | null> {
    root.hidden = false;
    if (options.fullscreen) {
      try {
        await root.requestFullscreen(options.screen ? { navigationUI: "hide", screen: options.screen } : { navigationUI: "hide" });
      } catch {
        root.hidden = true;
        return null;
      }
    }
    return new Presentation(talk, cache, root, options);
  }

  private constructor(
    private readonly talk: Talk,
    private readonly cache: RenderCache,
    private readonly root: HTMLElement,
    private readonly options: PresentationOptions,
  ) {
    const deck = talk.deck;
    this.view = new AudienceView(root, cache, deck);
    this.view.onLink = (page, index) => this.dispatch({ name: "followLink", page, index }, performance.now());

    // Out of full screen, the slides stay in the window and every key still just drives them
    // (Ben, 2026-11-27). The way back is a button that shows only while the mouse is moving,
    // like the cursor, so nothing sits on top of the slides.
    const back = document.createElement("button");
    back.type = "button";
    back.className = "fs-button";
    back.textContent = "Full screen";
    back.addEventListener("click", (ev) => {
      ev.stopPropagation();
      back.blur();
      void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    });
    root.append(back);
    root.classList.toggle("setup", options.setup === true);
    this.showWindowed();

    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    if (document.fullscreenElement === root) void this.lockKeyboard();
    void this.requestWakeLock();

    talk.audience = {
      changed: (inputTime) => this.render(inputTime ?? performance.now()),
      pointer: (x, y, visible) => this.view.setPointer(x, y, visible),
      status: () => this.status(),
    };
    this.render(performance.now());
    // From here this device shows the slides: if it does not run the talk yet, it takes it over.
    talk.peer.setView("audience");

    if (import.meta.env.DEV) {
      // Development and e2e only: lets tests read the state without anything showing on the slides.
      (window as unknown as { __lectern?: unknown }).__lectern = {
        state: () => this.state(),
        session: () => talk.peer.session,
        role: () => talk.peer.role,
        shownPage: () => this.view.shownPage,
        links: (page: number) => deck.linksNow(page),
        frames: () => deck.frames.frames,
        keyboardLocked: () => this.keyboardLocked,
        pointerVisible: () => this.view.pointerVisible,
        inkShown: () => this.view.inkShown,
        drop: () => talk.dropForTest(),
      };
    }
  }

  /** What to show: the talk as it stands, or the first slide until that is known. */
  private state() {
    return this.talk.peer.viewState() ?? { ...initialState, timer: { ...initialState.timer, targetMs: this.talk.source.targetMs } };
  }

  /** A command from this window's own keyboard or mouse. `inputTime` is a `performance.now()` timestamp. */
  dispatch(command: Command, inputTime: number): void {
    if (!this.ended) this.talk.peer.dispatch(command, inputTime);
  }

  /** Moves the full-screen slides to another screen. Needs a user gesture, or one delegated to this window. */
  async moveToScreen(screen: ScreenDetailed): Promise<void> {
    await this.root.requestFullscreen({ navigationUI: "hide", screen });
  }

  /** Takes the slides off this screen: out of full screen, locks released, pixels dropped. */
  private async takeDown(): Promise<void> {
    this.ended = true;
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (import.meta.env.DEV) delete (window as unknown as { __lectern?: unknown }).__lectern;

    this.onEnding?.(); // two screens: the presenter window goes too
    this.onSwapKey = null;
    this.onEnding = null;
    this.talk.audience = null;
    this.view.wipe();
    this.root.hidden = true;
    this.root.classList.remove("windowed", "setup");
    navigator.keyboard?.unlock?.();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  }

  /**
   * Esc twice (Ben, 2026-11-27): the slides come off this screen and the device goes back to
   * choosing a view, still in the talk and with the deck in memory, so one click shows them again.
   */
  async stop(): Promise<void> {
    if (this.ended) return;
    await this.takeDown();
    this.talk.peer.setView(null);
    this.options.onStopped();
  }

  /** Leave (SPEC §5.3): this device is out of the talk and every decrypted byte and pixel is dropped. */
  async end(navigate = true): Promise<void> {
    if (this.ended) return;
    const leaving = this.talk.close();
    await this.takeDown();
    this.cache.wipe();
    await leaving;
    await this.talk.deck.destroy();
    if (navigate) this.options.onEnded();
  }

  /** This screen's own numbers, for presenter views only; none of it is ever shown to the audience. */
  private status(): { draw: { count: number; medianMs: number | null; lastMs: number | null; maxMs: number | null }; cacheMisses: number } {
    const draws = performance.getEntriesByName("lectern:input-to-draw").map((e) => e.duration);
    const sorted = [...draws].sort((a, b) => a - b);
    return {
      draw: {
        count: draws.length,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
        lastMs: draws.at(-1) ?? null,
        maxMs: sorted.at(-1) ?? null,
      },
      cacheMisses: this.cache.misses,
    };
  }

  private render(inputTime: number): void {
    if (this.ended) return;
    const deck = this.talk.deck;
    // Whoever runs the talk decides whether a Beamer notes panel is cropped away; follow it.
    const heard = this.talk.peer.heard;
    if (heard && parseSplit(heard.split) !== deck.split) {
      deck.setSplit(parseSplit(heard.split));
      this.cache.invalidate();
    }
    const state = this.state();
    const pages = prefetchPages(state, deck.frames);
    this.cache.want(pages);
    for (const page of pages) void deck.loadLinks(page);
    this.view.show(state, inputTime);
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.escapeDown = true;
    if (this.onSwapKey && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault(); // otherwise the browser bookmarks the page
      if (!ev.repeat) this.onSwapKey();
      return;
    }
    const result = this.keys.interpret(
      { key: ev.key, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, repeat: ev.repeat, time: ev.timeStamp },
      this.state(),
    );
    if (result.handled) ev.preventDefault();

    if (result.end) void this.stop();
    else if (result.command) this.dispatch(result.command, ev.timeStamp);
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.escapeDown = false;
  };

  /** Marks the slides as windowed or not, and on leaving full screen shows the way back for a moment. */
  private showWindowed(): void {
    const windowed = document.fullscreenElement !== this.root && document.fullscreenEnabled;
    const was = this.root.classList.contains("windowed");
    this.root.classList.toggle("windowed", windowed);
    if (!windowed) this.root.classList.remove("setup");
    if (windowed && !was) this.view.wake();
  }

  private readonly onFullscreenChange = (): void => {
    this.showWindowed();
    if (document.fullscreenElement === this.root) {
      void this.lockKeyboard();
      return;
    }
    const wasLocked = this.keyboardLocked;
    this.keyboardLocked = false;
    // With keyboard lock on, the browser leaves full screen only when Esc is held: that stops
    // showing the slides (SPEC §5.3). Without the lock a single stray Esc (some clickers send
    // one) also lands here, so any other exit keeps showing them in the window. Never fail on stage.
    if (wasLocked && this.escapeDown) void this.stop();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") void this.requestWakeLock();
  };

  private async lockKeyboard(): Promise<void> {
    const keyboard = navigator.keyboard;
    if (!keyboard?.lock) return;
    try {
      await keyboard.lock(["Escape"]);
      this.keyboardLocked = !this.ended;
    } catch {
      this.keyboardLocked = false;
    }
  }

  private async requestWakeLock(): Promise<void> {
    if (this.ended || !("wakeLock" in navigator) || (this.wakeLock && !this.wakeLock.released)) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (this.ended) void lock.release().catch(() => {});
      else this.wakeLock = lock;
    } catch {
      // Refused or unsupported: the talk goes on.
    }
  }
}
