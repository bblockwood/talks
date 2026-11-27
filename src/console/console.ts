// The presenter view (SPEC §7, Native §6.2–6.4): the one screen the presenter looks at, on a
// phone, tablet or laptop, or in the second window of two-screen mode. It renders the deck
// itself and exchanges small messages with whichever device runs the talk, which may be this
// one (see client.ts and core/peer.ts). It shows what the host last reported, never what it
// merely asked for.
import { parseDuration } from "../core/duration";
import { DEFAULT_INK_WIDTH, NO_INK, appendToStroke, beginStroke, clearLayer, undoStroke } from "../core/ink";
import type { InkLayer, InkState } from "../core/ink";
import { KeyInterpreter } from "../core/keys";
import { hitTest } from "../core/links";
import { formatClock, renderNotesHtml } from "../core/markdown";
import { NotesTable, assembleNotes, parsePdfpc } from "../core/notes";
import { currentEntry, shadowedEntries } from "../core/outline";
import type { OutlineEntry } from "../core/outline";
import { APP_VERSION } from "../core/protocol";
import type { Envelope, StateBody, StrokeOp } from "../core/protocol";
import { hitsByFrame, searchPages } from "../core/search";
import type { SearchHit } from "../core/search";
import { initialState } from "../core/session";
import type { Command, SessionState } from "../core/session";
import { parseSplit } from "../core/split";
import type { Deck } from "../shared/deck";
import type { PresenterDeck } from "../shared/local-channel";
import { deviceName } from "../shared/relay-client";
import type { LinkStatus } from "../shared/relay-client";
import { SlideSurface } from "../shared/slide-surface";
import { ThumbGrid } from "../shared/thumbs";
import type { ThumbMode } from "../shared/thumbs";
import type { ConsoleClient } from "./client";
import { NOTES_INFO, outlineInfo } from "./info";

const PING_MS = 2000;
/** The host sends state every 2.5 s; past this it is treated as gone (and a successor takes over). */
const ROOM_TIMEOUT_MS = 9000;
const LONG_PRESS_MS = 350;
const POINTER_INTERVAL_MS = 33; // at most ~30 messages a second, well under the relay's limit
const SWIPE_MIN_PX = 45;
const TAP_SLOP_PX = 10;

export type Layout = "wide" | "stacked" | "compact" | "buttons";

/**
 * Which arrangement suits a window: a phone held sideways gets only the big buttons, a phone
 * upright the compact column, a tablet upright the stacked panes, and anything wider the
 * side-by-side panes of the native app.
 */
export function layoutFor(width: number, height: number): Layout {
  if (width > height && height < 540) return "buttons";
  if (width < 700) return "compact";
  if (height > width) return "stacked";
  return "wide";
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

/** The notes a deck carries besides those embedded in the PDF. */
export type NoteSources = Pick<PresenterDeck, "noteOverrides" | "pdfpcText" | "pptxNotes">;

export interface ConsoleOptions {
  readonly deck: Deck;
  readonly notes: NoteSources;
  /** `meta.published` of this view's copy of the deck, to notice a newer publish on the room PC. Empty if unknown. */
  readonly published: string;
  /** False unless this is the presenter's own device: nothing is stored on a shared computer. */
  readonly remember: boolean;
  /** True when this view opened the deck itself (the second window) and must destroy it on leaving. */
  readonly ownsDeck: boolean;
  loadNotesSize(): number | null;
  saveNotesSize(px: number): void;
  /** The user closed this presenter view. */
  onLeave(): void;
  /** The room PC has a newer publish of this deck and the user asked to reload. Absent where that can't happen. */
  onReload?: () => void;
  /** How another device joins, when that can be shown: "code maple". */
  readonly joinHint?: string;
  /** Swap displays: only the second window of two-screen mode can do this. */
  onSwap?: () => void;
  /** Go back to choosing what this device shows, without leaving the talk (Esc twice, or Change view). */
  onChangeView?: () => void;
  /** False in a window the browser placed on a screen itself, which must stay movable for Swap displays. */
  readonly fullscreen?: boolean;
  /** Development and tests only: drop the connection as a network failure would. */
  dropForTest?: () => void;
}

export class PresenterConsole {
  private readonly deck: Deck;
  private client: ConsoleClient;
  private readonly current: SlideSurface;
  private readonly next: SlideSurface;
  private notesImage: SlideSurface | null = null;
  private thumbs: ThumbGrid | null = null;
  private readonly abort = new AbortController();
  private readonly keys = new KeyInterpreter();
  private notes: NotesTable = NotesTable.empty;
  private notesSize: number;
  private layout: Layout = "compact";

  private linkStatus: LinkStatus = "connecting";
  /** The last state reported by whatever runs the talk. */
  private view: StateBody | null = null;
  /** `performance.now()` when it arrived, for extrapolating the clock. */
  private viewAt = 0;
  private roomSeenAt = -Infinity;

  /** This view's copy of the ink on screen, kept in step by `strokes` messages. */
  private ink: InkState = NO_INK;
  private drawMode = false;
  private laserMode = false;
  private inkColor = 0;
  private strokeSeq = 0;
  private activeStroke: string | null = null;
  private activeStrokeNumber = 0;
  private pendingPoints: number[] = [];
  private inkTimer: number | undefined;
  private inkMismatchSince = 0;
  private lastResync = 0;

  private overviewOpen = false;
  private thumbMode: ThumbMode = "frames";
  /** The PDF's outline, once read; and whether the notes pane shows it instead of the notes. */
  private outline: readonly OutlineEntry[] = [];
  private outlineShown = false;
  private outlineBuilt = false;
  private keyboardLocked = false;
  private pageTexts: string[] | null = null;
  private hits: SearchHit[] = [];
  private selectedHit = 0;
  private searchRun = 0;

  private readonly pending = new Map<number, number>();
  private readonly pings = new Set<number>();
  private rtts: number[] = [];
  private taps: number[] = [];
  private bannerShown = false;
  /** What "Down from" offers next time the clock's controls open. */
  private lastCountdownMs = 20 * 60_000;
  private notice = "";
  private noticeUntil = 0;
  private timers: number[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  private destroyed = false;

  constructor(
    private readonly options: ConsoleOptions,
    client: ConsoleClient,
  ) {
    this.deck = options.deck;
    this.client = client;
    this.notesSize = options.loadNotesSize() ?? 0;
    document.documentElement.style.setProperty("--slide-aspect", String(this.deck.aspect));
    if (this.notesSize > 0) document.documentElement.style.setProperty("--notes-size", `${this.notesSize}px`);

    this.current = new SlideSurface($("current"), this.deck, 6);
    this.next = new SlideSurface($("next-slide"), this.deck, 4);

    this.resetPanels();
    this.applyLayout();
    this.bind();
    this.timers.push(
      window.setInterval(() => this.tick(), 500),
      window.setInterval(() => this.ping(), PING_MS),
    );
    void this.loadNotes();
    void this.loadOutline();
    void this.requestWakeLock();
    this.showFullscreen();
    this.update();

    if (import.meta.env.DEV) {
      (window as unknown as { __console?: unknown }).__console = {
        view: () => this.view,
        shownPage: () => this.current.shownPage,
        layout: () => this.layout,
        taps: () => this.taps,
        rtts: () => this.rtts,
        ink: () => ({ page: this.ink.page.length, board: this.ink.board.length }),
        hits: () => this.hits,
        outline: () => this.outline,
        kind: () => this.client.kind,
        hosting: () => this.client.hosting,
        drop: () => this.options.dropForTest?.(),
      };
    }
  }

  // ---------------------------------------------------------------- connection

  /** Called by the client for every message from whatever runs the talk. */
  onMessage(envelope: Envelope): void {
    if (this.destroyed) return;
    const now = performance.now();
    switch (envelope.type) {
      case "state": {
        const body = envelope.body;
        this.followSplit(body.split);
        // Ink belongs to its page.
        if (this.view && body.page !== this.view.page) this.ink = clearLayer(this.ink, "page");
        this.view = body;
        this.viewAt = now;
        this.roomSeenAt = now;
        const ack = body.ack;
        if (ack && ack.sid === this.client.sid) {
          const sent = this.pending.get(ack.seq);
          if (sent !== undefined) {
            this.taps = [...this.taps, now - sent].slice(-100);
            this.pending.delete(ack.seq);
          }
        }
        this.checkInk(now);
        this.update();
        break;
      }
      case "strokes":
        this.applyStrokes(envelope.body);
        break;
      case "hello":
        if (envelope.body.role === "room") this.roomSeenAt = now; // the host, (re)announcing itself
        break;
      case "pong":
        // Every presenter view hears every pong; only the answer to our own ping is a measurement.
        if (this.pings.delete(envelope.body.t)) {
          this.roomSeenAt = now;
          this.rtts = [...this.rtts, now - envelope.body.t].slice(-30);
        }
        break;
      default:
        break;
    }
  }

  onStatus(status: LinkStatus): void {
    if (this.destroyed) return;
    this.linkStatus = status;
    if (status !== "connected") this.pending.clear();
    else this.hello(); // ask whoever runs the talk for the state and the ink
    this.update();
  }

  /** Something the presenter should know, shown briefly in the status line. */
  showNotice(text: string): void {
    this.notice = text;
    this.noticeUntil = performance.now() + 8000;
    this.tick();
  }

  private hello(): void {
    this.client.send({ type: "hello", body: { role: "presenter", device: deviceName(), appVersion: APP_VERSION, view: "presenter" } });
  }

  private ping(): void {
    if (this.client.hosting) return; // this device runs the talk: nothing to measure
    const t = performance.now();
    if (this.client.send({ type: "ping", body: { t } }) > 0) {
      this.pings.add(t);
      if (this.pings.size > 8) this.pings.delete(this.pings.values().next().value ?? 0);
    }
  }

  private get live(): boolean {
    if (this.view === null) return false;
    // Whoever runs the talk is heard from every few seconds, this device included. A device that
    // follows another needs its connection; if that stays down it takes the talk over itself.
    if (!this.client.hosting && this.linkStatus !== "connected") return false;
    return performance.now() - this.roomSeenAt < ROOM_TIMEOUT_MS;
  }

  private send(command: Command): void {
    const seq = this.client.send({ type: "command", body: command });
    if (seq > 0) {
      this.pending.set(seq, performance.now());
      if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value ?? 0);
    }
  }

  /**
   * The room PC decides whether a Beamer notes-split deck is cropped (its entry screen can turn
   * the crop off), so every presenter view follows what it reports.
   */
  private followSplit(reported: string | null): void {
    const split = parseSplit(reported);
    if (split === this.deck.split) return;
    this.deck.setSplit(split);
    document.documentElement.style.setProperty("--slide-aspect", String(this.deck.aspect));
    this.current.refresh();
    this.next.refresh();
    this.notesImage?.destroy();
    this.notesImage = null;
    this.thumbs?.destroy();
    this.thumbs = null;
    this.outlineBuilt = false; // its frame numbers changed
    void this.loadNotes();
  }

  // ---------------------------------------------------------------- ink

  private get layer(): InkLayer {
    return this.view?.audienceMode.kind === "white" ? "board" : "page";
  }

  private applyStrokes(op: StrokeOp): void {
    if (op.op === "reset") {
      this.ink = NO_INK;
    } else if (op.from === this.client.sid) {
      return; // our own ink, already drawn here
    } else if (op.op === "begin") {
      this.ink = beginStroke(this.ink, op.layer, op.id, op.x, op.y, op.color, op.width);
    } else if (op.op === "append") {
      this.ink = appendToStroke(this.ink, op.id, op.points);
    } else if (op.op === "undo") {
      this.ink = undoStroke(this.ink, op.layer);
    } else {
      this.ink = clearLayer(this.ink, op.layer);
    }
    this.showInk();
  }

  /** If our copy disagrees with the room PC's count for a while, ask for a fresh copy. */
  private checkInk(now: number): void {
    const view = this.view;
    const mode = view?.audienceMode.kind;
    if (!view || this.activeStroke !== null || (mode !== "live" && mode !== "white")) {
      this.inkMismatchSince = 0;
      return;
    }
    if (view.ink === this.ink[this.layer].length) {
      this.inkMismatchSince = 0;
      return;
    }
    if (view.ink === 0) {
      this.ink = clearLayer(this.ink, this.layer); // cleared on the room PC: nothing to fetch
      return;
    }
    if (this.inkMismatchSince === 0) this.inkMismatchSince = now;
    else if (now - this.inkMismatchSince > 1500 && now - this.lastResync > 5000) {
      this.lastResync = now;
      this.inkMismatchSince = 0;
      this.hello(); // the answer includes a full copy of the ink
    }
  }

  private showInk(): void {
    const board = this.view?.audienceMode.kind === "white";
    this.current.setBlank(board);
    this.current.setInk(board ? this.ink.board : this.ink.page);
  }

  private beginInk(clientX: number, clientY: number): boolean {
    const point = this.current.pointAt(clientX, clientY, true);
    const mode = this.view?.audienceMode.kind;
    if (!point || !this.live || (mode !== "live" && mode !== "white")) return false;
    const n = ++this.strokeSeq;
    // The same id the room PC will give this stroke, so a full copy later lines up with it.
    const id = `${this.client.sid}:${n}`;
    this.activeStroke = id;
    this.activeStrokeNumber = n;
    this.pendingPoints = [];
    this.ink = beginStroke(this.ink, this.layer, id, point.x, point.y, this.inkColor, DEFAULT_INK_WIDTH);
    this.showInk();
    this.client.send({ type: "ink", body: { op: "begin", id: n, ...point, color: this.inkColor, width: DEFAULT_INK_WIDTH } });
    this.inkTimer = window.setInterval(() => this.flushInk(), POINTER_INTERVAL_MS);
    return true;
  }

  private extendInk(ev: PointerEvent): void {
    const id = this.activeStroke;
    if (id === null) return;
    // Coalesced events carry every sample a pen or finger produced since the last frame.
    const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    const added: number[] = [];
    for (const sample of samples.length > 0 ? samples : [ev]) {
      const point = this.current.pointAt(sample.clientX, sample.clientY, true);
      if (point) added.push(point.x, point.y);
    }
    if (added.length === 0) return;
    this.ink = appendToStroke(this.ink, id, added);
    this.pendingPoints.push(...added);
    this.showInk();
  }

  private flushInk(): void {
    if (this.activeStroke === null) return;
    // Batches of at most 128 points keep every frame far below the relay's 64 KB limit.
    while (this.pendingPoints.length > 0) {
      this.client.send({ type: "ink", body: { op: "append", id: this.activeStrokeNumber, points: this.pendingPoints.splice(0, 256) } });
    }
  }

  private endInk(): void {
    if (this.activeStroke === null) return;
    this.flushInk();
    window.clearInterval(this.inkTimer);
    this.client.send({ type: "ink", body: { op: "end", id: this.activeStrokeNumber } });
    this.activeStroke = null;
  }

  // ---------------------------------------------------------------- view

  private get page(): number {
    return Math.min(Math.max(this.view?.page ?? 0, 0), this.deck.pageCount - 1);
  }

  private applyLayout(): void {
    const layout = layoutFor(window.innerWidth, window.innerHeight);
    if (layout === this.layout && $("console").dataset["layout"] === layout) return;
    this.layout = layout;
    $("console").dataset["layout"] = layout;
  }

  private update(): void {
    if (this.destroyed) return;
    const { frames, pageCount } = this.deck;
    const page = this.page;
    const live = this.live;
    const view = this.view;
    const mode = view?.audienceMode.kind ?? "live";

    if (!live) {
      this.drawMode = false;
      this.laserMode = false;
    }
    this.showInk();
    this.current.show(page, [page + 1, page - 1].filter((p) => p >= 0 && p < pageCount));
    this.next.show(page + 1 < pageCount ? page + 1 : page);
    void this.deck.loadLinks(page);

    const frame = frames.frameContaining(page);
    const builds = frame ? frame.lastPage - frame.firstPage + 1 : 1;
    const build = frames.buildIndex(page) + 1;
    $("frame-line").textContent = frame ? `Frame ${frame.label} of ${frames.frameCount}` : "–";
    $("build-line").textContent = builds > 1 ? `Build ${build} of ${builds}` : "";
    $("bar-where").textContent = frame ? `Frame ${frame.label}/${frames.frameCount}${builds > 1 ? ` · ${build}/${builds}` : ""}` : "";

    // Notes: text when there is any; otherwise, for a Beamer notes-split deck, the notes half as an image.
    const note = this.notes.noteFor(page, frames);
    const notesEl = $("notes");
    const asImage = !note && this.deck.notesCrop !== null;
    const outlineShown = this.outlineShown && this.outline.length > 0;
    notesEl.hidden = asImage || outlineShown;
    $("notes-image").hidden = !asImage || outlineShown;
    $("outline").hidden = !outlineShown;
    $("tab-notes").classList.toggle("on-tab", !outlineShown);
    $("tab-outline").classList.toggle("on-tab", outlineShown);
    $("tab-outline").classList.toggle("off", this.outline.length === 0);
    $("tab-outline").title = this.outline.length === 0 ? "This PDF has no outline" : "The PDF's outline; click an entry to jump there";
    if (outlineShown) this.showOutline(page);
    if (asImage && !outlineShown) {
      this.notesImage ??= new SlideSurface($("notes-image"), this.deck, 3, "notes");
      this.notesImage.show(page);
    } else if (!asImage) {
      const html = note ? renderNotesHtml(note.text) : `<p class="empty">No notes for this slide.</p>`;
      if (notesEl.dataset["html"] !== html) {
        notesEl.dataset["html"] = html;
        notesEl.innerHTML = html; // every piece of note text is escaped by renderNotesHtml
        notesEl.scrollTop = 0;
      }
    }

    // BLACK / WHITEBOARD / FROZEN show only in those modes.
    const pill = $("pill");
    pill.hidden = mode === "live";
    pill.textContent = mode === "white" ? "WHITEBOARD" : mode.toUpperCase();
    pill.className = `pill ${mode}`;

    for (const id of ["prev", "next", "t-black", "t-freeze", "m-white", "clock-toggle", "clock-reset", "count-up", "count-down", "end-talk", "t-draw", "t-laser", "ink-board"]) {
      $<HTMLButtonElement>(id).disabled = !live;
    }
    $("t-black").classList.toggle("on", mode === "black");
    $("t-freeze").classList.toggle("on", mode === "frozen");
    $("m-white").classList.toggle("on", mode === "white");
    $("ink-board").classList.toggle("on", mode === "white");
    $("t-draw").classList.toggle("on", this.drawMode);
    $("t-laser").classList.toggle("on", this.laserMode);
    $("drawbar").hidden = !this.drawMode;
    $("current").classList.toggle("drawing", this.drawMode);
    $("current").classList.toggle("laser", this.laserMode);
    for (const el of document.querySelectorAll<HTMLElement>(".ink-color")) {
      el.classList.toggle("on", Number(el.dataset["color"]) === this.inkColor);
    }

    // After a jump, Back returns to where it started; after a Back, Forward undoes it (Native §6.2).
    const target = (list: readonly number[] | undefined): number | null => {
      for (let i = (list?.length ?? 0) - 1; i >= 0; i--) {
        const p = list?.[i];
        if (p !== undefined && p !== view?.page) return p;
      }
      return null;
    };
    const back = target(view?.history);
    const forward = target(view?.forwardHistory);
    const label = (p: number | null): string => (p === null ? "" : (frames.frameContaining(p)?.label ?? ""));
    const backButton = $<HTMLButtonElement>("t-back");
    const forwardButton = $<HTMLButtonElement>("t-forward");
    backButton.disabled = !live || back === null;
    forwardButton.disabled = !live || forward === null;
    backButton.title = back === null ? "Back after a jump (Delete)" : `Back to frame ${label(back)} (Delete)`;
    forwardButton.title = forward === null ? "Forward" : `Forward to frame ${label(forward)}`;
    $("clock-toggle").textContent = view?.timer.running === false ? "Resume" : "Pause";
    const countdown = view?.timer.targetMs ?? null;
    if (countdown !== null) this.lastCountdownMs = countdown;
    $("count-up").classList.toggle("on", view !== null && countdown === null);
    $("count-down").classList.toggle("on", countdown !== null);
    $<HTMLInputElement>("count-from").disabled = !live;

    $("swap").hidden = !this.options.onSwap;
    $("change-view").hidden = !this.options.onChangeView;
    $("row-join").hidden = this.client.kind === "local";
    const where = `${window.location.host}${import.meta.env.BASE_URL.replace(/\/$/, "")}`;
    $("join-text").textContent = `${where}, ${this.options.joinHint ?? "with the same talk code"}`;

    $("digits").textContent = this.keys.typedDigits === "" ? "" : `Go to frame ${this.keys.typedDigits}⏎`;
    if (this.overviewOpen) this.markThumbs();
    this.tick();
  }

  /** The parts that change with time: connection line, clocks, diagnostics. */
  private tick(): void {
    if (this.destroyed) return;
    const now = performance.now();
    const link = $("link");
    const rtt = median(this.rtts);
    const others = (this.view?.room?.devices.length ?? 1) - 1;
    // One line on where the talk stands: is a screen showing the slides, and who else is in it.
    const room = this.view?.room;
    const count = room?.devices.length ?? 1;
    const screens = room?.audiences ?? 0;
    let text: string;
    let cls: "ok" | "wait" | "" = "";
    if (now < this.noticeUntil) {
      text = this.notice;
      cls = "wait";
    } else if (!this.live) {
      text = this.view ? "Reconnecting…" : "Joining the talk…";
    } else if (this.client.kind === "local") {
      text = `Slides on the other screen${count > 1 ? ` · ${count - 1} more ${count === 2 ? "device" : "devices"}` : ""}`;
      cls = "ok";
    } else {
      const others = count > 1 ? ` · ${count} devices` : "";
      const alone = room?.relay === "none" ? " · this device only" : room?.relay !== "connected" && this.client.hosting ? " · offline" : "";
      // With no screen showing the slides, say how one joins.
      const join = this.options.joinHint && room?.relay === "connected" ? ` · join with ${this.options.joinHint}` : "";
      text = screens > 0 ? `Slides showing${screens > 1 ? ` on ${screens} screens` : ""}${others}${alone}` : `No slides screen yet${others}${alone}${join}`;
      cls = screens > 0 ? "ok" : "wait";
    }
    if (link.textContent !== text) link.textContent = text;
    link.classList.toggle("ok", cls === "ok");
    link.classList.toggle("wait", cls === "wait");

    // The host has a newer publish of this deck than this device does.
    const view = this.view;
    const stale =
      view !== null && this.options.onReload !== undefined && this.options.published !== "" && view.deckPublished !== "" && view.deckPublished !== this.options.published;
    if (stale !== this.bannerShown || $("banner").hidden === stale) {
      this.bannerShown = stale;
      $("banner").hidden = !stale;
      $("banner-text").textContent = "Slides updated — reload?";
      $("banner-action").textContent = "Reload";
    }

    const timer = $("timer");
    const t = view?.timer;
    if (!t) {
      timer.textContent = "0:00";
      timer.className = "timer paused";
      $("clock-now").textContent = "";
      $("clock-sub").textContent = "";
    } else {
      const elapsed = t.elapsedMs + (t.running && this.live ? now - this.viewAt : 0);
      const left = t.targetMs === null ? null : t.targetMs - elapsed;
      // Counting down, the time left takes the clock's place: green while positive, red and
      // counting up once it has run out. The arrow gives the direction (Native §6.2).
      const over = left !== null && left <= -1000;
      const shown = left === null ? formatClock(elapsed) : `${over ? "−" : ""}${formatClock(Math.abs(left))}`;
      // Before the first slide change the clock has not started: it shows where it will run from.
      const waiting = !t.running && t.elapsedMs === 0;
      timer.textContent = `${shown} ${!t.running && !waiting ? "⏸" : left === null ? "↑" : "↓"}`;
      timer.className = `timer${!t.running ? " paused" : left === null ? "" : over ? " over" : " good"}`;
      // Beside the clock's controls: the same value in words, and the elapsed time under a countdown.
      $("clock-now").textContent = left === null ? formatClock(elapsed) : `${formatClock(Math.abs(left))} ${over ? "over" : "left"}`;
      $("clock-sub").textContent = [left === null ? "" : `${formatClock(elapsed)} elapsed`, t.running ? "" : waiting ? "starts with the first slide change" : "paused"]
        .filter((x) => x !== "")
        .join(" · ");
    }
    $("wall").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const tap = median(this.taps);
    // A command's answer comes back over the same path as a ping's, so half the ping round trip
    // is the return leg; the rest is tap → slide drawn.
    const oneWay = tap === null ? null : Math.max(0, tap - (rtt ?? 0) / 2);
    $("diag").textContent = this.client.hosting
      ? "this device runs the talk"
      : this.client.kind === "local"
        ? "same computer"
        : `ping ${rtt === null ? "–" : `${Math.round(rtt)} ms`} · tap → slide ${oneWay === null ? "–" : `${Math.round(oneWay)} ms`} (median of ${this.taps.length})`;

    const ms = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : `${n.toFixed(1)} ms`);
    $("debug-text").textContent = [
      `input → audience draw   n=${room?.draw.count ?? 0}`,
      `  median ${ms(room?.draw.medianMs)}   last ${ms(room?.draw.lastMs)}   max ${ms(room?.draw.maxMs)}`,
      `render-cache misses     ${room?.cacheMisses ?? 0}`,
      `host's connection       ${room?.relay ?? "–"}`,
      `devices (host first)    ${room && room.devices.length > 0 ? room.devices.join(", ") : "–"}`,
      `slides screens          ${screens}`,
      `this view               ${this.client.hosting ? "runs the talk" : "follows"}, ${this.layout}${rtt === null ? "" : `, ping ${Math.round(rtt)} ms`}`,
      `page ${this.page + 1}   mode ${this.view?.audienceMode.kind ?? "–"}   history ${this.view?.history.length ?? 0}`,
    ].join("\n");
  }

  private async loadNotes(): Promise<void> {
    const sources = this.options.notes;
    const pdfpc = sources.pdfpcText ? parsePdfpc(sources.pdfpcText) : null;
    const build = (embedded: Map<number, string>): NotesTable =>
      assembleNotes({ overrides: sources.noteOverrides, pdfpc, embedded, pptx: sources.pptxNotes }, this.deck.frames);
    this.notes = build(new Map()); // what came with the deck, at once
    this.update();
    const embedded = await this.deck.loadEmbeddedNotes().catch(() => new Map<number, string>());
    if (this.destroyed) return;
    this.notes = build(embedded);
    this.update();
  }

  private async loadOutline(): Promise<void> {
    const outline = await this.deck.loadOutline().catch((): readonly OutlineEntry[] => []);
    if (this.destroyed) return;
    this.outline = outline;
    this.outlineBuilt = false;
    this.update();
  }

  /** The outline in the notes pane: every entry with the frame it starts on, the current one lit and in view. */
  private showOutline(page: number): void {
    const box = $("outline");
    const frames = this.deck.frames;
    if (!this.outlineBuilt) {
      this.outlineBuilt = true;
      const shadowed = shadowedEntries(this.outline);
      box.replaceChildren(
        ...this.outline.map((entry, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "entry-row";
          row.style.paddingLeft = `${0.5 + entry.depth * 1.1}em`;
          const title = document.createElement("span");
          title.className = "title";
          title.textContent = entry.title === "" ? "(untitled)" : entry.title;
          row.append(title);
          const target = entry.page;
          if (target === null) row.disabled = true;
          else {
            if (!shadowed.has(i)) {
              const frame = document.createElement("span");
              frame.className = "frame";
              frame.textContent = frames.frameContaining(target)?.label ?? "";
              row.append(frame);
            }
            // A jump like any other: Back returns to where it started.
            row.addEventListener("click", () => this.send({ name: "goToPage", page: target }), { signal: this.abort.signal });
          }
          return row;
        }),
      );
      delete box.dataset["current"];
    }
    const current = currentEntry(this.outline, page);
    if (box.dataset["current"] === String(current)) return;
    box.dataset["current"] = String(current);
    Array.from(box.children).forEach((row, i) => {
      row.classList.toggle("current", i === current);
      if (i === current) row.scrollIntoView({ block: "nearest" });
    });
  }

  private setOutlineShown(shown: boolean): void {
    this.outlineShown = shown && this.outline.length > 0;
    delete $("outline").dataset["current"]; // scroll the current entry into view when it appears
    this.update();
  }

  // ---------------------------------------------------------------- pop-ups

  private showInfo(title: string, markdown: string): void {
    $("info-title").textContent = title;
    $("info-body").innerHTML = renderNotesHtml(markdown); // fixed text of ours, escaped all the same
    $("info").hidden = false;
  }

  // ---------------------------------------------------------------- full screen

  /** The presenter view fills the screen when the browser allows; otherwise a button at the top offers it. */
  private get canFullscreen(): boolean {
    return this.options.fullscreen !== false && document.fullscreenEnabled;
  }

  private showFullscreen(): void {
    const full = document.fullscreenElement !== null;
    $("fs").hidden = full || !this.canFullscreen;
    if (full) void this.lockKeyboard();
    else this.keyboardLocked = false;
  }

  /** Call from a click or key press: full screen needs the user gesture. */
  enterFullscreen(): void {
    if (!this.canFullscreen || document.fullscreenElement) return;
    void $("console")
      .requestFullscreen({ navigationUI: "hide" })
      .catch(() => {}); // refused: the button stays
  }

  /** Where the browser can hold Esc for the page, Esc closes what is open here instead of leaving full screen. */
  private async lockKeyboard(): Promise<void> {
    const keyboard = navigator.keyboard;
    if (!keyboard?.lock || this.keyboardLocked) return;
    try {
      await keyboard.lock(["Escape"]);
      this.keyboardLocked = !this.destroyed;
    } catch {
      this.keyboardLocked = false;
    }
  }

  // ---------------------------------------------------------------- overview and search

  private setOverview(open: boolean): void {
    if (open && this.layout === "buttons") return; // a phone held sideways shows no slides
    this.overviewOpen = open;
    $("overview").hidden = !open;
    // In the wide and stacked layouts the overview takes the place of the next slide and notes.
    $("side-normal").hidden = open && this.layout !== "compact";
    $("t-slides").classList.toggle("on", open);
    if (open) {
      if (!this.thumbs) {
        $("grid").scrollTop = 0;
        this.thumbMode = "frames";
      }
      this.thumbs ??= new ThumbGrid($("grid"), this.deck, {
        // A pick jumps at once and can be undone with Back; the overview stays open (Native §6.3).
        onPick: (page) => this.send({ name: "goToPage", page }),
        hasNotes: (frame) => {
          for (let p = frame.firstPage; p <= frame.lastPage; p++) if (this.notes.byPage.has(p)) return true;
          return false;
        },
      });
      this.markThumbs(true);
    } else {
      const search = $<HTMLInputElement>("search");
      search.value = "";
      search.blur();
      this.showHits("");
    }
    this.update();
  }

  private markThumbs(scroll = false): void {
    const view = this.view;
    const frozen = view?.audienceMode.kind === "frozen" ? view.audienceMode.page : null;
    this.thumbs?.mark(this.page, frozen, scroll);
    // Frames or Builds: only a deck with builds has the choice.
    $("ov-mode").hidden = this.deck.frames.frameCount === this.deck.pageCount;
    $("ov-frames").classList.toggle("on", this.thumbMode === "frames");
    $("ov-builds").classList.toggle("on", this.thumbMode === "builds");
  }

  private setThumbMode(mode: ThumbMode): void {
    this.thumbMode = mode;
    this.thumbs?.setMode(mode);
    this.markThumbs(true);
  }

  private async runSearch(): Promise<void> {
    const query = $<HTMLInputElement>("search").value;
    const run = ++this.searchRun;
    if (query.trim() !== "" && !this.pageTexts) {
      this.pageTexts = await Promise.all(Array.from({ length: this.deck.pageCount }, (_, p) => this.deck.pageText(p)));
    }
    if (run !== this.searchRun || this.destroyed) return;
    this.hits = query.trim() === "" ? [] : hitsByFrame(searchPages(this.pageTexts ?? [], query, this.deck.frames));
    this.selectedHit = 0;
    this.showHits(query);
  }

  private showHits(query: string): void {
    const results = $("results");
    const searching = query.trim() !== "";
    results.hidden = !searching;
    $("grid").hidden = searching;
    results.replaceChildren();
    if (!searching) return;
    if (this.hits.length === 0) {
      const none = document.createElement("p");
      none.className = "none";
      none.textContent = "No slides match.";
      results.append(none);
      return;
    }
    this.selectedHit = Math.min(this.selectedHit, this.hits.length - 1);
    this.hits.forEach((hit, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `hit${i === this.selectedHit ? " selected" : ""}`;
      const frame = document.createElement("span");
      frame.className = "frame";
      frame.textContent = `Frame ${this.deck.frames.frames[hit.frameIndex]?.label ?? ""}`;
      button.append(frame, document.createTextNode(hit.snippet));
      button.addEventListener("click", () => this.send({ name: "goToPage", page: hit.page }));
      results.append(button);
    });
  }

  // ---------------------------------------------------------------- input

  private setDraw(on: boolean): void {
    if (!on) this.endInk();
    this.drawMode = on && this.live;
    if (this.drawMode) this.setLaser(false);
    this.update();
  }

  private setLaser(on: boolean): void {
    if (this.laserMode && !on) {
      this.current.setDot(null);
      this.client.send({ type: "pointer", body: { x: 0, y: 0, visible: false } });
    }
    this.laserMode = on && this.live;
    if (this.laserMode && this.drawMode) {
      this.endInk();
      this.drawMode = false;
    }
    this.update();
  }

  private toggleMode(kind: "black" | "white" | "frozen"): void {
    const now = this.view?.audienceMode.kind;
    if (now === kind) this.send({ name: "setAudienceMode", mode: { kind: "live" } });
    else if (kind === "frozen") this.send({ name: "setAudienceMode", mode: { kind: "frozen", page: this.view?.page ?? 0 } });
    else this.send({ name: "setAudienceMode", mode: { kind } });
  }

  /** Counts down from the typed time. A time that does not parse is flagged and leaves the clock alone. */
  private countDown(close: boolean): void {
    const input = $<HTMLInputElement>("count-from");
    const ms = parseDuration(input.value);
    input.classList.toggle("invalid", ms === null);
    $("count-hint").hidden = ms !== null;
    if (ms === null) {
      input.focus();
      return;
    }
    this.lastCountdownMs = ms;
    this.send({ name: "timerSetTarget", targetMs: ms });
    if (close) $("sheet-more").hidden = true;
  }

  private setNotesSize(px: number): void {
    const base = this.notesSize > 0 ? this.notesSize : this.layout === "wide" ? 22 : 18;
    this.notesSize = Math.min(48, Math.max(12, base + px));
    document.documentElement.style.setProperty("--notes-size", `${this.notesSize}px`);
    if (this.options.remember) this.options.saveNotesSize(this.notesSize);
  }

  private endTalk(): void {
    this.client.send({ type: "end", body: {} });
    $("end-confirm").hidden = true;
    $("sheet-more").hidden = true;
    this.view = null;
    this.update();
  }

  /** The session state the key map needs: where we are and what the room screen is doing. */
  private keyState(): SessionState {
    const view = this.view;
    return view ? { ...initialState, committedPage: view.page, audienceMode: view.audienceMode } : initialState;
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if ($("console").hidden) return;
    // A pop-up takes the keys while it is open: Esc closes it, and Enter closes the information one.
    // Ending the talk is never one key press away.
    const modal = !$("end-confirm").hidden ? "end-confirm" : !$("info").hidden ? "info" : null;
    if (modal && !ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === "Escape" || ev.key === "Enter" || ev.key === " " || ev.key === "Tab")) {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape" || (ev.key === "Enter" && modal === "info")) $(modal).hidden = true;
      return;
    }
    if (ev.ctrlKey && ev.shiftKey && (ev.key === "D" || ev.key === "d")) {
      ev.preventDefault();
      $("debug").hidden = !$("debug").hidden;
      return;
    }
    if (this.options.onSwap && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault(); // otherwise the browser bookmarks the page
      if (!ev.repeat) this.options.onSwap();
      return;
    }
    const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    const search = $<HTMLInputElement>("search");

    // Typing a countdown: digits here are a time, not a frame to jump to.
    if (ev.target === $("count-from")) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.countDown(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        $("sheet-more").hidden = true;
      }
      if (ev.key !== "PageDown" && ev.key !== "PageUp") return;
    }

    if (ev.target === search && plain) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const hit = this.hits[this.selectedHit];
        if (hit) this.send({ name: "goToPage", page: hit.page });
        return;
      }
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (this.hits.length > 0) this.selectedHit = (this.selectedHit + (ev.key === "ArrowDown" ? 1 : this.hits.length - 1)) % this.hits.length;
        this.showHits(search.value);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (search.value !== "") {
          search.value = "";
          void this.runSearch();
        } else {
          this.setOverview(false);
        }
        return;
      }
      // Page Up/Down still drive the talk (a clicker keeps working); everything else is typing.
      if (ev.key !== "Tab" && ev.key !== "PageDown" && ev.key !== "PageUp") return;
    }

    if (plain && ev.key === "Tab") {
      ev.preventDefault();
      this.setOverview(!this.overviewOpen);
      return;
    }
    if (plain && !ev.repeat && (ev.key === "l" || ev.key === "L")) {
      ev.preventDefault();
      this.setLaser(!this.laserMode);
      return;
    }
    if (plain && !ev.repeat && (ev.key === "d" || ev.key === "D")) {
      ev.preventDefault();
      this.setDraw(!this.drawMode);
      return;
    }
    // A single Esc first clears typed digits, then turns the laser or pen off, then closes
    // whatever is open; only after that does it count towards ending the talk (Native §6.5).
    const sheetOpen = !$("sheet-more").hidden;
    // With More open, Enter is its Close button.
    if (plain && sheetOpen && ev.key === "Enter") {
      ev.preventDefault();
      if (!ev.repeat) $("sheet-more").hidden = true;
      return;
    }
    if (plain && ev.key === "Escape" && !ev.repeat && this.keys.typedDigits === "" && (this.laserMode || this.drawMode || this.overviewOpen || sheetOpen)) {
      ev.preventDefault();
      if (sheetOpen) $("sheet-more").hidden = true;
      else if (this.laserMode) this.setLaser(false);
      else if (this.drawMode) this.setDraw(false);
      else this.setOverview(false);
      return;
    }

    const result = this.keys.interpret(
      { key: ev.key, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey, repeat: ev.repeat, time: ev.timeStamp },
      this.keyState(),
    );
    if (result.handled) ev.preventDefault();
    // Esc twice goes back to choosing a view, as it does on the slides (Ben, 2026-11-27). The talk
    // goes on; ending it for everyone is End talk, under More.
    if (result.end) this.options.onChangeView?.();
    else if (result.command) this.send(result.command);
    $("digits").textContent = this.keys.typedDigits === "" ? "" : `Go to frame ${this.keys.typedDigits}⏎`;
  };

  private bind(): void {
    const signal = this.abort.signal;
    const on = (id: string, handler: () => void): void => $(id).addEventListener("click", handler, { signal });

    window.addEventListener("keydown", this.onKeyDown, { capture: true, signal });
    window.addEventListener(
      "resize",
      () => {
        const was = this.layout;
        this.applyLayout();
        if (was !== this.layout) this.setOverview(false);
      },
      { signal },
    );

    on("next", () => this.send({ name: "next" }));
    on("prev", () => this.send({ name: "previous" }));
    on("next-slide", () => this.send({ name: "next" }));
    on("t-back", () => this.send({ name: "back" }));
    on("t-forward", () => this.send({ name: "forward" }));
    on("t-black", () => this.toggleMode("black"));
    on("t-freeze", () => this.toggleMode("frozen"));
    on("m-white", () => this.toggleMode("white"));
    on("ink-board", () => this.toggleMode("white"));
    on("clock-toggle", () => this.send({ name: "timerToggle" }));
    on("clock-reset", () => this.send({ name: "timerReset" }));
    const countFrom = $<HTMLInputElement>("count-from");
    const clearCountError = (): void => {
      countFrom.classList.remove("invalid");
      $("count-hint").hidden = true;
    };
    on("count-up", () => {
      clearCountError();
      if (this.view?.timer.targetMs !== null) this.send({ name: "timerSetTarget", targetMs: null });
    });
    on("count-down", () => this.countDown(false));
    // Applied as it is typed, so there is nothing to confirm; a half-typed "20:" is left alone.
    countFrom.addEventListener(
      "input",
      () => {
        clearCountError();
        const ms = parseDuration(countFrom.value);
        if (ms === null) return;
        this.lastCountdownMs = ms;
        this.send({ name: "timerSetTarget", targetMs: ms });
      },
      { signal },
    );

    on("t-draw", () => this.setDraw(!this.drawMode));
    on("t-laser", () => this.setLaser(!this.laserMode));
    on("ink-undo", () => {
      this.ink = undoStroke(this.ink, this.layer);
      this.showInk();
      this.client.send({ type: "ink", body: { op: "undo" } });
    });
    on("ink-clear", () => {
      this.ink = clearLayer(this.ink, this.layer);
      this.showInk();
      this.client.send({ type: "ink", body: { op: "clear" } });
    });
    for (const el of document.querySelectorAll<HTMLElement>(".ink-color")) {
      el.addEventListener(
        "click",
        () => {
          this.inkColor = Number(el.dataset["color"]) || 0;
          this.update();
        },
        { signal },
      );
    }

    for (const id of ["t-slides", "side-slides"]) on(id, () => this.setOverview(!this.overviewOpen));
    on("overview-close", () => this.setOverview(false));
    $("search").addEventListener("input", () => void this.runSearch(), { signal });

    const openMore = (): void => {
      $("end-confirm").hidden = true;
      clearCountError();
      countFrom.value = formatClock(this.view?.timer.targetMs ?? this.lastCountdownMs);
      $("sheet-more").hidden = false;
      this.tick();
    };
    on("t-more", openMore);
    on("timer", openMore);
    on("link", openMore);
    on("more-close", () => ($("sheet-more").hidden = true));
    $("sheet-more").addEventListener(
      "click",
      (ev) => {
        if (ev.target === ev.currentTarget) $("sheet-more").hidden = true; // a click on the backdrop
      },
      { signal },
    );

    on("notes-smaller", () => this.setNotesSize(-2));
    on("notes-larger", () => this.setNotesSize(2));
    on("tab-notes", () => this.setOutlineShown(false));
    on("tab-outline", () => this.setOutlineShown(true));
    on("info-notes", () => this.showInfo("Notes", NOTES_INFO));
    on("info-outline", () => this.showInfo("Outline", outlineInfo(this.outline.length > 0)));
    on("info-close", () => ($("info").hidden = true));
    on("ov-frames", () => this.setThumbMode("frames"));
    on("ov-builds", () => this.setThumbMode("builds"));
    on("debug-toggle", () => {
      $("debug").hidden = !$("debug").hidden;
      $("sheet-more").hidden = true; // or the sheet covers what was just asked for
    });
    on("debug-close", () => ($("debug").hidden = true));
    on("swap", () => this.options.onSwap?.());
    on("change-view", () => this.options.onChangeView?.());
    on("fs", () => this.enterFullscreen());
    document.addEventListener("fullscreenchange", () => this.showFullscreen(), { signal });
    for (const id of ["end-confirm", "info"]) {
      $(id).addEventListener(
        "click",
        (ev) => {
          if (ev.target === ev.currentTarget) $(id).hidden = true; // a click outside the pop-up
        },
        { signal },
      );
    }
    on("banner-action", () => this.options.onReload?.());
    on("leave", () => this.options.onLeave());
    on("end-talk", () => ($("end-confirm").hidden = false));
    on("end-cancel", () => ($("end-confirm").hidden = true));
    on("end-yes", () => this.endTalk());

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") return;
        // Back from the background: phones drop sockets there. Reconnect and ask for the state again.
        this.client.reconnectNow();
        this.hello();
        void this.requestWakeLock();
      },
      { signal },
    );
    document.addEventListener("pointerdown", () => void this.requestWakeLock(), { signal, passive: true });
    // Buttons keep focus after a click; Space or Enter from a clicker would then press them again.
    document.addEventListener(
      "click",
      (ev) => {
        if (ev.target instanceof HTMLButtonElement) ev.target.blur();
      },
      { signal },
    );

    // The divider between the panes (wide layout). Not saved on the room PC, which stores nothing.
    const divider = $("divider");
    divider.addEventListener(
      "pointerdown",
      (down) => {
        divider.setPointerCapture(down.pointerId);
        const move = (ev: PointerEvent): void => {
          const fraction = Math.min(0.8, Math.max(0.2, ev.clientX / window.innerWidth));
          document.documentElement.style.setProperty("--left", `${(fraction * 100).toFixed(1)}%`);
        };
        const up = (): void => {
          divider.removeEventListener("pointermove", move);
          divider.removeEventListener("pointerup", up);
        };
        divider.addEventListener("pointermove", move);
        divider.addEventListener("pointerup", up);
      },
      { signal },
    );

    this.bindSlide(signal);
  }

  /**
   * The current slide takes every kind of input (SPEC §7, Native §6.4, §7):
   * - a pen always draws, and so does anything while Draw is on;
   * - a finger swipes to step, or presses and holds, then drags, to point;
   * - a mouse clicks to advance, and with Laser on points as it moves;
   * - a tap or click on a link follows the link.
   */
  private bindSlide(signal: AbortSignal): void {
    const el = $("current");
    let start: { x: number; y: number; t: number; id: number; type: string } | null = null;
    let pressTimer: number | undefined;
    let pointing = false;
    let lastSent = 0;

    const sendPointer = (clientX: number, clientY: number, force = false): void => {
      const point = this.current.pointAt(clientX, clientY, true);
      if (!point) return;
      this.current.setDot(point);
      const now = performance.now();
      if (!force && now - lastSent < POINTER_INTERVAL_MS) return;
      lastSent = now;
      this.client.send({ type: "pointer", body: { ...point, visible: true } });
    };
    const hidePointer = (): void => {
      this.current.setDot(null);
      this.client.send({ type: "pointer", body: { x: 0, y: 0, visible: false } });
    };

    el.addEventListener(
      "pointerdown",
      (ev) => {
        if (start || (ev.pointerType === "mouse" && ev.button !== 0)) return;
        start = { x: ev.clientX, y: ev.clientY, t: performance.now(), id: ev.pointerId, type: ev.pointerType };
        el.setPointerCapture(ev.pointerId);
        window.clearTimeout(pressTimer);
        if (this.drawMode || ev.pointerType === "pen") {
          ev.preventDefault();
          this.beginInk(ev.clientX, ev.clientY);
          return;
        }
        // Press and hold, then drag, to point. A finger does this instead of the Laser toggle; a
        // mouse can do either.
        if (this.live && !this.laserMode) {
          pressTimer = window.setTimeout(() => {
            if (!start) return;
            pointing = true;
            navigator.vibrate?.(10);
            sendPointer(start.x, start.y, true);
          }, LONG_PRESS_MS);
        }
      },
      { signal },
    );
    el.addEventListener(
      "pointermove",
      (ev) => {
        if (!start) {
          // A mouse moving with no button down: the laser, when it is on.
          if (this.laserMode && ev.pointerType === "mouse") sendPointer(ev.clientX, ev.clientY);
          return;
        }
        if (ev.pointerId !== start.id) return;
        if (this.activeStroke !== null) this.extendInk(ev);
        else if (pointing) sendPointer(ev.clientX, ev.clientY);
        else if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > TAP_SLOP_PX) window.clearTimeout(pressTimer); // a swipe, not a press
      },
      { signal },
    );
    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      if (!start || ev.pointerId !== start.id) return;
      window.clearTimeout(pressTimer);
      const down = start;
      start = null;
      if (this.activeStroke !== null || this.drawMode || down.type === "pen") {
        this.endInk();
        return;
      }
      if (pointing) {
        pointing = false;
        hidePointer();
        return;
      }
      if (cancelled) return;
      const dx = ev.clientX - down.x;
      const dy = ev.clientY - down.y;
      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        // Swipe left = forward, as on a touch screen showing the slides.
        this.send({ name: dx < 0 ? "next" : "previous" });
      } else if (Math.hypot(dx, dy) <= TAP_SLOP_PX && performance.now() - down.t < LONG_PRESS_MS + 150) {
        const page = this.page;
        const point = this.current.pointAt(ev.clientX, ev.clientY);
        const links = this.deck.linksNow(page);
        const index = point && links && this.current.shownPage === page ? hitTest(links, point.x, point.y) : -1;
        // Whoever runs the talk resolves the link from its own copy of the same PDF, so page and index are enough.
        if (index >= 0) this.send({ name: "followLink", page, index });
        else if (down.type === "mouse") this.send({ name: "next" }); // a click anywhere else advances (Native §6.5)
      }
    };
    el.addEventListener("pointerup", (ev) => finish(ev, false), { signal });
    el.addEventListener("pointercancel", (ev) => finish(ev, true), { signal });
    el.addEventListener(
      "pointerleave",
      (ev) => {
        if (!start && this.laserMode && ev.pointerType === "mouse") hidePointer();
      },
      { signal },
    );
    el.addEventListener("contextmenu", (ev) => ev.preventDefault(), { signal });
  }

  // ---------------------------------------------------------------- lifecycle

  /** The page elements outlive a console (the same device can open another talk), so start and end clean. */
  private resetPanels(): void {
    for (const id of ["sheet-more", "end-confirm", "info", "banner", "pill", "overview", "drawbar", "debug", "count-hint", "outline", "fs"]) $(id).hidden = true;
    $("outline").replaceChildren();
    delete $("outline").dataset["current"];
    $("side-normal").hidden = false;
    $<HTMLInputElement>("search").value = "";
    $("results").replaceChildren();
  }

  private async requestWakeLock(): Promise<void> {
    if (this.destroyed || !("wakeLock" in navigator) || (this.wakeLock && !this.wakeLock.released)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Not allowed right now; retried on the next touch.
    }
  }

  /** Drops everything this view holds, including its copy of the deck. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    for (const t of this.timers) window.clearInterval(t);
    window.clearInterval(this.inkTimer);
    this.thumbs?.destroy();
    this.thumbs = null;
    this.notesImage?.destroy();
    this.client.close();
    this.current.destroy();
    this.next.destroy();
    $("notes").replaceChildren();
    delete $("notes").dataset["html"];
    this.resetPanels();
    void this.wakeLock?.release().catch(() => {});
    if (this.keyboardLocked) navigator.keyboard?.unlock?.();
    if (this.options.ownsDeck) void this.deck.destroy();
    if (import.meta.env.DEV) delete (window as unknown as { __console?: unknown }).__console;
  }
}
