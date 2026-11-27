// Showing the slides (SPEC §5.2–5.3): this device's full-screen view for the audience. Keys and
// clicks become commands for the talk, and the view draws whatever the talk's host says, which
// is this device itself whenever it can be (see core/peer.ts). Leaving wipes everything here;
// the talk goes on for the other devices.
import { stageKeysInfo } from "../console/info";
import { buildCount } from "../core/frames";
import { DEFAULT_INK_WIDTH, INK_COLORS } from "../core/ink";
import { KeyInterpreter } from "../core/keys";
import { prefetchPages } from "../core/prefetch";
import { formatClock, renderNotesHtml } from "../core/markdown";
import type { Message } from "../core/protocol";
import { LIVE, elapsedMs, initialState } from "../core/session";
import type { Command } from "../core/session";
import { parseSplit } from "../core/split";
import { APPLE_TOUCH, IS_MAC, setStage } from "../shared/device";
import { ThumbGrid } from "../shared/thumbs";
import type { RenderCache } from "../shared/render-cache";
import type { Talk } from "../shared/talk";
import { AudienceView } from "./audience";
import type { StageTool } from "./audience";

/** At most ~30 pointer or ink messages a second, well under the relay's limit. */
const SEND_INTERVAL_MS = 33;
/** The bar goes this long after the mouse leaves it. */
const BAR_LINGER_MS = 1200;

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

  /** The bar a double tap brings up on a touch screen: where the talk is, the clock, the connection, Exit. */
  private bar!: HTMLElement;
  private barTimer: number | undefined;
  private barHide: number | undefined;
  /** `performance.now()` when the followed host's state last arrived, for running its clock on. */
  private heardAt = 0;

  // With one device and one screen, the slides are run from here (Ben, 2026-11-27): the
  // presenter view's keys and tools work on the slides themselves. Nothing below is on screen
  // unless the presenter asks for it.
  /** The tool was chosen on the bar by touch, so the bar stays up to turn it off again. */
  private barPinned = false;
  private barHovered = false;
  private help: HTMLElement | null = null;
  private overview: HTMLElement | null = null;
  private thumbs: ThumbGrid | null = null;
  private digits!: HTMLElement;
  private inkColor = 0;
  /** Stroke numbers start somewhere new each time, so they never repeat one already on the slide. */
  private strokeSeq = (Date.now() % 1_000_000) * 1000;
  private activeStroke: number | null = null;
  private pendingPoints: number[] = [];
  private inkTimer: number | undefined;
  private pointerSentAt = 0;

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
    // A touch screen showing the slides (an iPad mirrored to the projector) runs the talk by
    // touch: tap or swipe to step. With no Esc key, two quick taps bring up a bar like the
    // presenter view's status bar, with Exit; a tap anywhere else puts it away again.
    this.view.onStep = (name) => this.dispatch({ name }, performance.now());
    this.view.onDoubleTap = () => this.showBar(this.bar.hidden !== false);
    this.view.intercept = () => {
      if (this.help) {
        this.showHelp(false);
        return true;
      }
      if (this.bar.hidden || this.barPinned || this.overview) return false;
      this.showBar(false);
      return true;
    };
    this.view.onPoint = (x, y, visible) => this.point(x, y, visible);
    this.view.onInk = (op) => {
      if (op.kind === "end") this.endInk();
      else if (op.kind === "begin") this.beginInk(op.x, op.y);
      else this.pendingPoints.push(op.x, op.y);
    };
    this.bar = this.buildBar();
    this.digits = document.createElement("div");
    this.digits.className = "aud-digits";
    this.digits.hidden = true;
    root.append(this.bar, this.digits);
    root.addEventListener("mousemove", this.onRootMouseMove);
    setStage(true);

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
      changed: (inputTime) => {
        this.heardAt = performance.now();
        this.render(inputTime ?? performance.now());
        if (!this.bar.hidden) this.fillBar();
        if (this.thumbs) this.thumbs.mark(this.state().committedPage);
      },
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
        tool: () => this.view.tool,
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

  // ---------------------------------------------------------------- the bar

  private buildBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "aud-bar";
    bar.hidden = true;
    const part = (cls: string): HTMLElement => {
      const el = document.createElement("span");
      el.className = cls;
      return el;
    };
    const button = (cls: string, label: string, title: string, act: (ev: MouseEvent) => void): HTMLButtonElement => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = cls;
      el.textContent = label;
      el.title = title;
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        el.blur(); // or Space and Enter would press it again instead of stepping
        act(ev);
      });
      return el;
    };
    // A tool chosen by touch keeps the bar up: with it on, a tap no longer brings the bar back.
    const byTouch = (ev: MouseEvent): boolean => (ev as PointerEvent).pointerType !== undefined && (ev as PointerEvent).pointerType !== "mouse" && (ev as PointerEvent).pointerType !== "";
    const mode = (kind: "black" | "white"): void =>
      this.dispatch({ name: "setAudienceMode", mode: this.state().audienceMode.kind === kind ? LIVE : { kind } }, performance.now());

    const tools = part("aud-tools");
    const drawbar = part("aud-drawbar");
    INK_COLORS.forEach((color, i) => {
      const dot = button("aud-color", "", `Ink colour ${i + 1}`, () => {
        this.inkColor = i;
        this.fillBar();
      });
      dot.dataset["color"] = String(i);
      dot.style.background = color;
      drawbar.append(dot);
    });
    drawbar.append(
      button("aud-tool", "Undo", "Remove the last stroke", () => this.send({ type: "ink", body: { op: "undo" } })),
      button("aud-tool", "Clear", "Clear the ink (C)", () => this.send({ type: "ink", body: { op: "clear" } })),
    );
    tools.append(
      button("aud-tool aud-overview-b", "Overview", "All frames at a glance (Tab)", () => this.showOverview(!this.overview)),
      button("aud-tool aud-laser", "Laser", "Point with the mouse or a finger (L)", (ev) => this.setTool(this.view.tool === "laser" ? "none" : "laser", byTouch(ev))),
      button("aud-tool aud-draw", "Draw", "Draw on the slide (D)", (ev) => this.setTool(this.view.tool === "draw" ? "none" : "draw", byTouch(ev))),
      drawbar,
      button("aud-tool aud-black", "Black", "Black screen (B)", () => mode("black")),
      button("aud-tool aud-white", "White", "White screen, to draw on (W)", () => mode("white")),
      part("aud-spacer"),
      button("aud-tool aud-back", "", "Back to where the last jump started", () => this.dispatch({ name: "back" }, performance.now())),
      button("aud-tool aud-forward", "", "Forward again", () => this.dispatch({ name: "forward" }, performance.now())),
      button("aud-tool aud-help-b", "?", "Keyboard shortcuts (?)", () => this.showHelp(!this.help)),
    );

    const status = part("aud-status");
    const right = part("aud-right");
    right.append(
      part("aud-link"),
      button("aud-exit", "Exit", "Back to the page where a view is chosen (Esc twice)", () => void this.stop()),
    );
    status.append(part("aud-where"), part("aud-clock"), right);
    bar.append(tools, status);
    bar.addEventListener("mouseenter", () => {
      this.barHovered = true;
      window.clearTimeout(this.barHide);
    });
    bar.addEventListener("mouseleave", () => {
      this.barHovered = false;
      this.lingerBar(BAR_LINGER_MS);
    });
    return bar;
  }

  private showBar(on: boolean): void {
    if (this.ended) return;
    this.bar.hidden = !on;
    window.clearInterval(this.barTimer);
    window.clearTimeout(this.barHide);
    if (!on) {
      this.barPinned = false;
      return;
    }
    this.fillBar();
    this.barTimer = window.setInterval(() => this.fillBar(), 500);
    this.lingerBar(10_000);
  }

  /** Not left on the audience's screen: the bar goes by itself, unless it is in use. */
  private lingerBar(ms: number): void {
    window.clearTimeout(this.barHide);
    if (this.bar.hidden) return;
    this.barHide = window.setTimeout(() => {
      if (this.barPinned || this.barHovered || this.overview) return;
      this.showBar(false);
    }, ms);
  }

  /** The mouse at the very bottom of the screen brings the bar up, as the Dock or a video player's controls come up. */
  private readonly onRootMouseMove = (ev: MouseEvent): void => {
    if (!this.bar.hidden || this.ended) return;
    const box = this.root.getBoundingClientRect();
    if (ev.clientY >= box.bottom - 3) this.showBar(true);
  };

  private fillBar(): void {
    const deck = this.talk.deck;
    const peer = this.talk.peer;
    const state = this.state();
    const frames = deck.frames;
    const frame = frames.frameContaining(state.committedPage);
    const builds = frame ? frame.lastPage - frame.firstPage + 1 : 1;
    const set = (cls: string, text: string): HTMLElement => {
      const el = this.bar.querySelector<HTMLElement>(`.${cls}`) as HTMLElement;
      if (el.textContent !== text) el.textContent = text;
      return el;
    };
    set("aud-where", frame ? `Frame ${frame.label} / ${frames.frameCount}${builds > 1 ? `   Build ${frames.buildIndex(state.committedPage) + 1}/${builds}` : ""}` : "");

    // The tools, lit as in the presenter view.
    const tool = this.view.tool;
    const kind = state.audienceMode.kind;
    const lit = (cls: string, on: boolean): void => void this.bar.querySelector(`.${cls}`)?.classList.toggle("on", on);
    lit("aud-overview-b", this.overview !== null);
    lit("aud-laser", tool === "laser");
    lit("aud-draw", tool === "draw");
    lit("aud-black", kind === "black");
    lit("aud-white", kind === "white");
    (this.bar.querySelector(".aud-drawbar") as HTMLElement).hidden = tool !== "draw";
    for (const dot of this.bar.querySelectorAll<HTMLElement>(".aud-color")) dot.classList.toggle("on", Number(dot.dataset["color"]) === this.inkColor);
    // Back and Forward only when there is somewhere to go: "← 8.2", "9 →".
    const target = (list: readonly number[]): number | null => {
      for (let i = list.length - 1; i >= 0; i--) if (list[i] !== undefined && list[i] !== state.committedPage) return list[i] as number;
      return null;
    };
    const short = (page: number): string => {
      const to = frames.frameContaining(page);
      return !to ? "" : buildCount(to) > 1 ? `${to.label}.${frames.buildIndex(page) + 1}` : to.label;
    };
    const back = target(state.history);
    const forward = target(state.forwardHistory);
    set("aud-back", back === null ? "" : `← ${short(back)}`).hidden = back === null;
    set("aud-forward", forward === null ? "" : `${short(forward)} →`).hidden = forward === null;

    // The clock: this device's own when it runs the talk, otherwise the host's as last heard, run on from then.
    const heard = peer.heard;
    const running = heard ? heard.timer.running : state.timer.runningSince !== null;
    const elapsed = heard ? heard.timer.elapsedMs + (heard.timer.running ? performance.now() - this.heardAt : 0) : elapsedMs(state.timer, Date.now());
    const targetMs = heard ? heard.timer.targetMs : state.timer.targetMs;
    const left = targetMs === null ? null : targetMs - elapsed;
    const over = left !== null && left <= -1000;
    const paused = !running && elapsed > 0;
    const clock = set("aud-clock", `${left === null ? formatClock(elapsed) : `${over ? "−" : ""}${formatClock(Math.abs(left))}`} ${paused ? "paused" : left === null ? "↑" : "↓"}`);
    clock.className = `aud-clock${!running ? " paused" : left === null ? "" : over ? " over" : " good"}`;

    const count = peer.deviceCount;
    const link = set(
      "aud-link",
      this.talk.relayStatus === "none" ? "This device only" : this.talk.relayStatus !== "connected" ? "Not connected" : count > 1 ? `Slides showing · ${count} devices` : "Slides showing · no other device yet",
    );
    link.className = `aud-link ${this.talk.relayStatus === "connected" ? "ok" : this.talk.relayStatus === "none" ? "off" : "bad"}`;
  }

  // ---------------------------------------------------------------- laser, ink, overview, help

  /** A message from this view to whoever runs the talk (this device, as a rule). */
  private send(message: Message): void {
    if (!this.ended) this.talk.peer.send(message);
  }

  /** Laser or Draw on the slides themselves; "none" gives clicks and taps back to stepping. */
  private setTool(tool: StageTool, pinned = false): void {
    if (this.ended) return;
    this.view.setTool(tool);
    this.barPinned = tool !== "none" && pinned && !this.bar.hidden;
    if (!this.bar.hidden) {
      this.fillBar();
      this.lingerBar(BAR_LINGER_MS);
    }
  }

  /** The laser: drawn here at once, and sent on (no more often than the relay likes) to every other screen. */
  private point(x: number, y: number, visible: boolean): void {
    const now = performance.now();
    if (visible && now - this.pointerSentAt < SEND_INTERVAL_MS) {
      this.view.setPointer(x, y, true);
      return;
    }
    this.pointerSentAt = visible ? now : 0;
    this.send({ type: "pointer", body: { x, y, visible } });
    if (!visible) this.view.setPointer(0, 0, false);
  }

  private beginInk(x: number, y: number): void {
    this.endInk();
    const id = ++this.strokeSeq;
    this.activeStroke = id;
    this.pendingPoints = [];
    this.send({ type: "ink", body: { op: "begin", id, x, y, color: this.inkColor, width: DEFAULT_INK_WIDTH } });
    this.inkTimer = window.setInterval(() => this.flushInk(), SEND_INTERVAL_MS);
  }

  private flushInk(): void {
    const id = this.activeStroke;
    while (id !== null && this.pendingPoints.length > 0) {
      this.send({ type: "ink", body: { op: "append", id, points: this.pendingPoints.splice(0, 256) } });
    }
  }

  private endInk(): void {
    const id = this.activeStroke;
    if (id === null) return;
    this.flushInk();
    window.clearInterval(this.inkTimer);
    this.send({ type: "ink", body: { op: "end", id } });
    this.activeStroke = null;
  }

  /** "Go to frame 12", large at the bottom left while a number is being typed. */
  private showDigits(): void {
    const typed = this.keys.typedDigits;
    this.digits.hidden = typed === "";
    if (typed === "") return;
    const number = document.createElement("strong");
    number.textContent = typed;
    this.digits.replaceChildren("Go to frame ", number, " ⏎");
  }

  /** The shortcut card (?). Any key or click puts it away. */
  private showHelp(on: boolean): void {
    this.help?.remove();
    this.help = null;
    if (!on || this.ended) return;
    const help = document.createElement("div");
    help.className = "aud-overlay aud-help modal";
    const panel = document.createElement("div");
    panel.className = "modal-panel wide";
    const title = document.createElement("p");
    title.className = "modal-title";
    title.textContent = "Keyboard shortcuts";
    const body = document.createElement("div");
    body.className = "info-body";
    body.innerHTML = renderNotesHtml(stageKeysInfo(IS_MAC)); // fixed text, escaped by renderNotesHtml
    panel.append(title, body);
    help.append(panel);
    help.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.showHelp(false);
    });
    this.root.append(help);
    this.help = help;
  }

  /**
   * Every frame at a glance (Tab), over the slides, with the bar under it. A click on a frame
   * goes there and puts the overview away; keys keep presenting meanwhile.
   */
  private showOverview(on: boolean): void {
    this.thumbs?.destroy();
    this.thumbs = null;
    this.overview?.remove();
    this.overview = null;
    if (!on || this.ended) {
      if (!this.bar.hidden) {
        this.fillBar();
        this.lingerBar(BAR_LINGER_MS);
      }
      return;
    }
    const overview = document.createElement("div");
    overview.className = "aud-overlay aud-overview";
    const head = document.createElement("div");
    head.className = "aud-overview-head";
    const title = document.createElement("strong");
    title.textContent = "Overview";
    const hint = document.createElement("span");
    hint.className = "aud-hint";
    hint.textContent = "Click a frame to go there · Tab or Esc closes";
    const seg = document.createElement("span");
    seg.className = "seg";
    const grid = document.createElement("div");
    grid.className = "aud-grid";
    const thumbs = new ThumbGrid(grid, this.talk.deck, {
      onPick: (page) => {
        this.dispatch({ name: "goToPage", page }, performance.now());
        this.showOverview(false);
      },
    });
    for (const kind of ["frames", "builds"] as const) {
      const pick = document.createElement("button");
      pick.type = "button";
      pick.textContent = kind === "frames" ? "Frames" : "Builds";
      pick.classList.toggle("on", kind === "frames");
      pick.addEventListener("click", () => {
        pick.blur();
        thumbs.setMode(kind);
        for (const other of seg.children) other.classList.toggle("on", other === pick);
      });
      seg.append(pick);
    }
    head.append(title, hint, seg);
    overview.append(head, grid);
    this.root.insertBefore(overview, this.bar);
    this.overview = overview;
    this.thumbs = thumbs;
    thumbs.mark(this.state().committedPage, null, true);
    this.showBar(true);
  }

  /** Takes the slides off this screen: out of full screen, locks released, pixels dropped. */
  private async takeDown(): Promise<void> {
    this.endInk();
    this.view.setTool("none");
    this.showHelp(false);
    this.showOverview(false);
    this.ended = true;
    window.clearInterval(this.barTimer);
    window.clearTimeout(this.barHide);
    window.clearInterval(this.inkTimer);
    this.root.removeEventListener("mousemove", this.onRootMouseMove);
    this.bar.remove();
    this.digits.remove();
    window.removeEventListener("keydown", this.onKeyDown, { capture: true });
    window.removeEventListener("keyup", this.onKeyUp, { capture: true });
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (import.meta.env.DEV) delete (window as unknown as { __lectern?: unknown }).__lectern;

    this.onEnding?.(); // two screens: the presenter window goes too
    this.onSwapKey = null;
    this.onEnding = null;
    this.talk.audience = null;
    setStage(false);
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
    // The presenter view's own keys, on the slides (Ben, 2026-11-27).
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const typing = this.keys.typedDigits !== "";
      if (this.help) {
        // Any key puts the shortcut card away; all but Esc and ? then do what they always do.
        this.showHelp(false);
        if (ev.key === "Escape" || ev.key === "?") {
          ev.preventDefault();
          return;
        }
      } else if (ev.key === "?") {
        ev.preventDefault();
        if (!ev.repeat) this.showHelp(true);
        return;
      }
      const toggle = ev.key === "Tab" ? "overview" : ev.key === "l" || ev.key === "L" ? "laser" : ev.key === "d" || ev.key === "D" ? "draw" : null;
      if (toggle) {
        ev.preventDefault();
        if (ev.repeat) return;
        if (toggle === "overview") this.showOverview(!this.overview);
        else this.setTool(this.view.tool === toggle ? "none" : toggle);
        return;
      }
      // One Esc closes what is open, then puts the tool down; only then does Esc count towards leaving.
      if (ev.key === "Escape" && !ev.repeat && !typing && (this.overview || this.view.tool !== "none" || !this.bar.hidden)) {
        ev.preventDefault();
        if (this.overview) this.showOverview(false);
        else if (this.view.tool !== "none") this.setTool("none");
        else this.showBar(false);
        return;
      }
    }
    const result = this.keys.interpret(
      { key: ev.key, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, repeat: ev.repeat, time: ev.timeStamp },
      this.state(),
    );
    if (result.handled) ev.preventDefault();
    this.showDigits();

    if (result.end) void this.stop();
    else if (result.command) this.dispatch(result.command, ev.timeStamp);
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") this.escapeDown = false;
  };

  /** Marks the slides as windowed or not, and on leaving full screen shows the way back for a moment. */
  private showWindowed(): void {
    // No button on an iPad or iPhone, where the slides never use Safari's full screen.
    const windowed = document.fullscreenElement !== this.root && document.fullscreenEnabled && !APPLE_TOUCH;
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
