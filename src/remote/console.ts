// The phone's presenter console (SPEC §7). It renders the deck locally and exchanges only small
// encrypted messages with the room PC, which stays authoritative: the phone shows what the room
// PC last reported, never what it merely asked for.
import { strFromU8 } from "fflate";
import type { TalkKeys } from "../core/crypto";
import { hitTest } from "../core/links";
import { formatClock, renderNotesHtml } from "../core/markdown";
import { NotesTable, assembleNotes, parsePdfpc } from "../core/notes";
import type { DeckPayload } from "../core/payload";
import { APP_VERSION } from "../core/protocol";
import type { Envelope, StateBody } from "../core/protocol";
import type { Command } from "../core/session";
import { DEFAULT_INK_WIDTH } from "../core/ink";
import type { Stroke } from "../core/ink";
import { parseSplit } from "../core/split";
import { ThumbGrid } from "../shared/thumbs";
import type { Deck } from "../shared/deck";
import { RelayClient, deviceName } from "../shared/relay-client";
import type { LinkStatus } from "../shared/relay-client";
import { SlideSurface } from "../shared/slide-surface";
import { loadNotesSize, saveNotesSize } from "./saved";

const PING_MS = 2000;
/** The room PC sends state at least every 5 s; past this it is treated as gone. */
const ROOM_TIMEOUT_MS = 9000;
const LONG_PRESS_MS = 350;
const POINTER_INTERVAL_MS = 33; // at most ~30 messages a second, well under the relay's limit
const INK_FLUSH_MS = 33;
const SWIPE_MIN_PX = 45;
const TAP_SLOP_PX = 10;

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

export interface ConsoleOptions {
  readonly deck: Deck;
  readonly payload: DeckPayload;
  readonly keys: TalkKeys;
  /** The user closed the remote on this phone. */
  onLeave(): void;
  /** The room PC has a newer publish of this deck and the user asked to reload. */
  onReload(): void;
}

export class RemoteConsole {
  private readonly deck: Deck;
  private readonly client: RelayClient;
  private readonly current: SlideSurface;
  private readonly next: SlideSurface;
  private readonly abort = new AbortController();
  private notes: NotesTable = NotesTable.empty;
  private notesSize = loadNotesSize() ?? 18;

  private linkStatus: LinkStatus = "connecting";
  private room: StateBody | null = null;
  /** `performance.now()` when the last state arrived, for extrapolating the clock. */
  private roomAt = 0;
  private roomSeenAt = -Infinity;
  private roomWaitingForStart = false;
  private preview: number | null = null;

  private readonly pending = new Map<number, number>();
  private rtts: number[] = [];
  private taps: number[] = [];
  private timers: number[] = [];
  private wakeLock: WakeLockSentinel | null = null;
  /** Draw tool (SPEC §7): this phone's own copy of what it has drawn, so ink appears under the finger at once. */
  private drawMode = false;
  private inkColor = 0;
  private localInk: { page: Stroke[]; board: Stroke[] } = { page: [], board: [] };
  private strokeSeq = 0;
  private activeStroke: number | null = null;
  private pendingPoints: number[] = [];
  private inkFlush: number | undefined;
  private thumbs: ThumbGrid | null = null;
  private notesImage: SlideSurface | null = null;
  private destroyed = false;

  constructor(private readonly options: ConsoleOptions) {
    this.deck = options.deck;
    document.documentElement.style.setProperty("--slide-aspect", String(this.deck.aspect));
    document.documentElement.style.setProperty("--notes-size", `${this.notesSize}px`);

    this.current = new SlideSurface($("current"), this.deck, 6);
    this.next = new SlideSurface($("next-slide"), this.deck, 4);

    this.client = new RelayClient({
      roomId: options.keys.roomId,
      channelKey: options.keys.channelKey,
      role: "remote",
      onMessage: (envelope) => this.onMessage(envelope),
      onStatus: (status) => {
        this.linkStatus = status;
        if (status !== "connected") this.pending.clear();
        this.update();
      },
    });

    this.resetPanels();
    this.bind();
    this.timers.push(
      window.setInterval(() => this.tick(), 500),
      window.setInterval(() => this.client.send({ type: "ping", body: { t: performance.now() } }), PING_MS),
    );
    void this.loadNotes();
    void this.requestWakeLock();
    this.update();

    if (import.meta.env.DEV) {
      (window as unknown as { __remote?: unknown }).__remote = {
        room: () => this.room,
        shownPage: () => this.current.shownPage,
        taps: () => this.taps,
        rtts: () => this.rtts,
        dropConnection: () => this.client.dropForTest(),
        localInk: () => ({ page: this.localInk.page.length, board: this.localInk.board.length }),
      };
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    for (const t of this.timers) window.clearInterval(t);
    window.clearInterval(this.inkFlush);
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
    void this.deck.destroy();
    if (import.meta.env.DEV) delete (window as unknown as { __remote?: unknown }).__remote;
  }

  /** The page elements outlive a console (the same phone can open another talk), so start and end clean. */
  private resetPanels(): void {
    for (const id of ["sheet-slides", "sheet-more", "end-confirm", "banner", "mode-badge", "preview-badge"]) $(id).hidden = true;
  }

  // ---------------------------------------------------------------- relay

  private get roomLive(): boolean {
    return this.linkStatus === "connected" && this.room !== null && performance.now() - this.roomSeenAt < ROOM_TIMEOUT_MS;
  }

  private send(command: Command): void {
    const seq = this.client.send({ type: "command", body: command });
    if (seq > 0) {
      this.pending.set(seq, performance.now());
      if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value ?? 0);
    }
  }

  private onMessage(envelope: Envelope): void {
    const now = performance.now();
    switch (envelope.type) {
      case "state": {
        this.followSplit(envelope.body.split);
        // Ink belongs to its page; and if the room PC has none (cleared with C there), neither do we.
        if (this.room && envelope.body.page !== this.room.page) this.localInk.page = [];
        if (envelope.body.ink === 0 && this.activeStroke === null) {
          if (envelope.body.audienceMode.kind === "white") this.localInk.board = [];
          else if (envelope.body.audienceMode.kind === "live") this.localInk.page = [];
        }
        this.room = envelope.body;
        this.roomAt = now;
        this.roomSeenAt = now;
        this.roomWaitingForStart = false;
        const ack = envelope.body.ack;
        if (ack && ack.sid === this.client.channel.sid) {
          const sent = this.pending.get(ack.seq);
          if (sent !== undefined) {
            this.taps = [...this.taps, now - sent].slice(-100);
            this.pending.delete(ack.seq);
          }
        }
        this.update();
        break;
      }
      case "hello":
        if (envelope.body.role === "room") {
          // A room PC with the deck open that has not clicked Start yet, or one that just (re)connected.
          this.roomSeenAt = now;
          if (!this.room) this.roomWaitingForStart = true;
          this.update();
        }
        break;
      case "pong":
        this.roomSeenAt = now;
        this.rtts = [...this.rtts, now - envelope.body.t].slice(-30);
        break;
      default:
        break;
    }
  }

  /**
   * The room PC decides whether a Beamer notes-split deck is cropped (its entry screen can turn
   * the crop off), so the phone follows what the room PC reports.
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
    this.preview = null;
    void this.loadNotes();
  }

  // ---------------------------------------------------------------- view

  private get page(): number {
    const p = this.preview ?? this.room?.page ?? 0;
    return Math.min(Math.max(p, 0), this.deck.pageCount - 1);
  }

  private update(): void {
    if (this.destroyed) return;
    const { frames, pageCount } = this.deck;
    const page = this.page;
    const previewing = this.preview !== null;
    const live = this.roomLive;

    const board = this.room?.audienceMode.kind === "white" && !previewing;
    if ((previewing || !live) && this.drawMode) this.drawMode = false;
    this.current.setBlank(board);
    this.current.setInk(previewing ? [] : board ? this.localInk.board : this.localInk.page);
    $("drawbar").hidden = !this.drawMode;
    $("t-draw").classList.toggle("on", this.drawMode);
    $<HTMLButtonElement>("t-draw").disabled = !live || previewing;
    $("ink-board").classList.toggle("on", board);
    $("current").parentElement?.classList.toggle("drawing", this.drawMode);
    for (const el of document.querySelectorAll<HTMLElement>(".ink-color")) {
      el.classList.toggle("on", Number(el.dataset["color"]) === this.inkColor);
    }
    this.current.show(page, [page + 1, page - 1].filter((p) => p >= 0 && p < pageCount));
    this.next.show(page + 1 < pageCount ? page + 1 : page);
    void this.deck.loadLinks(page);

    const frame = frames.frameContaining(page);
    $("frame-line").textContent = frame ? `Frame ${frame.label} of ${frames.frameCount}` : "–";
    const builds = frame ? frame.lastPage - frame.firstPage + 1 : 1;
    $("build-line").textContent = builds > 1 ? `Build ${frames.buildIndex(page) + 1} of ${builds}` : "";
    // Shown in landscape, where the slide and notes are hidden to leave room for the buttons.
    $("bar-where").textContent = frame
      ? `Frame ${frame.label}/${frames.frameCount}${builds > 1 ? ` · ${frames.buildIndex(page) + 1}/${builds}` : ""}`
      : "";

    // Notes: text when there is any; otherwise, for a Beamer notes-split deck, the notes half as an image.
    const note = this.notes.noteFor(page, frames);
    const notesEl = $("notes");
    const asImage = !note && this.deck.notesCrop !== null;
    notesEl.hidden = asImage;
    $("notes-image").hidden = !asImage;
    if (asImage) {
      this.notesImage ??= new SlideSurface($("notes-image"), this.deck, 3, "notes");
      this.notesImage.show(page);
    } else {
      const html = note ? renderNotesHtml(note.text) : `<p class="empty">No notes for this slide.</p>`;
      if (notesEl.dataset["html"] !== html) {
        notesEl.dataset["html"] = html;
        notesEl.innerHTML = html; // every piece of note text is escaped by renderNotesHtml
        notesEl.scrollTop = 0;
      }
    }

    const mode = this.room?.audienceMode.kind ?? "live";
    const badge = $("mode-badge");
    badge.hidden = mode === "live" || previewing;
    badge.textContent = mode === "black" ? "ROOM SCREEN BLACK" : mode === "white" ? "WHITEBOARD" : "ROOM SCREEN FROZEN";
    $("preview-badge").hidden = !previewing;
    $("current").parentElement?.classList.toggle("previewing", previewing);

    $("steps").hidden = previewing;
    $("preview-actions").hidden = !previewing;
    $<HTMLButtonElement>("preview-show").disabled = !live;
    for (const id of ["prev", "next", "t-black", "t-freeze", "m-white", "clock-toggle", "clock-reset", "end-talk"]) {
      $<HTMLButtonElement>(id).disabled = !live;
    }
    $("t-black").classList.toggle("on", mode === "black");
    $("t-freeze").classList.toggle("on", mode === "frozen");
    $("m-white").classList.toggle("on", mode === "white");
    const lastOther = (list: readonly number[] | undefined): boolean => (list ?? []).some((p) => p !== this.room?.page);
    $<HTMLButtonElement>("t-back").disabled = !live || !lastOther(this.room?.history);
    $<HTMLButtonElement>("m-forward").disabled = !live || !lastOther(this.room?.forwardHistory);
    $("clock-toggle").textContent = this.room?.timer.running === false ? "Resume" : "Pause";

    const banner = $("banner");
    const stale = this.room !== null && this.room.deckPublished !== "" && this.room.deckPublished !== this.options.payload.meta.published;
    banner.hidden = !stale;
    if (stale) {
      $("banner-text").textContent = "Slides updated — reload?";
      $("banner-action").textContent = "Reload";
    }

    this.tick();
    if (!$("sheet-slides").hidden) this.markCurrentThumb();
  }

  /** The parts that change with time: connection line, clock, diagnostics. */
  private tick(): void {
    if (this.destroyed) return;
    const link = $("link");
    const rtt = median(this.rtts);
    let text: string;
    let cls: "ok" | "wait" | "" = "";
    if (this.linkStatus === "unavailable") text = "Remote unavailable in this build";
    else if (this.linkStatus !== "connected") text = "Reconnecting…";
    else if (this.roomLive) {
      text = `Connected to room PC${rtt === null ? "" : ` · ${Math.round(rtt)} ms`}`;
      cls = "ok";
    } else if (this.roomWaitingForStart && performance.now() - this.roomSeenAt < ROOM_TIMEOUT_MS) {
      text = "Room PC is ready: click Start there";
      cls = "wait";
    } else {
      text = "Waiting for the room PC";
      cls = "wait";
    }
    if (link.textContent !== text) link.textContent = text;
    link.classList.toggle("ok", cls === "ok");
    link.classList.toggle("wait", cls === "wait");

    const timer = $("timer");
    const t = this.room?.timer;
    if (!t) {
      timer.textContent = "0:00";
      timer.className = "timer paused";
    } else {
      const elapsed = t.elapsedMs + (t.running && this.roomLive ? performance.now() - this.roomAt : 0);
      const left = t.targetMs === null ? null : t.targetMs - elapsed;
      // With a target, the time left takes the clock's place: green while positive, red once over (Native §6.2).
      timer.textContent = `${t.running ? "" : "⏸ "}${formatClock(elapsed)}${left === null ? "" : ` · ${formatClock(left)}`}`;
      timer.className = `timer${!t.running ? " paused" : left === null ? "" : left >= 0 ? " good" : " over"}`;
    }

    const tap = median(this.taps);
    // A command's answer comes back over the same path as a ping's, so half the ping round trip
    // is the return leg; the rest is tap → slide drawn.
    const oneWay = tap === null ? null : Math.max(0, tap - (rtt ?? 0) / 2);
    $("diag").textContent =
      `ping ${rtt === null ? "–" : `${Math.round(rtt)} ms`}` +
      ` · tap → slide ${oneWay === null ? "–" : `${Math.round(oneWay)} ms`} (median of ${this.taps.length})`;
  }

  private async loadNotes(): Promise<void> {
    const { payload } = this.options;
    const pdfpc = payload.pdfpc ? parsePdfpc(strFromU8(payload.pdfpc)) : null;
    const build = (embedded: Map<number, string>): NotesTable =>
      assembleNotes({ overrides: payload.meta.noteOverrides, pdfpc, embedded, pptx: payload.notes?.pages ?? [] }, this.deck.frames);
    this.notes = build(new Map()); // what the payload alone gives, at once
    this.update();
    const embedded = await this.deck.loadEmbeddedNotes().catch(() => new Map<number, string>());
    if (this.destroyed) return;
    this.notes = build(embedded);
    this.update();
  }

  // ---------------------------------------------------------------- input

  private bind(): void {
    const signal = this.abort.signal;
    const on = (id: string, handler: () => void): void => $(id).addEventListener("click", handler, { signal });
    const toggleMode = (kind: "black" | "white" | "frozen"): void => {
      const now = this.room?.audienceMode.kind;
      if (now === kind) this.send({ name: "setAudienceMode", mode: { kind: "live" } });
      else if (kind === "frozen") this.send({ name: "setAudienceMode", mode: { kind: "frozen", page: this.room?.page ?? 0 } });
      else this.send({ name: "setAudienceMode", mode: { kind } });
    };

    on("next", () => this.send({ name: "next" }));
    on("prev", () => this.send({ name: "previous" }));
    on("t-back", () => this.send({ name: "back" }));
    on("m-forward", () => this.send({ name: "forward" }));
    on("t-black", () => toggleMode("black"));
    on("t-freeze", () => toggleMode("frozen"));
    on("m-white", () => toggleMode("white"));
    on("clock-toggle", () => this.send({ name: "timerToggle" }));
    on("clock-reset", () => this.send({ name: "timerReset" }));

    on("t-draw", () => {
      this.drawMode = !this.drawMode;
      this.update();
    });
    on("ink-undo", () => {
      this.layerInk().pop();
      this.touchInk();
      this.client.send({ type: "ink", body: { op: "undo" } });
    });
    on("ink-clear", () => {
      this.layerInk().length = 0;
      this.touchInk();
      this.client.send({ type: "ink", body: { op: "clear" } });
    });
    on("ink-board", () => toggleMode("white"));
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

    on("t-slides", () => this.openSlides());
    on("slides-close", () => ($("sheet-slides").hidden = true));
    on("t-more", () => this.openMore());
    on("timer", () => this.openMore());
    on("link", () => this.openMore());
    on("more-close", () => ($("sheet-more").hidden = true));

    on("preview-cancel", () => {
      this.preview = null;
      this.update();
    });
    on("preview-show", () => {
      if (this.preview === null) return;
      this.send({ name: "goToPage", page: this.preview });
      this.preview = null;
      this.update();
    });

    on("notes-smaller", () => this.setNotesSize(this.notesSize - 2));
    on("notes-larger", () => this.setNotesSize(this.notesSize + 2));
    on("banner-action", () => this.options.onReload());
    on("leave", () => this.options.onLeave());
    on("end-talk", () => ($("end-confirm").hidden = false));
    on("end-cancel", () => ($("end-confirm").hidden = true));
    on("end-yes", () => {
      this.client.send({ type: "end", body: {} });
      $("end-confirm").hidden = true;
      $("sheet-more").hidden = true;
      this.room = null;
      this.update();
    });

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") return;
        // Back from the background: phones drop sockets there. Reconnect and ask for the state again.
        this.client.reconnectNow();
        this.client.send({ type: "hello", body: { role: "remote", device: deviceName(), appVersion: APP_VERSION } });
        void this.requestWakeLock();
      },
      { signal },
    );
    document.addEventListener("pointerdown", () => void this.requestWakeLock(), { signal, passive: true });

    this.bindSlideGestures(signal);
  }

  // ---------------------------------------------------------------- ink

  private layerInk(): Stroke[] {
    return this.room?.audienceMode.kind === "white" ? this.localInk.board : this.localInk.page;
  }

  /** The slide surface redraws only when handed a new array. */
  private touchInk(): void {
    if (this.room?.audienceMode.kind === "white") this.localInk.board = [...this.localInk.board];
    else this.localInk.page = [...this.localInk.page];
    this.update();
  }

  private beginStroke(clientX: number, clientY: number): void {
    const point = this.current.pointAt(clientX, clientY, true);
    const mode = this.room?.audienceMode.kind;
    if (!point || !this.roomLive || (mode !== "live" && mode !== "white")) return;
    const id = ++this.strokeSeq;
    this.activeStroke = id;
    this.pendingPoints = [];
    this.layerInk().push({ id: `local:${id}`, color: this.inkColor, width: DEFAULT_INK_WIDTH, points: [point.x, point.y] });
    this.touchInk();
    this.client.send({ type: "ink", body: { op: "begin", id, ...point, color: this.inkColor, width: DEFAULT_INK_WIDTH } });
    this.inkFlush = window.setInterval(() => this.flushInk(), INK_FLUSH_MS);
  }

  private extendStroke(ev: PointerEvent): void {
    if (this.activeStroke === null) return;
    const layer = this.layerInk();
    const stroke = layer.at(-1);
    if (!stroke) return;
    // Coalesced events carry every sample a Pencil or finger produced since the last frame.
    const samples = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    const added: number[] = [];
    for (const sample of samples.length > 0 ? samples : [ev]) {
      const point = this.current.pointAt(sample.clientX, sample.clientY, true);
      if (point) added.push(point.x, point.y);
    }
    if (added.length === 0) return;
    layer[layer.length - 1] = { ...stroke, points: [...stroke.points, ...added] };
    this.pendingPoints.push(...added);
    this.touchInk();
  }

  private flushInk(): void {
    const id = this.activeStroke;
    if (id === null) return;
    // Batches of at most 128 points keep every frame far below the relay's 64 KB limit.
    while (this.pendingPoints.length > 0) {
      this.client.send({ type: "ink", body: { op: "append", id, points: this.pendingPoints.splice(0, 256) } });
    }
  }

  private endStroke(): void {
    const id = this.activeStroke;
    if (id === null) return;
    this.flushInk();
    window.clearInterval(this.inkFlush);
    this.activeStroke = null;
    this.client.send({ type: "ink", body: { op: "end", id } });
  }

  /** Swipe to step, long-press then drag for the pointer, tap a link to follow it (SPEC §7). */
  private bindSlideGestures(signal: AbortSignal): void {
    const el = $("current");
    let start: { x: number; y: number; t: number; id: number } | null = null;
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
    const stopPointing = (): void => {
      if (!pointing) return;
      pointing = false;
      this.current.setDot(null);
      this.client.send({ type: "pointer", body: { x: 0, y: 0, visible: false } });
    };

    el.addEventListener(
      "pointerdown",
      (ev) => {
        if (start) return;
        start = { x: ev.clientX, y: ev.clientY, t: performance.now(), id: ev.pointerId };
        el.setPointerCapture(ev.pointerId);
        if (this.drawMode) {
          // In Draw mode every touch on the slide is ink: no swipes, no pointer, no links.
          this.beginStroke(ev.clientX, ev.clientY);
          return;
        }
        window.clearTimeout(pressTimer);
        if (this.preview === null) {
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
        if (!start || ev.pointerId !== start.id) return;
        if (this.activeStroke !== null) {
          this.extendStroke(ev);
          return;
        }
        if (pointing) {
          sendPointer(ev.clientX, ev.clientY);
        } else if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > TAP_SLOP_PX) {
          window.clearTimeout(pressTimer); // it is a swipe, not a press
        }
      },
      { signal },
    );
    const finish = (ev: PointerEvent, cancelled: boolean): void => {
      if (!start || ev.pointerId !== start.id) return;
      window.clearTimeout(pressTimer);
      if (this.activeStroke !== null || this.drawMode) {
        this.endStroke();
        start = null;
        return;
      }
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const wasPointing = pointing;
      const down = start;
      start = null;
      stopPointing();
      if (cancelled || wasPointing) return;

      if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        // Swipe left = forward, as on a touch screen showing the slides.
        this.step(dx < 0 ? 1 : -1);
      } else if (Math.hypot(dx, dy) <= TAP_SLOP_PX && performance.now() - down.t < LONG_PRESS_MS) {
        this.tapSlide(ev.clientX, ev.clientY);
      }
    };
    el.addEventListener("pointerup", (ev) => finish(ev, false), { signal });
    el.addEventListener("pointercancel", (ev) => finish(ev, true), { signal });
    el.addEventListener("contextmenu", (ev) => ev.preventDefault(), { signal });
  }

  private step(delta: 1 | -1): void {
    if (this.preview !== null) {
      this.preview = Math.min(this.deck.pageCount - 1, Math.max(0, this.preview + delta));
      this.update();
    } else {
      this.send({ name: delta > 0 ? "next" : "previous" });
    }
  }

  private tapSlide(clientX: number, clientY: number): void {
    if (this.preview !== null) return;
    const page = this.page;
    const point = this.current.pointAt(clientX, clientY);
    const links = this.deck.linksNow(page);
    if (!point || !links || this.current.shownPage !== page) return;
    const index = hitTest(links, point.x, point.y);
    // The room PC resolves the link from its own copy of the same PDF, so page and index are enough.
    if (index >= 0) this.send({ name: "followLink", page, index });
  }

  private setNotesSize(px: number): void {
    this.notesSize = Math.min(40, Math.max(12, px));
    document.documentElement.style.setProperty("--notes-size", `${this.notesSize}px`);
    saveNotesSize(this.notesSize);
  }

  private openMore(): void {
    $("end-confirm").hidden = true;
    $("sheet-more").hidden = false;
    this.tick();
  }

  // ---------------------------------------------------------------- thumbnails

  private openSlides(): void {
    $("sheet-slides").hidden = false;
    // A tap previews the frame's first build on this phone only (SPEC §7).
    this.thumbs ??= new ThumbGrid($("grid"), this.deck, {
      onPick: (frame) => {
        this.preview = frame.firstPage;
        $("sheet-slides").hidden = true;
        this.update();
      },
    });
    this.markCurrentThumb(true);
  }

  private markCurrentThumb(scroll = false): void {
    const frame = this.deck.frames.frameContaining(this.room?.page ?? 0);
    this.thumbs?.mark(frame?.index ?? null, null, scroll);
  }

  private async requestWakeLock(): Promise<void> {
    if (this.destroyed || !("wakeLock" in navigator) || (this.wakeLock && !this.wakeLock.released)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Not allowed right now; retried on the next touch.
    }
  }
}
