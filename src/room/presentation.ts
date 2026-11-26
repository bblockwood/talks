// Presenting (SPEC §5.2–5.3): the audience window while a talk is running. It wraps the session
// host with the screen: keys and clicks become Commands, the audience view draws the state, and
// every presenter view (a second window here, or other devices through the relay) is kept in
// step. Ending wipes everything.
import { SessionHost } from "../core/host";
import { KeyInterpreter } from "../core/keys";
import { prefetchPages } from "../core/prefetch";
import type { Envelope, Message } from "../core/protocol";
import type { Command, SessionState } from "../core/session";
import type { Deck } from "../shared/deck";
import { deviceName } from "../shared/relay-client";
import type { RenderCache } from "../shared/render-cache";
import { AudienceView } from "./audience";

const HEARTBEAT_MS = 5000;

/** A connection to presenter views: the relay, or the local channel to a second window. */
export interface HostTransport {
  onMessage: ((envelope: Envelope) => void) | null;
  /** Called with "connected" when the connection (re)opens, so the host can resync its listeners. */
  onStatus: ((status: string) => void) | null;
  readonly status: string;
  send(message: Message): void;
  close(): void;
}

export interface PresentationOptions {
  /** False when the user chose to present in the window (full screen was blocked). */
  readonly fullscreen: boolean;
  /** Two-screen mode: the screen to put the audience view on. Omitted, full screen uses the current screen. */
  readonly screen?: ScreenDetailed;
  /** Called once everything decrypted has been dropped. */
  readonly onEnded: () => void;
  /** The relay connection, when the deck was opened by code. Null means keyboard and clicker only. */
  readonly relay: HostTransport | null;
  /** `meta.published` of the open deck, so presenter views can tell their copy is stale. */
  readonly deckPublished: string;
  /** Target length of the talk for the clock, if the deck sets one. */
  readonly targetMs: number | null;
}

export class Presentation {
  private readonly host: SessionHost;
  private readonly view: AudienceView;
  private readonly keys = new KeyInterpreter();
  private readonly transports = new Set<HostTransport>();
  private wakeLock: WakeLockSentinel | null = null;
  private keyboardLocked = false;
  private escapeDown = false;
  private ended = false;
  private readonly heartbeat: number;

  /** Two-screen mode: Ctrl+D or Cmd+D was pressed in the audience window (swap displays, Native §6.5). */
  onSwapKey: (() => void) | null = null;

  /**
   * Starts presenting. Must be called synchronously from the Start click, because full screen
   * needs that user gesture. Resolves to null, with nothing changed, if full screen is refused.
   */
  static async start(
    deck: Deck,
    cache: RenderCache,
    root: HTMLElement,
    options: PresentationOptions,
  ): Promise<Presentation | null> {
    root.hidden = false;
    if (options.fullscreen) {
      try {
        await root.requestFullscreen(
          options.screen ? { navigationUI: "hide", screen: options.screen } : { navigationUI: "hide" },
        );
      } catch {
        root.hidden = true;
        return null;
      }
    }
    return new Presentation(deck, cache, root, options);
  }

  private constructor(
    private readonly deck: Deck,
    private readonly cache: RenderCache,
    private readonly root: HTMLElement,
    private readonly options: PresentationOptions,
  ) {
    this.view = new AudienceView(root, cache, deck);
    this.view.onLink = (page, index) => this.dispatch({ name: "followLink", page, index }, performance.now());

    this.host = new SessionHost(
      {
        get frames() {
          return deck.frames;
        },
        get split() {
          return deck.split;
        },
        linksFor: (page) => deck.linksNow(page),
      },
      { deckPublished: options.deckPublished, targetMs: options.targetMs, device: deviceName() },
      {
        now: () => Date.now(),
        send: (message) => {
          for (const transport of this.transports) transport.send(message);
        },
        applied: (state, inputTime) => this.render(state, inputTime ?? performance.now()),
        pointer: (x, y, visible) => this.view.setPointer(x, y, visible),
        end: () => void this.end(),
        status: () => this.status(),
      },
    );

    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pagehide", this.onPageHide);

    if (document.fullscreenElement === root) void this.lockKeyboard();
    void this.requestWakeLock();
    this.render(this.host.state, performance.now());

    if (options.relay) this.addTransport(options.relay);
    this.heartbeat = window.setInterval(() => this.host.broadcast(), HEARTBEAT_MS);

    if (import.meta.env.DEV) {
      // Development and e2e only: lets tests read the state without anything showing on the audience view.
      (window as unknown as { __lectern?: unknown }).__lectern = {
        state: () => this.host.state,
        session: () => this.host.session,
        shownPage: () => this.view.shownPage,
        links: (page: number) => this.deck.linksNow(page),
        frames: () => this.deck.frames.frames,
        keyboardLocked: () => this.keyboardLocked,
        pointerVisible: () => this.view.pointerVisible,
        inkShown: () => this.view.inkShown,
      };
    }
  }

  /** Connects a set of presenter views. They are told who this is and what the state is. */
  addTransport(transport: HostTransport): void {
    if (this.ended) return;
    this.transports.add(transport);
    transport.onMessage = (envelope) => {
      if (!this.ended) this.host.receive(envelope);
    };
    transport.onStatus = (status) => {
      if (status === "connected" && !this.ended) this.host.announce(); // resync whoever is listening
    };
    this.host.announce();
  }

  removeTransport(transport: HostTransport): void {
    this.transports.delete(transport);
    transport.onMessage = null;
    transport.onStatus = null;
  }

  /** Applies a command from this window's own keyboard or mouse. `inputTime` is a `performance.now()` timestamp. */
  dispatch(command: Command, inputTime: number): void {
    if (!this.ended) this.host.dispatch(command, inputTime);
  }

  /** Moves the full-screen audience view to another screen. Needs a user gesture, or one delegated to this window. */
  async moveToScreen(screen: ScreenDetailed): Promise<void> {
    await this.root.requestFullscreen({ navigationUI: "hide", screen });
  }

  /** End (SPEC §5.3): leave full screen, release locks, drop every decrypted byte and pixel. */
  async end(navigate = true): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pagehide", this.onPageHide);
    if (import.meta.env.DEV) delete (window as unknown as { __lectern?: unknown }).__lectern;

    window.clearInterval(this.heartbeat);
    for (const transport of this.transports) transport.close();
    this.transports.clear();
    this.onSwapKey = null;
    this.view.wipe();
    this.cache.wipe();
    this.root.hidden = true;
    navigator.keyboard?.unlock?.();
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    await this.deck.destroy();
    if (navigate) this.options.onEnded();
  }

  /** The room PC's own status, for presenter views only; none of it is ever shown to the audience. */
  private status(): { relay: string; draw: { count: number; medianMs: number | null; lastMs: number | null; maxMs: number | null }; cacheMisses: number } {
    const draws = performance.getEntriesByName("lectern:input-to-draw").map((e) => e.duration);
    const sorted = [...draws].sort((a, b) => a - b);
    return {
      relay: this.options.relay?.status ?? "unavailable",
      draw: {
        count: draws.length,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? null,
        lastMs: draws.at(-1) ?? null,
        maxMs: sorted.at(-1) ?? null,
      },
      cacheMisses: this.cache.misses,
    };
  }

  private render(state: SessionState, inputTime: number): void {
    const pages = prefetchPages(state, this.deck.frames);
    this.cache.want(pages);
    for (const page of pages) void this.deck.loadLinks(page);
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
      {
        key: ev.key,
        shift: ev.shiftKey,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        meta: ev.metaKey,
        repeat: ev.repeat,
        time: ev.timeStamp,
      },
      this.host.state,
    );
    if (result.handled) ev.preventDefault();

    // If the browser dropped out of full screen (a stray Esc where keyboard lock isn't available),
    // any other key press is a user gesture that lets us go straight back in.
    if (this.options.fullscreen && !document.fullscreenElement && ev.key !== "Escape" && !result.end) {
      void this.root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }

    if (result.end) void this.end();
    else if (result.command) this.dispatch(result.command, ev.timeStamp);
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.escapeDown = false;
  };

  private readonly onFullscreenChange = (): void => {
    if (document.fullscreenElement === this.root) {
      void this.lockKeyboard();
      return;
    }
    const wasLocked = this.keyboardLocked;
    this.keyboardLocked = false;
    // With keyboard lock on, the browser leaves full screen only when Esc is held: that ends the
    // talk (SPEC §5.3). Without the lock a single stray Esc (some clickers send one) also lands
    // here, so any other exit keeps presenting in the window. Never fail on stage.
    if (wasLocked && this.escapeDown) void this.end();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") void this.requestWakeLock();
  };

  private readonly onPageHide = (): void => {
    void this.end(false);
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
