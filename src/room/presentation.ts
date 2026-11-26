// Presenting in Mode A (SPEC §5.2–5.3): owns the session state while a talk is running, turns
// keys and clicks into Commands, and wipes everything at the end.
import { KeyInterpreter } from "../core/keys";
import { prefetchPages } from "../core/prefetch";
import { stateBody } from "../core/protocol";
import type { Ack, Envelope } from "../core/protocol";
import { apply, initialState } from "../core/session";
import type { Command, DeckContext, SessionState } from "../core/session";
import type { Deck } from "../shared/deck";
import type { RenderCache } from "../shared/render-cache";
import { AudienceView } from "./audience";
import type { RoomLink } from "./room-link";

const HEARTBEAT_MS = 5000;

export interface PresentationOptions {
  /** False when the user chose to present in the window (full screen was blocked). */
  readonly fullscreen: boolean;
  /** Called once everything decrypted has been dropped. */
  readonly onEnded: () => void;
  /** The relay connection, when the deck was opened by code. Null means keyboard and clicker only. */
  readonly link: RoomLink | null;
  /** `meta.published` of the open deck, sent to phones so they can tell their copy is stale. */
  readonly deckPublished: string;
  /** Target length of the talk for the clock, if the deck sets one. */
  readonly targetMs: number | null;
}

export class Presentation {
  private state: SessionState = initialState;
  private readonly view: AudienceView;
  private readonly keys = new KeyInterpreter();
  private readonly context: DeckContext;
  private wakeLock: WakeLockSentinel | null = null;
  private keyboardLocked = false;
  private escapeDown = false;
  private ended = false;
  private heartbeat: number | undefined;

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
        await root.requestFullscreen({ navigationUI: "hide" });
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
    this.context = { frames: deck.frames, linksFor: (page) => deck.linksNow(page) };
    this.view = new AudienceView(root, cache, deck);
    this.view.onLink = (page, index) => this.dispatch({ name: "followLink", page, index }, performance.now());

    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pagehide", this.onPageHide);

    if (document.fullscreenElement === root) void this.lockKeyboard();
    void this.requestWakeLock();
    // The clock runs while presenting (Native §6.7).
    this.state = { ...initialState, timer: { accumulatedMs: 0, runningSince: Date.now(), targetMs: options.targetMs } };
    this.render(performance.now());

    const link = options.link;
    if (link) {
      link.onMessage = this.onRelayMessage;
      link.onStatus = (status) => {
        if (status === "connected") this.broadcast(); // resync whoever is listening after a reconnect
      };
      this.heartbeat = window.setInterval(() => this.broadcast(), HEARTBEAT_MS);
      this.broadcast();
    }

    if (import.meta.env.DEV) {
      // Development and e2e only: lets tests read the state without anything showing on the audience view.
      (window as unknown as { __lectern?: unknown }).__lectern = {
        state: () => this.state,
        shownPage: () => this.view.shownPage,
        links: (page: number) => this.deck.linksNow(page),
        frames: () => this.deck.frames.frames,
        keyboardLocked: () => this.keyboardLocked,
        pointerVisible: () => this.view.pointerVisible,
      };
    }
  }

  /**
   * Applies a command from any input. `inputTime` is a `performance.now()` timestamp. `ack` names
   * the relay message that carried the command, so its sender can time the round trip.
   */
  dispatch(command: Command, inputTime: number, ack?: Ack): void {
    if (this.ended) return;
    const next = apply(this.state, command, this.context, Date.now());
    if (next !== this.state) {
      this.state = next;
      this.render(inputTime);
      this.broadcast(ack);
    } else if (ack) {
      this.broadcast(ack); // nothing changed (e.g. Next on the last slide), but the sender still gets its answer
    }
  }

  /** The room PC is authoritative: it sends `state` after every change and as a heartbeat (SPEC §8.2). */
  private broadcast(ack?: Ack): void {
    if (this.ended) return;
    this.options.link?.send({
      type: "state",
      body: stateBody(this.state, this.deck.frames, Date.now(), this.options.deckPublished, ack),
    });
  }

  private readonly onRelayMessage = (envelope: Envelope): void => {
    if (this.ended) return;
    switch (envelope.type) {
      case "hello":
        if (envelope.body.role !== "room") this.broadcast(); // late joiners sync
        break;
      case "command":
        // Anyone who can decrypt is authorised: knowing the code is the credential (SPEC §8.2).
        this.dispatch(envelope.body, performance.now(), { sid: envelope.sid, seq: envelope.seq });
        break;
      case "pointer":
        this.view.setPointer(envelope.body.x, envelope.body.y, envelope.body.visible);
        break;
      case "ping":
        this.options.link?.send({ type: "pong", body: { t: envelope.body.t } });
        break;
      case "end":
        void this.end();
        break;
      default:
        break;
    }
  };

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
    this.options.link?.close();
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

  private render(inputTime: number): void {
    const pages = prefetchPages(this.state, this.deck.frames);
    this.cache.want(pages);
    for (const page of pages) void this.deck.loadLinks(page);
    this.view.show(this.state, inputTime);
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.escapeDown = true;
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
      this.state,
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
